"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Play, Pause, Gauge, Volume2, VolumeX, Sparkles, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils";
import {
  makeMainTrack,
  speedAt,
  SPEED_MAX,
  SPEED_MIN,
  XFADE_DEFAULT,
  XFADE_MAX,
  XFADE_MIN,
  type EditorState,
  type EditorTrack,
  type SpeedPoint,
} from "@/lib/editor/presets";
import { useAudioPeaks, Waveform } from "@/components/editor/editor-waveform";
import { Filmstrip } from "@/components/editor/filmstrip";
import { TimecodeInput } from "@/components/editor/editable-timecode";
import { getRulerConfig, shouldShowLabel, formatRulerLabel } from "@/vendor/opencut/ruler-utils";
import type { ClipReframe } from "@/lib/types";

type Update = (patch: Partial<EditorState>) => void;
const SPEEDS = [0.5, 1, 1.5, 2];
const MIN_LEN = 0.5; // seconds — smallest trim window / split piece
const MAX_ZOOM = 8; // 800%
// Lane geometry (px) — must match the h-10 / space-y-1 classes below; used to
// place transition zones on the seam between adjacent track lanes.
const LANE_H = 40;
const LANE_GAP = 4;
// 분할(Ctrl+B)은 오른쪽 조각을 새 트랙으로 보내는데, 서버 렌더는 tracks[0] 만 합성한다 —
// 즉 지금 분할하면 뒷부분이 결과물에서 조용히 사라진다. renderShort 가 다중 트랙을
// 합성하게 되면 다시 true 로 되돌린다 (기능 삭제 아님).
const SPLIT_ENABLED: boolean = false;

const clampSpeed = (v: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
// Log2 mapping so 1× sits mid-lane: lane top = 4×, bottom = 0.25×.
const speedToY = (s: number) => 1 - (Math.log2(clampSpeed(s)) + 2) / 4;
const yToSpeed = (yFrac: number) =>
  clampSpeed(Math.pow(2, (1 - Math.min(1, Math.max(0, yFrac))) * 4 - 2));

function speedTint(s: number) {
  if (s < 0.95) return "bg-sky-500/25 text-sky-200";
  if (s <= 1.05) return "bg-emerald-500/10 text-emerald-200/80";
  return "bg-red-500/25 text-red-200";
}

/** Cut the trim window into constant-speed regions from the step keyframes. */
function speedSegments(points: SpeedPoint[], base: number, trIn: number, trOut: number) {
  const inner = [...points].sort((a, b) => a.time - b.time).filter((p) => p.time > trIn && p.time < trOut);
  const segs: { from: number; to: number; speed: number }[] = [];
  let from = trIn;
  let sp = speedAt(points, trIn, base);
  for (const p of inner) {
    segs.push({ from, to: p.time, speed: sp });
    from = p.time;
    sp = p.speed;
  }
  segs.push({ from, to: trOut, speed: sp });
  return segs;
}

/** Bottom transport: drives the real <video>, trim handles, speed, hook tools, ±sync.
 *  The <video> element is the source of truth — the playhead reads its currentTime and
 *  playback loops inside [trimIn, trimOut] (render-free segment preview, plan §2.4). */
export function EditorTimeline({
  state,
  update,
  duration,
  video,
  videoUrl,
  tracks,
  onTogglePlay,
  recWindow,
  hookAvailable,
  onPlayHook,
  hookCaption,
  frameMediaId,
  apiBase,
  reframe,
}: {
  state: EditorState;
  update: Update;
  duration: number;
  video: HTMLVideoElement | null;
  videoUrl?: string;
  /** 필름스트립용 원본(master) 미디어 id + API 베이스. 프레임 파노라마를 눈금 아래 깐다. */
  frameMediaId?: string;
  apiBase?: string;
  /** Vertical layers, stacked. tracks[0] is the main track (mirrors the master trim). */
  tracks?: EditorTrack[];
  onTogglePlay: () => void;
  /** AI 추천 창(마스터 절대 초) — 있으면 트랙 상단에 얇은 하이라이트 밴드로 표시하고
   *  트림 IN/OUT의 "추천 원위치로" 스냅 대상이 된다. 트림 자체는 사용자 자유. */
  recWindow?: { start: number; end: number };
  /** clip 에 hookTimeSec 이 있어 "첫 3초 훅" 프리롤을 실제로 렌더할 수 있는지. false 면 토글을
   *  켜도 렌더가 no-op 이라 · 토글에 안내 툴팁을 띄운다. */
  hookAvailable?: boolean;
  /** 타임라인 왼쪽 "하이라이트 훅" 북엔드 클릭 시 훅 지점 재생(editor-shell 이 좌표를 안다). */
  onPlayHook?: () => void;
  /** 훅 자막(북엔드 툴팁 표시용). */
  hookCaption?: string;
  /** Read-only Beat decisions. Segment times are source-master absolute seconds. */
  reframe?: ClipReframe;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const peaks = useAudioPeaks(videoUrl);

  const [zoom, setZoom] = useState(1); // 1 = 100% (full clip), up to MAX_ZOOM
  const [zoomBadge, setZoomBadge] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ trackId: string; side: "in" | "out" } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [splitFlash, setSplitFlash] = useState<number | null>(null);
  const [rampMode, setRampMode] = useState(false);
  const [speedDrag, setSpeedDrag] = useState<{ trackId: string; index: number } | null>(null);
  const [volPop, setVolPop] = useState<string | null>(null);
  const [xfDrag, setXfDrag] = useState<{ trackId: string; startX: number; startDur: number } | null>(null);
  const laneRefs = useRef(new Map<string, HTMLDivElement>());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);

  // Latest values for window-level listeners (wheel / drag / keydown live outside React's render).
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateRef = useRef(update);
  updateRef.current = update;
  const tRef = useRef(t);
  tRef.current = t;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  // Mirror the element's play state + position (it is the source of truth).
  // 트림/타임라인/비디오가 같은 좌표계(로드된 파일의 자체 초)라 오프셋 불필요.
  useEffect(() => {
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setT(video.currentTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onTime);
    setPlaying(!video.paused);
    setT(video.currentTime);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onTime);
    };
  }, [video]);

  // While playing, advance the playhead from the element and loop within the trim window.
  // ⚠️ 되돌리기는 **유효한 창(trimOut > trimIn)** 에서만 한다. trimOut ≤ trimIn(퇴화·역전 창)
  // 인데도 되돌리면 매 프레임 currentTime 이 trimIn 으로 리셋돼 재생이 그 지점(보통 0:00)에
  // 고정된다 — 이게 "재생이 아예 안 움직임" 의 원인이었다. 창이 유효하지 않으면 되돌리지 않고
  // 그냥 앞으로 재생시킨다(브라우저가 파일 끝에서 멈춘다).
  useEffect(() => {
    if (!video || !playing) return;
    const loop = () => {
      const lo = Math.max(0, state.trimIn);
      const hi = state.trimOut;
      if (hi > lo + 0.05 && video.currentTime >= hi) video.currentTime = lo;
      setT(video.currentTime);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [video, playing, state.trimIn, state.trimOut]);

  // Clamped: t is segment-relative and can run negative / past duration while the
  // element plays the master outside the segment window.
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / Math.max(1, duration)) * 100))}%`;
  const trimmedLen = Math.max(0, state.trimOut - state.trimIn);

  // Backward compat: pre-track editorState renders as a single main track.
  function listOf(s: EditorState): EditorTrack[] {
    return s.tracks && s.tracks.length > 0 ? s.tracks : [makeMainTrack(s.trimIn, s.trimOut, duration)];
  }
  const trackList = listOf(state);
  const showReframeLane = reframe?.mode === "ai_multi";
  const reframeSegments = reframe?.status === "ready" ? (reframe.plan?.segments ?? []) : [];
  const focused = trackList.find((x) => x.id === focusId) ?? trackList[0];

  // 타임라인 오버레이 레인(제목·요소 시간창 UI)은 제거됨 — 오버레이 표시/편집은 프리뷰·속성 패널에서 처리.
  const tracksTop = showReframeLane ? LANE_H + LANE_GAP : 0;

  // Keep playback speed in sync with the transport. The main track's speed ramp wins
  // (it is what the render cuts); no keyframes = uniform state.speed as before.
  const mainPoints = trackList[0]?.speedPoints;
  const currentSpeed = speedAt(mainPoints, t, state.speed);
  useEffect(() => {
    if (!video) return;
    if (Math.abs(video.playbackRate - currentSpeed) > 0.001) video.playbackRate = currentSpeed;
  }, [video, currentSpeed]);

  // One <video> for all layers (phase 1) — it takes the focused track's audio settings.
  useEffect(() => {
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, focused.volume ?? 1));
    video.muted = focused.muted === true;
  }, [video, focused.volume, focused.muted]);

  function patchTrack(trackId: string, patch: Partial<EditorTrack>) {
    const s = stateRef.current;
    const base = s.tracks && s.tracks.length > 0 ? s.tracks : listOf(s);
    updateRef.current({ tracks: base.map((x) => (x.id === trackId ? { ...x, ...patch } : x)) });
  }

  function addSpeedPointAt(sec: number) {
    const s = stateRef.current;
    const list = listOf(s);
    const target = list.find((x) => x.id === focusRef.current) ?? list[0];
    const pts = target.speedPoints ?? [];
    const time = Math.max(0, Math.min(Math.round(sec * 10) / 10, duration));
    // New keyframe starts at the speed already in effect there — a flat insert the
    // operator then drags, instead of a surprise jump.
    patchTrack(target.id, { speedPoints: [...pts, { time, speed: speedAt(pts, time, s.speed) }] });
  }

  function removeSpeedPoint(trackId: string, index: number) {
    const s = stateRef.current;
    const tr = listOf(s).find((x) => x.id === trackId);
    if (!tr) return;
    patchTrack(trackId, { speedPoints: (tr.speedPoints ?? []).filter((_, i) => i !== index) });
  }

  // ── transitions: the zone between adjacent tracks toggles cut ⇄ crossfade;
  // Shift+drag on a crossfade zone adjusts its overlap duration. ──
  function toggleTransition(trackId: string) {
    const tr = listOf(stateRef.current).find((x) => x.id === trackId);
    if (!tr) return;
    const cur = tr.transition ?? { type: "cut" as const, duration: 0 };
    patchTrack(trackId, {
      transition:
        cur.type === "cut" ? { type: "crossfade", duration: XFADE_DEFAULT } : { type: "cut", duration: 0 },
    });
  }

  // The master trim IS the main track's trim — keep tracks[0] in lockstep so the
  // stored track model never drifts from what the render will cut.
  function mainTrimPatch(s: EditorState, patch: { trimIn?: number; trimOut?: number }): Partial<EditorState> {
    const [main, ...rest] = s.tracks ?? [];
    return main ? { ...patch, tracks: [{ ...main, ...patch }, ...rest] } : patch;
  }
  const trimPatch = (patch: { trimIn?: number; trimOut?: number }) => mainTrimPatch(state, patch);

  function seekTo(sec: number) {
    const clamped = Math.max(0, Math.min(sec, duration));
    if (video) video.currentTime = clamped;
    setT(clamped);
  }
  function onTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (suppressClick.current) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sec = ((e.clientX - rect.left) / rect.width) * duration;
    if (rampMode) {
      addSpeedPointAt(sec);
      return;
    }
    seekTo(sec);
  }

  // ── inline trim handles: drag on the focused lane ─────────────────────────────
  function applyTrimDrag(trackId: string, side: "in" | "out", sec: number) {
    const s = stateRef.current;
    const list = listOf(s);
    const isMain = trackId === list[0].id;
    const tr = list.find((x) => x.id === trackId);
    if (!tr) return;
    const win = isMain ? { in: s.trimIn, out: s.trimOut } : { in: tr.trimIn, out: tr.trimOut };
    if (side === "in") {
      const v = Math.max(0, Math.min(sec, win.out - MIN_LEN));
      if (isMain) updateRef.current(mainTrimPatch(s, { trimIn: v }));
      else updateRef.current({ tracks: (s.tracks ?? []).map((x) => (x.id === trackId ? { ...x, trimIn: v } : x)) });
    } else {
      const v = Math.min(duration, Math.max(sec, win.in + MIN_LEN));
      if (isMain) updateRef.current(mainTrimPatch(s, { trimOut: v }));
      else updateRef.current({ tracks: (s.tracks ?? []).map((x) => (x.id === trackId ? { ...x, trimOut: v } : x)) });
    }
  }

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      applyTrimDrag(drag.trackId, drag.side, ((e.clientX - rect.left) / rect.width) * duration);
    };
    const onUp = () => {
      // The click that follows mouseup would seek — swallow it once.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (drag.side === "in") {
        // Same behavior as the IN slider: park the playhead at the new start.
        const s = stateRef.current;
        const list = listOf(s);
        const tr = list.find((x) => x.id === drag.trackId);
        if (tr) seekTo(tr.id === list[0].id ? s.trimIn : tr.trimIn);
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, duration]);

  // ── speed keyframe drag: vertical position in the lane maps to 0.25×–4× (log scale) ──
  useEffect(() => {
    if (!speedDrag) return;
    const onMove = (e: MouseEvent) => {
      const lane = laneRefs.current.get(speedDrag.trackId);
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const speed = Math.round(yToSpeed((e.clientY - rect.top) / rect.height) * 20) / 20;
      const tr = listOf(stateRef.current).find((x) => x.id === speedDrag.trackId);
      const pts = tr?.speedPoints ?? [];
      if (!tr || !pts[speedDrag.index] || pts[speedDrag.index].speed === speed) return;
      patchTrack(speedDrag.trackId, {
        speedPoints: pts.map((p, i) => (i === speedDrag.index ? { ...p, speed } : p)),
      });
    };
    const onUp = () => {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setSpeedDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speedDrag]);

  // ── crossfade duration drag (Shift+drag on the zone): dx in px → seconds ──────
  useEffect(() => {
    if (!xfDrag) return;
    const onMove = (e: MouseEvent) => {
      const el = trackRef.current;
      if (!el) return;
      const w = Math.max(1, el.getBoundingClientRect().width);
      const delta = ((e.clientX - xfDrag.startX) / w) * duration;
      const dur = Math.round(Math.min(XFADE_MAX, Math.max(XFADE_MIN, xfDrag.startDur + delta)) * 10) / 10;
      const tr = listOf(stateRef.current).find((x) => x.id === xfDrag.trackId);
      if (!tr || tr.transition?.duration === dur) return;
      patchTrack(xfDrag.trackId, { transition: { type: "crossfade", duration: dur } });
    };
    const onUp = () => {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setXfDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xfDrag, duration]);

  // ── split at playhead (Ctrl/Cmd+B): focused track ends at playhead, the rest
  // becomes a new track. Main-track split moves the master trimOut (what renders). ──
  function splitAtPlayhead() {
    const s = stateRef.current;
    const list = listOf(s);
    const target = list.find((x) => x.id === focusRef.current) ?? list[0];
    const isMain = target.id === list[0].id;
    const win = isMain ? { in: s.trimIn, out: s.trimOut } : { in: target.trimIn, out: target.trimOut };
    const at = Math.round(tRef.current * 10) / 10;
    if (at < win.in + MIN_LEN || at > win.out - MIN_LEN) return;
    const right: EditorTrack = {
      ...target,
      id: `track-${Date.now()}`,
      label: `트랙 ${((s.tracks?.length ?? 0) || 1) + 1}`,
      trimIn: at,
      trimOut: win.out,
      // A fresh split starts as a hard cut, even if the source track entered via crossfade.
      transition: { type: "cut", duration: 0 },
    };
    if (isMain) {
      const main = s.tracks?.[0] ?? makeMainTrack(s.trimIn, s.trimOut, Math.max(1, duration));
      const rest = (s.tracks ?? []).slice(1);
      updateRef.current({ trimOut: at, tracks: [{ ...main, trimOut: at }, ...rest, right] });
    } else {
      updateRef.current({
        tracks: (s.tracks ?? []).flatMap((x) => (x.id === target.id ? [{ ...x, trimOut: at }, right] : [x])),
      });
    }
    setSplitFlash(at);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSplitFlash(null), 600);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!SPLIT_ENABLED) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      e.preventDefault();
      splitAtPlayhead();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── zoom: wheel over the lanes scales the timeline (width-based so the canvas
  // waveform re-renders sharp instead of a blurry scaleX). Native listener because
  // React registers wheel as passive — preventDefault must stop page scroll. ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        el.scrollLeft += e.deltaY; // pan when zoomed
        return;
      }
      const prev = zoomRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(1, prev * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
      if (next === prev) return;
      // Keep the second under the cursor stationary across the scale change.
      const cursor = e.clientX - el.getBoundingClientRect().left;
      const anchor = (el.scrollLeft + cursor) / (el.clientWidth * prev);
      pendingScroll.current = anchor * el.clientWidth * next - cursor;
      zoomRef.current = next;
      setZoom(next);
      setZoomBadge(`${Math.round(next * 100)}%`);
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
      badgeTimer.current = setTimeout(() => setZoomBadge(null), 800);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Apply the cursor-anchored scroll in the same frame the new width paints.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current != null) {
      el.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [zoom]);

  useEffect(
    () => () => {
      if (badgeTimer.current) clearTimeout(badgeTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <div className="space-y-3">
      {/* 키보드 단축키 범례 (audit #4) — AENA 트랜스포트 kbd 줄 이식. 강력한 단축키를 발견 가능하게. */}
      <div className="hidden flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-zinc-500 md:flex">
        <span className="inline-flex items-center gap-1"><Kbd>Space</Kbd> 재생</span>
        <span className="inline-flex items-center gap-1"><Kbd>I</Kbd><Kbd>O</Kbd> 구간 시작·끝</span>
        <span className="inline-flex items-center gap-1"><Kbd>Ctrl+Z</Kbd> 되돌리기</span>
        <span className="inline-flex items-center gap-1"><Kbd>Ctrl+S</Kbd> 저장</span>
        <span className="inline-flex items-center gap-1"><Kbd>↑↓←→</Kbd> 오버레이 이동 <span className="text-zinc-600">(Shift 10×)</span></span>
        <span className="inline-flex items-center gap-1"><Kbd>Del</Kbd> 요소 삭제</span>
        <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd> 선택 해제</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onTogglePlay}
          title="재생·일시정지 (Space)"
          className="flex size-9 items-center justify-center rounded-full bg-cyan-600 text-white transition-colors hover:bg-cyan-500"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <span className="tabular-nums text-sm text-zinc-300">
          {formatTimecode(t)} <span className="text-zinc-600">/ {formatTimecode(duration)}</span>
        </span>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
          컷 길이 {formatTimecode(trimmedLen)}
        </span>
        <span className={cn("hidden text-[11px] md:inline", rampMode ? "text-amber-400" : "text-zinc-600")}>
          {rampMode ? "클릭: 속도 키프레임 추가 · 드래그↕: 속도 · 우클릭: 삭제" : "휠: 줌 · Shift+휠: 좌우 이동"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => update({ speed: SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length] })}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            title="기본 재생 속도 (키프레임 없는 구간에 적용)"
          >
            <Gauge className="size-3.5" /> {state.speed}×
          </button>
          {/* 서버 uniformSpeed()는 speedPoints 가 하나라도 있으면 배속을 1× 로 강제한다 —
              램핑은 렌더에 안 들어갈 뿐 아니라 고른 기본 배속까지 무효화한다. */}
          <HookToggle
            icon={TrendingUp}
            label="속도 램핑"
            on={rampMode}
            onClick={() => setRampMode((v) => !v)}
            disabled
            title="가변속 렌더 미지원 — 기본 배속만 결과물에 반영됩니다."
          />
          <HookToggle
            icon={Sparkles}
            label="첫 3초 훅"
            on={state.hookOn}
            onClick={() => update({ hookOn: !state.hookOn })}
            title={
              hookAvailable === false
                ? "이 클립엔 AI hook 시각(hook_time_sec)이 없어 프리롤이 렌더되지 않습니다."
                : "ON 시 렌더(확정)할 때 hook 구간 첫 3초를 프리롤로 앞에 붙입니다 (이탈 방지)."
            }
          />
          {/* silenceCut 을 읽는 서버 코드가 없다 — 켜두면 저장까지 되어 '적용됨'처럼 보였다. */}
          <HookToggle
            icon={Volume2}
            label="무음 제거"
            on={state.silenceCut}
            onClick={() => update({ silenceCut: !state.silenceCut })}
            disabled
            title="무음 제거 렌더 미지원 — 준비 중입니다."
          />
        </div>
      </div>

      {/* tracks: stacked layers (waveform + trim window each) sharing one playhead — click to seek */}
      <div className="flex">
        <div className="w-28 shrink-0 space-y-1 pr-1">
          {showReframeLane && (
            <div className="flex h-10 items-center text-[11px] font-medium text-violet-300">
              AI 리프레임
            </div>
          )}
          {trackList.map((tr) => {
            const vol = tr.volume ?? 1;
            const muted = tr.muted === true;
            return (
              <div key={tr.id} className="relative flex h-10 w-full items-center gap-0.5">
                <button
                  onClick={() => setFocusId(tr.id)}
                  className={cn(
                    "min-w-0 flex-1 truncate text-left text-xs",
                    tr.id === focused.id ? "text-emerald-300" : "text-zinc-400 hover:text-zinc-200",
                  )}
                  title={tr.label}
                >
                  {tr.label}
                </button>
                <button
                  onClick={() => setVolPop((v) => (v === tr.id ? null : tr.id))}
                  className={cn(
                    "shrink-0 rounded px-0.5 text-[9px] tabular-nums",
                    volPop === tr.id ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300",
                  )}
                  title="볼륨 조절"
                >
                  {Math.round(vol * 100)}
                </button>
                <button
                  onClick={() => patchTrack(tr.id, { muted: !muted })}
                  className={cn("shrink-0 rounded p-0.5", muted ? "text-red-400" : "text-zinc-500 hover:text-zinc-300")}
                  title={muted ? "음소거 해제" : "음소거"}
                >
                  {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                </button>
                {volPop === tr.id && (
                  <div className="absolute left-full top-1/2 z-40 ml-1 flex -translate-y-1/2 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 shadow-xl">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(vol * 100)}
                      onChange={(e) => patchTrack(tr.id, { volume: Number(e.target.value) / 100 })}
                      className="w-24"
                    />
                    <span className="w-8 text-right text-[10px] tabular-nums text-zinc-300">
                      {Math.round(vol * 100)}%
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* 하이라이트 훅 북엔드 — 타임라인 왼쪽에 훅을 **분리된 블록**으로(사용자 2026-08-20 · 이미지).
            숏폼(9:16)에 훅 시각이 있을 때만. 클릭하면 훅 지점이 재생된다(onPlayHook). 렌더 반영 여부는
            위 "첫 3초 훅" 토글이 정한다 — 여기선 미리 들어볼 뿐. */}
        {String(state.aspect).startsWith("9:16") && hookAvailable && onPlayHook && (
          <button
            type="button"
            onClick={onPlayHook}
            title={`하이라이트 훅 재생 — 훅 지점으로 이동해 재생${hookCaption ? ` · "${hookCaption}"` : ""}`}
            className={cn(
              "mr-1.5 flex w-16 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch rounded-md px-1 text-white ring-1 transition hover:brightness-110",
              state.hookOn
                ? "bg-gradient-to-b from-pink-500/85 to-orange-500/70 ring-pink-400/50"
                : "bg-gradient-to-b from-pink-500/35 to-orange-500/25 ring-pink-400/25",
            )}
          >
            <Sparkles className="size-4" />
            <span className="text-[10px] font-bold leading-tight">하이라이트</span>
            <span className="text-[10px] font-bold leading-tight">훅</span>
            <span className="mt-0.5 inline-flex items-center gap-0.5 text-[8px] font-semibold opacity-95">
              <Play className="size-2.5" fill="currentColor" /> 첫 3초
            </span>
          </button>
        )}
        <div className="relative min-w-0 flex-1">
          <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
            <div
              ref={trackRef}
              onClick={onTrackClick}
              className="relative cursor-pointer"
              style={{ width: `${zoom * 100}%` }}
            >
              {/* CapCut 스타일 눈금(ruler) — opencut-classic의 ruler-utils 패턴 이식.
                  60px/s×zoom을 기준으로 스마트 간격(2·3·5·10·15 프레임)을 계산해 라벨은 넓게(≥120px),
                  틱은 촘촘히(≥18px) 배치. 우리 EditorState에 fps 필드가 없으므로 기본 30fps로 고정. */}
              {duration > 0 && (() => {
                const fps = { numerator: 30, denominator: 1 };
                const cfg = getRulerConfig({ zoomLevel: zoom, fps });
                const ticks: number[] = [];
                for (let t = 0; t <= duration; t += cfg.tickIntervalSeconds) {
                  ticks.push(Math.round(t * 1000) / 1000);
                  if (ticks.length > 400) break; // 안전장치
                }
                return (
                  <div className="relative h-4 border-b border-zinc-800/70 bg-zinc-950/40">
                    {ticks.map((t, i) => {
                      const isLabel = shouldShowLabel({ time: t, labelIntervalSeconds: cfg.labelIntervalSeconds });
                      return (
                        <div key={i} className="absolute top-0 h-full" style={{ left: pct(t) }}>
                          <div className={cn("h-full w-px", isLabel ? "bg-zinc-600" : "bg-zinc-800")} />
                          {isLabel && (
                            <div className="absolute left-0.5 top-0.5 whitespace-nowrap text-[9px] tabular-nums text-zinc-500">
                              {formatRulerLabel({ timeInSeconds: t, fps })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              {/* 프레임 파노라마 — 눈금 바로 아래, 트랙 위. 같은 스크롤 컨테이너라 줌·좌표 자동 정렬. */}
              {frameMediaId && apiBase && (
                <Filmstrip mediaId={frameMediaId} duration={duration} apiBase={apiBase} />
              )}
              {showReframeLane && (
                <div className="relative mb-1 h-10 overflow-hidden rounded-md border border-violet-500/20 bg-zinc-900/80">
                  {reframeSegments.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-[10px] text-zinc-500">
                      {reframe?.status === "queued" ? "분석 대기 중" : reframe?.status === "running" ? "Beat 분석 중" : reframe?.status === "failed" ? "분석 실패" : reframe?.status === "stale" ? "재분석 필요" : "결과 준비 중"}
                    </div>
                  ) : (
                    reframeSegments.map((segment, index) => (
                      <button
                        key={`${segment.beatId ?? index}-${segment.start}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          seekTo(segment.start);
                        }}
                        className={cn(
                          "absolute inset-y-0 overflow-hidden border-r border-zinc-950/60 px-1 text-left text-[9px] font-semibold text-white/90 hover:brightness-125",
                          segment.layout === "fill" ? "bg-violet-500/70" : "bg-sky-600/55",
                        )}
                        style={{
                          left: pct(segment.start),
                          width: pct(Math.max(0, segment.end - segment.start)),
                        }}
                        title={`${segment.layout === "fill" ? "Fill · 풀스크린" : "Fit · 원본 구도"}${typeof segment.score === "number" ? ` · ${Math.round(segment.score)}점` : ""} · 클릭해서 이동`}
                      >
                        <span className="block truncate">
                          {segment.layout === "fill" ? "Fill" : "Fit"}
                          {typeof segment.score === "number" ? ` ${Math.round(segment.score)}` : ""}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              <div className="space-y-1">
                {trackList.map((tr, i) => {
                  const trIn = i === 0 ? state.trimIn : tr.trimIn;
                  const trOut = i === 0 ? state.trimOut : tr.trimOut;
                  const isFocused = tr.id === focused.id;
                  const pts = tr.speedPoints ?? [];
                  const dimmed = tr.muted === true || (tr.volume ?? 1) === 0;
                  // Crossfade overlap tints: this track's own fade-in and the next track's fade-out.
                  const xfIn = i > 0 && tr.transition?.type === "crossfade" ? tr.transition.duration : 0;
                  const next = trackList[i + 1];
                  const xfOut = next?.transition?.type === "crossfade" ? next.transition.duration : 0;
                  return (
                    <div
                      key={tr.id}
                      ref={(el) => {
                        if (el) laneRefs.current.set(tr.id, el);
                        else laneRefs.current.delete(tr.id);
                      }}
                      onMouseDown={() => setFocusId(tr.id)}
                      className={cn(
                        "relative h-10 overflow-hidden rounded-md bg-zinc-800",
                        isFocused && "ring-1 ring-emerald-500/40",
                      )}
                    >
                      <Waveform
                        peaks={peaks}
                        className={cn(
                          "pointer-events-none absolute inset-0 h-full w-full",
                          dimmed ? "opacity-15 grayscale" : i === 0 ? "opacity-80" : "opacity-40",
                        )}
                      />
                      {pts.length > 0 && (
                        <div className="pointer-events-none absolute inset-0">
                          {speedSegments(pts, state.speed, trIn, trOut).map((seg, si) => (
                            <div
                              key={si}
                              className={cn("absolute inset-y-0 flex items-start justify-center", speedTint(seg.speed))}
                              style={{ left: pct(seg.from), width: pct(Math.max(0, seg.to - seg.from)) }}
                            >
                              <span className="mt-0.5 rounded bg-black/40 px-1 text-[9px] tabular-nums">
                                {Number(seg.speed.toFixed(2))}×
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div
                        className="pointer-events-none absolute inset-y-0 rounded-md border border-emerald-500/60 bg-emerald-500/15"
                        style={{ left: pct(trIn), width: pct(Math.max(0, trOut - trIn)) }}
                      >
                        <div className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" />
                        <div className="absolute inset-y-0 right-0 w-0.5 bg-emerald-400" />
                      </div>
                      {xfIn > 0 && (
                        <div
                          className="pointer-events-none absolute inset-y-0 z-10"
                          style={{
                            left: pct(trIn - xfIn / 2),
                            width: pct(xfIn),
                            background: "linear-gradient(90deg, rgba(217,70,239,.4), transparent)",
                          }}
                        />
                      )}
                      {xfOut > 0 && next && (
                        <div
                          className="pointer-events-none absolute inset-y-0 z-10"
                          style={{
                            left: pct(next.trimIn - xfOut / 2),
                            width: pct(xfOut),
                            background: "linear-gradient(90deg, transparent, rgba(217,70,239,.4))",
                          }}
                        />
                      )}
                      {isFocused &&
                        pts.map((p, pi) => (
                          <div
                            key={pi}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSpeedDrag({ trackId: tr.id, index: pi });
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              removeSpeedPoint(tr.id, pi);
                            }}
                            className="absolute z-30 size-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-amber-950/60 bg-amber-300 shadow hover:scale-125"
                            style={{ left: pct(p.time), top: `${speedToY(p.speed) * 100}%` }}
                            title={`${p.speed}× — 드래그↕: 속도 · 우클릭: 삭제`}
                          />
                        ))}
                      {isFocused && (
                        <>
                          <div
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDrag({ trackId: tr.id, side: "in" });
                            }}
                            className="absolute inset-y-0 z-20 flex w-2 cursor-ew-resize items-center justify-center rounded-l-md bg-emerald-500 hover:bg-emerald-400"
                            style={{ left: pct(trIn) }}
                            title="트림 시작 (드래그)"
                          >
                            <div className="h-4 w-px bg-emerald-950/80" />
                          </div>
                          <div
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDrag({ trackId: tr.id, side: "out" });
                            }}
                            className="absolute inset-y-0 z-20 flex w-2 -translate-x-full cursor-ew-resize items-center justify-center rounded-r-md bg-emerald-500 hover:bg-emerald-400"
                            style={{ left: pct(trOut) }}
                            title="트림 끝 (드래그)"
                          >
                            <div className="h-4 w-px bg-emerald-950/80" />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* transition zones — on the seam between adjacent lanes, at the incoming track's
                  start. 현재는 표시 전용(비활성): index.ts 에 track.transition 을 읽는 코드가
                  없어 컷/크로스페이드 선택이 결과물에 반영되지 않는다. */}
              {trackList.map((tr, i) => {
                if (i === 0) return null;
                const transition = tr.transition ?? { type: "cut" as const, duration: 0 };
                const isXf = transition.type === "crossfade";
                const centerY = tracksTop + i * (LANE_H + LANE_GAP) - LANE_GAP / 2;
                return (
                  <button
                    key={`transition-${tr.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (suppressClick.current) return;
                      toggleTransition(tr.id);
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (isXf && e.shiftKey) {
                        e.preventDefault();
                        setXfDrag({ trackId: tr.id, startX: e.clientX, startDur: transition.duration });
                      }
                    }}
                    disabled
                    className={cn(
                      "absolute z-30 flex -translate-y-1/2 cursor-not-allowed items-center justify-center overflow-hidden whitespace-nowrap rounded border text-[9px] font-bold opacity-50",
                      isXf
                        ? "border-fuchsia-400/80 text-fuchsia-100"
                        : "-translate-x-1/2 border-zinc-600 bg-zinc-900 text-zinc-400",
                    )}
                    style={
                      isXf
                        ? {
                            left: pct(tr.trimIn - transition.duration / 2),
                            width: pct(transition.duration),
                            top: centerY,
                            height: 18,
                            minWidth: 42,
                            background:
                              "repeating-linear-gradient(45deg, rgba(217,70,239,.4) 0 4px, rgba(217,70,239,.15) 4px 8px)",
                          }
                        : { left: pct(tr.trimIn), top: centerY, height: 16, width: 16 }
                    }
                    title="전환(크로스페이드) 렌더 미지원 — 서버가 트랙 간 합성을 아직 안 합니다."
                  >
                    {isXf ? `XF ${transition.duration.toFixed(1)}s` : "‖"}
                  </button>
                );
              })}
              {splitFlash != null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 w-0.5 animate-pulse bg-amber-300"
                  style={{ left: pct(splitFlash) }}
                />
              )}
              {/* AI 추천 창 — 트랙 위에 얇은 반투명 밴드로 표시. 트림은 사용자가 자유롭게
                  안팎으로 확장/축소할 수 있고, 이 밴드는 "원본 어디가 AI 추천이었는지"만 알려준다. */}
              {recWindow && recWindow.end > recWindow.start && (
                <>
                  <div
                    className="pointer-events-none absolute inset-y-0 z-0 border-x border-amber-400/40 bg-amber-400/10"
                    style={{ left: pct(recWindow.start), width: pct(Math.max(0.1, recWindow.end - recWindow.start)) }}
                    title={`AI 추천: ${formatTimecode(recWindow.start)}–${formatTimecode(recWindow.end)}`}
                  />
                  <div
                    className="pointer-events-none absolute top-0 z-30 -translate-x-1/2 rounded-b bg-amber-400/80 px-1 text-[9px] font-semibold text-black"
                    style={{ left: pct((recWindow.start + recWindow.end) / 2) }}
                  >
                    AI 추천
                  </div>
                </>
              )}
              <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white" style={{ left: pct(t) }} />
            </div>
          </div>
          {zoomBadge && (
            <div className="pointer-events-none absolute right-2 top-1 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-200">
              {zoomBadge}
            </div>
          )}
        </div>
      </div>

      {/* trim controls + fine-tune */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        <label className="flex items-center gap-2">
          IN
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={state.trimIn}
            onChange={(e) => {
              const v = Math.min(Number(e.target.value), state.trimOut - 0.5);
              update(trimPatch({ trimIn: v }));
              seekTo(v);
            }}
            className="w-32"
          />
          <TimecodeInput
            value={state.trimIn}
            min={0}
            max={state.trimOut - 0.1}
            onCommit={(v) => {
              update(trimPatch({ trimIn: v }));
              seekTo(v);
            }}
            className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center tabular-nums text-zinc-200 outline-none focus:border-zinc-500"
          />
        </label>
        <label className="flex items-center gap-2">
          OUT
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={state.trimOut}
            onChange={(e) => update(trimPatch({ trimOut: Math.max(Number(e.target.value), state.trimIn + 0.5) }))}
            className="w-32"
          />
          <TimecodeInput
            value={state.trimOut}
            min={state.trimIn + 0.1}
            max={duration}
            onCommit={(v) => update(trimPatch({ trimOut: v }))}
            className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center tabular-nums text-zinc-200 outline-none focus:border-zinc-500"
          />
        </label>

        {/* 번인 자막은 원본 STT 절대 시각을 그대로 쓴다(index.ts windowCaptions·buildEditorAss) —
            offsetMs 는 아직 렌더에 안 들어가므로 미리보기 전용임을 라벨에 박아둔다. */}
        <div className="ml-auto flex items-center gap-1">
          <span title="자막 미리보기 타이밍만 조정합니다 — 확정(렌더) 결과물에는 반영되지 않습니다.">
            싱크 <span className="text-zinc-600">(미리보기 전용)</span>
          </span>
          <button onClick={() => update({ offsetMs: state.offsetMs - 100 })}
            title="큰 스텝 -100ms"
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
            −100
          </button>
          <button onClick={() => update({ offsetMs: state.offsetMs - 25 })}
            title="미세 -25ms"
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
            −25
          </button>
          <input
            type="number"
            step={5}
            value={state.offsetMs}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) update({ offsetMs: Math.round(v) });
            }}
            className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center tabular-nums text-zinc-200 outline-none focus:border-zinc-500"
            title="직접 입력 (ms · 음수면 자막 지연)"
          />
          <span className="text-zinc-500">ms</span>
          <button onClick={() => update({ offsetMs: state.offsetMs + 25 })}
            title="미세 +25ms"
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
            +25
          </button>
          <button onClick={() => update({ offsetMs: state.offsetMs + 100 })}
            title="큰 스텝 +100ms"
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
            +100
          </button>
          <button onClick={() => update({ offsetMs: 0 })}
            title="원위치 (0ms)"
            className="ml-0.5 rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
            리셋
          </button>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-sans text-[10px] leading-none text-zinc-300">
      {children}
    </kbd>
  );
}

function HookToggle({
  icon: Icon,
  label,
  on,
  onClick,
  title,
  disabled,
}: {
  icon: typeof Sparkles;
  label: string;
  on: boolean;
  onClick: () => void;
  title?: string;
  /** 렌더가 읽지 않는 토글은 켜지지 않게 막고 사유를 title 로 붙인다. */
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
        on ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800",
        disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
      )}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

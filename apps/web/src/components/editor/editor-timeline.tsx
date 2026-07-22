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
  type KeyframePoint,
  type KfSelection,
  type SpeedPoint,
} from "@/lib/editor/presets";
import { useAudioPeaks, Waveform } from "@/components/editor/editor-waveform";
import { TimecodeInput } from "@/components/editor/editable-timecode";
import { getRulerConfig, shouldShowLabel, formatRulerLabel } from "@/vendor/opencut/ruler-utils";

type Update = (patch: Partial<EditorState>) => void;
const SPEEDS = [0.5, 1, 1.5, 2];
const MIN_LEN = 0.5; // seconds — smallest trim window / split piece
const MAX_ZOOM = 8; // 800%
const MIN_OVERLAY_LEN = 0.2; // seconds — smallest overlay visibility window
// Lane geometry (px) — must match the h-10 / h-5 / space-y-1 classes below; used to
// place transition zones on the seam between adjacent track lanes.
const LANE_H = 40;
const LANE_GAP = 4;
const OVERLAY_LANE_H = 20;

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
  startOffset = 0,
  video,
  videoUrl,
  tracks,
  onTogglePlay,
  kfSel,
  onKfSelect,
}: {
  state: EditorState;
  update: Update;
  duration: number;
  /** Master-absolute seconds where the segment (relative t=0) begins. The <video> streams
   *  the master, so we map segment-relative time ⇄ element time by ± startOffset. */
  startOffset?: number;
  video: HTMLVideoElement | null;
  videoUrl?: string;
  /** Vertical layers, stacked. tracks[0] is the main track (mirrors the master trim). */
  tracks?: EditorTrack[];
  onTogglePlay: () => void;
  /** Overlay keyframe selection, shared with the properties panel. */
  kfSel?: KfSelection;
  onKfSelect?: (s: KfSelection) => void;
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
  const [ovDrag, setOvDrag] = useState<{ target: "title" | "element"; id: string; side: "in" | "out" } | null>(null);
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
  useEffect(() => {
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setT(video.currentTime - startOffset);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onTime);
    setPlaying(!video.paused);
    setT(video.currentTime - startOffset);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onTime);
    };
  }, [video, startOffset]);

  // While playing, advance the playhead from the element and loop within the trim window
  // (both in segment-relative seconds; the element runs at startOffset + relative).
  useEffect(() => {
    if (!video || !playing) return;
    const loop = () => {
      const rel = video.currentTime - startOffset;
      if (rel >= state.trimOut) video.currentTime = startOffset + state.trimIn;
      setT(video.currentTime - startOffset);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [video, playing, startOffset, state.trimIn, state.trimOut]);

  // Clamped: t is segment-relative and can run negative / past duration while the
  // element plays the master outside the segment window.
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / Math.max(1, duration)) * 100))}%`;
  const trimmedLen = Math.max(0, state.trimOut - state.trimIn);

  // Backward compat: pre-track editorState renders as a single main track.
  function listOf(s: EditorState): EditorTrack[] {
    return s.tracks && s.tracks.length > 0 ? s.tracks : [makeMainTrack(s.trimIn, s.trimOut, duration)];
  }
  const trackList = listOf(state);
  const focused = trackList.find((x) => x.id === focusId) ?? trackList[0];

  // Timed overlays (title lines + elements) shown as thin bars above the track lanes.
  const overlayItems = [
    ...state.titleLines.map((l) => ({
      target: "title" as const,
      id: l.id,
      label: l.text || "제목",
      item: l as { startSec?: number; endSec?: number },
      cls: "border-amber-400/70 bg-amber-500/40 text-amber-100",
    })),
    ...state.elements.map((el) => ({
      target: "element" as const,
      id: el.id,
      label: el.text || el.type,
      item: el as { startSec?: number; endSec?: number },
      cls: "border-sky-400/70 bg-sky-500/40 text-sky-100",
    })),
  ];
  const tracksTop = overlayItems.length * (OVERLAY_LANE_H + LANE_GAP);

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

  // ── overlay timing: drag a bar edge to set when a title line / element shows.
  // Unset startSec/endSec means "full clip" (legacy states keep behaving as before). ──
  function applyOverlayDrag(target: "title" | "element", id: string, side: "in" | "out", sec: number) {
    const s = stateRef.current;
    const v = Math.round(Math.max(0, Math.min(sec, duration)) * 10) / 10;
    const patchOne = <T extends { id: string; startSec?: number; endSec?: number }>(arr: T[]): T[] =>
      arr.map((o) => {
        if (o.id !== id) return o;
        if (side === "in") return { ...o, startSec: Math.max(0, Math.min(v, (o.endSec ?? duration) - MIN_OVERLAY_LEN)) };
        return { ...o, endSec: Math.min(duration, Math.max(v, (o.startSec ?? 0) + MIN_OVERLAY_LEN)) };
      });
    if (target === "title") updateRef.current({ titleLines: patchOne(s.titleLines) });
    else updateRef.current({ elements: patchOne(s.elements) });
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
    if (video) video.currentTime = startOffset + clamped;
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

  // ── overlay-bar edge drag (title/element show window) ─────────────────────────
  useEffect(() => {
    if (!ovDrag) return;
    const onMove = (e: MouseEvent) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      applyOverlayDrag(ovDrag.target, ovDrag.id, ovDrag.side, ((e.clientX - rect.left) / rect.width) * duration);
    };
    const onUp = () => {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setOvDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ovDrag, duration]);

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
      <div className="flex items-center gap-3">
        <button
          onClick={onTogglePlay}
          className="flex size-9 items-center justify-center rounded-full bg-white text-black"
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
          {rampMode ? "클릭: 속도 키프레임 추가 · 드래그↕: 속도 · 우클릭: 삭제" : "휠: 줌 · Ctrl+B: 분할"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => update({ speed: SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length] })}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            title="기본 재생 속도 (키프레임 없는 구간에 적용)"
          >
            <Gauge className="size-3.5" /> {state.speed}×
          </button>
          <HookToggle icon={TrendingUp} label="속도 램핑" on={rampMode} onClick={() => setRampMode((v) => !v)} />
          <HookToggle icon={Sparkles} label="첫 3초 훅" on={state.hookOn} onClick={() => update({ hookOn: !state.hookOn })} />
          <HookToggle icon={Volume2} label="무음 제거" on={state.silenceCut} onClick={() => update({ silenceCut: !state.silenceCut })} />
        </div>
      </div>

      {/* tracks: stacked layers (waveform + trim window each) sharing one playhead — click to seek */}
      <div className="flex">
        <div className="w-28 shrink-0 space-y-1 pr-1">
          {overlayItems.map((o) => (
            <div
              key={`${o.target}-${o.id}`}
              className="flex h-5 w-full items-center truncate text-[10px] text-zinc-500"
              title={o.label}
            >
              <span className="truncate">{o.label}</span>
            </div>
          ))}
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
              <div className="space-y-1">
                {overlayItems.map((o) => {
                  const os = o.item.startSec ?? 0;
                  const oe = o.item.endSec ?? duration;
                  // 키프레임 다이아몬드 마커 (CapCut 벤치마크·감사 §3 결여 해소).
                  // titleLines/elements의 keyframes는 오버레이 시작(startSec) 기준 상대 시간 → 절대 초 = os+kf.time.
                  const kfsRaw =
                    o.target === "title"
                      ? (state.titleLines.find((l) => l.id === o.id)?.keyframes ?? [])
                      : (state.elements.find((el) => el.id === o.id)?.keyframes ?? []);
                  return (
                    <div key={`${o.target}-${o.id}`} className="relative h-5 rounded bg-zinc-800/50">
                      <div
                        className={cn(
                          "pointer-events-none absolute inset-y-0.5 flex items-center overflow-hidden rounded border px-1.5 text-[9px] font-medium",
                          o.cls,
                        )}
                        style={{ left: pct(os), width: pct(Math.max(0.1, oe - os)) }}
                      >
                        <span className="truncate">{o.label}</span>
                      </div>
                      {/* 키프레임 다이아몬드 — 클릭하면 속성 패널로 선택 이동 */}
                      {kfsRaw.map((kf, idx) => {
                        const absT = Math.max(0, Math.min(duration, os + (kf.time ?? 0)));
                        const isSel = kfSel && kfSel.target === o.id && kfSel.index === idx;
                        return (
                          <button
                            key={`kf-${idx}`}
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            onClick={(e) => { e.stopPropagation(); onKfSelect?.({ target: o.id, index: idx }); }}
                            className={cn(
                              "absolute top-1/2 z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] border transition-colors",
                              isSel
                                ? "border-white bg-white shadow-[0_0_0_1px_rgba(0,0,0,.6)]"
                                : "border-amber-300 bg-amber-400/90 hover:bg-amber-300",
                            )}
                            style={{ left: pct(absT) }}
                            title={`키프레임 ${idx + 1} @ ${(kf.time ?? 0).toFixed(2)}s`}
                          />
                        );
                      })}
                      <div
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOvDrag({ target: o.target, id: o.id, side: "in" });
                        }}
                        className="absolute inset-y-0 z-20 w-1.5 cursor-ew-resize rounded-l bg-white/25 hover:bg-white/60"
                        style={{ left: pct(os) }}
                        title="표시 시작 (드래그)"
                      />
                      <div
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOvDrag({ target: o.target, id: o.id, side: "out" });
                        }}
                        className="absolute inset-y-0 z-20 w-1.5 -translate-x-full cursor-ew-resize rounded-r bg-white/25 hover:bg-white/60"
                        style={{ left: pct(oe) }}
                        title="표시 끝 (드래그)"
                      />
                    </div>
                  );
                })}
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
              {/* transition zones — on the seam between adjacent lanes, at the incoming
                  track's start. Click: cut ⇄ crossfade · Shift+drag: crossfade duration. */}
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
                    className={cn(
                      "absolute z-30 flex -translate-y-1/2 items-center justify-center overflow-hidden whitespace-nowrap rounded border text-[9px] font-bold",
                      isXf
                        ? "border-fuchsia-400/80 text-fuchsia-100"
                        : "-translate-x-1/2 border-zinc-600 bg-zinc-900 text-zinc-400 hover:border-fuchsia-400 hover:text-fuchsia-300",
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
                    title={isXf ? "크로스페이드 — 클릭: 컷으로 · Shift+드래그: 길이 조절" : "컷 전환 — 클릭: 크로스페이드"}
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

        <div className="ml-auto flex items-center gap-1.5">
          <span>싱크 미세조정</span>
          <button onClick={() => update({ offsetMs: state.offsetMs - 100 })} className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800">
            −100ms
          </button>
          <span className="w-14 text-center tabular-nums text-zinc-300">
            {state.offsetMs > 0 ? "+" : ""}
            {state.offsetMs}ms
          </span>
          <button onClick={() => update({ offsetMs: state.offsetMs + 100 })} className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800">
            +100ms
          </button>
        </div>
      </div>
    </div>
  );
}

function HookToggle({
  icon: Icon,
  label,
  on,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
        on ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800",
      )}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

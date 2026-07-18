"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Play, Pause, Gauge, Volume2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils";
import { makeMainTrack, type EditorState, type EditorTrack } from "@/lib/editor/presets";
import { useAudioPeaks, Waveform } from "@/components/editor/editor-waveform";
import { TimecodeInput } from "@/components/editor/editable-timecode";

type Update = (patch: Partial<EditorState>) => void;
const SPEEDS = [0.5, 1, 1.5, 2];
const MIN_LEN = 0.5; // seconds — smallest trim window / split piece
const MAX_ZOOM = 8; // 800%

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

  // Keep playback speed in sync with the transport.
  useEffect(() => {
    if (video) video.playbackRate = state.speed;
  }, [video, state.speed]);

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
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
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
        <span className="hidden text-[11px] text-zinc-600 md:inline">휠: 줌 · Ctrl+B: 분할</span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => update({ speed: SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length] })}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Gauge className="size-3.5" /> {state.speed}×
          </button>
          <HookToggle icon={Sparkles} label="첫 3초 훅" on={state.hookOn} onClick={() => update({ hookOn: !state.hookOn })} />
          <HookToggle icon={Volume2} label="무음 제거" on={state.silenceCut} onClick={() => update({ silenceCut: !state.silenceCut })} />
        </div>
      </div>

      {/* tracks: stacked layers (waveform + trim window each) sharing one playhead — click to seek */}
      <div className="flex">
        <div className="w-20 shrink-0 space-y-1 pr-2">
          {trackList.map((tr) => (
            <button
              key={tr.id}
              onClick={() => setFocusId(tr.id)}
              className={cn(
                "flex h-10 w-full items-center truncate text-left text-xs",
                tr.id === focused.id ? "text-emerald-300" : "text-zinc-400 hover:text-zinc-200",
              )}
              title={tr.label}
            >
              {tr.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
            <div
              ref={trackRef}
              onClick={onTrackClick}
              className="relative cursor-pointer"
              style={{ width: `${zoom * 100}%` }}
            >
              <div className="space-y-1">
                {trackList.map((tr, i) => {
                  const trIn = i === 0 ? state.trimIn : tr.trimIn;
                  const trOut = i === 0 ? state.trimOut : tr.trimOut;
                  const isFocused = tr.id === focused.id;
                  return (
                    <div
                      key={tr.id}
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
                          i === 0 ? "opacity-80" : "opacity-40",
                        )}
                      />
                      <div
                        className="pointer-events-none absolute inset-y-0 rounded-md border border-emerald-500/60 bg-emerald-500/15"
                        style={{ left: pct(trIn), width: pct(Math.max(0, trOut - trIn)) }}
                      >
                        <div className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" />
                        <div className="absolute inset-y-0 right-0 w-0.5 bg-emerald-400" />
                      </div>
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

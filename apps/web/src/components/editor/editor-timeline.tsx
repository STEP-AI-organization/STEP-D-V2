"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, Scissors, Gauge, Volume2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils";
import type { EditorState } from "@/lib/editor/presets";
import { useAudioPeaks, Waveform } from "@/components/editor/editor-waveform";
import { TimecodeInput } from "@/components/editor/editable-timecode";

type Update = (patch: Partial<EditorState>) => void;
const SPEEDS = [0.5, 1, 1.5, 2];

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
  onTogglePlay: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const peaks = useAudioPeaks(videoUrl);

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

  function seekTo(sec: number) {
    const clamped = Math.max(0, Math.min(sec, duration));
    if (video) video.currentTime = startOffset + clamped;
    setT(clamped);
  }
  function onTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  }

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

      {/* track: waveform (speech boundaries) + trim window + playhead — click to seek */}
      <div
        ref={trackRef}
        onClick={onTrackClick}
        className="relative h-12 cursor-pointer overflow-hidden rounded-md bg-zinc-800"
      >
        <Waveform peaks={peaks} className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />
        <div
          className="pointer-events-none absolute inset-y-0 rounded-md border border-emerald-500/60 bg-emerald-500/15"
          style={{ left: pct(state.trimIn), width: pct(trimmedLen) }}
        >
          <Scissors className="absolute -left-2 top-1/2 size-3.5 -translate-y-1/2 text-emerald-400" />
        </div>
        <div className="pointer-events-none absolute top-0 h-full w-0.5 bg-white" style={{ left: pct(t) }} />
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
              update({ trimIn: v });
              seekTo(v);
            }}
            className="w-32"
          />
          <TimecodeInput
            value={state.trimIn}
            min={0}
            max={state.trimOut - 0.1}
            onCommit={(v) => {
              update({ trimIn: v });
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
            onChange={(e) => update({ trimOut: Math.max(Number(e.target.value), state.trimIn + 0.5) })}
            className="w-32"
          />
          <TimecodeInput
            value={state.trimOut}
            min={state.trimIn + 0.1}
            max={duration}
            onCommit={(v) => update({ trimOut: v })}
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

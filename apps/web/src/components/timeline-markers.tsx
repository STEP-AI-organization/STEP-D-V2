"use client";

import { cn } from "@/lib/utils";

export interface TimelineMarker {
  /** seconds from video start */
  start: number;
  /** seconds from video end */
  end: number;
  /** 1–5 appeal score (core/recommend.py 절대평가 — 5=확실히 터진다, 1=비추천) */
  appeal: number;
  /** Short label */
  label?: string;
}

/** Neutral appeal ("쓸만함") for segments that carry no score of their own. */
const NEUTRAL_APPEAL = 3;

/**
 * Opus Clip-style timeline markers — AI-recommended highlight segments
 * shown as colored bars on the video progress track.
 */
export function TimelineMarkers({
  markers,
  durationSec,
  currentTime = 0,
  onSeek,
}: {
  markers: TimelineMarker[];
  durationSec: number;
  currentTime?: number;
  onSeek?: (time: number) => void;
}) {
  if (!durationSec || markers.length === 0) return null;

  return (
    <div className="relative h-8 w-full">
      {/* Track background */}
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />

      {/* Segment markers */}
      {markers.map((m, i) => {
        // Clamp to the track — markers can carry times past the media duration.
        const leftPct = Math.min(Math.max((m.start / durationSec) * 100, 0), 100);
        const widthPct = Math.min(
          Math.max(((m.end - m.start) / durationSec) * 100, 1),
          100 - leftPct,
        );

        return (
          <button
            key={i}
            title={`${m.label ?? ""} (${m.appeal}점)`}
            onClick={() => onSeek?.(m.start)}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 rounded-full transition-all hover:opacity-90",
              m.appeal >= 4
                ? "h-2 bg-status-done shadow-[0_0_6px_var(--color-status-done)]"
                : m.appeal >= 3
                  ? "h-1.5 bg-status-warn"
                  : "h-1 bg-muted-foreground/40"
            )}
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
            }}
          />
        );
      })}

      {/* Current time scrubber */}
      {currentTime > 0 && (
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground transition-all duration-100"
          style={{ left: `${Math.min((currentTime / durationSec) * 100, 100)}%` }}
        />
      )}

      {/* Legend */}
      <div className="absolute -bottom-5 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-status-done" /> 인기 구간
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-status-warn" /> 후보 구간
        </span>
      </div>
    </div>
  );
}

/** Build TimelineMarker[] from AI analysis shorts or recommendations. */
export function markersFromAnalysis(
  shorts: { start: number; end: number; appeal?: number; title?: string }[],
): TimelineMarker[] {
  return shorts
    .filter((s) => s.start != null && s.end != null)
    .map((s) => ({
      start: s.start,
      end: s.end,
      appeal: s.appeal ?? NEUTRAL_APPEAL,
      label: s.title,
    }))
    .sort((a, b) => a.start - b.start);
}
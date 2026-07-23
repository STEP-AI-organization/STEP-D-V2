"use client";

import { cn } from "@/lib/utils";

export interface TimelineMarker {
  /** seconds from video start */
  start: number;
  /** seconds from video end */
  end: number;
  /** 1–5 legacy compressed appeal (호환용). 색·크기 결정에는 score100 우선. */
  appeal: number;
  /** 3축 가중합 0-100 (2026-07-23~). 있으면 이걸 우선 사용. */
  score100?: number;
  /** Short label */
  label?: string;
}

/** Neutral score (0-100) — 스코어 없는 세그먼트용 중립값. legacy appeal 3에 해당. */
const NEUTRAL_SCORE = 50;
const NEUTRAL_APPEAL = 3;

/** 마커 색·크기·툴팁의 단일 진실 소스. score100(0-100) 우선, 없으면 legacy appeal에서 근사. */
function markerScore(m: TimelineMarker): number {
  if (typeof m.score100 === "number") return Math.round(m.score100);
  if (typeof m.appeal === "number") return Math.round((m.appeal - 1) * 25);
  return NEUTRAL_SCORE;
}

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

        const sc = markerScore(m);
        return (
          <button
            key={i}
            title={`${m.label ?? ""} (${sc}점)`}
            onClick={() => onSeek?.(m.start)}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 rounded-full transition-all hover:opacity-90",
              // 0-100 스케일 임계: 75+=인기, 50+=후보, 그 이하 옅게. (legacy 5·4·3에 대응)
              sc >= 75
                ? "h-2 bg-status-done shadow-[0_0_6px_var(--color-status-done)]"
                : sc >= 50
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
  shorts: { start: number; end: number; appeal?: number; score100?: number; title?: string }[],
): TimelineMarker[] {
  return shorts
    .filter((s) => s.start != null && s.end != null)
    .map((s) => ({
      start: s.start,
      end: s.end,
      appeal: s.appeal ?? NEUTRAL_APPEAL,
      score100: s.score100,
      label: s.title,
    }))
    .sort((a, b) => a.start - b.start);
}
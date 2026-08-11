"use client";

/**
 * 마커 데이터 유틸. 예전엔 여기 TimelineMarkers 트랙 컴포넌트도 있었지만 렌더하는 곳이
 * 하나도 없어(실제 트랙은 source-panel 의 ReviewTimeline) 2026-08-11 삭제했다.
 */

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

/** 스코어 없는 세그먼트용 중립값(legacy appeal 3). */
const NEUTRAL_APPEAL = 3;

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
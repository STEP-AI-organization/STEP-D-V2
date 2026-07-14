/**
 * Pipeline helpers — recommendation generation, ID generation.
 * Simple deterministic logic without external AI dependencies.
 */
import crypto from "node:crypto";

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}_${rand}`;
}

export interface Recommendation {
  id: string;
  episodeId: string;
  title: string;
  kind: "short" | "highlight";
  startTime: number;
  endTime: number;
  editNote: string;
  status: string;
  thumbnailCandidates: Array<{ id: string; label: string; time: number }>;
  selectedThumbnailId: string | null;
  adoptedClipId: string | null;
}

/**
 * Build heuristic recommendations for a given episode.
 * Splits the video duration into logical segments and creates
 * short/highlight recommendation slots.
 */
export function buildRecommendations(
  episodeId: string,
  durationSec: number
): Recommendation[] {
  const recs: Recommendation[] = [];
  const minSegLen = 15; // minimum segment length in seconds
  const maxSegLen = 90; // maximum segment length in seconds

  if (durationSec < 30) {
    // Very short video — single highlight
    recs.push(makeRec(episodeId, "highlight", "전체 하이라이트", 0, durationSec, recs.length));
    return recs;
  }

  // Split into chunks
  let cursor = 0;
  const segmentCount = Math.min(5, Math.max(2, Math.floor(durationSec / 45)));

  for (let i = 0; i < segmentCount && cursor < durationSec - 10; i++) {
    const remaining = durationSec - cursor;
    const segLen = Math.min(maxSegLen, Math.max(minSegLen, remaining / (segmentCount - i)));
    const end = Math.min(durationSec, cursor + segLen);

    const kind = segLen <= 60 ? "short" : "highlight";
    const labels = [
      "오프닝 · 훅",
      "초반 몰입 구간",
      "중반 핵심 장면",
      "후반 전개",
      "클라이맥스 · 결말",
    ];
    recs.push(makeRec(episodeId, kind, labels[i] ?? `구간 ${i + 1}`, cursor, end, i));
    cursor = end;
  }

  // Ensure last segment reaches the end
  if (recs.length > 0) {
    const last = recs[recs.length - 1];
    if (last.endTime < durationSec - 2) {
      recs[recs.length - 1] = {
        ...last,
        endTime: durationSec,
        editNote: `${last.editNote} (전체 포함)`,
      };
    }
  }

  return recs;
}

function makeRec(
  episodeId: string,
  kind: "short" | "highlight",
  label: string,
  start: number,
  end: number,
  idx: number
): Recommendation {
  const id = newId("r");
  const duration = end - start;
  const midTime = start + duration * 0.3;

  return {
    id,
    episodeId,
    title: label,
    kind,
    startTime: start,
    endTime: end,
    editNote: `${label} · ${Math.round(duration)}초`,
    status: "pending",
    thumbnailCandidates: [
      { id: `${id}-t1`, label: "시작", time: start + 0.5 },
      { id: `${id}-t2`, label: "핵심", time: midTime },
      { id: `${id}-t3`, label: "끝", time: end - 1 },
    ],
    selectedThumbnailId: `${id}-t2`,
    adoptedClipId: null,
  };
}
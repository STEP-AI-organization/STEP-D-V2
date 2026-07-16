/**
 * STEP-D — controlled vocabulary, single source of truth.
 *
 * In STEPD these tables (clipType / clipCategory / targetAge / aspectRatio / status)
 * are re-defined independently across 5+ files with slightly different labels.
 * v2 centralizes them here so labels/colors never drift. (See docs/reference/glossary.md.)
 */

// ── Clip types ────────────────────────────────────────────────────────────────
export const CLIP_TYPES = {
  T2: "예고편",
  T3: "촬영장 스케치",
  T6: "숏폼",
  T9: "기타",
  TZ: "클립영상",
  TH: "하이라이트",
  TI: "인터뷰",
  TS: "주요장면 기획",
  TT: "구작",
} as const;
export type ClipType = keyof typeof CLIP_TYPES;

// ── Clip categories (SMR 01–11) ────────────────────────────────────────────────
export const CLIP_CATEGORIES = {
  "01": "드라마/영화",
  "02": "예능",
  "03": "뮤직",
  "04": "시사",
  "05": "교양",
  "06": "라이프",
  "07": "스포츠",
  "08": "게임",
  "09": "어린이",
  "10": "뉴스",
  "11": "애니메이션",
} as const;
export type ClipCategory = keyof typeof CLIP_CATEGORIES;

// ── View-age ratings ───────────────────────────────────────────────────────────
export const TARGET_AGES = [0, 7, 12, 15, 19] as const;
export type TargetAge = (typeof TARGET_AGES)[number];
export function targetAgeLabel(age: TargetAge): string {
  return age === 0 ? "전체" : `${age}세`;
}

// ── Aspect ratios ────────────────────────────────────────────────────────────
export const ASPECT_RATIOS = {
  "16:9": "가로 16:9",
  "9:16-letterbox": "세로 9:16 (레터박스)",
  "9:16-crop-main": "세로 9:16 (메인 크롭)",
  "9:16-crop-sub": "세로 9:16 (서브 크롭)",
} as const;
export type AspectRatio = keyof typeof ASPECT_RATIOS;

// ── Pipeline stages (v2 work-centric view) ──────────────────────────────────────
export const PIPELINE_STAGES = [
  "source",
  "merge",
  "split",
  "analyze",
  "recommend",
  "edit",
  "encode",
  "publish",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  source: "소스",
  merge: "병합",
  split: "분할",
  analyze: "분석",
  recommend: "추천",
  edit: "편집",
  encode: "인코딩",
  publish: "배포",
};

// ── Generic status (drives StatusBadge colors) ──────────────────────────────────
export type StatusTone = "idle" | "progress" | "done" | "warn" | "error";

/** Raw STEPD source_set pipeline statuses mapped to a display tone. */
export const PIPELINE_STATUS_TONE: Record<string, StatusTone> = {
  draft: "idle",
  uploaded: "idle",
  merging: "progress",
  merged: "progress",
  splitting: "progress",
  "uploading-gemini": "progress",
  analyzing: "progress",
  analyzed: "progress",
  recommending: "progress",
  recommended: "done",
  ready: "done",
  published: "done",
  failed: "error",
  error: "error",
};

// ── Distribution channels ───────────────────────────────────────────────────────
export const DISTRIBUTION_CHANNELS = {
  smr: "네이버 SMR",
  youtube: "YouTube",
  meta: "Meta Reels",
} as const;
export type DistributionChannel = keyof typeof DISTRIBUTION_CHANNELS;

// ── Recommendation kinds ────────────────────────────────────────────────────────
export const RECOMMENDATION_KINDS = {
  candidate: "후보",
  short: "쇼츠",
  clip: "클립",
} as const;
export type RecommendationKind = keyof typeof RECOMMENDATION_KINDS;

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

// ── Clip categories (방송 카테고리 코드 01–11) ────────────────────────────────────────────────
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
// label = 짧은 표시명 · icon = /channel-icons/*.png 정적 자산 · status = 백엔드 실제 연동
// 여부(implemented=실제로 파일이 올라감, planned=상태 기록만 남는 스텁).
// 새 채널 추가 시: 1) 여기 항목 하나 · 2) apps/web/public/channel-icons/<id>.png · 3) 서버
// /api/distributions/publish 스위치. UI는 이 맵을 순회해 자동으로 카드가 늘어난다.
//
// 네이버는 **클립만** 배포 대상이다 (2026-08-13 사용자 결정 — TV 는 제품에서 제외).
// 서버는 옛 기록 호환을 위해 navertv 를 계속 받지만, 화면은 새 배포 대상으로 내놓지 않는다.
// 서버 채널 id 와 문자열이 정확히 같아야 한다(publish-guard.ts NAVER_CHANNELS).
export const DISTRIBUTION_CHANNELS = {
  youtube:   { label: "YouTube",   icon: "/channel-icons/youtube.png",   status: "implemented" },
  instagram: { label: "Instagram", icon: "/channel-icons/instagram.png", status: "planned" },
  facebook:  { label: "Facebook",  icon: "/channel-icons/facebook.png",  status: "planned" },
  tiktok:    { label: "TikTok",    icon: "/channel-icons/tiktok.png",    status: "planned" },
  naverclip: { label: "네이버 클립", icon: "/channel-icons/naver.png",     status: "implemented" },
} as const;

/** 네이버 채널인가 — 계정 선택·설명 입력이 필요한 축. 서버 판정과 같은 집합이어야 한다. */
export const NAVER_CHANNEL_IDS = ["naverclip"] as const;
export type NaverChannelId = (typeof NAVER_CHANNEL_IDS)[number];
export function isNaverChannel(id: string): id is NaverChannelId {
  return (NAVER_CHANNEL_IDS as readonly string[]).includes(id);
}
export type DistributionChannel = keyof typeof DISTRIBUTION_CHANNELS;
export interface DistributionChannelMeta {
  label: string;
  icon: string | null;
  status: "implemented" | "planned";
}

/** 알려지지 않은 channel id(예: 옛 'meta' 값)를 안전하게 라벨링. undefined 반환 안 함. */
export function channelLabel(id: string): string {
  return (DISTRIBUTION_CHANNELS as Record<string, DistributionChannelMeta>)[id]?.label ?? id;
}
export function channelMeta(id: string): DistributionChannelMeta | undefined {
  return (DISTRIBUTION_CHANNELS as Record<string, DistributionChannelMeta>)[id];
}

// ── Recommendation kinds ────────────────────────────────────────────────────────
export const RECOMMENDATION_KINDS = {
  candidate: "후보",
  short: "쇼츠",
  clip: "클립",
} as const;
export type RecommendationKind = keyof typeof RECOMMENDATION_KINDS;

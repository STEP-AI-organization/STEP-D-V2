/**
 * STEP-D — domain types.
 *
 * Domain shapes for the UI layer (storage contract: docs/reference/data-model.md).
 * Both the mock data layer (lib/data) and the live @stepd/server REST client
 * (lib/data/api.ts) satisfy these shapes.
 */

import type { AspectKey, EditorState } from "@/lib/editor/presets";
import type {
  AspectRatio,
  ClipCategory,
  ClipType,
  DistributionChannel,
  PipelineStage,
  RecommendationKind,
  StatusTone,
  TargetAge,
} from "./constants";

// ── Content hierarchy: Program → Episode → (Clip | Media) ────────────────────────
export interface Program {
  id: string;
  title: string;
  section: string; // 장르 (예능/드라마 …)
  targetAge: TargetAge;
  cast?: string[];
  episodeCount: number;
  status: "active" | "archived";
  /** SMR feed-level requirements — set once per program (plan §3, §5.1③). */
  smr?: ProgramSmrConfig;
  /** 파이프라인 분기 축(2026-07-24~). section("예능") 표시와 별개로 코어 파이프라인이 어떤
   *  트랙을 타야 하는지 명시. "variety"·"drama"만 지원 — 미설정이면 자동 판정. 씬 청크 크기,
   *  shot 임계, faces 정면성 관용도, recommend 프롬프트 팩이 이 값에 따라 분기. */
  pipelineGenre?: "variety" | "drama";
  // ── TV/OTT 프로그램 정보 (program-home-prototype.html 참고) ───────────────────
  /** 시놉시스 · 프로그램 소개 (multi-line 허용). */
  synopsis?: string;
  /** 방송 채널 · 편성 채널 (예: "ENA · SBS플러스"). */
  broadcaster?: string;
  /** 편성 정보 (예: "수 밤 10:30", "매주 토 저녁 7시 50분"). */
  schedule?: string;
  /** 첫 방송일 (자유 형식 문자열 예: "2021.07.14"). */
  firstAiredDate?: string;
  /** 현재 회차/기수 정보 (예: "25기 191회~"). */
  currentInfo?: string;
  /** 연출 · 감독. */
  director?: string;
  /** 스핀오프 프로그램명. */
  spinoff?: string;
  /** 수상 이력. */
  awards?: string;
  /** 분위기·서브장르 태그 (예: ["극사실주의","돌직구","삼각관계"]). */
  moods?: string[];
  /** 프로그램 대표 이미지(포스터) — data URL로 저장(base64). 프로그램 상세 페이지 히어로.
   *  TODO: 사이즈 상한이 있으니 향후 /api/programs/:id/poster 업로드 라우트로 옮기는 게 이상적. */
  posterImageDataUrl?: string;
  /** 출연자별 인물 이미지 매핑 — cast 배열의 이름을 키로 data URL 저장.
   *  cast에서 이름이 제거되면 해당 키도 정리(서버 PATCH 시). */
  castPhotos?: Record<string, string>;
}

/**
 * Program-level SMR feed metadata. In STEPD these gate whether the whole program
 * (and thus its clips) can appear in the 네이버 SMR XML feed
 * (validateAggregateFeedProgramInfo). Kept off the per-clip publish path so
 * operators don't re-enter them for every clip.
 */
export interface ProgramSmrConfig {
  /** SMR programcode — lowercase alphanumeric (`^[a-z0-9]+$`). */
  programCode?: string;
  /** SMR category code: 01/02/03. */
  category?: string;
  /** Broadcast weekdays 0(일)–6(토) → SMR weekcode (≥1 required). */
  weekdays?: number[];
  /** 포스터 이미지 등록 여부. */
  posterReady?: boolean;
  /** 프로그램 썸네일 이미지 등록 여부. */
  thumbnailReady?: boolean;
}

export interface Episode {
  id: string;
  programId: string;
  programTitle: string;
  episodeNumber: number;
  broadDate: string; // YYYY-MM-DD
  targetAge: TargetAge;
  /** Current position + health of this episode in the production pipeline. */
  pipeline: EpisodePipeline;
}

/** Per-stage progress for one episode — powers the "회차 파이프라인 허브" (plan §7.2). */
export interface EpisodePipeline {
  stage: PipelineStage;
  stageStatus: StatusTone;
  /** 0–100 for the active stage, when a job is running. */
  progress?: number;
  /** Human-readable note, e.g. "추천 18건 · 채택 대기". */
  note?: string;
  /** Populated when a stage is blocked/failed and needs operator action. */
  blockedReason?: string;
}

// ── AI recommendation (review board / one-click adopt) ───────────────────────────
export interface ThumbnailCandidate {
  id: string;
  /** Seconds into the master where the frame is captured. */
  atTime: number;
  /** Short label describing the frame (배경/인물 등). */
  label: string;
}

export interface Recommendation {
  id: string;
  episodeId: string;
  kind: RecommendationKind;
  title: string;
  /** 처음 제목 생성 단계에서 뽑힌 대체 제목 후보들 (기본 title 포함/미포함 무관).
   *  에디터의 '제목 후보' 탭이 이 배열을 후보 리스트로 표시한다. 비어 있으면 title 하나만. */
  titleCandidates?: string[];
  /** 1–5 legacy compressed appeal (higher = surfaced first). 2026-07-23~는 score100/3축이 진짜 스코어. */
  appeal: number;
  /** 3축 가중합 0-100 — 2026-07-23~ 신규. hook 0.40·payoff 0.35·완결 0.25. */
  score100?: number;
  /** 3축 각 축 0-10 — score100의 근거. 옛 회차는 없을 수 있음. */
  hookStrength?: number;
  payoff?: number;
  completeness?: number;
  startTime: number; // seconds into master
  endTime: number;
  thumbnailUrl?: string;
  /** Candidate thumbnails the operator picks from (STEPD pain C5: shown but no select). */
  thumbnailCandidates?: ThumbnailCandidate[];
  selectedThumbnailId?: string;
  people?: string[];
  brands?: string[];
  editNote?: string;
  status: "pending" | "adopted" | "rejected";
  rejectReason?: string;
  /** Chosen thumbnail candidate label, carried from the adopted recommendation. */
  thumbnailLabel?: string;
  /** Generated multi-layer thumbnails from AI session (v1, v2, v3 variants) */
  thumbnails?: ThumbnailVariant[];
  /** Lineage: set once adopted → clip. */
  adoptedClipId?: string;
}

export interface ThumbnailVariant {
  id: string;              // "s1_v1"
  urls: Record<string, string>; // {"16:9": "analysis/..._16x9.png", "9:16": "..."}
  aspect_ratios: string[];
  frame_source_sec: number;
  caption_text: string;
  caption_tone: string;
  layout_preset: string;
  person_bbox_used: number[];
  generated_at: number;
  chosen: boolean;
}

// ── Clip (Finalized media output) ────────────────────────────────────────────────
/**
 * Destinations that have a render preset (frame + hard length cap) — mirrors the server's
 * RENDER_PRESETS keys, which in turn mirror core/channels.py CHANNEL_PRESETS.
 */
export type RenderChannel = "youtube_shorts" | "instagram_reels" | "smr";

/**
 * What each preset does to the render. Labels/caps are shown in the export selector, and
 * `aspect` is the frame the editor switches to when that destination is picked — it must stay
 * an AspectKey so preview and burn-in agree. Mirrors the server's RENDER_PRESETS.
 */
export const RENDER_CHANNELS: Record<RenderChannel, { label: string; aspect: AspectKey; maxSec: number }> = {
  youtube_shorts: { label: "YouTube Shorts", aspect: "9:16", maxSec: 60 },
  instagram_reels: { label: "Instagram Reels", aspect: "9:16", maxSec: 90 },
  smr: { label: "SMR (포털 VOD)", aspect: "16:9", maxSec: 180 },
};

export interface Clip {
  id: string;
  episodeId: string;
  programTitle: string;
  title: string;
  clipType: ClipType;
  clipCategory?: ClipCategory;
  targetAge: TargetAge;
  aspectRatio: AspectRatio;
  durationSec: number;
  thumbnailUrl?: string;
  /** Chosen thumbnail candidate label, carried from the adopted recommendation. */
  thumbnailLabel?: string;
  /** Short description — maps to the 내용 column of the STEPD report (clip.synopsis). */
  synopsis?: string;
  /** Real backend: server-relative stream URL of the encoded clip video (playable). */
  videoUrl?: string;
  /** Real backend: media id of the encoded clip / the source master it came from. */
  mediaId?: string;
  sourceMediaId?: string;
  /** True once the single export render produced a deliverable (plan §2.4 deferred-render). */
  rendered?: boolean;
  /** Hash of the render-affecting decisions — caches identical re-exports (no re-encode). */
  renderRevision?: string;
  /**
   * Destination the AI matrix suggested at adopt (F3) — seeds the export selector's default.
   * Null/absent = no suggestion (matrix absent, or the clip fits nowhere): the export defaults
   * to "원본 유지", which renders exactly as it did before presets existed.
   */
  targetChannel?: RenderChannel | null;
  /** The preset the last export actually rendered with (null = 원본 유지). */
  renderPreset?: RenderChannel | null;
  /** Adopted segment window in the master (seconds) — drives render-free preview + export. */
  startTime?: number;
  endTime?: number;
  status: "editing" | "encoding" | "ready" | "published";
  /** Lineage back-references. */
  sourceRecommendationId?: string;
  /** Serialized editor decisions (revision JSON) — persisted on save, no render (plan §2.4). */
  editorState?: EditorState;
  distributions: DistributionState[];
}

// ── Account connections (channel-level, set once) ────────────────────────────────
/** Whether each push-channel account is connected. SMR is an internal feed (no OAuth). */
export interface Connections {
  /** YouTube channel OAuth connected. */
  youtube: boolean;
  /** Meta page connected. */
  meta: boolean;
  /** Instagram Business account linked to the Meta page (required for IG Reels). */
  metaInstagram: boolean;
}

// ── Distribution (per-channel state) ─────────────────────────────────────────────
export type MetaPlatform = "instagram" | "facebook";

export interface DistributionState {
  channel: DistributionChannel;
  /** "pending" = upload queued/in-flight on the worker; resolves to published/scheduled/failed. */
  status: "none" | "pending" | "scheduled" | "published" | "failed";
  reserveDate?: string; // KST, honest scheduling (plan §7.5)
  error?: string;
  /** Channel-specific metadata captured at publish (mirrors STEPD distributions.metadata jsonb). */
  platforms?: MetaPlatform[]; // Meta: which surfaces were published
  /** External ref on the channel — YouTube videoId / Meta post id (→ dist.metadata.youtubeVideoId). */
  externalId?: string;
  /** YouTube: the connected channel this clip was (or is being) uploaded to. */
  youtubeChannelId?: string;
}

// ── Inbox / action-queue item (home screen) ──────────────────────────────────────
export type InboxKind =
  | "recommend-review"
  | "edit-pending"
  | "register-pending"
  | "publish-pending"
  | "distribution-failed";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  subtitle: string;
  episodeId?: string;
  count?: number;
  tone: StatusTone;
}

// ── Media asset (real uploaded/encoded video, from the backend) ──────────────────
export interface MediaAsset {
  id: string;
  episodeId: string | null;
  role: "master" | "clip" | string;
  title: string;
  filename: string;
  mime: string;
  size: number;
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  /** Server-relative URLs (prepend the API base to load). */
  streamUrl: string;
  thumbUrl: string | null;
  createdAt: number;
}

// ── Background job (job/alert center) ────────────────────────────────────────────
export interface JobEvent {
  id: string;
  label: string;
  stage: PipelineStage;
  status: "running" | "done" | "failed";
  progress?: number;
  episodeId?: string;
  needsAction?: boolean;
}

// ── YouTube channel video & trend types ──────────────────────────────────────────
export interface YouTubeChannelVideo {
  id: string;
  channelId: string;
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  thumbnail: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  lastSynced: number;
  /** True if this upload is a YouTube Short (verified server-side via a /shorts/ probe, not by duration). */
  isShort?: boolean;
}

export interface ChannelTrendSummary {
  totalViews: number;
  videoCount: number;
  recentPeriodViews: number;
  earlierPeriodViews: number;
  growthPercent: number;
  /** Recent-window rollups from channel_analytics (real daily data). */
  watchMinutes?: number;
  netSubscribers?: number;
  channelRevenue?: number; // USD, monetized channels only
  periodDays?: number;
}

export interface DailyTrend {
  date: string;
  totalViews: number;
  count: number;
}

export interface VideoTrend {
  video: YouTubeChannelVideo;
  trend: { date: string; views: number; likes: number; comments: number }[];
}

export interface SyncResponse {
  ok: boolean;
  channelId: string;
  videoCount: number;
  inserted: number;
  updated: number;
  snapshotCount: number;
}

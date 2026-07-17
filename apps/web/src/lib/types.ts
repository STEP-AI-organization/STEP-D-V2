/**
 * STEP-D — domain types.
 *
 * Domain shapes for the UI layer (storage contract: docs/reference/data-model.md).
 * Both the mock data layer (lib/data) and the live @stepd/server REST client
 * (lib/data/api.ts) satisfy these shapes.
 */

import type { EditorState } from "@/lib/editor/presets";
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
  /** 1–5 appeal score from the recommend pass (higher = surfaced first). */
  appeal: number;
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
  /** Lineage: set once adopted → clip. */
  adoptedClipId?: string;
}

// ── Clip (finished asset) ────────────────────────────────────────────────────────
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

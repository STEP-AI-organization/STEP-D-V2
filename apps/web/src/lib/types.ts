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

/**
 * 프로그램 편성 상태 (FLOWS F10) — 카드 내용이 상태마다 다르다.
 * 방영 중은 진행 바, 종영은 종영일·마지막 배포일(클립 생성 단계 없음),
 * 편성 예정은 첫 방송 전까지 회차를 숨긴다.
 */
export type ProgramStatus = "airing" | "ended" | "upcoming";

export interface Program {
  id: string;
  title: string;
  section: string; // 장르 (예능/드라마 …)
  targetAge: TargetAge;
  cast?: string[];
  episodeCount: number;
  /**
   * 편성 상태 — 사람이 지정한다(자동 판정 없음, 2026-08-10 확정).
   * 결방·시즌 종료 같은 현실은 날짜로 못 잡는다.
   *
   * `"active"`/`"archived"` 는 구버전 저장값이다. 마이그레이션 대신 읽을 때
   * `normalizeProgramStatus()` 로 좁힌다 — 프로그램은 JSONB 엔티티라 스키마 변경이 없고,
   * 운영자가 셀렉트를 한 번 건드리면 새 값으로 덮인다.
   */
  status: ProgramStatus | "active" | "archived";
  /** 담당 PD 이름. "내 담당만" 필터가 이 값과 현재 사용자 이름을 비교한다. */
  owner?: string;
  /** 종영일 (ISO date, 예: "2026-03-24"). 상태가 ended 일 때만 의미 있다. */
  endedDate?: string;
  /**
   * 디지털 권리 만료일 (ISO date). 임박하면 프로그램 카드·대시보드에 경고 톤으로 뜬다(F3).
   * ⚠️ 이 날짜가 지나도 시스템이 배포를 자동 차단하지 않는다 — 게이트는 사람이 등록한
   * 이슈로만 걸린다(F3 "자동 판정 없음"). 여기서 하는 일은 경고까지다.
   */
  rightsUntil?: string;
  /** 권리 관련 자유 메모 (예: "해외 배포 불가 · 국내만", "재계약 확인"). */
  rightsNote?: string;
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
  /** 쇼츠 브랜딩 아이콘(data URL) — 자동 렌더 하단 원형 아이콘. 프로그램에서 미리 설정. */
  brandIconDataUrl?: string;
  /** 출연자별 인물 이미지 매핑 — cast 배열의 이름을 키로 data URL 저장.
   *  cast에서 이름이 제거되면 해당 키도 정리(서버 PATCH 시). */
  castPhotos?: Record<string, string>;
  /** 쇼츠·클립 제목 생성 시 이 프로그램에만 덧붙는 운영자 추가 지시.
   *  저장 즉시가 아니라 **다음 content.analyze 부터** 프롬프트에 주입된다 —
   *  이미 분석된 회차는 재분석해야 반영. 빈 값이면 필드 자체가 없다(지시 없음). */
  titlePrompt?: string;
  /** 추천 구간(BEAT 조합) 생성 시 덧붙는 운영자 추가 지시. 반영 시점은 titlePrompt 와 같다. */
  recommendPrompt?: string;
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
  /** 두 줄 제목 (2026-07-29): AI 가 setup/payoff 로 분리해 라인당 최대 15자.
   *  라인1 = 상단 흰색 setup (오해·질문) · 라인2 = 하단 파란색 payoff (반전·정답).
   *  editor 초기 오버레이 렌더에 사용. 없으면 title 한 줄 폴백. */
  titleLine1?: string;
  titleLine2?: string;
  /** 처음 제목 생성 단계에서 뽑힌 대체 제목 후보들 (기본 title 포함/미포함 무관).
   *  에디터의 '제목 후보' 탭이 이 배열을 후보 리스트로 표시한다. 비어 있으면 title 하나만. */
  titleCandidates?: string[];
  /** 1–5 legacy compressed appeal (higher = surfaced first). 2026-07-23~는 score100/3축이 진짜 스코어. */
  appeal: number;
  /** 0-100 메인 스코어. 2026-08-06~ **결정론 계산**(signal 0.40·hook 0.25·length 0.20·closure 0.15).
   *  그 이전 회차는 LLM 3축 가중합이었다. */
  score100?: number;
  /** ⚠️ LLM 3축 (2026-07-23~08-06). 이후 회차는 **없다** — LLM 점수는 실행마다 달라져 제거됨. */
  hookStrength?: number;
  payoff?: number;
  completeness?: number;
  /** score100 근거 (2026-08-06~). signal·hook·length·closure 각 0-1. 3축을 대체한다. */
  scoreParts?: Record<string, number | boolean>;
  /** 쇼츠 첫 3초 hook intro (2026-07-31 · docs/plans/shorts-hook-intro-3sec.md) — 이탈 방지.
   *  core가 채우고, 카드/에디터에서 미리보기·편집. 옛 회차·미생성은 없음. */
  hookQuote?: string;        // 실 대사 원문 인용 (STT 그대로)
  hookTimeSec?: number;      // hook 대사 시각 (쇼츠 시작 상대 · 초)
  hookIntroCaption?: string; // 어그로 편집자막 ("충격 고백!" 톤)
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
export type RenderChannel = "youtube_shorts" | "instagram_reels" | "naver_tv";

/**
 * What each preset does to the render. Labels/caps are shown in the export selector, and
 * `aspect` is the destination's **ratio family** ("9:16"/"16:9"); the editor maps it to a
 * concrete 5-value AspectKey (portrait defaults to crop-main) when that destination is picked,
 * so preview and burn-in agree. Mirrors the server's RENDER_PRESETS.
 */
export const RENDER_CHANNELS: Record<RenderChannel, { label: string; aspect: "16:9" | "9:16"; maxSec: number }> = {
  youtube_shorts: { label: "YouTube Shorts", aspect: "9:16", maxSec: 60 },
  instagram_reels: { label: "Instagram Reels", aspect: "9:16", maxSec: 90 },
  naver_tv: { label: "네이버 TV (가로 VOD)", aspect: "16:9", maxSec: 180 },
};

export type ReframeMode = "basic" | "ai_multi";
export type ReframeStatus = "idle" | "queued" | "running" | "ready" | "stale" | "failed";
export type ReframeLayout = "fit" | "fill";

export interface ReframeTrackingPoint {
  /** Seconds on the source master timeline. */
  t: number;
  /** Normalized source-frame focus coordinates (0..1). */
  cx: number;
  cy: number;
  confidence?: number;
}

export interface ReframeSegment {
  beatId?: string | number;
  /** Seconds on the source master timeline. */
  start: number;
  end: number;
  layout: ReframeLayout;
  /** Integer score on a 0..100 scale. */
  score?: number;
  reasonCodes?: string[];
  tracking?: ReframeTrackingPoint[];
}

export interface ReframePlan {
  version: 1;
  mode: "ai_multi";
  sourceStart: number;
  sourceEnd: number;
  segments: ReframeSegment[];
}

export interface ClipReframe {
  mode: ReframeMode;
  status: ReframeStatus;
  timeBase?: "master_absolute";
  revision?: number;
  inputFingerprint?: string;
  requestId?: string;
  jobId?: string | null;
  planHash?: string;
  plan?: ReframePlan;
  overallScore?: number;
  reasonCodes?: string[];
  modelVersion?: string;
  requestedAt?: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  error?: { code?: string; message: string; at?: number } | string | null;
}

/** 편집본(직접 업로드) 유형 — 업로드할 때 사람이 지정한다. */
export type EditKind = "shorts" | "clip" | "highlight";

export const EDIT_KIND_LABEL: Record<EditKind, string> = {
  shorts: "숏폼",
  clip: "클립",
  highlight: "하이라이트",
};

export interface Clip {
  id: string;
  episodeId: string;
  programTitle: string;
  /** 완성 영상 직접 업로드로 만들어진 클립 — 분석·회차 없이 파일 자체가 산출물. 편집(트림·리프레임) 비대상. */
  directUpload?: boolean;
  /** 프로그램 링크 (직접 업로드 클립은 episodeId 가 없어 이 값으로 프로그램을 표시한다). */
  programId?: string;
  /** 편집본이 기록한 회차 번호 — 같은 번호의 회차가 시스템에 있으면 episodeId 도 연결돼 있다. */
  episodeNumber?: number;
  /** 편집본 유형(숏폼·클립·하이라이트) — 업로드 때 지정. */
  editKind?: EditKind;
  title: string;
  /** 두 줄 제목 (2026-07-29): editor 오버레이 · 라인1 흰색 setup · 라인2 파란색 payoff. */
  titleLine1?: string;
  titleLine2?: string;
  /** 첫 3초 hook intro (2026-08-02 · docs/plans/shorts-hook-intro-3sec.md) — adopt 시 rec 에서 승계.
   *  에디터 "첫 3초 훅" 토글(editorState.hookOn) ON + hookTimeSec 있을 때 /export 가 프리롤로 붙인다. */
  hookQuote?: string;
  hookTimeSec?: number;
  hookIntroCaption?: string;
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
  /** Beat-by-beat AI Fit/Fill analysis. Times always reference the source master. */
  reframe?: ClipReframe;
  distributions: DistributionState[];
}

// ── Account connections (channel-level, set once) ────────────────────────────────
/**
 * 채널 계정이 연결돼 있는가.
 *
 * `naver` 만 OAuth 가 아니다 — 네이버는 공개 업로드 API 가 없어서, 사람이 로그인해 만든
 * 브라우저 세션이 등록돼 있는지를 뜻한다(배포채널 화면 → 네이버 연결 계정).
 * YouTube·네이버는 실제 배선됨 · Meta/TikTok 은 UI 슬롯만 있고 파일은 올라가지 않는다.
 */
export interface Connections {
  youtube: boolean;
  instagram: boolean;
  facebook: boolean;
  tiktok: boolean;
  naver: boolean;
}

// ── Distribution (per-channel state) ─────────────────────────────────────────────

export interface DistributionState {
  channel: DistributionChannel;
  /**
   * "pending" = 워커 큐에 들어감(업로드 중) → published/scheduled/failed 로 풀린다.
   *
   * **"recorded" 는 게시가 아니다** (F4 Invariant · FLOWS.md:92). Meta·TikTok 은
   * 파일이 올라가지 않는다 — 우리 쪽 기록만 남고 실제 게시는 담당자가 해당 앱에서 직접 한다.
   * 그래서 published 와 같은 톤·같은 문구로 그리면 안 된다.
   */
  status: "none" | "pending" | "scheduled" | "published" | "recorded" | "failed";
  /**
   * 자동/수동 구분 (서버 publish-dispatch.ts 가 기록에 남긴다 · 2026-08-13~).
   * "automation"·"factory" = 자동, "manual"·"retry" = 수동. **구 기록에는 없다** —
   * 없으면 화면은 배지를 그리지 않는다(추측 표기 금지).
   */
  origin?: string;
  reserveDate?: string; // KST, honest scheduling (plan §7.5)
  error?: string;
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

// ── YouTube 트렌드 (mostPopular chart) ────────────────────────────────────────
export interface TrendingVideo {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSec: number;
  thumbnail: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  categoryId: string;
  tags: string[];
}

export interface VideoCategory {
  id: string;
  title: string;
  assignable: boolean;
}

export interface TrendingResponse {
  regionCode: string;
  categoryId: string;
  count: number;
  videos: TrendingVideo[];
  fetchedAt: number;
}

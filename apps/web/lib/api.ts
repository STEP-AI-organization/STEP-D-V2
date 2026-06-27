export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type SubtitleMode = "auto" | "on" | "off";
export type ShortsStylePreset = "korean_pop" | "clean" | "news";

export type VideoInspection = {
  filename: string;
  size_bytes: number;
  duration_seconds?: number | null;
  has_subtitle_stream: boolean;
};

export type Job = {
  job_id: string;
  status: JobStatus;
  progress: number;
  error?: string | null;
  duration?: number | null;
  original_filename: string;
  created_at: string;
  updated_at: string;
};

export type YouTubeMetadata = {
  youtube_title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  labels: string[];
  category: string;
  privacy_status: string;
  made_for_kids: boolean;
  source_start_time: string;
  source_end_time: string;
  duration_seconds: number;
  thumbnail_text?: string | null;
  thumbnail_description?: string | null;
  upload_note: string;
};

export type TitleOption = {
  id: string;
  title: string;
  overlay_text: string;
  style: string;
  reason: string;
};

export type ScoreBreakdownItem = {
  label: string;
  value: number;
};

export type KoreanShortsSignals = {
  hook_terms: string[];
  labels: string[];
  score_breakdown: ScoreBreakdownItem[];
  selection_basis: string;
  boundary_reason?: string;
  title_styles: string[];
  fallback: boolean;
};

export type ClipBriefing = {
  score_band: string;
  hook_line: string;
  why_it_works: string;
  first_three_seconds: string;
  retention_plan: string[];
  risk_flags: string[];
  upload_actions: string[];
  score_summary: Record<string, number>;
};

export type RenderTemplate = {
  id: string;
  label: string;
  platform: string;
  kind: string;
  badge_text: string;
  position: string;
  scale: number;
};

export type CreativeApplyRequest = {
  title: string;
  thumbnail_text: string;
  template_id: string;
  asset_id?: string | null;
  overlay_position: string;
  overlay_scale: number;
  editor_state?: Record<string, unknown>;
  burn_overlays?: Record<string, unknown>[];
  metadata_overrides?: Record<string, unknown>;
};

export type HighlightRenderRequest = {
  clip_ids: string[];
  title: string;
  aspect?: "landscape" | "vertical" | "square";
  max_duration_seconds?: number;
};

export type HighlightRenderResponse = {
  job_id: string;
  title: string;
  video_url: string;
  duration_seconds: number;
  clip_count: number;
  aspect: string;
};

export type AssetUploadResponse = {
  asset_id: string;
  asset_url: string;
  filename: string;
  content_type?: string | null;
};

export type Clip = {
  clip_id: string;
  rank: number;
  title: string;
  score: number;
  local_score: number;
  gemini_score: number;
  start_time: string;
  end_time: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  reason: string;
  video_url: string;
  thumbnail_url: string;
  source_thumbnail_url?: string | null;
  thumbnail_text?: string | null;
  thumbnail_description?: string | null;
  best_frame_time?: number | null;
  transcript: string;
  youtube_metadata: YouTubeMetadata;
  title_options: TitleOption[];
  thumbnail_text_options?: ThumbnailTextOption[];
  edit_status?: string | null;
  creative_settings: Record<string, unknown>;
  render_revision: number;
  youtube_package_url?: string | null;
  korean_shorts_signals: KoreanShortsSignals;
  clip_briefing: ClipBriefing;
  ppl_analysis?: PplAnalysis | null;
};

export type PplDetection = {
  product_id: string;
  brand: string;
  product: string;
  box: [number, number, number, number]; // [x, y, w, h] normalized 0..1
  confidence: number;
};

export type PplFrame = {
  timestamp: number;
  detections: PplDetection[];
};

export type PplProduct = {
  id: string;
  brand: string;
  product: string;
  category: string;
  confidence: number;
  first_seen: number;
  last_seen: number;
  frames_seen: number;
  exposure_seconds: number;
  best_box: [number, number, number, number];
  affiliate_url: string;
};

export type PplAnalysis = {
  status: string;
  model?: string;
  analyzed_at?: string;
  duration_seconds: number;
  frame_count: number;
  products: PplProduct[];
  frames: PplFrame[];
};

export type Results = {
  job_id?: string | null;
  status?: JobStatus | null;
  clips: Clip[];
};

export type DebugCandidate = {
  id: string;
  start_time: string;
  end_time: string;
  start_seconds: number;
  end_seconds: number;
  original_start_time?: string;
  original_end_time?: string;
  original_start_seconds?: number | null;
  original_end_seconds?: number | null;
  refined_start_seconds?: number | null;
  refined_end_seconds?: number | null;
  boundary_reason?: string;
  duration_seconds: number;
  local_score: number;
  hook_terms: string[];
  transcript_preview: string;
};

export type JobDebug = {
  job_id: string;
  status: JobStatus;
  progress: number;
  transcript_preview: string;
  transcript_segment_count: number;
  candidate_count: number;
  candidates: DebugCandidate[];
  evaluations: unknown[];
  warnings: string[];
  artifacts: Record<string, string>;
};

export type YouTubeChannel = {
  id: string;
  channel_id: string;
  title: string;
  description?: string | null;
  thumbnail_url?: string | null;
  style_note?: string | null;
  google_account_email?: string | null;
  is_default: boolean;
  connected_at?: string | null;
};

export type ThumbnailTextOption = {
  id: string;
  text: string;
  style?: string;
  reason?: string;
};

export type YouTubeChannelCandidate = {
  channel_id: string;
  title: string;
  thumbnail_url?: string | null;
  description?: string | null;
  already_connected: boolean;
};

export type YouTubeChannelDraft = {
  id: string;
  google_account_email?: string | null;
  google_account_name?: string | null;
  google_account_picture_url?: string | null;
  expires_at: string;
  channels: YouTubeChannelCandidate[];
};

export type YouTubeStatus = {
  configured: boolean;
  oauth_ready: boolean;
  env_fallback_ready: boolean;
  authenticated: boolean;
  default_privacy_status: string;
  channels: YouTubeChannel[];
};

export type AuthUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  picture_url?: string | null;
};

export type YouTubePublishStatus =
  | "pending"
  | "uploading"
  | "published"
  | "scheduled"
  | "failed";

export type YouTubePublish = {
  id: string;
  clip_id: string;
  status: YouTubePublishStatus;
  title: string;
  privacy_status: string;
  schedule_date?: string | null;
  youtube_video_id?: string | null;
  youtube_url?: string | null;
  error?: string | null;
  channel_title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type YouTubePublishRequest = {
  channel_db_id?: string | null;
  privacy_status?: string;
  schedule_date?: string | null;
  title?: string;
  description?: string;
  tags?: string[];
};

export type AnalyticsSort = "views" | "likes" | "comments" | "recent";

export type ChannelAnalyticsVideo = {
  video_id: string;
  title: string;
  url: string;
  thumbnail?: string | null;
  published_at?: string | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  duration?: string | null;
  rank: number;
};

export type ChannelAnalyticsTotals = {
  video_count: number;
  subscriber_count: number;
  hidden_subscriber_count: boolean;
  channel_view_count: number;
  sampled_videos: number;
  sampled_views: number;
  sampled_likes: number;
  sampled_comments: number;
};

export type ChannelAnalytics = {
  channel_db_id: string;
  channel_title: string;
  channel_thumbnail?: string | null;
  sort: AnalyticsSort;
  totals: ChannelAnalyticsTotals;
  videos: ChannelAnalyticsVideo[];
};

export type StudioProjectClip = {
  clip_id: string;
  rank: number;
  title: string;
  score: number;
  thumbnail_url: string;
  video_url: string;
  status: string;
  publish_id?: string | null;
  youtube_url?: string | null;
  schedule_date?: string | null;
  updated_at?: string | null;
};

export type StudioProject = {
  job_id: string;
  title: string;
  status: JobStatus;
  original_filename: string;
  duration?: number | null;
  progress: number;
  clip_count: number;
  top_score?: number | null;
  source: string;
  source_url?: string | null;
  original_video_url?: string | null;
  subtitle_mode: string;
  style_preset: string;
  created_at: string;
  updated_at: string;
  clips: StudioProjectClip[];
};

export type StudioScheduleItem = {
  publish_id: string;
  clip_id: string;
  job_id: string;
  title: string;
  status: string;
  privacy_status: string;
  schedule_date?: string | null;
  youtube_url?: string | null;
  channel_title?: string | null;
  thumbnail_url?: string | null;
  score?: number | null;
  created_at: string;
  updated_at: string;
};

export type StudioSummary = {
  project_count: number;
  clip_count: number;
  scheduled_count: number;
  published_count: number;
  projects: StudioProject[];
  schedule: StudioScheduleItem[];
};

const API_PROXY_ENABLED = process.env.NEXT_PUBLIC_API_PROXY === "true";
const CONFIGURED_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8010";

export const API_BASE_URL = API_PROXY_ENABLED ? "" : CONFIGURED_API_BASE_URL.replace(/\/$/, "");

function normalizeLocalReturnUrl(returnUrl: string): string {
  if (!API_BASE_URL) return returnUrl;
  try {
    const target = new URL(returnUrl);
    const api = new URL(API_BASE_URL);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (localHosts.has(target.hostname) && localHosts.has(api.hostname)) {
      target.hostname = api.hostname;
    }
    return target.toString();
  } catch {
    return returnUrl;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...init });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail ?? message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function uploadVideo(
  file: File,
  subtitleMode: SubtitleMode = "auto",
  stylePreset: ShortsStylePreset = "korean_pop"
): Promise<{ job_id: string }> {
  const body = new FormData();
  body.append("file", file);
  body.append("subtitle_mode", subtitleMode);
  body.append("style_preset", stylePreset);
  return request<{ job_id: string }>("/api/upload", {
    method: "POST",
    body
  });
}

export async function inspectVideo(file: File): Promise<VideoInspection> {
  const body = new FormData();
  body.append("file", file);
  return request<VideoInspection>("/api/videos/inspect", {
    method: "POST",
    body
  });
}

export async function importFromYouTube(
  url: string,
  subtitleMode: SubtitleMode = "auto",
  stylePreset: ShortsStylePreset = "korean_pop"
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>("/api/jobs/from-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, subtitle_mode: subtitleMode, style_preset: stylePreset })
  });
}

export async function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${jobId}`);
}

export async function getResults(jobId: string): Promise<Results> {
  return request<Results>(`/api/jobs/${jobId}/results`);
}

export async function getLatestCompletedResults(): Promise<Results> {
  return request<Results>("/api/jobs/latest-completed");
}

export async function getStudioSummary(): Promise<StudioSummary> {
  return request<StudioSummary>("/api/studio/summary");
}

export async function getJobDebug(jobId: string): Promise<JobDebug> {
  return request<JobDebug>(`/api/jobs/${jobId}/debug`);
}

export async function getRenderTemplates(): Promise<RenderTemplate[]> {
  return request<RenderTemplate[]>("/api/render-templates");
}

export async function regenerateTitles(clipId: string): Promise<{ clip_id: string; options: TitleOption[] }> {
  return request<{ clip_id: string; options: TitleOption[] }>(`/api/clips/${clipId}/titles/regenerate`, {
    method: "POST"
  });
}

export async function regenerateThumbnailTexts(
  clipId: string
): Promise<{ clip_id: string; options: ThumbnailTextOption[] }> {
  return request<{ clip_id: string; options: ThumbnailTextOption[] }>(`/api/clips/${clipId}/thumbnails/regenerate`, {
    method: "POST"
  });
}

export async function retrimClip(
  clipId: string,
  payload: { start_seconds: number; end_seconds: number }
): Promise<Clip> {
  return request<Clip>(`/api/clips/${clipId}/retrim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function analyzePpl(clipId: string): Promise<PplAnalysis | null> {
  const res = await request<{ clip_id: string; analysis: PplAnalysis | null }>(`/api/clips/${clipId}/ppl`, {
    method: "POST"
  });
  return res.analysis;
}

export async function savePplLinks(
  clipId: string,
  links: Record<string, string>
): Promise<PplAnalysis | null> {
  const res = await request<{ clip_id: string; analysis: PplAnalysis | null }>(`/api/clips/${clipId}/ppl/links`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ links })
  });
  return res.analysis;
}

export async function uploadOverlayAsset(jobId: string, file: File): Promise<AssetUploadResponse> {
  const body = new FormData();
  body.append("file", file);
  return request<AssetUploadResponse>(`/api/jobs/${jobId}/assets`, {
    method: "POST",
    body
  });
}

export async function applyCreative(clipId: string, payload: CreativeApplyRequest): Promise<Clip> {
  return request<Clip>(`/api/clips/${clipId}/creative/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export async function renderHighlight(
  jobId: string,
  payload: HighlightRenderRequest
): Promise<HighlightRenderResponse> {
  return request<HighlightRenderResponse>(`/api/jobs/${jobId}/highlights/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function mediaUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE_URL}${path}`;
}

// Forces a file download (Content-Disposition: attachment) instead of inline
// playback — the plain /media URL plays inline and <a download> is ignored cross-origin.
export function clipDownloadUrl(clipId: string): string {
  return `${API_BASE_URL}/api/clips/${clipId}/download`;
}

export async function getYouTubeStatus(): Promise<YouTubeStatus> {
  return request<YouTubeStatus>("/api/youtube/status");
}

export async function getMe(): Promise<AuthUser | null> {
  const result = await request<{ user: AuthUser | null }>("/api/auth/me");
  return result.user;
}

export function authLoginUrl(returnUrl?: string): string {
  const target = normalizeLocalReturnUrl(returnUrl ?? (typeof window !== "undefined" ? window.location.href : ""));
  const query = target ? `?return_url=${encodeURIComponent(target)}` : "";
  return `${API_BASE_URL}/api/auth/google/start${query}`;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
}

export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, { method: "DELETE", credentials: "include" });
  if (!res.ok && res.status !== 204) throw new Error(`삭제 실패: ${res.status}`);
}

export function youtubeConnectUrl(returnUrl?: string): string {
  const target = normalizeLocalReturnUrl(returnUrl ?? (typeof window !== "undefined" ? window.location.href : ""));
  const query = target ? `?return_url=${encodeURIComponent(target)}` : "";
  return `${API_BASE_URL}/api/youtube/oauth/start${query}`;
}

export async function setDefaultChannel(channelDbId: string): Promise<YouTubeChannel> {
  return request<YouTubeChannel>(`/api/youtube/channels/${channelDbId}/default`, { method: "POST" });
}

export async function updateChannelStyleNote(
  channelDbId: string,
  styleNote: string
): Promise<YouTubeChannel> {
  return request<YouTubeChannel>(`/api/youtube/channels/${channelDbId}/style-note`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ style_note: styleNote })
  });
}

export async function disconnectChannel(channelDbId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/youtube/channels/${channelDbId}`, {
    method: "DELETE",
    credentials: "include"
  });
}

export async function getYouTubeChannelDraft(draftId: string): Promise<YouTubeChannelDraft> {
  return request<YouTubeChannelDraft>(`/api/youtube/channel-drafts/${draftId}`);
}

export async function confirmYouTubeChannelDraft(
  draftId: string,
  channelId: string
): Promise<YouTubeChannel> {
  return request<YouTubeChannel>(`/api/youtube/channel-drafts/${draftId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId })
  });
}

export async function confirmManyYouTubeChannelDraft(
  draftId: string,
  channelIds: string[]
): Promise<YouTubeChannel[]> {
  return request<YouTubeChannel[]>(`/api/youtube/channel-drafts/${draftId}/confirm-many`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_ids: channelIds })
  });
}

export async function cancelYouTubeChannelDraft(draftId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/youtube/channel-drafts/${draftId}`, {
    method: "DELETE",
    credentials: "include"
  });
}

export async function publishToYouTube(
  clipId: string,
  payload: YouTubePublishRequest
): Promise<YouTubePublish> {
  return request<YouTubePublish>(`/api/youtube/clips/${clipId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getPublishStatus(publishId: string): Promise<YouTubePublish> {
  return request<YouTubePublish>(`/api/youtube/publishes/${publishId}`);
}

export async function reschedulePublish(
  publishId: string,
  scheduleDate: string | null
): Promise<YouTubePublish> {
  return request<YouTubePublish>(`/api/youtube/publishes/${publishId}/reschedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schedule_date: scheduleDate })
  });
}

export async function cancelPublish(publishId: string): Promise<YouTubePublish> {
  return request<YouTubePublish>(`/api/youtube/publishes/${publishId}/cancel`, { method: "POST" });
}

export type AutoDistributeItem = { clip_id: string; publish_id: string; schedule_date: string };

export async function autoDistribute(payload: {
  clip_ids: string[];
  channel_db_id: string;
  start_date: string;
  times: string[];
  privacy_status?: string;
}): Promise<{ items: AutoDistributeItem[] }> {
  return request<{ items: AutoDistributeItem[] }>("/api/youtube/auto-distribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getChannelAnalytics(
  channelDbId: string,
  options: { limit?: number; sort?: AnalyticsSort } = {}
): Promise<ChannelAnalytics> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.sort) params.set("sort", options.sort);
  const query = params.toString();
  return request<ChannelAnalytics>(`/api/youtube/channels/${channelDbId}/analytics${query ? `?${query}` : ""}`);
}

export type ChannelInsightsVideo = {
  video_id: string;
  title: string;
  url: string;
  views: number;
  likes: number;
  comments: number;
  duration_seconds: number;
  rank: number;
};

export type ChannelInsights = {
  channel_db_id: string;
  sample_size: number;
  has_enough: boolean;
  best_videos: ChannelInsightsVideo[];
  recommendations: string[];
  patterns: Record<string, unknown>;
};

export async function getChannelInsights(channelDbId: string): Promise<ChannelInsights> {
  return request<ChannelInsights>(`/api/youtube/channels/${channelDbId}/insights`);
}

export type VideoComment = {
  author: string;
  text: string;
  likes: number;
  published_at?: string | null;
};

export async function getVideoComments(
  channelDbId: string,
  videoId: string,
  limit = 20
): Promise<VideoComment[]> {
  return request<VideoComment[]>(`/api/youtube/channels/${channelDbId}/videos/${videoId}/comments?limit=${limit}`);
}

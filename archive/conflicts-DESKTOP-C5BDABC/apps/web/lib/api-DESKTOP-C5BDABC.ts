export type JobStatus = "pending" | "processing" | "completed" | "failed";

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
  thumbnail_text?: string | null;
  thumbnail_description?: string | null;
  best_frame_time?: number | null;
  transcript: string;
  youtube_metadata: YouTubeMetadata;
  edit_status?: string | null;
  edit_error?: string | null;
  editor_project?: EditorProject | null;
};

export type EditorSegment = {
  segmentId: string;
  start: number;
  end: number;
};

export type EditorOverlay = {
  overlayId: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  textAlign: "left" | "center" | "right";
};

export type EditorProject = {
  render_title: string;
  aspect_ratio: "9:16-fit" | "9:16-crop";
  segments: EditorSegment[];
  overlays: EditorOverlay[];
};

export type Results = {
  job_id?: string | null;
  status?: JobStatus | null;
  clips: Clip[];
};

export type SourceVideo = {
  job_id: string;
  original_filename: string;
  status: JobStatus;
  progress: number;
  error?: string | null;
  duration?: number | null;
  clip_count: number;
  top_score?: number | null;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
};

export type Videos = {
  videos: SourceVideo[];
};

export type YouTubeConfig = {
  configured: boolean;
  privacy_status: string;
  category_id: string;
  connected_channel_count: number;
  default_channel_id?: string | null;
  legacy_refresh_configured: boolean;
};

export type YouTubeChannel = {
  id: string;
  channel_id: string;
  title: string;
  description?: string | null;
  thumbnail_url?: string | null;
  google_account_id?: string | null;
  google_account_email?: string | null;
  google_account_name?: string | null;
  google_account_picture_url?: string | null;
  upload_ready: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type YouTubeChannels = {
  channels: YouTubeChannel[];
};

export type YouTubePublish = {
  publish_id: string;
  clip_id: string;
  job_id: string;
  status: string;
  title: string;
  description?: string | null;
  tags: string[];
  privacy_status: string;
  category_id: string;
  schedule_date?: string | null;
  youtube_channel_id?: string | null;
  youtube_channel_title?: string | null;
  youtube_video_id?: string | null;
  youtube_url?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

export type YouTubePublishes = {
  publishes: YouTubePublish[];
};

export type YouTubeAutoPublishResult = {
  job_id: string;
  requested_count: number;
  queued_count: number;
  skipped_count: number;
  youtube_channel_id?: string | null;
  youtube_channel_title?: string | null;
  publishes: YouTubePublish[];
};

export type DebugCandidate = {
  id: string;
  start_time: string;
  end_time: string;
  start_seconds: number;
  end_seconds: number;
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

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8010";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (typeof payload.detail === "string") {
        message = payload.detail;
      } else if (Array.isArray(payload.detail)) {
        message = payload.detail
          .map((item: { msg?: string; loc?: unknown[] }) => {
            const location = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
            return location ? `${location}: ${item.msg ?? "Invalid value"}` : item.msg ?? "Invalid value";
          })
          .join("; ");
      }
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function uploadVideo(file: File): Promise<{ job_id: string }> {
  const body = new FormData();
  body.append("file", file);
  return request<{ job_id: string }>("/api/upload", {
    method: "POST",
    body
  });
}

export async function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${jobId}`);
}

export async function getResults(jobId: string): Promise<Results> {
  return request<Results>(`/api/jobs/${jobId}/results`);
}

export async function getVideos(): Promise<Videos> {
  return request<Videos>("/api/videos");
}

export async function getLatestCompletedResults(): Promise<Results> {
  return request<Results>("/api/jobs/latest-completed");
}

export async function getJobDebug(jobId: string): Promise<JobDebug> {
  return request<JobDebug>(`/api/jobs/${jobId}/debug`);
}

export async function updateClip(
  clipId: string,
  payload: {
    title?: string;
    reason?: string;
    thumbnail_text?: string;
    thumbnail_description?: string;
    youtube_metadata?: Partial<YouTubeMetadata>;
    editor_project?: EditorProject;
  }
): Promise<{ clip: Clip }> {
  return request<{ clip: Clip }>(`/api/clips/${clipId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function rerenderClip(clipId: string): Promise<{ clip: Clip }> {
  return request<{ clip: Clip }>(`/api/clips/${clipId}/rerender`, { method: "POST" });
}

export async function getYouTubeConfig(): Promise<YouTubeConfig> {
  return request<YouTubeConfig>("/api/youtube/config");
}

export async function getYouTubeChannels(): Promise<YouTubeChannels> {
  return request<YouTubeChannels>("/api/youtube/channels");
}

export async function startYouTubeOAuth(returnUrl: string): Promise<{ auth_url: string }> {
  return request<{ auth_url: string }>(`/api/youtube/oauth/start?return_url=${encodeURIComponent(returnUrl)}`);
}

export async function setDefaultYouTubeChannel(channelId: string): Promise<YouTubeChannel> {
  return request<YouTubeChannel>(`/api/youtube/channels/${channelId}/default`, { method: "POST" });
}

export async function getYouTubePublishes(jobId?: string): Promise<YouTubePublishes> {
  return request<YouTubePublishes>(`/api/youtube/publishes${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`);
}

export async function publishClipToYouTube(
  clipId: string,
  payload: {
    title?: string;
    description?: string;
    tags?: string[];
    privacy_status?: string;
    category_id?: string;
    schedule_date?: string;
    youtube_channel_id?: string;
  }
): Promise<YouTubePublish> {
  return request<YouTubePublish>(`/api/clips/${clipId}/youtube/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function autoPublishJobToYouTube(
  jobId: string,
  payload: {
    max_clips?: number;
    min_score?: number;
    privacy_status?: string;
    category_id?: string;
    schedule_date?: string;
    youtube_channel_id?: string;
    skip_existing?: boolean;
  }
): Promise<YouTubeAutoPublishResult> {
  return request<YouTubeAutoPublishResult>(`/api/jobs/${jobId}/youtube/auto-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function mediaUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE_URL}${path}`;
}

/**
 * Backend client (real-video mode). Talks to @stepd/server. When the server is
 * unreachable the store falls back to the in-memory mock, so the app still runs
 * standalone — this module is only used once a live server is detected.
 */
import type { DistributionChannel } from "@/lib/constants";
import type { MetaPlatform, Program, RenderChannel } from "@/lib/types";
import type { EditorState } from "@/lib/editor/presets";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "/api";

/** Absolute URL for a server-relative media path (stream/thumb). */
export function mediaUrl(relative: string | null | undefined): string | undefined {
  if (!relative) return undefined;
  return relative.startsWith("http") ? relative : `${API_BASE}${relative}`;
}

export interface ServerState {
  programs: unknown[];
  episodes: unknown[];
  recommendations: unknown[];
  clips: unknown[];
  jobs: unknown[];
  connections: { youtube: boolean; meta: boolean; metaInstagram: boolean };
  media: unknown[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Probe + load full state. Rejects (fast) if the server isn't up. */
export async function fetchState(signal?: AbortSignal): Promise<ServerState> {
  const res = await fetch(`${API_BASE}/state`, { signal, cache: "no-store" });
  return json<ServerState>(res);
}

export interface AnalysisScene {
  index?: number;
  start: number;
  end?: number;
  duration?: number;
  text?: string;
  vision_reason?: string;
  vision_score?: number;
  vision_tags?: string[];
  has_dialogue?: boolean;
  on_screen_names?: string[];
}
/** One AI-recommended short (core.recommend output). */
export interface AnalysisShort {
  rank?: number;
  title?: string;
  start: number;
  end: number;
  reason?: string;
  tags?: string[];
}
/** One refined transcript segment (STT → refine). */
export interface AnalysisTranscriptSegment {
  start: number;
  end?: number;
  text?: string;
}
export interface MediaAnalysis {
  status: "pending" | "done" | "failed" | null;
  data?: {
    transcript?: AnalysisTranscriptSegment[];
    scenes?: AnalysisScene[];
    shorts?: AnalysisShort[];
  } | null;
  error?: string | null;
}

/** Content-pipeline result for one uploaded media (STT → scenes → shorts). */
export async function getMediaAnalysis(mediaId: string): Promise<MediaAnalysis> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/analysis`, { cache: "no-store" });
  if (!res.ok) throw new Error(`analysis fetch failed (${res.status})`);
  return res.json();
}

/** Re-run the AI content pipeline for a media (operator recovery from a failed analysis). */
export async function reanalyzeMedia(mediaId: string): Promise<{ ok: boolean; queued: boolean }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/analyze`, { method: "POST" });
  if (!res.ok) throw new Error(`재분석 요청 실패 (${res.status})`);
  return res.json();
}

/**
 * A playable video URL for a media id. In production this is a short-lived signed GCS URL
 * the <video> element streams directly from Cloud Storage (no proxy/redirect in the byte
 * path). In local dev it falls back to the server's chunked stream endpoint.
 */
export async function getStreamUrl(mediaId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/stream-url`, { cache: "no-store" });
  const data = await json<{ url: string; direct: boolean }>(res);
  return data.direct ? data.url : `${API_BASE}${data.url}`;
}

export interface CreateProgramInput {
  title: string;
  section?: string;
  targetAge?: number;
  cast?: string[];
  /** SMR feed metadata (program-level). */
  programCode?: string;
  category?: string;
  weekdays?: number[];
}

/** Create a program (content root). Required before any episode/upload can exist. */
export async function createProgram(input: CreateProgramInput): Promise<{ program: Program }> {
  return json(
    await fetch(`${API_BASE}/programs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Persist the editor's decision blob on a clip (metadata only — no render, plan §2.4). */
export async function saveClipEditor(clipId: string, editorState: EditorState): Promise<void> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/editor`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editorState }),
  });
  await json<{ ok: boolean }>(res);
}

type UploadResult = { episode: { id: string }; media: unknown; recommendations: unknown[] };

// GCS resumable chunk size. MUST be a multiple of 256 KiB (GCS requirement); 16 MiB = 64×256 KiB.
const RESUMABLE_CHUNK = 16 * 1024 * 1024;
const CHUNK_RETRIES = 4;

/**
 * Upload a (possibly multi-hour, multi-GB) master video.
 *
 * The server first hands us a direct-to-GCS resumable session — the bytes stream
 * straight to Cloud Storage in chunks, bypassing Cloud Run entirely (no 32 MB request
 * cap, no server-side buffering, no request timeout, and a dropped chunk retries instead
 * of restarting the whole upload). We then call /finalize to build the episode + recs.
 *
 * On local dev (no GCS) the server replies mode:"multipart" and we fall back to the
 * old single-request upload, which is fine for the small files used there.
 */
export async function uploadVideo(
  file: File,
  programId: string,
  title?: string,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  const init = await json<
    | { mode: "resumable"; mediaId: string; objectPath: string; sessionUrl: string }
    | { mode: "multipart"; mediaId: string; objectPath: string }
  >(
    await fetch(`${API_BASE}/media/upload-init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "video/mp4",
        programId,
        title,
      }),
    }),
  );

  if (init.mode === "multipart") return uploadVideoMultipart(file, programId, title, onProgress);

  await uploadResumable(init.sessionUrl, file, onProgress);

  return json<UploadResult>(
    await fetch(`${API_BASE}/media/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: init.mediaId,
        objectPath: init.objectPath,
        programId,
        title,
        filename: file.name,
        contentType: file.type || "video/mp4",
        size: file.size,
      }),
    }),
  );
}

/** PUT the file to a GCS resumable session URI in chunks, resuming on transient failures. */
async function uploadResumable(
  sessionUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const total = file.size;
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + RESUMABLE_CHUNK, total);
    const chunk = file.slice(offset, end);

    let res: ChunkResponse | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      try {
        res = await putChunk(sessionUrl, chunk, offset, end - 1, total, (loaded) => {
          if (onProgress) onProgress(Math.min(99, Math.round(((offset + loaded) / total) * 100)));
        });
        break;
      } catch (err) {
        // Network drop mid-chunk — re-sync the committed offset from GCS, then retry.
        lastErr = err;
        const committed = await queryCommittedOffset(sessionUrl, total).catch(() => null);
        if (committed !== null && committed > offset) {
          offset = committed;
          if (offset >= total) return;
        }
      }
    }
    if (!res) throw new Error(`upload chunk failed after retries: ${lastErr ?? "unknown error"}`);

    if (res.status === 200 || res.status === 201) {
      offset = total;
    } else if (res.status === 308) {
      // Chunk accepted, more to come. Trust the Range header if CORS exposes it; else advance.
      const next = parseRangeEnd(res.range);
      offset = next !== null ? next + 1 : end;
    } else {
      throw new Error(`upload chunk rejected: ${res.status} ${res.body}`);
    }
  }
  if (onProgress) onProgress(100);
}

type ChunkResponse = { status: number; range: string | null; body: string };

function putChunk(
  sessionUrl: string,
  chunk: Blob,
  start: number,
  endInclusive: number,
  total: number,
  onProgress?: (loaded: number) => void,
): Promise<ChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${endInclusive}/${total}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () =>
      resolve({ status: xhr.status, range: xhr.getResponseHeader("Range"), body: xhr.responseText });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(chunk);
  });
}

/** Ask GCS how many bytes it has committed (PUT with an empty body + `bytes *​/total`). */
function queryCommittedOffset(sessionUrl: string, total: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const next = parseRangeEnd(xhr.getResponseHeader("Range"));
        resolve(next !== null ? next + 1 : 0);
      } else if (xhr.status === 200 || xhr.status === 201) {
        resolve(total); // already complete
      } else {
        resolve(null);
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send();
  });
}

/** "bytes=0-16777215" → 16777215. Returns null when the header is absent (CORS not exposing it). */
function parseRangeEnd(range: string | null): number | null {
  if (!range) return null;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? parseInt(m[1], 10) : null;
}

/** Legacy single-request multipart upload — used only in local dev (no GCS). */
function uploadVideoMultipart(
  file: File,
  programId: string,
  title: string | undefined,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("programId", programId);
    if (title) form.append("title", title);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/media/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

export async function adoptRec(recId: string): Promise<{ clipId: string; clip: unknown }> {
  return json(await fetch(`${API_BASE}/recommendations/${recId}/adopt`, { method: "POST" }));
}

/**
 * Confirm/export a clip — the single expensive render (plan §2.4). The server bakes the
 * deliverable once and caches by revision hash, so re-exporting identical decisions is a
 * no-op. Returns the updated (rendered, status:"ready") clip.
 *
 * `channel` picks the destination render preset (F3): the frame (SMR renders 16:9, Shorts/
 * Reels 9:16) and the hard length cap. Omit it to render the clip's own aspect over the full
 * segment. `capped` comes back set when the preset's maxSec shortened the deliverable — show
 * it; the operator's segment was longer than what shipped.
 */
export async function exportClip(
  clipId: string,
  channel?: RenderChannel,
): Promise<{
  clipId: string;
  clip: unknown;
  cached?: boolean;
  preset?: string | null;
  capped?: { maxSec: number; requestedSec: number } | null;
}> {
  return json(
    await fetch(`${API_BASE}/clips/${clipId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel ?? "" }),
    }),
  );
}

export async function rejectRec(recId: string, reason: string): Promise<void> {
  await fetch(`${API_BASE}/recommendations/${recId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function publishClips(
  clipIds: string[],
  channel: DistributionChannel,
  opts: { reserveDate?: string; scheduled?: boolean; platforms?: MetaPlatform[] },
): Promise<void> {
  const res = await fetch(`${API_BASE}/distributions/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds, channel, ...opts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

export async function retryDist(clipId: string, channel: DistributionChannel): Promise<void> {
  await fetch(`${API_BASE}/distributions/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipId, channel }),
  });
}

// ── YouTube channels ───────────────────────────────────────────────────────────

export interface YouTubeChannelInfo {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  thumbnail: string | null;
  subscribers: string | null;
  status: string;
  connectedAt: number;
  email: string | null;
  /** BIGINT epoch (as string) or null — set once the analyze job's steps land. */
  lastSyncedAt?: number | string | null;
  lastAnalyzedAt?: number | string | null;
  /** True if the consent granted the revenue (monetary) scope. */
  hasMonetaryScope?: boolean;
  /** Last pipeline error for this channel, if any. */
  lastError?: string | null;
}

export async function fetchYouTubeChannels(): Promise<YouTubeChannelInfo[]> {
  const res = await fetch(`${API_BASE}/youtube/channels`);
  const data = await res.json() as { channels: YouTubeChannelInfo[] };
  return data.channels;
}

/**
 * `analytics` (default) asks an external creator for read-only access so we can
 * pull their channel metrics. `publish` asks for upload rights and is only for
 * our own channels — never send it to a partner.
 */
export type ConsentMode = "analytics" | "publish";

export function getYouTubeAuthUrl(
  channelUrl?: string,
  mode: ConsentMode = "analytics",
  returnTo?: string,
): string {
  const params = new URLSearchParams({ mode });
  if (channelUrl) params.set("channel", channelUrl);
  if (returnTo) params.set("return", returnTo);
  return `${API_BASE}/youtube/auth?${params}`;
}

export interface ChannelAnalytics {
  channelId: string;
  channelName: string;
  columns: string[];
  rows: Record<string, string | number>[];
}

export async function fetchChannelAnalytics(
  channelId: string,
  opts: { start?: string; end?: string; dimensions?: string; metrics?: string } = {},
): Promise<ChannelAnalytics> {
  const params = new URLSearchParams(
    Object.entries(opts).filter(([, v]) => v) as [string, string][],
  );
  const res = await fetch(`${API_BASE}/youtube/analytics/${channelId}?${params}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Analytics failed (${res.status})`);
  return res.json();
}

export async function deleteYouTubeChannel(channelId: string): Promise<void> {
  await fetch(`${API_BASE}/youtube/channels/${channelId}`, { method: "DELETE" });
}

/**
 * Ask the worker to (re)analyze a channel now. Returns immediately — the run happens
 * in the background. `queued: false` means a run for this channel is already in flight.
 */
export async function triggerChannelAnalysis(
  channelId: string,
): Promise<{ ok: boolean; queued: boolean; note: string }> {
  const res = await fetch(`${API_BASE}/youtube/pipeline/run/${channelId}`, { method: "POST" });
  if (!res.ok) throw new Error(`analysis trigger failed (${res.status})`);
  return res.json();
}

export interface ChannelDailyRow {
  channelId: string;
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  subscribersGained: number;
  subscribersLost: number;
  fetchedAt: number;
}

/** Stored daily analytics the worker has collected (served from our DB, not YouTube). */
export async function fetchChannelDaily(
  channelId: string,
  days = 90,
): Promise<ChannelDailyRow[]> {
  const res = await fetch(`${API_BASE}/youtube/analytics/${channelId}/daily?days=${days}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { rows: Record<string, unknown>[] };
  // Postgres BIGINT comes back as a string over JSON (node-postgres avoids precision
  // loss), so coerce the numeric fields — otherwise `+=` in the UI concatenates.
  return (data.rows ?? []).map((r) => ({
    channelId: String(r.channelId),
    day: String(r.day),
    views: Number(r.views),
    estimatedMinutesWatched: Number(r.estimatedMinutesWatched),
    averageViewDuration: Number(r.averageViewDuration),
    averageViewPercentage: Number(r.averageViewPercentage),
    subscribersGained: Number(r.subscribersGained),
    subscribersLost: Number(r.subscribersLost),
    fetchedAt: Number(r.fetchedAt),
  }));
}

// ── Channel video sync & trends ────────────────────────────────────────────────

import type {
  YouTubeChannelVideo,
  ChannelTrendSummary,
  DailyTrend,
  VideoTrend,
  SyncResponse,
} from "@/lib/types";

export async function syncChannelVideos(channelId: string): Promise<SyncResponse> {
  const res = await fetch(`${API_BASE}/youtube/sync/${channelId}`, { method: "POST" });
  return json<SyncResponse>(res);
}

export async function fetchChannelVideos(channelId: string): Promise<{
  channelId: string;
  channelName: string;
  videoCount: number;
  videos: YouTubeChannelVideo[];
}> {
  const res = await fetch(`${API_BASE}/youtube/videos/${channelId}`);
  return json(res);
}

export async function fetchChannelTrends(channelId: string, days = 30): Promise<{
  channelId: string;
  channelName: string;
  days: number;
  trend: DailyTrend[];
  summary: ChannelTrendSummary;
}> {
  const res = await fetch(`${API_BASE}/youtube/trends/${channelId}?days=${days}`);
  return json(res);
}

export async function fetchVideoTrend(videoId: string, days = 30): Promise<VideoTrend> {
  const res = await fetch(`${API_BASE}/youtube/trends/video/${videoId}?days=${days}`);
  return json<VideoTrend>(res);
}

export interface VideoAnalyticsSummary {
  views?: number;
  likes?: number;
  shares?: number;
  subscribersGained?: number;
  averageViewDuration?: number; // seconds
  averageViewPercentage?: number; // 0–100
  estimatedMinutesWatched?: number;
  // Revenue (monetized channels only; absent otherwise). USD.
  estimatedRevenue?: number;
  estimatedAdRevenue?: number;
  grossRevenue?: number;
  cpm?: number;
  playbackBasedCpm?: number;
  adImpressions?: number;
  monetizedPlaybacks?: number;
}
export interface VideoTrafficSource {
  source: string;
  views: number;
  estimatedMinutesWatched?: number;
}
export interface VideoDemographic {
  ageGroup?: string;
  gender?: string;
  percentage?: number;
}
export interface VideoComment {
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string;
}
export interface VideoAnalytics {
  video: YouTubeChannelVideo;
  summary: VideoAnalyticsSummary;
  trafficSources: VideoTrafficSource[];
  demographics: VideoDemographic[];
  retention: { ratio: number; watchRatio: number }[];
  comments: VideoComment[];
  fetchedAt: number | null;
}

/** Rich per-video analytics (avg view duration/%, traffic sources, demographics,
 *  retention curve, top comments) collected by the video.analyze / video.comments jobs. */
export async function fetchVideoAnalytics(videoId: string): Promise<VideoAnalytics> {
  const res = await fetch(`${API_BASE}/youtube/videos/${videoId}/analytics`);
  return json<VideoAnalytics>(res);
}

export async function deleteTrackedVideo(videoId: string): Promise<void> {
  await fetch(`${API_BASE}/youtube/videos/${videoId}`, { method: "DELETE" });
}

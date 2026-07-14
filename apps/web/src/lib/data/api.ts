/**
 * Backend client (real-video mode). Talks to @stepd/server. When the server is
 * unreachable the store falls back to the in-memory mock, so the app still runs
 * standalone — this module is only used once a live server is detected.
 */
import type { DistributionChannel } from "@/lib/constants";
import type { MetaPlatform } from "@/lib/types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:4000";

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
  const res = await fetch(`${API_BASE}/api/state`, { signal, cache: "no-store" });
  return json<ServerState>(res);
}

export async function uploadVideo(
  file: File,
  programId: string,
  title?: string,
  onProgress?: (pct: number) => void,
): Promise<{ episode: { id: string }; media: unknown; recommendations: unknown[] }> {
  // XHR for upload progress (fetch has no upload progress in browsers).
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("programId", programId);
    if (title) form.append("title", title);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/media/upload`);
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
  return json(await fetch(`${API_BASE}/api/recommendations/${recId}/adopt`, { method: "POST" }));
}

export async function rejectRec(recId: string, reason: string): Promise<void> {
  await fetch(`${API_BASE}/api/recommendations/${recId}/reject`, {
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
  await fetch(`${API_BASE}/api/distributions/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds, channel, ...opts }),
  });
}

export async function retryDist(clipId: string, channel: DistributionChannel): Promise<void> {
  await fetch(`${API_BASE}/api/distributions/retry`, {
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
}

export async function fetchYouTubeChannels(): Promise<YouTubeChannelInfo[]> {
  const res = await fetch(`${API_BASE}/api/youtube/channels`);
  const data = await res.json() as { channels: YouTubeChannelInfo[] };
  return data.channels;
}

export function getYouTubeAuthUrl(channelUrl?: string): string {
  const base = `${API_BASE}/api/youtube/auth`;
  if (channelUrl) return `${base}?channel=${encodeURIComponent(channelUrl)}`;
  return base;
}

export async function deleteYouTubeChannel(channelId: string): Promise<void> {
  await fetch(`${API_BASE}/api/youtube/channels/${channelId}`, { method: "DELETE" });
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
  const res = await fetch(`${API_BASE}/api/youtube/sync/${channelId}`, { method: "POST" });
  return json<SyncResponse>(res);
}

export async function fetchChannelVideos(channelId: string): Promise<{
  channelId: string;
  channelName: string;
  videoCount: number;
  videos: YouTubeChannelVideo[];
}> {
  const res = await fetch(`${API_BASE}/api/youtube/videos/${channelId}`);
  return json(res);
}

export async function fetchChannelTrends(channelId: string, days = 30): Promise<{
  channelId: string;
  channelName: string;
  days: number;
  trend: DailyTrend[];
  summary: ChannelTrendSummary;
}> {
  const res = await fetch(`${API_BASE}/api/youtube/trends/${channelId}?days=${days}`);
  return json(res);
}

export async function fetchVideoTrend(videoId: string, days = 30): Promise<VideoTrend> {
  const res = await fetch(`${API_BASE}/api/youtube/trends/video/${videoId}?days=${days}`);
  return json<VideoTrend>(res);
}

export async function deleteTrackedVideo(videoId: string): Promise<void> {
  await fetch(`${API_BASE}/api/youtube/videos/${videoId}`, { method: "DELETE" });
}

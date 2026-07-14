/**
 * YouTube Data API v3 helpers — upload list and video statistics.
 */
export interface YtVideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  thumbnail: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

/** One row of a YouTube Analytics report, keyed by column name. */
export type AnalyticsRow = Record<string, string | number>;

export interface AnalyticsReport {
  columns: string[];
  rows: AnalyticsRow[];
}

export const DEFAULT_ANALYTICS_METRICS =
  "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost";

/**
 * YouTube Analytics API — the numbers the Data API cannot give us (watch time,
 * retention, traffic sources, demographics).
 *
 * `ids=channel==MINE` means "the channel owning this access token". Reading a
 * third party's channel by id requires content-owner (MCN) access, so the whole
 * design hinges on holding each creator's own refresh token.
 */
export async function fetchChannelAnalytics(
  accessToken: string,
  opts: { startDate: string; endDate: string; metrics?: string; dimensions?: string; sort?: string; maxResults?: number },
): Promise<AnalyticsReport> {
  const params = new URLSearchParams({
    ids: "channel==MINE",
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: opts.metrics || DEFAULT_ANALYTICS_METRICS,
  });
  if (opts.dimensions) params.set("dimensions", opts.dimensions);
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.maxResults) params.set("maxResults", String(opts.maxResults));

  const res = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new YouTubeApiError(res.status, `YouTube Analytics failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    columnHeaders?: { name: string }[];
    rows?: (string | number)[][];
  };
  const columns = (data.columnHeaders ?? []).map((h) => h.name);
  const rows = (data.rows ?? []).map((row) => {
    const obj: AnalyticsRow = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
  return { columns, rows };
}

// ── Token management ──────────────────────────────────────────────────────────
//
// We hold each creator's refresh token; access tokens live ~1h. Every YouTube call
// therefore goes through `withAccessToken`, which reuses the stored access token
// until it is close to expiry, refreshes when it isn't, and retries once if Google
// rejects a token we believed was still good.

/** Carries the HTTP status so callers can tell "expired" (401) from "no scope" (403). */
export class YouTubeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
  }
}

/** The creator revoked us, or the refresh token aged out. Re-consent is the only fix. */
export class TokenRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRevokedError";
  }
}

/** Refresh this early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface ChannelTokens {
  channelId: string;
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
}

/** Called with a freshly minted token so it outlives the process. */
export type PersistTokens = (t: { accessToken: string; expiresAt: number }) => void | Promise<void>;

/** Refreshes in flight, keyed by channel — parallel callers share one round trip. */
const refreshing = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>();

async function requestRefresh(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // invalid_grant is terminal: the token is dead and retrying cannot revive it.
    if (body.includes("invalid_grant")) {
      throw new TokenRevokedError(`Refresh token rejected: ${body}`);
    }
    throw new YouTubeApiError(res.status, `Token refresh failed (${res.status}): ${body}`);
  }
  const data = JSON.parse(body) as { access_token: string; expires_in?: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Force a refresh regardless of the stored expiry, persist it, and return the token.
 * Concurrent callers for the same channel share a single round trip to Google.
 */
export async function refreshChannelToken(
  clientId: string,
  clientSecret: string,
  ch: ChannelTokens,
  persist: PersistTokens,
): Promise<string> {
  return refreshAndPersist(clientId, clientSecret, ch, persist);
}

async function refreshAndPersist(
  clientId: string,
  clientSecret: string,
  ch: ChannelTokens,
  persist: PersistTokens,
): Promise<string> {
  let pending = refreshing.get(ch.channelId);
  if (!pending) {
    pending = requestRefresh(clientId, clientSecret, ch.refreshToken);
    refreshing.set(ch.channelId, pending);
    pending.finally(() => refreshing.delete(ch.channelId)).catch(() => {});
  }

  const fresh = await pending;
  // Persist BOTH fields. Saving the token without its new expiry would leave the
  // stored expiry in the past, so every later call would refresh again.
  await persist(fresh);
  ch.accessToken = fresh.accessToken;
  ch.expiresAt = fresh.expiresAt;
  return fresh.accessToken;
}

function isExpired(ch: ChannelTokens): boolean {
  if (!ch.accessToken) return true;
  if (ch.expiresAt == null) return true;
  return Date.now() > ch.expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Run `call` with a valid access token for this channel.
 *
 * Refreshes up front when the stored token is missing or near expiry, and retries
 * once if Google still answers 401 — a token can die early (revoked scope, clock
 * skew, password change) and the stored expiry would not know it. A 403 is NOT
 * retried: that means missing scope or exhausted quota, and a new token won't help.
 */
export async function withAccessToken<T>(
  clientId: string,
  clientSecret: string,
  ch: ChannelTokens,
  persist: PersistTokens,
  call: (accessToken: string) => Promise<T>,
): Promise<T> {
  let token = isExpired(ch)
    ? await refreshAndPersist(clientId, clientSecret, ch, persist)
    : ch.accessToken!;

  try {
    return await call(token);
  } catch (err) {
    if (!(err instanceof YouTubeApiError) || err.status !== 401) throw err;
    token = await refreshAndPersist(clientId, clientSecret, ch, persist);
    return call(token);
  }
}

/** Fetch the uploads playlist ID for a channel. */
async function getUploadsPlaylistId(accessToken: string, channelId: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new YouTubeApiError(res.status, `Failed to get channel details (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
  };
  if (!data.items?.length) throw new Error("No channel content details found");
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

/** Fetch all uploads from the uploads playlist (paginated, up to 500). */
async function fetchPlaylistItems(
  accessToken: string,
  playlistId: string,
  maxResults = 50,
): Promise<{ videoId: string; snippet: any }[]> {
  const items: { videoId: string; snippet: any }[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    // max 500 items (50 × 10 pages)
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: String(maxResults),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new YouTubeApiError(res.status, `Playlist items failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      items?: { snippet: { resourceId: { videoId: string }; title: string; description: string; publishedAt: string; thumbnails?: { high?: { url: string }; default?: { url: string } } } }[];
      nextPageToken?: string;
    };
    if (!data.items?.length) break;
    for (const item of data.items) {
      items.push({
        videoId: item.snippet.resourceId.videoId,
        snippet: item.snippet,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/** Fetch video statistics + duration for a batch of video IDs (max 50 per call). */
async function fetchVideosBatch(
  accessToken: string,
  videoIds: string[],
): Promise<Map<string, { viewCount: number; likeCount: number; commentCount: number; durationSec: number }>> {
  const map = new Map<
    string,
    { viewCount: number; likeCount: number; commentCount: number; durationSec: number }
  >();
  // YouTube API accepts up to 50 ids per call
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "statistics,contentDetails",
      id: batch.join(","),
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new YouTubeApiError(res.status, `Video stats failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      items?: {
        id: string;
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        contentDetails?: { duration?: string };
      }[];
    };
    if (!data.items) continue;
    for (const item of data.items) {
      map.set(item.id, {
        viewCount: Number(item.statistics?.viewCount ?? 0),
        likeCount: Number(item.statistics?.likeCount ?? 0),
        commentCount: Number(item.statistics?.commentCount ?? 0),
        durationSec: parseIsoDuration(item.contentDetails?.duration ?? "PT0S"),
      });
    }
  }
  return map;
}

/** Parse ISO 8601 duration (PT1H2M3S) → seconds. */
function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0", 10) * 3600 +
    parseInt(m[2] ?? "0", 10) * 60 +
    parseInt(m[3] ?? "0", 10));
}

export interface SyncResult {
  videos: YtVideoItem[];
}

/**
 * Pull a channel's uploads and their statistics.
 *
 * The whole sync runs under one `withAccessToken` so a token that expires partway
 * through (this can page through 500 videos) is refreshed and the call retried,
 * instead of failing halfway.
 */
export async function syncChannelVideos(
  clientId: string,
  clientSecret: string,
  channel: ChannelTokens,
  persist: PersistTokens,
): Promise<SyncResult> {
  const videos = await withAccessToken(clientId, clientSecret, channel, persist, async (accessToken) => {
    const uploadsPlaylistId = await getUploadsPlaylistId(accessToken, channel.channelId);
    const playlistItems = await fetchPlaylistItems(accessToken, uploadsPlaylistId);
    if (playlistItems.length === 0) return [];

    const statsMap = await fetchVideosBatch(accessToken, playlistItems.map((p) => p.videoId));

    return playlistItems.map<YtVideoItem>((p) => {
      const stats = statsMap.get(p.videoId);
      const thumb = p.snippet.thumbnails?.high?.url ?? p.snippet.thumbnails?.default?.url ?? null;
      return {
        videoId: p.videoId,
        title: p.snippet.title,
        description: p.snippet.description,
        publishedAt: p.snippet.publishedAt,
        durationSec: stats?.durationSec ?? 0,
        thumbnail: thumb,
        viewCount: stats?.viewCount ?? 0,
        likeCount: stats?.likeCount ?? 0,
        commentCount: stats?.commentCount ?? 0,
      };
    });
  });

  return { videos };
}

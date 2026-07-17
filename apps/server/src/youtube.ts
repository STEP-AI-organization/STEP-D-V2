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
  opts: { startDate: string; endDate: string; metrics?: string; dimensions?: string; sort?: string; maxResults?: number; filters?: string },
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
  // e.g. `video==VIDEO_ID` — scopes a channel report to a single upload.
  if (opts.filters) params.set("filters", opts.filters);

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
export async function fetchVideosBatch(
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

// ── video upload (resumable) ──────────────────────────────────────────────────────
//
// Uploads one rendered clip to the channel that owns `accessToken`. Uses the resumable
// protocol (session start → PUT bytes → finalize) even though we send the whole file in a
// single PUT: rendered clips (shorts / short highlights) are small enough to hold in memory
// on the worker VM, and one PUT to the session URL is a valid resumable upload. The session
// framing means a mid-upload network drop can be resumed by a future caller if we ever need
// to chunk large deliverables — the metadata round-trip stays identical.

export interface VideoUploadMeta {
  title: string;
  description?: string;
  tags?: string[];
  /** YouTube category id — default 22 (People & Blogs). */
  categoryId?: string;
  privacyStatus: "public" | "unlisted" | "private";
  /** RFC3339. When set, YouTube keeps the video private until this instant, then publishes it.
   *  Requires privacyStatus "private" — the caller is responsible for pairing them. */
  publishAt?: string | null;
  /** COPPA self-declaration — default false. */
  madeForKids?: boolean;
}

/**
 * Resumable-upload a video and return its id. `body` is the full file (rendered clip).
 * Throws YouTubeApiError on HTTP failure so `withAccessToken` can refresh+retry a 401.
 */
export async function uploadVideoResumable(
  accessToken: string,
  file: { body: Buffer; contentType?: string },
  meta: VideoUploadMeta,
): Promise<{ videoId: string }> {
  const snippet: Record<string, unknown> = {
    // YouTube hard-caps: title 100 chars, description 5000. Trim so a long AI title/synopsis
    // doesn't 400 the whole upload.
    title: (meta.title || "무제 클립").slice(0, 100),
    description: (meta.description ?? "").slice(0, 5000),
    categoryId: meta.categoryId ?? "22",
  };
  if (meta.tags?.length) snippet.tags = meta.tags.slice(0, 30);

  const status: Record<string, unknown> = {
    privacyStatus: meta.publishAt ? "private" : meta.privacyStatus,
    selfDeclaredMadeForKids: meta.madeForKids ?? false,
  };
  if (meta.publishAt) status.publishAt = meta.publishAt;

  const contentType = file.contentType || "video/*";

  // 1) Open the resumable session. The metadata rides in the JSON body; the byte length is
  //    declared up front so YouTube can validate the later PUT.
  const startRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentType,
        "X-Upload-Content-Length": String(file.body.byteLength),
      },
      body: JSON.stringify({ snippet, status }),
    },
  );
  if (!startRes.ok) {
    throw new YouTubeApiError(startRes.status, `Upload session start failed (${startRes.status}): ${await startRes.text()}`);
  }
  const uploadUrl = startRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube resumable upload: session URL missing from response");

  // 2) Send the bytes (single chunk) — a 2xx here finalizes the upload and returns the video.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file.body,
  });
  if (!putRes.ok) {
    throw new YouTubeApiError(putRes.status, `Upload PUT failed (${putRes.status}): ${await putRes.text()}`);
  }
  const data = (await putRes.json()) as { id?: string };
  if (!data.id) throw new Error("YouTube upload: response had no video id");
  return { videoId: data.id };
}

// ── Shorts classification ─────────────────────────────────────────────────────────
//
// The Data API exposes no "is this a Short?" field, and duration is unreliable (Shorts
// can now run up to 3 min). The one robust signal is the canonical URL: a Short resolves
// at youtube.com/shorts/<id> with 200, while a regular upload answers 303 (redirect to
// /watch). We probe with a manual-redirect GET and treat status 200 as the only Short —
// verified against real uploads: a Short → 200, a long-form video → 303.

/** True if `videoId` is a YouTube Short. Throws on network error so callers can retry. */
export async function isShortVideo(videoId: string, timeoutMs = 6000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      // A browser-like UA; the bare-fetch default can draw a consent interstitial.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    // Status line is all we need — don't pull the Short's HTML body over the wire.
    res.body?.cancel().catch(() => {});
    return res.status === 200;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify many uploads with bounded concurrency. A probe that errors is omitted from
 * the result (left for the next sync to retry), so the map holds only firm verdicts.
 */
export async function classifyShorts(
  videoIds: string[],
  concurrency = 8,
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < videoIds.length) {
      const id = videoIds[next++];
      try {
        verdicts.set(id, await isShortVideo(id));
      } catch {
        // network/timeout — omit; shortCheckedAt stays null so the next sync retries.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, videoIds.length) }, worker));
  return verdicts;
}

// ── per-video analytics ─────────────────────────────────────────────────────────

export interface VideoAnalyticsResult {
  /** Single-row lifetime summary: views, averageViewDuration, likes, shares, … */
  summary: Record<string, number>;
  /** Retention curve, 0→1 along the video. `relative` is relativeRetentionPerformance. */
  retention: { ratio: number; watchRatio: number; relative: number }[];
  trafficSources: { source: string; views: number; estimatedMinutesWatched: number }[];
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
}

function toNum(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A report YouTube answers with 400 means it will not compute that metric for this
 * particular video — routine on low-traffic uploads (retention/relative performance
 * need a minimum audience). Degrade that one report to empty so it doesn't sink the
 * other three. 401 (token) and 403 (scope/quota) still bubble so the caller can
 * refresh or back off.
 */
async function softReport(fn: () => Promise<AnalyticsReport>): Promise<AnalyticsReport | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof YouTubeApiError && err.status === 400) return null;
    throw err;
  }
}

/**
 * Like softReport but also swallows 403 — revenue metrics 403 on channels that aren't
 * monetized or whose consent lacks the monetary scope, which is the common case. We
 * simply omit revenue for those; the other reports must not fail because of it.
 */
async function softReportMonetary(fn: () => Promise<AnalyticsReport>): Promise<AnalyticsReport | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof YouTubeApiError && (err.status === 400 || err.status === 403)) return null;
    throw err;
  }
}

/**
 * Four Analytics reports for a single upload, all scoped by `filters=video==id`:
 * retention curve, lifetime summary, traffic sources, and viewer demographics.
 * Callers wrap this in `withAccessToken` so a mid-flight 401 refreshes and retries.
 */
export async function fetchVideoAnalytics(
  accessToken: string,
  videoId: string,
  opts: { startDate: string; endDate: string },
): Promise<VideoAnalyticsResult> {
  const base = { startDate: opts.startDate, endDate: opts.endDate, filters: `video==${videoId}` };

  const [summaryR, retentionR, trafficR, demoR, monetaryR] = await Promise.all([
    softReport(() => fetchChannelAnalytics(accessToken, {
      ...base,
      metrics: "views,averageViewDuration,averageViewPercentage,subscribersGained,likes,shares",
    })),
    softReport(() => fetchChannelAnalytics(accessToken, {
      ...base,
      dimensions: "elapsedVideoTimeRatio",
      metrics: "audienceWatchRatio,relativeRetentionPerformance",
    })),
    softReport(() => fetchChannelAnalytics(accessToken, {
      ...base,
      dimensions: "insightTrafficSourceType",
      metrics: "views,estimatedMinutesWatched",
    })),
    softReport(() => fetchChannelAnalytics(accessToken, {
      ...base,
      dimensions: "ageGroup,gender",
      metrics: "viewerPercentage",
    })),
    // Revenue — only resolves on monetized channels with the monetary scope; 403 → null.
    softReportMonetary(() => fetchChannelAnalytics(accessToken, {
      ...base,
      metrics: "estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,playbackBasedCpm,adImpressions,monetizedPlaybacks",
    })),
  ]);

  const summary: Record<string, number> = {};
  const srow = summaryR?.rows[0];
  if (srow) for (const k of Object.keys(srow)) summary[k] = toNum(srow[k]);
  // Merge revenue metrics into the same summary blob (JSONB — no schema change).
  const mrow = monetaryR?.rows[0];
  if (mrow) for (const k of Object.keys(mrow)) summary[k] = toNum(mrow[k]);

  const retention = (retentionR?.rows ?? [])
    .map((r) => ({
      ratio: toNum(r.elapsedVideoTimeRatio),
      watchRatio: toNum(r.audienceWatchRatio),
      relative: toNum(r.relativeRetentionPerformance),
    }))
    .sort((a, b) => a.ratio - b.ratio);

  const trafficSources = (trafficR?.rows ?? []).map((r) => ({
    source: String(r.insightTrafficSourceType ?? ""),
    views: toNum(r.views),
    estimatedMinutesWatched: toNum(r.estimatedMinutesWatched),
  }));

  const demographics = (demoR?.rows ?? []).map((r) => ({
    ageGroup: String(r.ageGroup ?? ""),
    gender: String(r.gender ?? ""),
    viewerPercentage: toNum(r.viewerPercentage),
  }));

  return { summary, retention, trafficSources, demographics };
}

// ── comments ─────────────────────────────────────────────────────────────────────

export interface YtComment {
  id: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string;
}

/**
 * Top comment threads for one video — a single relevance-ranked page. We deliberately
 * do not paginate: 100 comments is enough signal and every extra page is more quota.
 * Returns [] when the uploader disabled comments (403 commentsDisabled) — that is a
 * normal state, not a failure worth retrying.
 */
export async function fetchVideoComments(
  accessToken: string,
  videoId: string,
  maxResults = 100,
): Promise<YtComment[]> {
  const params = new URLSearchParams({
    part: "snippet",
    videoId,
    order: "relevance",
    maxResults: String(maxResults),
    textFormat: "plainText",
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    // Any 403 on comments is non-transient — disabled comments, or a token without the
    // comments scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT). Skip (empty) instead of throwing:
    // throwing makes the job retry 5× and the scheduler re-enqueue it every tick, which
    // floods the queue and starves other work (e.g. content.analyze).
    if (res.status === 403) return [];
    throw new YouTubeApiError(res.status, `Comment threads failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    items?: {
      snippet: {
        topLevelComment: {
          id: string;
          snippet: { authorDisplayName: string; textDisplay: string; likeCount: number; publishedAt: string };
        };
      };
    }[];
  };
  return (data.items ?? []).map((it) => {
    const c = it.snippet.topLevelComment;
    return {
      id: c.id,
      author: c.snippet.authorDisplayName,
      text: c.snippet.textDisplay,
      likeCount: Number(c.snippet.likeCount ?? 0),
      publishedAt: c.snippet.publishedAt,
    };
  });
}

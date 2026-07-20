/**
 * Channel analysis pipeline — the thing that runs when a creator connects.
 *
 * On Cloud Run we cannot trust work started after a response: CPU is throttled once
 * the request ends and the instance can be reclaimed. So connecting a channel only
 * *kicks* this off, and the scheduler (`runDueChannels`) is what guarantees it runs:
 * a channel with lastSyncedAt = NULL is always due, so anything the kick dropped is
 * picked up on the next tick.
 */
import {
  getYouTubeChannelByChannelId,
  listYouTubeChannels,
  upsertYouTubeChannel,
  updateYouTubeTokens,
  upsertChannelVideo,
  getChannelVideoByVideoId,
  getUncheckedShortVideoIds,
  setChannelVideoShort,
  insertVideoStat,
  getLatestVideoStat,
  upsertChannelAnalytics,
  markChannelRun,
  type YouTubeChannel,
  type ChannelVideo,
  type ChannelAnalyticsDay,
} from "./db-pg.ts";
import {
  syncChannelVideos,
  classifyShorts,
  fetchChannelAnalytics,
  withAccessToken,
  TokenRevokedError,
  YouTubeApiError,
  type PersistTokens,
} from "./youtube.ts";
import { enqueue } from "./queue.ts";
import { HOTWATCH_POLL_MS, HOTWATCH_WINDOW_MS, SHORTS_PROBE_MAX_PER_SYNC, SHORTS_PROBE_CONCURRENCY } from "./config.ts";

/** Re-sync uploads this often. Each run costs Data API quota, so don't go below this. */
const VIDEO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Analytics is day-granular; pulling more often than daily buys nothing. */
const ANALYTICS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** YouTube keeps revising recent days, so always re-pull a trailing window. */
const ANALYTICS_TRAILING_DAYS = 10;
/** First run for a new channel: pull enough history to be useful immediately. */
const ANALYTICS_BACKFILL_DAYS = 365;

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

function isoDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function num(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** One run per channel at a time — the scheduler tick and the on-connect kick overlap. */
const running = new Set<string>();

export interface PipelineResult {
  channelId: string;
  videosSynced: number;
  analyticsDays: number;
  skipped?: string;
  error?: string;
}

/**
 * Sync a channel's uploads and pull its analytics.
 *
 * `force` ignores the staleness intervals — used by the on-connect kick and by the
 * manual endpoint. The scheduler leaves it off so it respects quota.
 */
export async function runChannelPipeline(
  clientId: string,
  clientSecret: string,
  channelId: string,
  opts: { force?: boolean } = {},
): Promise<PipelineResult> {
  const base: PipelineResult = { channelId, videosSynced: 0, analyticsDays: 0 };

  if (running.has(channelId)) return { ...base, skipped: "already running" };
  running.add(channelId);

  try {
    const ch = await getYouTubeChannelByChannelId(channelId);
    if (!ch) return { ...base, skipped: "channel not found" };
    if (!ch.refreshToken) return { ...base, skipped: "no refresh token" };
    if (ch.status === "revoked") return { ...base, skipped: "revoked" };

    const now = Date.now();
    const persist = persistTokensFor(ch);
    const force = opts.force ?? false;

    const dueForVideos = force || isDue(ch.lastSyncedAt, VIDEO_SYNC_INTERVAL_MS, now);
    const dueForAnalytics = force || isDue(ch.lastAnalyzedAt, ANALYTICS_INTERVAL_MS, now);
    if (!dueForVideos && !dueForAnalytics) return { ...base, skipped: "not due" };

    const result: PipelineResult = { ...base };

    try {
      if (dueForVideos) {
        result.videosSynced = await syncVideos(clientId, clientSecret, ch, persist);
        await markChannelRun(channelId, { lastSyncedAt: Date.now(), lastError: null });
      }

      if (dueForAnalytics) {
        if (ch.scope && !ch.scope.includes(ANALYTICS_SCOPE)) {
          // Connected before the read-only/analytics scope split. Google would answer
          // 403; say so rather than burning a call every tick.
          result.skipped = "needs re-consent for analytics scope";
          await markChannelRun(channelId, { lastError: result.skipped });
        } else {
          result.analyticsDays = await syncAnalytics(clientId, clientSecret, ch, persist);
          await markChannelRun(channelId, { lastAnalyzedAt: Date.now(), lastError: null });
        }
      }
    } catch (err: any) {
      if (err instanceof TokenRevokedError) {
        // The creator pulled our access. Retrying can never succeed — park the channel
        // so the scheduler stops paying for it every tick.
        await upsertYouTubeChannel({ ...ch, status: "revoked" });
        await markChannelRun(channelId, { lastError: "revoked" });
        return { ...result, error: "revoked" };
      }
      await markChannelRun(channelId, { lastError: String(err.message).slice(0, 500) });
      return { ...result, error: err.message };
    }

    return result;
  } finally {
    running.delete(channelId);
  }
}

function isDue(last: number | null | undefined, interval: number, now: number): boolean {
  return last == null || now - last >= interval;
}

function persistTokensFor(ch: YouTubeChannel): PersistTokens {
  // Targeted two-column write — never a full-row upsert from this snapshot (see B6).
  return ({ accessToken, expiresAt }) => updateYouTubeTokens(ch.channelId, accessToken, expiresAt);
}

async function syncVideos(
  clientId: string,
  clientSecret: string,
  ch: YouTubeChannel,
  persist: PersistTokens,
): Promise<number> {
  const { videos } = await syncChannelVideos(clientId, clientSecret, ch, persist);
  const now = Date.now();

  for (const v of videos) {
    const existing = await getChannelVideoByVideoId(v.videoId);
    const row: ChannelVideo = {
      id: existing?.id ?? `cv_${v.videoId}`,
      channelId: ch.channelId,
      videoId: v.videoId,
      title: v.title,
      description: v.description,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      thumbnail: v.thumbnail,
      viewCount: v.viewCount,
      likeCount: v.likeCount,
      commentCount: v.commentCount,
      lastSynced: now,
    };
    await upsertChannelVideo(row);

    // First time we've ever seen this upload → kick off 48h high-density polling.
    // Deduped so a second sync before the row is committed can't double-schedule; the
    // hotwatch job itself decides when to stop (publish age) and re-enqueues meanwhile.
    // Age-gated here too: the first sync of a freshly connected channel sees the ENTIRE
    // back catalog as "new" — without the gate that's up to 500 pointless hotwatch jobs.
    if (!existing && now - Date.parse(v.publishedAt) < HOTWATCH_WINDOW_MS) {
      await enqueue(
        "video.hotwatch",
        { videoId: v.videoId, channelId: ch.channelId, publishedAt: v.publishedAt },
        { dedupeKey: `video.hotwatch:${v.videoId}`, delayMs: HOTWATCH_POLL_MS },
      );
    }

    // One snapshot per hour at most — this table is the time series behind the trend charts.
    const last = await getLatestVideoStat(v.videoId);
    if (!last || now - last.snapshotAt > 3_600_000) {
      await insertVideoStat({
        id: `vs_${v.videoId}_${now}`,
        videoId: v.videoId,
        channelId: ch.channelId,
        snapshotAt: now,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
      });
    }
  }

  // Verify Shorts via the /shorts/ probe (Data API has no flag; duration is unreliable).
  // Only not-yet-classified uploads are probed, capped per run and cached forever.
  const uncheckedIds = await getUncheckedShortVideoIds(ch.channelId, SHORTS_PROBE_MAX_PER_SYNC);
  const verdicts = await classifyShorts(uncheckedIds, SHORTS_PROBE_CONCURRENCY);
  for (const [videoId, isShort] of verdicts) {
    await setChannelVideoShort(videoId, isShort, now);
  }

  return videos.length;
}

async function syncAnalytics(
  clientId: string,
  clientSecret: string,
  ch: YouTubeChannel,
  persist: PersistTokens,
): Promise<number> {
  // Backfill on first run; afterwards just re-pull the window YouTube may have revised.
  const days = ch.lastAnalyzedAt ? ANALYTICS_TRAILING_DAYS : ANALYTICS_BACKFILL_DAYS;

  const report = await withAccessToken(clientId, clientSecret, ch, persist, (token) =>
    fetchChannelAnalytics(token, {
      startDate: isoDay(days),
      endDate: isoDay(0),
      dimensions: "day",
    }),
  );

  const fetchedAt = Date.now();
  const rows: ChannelAnalyticsDay[] = report.rows.map((r) => ({
    channelId: ch.channelId,
    day: String(r.day),
    views: num(r.views),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    averageViewDuration: num(r.averageViewDuration),
    averageViewPercentage: num(r.averageViewPercentage),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
    fetchedAt,
  }));

  // Daily revenue — only resolves on a monetized channel whose token carries the monetary
  // scope. A channel whose revenue is administered by a content owner (MCN / broadcaster
  // CMS) 403s here because channel==MINE cannot read owner-level revenue. We LOG the outcome
  // instead of swallowing it, so a silent $0 is diagnosable (403 vs no rows vs real data).
  try {
    const rev = await withAccessToken(clientId, clientSecret, ch, persist, (token) =>
      fetchChannelAnalytics(token, {
        startDate: isoDay(days),
        endDate: isoDay(0),
        dimensions: "day",
        metrics: "estimatedRevenue",
      }),
    );
    const byDay = new Map<string, number>();
    for (const r of rev.rows) byDay.set(String(r.day), num(r.estimatedRevenue));
    for (const row of rows) row.estimatedRevenue = byDay.get(row.day) ?? 0;
    const total = [...byDay.values()].reduce((a, b) => a + b, 0);
    console.log(`[revenue] ${ch.channelId}: ${rev.rows.length} day(s), total $${total.toFixed(2)}`);
  } catch (err) {
    // Revenue is optional — keep 0, but say why so it isn't an invisible failure.
    const status = err instanceof YouTubeApiError ? err.status : "?";
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[revenue] ${ch.channelId}: skipped (status ${status}) — ${msg.slice(0, 300)}`);
  }

  await upsertChannelAnalytics(rows);
  return rows.length;
}

/**
 * Scheduler entry point: run every channel that is due. Sequential on purpose —
 * these calls share one YouTube quota, and a burst of parallel channels is the
 * fastest way to exhaust it.
 */
export async function runDueChannels(
  clientId: string,
  clientSecret: string,
): Promise<PipelineResult[]> {
  const channels = await listYouTubeChannels();
  const results: PipelineResult[] = [];

  for (const ch of channels) {
    if (ch.status === "revoked") continue;
    results.push(await runChannelPipeline(clientId, clientSecret, ch.channelId));
  }

  return results;
}

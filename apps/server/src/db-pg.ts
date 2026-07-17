/**
 * Persistence — PostgreSQL (production). Replaces node:sqlite for Cloud Run + Cloud SQL.
 * Connection via DATABASE_URL env var.
 *
 * Same domain graph + media/youtube schema as the SQLite prototype.
 */
import pg from "pg";
import { seed } from "./seed.ts";

const { Pool } = pg;

export type EntityKind = "program" | "episode" | "recommendation" | "clip" | "job";

export interface MediaRow {
  id: string;
  episodeId: string | null;
  role: string;
  title: string;
  filename: string;
  path: string; // GCS URI or local path fallback
  mime: string;
  size: number;
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: number;
  thumbPath: string | null;
  createdAt: number;
}

let pool: pg.Pool;

export function getPool(): pg.Pool {
  return pool;
}

export async function initDb(): Promise<void> {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }

  await migrate();
  await seedIfEmpty();
}

// Runtime schema bootstrap (safety net). Mirrored by the node-pg-migrate baseline
// migrations/1784246400000_baseline-production-schema.cjs — both are all IF NOT EXISTS,
// so they coexist. Keep new tables/columns reflected in BOTH. See docs/ops/migrations.md.
async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entities (
      kind TEXT NOT NULL,
      id   TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      ord  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, id)
    );

    CREATE TABLE IF NOT EXISTS media (
      id          TEXT PRIMARY KEY,
      episodeId   TEXT,
      role        TEXT NOT NULL,
      title       TEXT NOT NULL,
      filename    TEXT NOT NULL,
      path        TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        BIGINT NOT NULL,
      durationSec REAL NOT NULL DEFAULT 0,
      width       INTEGER NOT NULL DEFAULT 0,
      height      INTEGER NOT NULL DEFAULT 0,
      codec       TEXT NOT NULL DEFAULT '',
      hasAudio    INTEGER NOT NULL DEFAULT 0,
      thumbPath   TEXT,
      createdAt   BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS youtube_channels (
      id           TEXT PRIMARY KEY,
      channelId    TEXT UNIQUE NOT NULL,
      channelName  TEXT NOT NULL,
      channelUrl   TEXT,
      thumbnail    TEXT,
      subscribers  TEXT,
      refreshToken TEXT NOT NULL,
      accessToken  TEXT,
      expiresAt    BIGINT,
      scope        TEXT,
      email        TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      connectedAt  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_videos (
      id           TEXT PRIMARY KEY,
      channelId    TEXT NOT NULL,
      videoId      TEXT UNIQUE NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      publishedAt  TEXT NOT NULL,
      durationSec  REAL NOT NULL DEFAULT 0,
      thumbnail    TEXT,
      viewCount    BIGINT NOT NULL DEFAULT 0,
      likeCount    BIGINT NOT NULL DEFAULT 0,
      commentCount BIGINT NOT NULL DEFAULT 0,
      lastSynced   BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_stats (
      id           TEXT PRIMARY KEY,
      videoId      TEXT NOT NULL,
      channelId    TEXT NOT NULL,
      snapshotAt   BIGINT NOT NULL,
      viewCount    BIGINT NOT NULL DEFAULT 0,
      likeCount    BIGINT NOT NULL DEFAULT 0,
      commentCount BIGINT NOT NULL DEFAULT 0
    );

    -- Daily channel metrics from the YouTube Analytics API. Keyed by (channel, day)
    -- so re-fetching a window overwrites instead of duplicating — YouTube keeps
    -- revising the last few days, so the pipeline re-pulls a trailing window.
    CREATE TABLE IF NOT EXISTS channel_analytics (
      channelId               TEXT NOT NULL,
      day                     TEXT NOT NULL,
      views                   BIGINT NOT NULL DEFAULT 0,
      estimatedMinutesWatched BIGINT NOT NULL DEFAULT 0,
      averageViewDuration     REAL NOT NULL DEFAULT 0,
      averageViewPercentage   REAL NOT NULL DEFAULT 0,
      subscribersGained       BIGINT NOT NULL DEFAULT 0,
      subscribersLost         BIGINT NOT NULL DEFAULT 0,
      fetchedAt               BIGINT NOT NULL,
      PRIMARY KEY (channelId, day)
    );

    -- Per-video analytics snapshot (YouTube Analytics API, filters=video==id). One
    -- row per video, overwritten on each refresh — we keep the latest, not a history.
    CREATE TABLE IF NOT EXISTS video_analytics (
      videoId        TEXT PRIMARY KEY,
      channelId      TEXT NOT NULL,
      fetchedAt      BIGINT NOT NULL,
      summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
      trafficSources JSONB NOT NULL DEFAULT '[]'::jsonb,
      demographics   JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    -- Retention curve for a video: [{ratio, watchRatio, relative}] along 0→1.
    -- Latest curve only (upsert by videoId), same rationale as video_analytics.
    CREATE TABLE IF NOT EXISTS video_retention (
      videoId   TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      fetchedAt BIGINT NOT NULL,
      curve     JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    -- Top comment threads per video (Data API commentThreads, one page). Keyed by the
    -- comment id so a re-fetch refreshes like counts instead of duplicating rows.
    CREATE TABLE IF NOT EXISTS video_comments (
      id          TEXT PRIMARY KEY,
      videoId     TEXT NOT NULL,
      channelId   TEXT NOT NULL,
      author      TEXT NOT NULL DEFAULT '',
      text        TEXT NOT NULL DEFAULT '',
      likeCount   BIGINT NOT NULL DEFAULT 0,
      publishedAt TEXT NOT NULL,
      fetchedAt   BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_videos_channel ON channel_videos(channelId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_video ON video_stats(videoId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_snapshot ON video_stats(snapshotAt);
    CREATE INDEX IF NOT EXISTS idx_video_analytics_channel ON video_analytics(channelId);
    CREATE INDEX IF NOT EXISTS idx_video_comments_video ON video_comments(videoId);
  `);

  // Added after the table shipped, so existing deployments need them backfilled.
  // These drive the scheduler: NULL means "never ran", so a newly connected channel
  // gets picked up on the next tick even if the on-connect kick never got CPU.
  await pool.query(`
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastSyncedAt   BIGINT;
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastAnalyzedAt BIGINT;
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastError      TEXT;
  `);

  // Shorts flag — verified by probing youtube.com/shorts/<id> (see youtube.ts:isShortVideo).
  // shortCheckedAt is null until probed; rows carried over from the old duration heuristic
  // have it null, so the next sync re-classifies them for real.
  await pool.query(`
    ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS isShort BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS shortCheckedAt BIGINT;
  `);

  // Daily estimated revenue (USD) — only nonzero on monetized channels whose consent
  // includes the monetary scope; stays 0 otherwise.
  await pool.query(`
    ALTER TABLE channel_analytics ADD COLUMN IF NOT EXISTS estimatedRevenue REAL NOT NULL DEFAULT 0;
  `);

  // Content pipeline results (per uploaded media): the analyze.py output blob
  // (transcript + scenes + shorts). Kept as JSONB — the shape evolves with the
  // pipeline and the admin/web read it whole.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_analysis (
      mediaId    TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'pending',
      data       JSONB,
      error      TEXT,
      createdAt  BIGINT NOT NULL,
      updatedAt  BIGINT NOT NULL
    );
  `);
}

async function seedIfEmpty(): Promise<void> {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM entities");
  if (rows[0].n > 0) return;

  const insert = `INSERT INTO entities (kind, id, data, ord) VALUES ($1, $2, $3::jsonb, $4)`;
  const put = async (kind: EntityKind, list: unknown[]) => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as { id: string };
      await pool.query(insert, [kind, e.id, JSON.stringify(e), i]);
    }
  };

  await put("program", seed.programs);
  await put("episode", seed.episodes);
  await put("recommendation", seed.recommendations);
  await put("clip", seed.clips);
  await put("job", seed.jobs);

  await pool.query(
    `INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ["connections", JSON.stringify(seed.connections)],
  );
}

// ── entity helpers ─────────────────────────────────────────────────────────────

export async function listEntities<T = unknown>(kind: EntityKind): Promise<T[]> {
  const { rows } = await pool.query(
    "SELECT data FROM entities WHERE kind = $1 ORDER BY ord ASC",
    [kind],
  );
  return rows.map((r) => r.data as T);
}

export async function getEntity<T = unknown>(kind: EntityKind, id: string): Promise<T | undefined> {
  const { rows } = await pool.query(
    "SELECT data FROM entities WHERE kind = $1 AND id = $2",
    [kind, id],
  );
  return rows[0]?.data as T | undefined;
}

export async function putEntity(kind: EntityKind, id: string, data: unknown, ord = 0): Promise<void> {
  await pool.query(
    `INSERT INTO entities (kind, id, data, ord) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (kind, id) DO UPDATE SET data = $3::jsonb`,
    [kind, id, JSON.stringify(data), ord],
  );
}

export async function prependEntity(kind: EntityKind, id: string, data: unknown): Promise<void> {
  const { rows } = await pool.query(
    "SELECT COALESCE(MIN(ord), 0) - 1 AS m FROM entities WHERE kind = $1",
    [kind],
  );
  await putEntity(kind, id, data, rows[0].m);
}

// ── connections ────────────────────────────────────────────────────────────────

export async function getConnections(): Promise<{ youtube: boolean; meta: boolean; metaInstagram: boolean }> {
  const { rows } = await pool.query("SELECT value FROM kv WHERE key = $1", ["connections"]);
  return rows[0] ? JSON.parse(rows[0].value) : seed.connections;
}

// ── youtube channels ───────────────────────────────────────────────────────────

export interface YouTubeChannel {
  id: string;
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  thumbnail: string | null;
  subscribers: string | null;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  email: string | null;
  status: string;
  connectedAt: number;
  /** null = never run. Drives which channels the scheduler picks up. */
  lastSyncedAt?: number | null;
  lastAnalyzedAt?: number | null;
  lastError?: string | null;
}

// ── channel analytics (YouTube Analytics API, daily) ───────────────────────────

export interface ChannelAnalyticsDay {
  channelId: string;
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  subscribersGained: number;
  subscribersLost: number;
  estimatedRevenue?: number;
  fetchedAt: number;
}

export async function upsertChannelAnalytics(rows: ChannelAnalyticsDay[]): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO channel_analytics
         (channelId, day, views, estimatedMinutesWatched, averageViewDuration,
          averageViewPercentage, subscribersGained, subscribersLost, estimatedRevenue, fetchedAt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (channelId, day) DO UPDATE SET
         views                   = EXCLUDED.views,
         estimatedMinutesWatched = EXCLUDED.estimatedMinutesWatched,
         averageViewDuration     = EXCLUDED.averageViewDuration,
         averageViewPercentage   = EXCLUDED.averageViewPercentage,
         subscribersGained       = EXCLUDED.subscribersGained,
         subscribersLost         = EXCLUDED.subscribersLost,
         estimatedRevenue        = EXCLUDED.estimatedRevenue,
         fetchedAt               = EXCLUDED.fetchedAt`,
      [r.channelId, r.day, r.views, r.estimatedMinutesWatched, r.averageViewDuration,
        r.averageViewPercentage, r.subscribersGained, r.subscribersLost, r.estimatedRevenue ?? 0, r.fetchedAt],
    );
  }
}

export async function getChannelAnalytics(
  channelId: string,
  fromDay: string,
): Promise<ChannelAnalyticsDay[]> {
  const { rows } = await pool.query(
    `SELECT channelid AS "channelId", day, views,
            estimatedminuteswatched AS "estimatedMinutesWatched",
            averageviewduration AS "averageViewDuration",
            averageviewpercentage AS "averageViewPercentage",
            subscribersgained AS "subscribersGained",
            subscriberslost AS "subscribersLost",
            estimatedrevenue AS "estimatedRevenue",
            fetchedat AS "fetchedAt"
       FROM channel_analytics
      WHERE channelId = $1 AND day >= $2
      ORDER BY day ASC`,
    [channelId, fromDay],
  );
  return rows as unknown as ChannelAnalyticsDay[];
}

/** Records a completed pipeline run (or the error that stopped it). */
export async function markChannelRun(
  channelId: string,
  patch: { lastSyncedAt?: number; lastAnalyzedAt?: number; lastError?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE youtube_channels
        SET lastSyncedAt   = COALESCE($2, lastSyncedAt),
            lastAnalyzedAt = COALESCE($3, lastAnalyzedAt),
            lastError      = $4
      WHERE channelId = $1`,
    [channelId, patch.lastSyncedAt ?? null, patch.lastAnalyzedAt ?? null, patch.lastError ?? null],
  );
}

export async function listYouTubeChannels(): Promise<YouTubeChannel[]> {
  const { rows } = await pool.query(`SELECT id, channelid AS "channelId", channelname AS "channelName", channelurl AS "channelUrl", thumbnail, subscribers, refreshtoken AS "refreshToken", accesstoken AS "accessToken", expiresat AS "expiresAt", scope, email, status, connectedat AS "connectedAt", lastsyncedat AS "lastSyncedAt", lastanalyzedat AS "lastAnalyzedAt", lasterror AS "lastError" FROM youtube_channels ORDER BY connectedAt DESC`);
  return rows as unknown as YouTubeChannel[];
}

export async function getYouTubeChannelByChannelId(channelId: string): Promise<YouTubeChannel | undefined> {
  const { rows } = await pool.query(
    `SELECT id, channelid AS "channelId", channelname AS "channelName", channelurl AS "channelUrl", thumbnail, subscribers, refreshtoken AS "refreshToken", accesstoken AS "accessToken", expiresat AS "expiresAt", scope, email, status, connectedat AS "connectedAt", lastsyncedat AS "lastSyncedAt", lastanalyzedat AS "lastAnalyzedAt", lasterror AS "lastError" FROM youtube_channels WHERE channelId = $1`,
    [channelId],
  );
  return rows[0] as YouTubeChannel | undefined;
}

export async function upsertYouTubeChannel(ch: YouTubeChannel): Promise<void> {
  await pool.query(
    `INSERT INTO youtube_channels (id, channelId, channelName, channelUrl, thumbnail, subscribers, refreshToken, accessToken, expiresAt, scope, email, status, connectedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (channelId) DO UPDATE SET
       channelName = EXCLUDED.channelName,
       channelUrl  = EXCLUDED.channelUrl,
       thumbnail   = EXCLUDED.thumbnail,
       subscribers = EXCLUDED.subscribers,
       refreshToken = EXCLUDED.refreshToken,
       accessToken = EXCLUDED.accessToken,
       expiresAt   = EXCLUDED.expiresAt,
       scope       = EXCLUDED.scope,
       email       = EXCLUDED.email,
       status      = EXCLUDED.status,
       connectedAt = EXCLUDED.connectedAt`,
    [ch.id, ch.channelId, ch.channelName, ch.channelUrl, ch.thumbnail,
     ch.subscribers, ch.refreshToken, ch.accessToken, ch.expiresAt,
     ch.scope, ch.email, ch.status, ch.connectedAt],
  );
}

export async function deleteYouTubeChannel(channelId: string): Promise<void> {
  await pool.query("DELETE FROM youtube_channels WHERE channelId = $1", [channelId]);
}

// ── channel videos ─────────────────────────────────────────────────────────────

export interface ChannelVideo {
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
  /** True if a YouTube Short. Verified async via a /shorts/ probe, not by upsertChannelVideo. */
  isShort?: boolean;
}

export interface VideoStat {
  id: string;
  videoId: string;
  channelId: string;
  snapshotAt: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export async function upsertChannelVideo(v: ChannelVideo): Promise<void> {
  // isShort is NOT written here — it's verified asynchronously by probing youtube.com/shorts
  // (see classifyShorts / setChannelVideoShort). A new row starts unclassified
  // (shortCheckedAt null → DEFAULT FALSE); upserting an existing row leaves its verified
  // isShort/shortCheckedAt untouched, so a re-sync never clobbers a real verdict.
  await pool.query(
    `INSERT INTO channel_videos (id, channelId, videoId, title, description, publishedAt, durationSec, thumbnail, viewCount, likeCount, commentCount, lastSynced)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (videoId) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       durationSec = EXCLUDED.durationSec,
       thumbnail = EXCLUDED.thumbnail,
       viewCount = EXCLUDED.viewCount,
       likeCount = EXCLUDED.likeCount,
       commentCount = EXCLUDED.commentCount,
       lastSynced = EXCLUDED.lastSynced`,
    [v.id, v.channelId, v.videoId, v.title, v.description, v.publishedAt,
     v.durationSec, v.thumbnail, v.viewCount, v.likeCount, v.commentCount, v.lastSynced],
  );
}

/** Video IDs on this channel whose Shorts status hasn't been verified yet (newest first). */
export async function getUncheckedShortVideoIds(channelId: string, limit: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT videoid AS "videoId" FROM channel_videos
     WHERE channelId = $1 AND shortCheckedAt IS NULL
     ORDER BY publishedAt DESC LIMIT $2`,
    [channelId, limit],
  );
  return rows.map((r) => r.videoId as string);
}

/** How many uploads on this channel still await Shorts classification. */
export async function countUncheckedShortVideos(channelId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM channel_videos WHERE channelId = $1 AND shortCheckedAt IS NULL`,
    [channelId],
  );
  return (rows[0]?.n as number) ?? 0;
}

/** Persist a verified Shorts verdict (checkedAt marks the row as classified). */
export async function setChannelVideoShort(videoId: string, isShort: boolean, checkedAt: number): Promise<void> {
  await pool.query(
    `UPDATE channel_videos SET isShort = $2, shortCheckedAt = $3 WHERE videoId = $1`,
    [videoId, isShort, checkedAt],
  );
}

export async function listChannelVideos(channelId: string): Promise<ChannelVideo[]> {
  const { rows } = await pool.query(
    `SELECT id, channelid AS "channelId", videoid AS "videoId", title, description, publishedat AS "publishedAt", durationsec AS "durationSec", thumbnail, viewcount AS "viewCount", likecount AS "likeCount", commentcount AS "commentCount", lastsynced AS "lastSynced", isshort AS "isShort" FROM channel_videos WHERE channelId = $1 ORDER BY publishedAt DESC`,
    [channelId],
  );
  return rows as unknown as ChannelVideo[];
}

export async function getChannelVideoByVideoId(videoId: string): Promise<ChannelVideo | undefined> {
  const { rows } = await pool.query(
    `SELECT id, channelid AS "channelId", videoid AS "videoId", title, description, publishedat AS "publishedAt", durationsec AS "durationSec", thumbnail, viewcount AS "viewCount", likecount AS "likeCount", commentcount AS "commentCount", lastsynced AS "lastSynced", isshort AS "isShort" FROM channel_videos WHERE videoId = $1`,
    [videoId],
  );
  return rows[0] as ChannelVideo | undefined;
}

export async function deleteChannelVideo(videoId: string): Promise<void> {
  await pool.query("DELETE FROM channel_videos WHERE videoId = $1", [videoId]);
  await pool.query("DELETE FROM video_stats WHERE videoId = $1", [videoId]);
  await pool.query("DELETE FROM video_analytics WHERE videoId = $1", [videoId]);
  await pool.query("DELETE FROM video_retention WHERE videoId = $1", [videoId]);
  await pool.query("DELETE FROM video_comments WHERE videoId = $1", [videoId]);
}

export async function deleteChannelVideosForChannel(channelId: string): Promise<void> {
  await pool.query("DELETE FROM channel_videos WHERE channelId = $1", [channelId]);
  await pool.query("DELETE FROM video_stats WHERE channelId = $1", [channelId]);
  await pool.query("DELETE FROM video_analytics WHERE channelId = $1", [channelId]);
  await pool.query("DELETE FROM video_retention WHERE channelId = $1", [channelId]);
  await pool.query("DELETE FROM video_comments WHERE channelId = $1", [channelId]);
}

export async function insertVideoStat(s: VideoStat): Promise<void> {
  await pool.query(
    `INSERT INTO video_stats (id, videoId, channelId, snapshotAt, viewCount, likeCount, commentCount)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [s.id, s.videoId, s.channelId, s.snapshotAt, s.viewCount, s.likeCount, s.commentCount],
  );
}

export async function getLatestVideoStat(videoId: string): Promise<VideoStat | undefined> {
  const { rows } = await pool.query(
    `SELECT id, videoid AS "videoId", channelid AS "channelId", snapshotat AS "snapshotAt", viewcount AS "viewCount", likecount AS "likeCount", commentcount AS "commentCount" FROM video_stats WHERE videoId = $1 ORDER BY snapshotAt DESC LIMIT 1`,
    [videoId],
  );
  return rows[0] as VideoStat | undefined;
}

export async function getVideoStats(videoId: string, days = 30): Promise<VideoStat[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const { rows } = await pool.query(
    `SELECT id, videoid AS "videoId", channelid AS "channelId", snapshotat AS "snapshotAt", viewcount AS "viewCount", likecount AS "likeCount", commentcount AS "commentCount" FROM video_stats WHERE videoId = $1 AND snapshotAt >= $2 ORDER BY snapshotAt ASC`,
    [videoId, cutoff],
  );
  return rows as unknown as VideoStat[];
}

export async function getChannelStats(channelId: string, days = 7): Promise<VideoStat[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const { rows } = await pool.query(
    `SELECT id, videoid AS "videoId", channelid AS "channelId", snapshotat AS "snapshotAt", viewcount AS "viewCount", likecount AS "likeCount", commentcount AS "commentCount" FROM video_stats WHERE channelId = $1 AND snapshotAt >= $2 ORDER BY snapshotAt ASC`,
    [channelId, cutoff],
  );
  return rows as unknown as VideoStat[];
}

function isoDayAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Real daily views from the YouTube Analytics backfill (channel_analytics), NOT our
 * post-connection cumulative snapshots. `channel_analytics.views` is the channel's
 * actual views on that calendar day, so the trend reflects true history (up to the
 * 365-day backfill) rather than "since you registered with us".
 */
export async function getChannelViewTrend(
  channelId: string,
  days = 90,
): Promise<{ date: string; totalViews: number; count: number }[]> {
  const { rows } = await pool.query(
    `SELECT day, views AS "totalViews", estimatedMinutesWatched AS "minutes"
       FROM channel_analytics
      WHERE channelId = $1 AND day >= $2
      ORDER BY day ASC`,
    [channelId, isoDayAgo(days)],
  );
  return rows.map((r) => ({ date: r.day, totalViews: Number(r.totalViews), count: Number(r.minutes) }));
}

/**
 * Growth compares the recent `days` window vs the equally-long window before it, from
 * real daily views — so it needs `2*days` of backfilled history (the 365-day backfill
 * covers it). Also rolls up watch minutes and net subscribers for the recent window.
 */
export async function getChannelTrendSummary(channelId: string, days = 90) {
  const { rows: recentRows } = await pool.query(
    `SELECT COALESCE(SUM(views), 0)::bigint AS total,
            COALESCE(SUM(estimatedMinutesWatched), 0)::bigint AS mins,
            COALESCE(SUM(subscribersGained - subscribersLost), 0)::bigint AS net_subs,
            COALESCE(SUM(estimatedRevenue), 0)::float8 AS revenue
       FROM channel_analytics WHERE channelId = $1 AND day >= $2`,
    [channelId, isoDayAgo(days)],
  );
  const { rows: earlierRows } = await pool.query(
    `SELECT COALESCE(SUM(views), 0)::bigint AS total
       FROM channel_analytics WHERE channelId = $1 AND day >= $2 AND day < $3`,
    [channelId, isoDayAgo(days * 2), isoDayAgo(days)],
  );
  const { rows: vidRows } = await pool.query(
    "SELECT COALESCE(SUM(viewCount), 0)::bigint AS total_views, COUNT(*)::int AS count FROM channel_videos WHERE channelId = $1",
    [channelId],
  );

  const recentViews = Number(recentRows[0]?.total ?? 0);
  const earlierViews = Number(earlierRows[0]?.total ?? 0);
  const growth = earlierViews > 0 ? Math.round(((recentViews - earlierViews) / earlierViews) * 100) : 0;

  return {
    totalViews: Number(vidRows[0]?.total_views ?? 0),
    videoCount: Number(vidRows[0]?.count ?? 0),
    recentPeriodViews: recentViews,
    earlierPeriodViews: earlierViews,
    growthPercent: growth,
    watchMinutes: Number(recentRows[0]?.mins ?? 0),
    netSubscribers: Number(recentRows[0]?.net_subs ?? 0),
    channelRevenue: Number(recentRows[0]?.revenue ?? 0),
    periodDays: days,
  };
}

// ── per-video analytics ─────────────────────────────────────────────────────────

export interface VideoAnalytics {
  videoId: string;
  channelId: string;
  fetchedAt: number;
  summary: Record<string, number>;
  trafficSources: { source: string; views: number; estimatedMinutesWatched: number }[];
  demographics: { ageGroup: string; gender: string; viewerPercentage: number }[];
}

export interface VideoRetention {
  videoId: string;
  channelId: string;
  fetchedAt: number;
  curve: { ratio: number; watchRatio: number; relative: number }[];
}

export interface VideoComment {
  id: string;
  videoId: string;
  channelId: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  fetchedAt: number;
}

export async function upsertVideoAnalytics(a: VideoAnalytics): Promise<void> {
  await pool.query(
    `INSERT INTO video_analytics (videoId, channelId, fetchedAt, summary, trafficSources, demographics)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
     ON CONFLICT (videoId) DO UPDATE SET
       channelId      = EXCLUDED.channelId,
       fetchedAt      = EXCLUDED.fetchedAt,
       summary        = EXCLUDED.summary,
       trafficSources = EXCLUDED.trafficSources,
       demographics   = EXCLUDED.demographics`,
    [a.videoId, a.channelId, a.fetchedAt, JSON.stringify(a.summary),
     JSON.stringify(a.trafficSources), JSON.stringify(a.demographics)],
  );
}

export async function getVideoAnalytics(videoId: string): Promise<VideoAnalytics | undefined> {
  const { rows } = await pool.query(
    `SELECT videoid AS "videoId", channelid AS "channelId", fetchedat AS "fetchedAt",
            summary, trafficsources AS "trafficSources", demographics
       FROM video_analytics WHERE videoId = $1`,
    [videoId],
  );
  return rows[0] as VideoAnalytics | undefined;
}

export async function upsertVideoRetention(r: VideoRetention): Promise<void> {
  await pool.query(
    `INSERT INTO video_retention (videoId, channelId, fetchedAt, curve)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (videoId) DO UPDATE SET
       channelId = EXCLUDED.channelId,
       fetchedAt = EXCLUDED.fetchedAt,
       curve     = EXCLUDED.curve`,
    [r.videoId, r.channelId, r.fetchedAt, JSON.stringify(r.curve)],
  );
}

export async function getVideoRetention(videoId: string): Promise<VideoRetention | undefined> {
  const { rows } = await pool.query(
    `SELECT videoid AS "videoId", channelid AS "channelId", fetchedat AS "fetchedAt", curve
       FROM video_retention WHERE videoId = $1`,
    [videoId],
  );
  return rows[0] as VideoRetention | undefined;
}

export async function upsertVideoComment(cm: VideoComment): Promise<void> {
  await pool.query(
    `INSERT INTO video_comments (id, videoId, channelId, author, text, likeCount, publishedAt, fetchedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       author      = EXCLUDED.author,
       text        = EXCLUDED.text,
       likeCount   = EXCLUDED.likeCount,
       fetchedAt   = EXCLUDED.fetchedAt`,
    [cm.id, cm.videoId, cm.channelId, cm.author, cm.text, cm.likeCount, cm.publishedAt, cm.fetchedAt],
  );
}

export async function listVideoComments(videoId: string, limit = 100): Promise<VideoComment[]> {
  const { rows } = await pool.query(
    `SELECT id, videoid AS "videoId", channelid AS "channelId", author, text,
            likecount AS "likeCount", publishedat AS "publishedAt", fetchedat AS "fetchedAt"
       FROM video_comments WHERE videoId = $1 ORDER BY likeCount DESC LIMIT $2`,
    [videoId, limit],
  );
  return rows as unknown as VideoComment[];
}

/** Most recent comment-collection time for a video — drives the daily refresh gate. */
export async function getLatestCommentFetchedAt(videoId: string): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT MAX(fetchedAt)::bigint AS "fetchedAt" FROM video_comments WHERE videoId = $1`,
    [videoId],
  );
  const v = rows[0]?.fetchedAt;
  return v == null ? null : Number(v);
}

// ── media ──────────────────────────────────────────────────────────────────────

export async function insertMedia(m: MediaRow): Promise<void> {
  await pool.query(
    `INSERT INTO media (id, episodeId, role, title, filename, path, mime, size, durationSec, width, height, codec, hasAudio, thumbPath, createdAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [m.id, m.episodeId, m.role, m.title, m.filename, m.path, m.mime, m.size,
     m.durationSec, m.width, m.height, m.codec, m.hasAudio, m.thumbPath, m.createdAt],
  );
}

export async function getMedia(id: string): Promise<MediaRow | undefined> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt" FROM media WHERE id = $1`, [id]);
  return rows[0] as MediaRow | undefined;
}

export async function listMedia(): Promise<MediaRow[]> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt" FROM media ORDER BY createdAt DESC`);
  return rows as unknown as MediaRow[];
}

export async function updateMediaThumb(id: string, thumbPath: string): Promise<void> {
  await pool.query("UPDATE media SET thumbPath = $1 WHERE id = $2", [thumbPath, id]);
}

// ── assembled state ────────────────────────────────────────────────────────────

export async function getState() {
  const [programs, episodes, recommendations, clips, jobs, connections, media] = await Promise.all([
    listEntities("program"),
    listEntities("episode"),
    listEntities("recommendation"),
    listEntities("clip"),
    listEntities("job"),
    getConnections(),
    listMedia(),
  ]);
  return {
    programs,
    episodes,
    recommendations,
    clips,
    jobs,
    connections,
    media: media.map(mediaPublic),
  };
}

export function mediaPublic(m: MediaRow) {
  return {
    id: m.id,
    episodeId: m.episodeId,
    role: m.role,
    title: m.title,
    filename: m.filename,
    mime: m.mime,
    size: m.size,
    durationSec: m.durationSec,
    width: m.width,
    height: m.height,
    codec: m.codec,
    hasAudio: Boolean(m.hasAudio),
    // Relative to the web's API_BASE (which already ends in /api) — no /api prefix here,
    // else `${apiBase}${streamUrl}` doubles to /api/api/... and 404s.
    streamUrl: `/media/${m.id}/stream`,
    thumbUrl: m.thumbPath ? `/media/${m.id}/thumb` : null,
    createdAt: m.createdAt,
  };
}

// ── content analysis (uploaded media pipeline results) ─────────────────────────

export interface ContentAnalysis {
  mediaId: string;
  status: string;
  data: unknown | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Mark a media as queued/processing before the worker starts. */
export async function markContentAnalysisPending(mediaId: string): Promise<void> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO content_analysis (mediaId, status, createdAt, updatedAt)
     VALUES ($1, 'pending', $2, $2)
     ON CONFLICT (mediaId) DO UPDATE SET status = 'pending', error = NULL, updatedAt = $2`,
    [mediaId, now],
  );
}

/** Store the finished analyze.py result (or an error). */
export async function saveContentAnalysis(
  mediaId: string,
  result: { data?: unknown; error?: string },
): Promise<void> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO content_analysis (mediaId, status, data, error, createdAt, updatedAt)
     VALUES ($1, $2, $3::jsonb, $4, $5, $5)
     ON CONFLICT (mediaId) DO UPDATE SET
       status = EXCLUDED.status, data = EXCLUDED.data, error = EXCLUDED.error, updatedAt = $5`,
    [
      mediaId,
      result.error ? "failed" : "done",
      result.data ? JSON.stringify(result.data) : null,
      result.error ?? null,
      now,
    ],
  );
}

export async function getContentAnalysis(mediaId: string): Promise<ContentAnalysis | undefined> {
  const { rows } = await pool.query(
    `SELECT mediaid AS "mediaId", status, data, error,
            createdat AS "createdAt", updatedat AS "updatedAt"
       FROM content_analysis WHERE mediaId = $1`,
    [mediaId],
  );
  return rows[0] as ContentAnalysis | undefined;
}

// ── cleanup ────────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  await pool.end();
}

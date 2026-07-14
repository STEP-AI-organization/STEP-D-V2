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

    CREATE INDEX IF NOT EXISTS idx_channel_videos_channel ON channel_videos(channelId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_video ON video_stats(videoId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_snapshot ON video_stats(snapshotAt);
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
}

export async function listYouTubeChannels(): Promise<YouTubeChannel[]> {
  const { rows } = await pool.query("SELECT * FROM youtube_channels ORDER BY connectedAt DESC");
  return rows as unknown as YouTubeChannel[];
}

export async function getYouTubeChannelByChannelId(channelId: string): Promise<YouTubeChannel | undefined> {
  const { rows } = await pool.query(
    "SELECT * FROM youtube_channels WHERE channelId = $1",
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

export async function listChannelVideos(channelId: string): Promise<ChannelVideo[]> {
  const { rows } = await pool.query(
    "SELECT * FROM channel_videos WHERE channelId = $1 ORDER BY publishedAt DESC",
    [channelId],
  );
  return rows as unknown as ChannelVideo[];
}

export async function getChannelVideoByVideoId(videoId: string): Promise<ChannelVideo | undefined> {
  const { rows } = await pool.query(
    "SELECT * FROM channel_videos WHERE videoId = $1",
    [videoId],
  );
  return rows[0] as ChannelVideo | undefined;
}

export async function deleteChannelVideo(videoId: string): Promise<void> {
  await pool.query("DELETE FROM channel_videos WHERE videoId = $1", [videoId]);
  await pool.query("DELETE FROM video_stats WHERE videoId = $1", [videoId]);
}

export async function deleteChannelVideosForChannel(channelId: string): Promise<void> {
  await pool.query("DELETE FROM channel_videos WHERE channelId = $1", [channelId]);
  await pool.query("DELETE FROM video_stats WHERE channelId = $1", [channelId]);
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
    "SELECT * FROM video_stats WHERE videoId = $1 ORDER BY snapshotAt DESC LIMIT 1",
    [videoId],
  );
  return rows[0] as VideoStat | undefined;
}

export async function getVideoStats(videoId: string, days = 30): Promise<VideoStat[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const { rows } = await pool.query(
    "SELECT * FROM video_stats WHERE videoId = $1 AND snapshotAt >= $2 ORDER BY snapshotAt ASC",
    [videoId, cutoff],
  );
  return rows as unknown as VideoStat[];
}

export async function getChannelStats(channelId: string, days = 7): Promise<VideoStat[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const { rows } = await pool.query(
    "SELECT * FROM video_stats WHERE channelId = $1 AND snapshotAt >= $2 ORDER BY snapshotAt ASC",
    [channelId, cutoff],
  );
  return rows as unknown as VideoStat[];
}

export async function getChannelViewTrend(
  channelId: string,
  days = 30,
): Promise<{ date: string; totalViews: number; count: number }[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const { rows } = await pool.query(
    `SELECT TO_CHAR(TO_TIMESTAMP(snapshotAt / 1000), 'YYYY-MM-DD') AS day,
            SUM(viewCount)::bigint AS "totalViews",
            COUNT(DISTINCT videoId)::int AS "count"
     FROM video_stats
     WHERE channelId = $1 AND snapshotAt >= $2
     GROUP BY day ORDER BY day ASC`,
    [channelId, cutoff],
  );
  return rows.map((r) => ({
    date: r.day,
    totalViews: Number(r.totalViews),
    count: Number(r.count),
  }));
}

export async function getChannelTrendSummary(channelId: string, days = 30) {
  const cutoff = Date.now() - days * 86_400_000;
  const half = days / 2;
  const midCutoff = cutoff + half * 86_400_000;

  const { rows: recentRows } = await pool.query(
    "SELECT COALESCE(SUM(viewCount), 0)::bigint AS total FROM video_stats WHERE channelId = $1 AND snapshotAt >= $2",
    [channelId, midCutoff],
  );

  const { rows: earlierRows } = await pool.query(
    "SELECT COALESCE(SUM(viewCount), 0)::bigint AS total FROM video_stats WHERE channelId = $1 AND snapshotAt >= $2 AND snapshotAt < $3",
    [channelId, cutoff, midCutoff],
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
  };
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
  const { rows } = await pool.query("SELECT * FROM media WHERE id = $1", [id]);
  return rows[0] as MediaRow | undefined;
}

export async function listMedia(): Promise<MediaRow[]> {
  const { rows } = await pool.query("SELECT * FROM media ORDER BY createdAt DESC");
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
    streamUrl: `/api/media/${m.id}/stream`,
    thumbUrl: m.thumbPath ? `/api/media/${m.id}/thumb` : null,
    createdAt: m.createdAt,
  };
}

// ── cleanup ────────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * Persistence — built-in node:sqlite (Node >=22, zero native deps).
 *
 * The domain graph (programs/episodes/recommendations/clips/jobs) is stored as
 * a small document store (`entities` table, JSON blobs with an order column) —
 * enough for a prototype and trivial to assemble into the web's InitialData
 * shape. Uploaded real videos get a proper relational `media` table (columns the
 * streaming endpoint needs). Connections live in `kv`.
 */
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureStorage } from "./storage.ts";
import { seed } from "./seed.ts";

export type EntityKind = "program" | "episode" | "recommendation" | "clip" | "job";

export interface MediaRow {
  id: string;
  episodeId: string | null;
  role: string; // 'master' | 'clip'
  title: string;
  filename: string;
  path: string;
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

let db: DatabaseSync;

export function initDb(): void {
  ensureStorage();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      kind TEXT NOT NULL,
      id   TEXT NOT NULL,
      data TEXT NOT NULL,
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
      size        INTEGER NOT NULL,
      durationSec REAL NOT NULL DEFAULT 0,
      width       INTEGER NOT NULL DEFAULT 0,
      height      INTEGER NOT NULL DEFAULT 0,
      codec       TEXT NOT NULL DEFAULT '',
      hasAudio    INTEGER NOT NULL DEFAULT 0,
      thumbPath   TEXT,
      createdAt   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS youtube_channels (
      id          TEXT PRIMARY KEY,
      channelId   TEXT UNIQUE NOT NULL,
      channelName TEXT NOT NULL,
      channelUrl  TEXT,
      thumbnail   TEXT,
      subscribers TEXT,
      refreshToken TEXT NOT NULL,
      accessToken TEXT,
      expiresAt   INTEGER,
      scope       TEXT,
      email       TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      connectedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_videos (
      id          TEXT PRIMARY KEY,
      channelId   TEXT NOT NULL,
      videoId     TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      publishedAt TEXT NOT NULL,
      durationSec REAL NOT NULL DEFAULT 0,
      thumbnail   TEXT,
      viewCount   INTEGER NOT NULL DEFAULT 0,
      likeCount   INTEGER NOT NULL DEFAULT 0,
      commentCount INTEGER NOT NULL DEFAULT 0,
      lastSynced  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_stats (
      id          TEXT PRIMARY KEY,
      videoId     TEXT NOT NULL,
      channelId   TEXT NOT NULL,
      snapshotAt  INTEGER NOT NULL,
      viewCount   INTEGER NOT NULL DEFAULT 0,
      likeCount   INTEGER NOT NULL DEFAULT 0,
      commentCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_videos_channel ON channel_videos(channelId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_video ON video_stats(videoId);
    CREATE INDEX IF NOT EXISTS idx_video_stats_snapshot ON video_stats(snapshotAt);
  `);
  seedIfEmpty();
}

function seedIfEmpty(): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
  if (row.n > 0) return;
  const insert = db.prepare("INSERT INTO entities (kind, id, data, ord) VALUES (?, ?, ?, ?)");
  const put = (kind: EntityKind, list: unknown[]) =>
    list.forEach((e, i) => insert.run(kind, (e as { id: string }).id, JSON.stringify(e), i));
  put("program", seed.programs);
  put("episode", seed.episodes);
  put("recommendation", seed.recommendations);
  put("clip", seed.clips);
  put("job", seed.jobs);
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(
    "connections",
    JSON.stringify(seed.connections),
  );
}

// ── entity helpers ─────────────────────────────────────────────────────────────

export function listEntities<T = unknown>(kind: EntityKind): T[] {
  const rows = db.prepare("SELECT data FROM entities WHERE kind = ? ORDER BY ord ASC").all(kind) as {
    data: string;
  }[];
  return rows.map((r) => JSON.parse(r.data) as T);
}

export function getEntity<T = unknown>(kind: EntityKind, id: string): T | undefined {
  const row = db.prepare("SELECT data FROM entities WHERE kind = ? AND id = ?").get(kind, id) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export function putEntity(kind: EntityKind, id: string, data: unknown, ord = 0): void {
  db.prepare(
    "INSERT INTO entities (kind, id, data, ord) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data",
  ).run(kind, id, JSON.stringify(data), ord);
}

/** Prepend a new entity (ord below the current minimum so it sorts first). */
export function prependEntity(kind: EntityKind, id: string, data: unknown): void {
  const min = db.prepare("SELECT MIN(ord) AS m FROM entities WHERE kind = ?").get(kind) as {
    m: number | null;
  };
  putEntity(kind, id, data, (min.m ?? 0) - 1);
}

// ── connections ────────────────────────────────────────────────────────────────

export function getConnections(): { youtube: boolean; meta: boolean; metaInstagram: boolean } {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'connections'").get() as
    | { value: string }
    | undefined;
  return row ? JSON.parse(row.value) : seed.connections;
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

export function listYouTubeChannels(): YouTubeChannel[] {
  return db.prepare(
    "SELECT * FROM youtube_channels ORDER BY connectedAt DESC",
  ).all() as unknown as YouTubeChannel[];
}

export function getYouTubeChannelByChannelId(channelId: string): YouTubeChannel | undefined {
  return db.prepare(
    "SELECT * FROM youtube_channels WHERE channelId = ?",
  ).get(channelId) as YouTubeChannel | undefined;
}

export function upsertYouTubeChannel(ch: YouTubeChannel): void {
  db.prepare(
    `INSERT INTO youtube_channels (id, channelId, channelName, channelUrl, thumbnail, subscribers, refreshToken, accessToken, expiresAt, scope, email, status, connectedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channelId) DO UPDATE SET
       channelName = excluded.channelName,
       channelUrl  = excluded.channelUrl,
       thumbnail   = excluded.thumbnail,
       subscribers = excluded.subscribers,
       refreshToken = excluded.refreshToken,
       accessToken = excluded.accessToken,
       expiresAt   = excluded.expiresAt,
       scope       = excluded.scope,
       email       = excluded.email,
       status      = excluded.status,
       connectedAt = excluded.connectedAt`,
  ).run(
    ch.id, ch.channelId, ch.channelName, ch.channelUrl, ch.thumbnail,
    ch.subscribers, ch.refreshToken, ch.accessToken, ch.expiresAt,
    ch.scope, ch.email, ch.status, ch.connectedAt,
  );
}

export function deleteYouTubeChannel(channelId: string): void {
  db.prepare("DELETE FROM youtube_channels WHERE channelId = ?").run(channelId);
}

// ── channel videos (synced from YouTube API) ─────────────────────────────────

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

export function upsertChannelVideo(v: ChannelVideo): void {
  db.prepare(
    `INSERT INTO channel_videos (id, channelId, videoId, title, description, publishedAt, durationSec, thumbnail, viewCount, likeCount, commentCount, lastSynced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(videoId) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       durationSec = excluded.durationSec,
       thumbnail = excluded.thumbnail,
       viewCount = excluded.viewCount,
       likeCount = excluded.likeCount,
       commentCount = excluded.commentCount,
       lastSynced = excluded.lastSynced`,
  ).run(v.id, v.channelId, v.videoId, v.title, v.description, v.publishedAt,
    v.durationSec, v.thumbnail, v.viewCount, v.likeCount, v.commentCount, v.lastSynced);
}

export function listChannelVideos(channelId: string): ChannelVideo[] {
  return db.prepare(
    "SELECT * FROM channel_videos WHERE channelId = ? ORDER BY publishedAt DESC",
  ).all(channelId) as unknown as ChannelVideo[];
}

export function getChannelVideoByVideoId(videoId: string): ChannelVideo | undefined {
  return db.prepare(
    "SELECT * FROM channel_videos WHERE videoId = ?",
  ).get(videoId) as ChannelVideo | undefined;
}

export function deleteChannelVideo(videoId: string): void {
  db.prepare("DELETE FROM channel_videos WHERE videoId = ?").run(videoId);
  db.prepare("DELETE FROM video_stats WHERE videoId = ?").run(videoId);
}

export function deleteChannelVideosForChannel(channelId: string): void {
  db.prepare("DELETE FROM channel_videos WHERE channelId = ?").run(channelId);
  db.prepare("DELETE FROM video_stats WHERE channelId = ?").run(channelId);
}

export function insertVideoStat(s: VideoStat): void {
  db.prepare(
    "INSERT INTO video_stats (id, videoId, channelId, snapshotAt, viewCount, likeCount, commentCount) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(s.id, s.videoId, s.channelId, s.snapshotAt, s.viewCount, s.likeCount, s.commentCount);
}

export function getLatestVideoStat(videoId: string): VideoStat | undefined {
  return db.prepare(
    "SELECT * FROM video_stats WHERE videoId = ? ORDER BY snapshotAt DESC LIMIT 1",
  ).get(videoId) as VideoStat | undefined;
}

export function getVideoStats(videoId: string, days = 30): VideoStat[] {
  const cutoff = Date.now() - days * 86_400_000;
  return db.prepare(
    "SELECT * FROM video_stats WHERE videoId = ? AND snapshotAt >= ? ORDER BY snapshotAt ASC",
  ).all(videoId, cutoff) as unknown as VideoStat[];
}

export function getChannelStats(channelId: string, days = 7): VideoStat[] {
  const cutoff = Date.now() - days * 86_400_000;
  return db.prepare(
    "SELECT * FROM video_stats WHERE channelId = ? AND snapshotAt >= ? ORDER BY snapshotAt ASC",
  ).all(channelId, cutoff) as unknown as VideoStat[];
}

/** Aggregate view counts per day for a channel (for trend chart). */
export function getChannelViewTrend(channelId: string, days = 30): { date: string; totalViews: number; count: number }[] {
  const cutoff = Date.now() - days * 86_400_000;
  const rows = db.prepare(
    `SELECT DATE(snapshotAt / 1000, 'unixepoch') AS day, SUM(viewCount) AS totalViews, COUNT(DISTINCT videoId) AS videoCount
     FROM video_stats WHERE channelId = ? AND snapshotAt >= ?
     GROUP BY day ORDER BY day ASC`,
  ).all(channelId, cutoff) as { day: string; totalViews: number; videoCount: number }[];
  return rows.map((r) => ({ date: r.day, totalViews: Number(r.totalViews), count: Number(r.videoCount) }));
}

/**
 * Trend summary: total views, avg views per video, growth rate over period.
 */
export function getChannelTrendSummary(channelId: string, days = 30) {
  const cutoff = Date.now() - days * 86_400_000;
  const half = days / 2;
  const midCutoff = cutoff + half * 86_400_000;

  const recent: { total: number } | undefined = db.prepare(
    "SELECT COALESCE(SUM(viewCount), 0) AS total FROM video_stats WHERE channelId = ? AND snapshotAt >= ?",
  ).get(channelId, midCutoff) as { total: number } | undefined;

  const earlier: { total: number } | undefined = db.prepare(
    "SELECT COALESCE(SUM(viewCount), 0) AS total FROM video_stats WHERE channelId = ? AND snapshotAt >= ? AND snapshotAt < ?",
  ).get(channelId, cutoff, midCutoff) as { total: number } | undefined;

  const recentViews = Number(recent?.total ?? 0);
  const earlierViews = Number(earlier?.total ?? 0);
  const growth = earlierViews > 0 ? Math.round(((recentViews - earlierViews) / earlierViews) * 100) : 0;

  const videos: { total_views: number; count: number } | undefined = db.prepare(
    "SELECT COALESCE(SUM(viewCount), 0) AS total_views, COUNT(*) AS count FROM channel_videos WHERE channelId = ?",
  ).get(channelId) as { total_views: number; count: number } | undefined;

  return {
    totalViews: Number(videos?.total_views ?? 0),
    videoCount: Number(videos?.count ?? 0),
    recentPeriodViews: recentViews,
    earlierPeriodViews: earlierViews,
    growthPercent: growth,
  };
}

export function insertMedia(m: MediaRow): void {
  db.prepare(
    `INSERT INTO media (id, episodeId, role, title, filename, path, mime, size, durationSec, width, height, codec, hasAudio, thumbPath, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id, m.episodeId, m.role, m.title, m.filename, m.path, m.mime, m.size,
    m.durationSec, m.width, m.height, m.codec, m.hasAudio, m.thumbPath, m.createdAt,
  );
}

export function getMedia(id: string): MediaRow | undefined {
  return db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
}

export function listMedia(): MediaRow[] {
  return db.prepare("SELECT * FROM media ORDER BY createdAt DESC").all() as unknown as MediaRow[];
}

export function updateMediaThumb(id: string, thumbPath: string): void {
  db.prepare("UPDATE media SET thumbPath = ? WHERE id = ?").run(thumbPath, id);
}

// ── assembled state (the web's InitialData + media) ─────────────────────────────

export function getState() {
  return {
    programs: listEntities("program"),
    episodes: listEntities("episode"),
    recommendations: listEntities("recommendation"),
    clips: listEntities("clip"),
    jobs: listEntities("job"),
    connections: getConnections(),
    media: listMedia().map(mediaPublic),
  };
}

/** Media shape exposed to the client (no absolute fs path; stream URL instead). */
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

# ──────────────────────────────────────────────────────────────
# STEP-D Server — Cloud SQL PostgreSQL schema
# Run once against your Cloud SQL instance to bootstrap tables.
# Usage:
#   psql "$DATABASE_URL" -f apps/server/schema.sql
# ──────────────────────────────────────────────────────────────

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
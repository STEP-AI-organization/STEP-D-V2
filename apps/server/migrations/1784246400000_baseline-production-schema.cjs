/* eslint-disable camelcase */

/**
 * BASELINE — captures the entire schema that already exists in production.
 *
 * Production was built additively by the runtime bootstraps in `src/db-pg.ts`
 * (initDb → migrate) and `src/queue.ts` (initQueue). This baseline reproduces
 * that exact end state so a fresh/empty DB (local, CI) gets the identical schema
 * via `node-pg-migrate up`.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION:
 *   - Every statement is CREATE TABLE / INDEX IF NOT EXISTS or
 *     ADD COLUMN IF NOT EXISTS. Nothing is dropped or altered in place.
 *   - Running this against the existing production DB is a pure no-op (every
 *     object already exists), which is why it is safe to mark it "already
 *     applied" there with `node-pg-migrate up --fake` (records the tracking row
 *     in pgmigrations WITHOUT executing any DDL). See docs/ops/migrations.md.
 *
 * The DDL below is kept byte-for-byte in sync with the runtime bootstraps, which
 * remain in place as a safety net (they too are all IF NOT EXISTS, so migrations
 * and the bootstrap coexist without conflict).
 *
 * Irreversible: `down` is disabled — a baseline of live production data must
 * never be auto-dropped. `node-pg-migrate down` will refuse rather than run.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── Core domain graph + media + kv (db-pg.ts migrate, block 1) ──────────────
  pgm.sql(`
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
    -- so re-fetching a window overwrites instead of duplicating.
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

    -- Per-video analytics snapshot (YouTube Analytics API, filters=video==id).
    CREATE TABLE IF NOT EXISTS video_analytics (
      videoId        TEXT PRIMARY KEY,
      channelId      TEXT NOT NULL,
      fetchedAt      BIGINT NOT NULL,
      summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
      trafficSources JSONB NOT NULL DEFAULT '[]'::jsonb,
      demographics   JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    -- Retention curve for a video: [{ratio, watchRatio, relative}] along 0->1.
    CREATE TABLE IF NOT EXISTS video_retention (
      videoId   TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      fetchedAt BIGINT NOT NULL,
      curve     JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    -- Top comment threads per video (Data API commentThreads, one page).
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

  // ── Additive columns backfilled after the tables shipped (db-pg.ts migrate) ──
  pgm.sql(`
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastSyncedAt   BIGINT;
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastAnalyzedAt BIGINT;
    ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS lastError      TEXT;
  `);

  pgm.sql(`
    ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS isShort BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS shortCheckedAt BIGINT;
  `);

  pgm.sql(`
    ALTER TABLE channel_analytics ADD COLUMN IF NOT EXISTS estimatedRevenue REAL NOT NULL DEFAULT 0;
  `);

  // ── Content pipeline results per uploaded media (db-pg.ts migrate) ──────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS content_analysis (
      mediaId    TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'pending',
      data       JSONB,
      error      TEXT,
      createdAt  BIGINT NOT NULL,
      updatedAt  BIGINT NOT NULL
    );
  `);

  // ── Job queue (queue.ts initQueue) — created at runtime, captured here too ──
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 5,
      runAfter    BIGINT NOT NULL,
      lockedAt    BIGINT,
      dedupeKey   TEXT,
      error       TEXT,
      createdAt   BIGINT NOT NULL,
      updatedAt   BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_queue_claim
      ON job_queue(status, runAfter);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe
      ON job_queue(dedupeKey)
      WHERE dedupeKey IS NOT NULL AND status IN ('pending', 'running');
  `);
};

// Baseline is irreversible on purpose — never auto-drop live production schema.
exports.down = false;

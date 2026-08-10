/**
 * Persistence — PostgreSQL (production). Replaces node:sqlite for Cloud Run + Cloud SQL.
 * Connection via DATABASE_URL env var.
 *
 * Same domain graph + media/youtube schema as the SQLite prototype.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { seed } from "./seed.ts";
import { ALL_TENANTS, DEFAULT_TENANT_ID, currentScope, runAsSystem, runWithTenant } from "./tenant.ts";

const { Pool } = pg;

export type EntityKind = "program" | "episode" | "recommendation" | "clip" | "job" | "factoryJob";

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

/**
 * 두 개의 풀 핸들이 있다.
 *   rawPool   — 테넌트 스코프가 **붙지 않는** 진짜 풀. 스키마 부트스트랩·테넌트 해석 등
 *               컨텍스트가 정해지기 전에 돌아야 하는 코드만 쓴다.
 *   pool      — 위를 감싼 프록시. 쿼리마다 커넥션에 `app.tenant_id` 를 심는다.
 *               RLS 정책(migrations/0014)이 그 값으로 행을 걸러낸다.
 *
 * 이 파일의 나머지 코드와 index.ts 는 전부 `pool` 을 쓴다 — 즉 SQL 을 한 줄도 안 고쳐도
 * 격리가 걸린다. 반대로 말하면 **rawPool 을 쓰는 순간 격리가 사라지므로** 새로 쓰지 말 것.
 */
let rawPool: pg.Pool;
let pool: pg.Pool;

export function getPool(): pg.Pool {
  return pool;
}

/** 스코프 없는 풀. 테넌트 해석·마이그레이션 전용. 일반 조회에 쓰면 격리가 깨진다. */
export function getRawPool(): pg.Pool {
  return rawPool;
}

const SET_SCOPE = "SELECT set_config('app.tenant_id', $1, false)";

/** 현재 컨텍스트의 스코프를 RLS 가 읽는 문자열로. 컨텍스트가 없으면 currentScope()가 던진다. */
function scopeValue(): string {
  const s = currentScope();
  return s === ALL_TENANTS ? "*" : s;
}

/**
 * 커넥션을 빌릴 때마다 스코프를 심는다. `SET LOCAL` 이 아니라 세션 단위 set_config 인 이유:
 * 트랜잭션을 새로 열지 않아도 되어 라운드트립이 하나 줄고, **모든 체크아웃이 예외 없이
 * 값을 덮어쓰므로** 이전 요청의 값이 남아 보일 수 있는 창이 없다.
 */
function makeScopedPool(target: pg.Pool): pg.Pool {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop === "query") {
        return async (...args: unknown[]) => {
          const scope = scopeValue();
          const client = await t.connect();
          try {
            await client.query(SET_SCOPE, [scope]);
            return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
          } finally {
            client.release();
          }
        };
      }
      if (prop === "connect") {
        return async () => {
          const scope = scopeValue();
          const client = await t.connect();
          try {
            await client.query(SET_SCOPE, [scope]);
          } catch (e) {
            client.release();
            throw e;
          }
          return client;
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/**
 * RLS 가 실제로 걸리는지 확인한다. BYPASSRLS 속성이 있는 역할(로컬 슈퍼유저 등)로 접속하면
 * 정책이 **조용히 무시된다** — 격리가 없는 채로 멀쩡히 도는 게 최악이라 기동 시 잡는다.
 * 로컬(localhost DSN)은 경고만, 그 외에는 기동을 거부한다. 의도적으로 넘기려면 ALLOW_RLS_BYPASS=1.
 */
async function assertRlsEnforced(): Promise<void> {
  const { rows } = await rawPool.query(
    "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  const bypass = rows[0]?.rolbypassrls === true || rows[0]?.rolsuper === true;
  if (!bypass) return;

  const dsn = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dsn) || dsn === "";
  const cause =
    "DB 접속 역할에 BYPASSRLS/SUPERUSER 가 있어 테넌트 격리(RLS)가 적용되지 않는다. " +
    "격리 전용 역할로 접속할 것.";
  if (process.env.ALLOW_RLS_BYPASS === "1" || isLocal) {
    console.warn(`[tenant] ⚠️  ${cause} (로컬/명시적 허용이라 경고만 하고 계속한다 — 이 상태에서는 격리가 없다)`);
    return;
  }
  throw new Error(`${cause} 격리 없이 도는 것이 가장 위험하므로 기동을 멈춘다. 의도한 상황이면 ALLOW_RLS_BYPASS=1.`);
}

export async function initDb(): Promise<void> {
  rawPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool = makeScopedPool(rawPool);

  // Test connection
  const client = await rawPool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }

  await migrate();
  await assertRlsEnforced();
  await seedIfEmpty();
}

// Runtime schema bootstrap (safety net). Its end state is captured by the
// node-pg-migrate baseline (migrations/0001_baseline.cjs). Going forward, make
// schema changes as NEW numbered migrations — do NOT add tables/columns here.
// This block stays only as a safety net; both are IF NOT EXISTS and coexist.
// See docs/ops/migrations.md.
async function migrate(): Promise<void> {
  // 스키마 부트스트랩은 테넌트 컨텍스트 밖에서 돈다 — 스코프 없는 풀을 쓴다.
  const pool = rawPool;
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
  // Meta (Facebook + Instagram) connected accounts.
  // 1 row per Facebook Page. Long-lived Page access token is non-expiring so we don't
  // track refresh — but a token can be revoked; status flips to 'disconnected' then.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_accounts (
      publicId               TEXT PRIMARY KEY,
      pageId                 TEXT NOT NULL UNIQUE,
      pageName               TEXT NOT NULL,
      pageProfilePictureUrl  TEXT,
      pageAccessToken        TEXT NOT NULL,
      igUserId               TEXT,
      igUsername             TEXT,
      igProfilePictureUrl    TEXT,
      status                 TEXT NOT NULL DEFAULT 'active',
      connectedAt            BIGINT NOT NULL
    );
  `);
  // TikTok Content Posting API. accessToken ~24h, refreshToken ~365d — worker
  // needs to refresh before upload. openId is stable per (user, app).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiktok_accounts (
      publicId          TEXT PRIMARY KEY,
      openId            TEXT NOT NULL UNIQUE,
      unionId           TEXT,
      displayName       TEXT NOT NULL,
      username          TEXT,
      avatarUrl         TEXT,
      accessToken       TEXT NOT NULL,
      refreshToken      TEXT NOT NULL,
      expiresAt         BIGINT NOT NULL,
      refreshExpiresAt  BIGINT NOT NULL,
      scope             TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'active',
      connectedAt       BIGINT NOT NULL
    );
  `);
}

/**
 * 기동 시점이라 컨텍스트가 없다. 시드는 **기본 테넌트 것**이므로 그 스코프를 명시해서 돈다
 * (스코프 없이 INSERT 하면 tenant_id DEFAULT 가 NULL 이 되어 NOT NULL 위반으로 죽는다).
 * seed.ts 는 의도적으로 전부 빈 배열이라 실제로 들어가는 건 kv 한 줄뿐이다.
 */
function seedIfEmpty(): Promise<void> {
  return runWithTenant({ scope: DEFAULT_TENANT_ID, via: "system" }, seedIfEmptyInner);
}

async function seedIfEmptyInner(): Promise<void> {
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

/**
 * Adopt a recommendation → clip as ONE atomic unit. The clip insert and the rec's
 * status flip must commit together: a crash between two separate writes would otherwise
 * leave an orphan clip with the rec still 'pending', and the client retry (guarded only by
 * status !== 'pending') would mint a SECOND clip. A transaction makes it exact.
 *
 * Returns false (writing NOTHING) when the rec is no longer 'pending' — the route's
 * check-then-act guard is not transactional, so two concurrent adopts both see 'pending';
 * this WHERE clause is what actually stops the second one from minting a duplicate clip.
 */
export async function commitAdoption(
  clipId: string,
  clip: unknown,
  recId: string,
  rec: unknown,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const flipped = await client.query(
      `UPDATE entities SET data = $2::jsonb
        WHERE kind = 'recommendation' AND id = $1
          AND COALESCE(data->>'status', 'pending') = 'pending'`,
      [recId, JSON.stringify(rec)],
    );
    if ((flipped.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows } = await client.query(
      "SELECT COALESCE(MIN(ord), 0) - 1 AS m FROM entities WHERE kind = 'clip'",
    );
    await client.query(
      `INSERT INTO entities (kind, id, data, ord) VALUES ('clip', $1, $2::jsonb, $3)
       ON CONFLICT (kind, id) DO UPDATE SET data = $2::jsonb`,
      [clipId, JSON.stringify(clip), rows[0].m],
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Flip a pending recommendation to rejected in one guarded write (no read-modify-write).
 * Returns false when the rec was already decided — rejecting an ADOPTED rec would strand
 * its clip on the board while the rec claims 'rejected'.
 */
export async function markRecommendationRejected(recId: string, reason: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE entities
        SET data = data || jsonb_build_object('status', 'rejected', 'rejectReason', $2::text)
      WHERE kind = 'recommendation' AND id = $1
        AND COALESCE(data->>'status', 'pending') = 'pending'`,
    [recId, reason],
  );
  return (rowCount ?? 0) > 0;
}

// ── connections ────────────────────────────────────────────────────────────────

export async function getConnections(): Promise<{ youtube: boolean; instagram: boolean; facebook: boolean; tiktok: boolean }> {
  const { rows } = await pool.query("SELECT value FROM kv WHERE key = $1", ["connections"]);
  const fallback = { youtube: false, instagram: false, facebook: false, tiktok: false };
  if (!rows[0]) return fallback;
  // 옛 저장분(meta/metaInstagram)은 새 스키마로 정규화. 없는 키는 false, 남는 키는 무시.
  const raw = JSON.parse(rows[0].value) as Record<string, unknown>;
  return {
    youtube:   raw.youtube === true,
    instagram: raw.instagram === true,
    facebook:  raw.facebook === true,
    tiktok:    raw.tiktok === true,
  };
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

/**
 * 스케줄러 전용 — **전 테넌트**의 살아 있는 채널을 (채널, 소유 테넌트) 쌍으로 훑는다.
 * 스윕은 테넌트를 가리지 않는 게 목적이지만, 그 결과로 만드는 잡은 **각 채널 소유자의 것**이라
 * tenantId 를 같이 돌려줘야 한다. 이걸 안 돌려주면 잡이 무소속으로 만들어져 FK 에서 죽는다.
 */
export function listChannelsForSweep(): Promise<{ channelId: string; tenantId: string; status: string }[]> {
  return runAsSystem(async () => {
    const { rows } = await pool.query(
      `SELECT channelid AS "channelId", tenant_id AS "tenantId", status FROM youtube_channels`,
    );
    return rows as { channelId: string; tenantId: string; status: string }[];
  });
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

// ── Meta (Facebook + Instagram) accounts ───────────────────────────────────────

export interface MetaAccount {
  publicId: string;
  pageId: string;
  pageName: string;
  pageProfilePictureUrl: string | null;
  pageAccessToken: string;
  igUserId: string | null;
  igUsername: string | null;
  igProfilePictureUrl: string | null;
  status: string;
  connectedAt: number;
}

const META_COLS = `publicid AS "publicId", pageid AS "pageId", pagename AS "pageName",
  pageprofilepictureurl AS "pageProfilePictureUrl", pageaccesstoken AS "pageAccessToken",
  iguserid AS "igUserId", igusername AS "igUsername", igprofilepictureurl AS "igProfilePictureUrl",
  status, connectedat AS "connectedAt"`;

export async function listMetaAccounts(): Promise<MetaAccount[]> {
  const { rows } = await pool.query(
    `SELECT ${META_COLS} FROM meta_accounts ORDER BY connectedAt DESC`,
  );
  return rows as MetaAccount[];
}

export async function getMetaAccountByPageId(pageId: string): Promise<MetaAccount | undefined> {
  const { rows } = await pool.query(
    `SELECT ${META_COLS} FROM meta_accounts WHERE pageId = $1`,
    [pageId],
  );
  return rows[0] as MetaAccount | undefined;
}

export async function upsertMetaAccount(a: MetaAccount): Promise<void> {
  await pool.query(
    `INSERT INTO meta_accounts (publicId, pageId, pageName, pageProfilePictureUrl,
       pageAccessToken, igUserId, igUsername, igProfilePictureUrl, status, connectedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (pageId) DO UPDATE SET
       pageName              = EXCLUDED.pageName,
       pageProfilePictureUrl = EXCLUDED.pageProfilePictureUrl,
       pageAccessToken       = EXCLUDED.pageAccessToken,
       igUserId              = EXCLUDED.igUserId,
       igUsername            = EXCLUDED.igUsername,
       igProfilePictureUrl   = EXCLUDED.igProfilePictureUrl,
       status                = EXCLUDED.status`,
    [a.publicId, a.pageId, a.pageName, a.pageProfilePictureUrl, a.pageAccessToken,
     a.igUserId, a.igUsername, a.igProfilePictureUrl, a.status, a.connectedAt],
  );
}

export async function deleteMetaAccount(publicId: string): Promise<void> {
  await pool.query("DELETE FROM meta_accounts WHERE publicId = $1", [publicId]);
}

// ── TikTok accounts ────────────────────────────────────────────────────────────

export interface TikTokAccount {
  publicId: string;
  openId: string;
  unionId: string | null;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  status: string;
  connectedAt: number;
}

const TIKTOK_COLS = `publicid AS "publicId", openid AS "openId", unionid AS "unionId",
  displayname AS "displayName", username, avatarurl AS "avatarUrl",
  accesstoken AS "accessToken", refreshtoken AS "refreshToken",
  expiresat AS "expiresAt", refreshexpiresat AS "refreshExpiresAt",
  scope, status, connectedat AS "connectedAt"`;

export async function listTikTokAccounts(): Promise<TikTokAccount[]> {
  const { rows } = await pool.query(
    `SELECT ${TIKTOK_COLS} FROM tiktok_accounts ORDER BY connectedAt DESC`,
  );
  return rows as TikTokAccount[];
}

export async function upsertTikTokAccount(a: TikTokAccount): Promise<void> {
  await pool.query(
    `INSERT INTO tiktok_accounts (publicId, openId, unionId, displayName, username, avatarUrl,
       accessToken, refreshToken, expiresAt, refreshExpiresAt, scope, status, connectedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (openId) DO UPDATE SET
       unionId          = EXCLUDED.unionId,
       displayName      = EXCLUDED.displayName,
       username         = EXCLUDED.username,
       avatarUrl        = EXCLUDED.avatarUrl,
       accessToken      = EXCLUDED.accessToken,
       refreshToken     = EXCLUDED.refreshToken,
       expiresAt        = EXCLUDED.expiresAt,
       refreshExpiresAt = EXCLUDED.refreshExpiresAt,
       scope            = EXCLUDED.scope,
       status           = EXCLUDED.status`,
    [a.publicId, a.openId, a.unionId, a.displayName, a.username, a.avatarUrl,
     a.accessToken, a.refreshToken, a.expiresAt, a.refreshExpiresAt, a.scope,
     a.status, a.connectedAt],
  );
}

export async function deleteTikTokAccount(publicId: string): Promise<void> {
  await pool.query("DELETE FROM tiktok_accounts WHERE publicId = $1", [publicId]);
}

/**
 * Persist a refreshed access token WITHOUT touching any other column. A full-row
 * upsert from an in-memory snapshot (captured at job start) can clobber a concurrent
 * reconnect's new refreshToken or resurrect a channel that was just marked 'revoked' —
 * so token persistence must be a targeted two-column write, not a whole-row overwrite.
 */
export async function updateYouTubeTokens(
  channelId: string,
  accessToken: string,
  expiresAt: number,
): Promise<void> {
  await pool.query(
    "UPDATE youtube_channels SET accessToken = $2, expiresAt = $3 WHERE channelId = $1",
    [channelId, accessToken, expiresAt],
  );
}

/**
 * Park a channel whose refresh token is dead — a status-only write, for the same reason
 * as updateYouTubeTokens: a full-row upsert from the caller's stale snapshot would clobber
 * a concurrent reconnect's fresh refreshToken with the dead one. When the caller knows
 * WHICH token died, pass it: the update then no-ops if a reconnect already swapped tokens,
 * so a slow in-flight request can never re-park a just-reconnected channel.
 */
/** 학습된 채널 포인트 프로파일 저장 (core/learn_profile.py 결과 → recommend 스티어링용). */
export async function setChannelPointProfile(channelId: string, profile: unknown): Promise<void> {
  await pool.query(
    `UPDATE youtube_channels SET pointProfile = $2::jsonb, pointProfileAt = $3 WHERE channelId = $1`,
    [channelId, JSON.stringify(profile), Date.now()],
  );
}

/** 채널의 학습된 프로파일 (없으면 null). recommend가 이 채널 영상 분석 시 스티어링에 쓴다. */
export async function getChannelPointProfile(channelId: string): Promise<{ profile: unknown; at: number | null } | null> {
  const { rows } = await pool.query(
    `SELECT pointprofile AS profile, pointprofileat AS at FROM youtube_channels WHERE channelId = $1`,
    [channelId],
  );
  if (!rows[0]) return null;
  return { profile: rows[0].profile ?? null, at: rows[0].at == null ? null : Number(rows[0].at) };
}

export async function markYouTubeChannelRevoked(
  channelId: string,
  deadRefreshToken?: string,
): Promise<void> {
  if (deadRefreshToken) {
    await pool.query(
      "UPDATE youtube_channels SET status = 'revoked' WHERE channelId = $1 AND refreshToken = $2",
      [channelId, deadRefreshToken],
    );
  } else {
    await pool.query(
      "UPDATE youtube_channels SET status = 'revoked' WHERE channelId = $1",
      [channelId],
    );
  }
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
  // short_source_map is deliberately NOT cleared here — a re-sync that drops and re-adds
  // the same videoIds must not destroy the operator's hand-made matching work.
}

// ── 숏폼 ↔ 롱폼 매칭 (short_source_map, migrations/0005) ────────────────────────
//
// The channel's existing shorts carry no record of which longform segment they came from,
// so an operator supplies it in the Lab. This is the input for channel point-profile
// learning: (롱폼 구간 → 발행 숏폼 → 성과).

export interface ShortSourceMap {
  shortVideoId: string;
  channelId: string;
  longVideoId: string;
  segStart: number;
  segEnd: number;
  note: string | null;
  /** 'manual' = 사람이 찍음 · 'auto' = core/align.py 오디오 정렬 추정 (미확인) */
  source: "manual" | "auto";
  /** auto일 때 정렬 신뢰도(peak ratio). 사람이 찍은 건 null. */
  confidence: number | null;
  /** 자동 추정을 사람이 확인한 시각. null이면 아직 검수 전. */
  confirmedAt: number | null;
  /** LEARN 입력 — core/segment.py가 구간을 보고 채운다 (migrations/0007). */
  segTranscript: string | null;
  segSummary: string | null;
  segEmotion: string | null;
  segHook: string | null;
  segAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const SOURCE_MAP_COLS = `shortvideoid AS "shortVideoId", channelid AS "channelId",
  longvideoid AS "longVideoId", segstart AS "segStart", segend AS "segEnd", note,
  source, confidence, confirmedat AS "confirmedAt",
  segtranscript AS "segTranscript", segsummary AS "segSummary",
  segemotion AS "segEmotion", seghook AS "segHook", segat AS "segAt",
  createdat AS "createdAt", updatedat AS "updatedAt"`;

/** Create or replace the mapping for one short (re-matching overwrites). */
export async function upsertShortSourceMap(m: {
  shortVideoId: string;
  channelId: string;
  longVideoId: string;
  segStart: number;
  segEnd: number;
  note?: string | null;
  source?: "manual" | "auto";
  confidence?: number | null;
}): Promise<ShortSourceMap> {
  const now = Date.now();
  const source = m.source ?? "manual";
  // 사람이 저장하면 그 자리에서 확인된 것으로 본다. 자동 추정은 confirmedAt을 비워 둬
  // "아직 검수 전"임이 데이터에 남게 한다.
  const confirmedAt = source === "manual" ? now : null;
  const { rows } = await pool.query(
    `INSERT INTO short_source_map
       (shortVideoId, channelId, longVideoId, segStart, segEnd, note, source, confidence, confirmedAt, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (shortVideoId) DO UPDATE SET
       channelId   = EXCLUDED.channelId,
       longVideoId = EXCLUDED.longVideoId,
       segStart    = EXCLUDED.segStart,
       segEnd      = EXCLUDED.segEnd,
       note        = EXCLUDED.note,
       source      = EXCLUDED.source,
       confidence  = EXCLUDED.confidence,
       confirmedAt = EXCLUDED.confirmedAt,
       updatedAt   = EXCLUDED.updatedAt
     RETURNING ${SOURCE_MAP_COLS}`,
    [m.shortVideoId, m.channelId, m.longVideoId, m.segStart, m.segEnd, m.note ?? null,
     source, m.confidence ?? null, confirmedAt, now],
  );
  return rows[0] as ShortSourceMap;
}

export async function listShortSourceMaps(channelId: string): Promise<ShortSourceMap[]> {
  const { rows } = await pool.query(
    `SELECT ${SOURCE_MAP_COLS} FROM short_source_map WHERE channelId = $1 ORDER BY updatedAt DESC`,
    [channelId],
  );
  return rows as ShortSourceMap[];
}

/** 아직 구간 설명이 없는 매핑 — 롱폼별로 묶어 배치 처리하기 위한 조회. */
export async function listSourceMapsMissingSegment(channelId: string): Promise<ShortSourceMap[]> {
  const { rows } = await pool.query(
    `SELECT ${SOURCE_MAP_COLS} FROM short_source_map
      WHERE channelId = $1 AND (segSummary IS NULL OR segSummary = '')
      ORDER BY longVideoId, segStart`,
    [channelId],
  );
  return rows as ShortSourceMap[];
}

/** core/segment.py 결과를 매핑에 적재. */
export async function setShortSourceSegment(
  shortVideoId: string,
  seg: { transcript?: string; scene_summary?: string; emotion?: string; hook?: string },
): Promise<void> {
  await pool.query(
    `UPDATE short_source_map
        SET segTranscript = $2, segSummary = $3, segEmotion = $4, segHook = $5,
            segAt = $6, updatedAt = $6
      WHERE shortVideoId = $1`,
    [shortVideoId, seg.transcript ?? null, seg.scene_summary ?? null,
     seg.emotion ?? null, seg.hook ?? null, Date.now()],
  );
}

export async function deleteShortSourceMap(shortVideoId: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM short_source_map WHERE shortVideoId = $1", [
    shortVideoId,
  ]);
  return (rowCount ?? 0) > 0;
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

// node-pg returns BIGINT columns (size, createdAt) as strings — coerce so numeric
// comparisons (e.g. the content-pipeline resume check) and arithmetic don't misbehave.
function coerceMediaRow(r: any): MediaRow {
  return { ...r, size: Number(r.size), createdAt: Number(r.createdAt) } as MediaRow;
}

export async function getMedia(id: string): Promise<MediaRow | undefined> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt" FROM media WHERE id = $1`, [id]);
  return rows[0] ? coerceMediaRow(rows[0]) : undefined;
}

export async function listMedia(): Promise<MediaRow[]> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt" FROM media ORDER BY createdAt DESC`);
  return rows.map(coerceMediaRow);
}

export async function updateMediaThumb(id: string, thumbPath: string): Promise<void> {
  await pool.query("UPDATE media SET thumbPath = $1 WHERE id = $2", [thumbPath, id]);
}

/**
 * Delete a media row and its per-mediaId derived stores. Does NOT touch GCS files or the
 * parent episode/program — the route orchestrates that (mirrors admin/reset ordering).
 * Individual DELETEs are guarded so a not-yet-migrated table cannot fail the whole cascade.
 */
export async function deleteMediaData(mediaId: string): Promise<void> {
  await pool.query("DELETE FROM media WHERE id = $1", [mediaId]);
  try { await pool.query("DELETE FROM content_analysis WHERE mediaId = $1", [mediaId]); } catch {}
  try { await pool.query("DELETE FROM transcript WHERE mediaId = $1", [mediaId]); } catch {}
  try { await pool.query("DELETE FROM episode_cast WHERE mediaId = $1", [mediaId]); } catch {}
  // 진행중/대기중 잡 정리 — done/failed는 이력이라 보존.
  try {
    await pool.query(
      "DELETE FROM job_queue WHERE (payload->>'mediaId') = $1 AND status IN ('pending','running','failed')",
      [mediaId],
    );
  } catch {}
}

export async function deleteEntityRow(kind: EntityKind, id: string): Promise<void> {
  await pool.query("DELETE FROM entities WHERE kind = $1 AND id = $2", [kind, id]);
}

/**
 * Delete recommendations and clips scoped to a given episode. entities.data.episodeId is
 * JSONB-scanned — cheaper than fetching all rows into Node just to filter in JS.
 */
export async function deleteEntitiesByEpisode(episodeId: string): Promise<void> {
  await pool.query(
    "DELETE FROM entities WHERE kind IN ('recommendation','clip') AND data->>'episodeId' = $1",
    [episodeId],
  );
}

/** Fill a placeholder media row (e.g. a queued YouTube import) with the real file's facts. */
export async function updateMediaSource(
  id: string,
  m: {
    path: string;
    mime: string;
    size: number;
    durationSec: number;
    width: number;
    height: number;
    codec: string;
    hasAudio: number;
    thumbPath: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE media SET path = $2, mime = $3, size = $4, durationSec = $5,
       width = $6, height = $7, codec = $8, hasAudio = $9, thumbPath = $10
     WHERE id = $1`,
    [id, m.path, m.mime, m.size, m.durationSec, m.width, m.height, m.codec, m.hasAudio, m.thumbPath],
  );
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
       status = EXCLUDED.status,
       -- A data-less write (e.g. a re-analysis that failed before any checkpoint)
       -- must NOT wipe a previously-stored good analysis. Only overwrite when we
       -- actually have new data; otherwise keep the prior blob.
       data = COALESCE(EXCLUDED.data, content_analysis.data),
       error = EXCLUDED.error, updatedAt = $5`,
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

export interface ContentAnalysisSummary {
  mediaId: string;
  status: string;
  error: string | null;
  scenes: number | null;
  shorts: number | null;
  cast: number | null;
  genre: string | null;
  stagesDone: string[] | null;
  hasData: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Per-media analysis summary for the ops dashboard — counts/status/error only, WITHOUT
 * pulling the (potentially large) transcript+scenes blob for every row. jsonb_typeof guards
 * so a null/failed/partial `data` yields null counts instead of erroring.
 */
export async function listContentAnalysisSummary(): Promise<ContentAnalysisSummary[]> {
  const { rows } = await pool.query(
    `SELECT mediaid AS "mediaId", status, error,
            createdat AS "createdAt", updatedat AS "updatedAt",
            (data IS NOT NULL) AS "hasData",
            data->>'genre' AS "genre",
            CASE WHEN jsonb_typeof(data->'stagesDone')='array' THEN data->'stagesDone' END AS "stagesDone",
            CASE WHEN jsonb_typeof(data->'scenes')='array' THEN jsonb_array_length(data->'scenes') END AS "scenes",
            CASE WHEN jsonb_typeof(data->'shorts')='array' THEN jsonb_array_length(data->'shorts') END AS "shorts",
            CASE WHEN jsonb_typeof(data->'cast'->'people')='array' THEN jsonb_array_length(data->'cast'->'people') END AS "cast"
       FROM content_analysis`,
  );
  return rows as ContentAnalysisSummary[];
}

// ── transcript (canonical STT store, shared across consumers) ────────────────────
//
// One row per media (mediaId PK). `segments` holds utterance-level segments with word
// timestamps nested inside — both levels preserved. This is the single source the
// caption/render/framing/highlight consumers read from, instead of each re-parsing the
// content_analysis blob. Created by migrations/0002_transcript-table.cjs (NOT by the
// bootstrap migrate() — new schema goes through migrations only).

/** One word token (whisper path). `probability` is the model's confidence 0–1. */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

/** One utterance-level segment. `words` is [] on the Gemini path (no word timings). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptRow {
  mediaId: string;
  language: string;
  provider: string | null;
  source: string;
  segmentCount: number;
  wordCount: number;
  hasWords: boolean;
  segments: TranscriptSegment[];
  createdAt: number;
  updatedAt: number;
}

function countWords(segments: TranscriptSegment[]): number {
  let n = 0;
  for (const s of segments) if (Array.isArray(s?.words)) n += s.words.length;
  return n;
}

/**
 * Upsert the transcript for a media. Non-destructive to callers: the `segments` are
 * stored verbatim (word tokens keep their native fields, incl. `probability`), so
 * downstream readers get the exact shape the pipeline produced. `createdAt` is set once.
 */
export async function saveTranscript(
  mediaId: string,
  t: { segments: TranscriptSegment[]; language?: string; provider?: string | null; source?: string },
): Promise<void> {
  const now = Date.now();
  const segments = Array.isArray(t.segments) ? t.segments : [];
  const wordCount = countWords(segments);
  await pool.query(
    `INSERT INTO transcript
       (mediaId, language, provider, source, segmentCount, wordCount, hasWords, segments, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)
     ON CONFLICT (mediaId) DO UPDATE SET
       language     = EXCLUDED.language,
       provider     = EXCLUDED.provider,
       source       = EXCLUDED.source,
       segmentCount = EXCLUDED.segmentCount,
       wordCount    = EXCLUDED.wordCount,
       hasWords     = EXCLUDED.hasWords,
       segments     = EXCLUDED.segments,
       updatedAt    = EXCLUDED.updatedAt`,
    [
      mediaId,
      t.language ?? "ko",
      t.provider ?? null,
      t.source ?? "refined",
      segments.length,
      wordCount,
      wordCount > 0,
      JSON.stringify(segments),
      now,
    ],
  );
}

export async function getTranscript(mediaId: string): Promise<TranscriptRow | undefined> {
  const { rows } = await pool.query(
    `SELECT mediaid AS "mediaId", language, provider, source,
            segmentcount AS "segmentCount", wordcount AS "wordCount",
            haswords AS "hasWords", segments,
            createdat AS "createdAt", updatedat AS "updatedAt"
       FROM transcript WHERE mediaId = $1`,
    [mediaId],
  );
  return rows[0] as TranscriptRow | undefined;
}

// ── cast registry + episode cast timeline ───────────────────────────────────────
//
// program_cast = the operator's roster (long-lived, hand-edited).
// episode_cast = one analysis run's "출연자 × 등장 구간" findings for one media.
// Identity evidence is the burned-in lower-third name caption (core/cast.py), never a face.
// Created by migrations/0003_cast-registry.cjs (NOT by the bootstrap migrate()).

export interface CastMember {
  castId: string;
  programId: string;
  name: string;
  aliases: string[];
  role: string;
  season: string;
  note: string;
  /** Display-only profile image URL — '' when none. Matching stays caption-based. */
  imageUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/** One appearance span, evidenced by the scenes whose name caption carried the person. */
export interface CastAppearance {
  start: number;
  end: number;
  scenes: number[];
  /** 'gemini' = a frame Gemini re-read (validated); 'ocr' = PaddleOCR-only (pre-filtered). */
  source: "gemini" | "ocr";
}

export interface EpisodeCastRow {
  mediaId: string;
  name: string;
  castId: string | null;
  status: "matched" | "candidate" | "confirmed" | "rejected";
  matchType: string;
  confidence: number;
  role: string;
  sceneCount: number;
  totalSec: number;
  evidence: string[];
  appearances: CastAppearance[];
  createdAt: number;
  updatedAt: number;
}

const CAST_COLS = `castid AS "castId", programid AS "programId", name, aliases, role, season, note,
                   imageurl AS "imageUrl", createdat AS "createdAt", updatedat AS "updatedAt"`;

export async function listProgramCast(programId: string): Promise<CastMember[]> {
  const { rows } = await pool.query(
    `SELECT ${CAST_COLS} FROM program_cast WHERE programId = $1 ORDER BY season, name`,
    [programId],
  );
  return rows as CastMember[];
}

export async function getCastMember(castId: string): Promise<CastMember | undefined> {
  const { rows } = await pool.query(`SELECT ${CAST_COLS} FROM program_cast WHERE castId = $1`, [castId]);
  return rows[0] as CastMember | undefined;
}

/** Insert or update one roster entry. `createdAt` is set once. */
export async function upsertCastMember(
  m: Omit<CastMember, "createdAt" | "updatedAt">,
): Promise<void> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO program_cast (castId, programId, name, aliases, role, season, note, imageUrl, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$9)
     ON CONFLICT (castId) DO UPDATE SET
       programId = EXCLUDED.programId, name = EXCLUDED.name, aliases = EXCLUDED.aliases,
       role = EXCLUDED.role, season = EXCLUDED.season, note = EXCLUDED.note,
       imageUrl = EXCLUDED.imageUrl, updatedAt = EXCLUDED.updatedAt`,
    [m.castId, m.programId, m.name, JSON.stringify(m.aliases ?? []), m.role ?? "", m.season ?? "", m.note ?? "", m.imageUrl ?? "", now],
  );
}

export async function deleteCastMember(castId: string): Promise<void> {
  await pool.query("DELETE FROM program_cast WHERE castId = $1", [castId]);
  // The roster entry is gone; past timelines keep their rows but lose the link, and a
  // re-analysis will re-file those people as candidates. Findings are never deleted here.
  await pool.query("UPDATE episode_cast SET castId = NULL WHERE castId = $1", [castId]);
}

/**
 * Replace one media's cast findings with a fresh analysis run's output.
 *
 * Upsert (not DELETE+INSERT) so an operator's `confirmed`/`rejected` decision SURVIVES a
 * re-analysis — the pipeline may only overwrite the machine-derived columns. This is the
 * label-loss trap the feasibility study flags for recommendations
 * (docs/archive/highlight-model-feasibility.md §6-2), avoided here from the start.
 * People no longer detected are left in place (their status is still the operator's).
 */
export async function saveEpisodeCast(
  mediaId: string,
  people: Array<Partial<EpisodeCastRow> & { name: string }>,
): Promise<number> {
  if (!Array.isArray(people) || people.length === 0) return 0;
  const now = Date.now();
  let wrote = 0;
  for (const p of people) {
    if (!p?.name) continue;
    await pool.query(
      `INSERT INTO episode_cast
         (mediaId, name, castId, status, matchType, confidence, role, sceneCount, totalSec,
          evidence, appearances, createdAt, updatedAt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$12)
       ON CONFLICT (mediaId, name) DO UPDATE SET
         matchType = EXCLUDED.matchType,
         confidence = EXCLUDED.confidence, role = EXCLUDED.role,
         sceneCount = EXCLUDED.sceneCount, totalSec = EXCLUDED.totalSec,
         evidence = EXCLUDED.evidence, appearances = EXCLUDED.appearances,
         updatedAt = EXCLUDED.updatedAt,
         -- An operator's confirm/reject outranks whatever this run decided.
         status = CASE WHEN episode_cast.status IN ('confirmed','rejected')
                       THEN episode_cast.status ELSE EXCLUDED.status END,
         -- …and so does the link they made: an operator who resolved '광수' onto a roster
         -- entry must not have it wiped by the next run, which (matching on captions alone)
         -- still sees an unknown name. Only re-link a decided row when its link is gone —
         -- i.e. the roster entry was deleted — so the pipeline can repair, never override.
         castId = CASE WHEN episode_cast.status IN ('confirmed','rejected')
                        AND episode_cast.castId IS NOT NULL
                       THEN episode_cast.castId ELSE EXCLUDED.castId END`,
      [
        mediaId, p.name, p.castId ?? null, p.status ?? "candidate", p.matchType ?? "none",
        Number(p.confidence) || 0, p.role ?? "", Number(p.sceneCount) || 0, Number(p.totalSec) || 0,
        JSON.stringify(p.evidence ?? []), JSON.stringify(p.appearances ?? []), now,
      ],
    );
    wrote++;
  }
  return wrote;
}

export async function listEpisodeCast(mediaId: string): Promise<EpisodeCastRow[]> {
  const { rows } = await pool.query(
    `SELECT mediaid AS "mediaId", name, castid AS "castId", status, matchtype AS "matchType",
            confidence, role, scenecount AS "sceneCount", totalsec AS "totalSec",
            evidence, appearances, createdat AS "createdAt", updatedat AS "updatedAt"
       FROM episode_cast WHERE mediaId = $1
       ORDER BY (status = 'confirmed') DESC, (castId IS NOT NULL) DESC, totalSec DESC`,
    [mediaId],
  );
  return rows as EpisodeCastRow[];
}

/** Operator decision on one detected person. Optionally links it to a roster entry. */
export async function setEpisodeCastStatus(
  mediaId: string,
  name: string,
  status: EpisodeCastRow["status"],
  castId?: string | null,
): Promise<EpisodeCastRow | undefined> {
  const { rows } = await pool.query(
    `UPDATE episode_cast
        SET status = $3,
            castId = COALESCE($4, castId),
            updatedAt = $5
      WHERE mediaId = $1 AND name = $2
      RETURNING mediaid AS "mediaId", name, castid AS "castId", status,
                matchtype AS "matchType", confidence, role,
                scenecount AS "sceneCount", totalsec AS "totalSec", evidence, appearances,
                createdat AS "createdAt", updatedat AS "updatedAt"`,
    [mediaId, name, status, castId ?? null, Date.now()],
  );
  return rows[0] as EpisodeCastRow | undefined;
}

// ── search segments (자연어 검색엔진 · pgvector) ────────────────────────────────
// core/index_segments.py 산출(segments.json)을 적재하고, /api/search가 조회한다.
// 필터는 컬럼(WHERE), 의미검색은 벡터(코사인), 키워드는 pg_trgm — 필터 먼저 좁히고 랭킹.

export interface SearchSegmentRow {
  segment_id: string;
  media_id: string;
  genre?: string | null;
  source_beat?: number | null;
  start: number;
  end: number;
  duration?: number | null;
  characters?: string[];
  speakers?: string[];
  scene_type?: string | null;
  hook?: string | null;
  highlight_score?: number | null;
  is_short?: boolean;
  rights?: Record<string, unknown> | null;
  scope?: { scope_type?: string | null; scope_id?: string | null; episode?: string | null; aired_at?: string | null } | null;
  dialogue?: string | null;
  chyron?: string | null;
  summary?: string | null;
  emb_dialogue?: number[] | null;
  emb_summary?: number[] | null;
}

/** pgvector 리터럴: number[] → '[0.1,0.2,...]' (없으면 null). */
function toVector(v: number[] | null | undefined): string | null {
  return v && v.length ? `[${v.join(",")}]` : null;
}

/**
 * 한 미디어의 검색 세그먼트를 통째로 교체 적재(DELETE + INSERT). 재분석 시 idempotent.
 * segments = core/index_segments.py 의 segments 배열(임베딩 포함).
 */
export async function upsertSearchSegments(mediaId: string, segments: SearchSegmentRow[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM search_segments WHERE media_id = $1", [mediaId]);
    for (const s of segments) {
      const scope = s.scope ?? {};
      await client.query(
        `INSERT INTO search_segments
           (segment_id, media_id, program_id, genre, scope_type, scope_id, episode, aired_at,
            start_sec, end_sec, duration_sec, characters, speakers, scene_type, hook,
            highlight_score, is_short, rights, dialogue, chyron, summary, emb_dialogue, emb_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,
                 $16,$17,$18::jsonb,$19,$20,$21,$22::vector,$23::vector)
         ON CONFLICT (segment_id) DO UPDATE SET
           media_id=EXCLUDED.media_id, program_id=EXCLUDED.program_id, genre=EXCLUDED.genre,
           scope_type=EXCLUDED.scope_type, scope_id=EXCLUDED.scope_id, episode=EXCLUDED.episode,
           aired_at=EXCLUDED.aired_at, start_sec=EXCLUDED.start_sec, end_sec=EXCLUDED.end_sec,
           duration_sec=EXCLUDED.duration_sec, characters=EXCLUDED.characters, speakers=EXCLUDED.speakers,
           scene_type=EXCLUDED.scene_type, hook=EXCLUDED.hook, highlight_score=EXCLUDED.highlight_score,
           is_short=EXCLUDED.is_short, rights=EXCLUDED.rights, dialogue=EXCLUDED.dialogue,
           chyron=EXCLUDED.chyron, summary=EXCLUDED.summary, emb_dialogue=EXCLUDED.emb_dialogue,
           emb_summary=EXCLUDED.emb_summary`,
        [
          s.segment_id, mediaId, (s as { program_id?: string }).program_id ?? null, s.genre ?? null,
          scope.scope_type ?? null, scope.scope_id ?? null, scope.episode ?? null, scope.aired_at ?? null,
          s.start, s.end, s.duration ?? (s.end - s.start),
          JSON.stringify(s.characters ?? []), JSON.stringify(s.speakers ?? []),
          s.scene_type ?? null, s.hook ?? null, s.highlight_score ?? null, s.is_short ?? false,
          JSON.stringify(s.rights ?? {}), s.dialogue ?? null, s.chyron ?? null, s.summary ?? null,
          toVector(s.emb_dialogue), toVector(s.emb_summary),
        ],
      );
    }
    await client.query("COMMIT");
    return segments.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface SearchQuery {
  queryText?: string;          // 키워드 축 (trgm) — 원문
  queryVec?: number[] | null;  // 의미 축 (코사인) — 임베딩된 쿼리
  // 메타데이터 필터
  programId?: string;
  genre?: string;
  scopeType?: string;
  scopeId?: string;
  episode?: string;
  airedFrom?: string;          // YYYY-MM-DD
  airedTo?: string;
  characters?: string[];       // 전부 포함(AND)
  sceneType?: string;
  isShort?: boolean;
  // 권리
  allowSpoiler?: boolean;      // 기본 false → 스포일러 제외
  topK?: number;
}

export interface SearchHit {
  segmentId: string;
  mediaId: string;
  start: number;
  end: number;
  duration: number | null;
  characters: string[];
  sceneType: string | null;
  isShort: boolean;
  highlightScore: number | null;
  summary: string | null;
  dialogue: string | null;
  rights: Record<string, unknown>;
  score: number;
  lex: number;
  vec: number;
}

/**
 * 메타데이터 필터 → 하이브리드 랭킹(trgm 키워드 + 벡터 코사인, 가중합) → 권리·스포일러 필터.
 * queryVec 없으면 키워드 축만으로 랭킹(임베딩 미가용 폴백).
 */
export async function searchSegments(q: SearchQuery): Promise<SearchHit[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (q.programId) where.push(`program_id = ${p(q.programId)}`);
  if (q.genre) where.push(`genre = ${p(q.genre)}`);
  if (q.scopeType) where.push(`scope_type = ${p(q.scopeType)}`);
  if (q.scopeId) where.push(`scope_id = ${p(q.scopeId)}`);
  if (q.episode) where.push(`episode = ${p(q.episode)}`);
  if (q.airedFrom) where.push(`aired_at >= ${p(q.airedFrom)}`);
  if (q.airedTo) where.push(`aired_at <= ${p(q.airedTo)}`);
  if (q.sceneType) where.push(`scene_type = ${p(q.sceneType)}`);
  if (typeof q.isShort === "boolean") where.push(`is_short = ${p(q.isShort)}`);
  if (q.characters && q.characters.length) {
    where.push(`characters @> ${p(JSON.stringify(q.characters))}::jsonb`);
  }
  // 권리·스포일러: 스포일러 기본 제외 · 출연자 사용불가 제외 (NULL=미확인은 통과)
  if (!q.allowSpoiler) where.push(`(rights->>'spoiler') IS DISTINCT FROM 'true'`);
  where.push(`(rights->>'cast_ok') IS DISTINCT FROM 'false'`);

  const vec = toVector(q.queryVec);
  const lexExpr = q.queryText ? `similarity(search_text, ${p(q.queryText)})` : `0`;
  const vecExpr = vec
    ? `GREATEST(1 - (emb_dialogue <=> ${p(vec)}::vector), 1 - (emb_summary <=> ${p(vec)}::vector))`
    : `0`;
  // 가중합 하이브리드. 둘 다 0..1 스케일이라 단순 합이 성립.
  const scoreExpr = `(0.5 * ${lexExpr} + 0.5 * ${vecExpr})`;
  const topK = Math.max(1, Math.min(q.topK ?? 20, 100));

  const sql = `
    SELECT segment_id, media_id, start_sec, end_sec, duration_sec, characters,
           scene_type, is_short, highlight_score, summary, dialogue, rights,
           ${lexExpr} AS lex, ${vecExpr} AS vec, ${scoreExpr} AS score
      FROM search_segments
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY score DESC, highlight_score DESC NULLS LAST
     LIMIT ${topK}`;

  const { rows } = await pool.query(sql, params);
  return rows.map((r: Record<string, unknown>): SearchHit => ({
    segmentId: r.segment_id as string,
    mediaId: r.media_id as string,
    start: Number(r.start_sec),
    end: Number(r.end_sec),
    duration: r.duration_sec == null ? null : Number(r.duration_sec),
    characters: (r.characters as string[]) ?? [],
    sceneType: (r.scene_type as string) ?? null,
    isShort: Boolean(r.is_short),
    highlightScore: r.highlight_score == null ? null : Number(r.highlight_score),
    summary: (r.summary as string) ?? null,
    dialogue: (r.dialogue as string) ?? null,
    rights: (r.rights as Record<string, unknown>) ?? {},
    score: Number(r.score),
    lex: Number(r.lex),
    vec: Number(r.vec),
  }));
}

/**
 * 인덱싱된 세그먼트에서 등장 인물 이름 사전을 뽑는다 (쿼리 파서 roster). programId 주면
 * 그 프로그램으로 한정 — "영철"을 (스코프, 역할명)으로 좁히는 데 쓴다.
 */
export async function listKnownCharacters(programId?: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT jsonb_array_elements_text(characters) AS name
       FROM search_segments
      WHERE ($1::text IS NULL OR program_id = $1)
      LIMIT 500`,
    [programId ?? null],
  );
  return rows.map((r: { name: string }) => r.name).filter(Boolean);
}

// ── 검색 로그 (search_events · core/search_log.py §8 스키마) ────────────────────
// 검색·클릭·반출·경계조정 4종. 특히 boundary_adjust(AI 제안 경계 → 사람이 옮긴 경계)가
// 컷 지점 학습의 지도 신호다. **기록 실패가 본 기능을 절대 막으면 안 된다** — 호출부는
// 전부 void 로 fire-and-forget 하고, 여기서 삼킨다.

export type SearchEventKind = "search" | "click" | "export" | "boundary_adjust";

export interface SearchEvent {
  event: SearchEventKind;
  queryId?: string | null;
  source?: "search" | "editor";
  userId?: string;
  role?: string;
  // search
  query?: string;
  parsed?: unknown;
  candidates?: unknown;
  resultCount?: number;
  // click / export / boundary_adjust
  segmentId?: string | null;
  mediaId?: string | null;
  clipId?: string | null;
  rank?: number | null;
  start?: number | null;
  end?: number | null;
  // boundary_adjust
  before?: { start?: number | null; end?: number | null } | null;
  after?: { start?: number | null; end?: number | null } | null;
}

/** UUID hex — core/search_log.py:new_query_id 와 같은 형태(하이픈 없는 32자). */
export function newQueryId(): string {
  return randomUUID().replace(/-/g, "");
}

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number((b - a).toFixed(3));
}

/**
 * 이벤트 1건 기록. 실패는 삼킨다(로그만) — 로그 테이블 하나 때문에 검색·저장이 죽으면
 * 얻는 것보다 잃는 게 크다. 마이그레이션 미적용 환경에서도 그냥 조용히 지나간다.
 */
export async function logSearchEvent(ev: SearchEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO search_events
         (event, query_id, source, user_id, role, query, parsed, candidates, result_count,
          segment_id, media_id, clip_id, rank, start_sec, end_sec,
          before_start, before_end, after_start, after_end, delta_start, delta_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        ev.event, ev.queryId ?? null, ev.source ?? null, ev.userId ?? "", ev.role ?? "",
        ev.query ?? null,
        ev.parsed === undefined ? null : JSON.stringify(ev.parsed),
        ev.candidates === undefined ? null : JSON.stringify(ev.candidates),
        ev.resultCount ?? null,
        ev.segmentId ?? null, ev.mediaId ?? null, ev.clipId ?? null, ev.rank ?? null,
        ev.start ?? null, ev.end ?? null,
        ev.before?.start ?? null, ev.before?.end ?? null,
        ev.after?.start ?? null, ev.after?.end ?? null,
        delta(ev.before?.start, ev.after?.start), delta(ev.before?.end, ev.after?.end),
      ],
    );
  } catch (e) {
    console.warn(`[search-log] ${ev.event} 기록 실패(무시): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 로그 열람 — 평가·학습 추출용. event 미지정 시 전체. */
export async function listSearchEvents(opts: { event?: SearchEventKind; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const { rows } = await pool.query(
    `SELECT * FROM search_events
      WHERE ($1::text IS NULL OR event = $1)
      ORDER BY ts DESC
      LIMIT ${limit}`,
    [opts.event ?? null],
  );
  return rows;
}

// ── 게이트: 권리·심의 이슈 · 판정 · 감사 로그 (migrations/0012, FLOWS F3) ────────
//
// 게이트 **상태는 저장하지 않는다.** 진실은 아래 행들이고 판정은 gate.ts 가 매번 계산한다.
// 캐시 필드를 두면 그걸 덮어써서 통과시킬 수 있고, 그 순간 "어떤 경로로도"가 깨진다.

export type GateSubjectType = "episode" | "recommendation" | "clip";

export interface RightsIssueRow {
  id: string;
  subjectType: GateSubjectType;
  subjectId: string;
  kind: string;
  resolution: string;
  bandStart: number | null;
  bandEnd: number | null;
  note: string;
  actor: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  inheritedFrom: string | null;
}

const ISSUE_COLS = `id, subject_type AS "subjectType", subject_id AS "subjectId", kind,
  resolution, band_start AS "bandStart", band_end AS "bandEnd", note, actor,
  created_at AS "createdAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
  resolution_note AS "resolutionNote", inherited_from AS "inheritedFrom"`;

export async function listRightsIssues(
  subjectType: GateSubjectType,
  subjectId: string,
): Promise<RightsIssueRow[]> {
  const { rows } = await pool.query<RightsIssueRow>(
    `SELECT ${ISSUE_COLS} FROM rights_issue
      WHERE subject_type = $1 AND subject_id = $2 ORDER BY created_at`,
    [subjectType, subjectId],
  );
  return rows;
}

/** 여러 대상의 이슈를 한 번에 — 미디어 목록이 N+1 로 돌지 않게. */
export async function listRightsIssuesFor(
  subjectType: GateSubjectType,
  subjectIds: string[],
): Promise<Map<string, RightsIssueRow[]>> {
  const out = new Map<string, RightsIssueRow[]>();
  if (subjectIds.length === 0) return out;
  const { rows } = await pool.query<RightsIssueRow>(
    `SELECT ${ISSUE_COLS} FROM rights_issue
      WHERE subject_type = $1 AND subject_id = ANY($2::text[]) ORDER BY created_at`,
    [subjectType, subjectIds],
  );
  for (const r of rows) {
    const list = out.get(r.subjectId);
    if (list) list.push(r);
    else out.set(r.subjectId, [r]);
  }
  return out;
}

export async function getRightsIssue(id: string): Promise<RightsIssueRow | null> {
  const { rows } = await pool.query<RightsIssueRow>(
    `SELECT ${ISSUE_COLS} FROM rights_issue WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertRightsIssue(row: {
  id: string;
  subjectType: GateSubjectType;
  subjectId: string;
  kind: string;
  resolution: string;
  bandStart?: number | null;
  bandEnd?: number | null;
  note?: string;
  actor: string;
  inheritedFrom?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO rights_issue
       (id, subject_type, subject_id, kind, resolution, band_start, band_end, note, actor, inherited_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.id, row.subjectType, row.subjectId, row.kind, row.resolution,
      row.bandStart ?? null, row.bandEnd ?? null, row.note ?? "", row.actor,
      row.inheritedFrom ?? null,
    ],
  );
}

/** 해제/재개 — 이전 상태를 돌려준다(감사 로그의 from_state 로 쓰인다). */
export async function updateRightsIssueResolution(
  id: string,
  next: { resolution: string; actor: string; resolutionNote: string },
): Promise<string | null> {
  // 이전 값은 CTE 로 먼저 붙잡는다. RETURNING 안에서 같은 테이블을 다시 읽는 방식은
  // 스냅샷 규칙에 기대는 미묘한 코드라, 감사 로그의 from_state 를 거기에 맡기지 않는다.
  const { rows } = await pool.query<{ prev: string | null }>(
    `WITH prev AS (SELECT resolution FROM rights_issue WHERE id = $1)
     UPDATE rights_issue
        SET resolution = $2,
            resolution_note = $4,
            resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
            resolved_by = CASE WHEN $2 = 'resolved' THEN $3 ELSE NULL END
      WHERE id = $1
      RETURNING (SELECT resolution FROM prev) AS prev`,
    [id, next.resolution, next.actor, next.resolutionNote],
  );
  return rows[0]?.prev ?? null;
}

export async function deleteRightsIssue(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM rights_issue WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** "이슈 없음"이라는 명시적 판정 (F2 Invariant — 미판정과 구분). */
export async function putRightsJudgement(
  subjectType: GateSubjectType,
  subjectId: string,
  actor: string,
  note = "",
): Promise<void> {
  await pool.query(
    `INSERT INTO rights_judgement (subject_type, subject_id, actor, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (subject_type, subject_id)
       DO UPDATE SET actor = $3, note = $4, judged_at = now()`,
    [subjectType, subjectId, actor, note],
  );
}

export async function isJudged(subjectType: GateSubjectType, subjectId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM rights_judgement WHERE subject_type = $1 AND subject_id = $2`,
    [subjectType, subjectId],
  );
  return rows.length > 0;
}

export async function judgedSet(
  subjectType: GateSubjectType,
  subjectIds: string[],
): Promise<Set<string>> {
  if (subjectIds.length === 0) return new Set();
  const { rows } = await pool.query<{ subject_id: string }>(
    `SELECT subject_id FROM rights_judgement
      WHERE subject_type = $1 AND subject_id = ANY($2::text[])`,
    [subjectType, subjectIds],
  );
  return new Set(rows.map((r) => r.subject_id));
}

/**
 * 감사 로그 — 누가·언제·무엇을 근거로 (FLOWS.md:74).
 *
 * ⚠️ 실패를 삼키지 않는다. 다른 로그(search_events)는 실패해도 무시하지만, 감사 로그가
 * 조용히 빠지면 "기록에 없으니 안 한 일"이 되어 버린다. 기록이 안 되면 그 작업도 실패시킨다.
 */
export async function appendGateAudit(ev: {
  subjectType: GateSubjectType;
  subjectId: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  actor: string;
  basis?: string;
  issueId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO gate_audit
       (subject_type, subject_id, action, from_state, to_state, actor, basis, issue_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ev.subjectType, ev.subjectId, ev.action, ev.fromState ?? null, ev.toState ?? null,
      ev.actor, ev.basis ?? "", ev.issueId ?? null,
    ],
  );
}

export async function listGateAudit(
  subjectType: GateSubjectType,
  subjectId: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT * FROM gate_audit WHERE subject_type = $1 AND subject_id = $2
      ORDER BY at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [subjectType, subjectId],
  );
  return rows;
}

// ── 채널별 업로드 규칙 (migrations/0015 · FLOWS F4-2) ───────────────────────────

export interface ChannelRuleRow {
  platform: string;
  accountId: string;
  label: string;
  role: string;
  maxSec: number | null;
  aspect: string;
  titlePrefix: string;
  hashtagTemplate: string;
  tonePreset: string;
  privacy: string;
  scheduleWindow: string;
  enabled: boolean;
}

const RULE_COLS = `platform, account_id AS "accountId", label, role, max_sec AS "maxSec",
  aspect, title_prefix AS "titlePrefix", hashtag_template AS "hashtagTemplate",
  tone_preset AS "tonePreset", privacy, schedule_window AS "scheduleWindow", enabled`;

export async function listChannelRules(): Promise<ChannelRuleRow[]> {
  const { rows } = await pool.query<ChannelRuleRow>(
    `SELECT ${RULE_COLS} FROM channel_rule ORDER BY platform, label, account_id`,
  );
  return rows;
}

export async function getChannelRule(platform: string, accountId: string): Promise<ChannelRuleRow | null> {
  const { rows } = await pool.query<ChannelRuleRow>(
    `SELECT ${RULE_COLS} FROM channel_rule WHERE platform = $1 AND account_id = $2`,
    [platform, accountId],
  );
  return rows[0] ?? null;
}

export async function upsertChannelRule(r: ChannelRuleRow): Promise<void> {
  await pool.query(
    `INSERT INTO channel_rule
       (platform, account_id, label, role, max_sec, aspect, title_prefix, hashtag_template,
        tone_preset, privacy, schedule_window, enabled, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (platform, account_id) DO UPDATE SET
       label = $3, role = $4, max_sec = $5, aspect = $6, title_prefix = $7,
       hashtag_template = $8, tone_preset = $9, privacy = $10, schedule_window = $11,
       enabled = $12, updated_at = now()`,
    [
      r.platform, r.accountId, r.label, r.role, r.maxSec, r.aspect, r.titlePrefix,
      r.hashtagTemplate, r.tonePreset, r.privacy, r.scheduleWindow, r.enabled,
    ],
  );
}

export async function deleteChannelRule(platform: string, accountId: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM channel_rule WHERE platform = $1 AND account_id = $2`, [platform, accountId]);
  return (r.rowCount ?? 0) > 0;
}

// ── 에셋: 폴더 · 파일 (migrations/0016 · FLOWS F8) ──────────────────────────────

export interface AssetFolderRow { path: string; parent: string; name: string; createdAt: string }
export interface AssetFileRow {
  id: string; folder: string; name: string; kind: string;
  mime: string; size: number; storagePath: string; createdAt: string;
}

export async function listAssetFolders(): Promise<AssetFolderRow[]> {
  const { rows } = await pool.query<AssetFolderRow>(
    `SELECT path, parent, name, created_at AS "createdAt" FROM asset_folder ORDER BY path`,
  );
  return rows;
}

export async function insertAssetFolder(path: string, parent: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO asset_folder (path, parent, name) VALUES ($1,$2,$3) ON CONFLICT (path) DO NOTHING`,
    [path, parent, name],
  );
}

export async function assetFolderExists(path: string): Promise<boolean> {
  if (path === "/") return true; // 루트는 행이 없어도 늘 존재한다
  const { rows } = await pool.query(`SELECT 1 FROM asset_folder WHERE path = $1`, [path]);
  return rows.length > 0;
}

/** 폴더와 그 하위 전부. 삭제·이동이 트리 단위로 일어나기 때문에 필요하다. */
export async function listAssetSubtree(path: string): Promise<{ folders: string[]; files: AssetFileRow[] }> {
  const like = path === "/" ? "/%" : `${path}/%`;
  const { rows: f } = await pool.query<{ path: string }>(
    `SELECT path FROM asset_folder WHERE path = $1 OR path LIKE $2 ORDER BY path`,
    [path, like],
  );
  const { rows: files } = await pool.query<AssetFileRow>(
    `SELECT id, folder, name, kind, mime, size::bigint AS size, storage_path AS "storagePath",
            created_at AS "createdAt"
       FROM asset_file WHERE folder = $1 OR folder LIKE $2`,
    [path, like],
  );
  return { folders: f.map((r) => r.path), files };
}

export async function moveAssetFolder(from: string, to: string): Promise<void> {
  const name = from.slice(from.lastIndexOf("/") + 1);
  const newPath = to === "/" ? `/${name}` : `${to}/${name}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 하위 경로를 통째로 갈아 끼운다. 한 트랜잭션이어야 트리가 반쯤 끊긴 상태가 안 생긴다.
    await client.query(
      `UPDATE asset_folder
          SET path = $3 || substring(path from length($1) + 1),
              parent = CASE WHEN path = $1 THEN $2 ELSE $3 || substring(parent from length($1) + 1) END
        WHERE path = $1 OR path LIKE $1 || '/%'`,
      [from, to, newPath],
    );
    await client.query(
      `UPDATE asset_file SET folder = $2 || substring(folder from length($1) + 1)
        WHERE folder = $1 OR folder LIKE $1 || '/%'`,
      [from, newPath],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteAssetFolderTree(path: string): Promise<void> {
  await pool.query(`DELETE FROM asset_folder WHERE path = $1 OR path LIKE $1 || '/%'`, [path]);
}

export async function listAssetFiles(folder: string): Promise<AssetFileRow[]> {
  const { rows } = await pool.query<AssetFileRow>(
    `SELECT id, folder, name, kind, mime, size::bigint AS size, storage_path AS "storagePath",
            created_at AS "createdAt"
       FROM asset_file WHERE folder = $1 ORDER BY created_at DESC`,
    [folder],
  );
  return rows;
}

export async function getAssetFile(id: string): Promise<AssetFileRow | null> {
  const { rows } = await pool.query<AssetFileRow>(
    `SELECT id, folder, name, kind, mime, size::bigint AS size, storage_path AS "storagePath",
            created_at AS "createdAt"
       FROM asset_file WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertAssetFile(r: Omit<AssetFileRow, "createdAt">): Promise<void> {
  await pool.query(
    `INSERT INTO asset_file (id, folder, name, kind, mime, size, storage_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [r.id, r.folder, r.name, r.kind, r.mime, r.size, r.storagePath],
  );
}

export async function moveAssetFiles(ids: string[], folder: string): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await pool.query(`UPDATE asset_file SET folder = $2 WHERE id = ANY($1::text[])`, [ids, folder]);
  return r.rowCount ?? 0;
}

export async function deleteAssetFiles(ids: string[]): Promise<AssetFileRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<AssetFileRow>(
    `DELETE FROM asset_file WHERE id = ANY($1::text[])
     RETURNING id, folder, name, kind, mime, size::bigint AS size,
               storage_path AS "storagePath", created_at AS "createdAt"`,
    [ids],
  );
  return rows;
}

// ── cleanup ────────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  await pool.end();
}

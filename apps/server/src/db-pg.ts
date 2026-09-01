/**
 * Persistence — PostgreSQL (production). Replaces node:sqlite for Cloud Run + Cloud SQL.
 * Connection via DATABASE_URL env var.
 *
 * Same domain graph + media/youtube schema as the SQLite prototype.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { seed } from "./seed.ts";
import { ALL_TENANTS, DEFAULT_TENANT_ID, currentScope, runAsSystem, runWithTenant } from "./auth/tenant.ts";
import { installKstTimestampParser } from "./kst.ts";
// 자동 충전 알림의 **모양·사유 목록·유효기간은 credits.ts(순수)가 정본**이다 — 여기선 저장만 한다.
import { AUTO_TOPUP_CODES, liveAutoTopupAlert, type AutoTopupAlert } from "./billing/credits.ts";

const { Pool } = pg;

// 시각은 **서버가 KST 로 내보낸다.** Cloud Run 이 UTC 라, 이걸 안 하면 TIMESTAMPTZ 가
// `...Z` 로 나가고 화면이 그걸 잘라 쓰면서 9시간 밀린다(실측 2026-08-27 · kst.ts 참고).
// 표시 지점마다 고치는 대신 여기 한 번으로 끝낸다 — 저장은 그대로라 기록은 안 바뀐다.
installKstTimestampParser(pg.types);

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
  /** 프레임 정합 메타(0046) — 초↔프레임 환산·Premiere 대조용. 안 잰 옛 행은 0/"". */
  fps: number;
  startTimecode: string;
  audioStreams: number;
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

/**
 * API 키 조회 — **테넌트 컨텍스트를 정하는 단계**다. 지금 이 요청이 누구 것인지를 정하는
 * 중이라 아직 스코프가 없고, 조회 조건이 곧 열쇠(sha256)라 스코프 없이도 남의 것이 안 나온다.
 *
 * ⚠️ **그래도 `rawPool` 을 쓰면 안 된다.** `api_keys` 는 RLS 대상이라(0023),
 * `app.tenant_id` 가 안 세워진 연결에서는 정책이 NULL 로 평가돼 **한 행도 안 나온다** —
 * 조용히 "모든 키가 무효"가 된다. auth.ts 가 rawPool 을 쓸 수 있는 건 users/sessions 가
 * RLS 대상이 **아니기** 때문이지 "컨텍스트 이전이라서"가 아니다. 그래서 여기는
 * 시스템 스코프('*')로 명시해서 읽는다 — queue.ts 의 claimJob 과 같은 이유·같은 방식.
 */
export async function lookupApiKey(keyHash: string): Promise<{
  id: string; tenantId: string; scopes: string[];
  revokedAt: Date | null; lastUsedAt: Date | null; tenantStatus: string | null;
} | null> {
  return runAsSystem(async () => {
    const { rows } = await pool.query(
      `SELECT k.id, k.tenant_id AS "tenantId", k.scopes, k.revoked_at AS "revokedAt",
              k.last_used_at AS "lastUsedAt", t.status AS "tenantStatus"
         FROM api_keys k LEFT JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = $1`,
      [keyHash],
    );
    return rows[0] ?? null;
  });
}

/** 마지막 사용 시각. 안 쓰는 키를 회수할 근거가 된다 — 실패해도 요청을 막지 않는다. */
export async function touchApiKey(id: string): Promise<void> {
  await runAsSystem(() =>
    pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]),
  ).catch(() => {});
}

/**
 * 어드민(superadmin)이 **남의 회사** RLS 표를 읽고 쓸 때 쓰는 통로.
 * 시스템 스코프('*')는 정책이 명시적으로 허용하는 값이다 — 우회가 아니라 정문이다.
 * `getRawPool()` 로 대신하면 RLS 표에서 0행이 나와 **조용히 빈 화면**이 된다.
 */
export function asSystem<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return runAsSystem(() => fn(pool));
}

/**
 * 최소한의 질의 인터페이스. Pool 과 PoolClient 가 둘 다 만족하므로, 같은 함수를
 * "풀에서 알아서" 와 "이 트랜잭션 안에서" 두 방식으로 쓸 수 있다.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * 스코프 없는 트랜잭션. **여러 테넌트에 걸친 쓰기**(회사 개설 = tenants + invites +
 * credit_ledger)에 쓴다 — 그런 쓰기는 애초에 한 테넌트 컨텍스트 안에서 표현할 수 없다.
 *
 * 콜백이 던지면 ROLLBACK 한다. 회사 개설이 중간에 깨져서 **아무도 못 들어가는 회사**가
 * 남는 걸 막는 게 이 함수의 존재 이유다.
 */
export async function withRawTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await rawPool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ⚠️ 세 번째 인자가 `false` = **세션 레벨**이라 이 값은 커넥션이 풀로 반환된 뒤에도 남는다.
 * 그리고 `makeScopedPool` 은 rawPool 을 감싼 프록시라 **두 풀이 커넥션을 공유한다.**
 *
 * 그래서 `getRawPool()` 로 RLS 표를 만지면 결과가 결정적이지 않다 — 새 커넥션이면 0행,
 * 앞서 스코프 쿼리가 썼던 커넥션이면 **그때 남은 스코프**로 읽힌다. 실제로 포트원 웹훅이
 * 그 덕에 "우연히" 동작하고 있었다(2026-08-11 발견).
 *
 * 규칙은 하나다: **RLS 표는 절대 rawPool 로 만지지 않는다.** 전 회사를 가로질러야 하면
 * `asSystem()` 을 쓴다. rls-access.test.ts 가 이걸 소스에서 검사한다.
 */
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
      createdAt   BIGINT NOT NULL,
      -- 프레임 정합 메타 (0046) — Premiere 플러그인이 추천 구간을 1프레임 오차로 꽂으려면
      -- fps·시작 타임코드가 필요하고, 오디오 트랙 수는 정규화 전후 대조에 쓴다.
      fps            REAL NOT NULL DEFAULT 0,
      start_timecode TEXT NOT NULL DEFAULT '',
      audio_streams  INTEGER NOT NULL DEFAULT 0
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
  // Instagram (API with Instagram Login) — Facebook Page 를 거치지 않는 직접 연결.
  // long-lived 토큰 ~60일, 갱신 토큰이 따로 없고 **같은 토큰을 refresh** 한다
  // (24시간 지난 뒤 ~ 만료 전에만 가능). 만료를 넘기면 재연결뿐이다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instagram_accounts (
      publicId           TEXT PRIMARY KEY,
      igUserId           TEXT NOT NULL UNIQUE,
      username           TEXT NOT NULL,
      name               TEXT,
      profilePictureUrl  TEXT,
      accessToken        TEXT NOT NULL,
      expiresAt          BIGINT NOT NULL,
      permissions        TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'active',
      connectedAt        BIGINT NOT NULL
    );
  `);

  // 메타데이터 수정 로그 — **AI 원본 → 사용자 최종** 을 저장 시점마다 한 줄씩 남긴다(덮어쓰기 X).
  // 워크스페이스별 취향 학습 데이터(사용자 2026-08-21: "나중에 학습할 때 필요한 데이터").
  // tenant_id 는 tenant 컨텍스트에서 DEFAULT 로 자동 채움(다른 런타임 테이블과 같은 패턴).
  // RLS 정책은 두지 않는다(content_analysis 와 같은 결) — 조회는 ops 가 runAsSystem 으로,
  // 기록은 tenant 컨텍스트의 INSERT 라 tenant_id 가 자동으로 붙는다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_edit_log (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   TEXT DEFAULT current_setting('app.tenant_id', true),
      clip_id     TEXT NOT NULL,
      program_id  TEXT,
      genre       TEXT,
      channel     TEXT NOT NULL,
      field       TEXT NOT NULL,
      ai_original TEXT,
      user_final  TEXT,
      was_ai      BOOLEAN NOT NULL DEFAULT TRUE,
      editor      TEXT,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_edit_log_tenant ON metadata_edit_log (tenant_id, created_at DESC);
  `);

  // 리프레임 라벨 — 비교 뷰어에서 사람이 "이 장면은 이 레이아웃" 을 1클릭으로 남긴 정답
  // (reframe-compare-viewer-plan §5 · append 전용 · 덮어쓰기 X). context JSONB 에 그 순간의
  // 후보 4종 점수·게이트·기계 확정을 통째로 조인해 두므로, 나중에 가중치를 조정할 때
  // "사람이 무엇을 보고 골랐나" 를 재현할 수 있다. RLS 없음 — metadata_edit_log 와 같은 결
  // (기록은 tenant 컨텍스트 INSERT 로 tenant_id 자동, 조회는 명시 필터).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reframe_labels (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   TEXT DEFAULT current_setting('app.tenant_id', true),
      clip_id     TEXT NOT NULL,
      compare_id  TEXT NOT NULL,
      beat_id     TEXT,
      seg_start   DOUBLE PRECISION,
      seg_end     DOUBLE PRECISION,
      at_sec      DOUBLE PRECISION,
      chosen      TEXT NOT NULL,
      machine     TEXT,
      agree       BOOLEAN,
      context     JSONB,
      note        TEXT,
      editor      TEXT,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reframe_labels_tenant ON reframe_labels (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reframe_labels_clip ON reframe_labels (clip_id, compare_id);
  `);

  // 연동 계정 4종의 유일성은 **테넌트 포함**이어야 한다.
  //
  // 전역 UNIQUE 로 두면 워크스페이스 A 가 이미 연결한 채널을 B 가 연결할 때, B 에게는 RLS 로
  // 보이지도 않는 행과 충돌해 OAuth 를 다 끝낸 뒤에 실패한다(0039 가 프로덕션에서 고친 것).
  // 여기는 그 짝이다 — 마이그레이션 없이 도는 환경(로컬 dev·새 DB)에서도 같은 모양이어야
  // `ON CONFLICT (tenant_id, …)` 가 성립한다. 두 정의가 갈라지면 한쪽 환경만 조용히 깨진다.
  for (const [table, col] of [
    ["youtube_channels", "channelId"], ["meta_accounts", "pageId"],
    ["tiktok_accounts", "openId"], ["instagram_accounts", "igUserId"],
  ] as const) {
    await pool.query(`
      DO $$
      DECLARE c RECORD;
      BEGIN
        EXECUTE 'ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id TEXT';
        EXECUTE 'ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
        FOR c IN
          SELECT con.conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
           WHERE rel.relname = '${table}' AND con.contype = 'u'
             AND pg_get_constraintdef(con.oid) = 'UNIQUE (${col.toLowerCase()})'
        LOOP
          EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END LOOP;
        -- 이미 (tenant_id, col) 유일 제약이 있으면(프로덕션은 0039 가 만들어 뒀다) 그대로 둔다.
        -- 이름으로 찾으면 같은 제약을 하나 더 만들게 된다 — 정의로 확인한다.
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
           WHERE rel.relname = '${table}' AND con.contype = 'u'
             AND pg_get_constraintdef(con.oid) = 'UNIQUE (tenant_id, ${col.toLowerCase()})'
        ) THEN
          EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_key UNIQUE (tenant_id, ${col})';
        END IF;
      END $$;
    `).catch((e) => {
      // 프로덕션은 0039 가 이미 같은 모양을 만들어 뒀다(제약 이름만 다르다) — 여기서
      // 실패해도 부팅을 막지 않는다. 다만 조용히 넘기지는 않는다.
      console.warn(`[db] ${table} 테넌트 유일성 정리 건너뜀:`, e instanceof Error ? e.message : e);
    });
  }
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

  // ⚠️ DO UPDATE 금지 — 시드가 **기존 connections 를 덮으면 안 되고**, RLS 하에서 스코프가
  // 비어 보이는 연결(GEBD VM 실측 2026-08-25 · 42501 크래시루프 11일)에서는 보이지 않는
  // 기존 행에 UPDATE 를 시도하다 with-check 위반으로 기동 자체가 죽는다. 시드는 "없을 때만".
  await pool.query(
    `INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    ["connections", JSON.stringify(seed.connections)],
  );
}

// ── 메타데이터 수정 로그 (AI 원본 → 사용자 최종 · 워크스페이스별 학습 데이터) ──────

export type MetadataEditRow = {
  clipId: string;
  programId?: string | null;
  genre?: string | null;
  channel: string;
  /** 'title' | 'description' | 'tags' */
  field: string;
  aiOriginal: string;
  userFinal: string;
  /** ai_original 이 AI 가 뽑은 값 그대로였나(그 채널이 이전에 수정 안 됨). false 면 직전 사용자 값. */
  wasAi: boolean;
  editor?: string | null;
  createdAt: number;
};

/** 수정 페어를 append 한다. tenant_id 는 DEFAULT 로 자동 — **호출부가 tenant 컨텍스트여야** 한다. */
export async function recordMetadataEdits(rows: MetadataEditRow[]): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO metadata_edit_log
         (clip_id, program_id, genre, channel, field, ai_original, user_final, was_ai, editor, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.clipId, r.programId ?? null, r.genre ?? null, r.channel, r.field,
       r.aiOriginal, r.userFinal, r.wasAi, r.editor ?? null, r.createdAt],
    );
  }
}

/**
 * 학습용 조회 — ops 가 `runAsSystem` 으로 전 워크스페이스를 읽거나 tenant 로 필터. 최신순.
 * 이 테이블엔 RLS 정책이 없어(content_analysis 와 같은 결) 스코프와 무관하게 전 행을 읽는다 —
 * 그래서 조회 라우트는 **ops 인가 뒤**에만 두고, 워크스페이스 필터는 여기서 명시적으로 건다.
 */
export async function listMetadataEdits(opts: { tenantId?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 50000);
  const params: unknown[] = [];
  let where = "";
  if (opts.tenantId) { params.push(opts.tenantId); where = "WHERE tenant_id = $1"; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, tenant_id, clip_id, program_id, genre, channel, field,
            ai_original, user_final, was_ai, editor, created_at
       FROM metadata_edit_log ${where}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// ── 리프레임 라벨 (비교 뷰어의 사람 정답 · reframe-compare-viewer-plan §5) ─────────

export type ReframeLabelRow = {
  clipId: string;
  compareId: string;
  beatId?: string | null;
  segStart?: number | null;
  segEnd?: number | null;
  /** 라벨을 찍은 순간의 프리뷰 시각(소스 절대초) — 구간 안 어느 장면을 보고 골랐는지. */
  atSec?: number | null;
  /** 사람이 고른 레이아웃 (9:16-letterbox 등 4종 — 라우트가 화이트리스트 검증). */
  chosen: string;
  /** 그 구간의 기계 확정 레이아웃 — 일치율(§5 채택 조건) 계산 축. */
  machine?: string | null;
  /** 그 순간의 후보 4종 점수·게이트·사유 스냅샷 — 가중치 조정 근거 재현용. */
  context?: unknown;
  note?: string | null;
  editor?: string | null;
  createdAt: number;
};

/** 라벨 append. tenant_id 는 DEFAULT 로 자동 — **호출부가 tenant 컨텍스트여야** 한다. */
export async function recordReframeLabel(r: ReframeLabelRow): Promise<void> {
  await pool.query(
    `INSERT INTO reframe_labels
       (clip_id, compare_id, beat_id, seg_start, seg_end, at_sec, chosen, machine, agree, context, note, editor, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
    [r.clipId, r.compareId, r.beatId ?? null, r.segStart ?? null, r.segEnd ?? null,
     r.atSec ?? null, r.chosen, r.machine ?? null,
     r.machine ? r.chosen === r.machine : null,
     r.context == null ? null : JSON.stringify(r.context), r.note ?? null, r.editor ?? null, r.createdAt],
  );
}

/**
 * 라벨 조회 — RLS 없는 테이블이라 필터를 여기서 명시적으로 건다(listMetadataEdits 와 같은 결).
 * 뷰어는 clipId+compareId+tenantId 로, superadmin 내보내기는 runAsSystem + tenant 선택 필터로.
 */
export async function listReframeLabels(
  opts: { clipId?: string; compareId?: string; tenantId?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 50000);
  const params: unknown[] = [];
  const conds: string[] = [];
  if (opts.clipId) { params.push(opts.clipId); conds.push(`clip_id = $${params.length}`); }
  if (opts.compareId) { params.push(opts.compareId); conds.push(`compare_id = $${params.length}`); }
  if (opts.tenantId) { params.push(opts.tenantId); conds.push(`tenant_id = $${params.length}`); }
  params.push(limit);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT id, tenant_id, clip_id, compare_id, beat_id, seg_start, seg_end, at_sec,
            chosen, machine, agree, context, note, editor, created_at
       FROM reframe_labels ${where}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// ── entity helpers ─────────────────────────────────────────────────────────────

/**
 * 종류별 엔티티 목록.
 *
 * `limit` 을 주면 **가장 최근 n 개**만 가져온다(정렬은 그대로 오름차순으로 돌려준다).
 * 무한히 쌓이는 종류(job)를 `/api/state` 가 통째로 실어 보내면 응답이 시간이 갈수록
 * 커지기만 한다 — 2026-08-31 에 그 응답이 11 MB 였고, 그걸 8초마다 부르던 폴링이
 * Vercel 청구서를 태웠다. 크기가 시간에 비례해 자라는 응답은 언젠가 반드시 문제가 된다.
 */
export async function listEntities<T = unknown>(kind: EntityKind, limit?: number): Promise<T[]> {
  if (limit && limit > 0) {
    const { rows } = await pool.query(
      "SELECT data FROM (SELECT data, ord FROM entities WHERE kind = $1 ORDER BY ord DESC LIMIT $2) t ORDER BY ord ASC",
      [kind, limit],
    );
    return rows.map((r) => r.data as T);
  }
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

/**
 * 이관 기간 이중 쓰기 — entities 에 쓰면 정규 테이블에도 반영한다.
 *
 * 호출부가 124곳이고 index.ts 만 60곳인데 그 파일은 지금 재작성 중이다. 거기를 동시에
 * 고치면 충돌이 확정이라, 저장 계층 한 곳에서 미러링한다. 라우트는 나중에 파일 단위로
 * 옮기면 되고, 다 옮긴 뒤 이 배선과 entities 를 함께 지운다.
 * (domain.ts 의 mirrorEntity 참고. 순환 import 를 피하려 동적 import 를 쓴다.)
 */
async function mirrorToDomain(kind: EntityKind, id: string, data: unknown): Promise<void> {
  if (kind !== "program" && kind !== "episode" && kind !== "clip" && kind !== "recommendation") return;
  const { mirrorEntity } = await import("./auth/domain.ts");
  await mirrorEntity(kind, id, data);
}

export async function putEntity(kind: EntityKind, id: string, data: unknown, ord = 0): Promise<void> {
  await pool.query(
    `INSERT INTO entities (kind, id, data, ord) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (kind, id) DO UPDATE SET data = $3::jsonb`,
    [kind, id, JSON.stringify(data), ord],
  );
  await mirrorToDomain(kind, id, data);
}

/**
 * Merge editor-owned top-level fields without replacing the whole clip JSON. A reframe
 * worker may finish while the editor request is in flight; a normal putEntity would then
 * overwrite the worker's plan with the request's old snapshot. The stale transition is
 * evaluated against the row that is locked by this UPDATE, so neither side can win with an
 * out-of-date read.
 */
export async function patchClipEditorAtomic(
  clipId: string,
  patch: Record<string, unknown>,
  nextReframeFingerprint: string,
): Promise<Record<string, unknown> | undefined> {
  const now = Date.now();
  const { rows } = await pool.query(
    `UPDATE entities
        SET data = CASE
          WHEN data->'reframe'->>'mode' = 'ai_multi'
           AND COALESCE(data->'reframe'->>'inputFingerprint', '') <> $3
          THEN (data || $2::jsonb) || jsonb_build_object(
            'reframe',
            jsonb_set(
              jsonb_set(
                jsonb_set(COALESCE(data->'reframe', '{}'::jsonb), '{status}', to_jsonb('stale'::text), true),
                '{revision}', to_jsonb($4::bigint), true
              ),
              '{updatedAt}', to_jsonb($4::bigint), true
            )
          )
          ELSE data || $2::jsonb
        END
      WHERE kind = 'clip' AND id = $1
      RETURNING data`,
    [clipId, JSON.stringify(patch), nextReframeFingerprint, now],
  );
  const data = rows[0]?.data as Record<string, unknown> | undefined;
  if (data) await mirrorToDomain("clip", clipId, data);
  return data;
}

/** Replace only clip.reframe, preserving editor and render fields changed concurrently. */
export async function setClipReframe(
  clipId: string,
  reframe: unknown,
  aspectRatio?: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    `UPDATE entities
        SET data = jsonb_set(data, '{reframe}', $2::jsonb, true)
          || CASE WHEN $3::text IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('aspectRatio', $3::text) END
      WHERE kind = 'clip' AND id = $1
      RETURNING data`,
    [clipId, JSON.stringify(reframe), aspectRatio ?? null],
  );
  const data = rows[0]?.data as Record<string, unknown> | undefined;
  // A basic-mode transition may restore aspectRatio as well as reframe state. That field is
  // part of the normalized Clip domain row, so mirror only that infrequent classification
  // change; planner lifecycle updates remain JSONB-only and cannot race editor saves.
  if (data && aspectRatio != null) await mirrorToDomain("clip", clipId, data);
  return data;
}

/**
 * Atomically claims one planner request. Concurrent POSTs for the same input reuse the
 * first queued/running/ready request. A failed request is only replaceable when retry=true.
 */
export async function tryQueueClipReframe(
  clipId: string,
  inputFingerprint: string,
  reframe: unknown,
  retry: boolean,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    `UPDATE entities
        SET data = jsonb_set(data, '{reframe}', $3::jsonb, true)
      WHERE kind = 'clip' AND id = $1
        AND NOT (
          data->'reframe'->>'mode' = 'ai_multi'
          AND data->'reframe'->>'inputFingerprint' = $2
          AND data->'reframe'->>'status' IN ('queued', 'running', 'ready')
        )
        AND (
          $4::boolean
          OR NOT (
            data->'reframe'->>'mode' = 'ai_multi'
            AND data->'reframe'->>'inputFingerprint' = $2
            AND data->'reframe'->>'status' = 'failed'
          )
        )
      RETURNING data`,
    [clipId, inputFingerprint, JSON.stringify(reframe), retry],
  );
  const data = rows[0]?.data as Record<string, unknown> | undefined;
  return data;
}

/** CAS used by the worker so a result from a superseded/basic request can never land. */
export async function compareAndSetClipReframe(
  clipId: string,
  inputFingerprint: string,
  requestId: string,
  reframe: unknown,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    `UPDATE entities
        SET data = jsonb_set(data, '{reframe}', $4::jsonb, true)
      WHERE kind = 'clip' AND id = $1
        AND data->'reframe'->>'mode' = 'ai_multi'
        AND data->'reframe'->>'inputFingerprint' = $2
        AND data->'reframe'->>'requestId' = $3
        AND data->'reframe'->>'status' IN ('queued', 'running')
      RETURNING data`,
    [clipId, inputFingerprint, requestId, JSON.stringify(reframe)],
  );
  const data = rows[0]?.data as Record<string, unknown> | undefined;
  return data;
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
/**
 * 스윕 대상 채널. **due 판정에 필요한 시각까지 같이 읽는다** — 예전엔 status 만 읽어서
 * 스윕이 신선도를 볼 방법이 없었고, 그래서 15분마다 전 채널을 무조건 큐잉했다
 * (실측 2026-08-31: channel.analyze 누적 23,121건 중 대부분이 헛돌이).
 * 같은 쿼리에 컬럼만 더한 것이라 비용은 그대로다.
 */
export function listChannelsForSweep(): Promise<
  { channelId: string; tenantId: string; status: string; lastSyncedAt: number | null; lastAnalyzedAt: number | null }[]
> {
  return runAsSystem(async () => {
    const { rows } = await pool.query(
      `SELECT channelid AS "channelId", tenant_id AS "tenantId", status,
              lastsyncedat AS "lastSyncedAt", lastanalyzedat AS "lastAnalyzedAt"
         FROM youtube_channels`,
    );
    return rows as { channelId: string; tenantId: string; status: string; lastSyncedAt: number | null; lastAnalyzedAt: number | null }[];
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
     -- 충돌 대상은 **테넌트 포함**(0039) — 전역으로 두면 다른 워크스페이스가 이미 연결한
     -- 채널과 부딪혀, 보이지도 않는 행 때문에 연결이 실패한다.
     ON CONFLICT (tenant_id, channelId) DO UPDATE SET
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

/**
 * 연동해제 — 토큰만 비우고 **행은 남긴다** (삭제와 다른 개념).
 * 애널리틱스 이력·영상 매핑이 채널 행에 걸려 있어, "그만 쓸래"가 곧 "이력 삭제"면
 * 재연동 때 처음부터 다시 동기화해야 한다. 배포 가능 판정은 refreshToken 유무를 보므로
 * 토큰이 비면 자동으로 배포 대상에서 빠진다 (factory validateTargets · targets 라우트).
 */
export async function disconnectYouTubeChannel(channelId: string): Promise<void> {
  // ⚠️ refreshtoken 컬럼이 NOT NULL 이라 NULL 은 제약 위반으로 500 난다 (2026-08-12 실측).
  // 빈 문자열이면 배포 가능 판정(!refreshToken)이 동일하게 falsy 로 걸린다.
  await pool.query(
    `UPDATE youtube_channels
        SET refreshToken = '', accessToken = '', status = 'disconnected'
      WHERE channelId = $1`,
    [channelId],
  );
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
     -- 충돌 대상은 테넌트 포함(0039).
     ON CONFLICT (tenant_id, pageId) DO UPDATE SET
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

/** 연동해제 — 토큰을 비우고 행은 남긴다 (youtube 쪽 disconnect 와 같은 의미). */
export async function disconnectMetaAccount(publicId: string): Promise<void> {
  await pool.query(
    `UPDATE meta_accounts SET pageAccessToken = '', status = 'disconnected' WHERE publicId = $1`,
    [publicId],
  );
}

// ── 네이버 계정 (B2B 다계정) ───────────────────────────────────────────────────
//
// **자격증명을 담지 않는다.** 로그인 세션(쿠키)은 워커 PC 로컬 파일에만 있고, 여기는
// "누구 것이고, 어느 세션 키를 쓰고, 살아있나" 만 안다. accountKey 는 불투명 키다 —
// 네이버 아이디를 경로·로그·DB 에 박지 않는다.

export interface NaverAccount {
  id: string;
  tenantId: string;
  label: string;
  accountKey: string;
  target: "clip" | "tv" | "both";
  status: "active" | "session_expired" | "disabled";
  lastLoginAt: number | null;
  lastPublishAt: number | null;
  /** 서버에 세션이 올라온 시각. **값 자체(session_blob)는 여기 절대 싣지 않는다** — 있다/없다만. */
  sessionUpdatedAt: number | null;
  createdAt: number;
}

// ⚠️ session_blob 은 이 목록에 넣지 않는다. 한 번 SELECT 에 들어가면 로그·응답·에러 덤프
//    어디로든 새어나간다 — 세션 쿠키는 그 계정의 전체 권한이다.
const NAVER_ACCOUNT_COLS = `id, tenant_id AS "tenantId", label, account_key AS "accountKey",
  target, status, last_login_at AS "lastLoginAt", last_publish_at AS "lastPublishAt",
  session_updated_at AS "sessionUpdatedAt", created_at AS "createdAt"`;

export async function listNaverAccounts(): Promise<NaverAccount[]> {
  const { rows } = await pool.query(
    `SELECT ${NAVER_ACCOUNT_COLS} FROM naver_account ORDER BY created_at DESC`);
  return rows as NaverAccount[];
}

/**
 * 계정 하나. **RLS 가 걸려 있어 다른 테넌트 것은 애초에 안 보인다** — 그래도 호출부는
 * 클립의 테넌트와 대조해야 한다(워커는 시스템 스코프로 도는 구간이 있다).
 */
export async function getNaverAccount(id: string): Promise<NaverAccount | undefined> {
  const { rows } = await pool.query(
    `SELECT ${NAVER_ACCOUNT_COLS} FROM naver_account WHERE id = $1`, [id]);
  return rows[0] as NaverAccount | undefined;
}

// sessionUpdatedAt 은 받지 않는다 — 세션은 setNaverSessionBlob 으로만 들어온다.
// (여기서 같이 쓰게 두면 "세션 없이 세션 시각만 있는" 행이 만들어질 수 있다.)
export async function upsertNaverAccount(
  a: Omit<NaverAccount, "tenantId" | "sessionUpdatedAt">,
): Promise<void> {
  await pool.query(
    `INSERT INTO naver_account (id, label, account_key, target, status,
       last_login_at, last_publish_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label, target = EXCLUDED.target, status = EXCLUDED.status,
       last_login_at = EXCLUDED.last_login_at, last_publish_at = EXCLUDED.last_publish_at`,
    [a.id, a.label, a.accountKey, a.target, a.status,
     a.lastLoginAt, a.lastPublishAt, a.createdAt]);
}

/** 암호화된 세션을 저장한다. blob 은 절대 로그·응답에 싣지 않는다. */
export async function setNaverSessionBlob(id: string, blob: string): Promise<void> {
  await pool.query(
    `UPDATE naver_account SET session_blob = $2, session_updated_at = $3, status = 'active'
      WHERE id = $1`, [id, blob, Date.now()]);
}

/** 워커가 세션을 받아갈 때만 쓴다. */
export async function getNaverSessionBlob(id: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT session_blob FROM naver_account WHERE id = $1`, [id]);
  return (rows[0]?.session_blob as string | undefined) ?? null;
}

export async function clearNaverSessionBlob(id: string): Promise<void> {
  await pool.query(
    `UPDATE naver_account SET session_blob = NULL, session_updated_at = NULL,
       status = 'session_expired' WHERE id = $1`, [id]);
}

export async function markNaverAccount(
  id: string,
  patch: {
    status?: NaverAccount["status"]; lastPublishAt?: number; lastLoginAt?: number;
    label?: string; target?: NaverAccount["target"];
  },
): Promise<void> {
  await pool.query(
    `UPDATE naver_account SET
       status          = COALESCE($2, status),
       last_publish_at = COALESCE($3, last_publish_at),
       last_login_at   = COALESCE($4, last_login_at),
       label           = COALESCE($5, label),
       target          = COALESCE($6, target)
     WHERE id = $1`,
    [id, patch.status ?? null, patch.lastPublishAt ?? null, patch.lastLoginAt ?? null,
     patch.label ?? null, patch.target ?? null]);
}

/**
 * 계정 삭제. 세션도 같이 사라진다(같은 행이다).
 * accountKey 로 만든 **워커 PC 로컬 세션 파일은 남는다** — 그건 그 머신에서 지워야 한다.
 */
export async function deleteNaverAccount(id: string): Promise<void> {
  await pool.query(`DELETE FROM naver_account WHERE id = $1`, [id]);
}

// ── 네이버 자격증명 (자동 재로그인용) ───────────────────────────────────────────
//
// ⚠️ cred_blob 은 NAVER_ACCOUNT_COLS 에 **없다.** 세션보다 위험한 값이라(비번은 다른 서비스
//    에서도 통하고 로그아웃으로 무효화도 안 된다) 전용 함수로만 꺼낸다. 0046 참고.

export type NaverCredStatus = "pending" | "verified" | "failed";

/** 봉인된 자격증명을 저장하고 **검증 대기**로 표시한다. 검증은 워커(naver.login)가 한다. */
export async function setNaverCredential(id: string, blob: string): Promise<void> {
  await pool.query(
    `UPDATE naver_account
        SET cred_blob = $2, cred_status = 'pending', cred_updated_at = $3, cred_error = NULL
      WHERE id = $1`,
    [id, blob, Date.now()]);
}

export async function getNaverCredentialBlob(id: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT cred_blob FROM naver_account WHERE id = $1`, [id]);
  return (rows[0]?.cred_blob as string | undefined) ?? null;
}

/**
 * 검증 결과 반영. **실패하면 blob 을 지운다** — 틀린 비번을 들고 반복 시도하면 계정이 잠긴다
 * (세션 만료보다 훨씬 나쁜 상태다). 추가 인증(challenge)은 비번이 맞을 수 있으므로 남긴다.
 */
export async function markNaverCredential(
  id: string,
  status: NaverCredStatus,
  error?: string | null,
  opts: { clear?: boolean } = {},
): Promise<void> {
  await pool.query(
    `UPDATE naver_account
        SET cred_status = $2,
            cred_error  = $3,
            cred_blob   = CASE WHEN $4 THEN NULL ELSE cred_blob END,
            relogin_at  = CASE WHEN $2 = 'verified' THEN $5 ELSE relogin_at END
      WHERE id = $1`,
    [id, status, error ?? null, !!opts.clear, Date.now()]);
}

export async function clearNaverCredential(id: string): Promise<void> {
  await pool.query(
    `UPDATE naver_account SET cred_blob = NULL, cred_status = NULL,
       cred_updated_at = NULL, cred_error = NULL WHERE id = $1`, [id]);
}

/** 자격증명 상태만 — 값은 절대 안 나간다. 화면이 "저장됨/검증됨/실패"를 보여줄 재료. */
export async function getNaverCredentialState(id: string): Promise<{
  hasCred: boolean; status: NaverCredStatus | null; updatedAt: number | null;
  error: string | null; reloginAt: number | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT (cred_blob IS NOT NULL) AS "hasCred", cred_status AS "status",
            cred_updated_at AS "updatedAt", cred_error AS "error", relogin_at AS "reloginAt"
       FROM naver_account WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ── 커머스(쿠팡파트너스) 계정 ───────────────────────────────────────────────────
//
// **회사마다 자기 법인 계정이다.** 커미션 정산이 계정 단위라, 한 계정에 subId 로 가르면
// 돈이 우리 계정으로 들어와 지급대행이 된다. 그래서 계정 자체를 테넌트별로 둔다.
// 스키마·RLS: migrations/0045_commerce-account.cjs

export interface CommerceAccount {
  id: string;
  tenantId: string;
  provider: string;
  label: string;
  status: "active" | "session_expired" | "disabled";
  /** 세션이 올라온 시각. **값(session_blob)은 절대 싣지 않는다** — 있다/없다만. */
  sessionUpdatedAt: number | null;
  lastIssuedAt: number | null;
  createdAt: number;
}

// ⚠️ session_blob 을 이 목록에 넣지 말 것. 한 번 SELECT 에 들어가면 로그·응답·에러 덤프
//    어디로든 새어나간다 — 세션 쿠키는 그 계정의 전체 권한이다(주입만으로 로그인된다).
const COMMERCE_ACCOUNT_COLS = `id, tenant_id AS "tenantId", provider, label, status,
  session_updated_at AS "sessionUpdatedAt", last_issued_at AS "lastIssuedAt",
  created_at AS "createdAt"`;

export async function listCommerceAccounts(): Promise<CommerceAccount[]> {
  const { rows } = await pool.query(
    `SELECT ${COMMERCE_ACCOUNT_COLS} FROM commerce_account ORDER BY created_at DESC`);
  return rows as CommerceAccount[];
}

/**
 * **이 워크스페이스의 계정.** 잡이 `tenantId` 로 자기 계정을 찾는 유일한 통로다.
 * RLS 가 걸려 있어 남의 회사 행은 애초에 안 나온다 — 그게 오귀속 방어의 1층이다.
 */
export async function getCommerceAccount(provider = "coupang"): Promise<CommerceAccount | undefined> {
  const { rows } = await pool.query(
    `SELECT ${COMMERCE_ACCOUNT_COLS} FROM commerce_account WHERE provider = $1`, [provider]);
  return rows[0] as CommerceAccount | undefined;
}

export async function upsertCommerceAccount(
  a: Pick<CommerceAccount, "id" | "provider" | "label" | "status" | "createdAt">,
): Promise<void> {
  // sessionUpdatedAt 은 받지 않는다 — 세션은 setCommerceSessionBlob 으로만 들어온다.
  // (같이 쓰게 두면 "세션 없이 세션 시각만 있는" 행이 만들어진다.)
  await pool.query(
    `INSERT INTO commerce_account (id, provider, label, status, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       label = EXCLUDED.label, status = EXCLUDED.status`,
    [a.id, a.provider, a.label, a.status, a.createdAt]);
}

/** 봉인된 세션을 저장한다. blob 은 절대 로그·응답에 싣지 않는다. */
export async function setCommerceSessionBlob(id: string, blob: string): Promise<void> {
  await pool.query(
    `UPDATE commerce_account SET session_blob = $2, session_updated_at = $3, status = 'active'
       WHERE id = $1`, [id, blob, Date.now()]);
}

export async function getCommerceSessionBlob(id: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT session_blob FROM commerce_account WHERE id = $1`, [id]);
  return (rows[0]?.session_blob as string | undefined) ?? null;
}

/** 세션이 죽었다 — 사람이 다시 로그인해야 한다. 잡은 조용히 건너뛴다. */
export async function markCommerceSessionExpired(id: string): Promise<void> {
  await pool.query(
    `UPDATE commerce_account SET session_blob = NULL, session_updated_at = NULL,
       status = 'session_expired' WHERE id = $1`, [id]);
}

export async function markCommerceIssued(id: string): Promise<void> {
  await pool.query(
    `UPDATE commerce_account SET last_issued_at = $2 WHERE id = $1`, [id, Date.now()]);
}

export async function deleteCommerceAccount(id: string): Promise<void> {
  await pool.query(`DELETE FROM commerce_account WHERE id = $1`, [id]);
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
     -- 충돌 대상은 테넌트 포함(0039).
     ON CONFLICT (tenant_id, openId) DO UPDATE SET
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

/** 연동해제 — 토큰을 비우고 행은 남긴다 (youtube 쪽 disconnect 와 같은 의미). */
export async function disconnectTikTokAccount(publicId: string): Promise<void> {
  await pool.query(
    `UPDATE tiktok_accounts
        SET accessToken = '', refreshToken = '', status = 'disconnected'
      WHERE publicId = $1`,
    [publicId],
  );
}

/** 워커가 배포 페이로드의 openId 로 계정을 찾는 경로 — openId 는 (user, app) 에 안정적이다. */
export async function getTikTokAccountByOpenId(openId: string): Promise<TikTokAccount | null> {
  const { rows } = await pool.query(
    `SELECT ${TIKTOK_COLS} FROM tiktok_accounts WHERE openId = $1`, [openId],
  );
  return (rows[0] as TikTokAccount) ?? null;
}

/**
 * refresh 결과 저장 — updateYouTubeTokens(B6)와 같은 이유로 targeted 컬럼 write 만 한다.
 * 잡 시작 시점 스냅샷으로 전체 행을 upsert 하면 동시 재연결의 새 토큰을 밟는다.
 * TikTok 은 refresh 응답이 **새 refresh_token 을 줄 수 있다**(회전) — 안 쓰면 다음
 * 갱신부터 죽은 토큰으로 부딪히므로 네 컬럼을 함께 쓴다.
 */
export async function updateTikTokTokens(
  openId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  refreshExpiresAt: number,
): Promise<void> {
  await pool.query(
    `UPDATE tiktok_accounts
        SET accessToken = $2, refreshToken = $3, expiresAt = $4, refreshExpiresAt = $5
      WHERE openId = $1`,
    [openId, accessToken, refreshToken, expiresAt, refreshExpiresAt],
  );
}

/**
 * 죽은 refresh 토큰 계정 파킹 — markYouTubeChannelRevoked 와 같은 status-only write.
 * 죽은 토큰을 알면 함께 넘겨라: 재연결이 이미 토큰을 갈아끼웠으면 no-op 이 되어,
 * 느린 요청이 방금 재연결된 계정을 다시 파킹하는 일이 없다.
 */
export async function markTikTokAccountDisconnected(
  openId: string,
  deadRefreshToken?: string,
): Promise<void> {
  if (deadRefreshToken) {
    await pool.query(
      "UPDATE tiktok_accounts SET status = 'disconnected' WHERE openId = $1 AND refreshToken = $2",
      [openId, deadRefreshToken],
    );
  } else {
    await pool.query(
      "UPDATE tiktok_accounts SET status = 'disconnected' WHERE openId = $1",
      [openId],
    );
  }
}

// ── Instagram accounts (Instagram 비즈니스 로그인 — Facebook Page 경유 아님) ────

export interface InstagramAccount {
  publicId: string;
  igUserId: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  accessToken: string;
  expiresAt: number;
  permissions: string;
  status: string;
  connectedAt: number;
}

const INSTAGRAM_COLS = `publicid AS "publicId", iguserid AS "igUserId", username,
  name, profilepictureurl AS "profilePictureUrl", accesstoken AS "accessToken",
  expiresat AS "expiresAt", permissions, status, connectedat AS "connectedAt"`;

export async function listInstagramAccounts(): Promise<InstagramAccount[]> {
  const { rows } = await pool.query(
    `SELECT ${INSTAGRAM_COLS} FROM instagram_accounts ORDER BY connectedAt DESC`,
  );
  return rows as InstagramAccount[];
}

export async function upsertInstagramAccount(a: InstagramAccount): Promise<void> {
  await pool.query(
    `INSERT INTO instagram_accounts (publicId, igUserId, username, name, profilePictureUrl,
       accessToken, expiresAt, permissions, status, connectedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     -- 충돌 대상은 테넌트 포함(0039).
     ON CONFLICT (tenant_id, igUserId) DO UPDATE SET
       username          = EXCLUDED.username,
       name              = EXCLUDED.name,
       profilePictureUrl = EXCLUDED.profilePictureUrl,
       accessToken       = EXCLUDED.accessToken,
       expiresAt         = EXCLUDED.expiresAt,
       permissions       = EXCLUDED.permissions,
       status            = EXCLUDED.status`,
    [a.publicId, a.igUserId, a.username, a.name, a.profilePictureUrl,
     a.accessToken, a.expiresAt, a.permissions, a.status, a.connectedAt],
  );
}

export async function deleteInstagramAccount(publicId: string): Promise<void> {
  await pool.query("DELETE FROM instagram_accounts WHERE publicId = $1", [publicId]);
}

/**
 * 만료된 토큰의 계정을 '재연결 필요' 로 파킹한다 — igUserId 기준(워커가 아는 식별자).
 * 토큰이 죽었는데 status 가 active 로 남으면 화면은 정상으로 보이고 배포만 매번 실패한다.
 */
export async function parkInstagramAccountExpired(igUserId: string): Promise<void> {
  await pool.query(
    `UPDATE instagram_accounts SET status = 'disconnected' WHERE igUserId = $1`,
    [igUserId],
  );
}

/** 연동해제 — 토큰을 비우고 행은 남긴다 (youtube 쪽 disconnect 와 같은 의미). */
export async function disconnectInstagramAccount(publicId: string): Promise<void> {
  await pool.query(
    `UPDATE instagram_accounts SET accessToken = '', status = 'disconnected' WHERE publicId = $1`,
    [publicId],
  );
}

/**
 * ig_refresh_token 결과 저장 — updateYouTubeTokens 와 같은 이유로 토큰·만료 두 컬럼만 쓴다
 * (전체 행 upsert 는 동시 재연결의 새 토큰을 밟을 수 있다).
 */
export async function updateInstagramToken(
  igUserId: string,
  accessToken: string,
  expiresAt: number,
): Promise<void> {
  await pool.query(
    "UPDATE instagram_accounts SET accessToken = $2, expiresAt = $3 WHERE igUserId = $1",
    [igUserId, accessToken, expiresAt],
  );
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
  // fps 는 REAL 이라 드라이버가 문자열로 줄 수 있고, 0046 이전 행은 컬럼 자체가 없다.
  // 화면·플러그인이 계산에 바로 쓰므로 여기서 숫자로 고정한다.
  return {
    ...r,
    size: Number(r.size),
    createdAt: Number(r.createdAt),
    fps: Number(r.fps ?? 0) || 0,
    startTimecode: String(r.startTimecode ?? ""),
    audioStreams: Number(r.audioStreams ?? 0) || 0,
  } as MediaRow;
}

export async function getMedia(id: string): Promise<MediaRow | undefined> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt", fps, start_timecode AS "startTimecode", audio_streams AS "audioStreams" FROM media WHERE id = $1`, [id]);
  return rows[0] ? coerceMediaRow(rows[0]) : undefined;
}

export async function listMedia(): Promise<MediaRow[]> {
  const { rows } = await pool.query(`SELECT id, episodeid AS "episodeId", role, title, filename, path, mime, size, durationsec AS "durationSec", width, height, codec, hasaudio AS "hasAudio", thumbpath AS "thumbPath", createdat AS "createdAt", fps, start_timecode AS "startTimecode", audio_streams AS "audioStreams" FROM media ORDER BY createdAt DESC`);
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
  // 영상 DB(검색 인덱스)도 같이 — 안 지우면 삭제된 회차가 영상검색에 유령으로 남는다.
  try { await pool.query("DELETE FROM search_segments WHERE media_id = $1", [mediaId]); } catch {}
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
    /** 프레임 정합 메타(0046) — 미지정이면 기존 값을 유지하지 않고 0/"" 로 덮는다. */
    fps?: number;
    startTimecode?: string;
    audioStreams?: number;
  },
): Promise<void> {
  await pool.query(
    `UPDATE media SET path = $2, mime = $3, size = $4, durationSec = $5,
       width = $6, height = $7, codec = $8, hasAudio = $9, thumbPath = $10,
       fps = $11, start_timecode = $12, audio_streams = $13
     WHERE id = $1`,
    [id, m.path, m.mime, m.size, m.durationSec, m.width, m.height, m.codec, m.hasAudio, m.thumbPath,
     m.fps ?? 0, m.startTimecode ?? "", m.audioStreams ?? 0],
  );
}

/**
 * 러닝타임만 채운다 — **targeted write**(다른 컬럼을 안 건드린다).
 *
 * `updateMediaSource` 는 path·mime·size… 전부를 요구해서 "길이만 알아냈다" 는 상황에 못 쓴다.
 * 그런데 durationSec=0 에 갇힌 미디어가 실제로 생긴다: handleMediaPrepare 가 바이트를 운영
 * 버킷으로 옮긴(promoteUpload) 뒤 probe 에서 죽으면 updateMediaSource 까지 못 가기 때문이다.
 * 그 상태는 자가치유되지 않고(재시도해도 같은 probe 에서 죽는다), 길이가 0 이면 크레딧
 * 게이트도 차감도 0 이라 **분석이 영구히 공짜로 돈다**(2026-08-26 감사). 분석 워커가 소스를
 * 내려받은 뒤 여기로 백필해 그 고리를 끊는다.
 */
export async function updateMediaDuration(id: string, durationSec: number): Promise<void> {
  if (!(Number(durationSec) > 0)) return;
  await pool.query(`UPDATE media SET durationSec = $2 WHERE id = $1`, [id, Number(durationSec)]);
}

/**
 * 저장 경로만 갱신한다 — **targeted write**. media.prepare 가 바이트를 운영 버킷으로 옮긴
 * (promoteUpload) 직후 부른다. 그 뒤 단계(remux·probe)가 죽어도 DB 가 옛 업로드 경로를
 * 가리킨 채 남지 않게 — 실제 위치와 기록이 어긋나면 "파일은 받아지는데 길이는 0" 인
 * 상태가 굳는다(2026-08-26 감사).
 */
export async function updateMediaPath(id: string, path: string): Promise<void> {
  if (!String(path ?? "").trim()) return;
  await pool.query(`UPDATE media SET path = $2 WHERE id = $1`, [id, path]);
}

// ── assembled state ────────────────────────────────────────────────────────────

/**
 * `/api/state` 가 실어 보낼 잡 개수 상한. 잡 센터가 최근 이력을 보여주는 데 필요한 만큼만.
 * 이 값을 없애면 응답 크기가 운영 기간에 비례해 계속 자란다(되돌아오지 않는 종류의 부채다).
 */
const STATE_JOB_LIMIT = 200;

export async function getState() {
  const [programs, episodes, recommendations, clips, jobs, connections, media] = await Promise.all([
    listProgramsForState(),
    listEntities("episode"),
    listEntities("recommendation"),
    listEntities("clip"),
    // ⚠️ 잡은 **지우지 않고 영구히 쌓인다.** 상한이 없으면 이 응답이 시간에 비례해 자란다.
    // 화면(잡 센터)은 최근 것만 보여주므로 오래된 잡을 실어 보낼 이유가 없다.
    listEntities("job", STATE_JOB_LIMIT),
    getConnections(),
    listMedia(),
  ]);
  return {
    programs,
    episodes,
    recommendations,
    clips: stripRedundantClipIcons(clips, programs, episodes),
    jobs,
    connections,
    media: media.map(mediaPublic),
  };
}

/**
 * `/api/state` 용 프로그램 목록 — **base64 이미지를 DB 에서부터 안 읽는다.**
 *
 * JS 에서만 걸러내면 **응답**은 줄어도 Postgres → Node 구간은 그대로 19 MB 를 실어 나르고
 * JSON.parse 까지 한다(실측 `/api/state` 0.40s — 전 라우트 최댓값). jsonb `-` 연산자로
 * **읽는 순간에** 빼면 그 구간도 같이 사라진다.
 *
 * ⚠️ 저장은 그대로다. 원본이 필요한 곳(설정 화면·렌더·팩토리)은 `getEntity` 로 통째로 읽는다.
 * ⚠️ 클립 아이콘은 여기서 못 뺀다 — "프로그램 brandIcon 과 같을 때만" 이라는 조건을 SQL 로
 *    표현하기 어렵고, 잘못 빼면 사람이 고른 아이콘이 사라진다(`stripRedundantClipIcons` 참고).
 */
async function listProgramsForState<T = unknown>(): Promise<T[]> {
  const { rows } = await pool.query(
    `SELECT (data - 'posterImageDataUrl' - 'brandIconDataUrl') AS data,
            (data ? 'posterImageDataUrl') AS has_poster,
            (data ? 'brandIconDataUrl')   AS has_icon
       FROM entities WHERE kind = 'program' ORDER BY ord ASC`,
  );
  return rows.map((r) => withImageFlags(r.data, r.has_poster, r.has_icon) as T);
}

/**
 * 뺀 자리에 **있다/없다만** 남긴다. 없으면 플래그 자체를 안 붙인다 — `false` 를 붙여도
 * 동작은 같지만, 화면이 "없다" 와 "모른다" 를 구분할 수 있게 모양을 좁혀 둔다.
 * SQL 이 아니라 여기 있는 이유: 순수 함수라야 테스트로 고정된다.
 */
export function withImageFlags(
  data: unknown, hasPoster: boolean, hasIcon: boolean,
): unknown {
  if (!hasPoster && !hasIcon) return data;
  return {
    ...(data as Record<string, unknown>),
    ...(hasPoster ? { hasPosterImage: true } : {}),
    ...(hasIcon ? { hasBrandIcon: true } : {}),
  };
}

/**
 * 클립 `editorState.channelIconDataUrl` 이 **그 프로그램의 brandIcon 과 똑같으면** 뺀다.
 *
 * 팩토리가 프로그램 이미지를 클립마다 base64 로 복사해 넣는데(`factory.ts`), 실측(2026-08-31)
 * ENA 워크스페이스는 `/api/state` 19.4 MB 중 **17.7 MB 가 이 복사본**이었다 — 서로 다른
 * 이미지는 단 2개인데 클립 51개에 장당 355 KB 씩 들어 있었다.
 *
 * ## 왜 이게 안전한가 (출력이 안 바뀐다)
 *
 * 서버 렌더는 `editorState.channelIconDataUrl` 이 없으면 `program.brandIconDataUrl` 로
 * 폴백한다(index.ts 두 곳). 그래서 **brandIcon 과 동일한 값**만 빼면 렌더 결과가 같다.
 * 미리보기도 같은 폴백을 한다(editor-shell `programIcon`).
 *
 * ## 무엇을 안 빼는가
 *
 *  - **brandIcon 과 다른 값** — 사람이 클립별로 고른 아이콘이다(실측 STEPAI 7개). 지우면 손실.
 *  - **poster 로 시드된 값** — 렌더 폴백에는 poster 가 없다. 빼면 발행 영상에서 아이콘이
 *    사라진다. brandIcon 이 없는 프로그램(실측 STEPAI 4개 중 2개)이 여기 해당한다.
 *
 * 저장된 데이터는 그대로다 — **내보낼 때만** 뺀다. 되돌리려면 이 함수만 지우면 된다.
 */
export function stripRedundantClipIcons(clips: unknown[], programs: unknown[], episodes: unknown[]): unknown[] {
  const brandIconOf = new Map<string, string>();
  for (const p of programs as Record<string, unknown>[]) {
    const icon = typeof p?.brandIconDataUrl === "string" ? p.brandIconDataUrl : "";
    if (p?.id && icon) brandIconOf.set(String(p.id), icon);
  }
  if (!brandIconOf.size) return clips;
  const programOfEpisode = new Map<string, string>();
  for (const e of episodes as Record<string, unknown>[]) {
    if (e?.id && e?.programId) programOfEpisode.set(String(e.id), String(e.programId));
  }
  return clips.map((raw) => {
    const clip = raw as Record<string, unknown>;
    const es = clip?.editorState as Record<string, unknown> | undefined;
    const icon = es?.channelIconDataUrl;
    if (typeof icon !== "string" || !icon) return raw;
    const pid = (typeof clip.programId === "string" && clip.programId)
      || programOfEpisode.get(String(clip.episodeId ?? ""));
    if (!pid || brandIconOf.get(pid) !== icon) return raw;   // 다르면 사람이 고른 값 — 보존
    const { channelIconDataUrl: _redundant, ...restEditor } = es!;
    return { ...clip, editorState: restEditor };
  });
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
  // ⚠️ `COALESCE(..., 0)` 이 없으면 **임베딩 없는 세그먼트가 검색 1위를 싹쓸이한다.**
  // pgvector 의 `<=>` 는 strict 라 emb 가 NULL 이면 결과도 NULL 이고, 두 컬럼이 모두 NULL 이면
  // GREATEST 도 NULL → score 가 NULL → `ORDER BY score DESC` 의 기본이 NULLS FIRST 다.
  // 임베딩이 NULL 인 행은 정상적으로 생긴다(대사·요약이 둘 다 빈 beat, Vertex 배치 실패한 회차).
  // 설계 의도는 "임베딩 없으면 키워드 축만으로 랭킹" 이므로 0 으로 떨어뜨리는 게 맞다.
  const vecExpr = vec
    ? `COALESCE(GREATEST(1 - (emb_dialogue <=> ${p(vec)}::vector), 1 - (emb_summary <=> ${p(vec)}::vector)), 0)`
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
     ORDER BY score DESC NULLS LAST, highlight_score DESC NULLS LAST, start_sec
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
  /** 공개 유예(분). 자동 게시를 이만큼 비공개로 잡아뒀다 공개한다. 0 = 즉시. */
  publishDelayMin: number;
}

const RULE_COLS = `platform, account_id AS "accountId", label, role, max_sec AS "maxSec",
  aspect, title_prefix AS "titlePrefix", hashtag_template AS "hashtagTemplate",
  tone_preset AS "tonePreset", privacy, schedule_window AS "scheduleWindow", enabled,
  publish_delay_min AS "publishDelayMin"`;

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
        tone_preset, privacy, schedule_window, enabled, publish_delay_min, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     -- 0021 이후 PK = (tenant_id, platform, account_id) — 옛 대상이면 "no unique constraint" 로 죽는다
     ON CONFLICT (tenant_id, platform, account_id) DO UPDATE SET
       label = $3, role = $4, max_sec = $5, aspect = $6, title_prefix = $7,
       hashtag_template = $8, tone_preset = $9, privacy = $10, schedule_window = $11,
       enabled = $12, publish_delay_min = $13, updated_at = now()`,
    [
      r.platform, r.accountId, r.label, r.role, r.maxSec, r.aspect, r.titlePrefix,
      r.hashtagTemplate, r.tonePreset, r.privacy, r.scheduleWindow, r.enabled,
      r.publishDelayMin,
    ],
  );
}

/**
 * 계정이 삭제될 때 그 계정을 겨눈 채널 규칙도 같이 지운다.
 * 남겨 두면 배포 순방·eligibility 가 존재하지 않는 계정을 계속 평가하는 고아 규칙이 된다.
 */
export async function deleteChannelRulesForAccount(platform: string, accountId: string): Promise<void> {
  await pool.query(`DELETE FROM channel_rule WHERE platform = $1 AND account_id = $2`, [platform, accountId]);
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
    // ⚠️ 충돌 대상은 **테넌트 포함 PK** 다 — 0021 이 (path) → (tenant_id, path) 로 바꿨다.
    // (path) 로 두면 그런 제약이 없어 42P10 으로 매번 500 이 난다(폴더 생성 불가).
    `INSERT INTO asset_folder (path, parent, name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, path) DO NOTHING`,
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

// ── 자동 배포: 규칙 · 실행 로그 · 보류 큐 (migrations/0019 · FLOWS F6) ──────────

export interface AutomationRuleRow {
  id: string; programId: string; platform: string; accountId: string;
  mediaKind: string; criterion: string; gatePolicy: string; window: string; enabled: boolean;
  // 다중 확장 (0032) — 배열이 있으면 배열이 정본, 없으면 단수 폴백.
  templateId?: string | null;
  layout?: Record<string, number> | null;
  programIds?: string[] | null;
  channels?: { platform: string; accountId: string }[] | null;
  dailyQuota?: number;
  activeStart?: number;
  activeEnd?: number;
  /** 발행 요일 ISO 1..7 (0042). NULL = 매일. */
  weekdays?: number[] | null;
  /** 발행 시각 슬롯 "HH:MM" KST (0042). NULL = 슬롯 없음(할당량 방식). */
  slots?: string[] | null;
  // 채택 형태 (0038) — 수동 채택 다이얼로그와 같은 값 체계. NULL = 기존(추천 kind 기반).
  orientation?: string | null;
  /** 'ai' 면 세로형 채택 직후 AI 리프레임(clip.reframe) 큐잉. */
  reframe?: string | null;
  /** 썸네일 생성 방식 (0041) — 'ai'(인물 누끼 생성) | 'frame'(프레임+자막). NULL = frame. */
  thumbnailMode?: string | null;
}

const RULE_SEL = `id, program_id AS "programId", platform, account_id AS "accountId",
  media_kind AS "mediaKind", criterion, gate_policy AS "gatePolicy",
  time_window AS "window", enabled,
  template_id AS "templateId", layout, program_ids AS "programIds", channels,
  daily_quota AS "dailyQuota", active_start AS "activeStart", active_end AS "activeEnd",
  weekdays, slots,
  orientation, reframe, thumbnail_mode AS "thumbnailMode"`;

export async function listAutomationRules(): Promise<AutomationRuleRow[]> {
  const { rows } = await pool.query<AutomationRuleRow>(
    `SELECT ${RULE_SEL} FROM automation_rule ORDER BY created_at DESC`,
  );
  return rows;
}

export async function upsertAutomationRule(r: AutomationRuleRow): Promise<void> {
  await pool.query(
    `INSERT INTO automation_rule
       (id, program_id, platform, account_id, media_kind, criterion, gate_policy, time_window, enabled,
        template_id, layout, program_ids, channels, daily_quota, active_start, active_end,
        orientation, reframe, thumbnail_mode, weekdays, slots)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
     ON CONFLICT (tenant_id, program_id, platform, account_id) DO UPDATE SET
       media_kind = $5, criterion = $6, gate_policy = $7, time_window = $8, enabled = $9,
       template_id = $10, layout = $11::jsonb, program_ids = $12::jsonb, channels = $13::jsonb,
       daily_quota = $14, active_start = $15, active_end = $16,
       orientation = $17, reframe = $18, thumbnail_mode = $19,
       weekdays = $20::jsonb, slots = $21::jsonb`,
    [r.id, r.programId, r.platform, r.accountId, r.mediaKind, r.criterion, r.gatePolicy, r.window, r.enabled,
     r.templateId ?? null,
     r.layout ? JSON.stringify(r.layout) : null,
     r.programIds?.length ? JSON.stringify(r.programIds) : null,
     r.channels?.length ? JSON.stringify(r.channels) : null,
     r.dailyQuota ?? 3, r.activeStart ?? 9, r.activeEnd ?? 22,
     r.orientation ?? null, r.reframe ?? null, r.thumbnailMode ?? null,
     r.weekdays?.length ? JSON.stringify(r.weekdays) : null,
     r.slots?.length ? JSON.stringify(r.slots) : null],
  );
}

/**
 * id 로 기존 규칙을 통째로 갱신. 자연키 upsert 는 **첫 채널이 바뀌면 새 규칙을 만든다** —
 * 구 규칙이 enabled 로 남아 이중 커버(한도 2배·뺀 채널로 계속 게시)가 되므로,
 * "갱신"의 정본은 id 다. 자연키가 다른 규칙과 충돌하면 unique_violation 이 던져진다(호출부 409).
 */
export async function updateAutomationRuleById(r: AutomationRuleRow): Promise<boolean> {
  const res = await pool.query(
    `UPDATE automation_rule SET
       program_id = $2, platform = $3, account_id = $4, media_kind = $5, criterion = $6,
       gate_policy = $7, time_window = $8, enabled = $9, template_id = $10, layout = $11::jsonb,
       program_ids = $12::jsonb, channels = $13::jsonb, daily_quota = $14,
       active_start = $15, active_end = $16, orientation = $17, reframe = $18,
       thumbnail_mode = $19, weekdays = $20::jsonb, slots = $21::jsonb
     WHERE id = $1`,
    [r.id, r.programId, r.platform, r.accountId, r.mediaKind, r.criterion, r.gatePolicy, r.window, r.enabled,
     r.templateId ?? null,
     r.layout ? JSON.stringify(r.layout) : null,
     r.programIds?.length ? JSON.stringify(r.programIds) : null,
     r.channels?.length ? JSON.stringify(r.channels) : null,
     r.dailyQuota ?? 3, r.activeStart ?? 9, r.activeEnd ?? 22,
     r.orientation ?? null, r.reframe ?? null, r.thumbnailMode ?? null,
     r.weekdays?.length ? JSON.stringify(r.weekdays) : null,
     r.slots?.length ? JSON.stringify(r.slots) : null],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 오늘(KST) 게시 수 — 하루 배포 개수 판정. rule_run 은 UTC 저장이라
 * KST 자정( UTC 전날 15:00 ) 기준으로 자른다.
 *
 * **계획(규칙) 단위로 센다** — `ruleId` 를 주면 그 계획의 몫만 센다 (2026-08-28 사용자 확정:
 * "A 계획 10개면 10개대로, B 계획 20개면 20개대로 나가라. 복수 채널·복수 프로그램은 무시").
 *
 * 예전엔 채널 단위였다. 채널 하나에 계획 하나이던 시절엔 같은 말이었지만, 한 채널을 여러
 * 계획이 함께 쓸 수 있게 되면서(같은 날 제한 해제) 두 계획이 **같은 카운터를 나눠 갖는**
 * 상태가 됐다 — A(10개)와 B(20개)가 같은 채널이면 채널 전체가 20개에서 멈추고, 사용자가
 * 계획마다 정한 개수는 그대로 나가지 않는다. "사용자가 정한 개수가 안 지켜지는 것" 은
 * 이 리포가 오늘만 두 번 데인 사고 형태다.
 *
 * ⚠️ `ruleId` 를 안 주면 종전처럼 채널 전체를 센다 — 화면의 "이 채널에 오늘 몇 건 나갔나"
 * 같은 **표시용** 질의가 그 축을 쓴다. 한도 판정은 반드시 ruleId 를 준다.
 *
 * 실패한 건은 세지 않는다. 큐에 넣은 시점에 'published' 를 쓰기 때문에, 워커가 그 업로드를
 * 실패시키면 채널엔 아무것도 없는데 한도만 소진된다("오늘 3건 게시" 인데 채널은 비어 있음).
 * 같은 클립·같은 계정에 뒤이어 'failed' 가 찍히면 그 슬롯은 되돌린다.
 *
 * ⚠️ **되돌림 조건(NOT EXISTS)에는 rule_id 를 넣지 말 것.** 세는 축이 계획이 됐으니 여기도
 * 맞추고 싶어 보이지만, 두 행의 rule_id 는 원래 다를 수 있다 — 'published' 는 게시한 **살아
 * 있는** 계획 id 로 쓰이고(automation-cycle), 'failed' 는 워커가 `clip.automationRuleId`,
 * 즉 그 클립을 **채택한** 계획 id 로 쓴다(worker.ts). 지워진 계획의 고아 클립을 다른 계획이
 * 이어받아 게시하면 둘이 갈린다. rule_id 를 걸면 그때 되돌림이 죽어 "한도는 깎였는데 채널은
 * 비어 있음" 이 그대로 돌아온다. (clip, account) 축이 맞다.
 */
export async function publishedTodayKst(accountKey: string, ruleId?: string | null): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rule_run r
      WHERE r.account_key = $1 AND r.result = 'published'
        AND ($2::text IS NULL OR r.rule_id = $2)
        AND r.at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
        AND NOT EXISTS (
          SELECT 1 FROM rule_run f
           WHERE f.clip_id IS NOT DISTINCT FROM r.clip_id
             AND f.account_key IS NOT DISTINCT FROM r.account_key
             AND f.result = 'failed' AND f.at >= r.at)`,
    [accountKey, ruleId ?? null],
  );
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}

export async function deleteAutomationRule(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM automation_rule WHERE id = $1`, [id]);
  // 이 규칙의 열린 보류도 같이 지운다. rule_hold 엔 FK·cascade 가 없어(0019) 규칙만 지우면
  // 보류 행이 남고, 승인 대기 목록에 **아무도 게시하지 않을 영상**이 영원히 뜬다(유령 항목).
  //
  // ⚠️ releaseHold(해제 표시)가 아니라 DELETE 다. released_at 이 찍히면 hasReleasedHold 가
  // 참이 되어, 나중에 다른 규칙이 같은 클립을 잡았을 때 **사람 승인 없이** approve_first 를
  // 통과한다 — 사람이 봐야 할 게 사람 눈을 거치지 않고 나가는 방향의 실패다.
  await pool.query(`DELETE FROM rule_hold WHERE rule_id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 자동 실행 전용 로그 — 사람이 누른 배포와 섞지 않는다(F6). */
export async function appendRuleRun(ev: {
  ruleId?: string | null; clipId?: string | null; result: string; detail?: string;
  /** 채널별 할당량 집계 키 — "youtube:UCxxx" · "naverclip:nva_xxx" 형식. */
  accountKey?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO rule_run (rule_id, clip_id, result, detail, account_key) VALUES ($1,$2,$3,$4,$5)`,
    [ev.ruleId ?? null, ev.clipId ?? null, ev.result, ev.detail ?? "", ev.accountKey ?? null],
  );
}

/**
 * 이 규칙·클립·계정 조합으로 같은 사유를 이미 남겼는가.
 *
 * 자동 순방은 15분마다 돈다 — 상태가 안 변하는 스킵을 매번 적으면 실행 로그가 같은 줄로
 * 가득 차고, 그러면 아무도 안 읽는다. 처음 한 번만 남기고 이후엔 조용히 넘기려고 쓴다.
 *
 * `ruleId` 가 null 이면 **워크스페이스 전체 사유**다(크레딧 부족 같은, 특정 규칙 탓이
 * 아닌 것). rule_run.rule_id 는 NULL 허용·FK 없음(0019)이라 그대로 들어간다 — `= $1` 하나로
 * 두면 NULL 비교가 항상 거짓이라 dedupe 가 통째로 무력해져 그 사유가 매 순방 쌓인다.
 *
 * `detail` 을 주면 **문구까지 같아야** 이미 남긴 것으로 본다. 사유가 여러 가지인 자리
 * (규칙별 유휴 사유)에서는 result 만으로는 "다른 사유로 이미 한 줄 남겼다" 와 구분이 안 된다.
 */
export async function hasRunNote(
  ruleId: string | null, clipId: string | null, accountKey?: string | null,
  result = "skipped", todayKstOnly = false, detail?: string | null,
): Promise<boolean> {
  // ⚠️ rule_id 조건은 **두 갈래로 나눈다.** 한 줄로 합치려고 `IS NOT DISTINCT FROM` 을 쓰면
  // 이 쿼리가 인덱스를 통째로 잃는다 — PostgreSQL 에 그 연산자의 btree 전략이 없고,
  // rule_run 의 인덱스는 idx_rule_run_rule(rule_id, at DESC · 0019) ·
  // idx_rule_run_quota(rule_id, account_key, at DESC · 0032) 둘 다 **rule_id 선행**이라
  // 그 자리를 못 쓰면 남는 진입점이 없어 매번 seq scan 이다. 순방은 15분마다 이 함수를
  // 규칙×채널×클립 수만큼 부르므로, rule_run 이 자라는 만큼 그대로 느려진다.
  //   값이 있으면 `= $1`(인덱스 진입) · null 이면 `rule_id IS NULL`(btree 는 NULL 도
  //   색인한다) — 워크스페이스 단위 dedupe 는 그대로 산다.
  // null 갈래에 `$1::text IS NULL` 을 붙이는 건 항등식이라서가 아니라, $1 을 어디서도 안 쓰면
  // Postgres 가 파라미터 타입을 못 정해 "could not determine data type of parameter $1" 로
  // 죽기 때문이다(자리 수를 유지해 나머지 $2~$5 를 그대로 쓴다).
  const ruleCond = ruleId == null ? "rule_id IS NULL AND $1::text IS NULL" : "rule_id = $1";
  const { rows } = await pool.query(
    `SELECT 1 FROM rule_run
      WHERE ${ruleCond} AND result = $4
        AND clip_id IS NOT DISTINCT FROM $2
        AND account_key IS NOT DISTINCT FROM $3
        AND ($5::text IS NULL OR detail = $5)
        ${todayKstOnly
          ? "AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'"
          : ""}
      LIMIT 1`,
    [ruleId ?? null, clipId ?? null, accountKey ?? null, result, detail ?? null],
  );
  return rows.length > 0;
}

export async function listRuleRuns(limit = 100): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT id, at, rule_id AS "ruleId", clip_id AS "clipId", result, detail,
            account_key AS "accountKey"
       FROM rule_run ORDER BY at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  );
  return rows;
}

/** 보류 — 행이 남아 있는 동안은 게이트가 열려도 자동이 밀어내지 않는다(F6 Invariant). */
export async function holdClip(ruleId: string, clipId: string, reason: string): Promise<void> {
  // 0021 이 rule_hold_pkey 를 (tenant_id, rule_id, clip_id) 로 재키잉했다 — 구 (rule_id, clip_id)
  // 타깃은 42P10 으로 죽는다. channel_rule 과 같은 병(1275481)의 같은 처방. tenant_id 는
  // DEFAULT current_setting 이 채운다.
  //
  // released_at·released_by 를 **반드시 NULL 로 되돌린다** — 재보류는 새 보류다.
  // 해제된 행 위에 reason 만 덮으면 (1) released_at 이 남아 openHolds(승인 큐)에 안 보이고
  // (2) hasReleasedHold 가 계속 참이라 approve_first 규칙을 **재승인 없이** 통과한다.
  // 사람이 봐야 하는 건이 사람 눈을 거치지 않고 나가는 방향의 실패라 여기서 막는다.
  await pool.query(
    `INSERT INTO rule_hold (rule_id, clip_id, reason) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, rule_id, clip_id) DO UPDATE
       SET reason = $3, released_at = NULL, released_by = NULL`,
    [ruleId, clipId, reason],
  );
}

/** 사람이 확정(승인) — 이게 있어야 다음 순방에 다시 잡혀 게시된다. 거부된 건은 승인 불가. */
export async function releaseHold(ruleId: string, clipId: string, actor: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rule_hold SET released_by = $3, released_at = now()
      WHERE rule_id = $1 AND clip_id = $2 AND released_at IS NULL AND rejected_at IS NULL`,
    [ruleId, clipId, actor],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 사람이 **거부** — 이 (규칙·영상)은 나가지 않는다. released_at 과 **별개 상태**다:
 * released_at 을 쓰면 hasReleasedHold 가 참이 되어 되레 게시된다(거부의 정반대). rejected_at 은
 * openHolds/isHeldAwaitingHuman 에서 빠지고, 순방이 isRejectedHold 로 보고 건너뛴다(0044).
 */
export async function rejectHold(ruleId: string, clipId: string, actor: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE rule_hold SET rejected_by = $3, rejected_at = now()
      WHERE rule_id = $1 AND clip_id = $2 AND released_at IS NULL AND rejected_at IS NULL`,
    [ruleId, clipId, actor],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function openHolds(ruleId?: string): Promise<{ ruleId: string; clipId: string; reason: string; heldAt: string }[]> {
  const { rows } = await pool.query<{ ruleId: string; clipId: string; reason: string; heldAt: string }>(
    `SELECT rule_id AS "ruleId", clip_id AS "clipId", reason, held_at AS "heldAt"
       FROM rule_hold
      WHERE released_at IS NULL AND rejected_at IS NULL AND ($1::text IS NULL OR rule_id = $1)
      ORDER BY held_at DESC`,
    [ruleId ?? null],
  );
  return rows;
}

/** 이 클립이 이 규칙에서 아직 사람 확정을 기다리는가(거부된 건 제외). */
export async function isHeldAwaitingHuman(ruleId: string, clipId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM rule_hold WHERE rule_id = $1 AND clip_id = $2 AND released_at IS NULL AND rejected_at IS NULL`,
    [ruleId, clipId],
  );
  return rows.length > 0;
}

/** 사람이 이 (규칙·영상)을 거부했는가 — 순방이 재선정·게시하지 않고 건너뛰는 근거. */
export async function isRejectedHold(ruleId: string, clipId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM rule_hold WHERE rule_id = $1 AND clip_id = $2 AND rejected_at IS NOT NULL`,
    [ruleId, clipId],
  );
  return rows.length > 0;
}

/**
 * 사람이 이 클립의 보류를 **해제한 기록**이 있는가 — approve_first 의 '승인' 근거.
 * `!isHeldAwaitingHuman` 을 승인으로 쓰면 보류된 적 없는 새 클립까지 자동 승인된다
 * (승인 정책이 통째로 무력화된다). 해제 행이 남아 있어야 사람이 봤다는 뜻이다.
 */
export async function hasReleasedHold(ruleId: string, clipId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM rule_hold WHERE rule_id = $1 AND clip_id = $2 AND released_at IS NOT NULL`,
    [ruleId, clipId],
  );
  return rows.length > 0;
}

export async function getAutomationSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM automation_setting WHERE key = $1`, [key],
  );
  return rows[0]?.value ?? null;
}

export async function setAutomationSetting(key: string, value: string): Promise<void> {
  await pool.query(
    // ⚠️ 충돌 대상은 **테넌트 포함 PK** 다 — 0021 이 (key) → (tenant_id, key) 로 바꿨다.
    // (key) 로 두면 42P10 으로 매번 500 → "전역 일시정지" 가 저장되지 않아, 눌러도 순방이
    // 계속 돌고 클립이 계속 나갔다.
    `INSERT INTO automation_setting (key, value) VALUES ($1,$2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

// ── 자동 충전 실패 알림 ──────────────────────────────────────────────────────────
//
// 테넌트당 **한 행**이라 새 표가 필요 없다 — 이미 테넌트 KV 인 automation_setting 을 쓴다
// (RLS·tenant_id DEFAULT 를 그대로 물려받아 마이그레이션이 0이다). 표 이름이 automation 인
// 것과 키가 billing 인 것이 어긋나 보이므로, 표를 직접 만지지 말고 **이름 있는 이 두 함수만**
// 쓸 것 — 나중에 표를 옮기면 여기 둘만 바뀐다.
const AUTO_TOPUP_ALERT_KEY = "billing.autoTopupAlert";

/**
 * 지금 걸려 있는 자동 충전 실패 알림. 없으면 null(해제됨·한 번도 실패 안 함·**유효기간 만료**).
 *
 * 만료 판정을 **읽는 이 한 곳**에 둔다 — "오늘 상한 도달" 은 그 날에만 참인데, 알림을 지우는
 * 유일한 경로(다음 maybeAutoTopup 정상 판정)가 분석 완료에만 달려 있어 잔액 0 이면 영영 안
 * 불린다. 소비처마다 기간을 따지게 하면 반드시 한쪽이 빠져 사흘 전 기록이 "오늘"로 보인다.
 */
export async function getAutoTopupAlert(): Promise<AutoTopupAlert | null> {
  const raw = await getAutomationSetting(AUTO_TOPUP_ALERT_KEY);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as AutoTopupAlert;
    // 모양이 깨진 값으로 화면을 채우지 않는다 — 코드를 모르면 힌트도 못 만든다.
    if (!a || typeof a !== "object" || !(AUTO_TOPUP_CODES as readonly string[]).includes(a.code)) return null;
    return liveAutoTopupAlert(a);
  } catch {
    return null;
  }
}

/**
 * 알림을 남기거나(객체) **지운다**(null). 해제는 빈 문자열 저장이다 —
 * 게터가 빈 값을 null 로 읽으므로 행을 지울 필요가 없다(DELETE 경합·RLS 걱정 제거).
 */
export async function setAutoTopupAlert(alert: AutoTopupAlert | null): Promise<void> {
  await setAutomationSetting(AUTO_TOPUP_ALERT_KEY, alert ? JSON.stringify(alert) : "");
}

// ── 결제 알림 수신자 (B2B 담당자 여러 명 · 2026-08-24) ─────────────────────────
//
// 인보이스(결제 완료)·자동 결제 실패 메일을 받을 추가 이메일 목록. autoTopupAlert 와
// 같은 이유로 automation_setting KV 를 쓴다(테넌트당 한 행 · 마이그레이션 0) —
// 표를 직접 만지지 말고 이 두 함수만 쓸 것.
const BILLING_NOTIFY_EMAILS_KEY = "billing.notifyEmails";

export async function getBillingNotifyEmails(): Promise<string[]> {
  const raw = await getAutomationSetting(BILLING_NOTIFY_EMAILS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function setBillingNotifyEmails(emails: string[]): Promise<void> {
  await setAutomationSetting(BILLING_NOTIFY_EMAILS_KEY, emails.length ? JSON.stringify(emails) : "");
}

/**
 * 이번 달(KST) 분석 사용량 합계(크레딧 = 분). 결제 화면 게이지의 생산자 —
 * 원장 50건 슬라이스로 화면이 직접 더하면 달이 넘어가는 사용량이 조용히 빠진다.
 */
export async function monthUsageCredits(): Promise<number> {
  const { rows } = await pool.query<{ used: number }>(
    // 사용 = 분석(usage) + 배포(publish · 2026-08-26 영상×채널 1크레딧). 환급(publish_refund ·
    // delta +1)은 SUM(-delta)에서 자연히 빠진다 — 실패한 배포는 이번달 사용에 안 잡힌다.
    `SELECT COALESCE(SUM(-delta), 0)::int AS used
       FROM credit_ledger
      WHERE reason IN ('usage', 'publish', 'publish_refund')
        AND occurred_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`,
  );
  return rows[0]?.used ?? 0;
}

// ── 과금 원장 (migrations/0023 · billing-portone-plan.md) ──────────────────────

export interface UsageEventInput {
  kind: string;
  quantity: number;
  mediaId?: string | null;
  jobId?: string | null;
  costKrw?: number | null;
  source?: "web" | "api";
  dedupeKey: string;
}

/**
 * 사용량 기록. **멱등하다** — 같은 dedupeKey 는 두 번 쌓이지 않는다.
 * 워커 재시도가 곧 중복 청구가 되면 안 되기 때문이다.
 *
 * @returns 새로 기록됐으면 true, 이미 있으면 false.
 */
export async function recordUsage(ev: UsageEventInput): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO usage_events (kind, quantity, media_id, job_id, cost_krw, source, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [ev.kind, ev.quantity, ev.mediaId ?? null, ev.jobId ?? null, ev.costKrw ?? null,
     ev.source ?? "web", ev.dedupeKey],
  );
  return rows.length > 0;
}

/** 이번 기간에 쓴 양 — 쿼터 판정 입력. */
export async function usedQuantity(kind: string, since: Date): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS total
       FROM usage_events WHERE kind = $1 AND occurred_at >= $2`,
    [kind, since],
  );
  return Number(rows[0]?.total ?? 0) || 0;
}

/** 최근 사용 내역 — 화면·원가 확인용. */
export async function listUsage(limit = 100): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT id, kind, quantity, media_id AS "mediaId", cost_krw AS "costKrw",
            source, occurred_at AS "occurredAt"
       FROM usage_events ORDER BY occurred_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  );
  return rows;
}

export interface PlanRow {
  id: string; displayName: string; monthlyKrw: number;
  includedMin: number; overageKrwPerMin: number | null;
}

/** 현재 테넌트의 활성 요금제. 없으면 null — 호출부가 0 으로 때우면 안 된다. */
export async function activePlan(): Promise<PlanRow | null> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT p.id, p.display_name AS "displayName", p.monthly_krw AS "monthlyKrw",
            p.included_min AS "includedMin", p.overage_krw_per_min AS "overageKrwPerMin"
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('trialing','active')
      ORDER BY s.period_end DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

// ── 크레딧 원장 (migrations/0024) ───────────────────────────────────────────────

/** 잔액 = 원장 합계. **캐시하지 않는다** — 어긋난 잔액은 조용히 틀린 채로 굴러간다. */
export async function creditBalance(): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(delta), 0)::text AS total FROM credit_ledger`,
  );
  return Number(rows[0]?.total ?? 0) || 0;
}

export interface CreditEntryInput {
  delta: number;
  reason: string;
  mediaId?: string | null;
  paymentId?: string | null;
  amountKrw?: number | null;
  note?: string;
  actor?: string;
  dedupeKey: string;
}

/**
 * 원장 기록. **멱등** — 같은 dedupeKey 는 두 번 쌓이지 않는다.
 * @returns 새로 기록됐으면 true, 이미 있으면 false.
 */
export async function addCreditEntry(e: CreditEntryInput): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO credit_ledger (delta, reason, media_id, payment_id, amount_krw, note, actor, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [Math.trunc(e.delta), e.reason, e.mediaId ?? null, e.paymentId ?? null,
     e.amountKrw ?? null, e.note ?? "", e.actor ?? "", e.dedupeKey],
  );
  return rows.length > 0;
}

/**
 * 크레딧 원장 조회.
 *
 * `scope: "user"` 는 **잔액을 움직인 행만** 준다. delta 0 행(PG 취소·실패 이벤트의 운영 기록)은
 * 원장엔 남지만 사용자 화면엔 안 나간다 — "조정 +0" 이 결제 취소 때마다 쌓여 결제 내역처럼
 * 보이는 걸 막는다. 실제 환불은 음수 delta 라 그대로 보인다(숨기면 안 되는 건 안 숨겨진다).
 * planManualCredit 이 delta 0 수동조정을 거부하므로 정상 조정이 걸릴 일도 없다.
 * 기본값 "ops" 는 기존 호출부(운영·정산 대사) 무변경 — 운영자는 전부 봐야 한다.
 */
export async function listCreditLedger(
  limit = 100,
  scope: "user" | "ops" = "ops",
): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT id, delta, reason, media_id AS "mediaId", payment_id AS "paymentId",
            amount_krw AS "amountKrw", note, actor, occurred_at AS "occurredAt"
       FROM credit_ledger
      ${scope === "user" ? "WHERE delta <> 0" : ""}
      ORDER BY occurred_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  );
  return rows;
}

export interface TopupRow {
  paymentId: string; credits: number; amountKrw: number; status: string; requestedBy: string;
  /** 조회 경로에서만 채워진다(createTopup 입력에는 없음) — 인보이스 결제일 표기용. */
  createdAt?: string;
  settledAt?: string | null;
}

// ── 회사 사업자정보 ───────────────────────────────────────────────────────────
// RLS 표(0030). 어드민이 **남의 회사** 것을 읽고 쓰므로 호출부가 asSystem 으로 감싼다.

export interface BusinessProfileRow {
  bizName: string; bizNo: string; ceoName: string; address: string;
  bizType: string; bizItem: string; contactEmail: string; contactPhone: string;
  updatedBy: string; updatedAt: string;
}

const BIZ_COLS = `biz_name AS "bizName", biz_no AS "bizNo", ceo_name AS "ceoName",
                  address, biz_type AS "bizType", biz_item AS "bizItem",
                  contact_email AS "contactEmail", contact_phone AS "contactPhone",
                  updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function getBusinessProfile(db: Queryable, tenantId: string): Promise<BusinessProfileRow | null> {
  const { rows } = await db.query(
    `SELECT ${BIZ_COLS} FROM business_profile WHERE tenant_id = $1`,
    [tenantId],
  );
  return (rows[0] as BusinessProfileRow | undefined) ?? null;
}

export async function saveBusinessProfile(
  db: Queryable,
  tenantId: string,
  p: Omit<BusinessProfileRow, "updatedAt"> ,
): Promise<BusinessProfileRow> {
  const { rows } = await db.query(
    `INSERT INTO business_profile
       (tenant_id, biz_name, biz_no, ceo_name, address, biz_type, biz_item,
        contact_email, contact_phone, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id) DO UPDATE SET
       biz_name = EXCLUDED.biz_name, biz_no = EXCLUDED.biz_no, ceo_name = EXCLUDED.ceo_name,
       address = EXCLUDED.address, biz_type = EXCLUDED.biz_type, biz_item = EXCLUDED.biz_item,
       contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING ${BIZ_COLS}`,
    [tenantId, p.bizName, p.bizNo, p.ceoName, p.address, p.bizType, p.bizItem,
     p.contactEmail, p.contactPhone, p.updatedBy],
  );
  return rows[0] as BusinessProfileRow;
}

// ── 저장 카드(빌링키) ─────────────────────────────────────────────────────────
// RLS 표(0029)라 **스코프 있는 풀**(pool)로 쓴다. rawPool 로 만지면 0행이 나온다.

export interface BillingCardRow {
  billingKey: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** 빌링키 결제의 customer 필수 3종(이니시스) — 0037 이전 등록 카드는 null 일 수 있다. */
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
}

export async function getBillingCard(): Promise<BillingCardRow | null> {
  const { rows } = await pool.query(
    `SELECT billing_key AS "billingKey", card_brand AS "cardBrand", card_last4 AS "cardLast4",
            created_at AS "createdAt", revoked_at AS "revokedAt",
            buyer_name AS "buyerName", buyer_email AS "buyerEmail", buyer_phone AS "buyerPhone"
       FROM billing_card WHERE tenant_id = current_setting('app.tenant_id', true)`,
  );
  return (rows[0] as BillingCardRow | undefined) ?? null;
}

/**
 * 구매자 정보 백필 — 0037 이전에 등록된 카드는 buyer 가 비어 있어 빌링키 결제가 불가능하다.
 * 수동 충전이 화면 입력값으로 성공하면 그 값을 카드에 남겨 자동충전도 가능해지게 한다.
 * targeted write(B6) — 다른 컬럼을 안 건드린다.
 */
export async function updateBillingCardBuyer(b: {
  fullName: string; email: string; phoneNumber: string;
}): Promise<void> {
  await pool.query(
    `UPDATE billing_card SET buyer_name = $1, buyer_email = $2, buyer_phone = $3
      WHERE tenant_id = current_setting('app.tenant_id', true)`,
    [b.fullName, b.email, b.phoneNumber],
  );
}

/**
 * 회사당 한 장 — 다시 등록하면 덮어쓴다.
 * 재등록은 `revoked_at` 을 비워야 한다. 안 그러면 해지 표시가 남아 새 카드가 죽은 채로 저장된다.
 */
export async function saveBillingCard(input: {
  billingKey: string;
  cardBrand: string | null;
  cardLast4: string | null;
  issuedBy: string;
  /** 빌링키 결제의 customer 필수 3종 — 저장해 둬야 결제·자동충전 때 보낼 값이 있다(0037). */
  buyer: { fullName: string; email: string; phoneNumber: string };
}): Promise<BillingCardRow> {
  const { rows } = await pool.query(
    `INSERT INTO billing_card (tenant_id, billing_key, card_brand, card_last4, issued_by,
                               buyer_name, buyer_email, buyer_phone)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET
       billing_key = EXCLUDED.billing_key, card_brand = EXCLUDED.card_brand,
       card_last4  = EXCLUDED.card_last4,  issued_by  = EXCLUDED.issued_by,
       buyer_name  = EXCLUDED.buyer_name,  buyer_email = EXCLUDED.buyer_email,
       buyer_phone = EXCLUDED.buyer_phone,
       created_at  = now(), revoked_at = NULL
     RETURNING billing_key AS "billingKey", card_brand AS "cardBrand", card_last4 AS "cardLast4",
               created_at AS "createdAt", revoked_at AS "revokedAt",
               buyer_name AS "buyerName", buyer_email AS "buyerEmail", buyer_phone AS "buyerPhone"`,
    [input.billingKey, input.cardBrand, input.cardLast4, input.issuedBy,
     input.buyer.fullName, input.buyer.email, input.buyer.phoneNumber],
  );
  return rows[0] as BillingCardRow;
}

/**
 * 표시정보(브랜드·끝 4자리)만 갱신한다 — 빌링키·등록일은 건드리지 않는다.
 * 저장 시점에 못 채운 기존 카드를 조회 때 한 번 백필하는 용도(포트원 조회 결과).
 */
export async function updateBillingCardDisplay(brand: string | null, last4: string | null): Promise<void> {
  await pool.query(
    `UPDATE billing_card SET card_brand = $1, card_last4 = $2
      WHERE tenant_id = current_setting('app.tenant_id', true) AND billing_key IS NOT NULL`,
    [brand, last4],
  );
}

/** 해지 — 행은 남기고 **빌링키 문자열은 비운다.** 해지된 권한을 들고 있을 이유가 없다. */
export async function revokeBillingCard(): Promise<void> {
  await pool.query(
    `UPDATE billing_card SET billing_key = NULL, revoked_at = now()
      WHERE tenant_id = current_setting('app.tenant_id', true) AND revoked_at IS NULL`,
  );
}

// ── 자동 충전 정책 (0033) ────────────────────────────────────────────────────────

export interface AutoTopupRow {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
  maxPerDay: number;
  maxKrwPerMonth: number;
  updatedAt: string;
  updatedBy: string;
}

/** 워크스페이스의 자동 충전 정책. 없으면 null(=한 번도 설정 안 함 → 꺼짐). */
export async function getAutoTopupPolicy(): Promise<AutoTopupRow | null> {
  const { rows } = await pool.query(
    `SELECT enabled, threshold_credits AS "thresholdCredits", topup_credits AS "topupCredits",
            max_per_day AS "maxPerDay", max_krw_per_month AS "maxKrwPerMonth",
            updated_at AS "updatedAt", updated_by AS "updatedBy"
       FROM auto_topup WHERE tenant_id = current_setting('app.tenant_id', true)`,
  );
  return (rows[0] as AutoTopupRow | undefined) ?? null;
}

export async function saveAutoTopupPolicy(p: {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
  maxPerDay: number;
  maxKrwPerMonth: number;
  updatedBy: string;
}): Promise<AutoTopupRow> {
  const { rows } = await pool.query(
    `INSERT INTO auto_topup (tenant_id, enabled, threshold_credits, topup_credits, max_per_day, max_krw_per_month, updated_by, updated_at)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, threshold_credits = EXCLUDED.threshold_credits,
       topup_credits = EXCLUDED.topup_credits, max_per_day = EXCLUDED.max_per_day,
       max_krw_per_month = EXCLUDED.max_krw_per_month, updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING enabled, threshold_credits AS "thresholdCredits", topup_credits AS "topupCredits",
               max_per_day AS "maxPerDay", max_krw_per_month AS "maxKrwPerMonth",
               updated_at AS "updatedAt", updated_by AS "updatedBy"`,
    [p.enabled, p.thresholdCredits, p.topupCredits, p.maxPerDay, p.maxKrwPerMonth, p.updatedBy],
  );
  return rows[0] as AutoTopupRow;
}

/**
 * 오늘(KST 달력일) **자동** 충전 성공 횟수 — 하루 상한 판정용(수동 충전은 세지 않는다).
 *
 * "하루" 는 **KST 달력일**이다 — 롤링 24시간이 아니다. UI 문구가 "하루 최대 N회"라
 * 사용자는 달력일로 읽고, paymentId 슬롯(autoTopupTodayAttempts·kstDateStamp)도 KST
 * 달력일이다. 예전엔 이 함수만 롤링 24시간이라 두 "하루"가 어긋났다 — 자정 직후
 * 슬롯은 1부터 새로 시작하는데 카운트는 어제 것까지 세는 식의 불일치.
 */
export async function autoTopupTodayCount(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM credit_topup
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND requested_by = 'auto-topup' AND status = 'paid'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** 이번 달(달력) **자동** 충전 성공 금액 합 — 월 상한 판정용. */
export async function autoTopupMonthKrw(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_krw), 0)::int AS krw FROM credit_topup
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND requested_by = 'auto-topup' AND status = 'paid'
        -- 일 카운터와 같은 KST 달력 기준 — 서버 TZ(UTC)로 자르면 매월 1일 00~09시 KST 의
        -- 충전이 전월로 집계돼 월 상한 판정이 사용자 인식과 9시간 어긋난다.
        AND (created_at AT TIME ZONE 'Asia/Seoul') >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul')`,
  );
  return Number(rows[0]?.krw ?? 0);
}

/**
 * 오늘(KST) 자동 충전 **시도** 수 — 결정적 paymentId 의 슬롯 재료. 성공분만 세는
 * autoTopupTodayCount 와 달리 실패분도 센다: 실패한 paymentId 를 재사용하면 포트원이
 * 새 결제를 거부하므로, 시도마다 슬롯이 한 칸씩 밀려야 한다.
 */
export async function autoTopupTodayAttempts(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM credit_topup
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND requested_by = 'auto-topup'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * 최근 3일 내 **자동 충전** 주문 중 paid 로 못 끝난 것 — 정산 대상 후보.
 *
 * 결제 호출이 승인 뒤 타임아웃으로 끊기면 주문은 pending/failed 인데 카드는 긁혀 있다.
 * 자동 충전은 새 결제 **전에** 이 목록을 포트원에 물어 정산한다(auto-topup.ts) — 안 하면
 * 이미 나간 돈 위에 또 긁는 이중 청구가 된다. 자동 충전 요청분(requested_by='auto-topup')만
 * 본다: 수동 충전의 미정산은 웹훅이 정산할 몫이지 자동 충전이 대신 결정할 일이 아니다.
 * 3일 컷 — 그보다 오래 안 정산된 건 웹훅 재전송도 끝났을 테니 사람이 봐야 한다.
 */
export async function listUnsettledAutoTopups(): Promise<TopupRow[]> {
  const { rows } = await pool.query<TopupRow>(
    `SELECT payment_id AS "paymentId", credits, amount_krw AS "amountKrw", status,
            requested_by AS "requestedBy"
       FROM credit_topup
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND requested_by = 'auto-topup'
        AND status <> 'paid'
        AND created_at >= now() - interval '3 days'
      ORDER BY created_at ASC
      LIMIT 20`,
  );
  return rows;
}

/**
 * 테넌트 단위 자문 잠금(pg_advisory_xact_lock) 안에서 fn 을 실행한다 — 잠금은
 * 트랜잭션 종료(함수 반환)와 함께 풀린다. **직렬화가 목적이지 원자성이 아니다**:
 * fn 안의 쿼리는 평소처럼 pool 로 나가 즉시 커밋돼도 된다. 경쟁자는 같은 키에서
 * 기다렸다가 앞선 실행이 커밋한 결과를 보고 재판정하게 된다 (자동 충전 이중 결제 방어).
 */
export async function withTenantLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect(); // 스코프 프록시가 app.tenant_id 를 심는다
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function createTopup(r: TopupRow): Promise<void> {
  await pool.query(
    `INSERT INTO credit_topup (payment_id, tenant_id, credits, amount_krw, status, requested_by)
     VALUES ($1, current_setting('app.tenant_id', true), $2, $3, 'pending', $4)`,
    [r.paymentId, r.credits, r.amountKrw, r.requestedBy],
  );
}

export async function getTopup(paymentId: string): Promise<TopupRow | null> {
  const { rows } = await pool.query<TopupRow>(
    `SELECT payment_id AS "paymentId", credits, amount_krw AS "amountKrw", status,
            requested_by AS "requestedBy", created_at AS "createdAt", settled_at AS "settledAt"
       FROM credit_topup WHERE payment_id = $1`,
    [paymentId],
  );
  return rows[0] ?? null;
}

/** 결제 완료(paid)된 충전 건 — 인보이스 목록의 원천. 별도 인보이스 표는 두지 않는다. */
export async function listPaidTopups(
  limit = 100,
): Promise<(TopupRow & { createdAt: string; settledAt: string | null })[]> {
  const { rows } = await pool.query(
    `SELECT payment_id AS "paymentId", credits, amount_krw AS "amountKrw", status,
            requested_by AS "requestedBy", created_at AS "createdAt", settled_at AS "settledAt"
       FROM credit_topup
      WHERE status = 'paid'
      ORDER BY COALESCE(settled_at, created_at) DESC
      LIMIT $1`,
    [limit],
  );
  return rows as (TopupRow & { createdAt: string; settledAt: string | null })[];
}

/** 결제 확정. 이미 paid 면 false — 웹훅이 여러 번 와도 한 번만 처리된다. */
/**
 * 충전 주문의 최종 상태를 찍는다.
 *
 * ⚠️ 조건이 `status = 'pending'` 이 아니라 **`status <> 'paid'`** 인 이유:
 * 결제 호출이 던졌다고 카드가 안 긁힌 게 아니다(포트원 승인 후 타임아웃이 대표적). 그때
 * 라우트는 주문을 'failed' 로 찍는데, 잠시 뒤 포트원 웹훅이 "이거 결제됐다" 며 온다.
 * 예전 조건에서는 'failed' 행이 **0행 갱신**으로 튕겨서 웹훅이 `"이미 처리됨"` 을 돌려주고
 * 200 으로 끝냈다 — 돈은 나갔는데 크레딧은 없고 로그는 처리됐다고 말하는 상태.
 * failed → paid 전이를 허용해야 웹훅이 진실을 반영할 수 있다.
 *
 * 멱등의 **정본은 이 컬럼이 아니라 `credit_ledger.dedupe_key`** 다. 이 함수의 반환값은
 * "내가 상태를 바꿨나" 일 뿐, "크레딧을 줬나" 가 아니다 — 그렇게 읽으면 안 된다.
 */
export async function markTopupPaid(paymentId: string, status: "paid" | "failed"): Promise<boolean> {
  const r = await pool.query(
    `UPDATE credit_topup SET status = $2, settled_at = now()
      WHERE payment_id = $1 AND status <> 'paid'`,
    [paymentId, status],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── cleanup ────────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  await pool.end();
}

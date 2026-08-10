/**
 * Postgres-backed job queue.
 *
 * The API (Cloud Run) only ever *enqueues* — a single INSERT inside the request, so
 * it survives the CPU throttling that kills anything started after a response. The
 * worker (a small VM, `worker.ts`) is what actually runs jobs, with no 600s request
 * ceiling, which the heavy pipeline stages will need.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED: two workers can never take the same job, so
 * scaling out is just starting another process.
 */
import { getPool, getRawPool } from "./db-pg.ts";
import { runAsSystem } from "./tenant.ts";

export type JobType =
  | "channel.analyze"
  | "video.analyze"
  | "video.hotwatch"
  | "video.comments"
  // Content pipeline (uploaded episodes): STT → refine → scenes → vision → shorts.
  // Distinct from the video.* YouTube-analytics jobs above.
  | "content.analyze"
  // Ingest: yt-dlp a YouTube URL on the worker VM → GCS → content.analyze.
  | "youtube.download"
  // Lab: 선택한 숏폼들이 롱폼의 어느 구간에서 나왔는지 오디오 정렬로 추적.
  | "match.align"
  // Lab: 매칭된 구간의 자막·장면요약을 채워 LEARN 입력을 완성.
  | "match.segment"
  // Lab: 채널 매칭 데이터에서 고성과 규칙을 학습해 채널 프로파일 저장.
  | "match.learn"
  // Distribution: resumable-upload a rendered clip to a connected YouTube channel.
  | "distribution.publish"
  // 콘텐츠 공장: 소스 영상 하나 → 분석·채택·렌더·배포까지 완주시키는 상태기계.
  // 한 걸음 전진하고 재큐한다 — 16분짜리 분석을 기다리며 워커를 붙잡지 않기 위해.
  | "factory.orchestrate"
  // 공장: private 로 올린 영상을 유예 후 공개로 전환 (되돌릴 시간을 벌기 위한 장치).
  | "factory.publicize"
  // 썸네일: 프로그램 채널의 기존 썸네일을 모아 스타일 프로파일을 만든다 (프로그램당 1회성).
  | "thumbnail.style"
  // 썸네일: 회차 1건 → 후보 N장. 인물은 사람이 등록한 사진에서만 가져온다.
  | "thumbnail.generate"
  // GEBD: 장면 경계 탐지 (mmaction2). content.analyze 가 boundaries 필요 구간에 enqueue
  // → GEBD 전용 T4 GPU VM 이 픽업 → boundaries.json GCS 업로드 → content.analyze 재개.
  // 별도 lane (WORKER_JOBS=gebd) · 다른 워커는 이 잡을 claim 하지 않는다.
  | "gebd.detect";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lockedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * 이 잡이 누구의 일인가. 워커는 잡을 **시스템 스코프로 집은 뒤** 이 값으로 컨텍스트를
   * 세우고 핸들러를 돌린다 — 그래야 핸들러 안의 모든 DB 접근이 그 테넌트로 제한된다.
   */
  tenantId: string;
}

/** A job stuck in `running` this long is assumed to be a crashed worker. */
const STALE_LOCK_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

// Captured in the node-pg-migrate baseline (migrations/0001_baseline.cjs). Safety net
// only — new schema changes go in NEW numbered migrations, not here. Both are IF NOT
// EXISTS and coexist. See docs/ops/migrations.md.
export async function initQueue(): Promise<void> {
  // 기동 시 스키마 부트스트랩 — 테넌트 컨텍스트 밖이라 스코프 없는 풀을 쓴다.
  const pool = getRawPool();
  await pool.query(`
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
  `);

  // Keeps a channel from piling up N identical jobs when the scheduler ticks while a
  // previous run is still queued. Only in-flight rows collide, so a finished job can
  // be enqueued again.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe
      ON job_queue(dedupeKey)
      WHERE dedupeKey IS NOT NULL AND status IN ('pending', 'running');
  `);
}

/** Returns the job id, or null when an identical job is already in flight. */
// 재시도 폭탄 방지: 무거운/비싼 잡은 낮게 상한. 일반 잡은 기존 5 유지.
// 2026-08-06 로컬 실측에서 content.analyze 가 chyron 트랩으로 두 번 자동 재실행 →
// PPL 이 두 번 돌아 회당 ~₩60 낭비. 이런 케이스는 사람 개입이 정답.
const MAX_ATTEMPTS_BY_TYPE: Partial<Record<JobType, number>> = {
  "content.analyze": 2,
  // 이미지 생성은 호출당 과금이라 재시도를 아낀다. 실패는 대개 입력 문제(인물 미등록)라
  // 반복해도 같은 결과다 — 사람이 고쳐야 한다.
  "thumbnail.generate": 2,
  "thumbnail.style": 2,
};

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {},
): Promise<string | null> {
  const now = Date.now();
  const id = `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS_BY_TYPE[type] ?? 5;

  const { rows } = await getPool().query(
    `INSERT INTO job_queue (id, type, payload, status, runAfter, dedupeKey, maxAttempts, createdAt, updatedAt)
     VALUES ($1, $2, $3::jsonb, 'pending', $4, $5, $6, $7, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, type, JSON.stringify(payload), now + (opts.delayMs ?? 0), opts.dedupeKey ?? null, maxAttempts, now],
  );
  return rows[0]?.id ?? null;
}

/**
 * Take the next due job. SKIP LOCKED means concurrent workers step over each other's
 * rows instead of blocking, so this is safe to call from many processes at once.
 */
export function claimJob(types?: JobType[]): Promise<Job | null> {
  // 큐 픽업은 **전 테넌트 횡단이 본래 목적**이다 — 워커는 다음 잡이 누구 것인지 모른 채 집는다.
  // 그래서 시스템 스코프로 돌리고, 집은 뒤 job.tenantId 로 컨텍스트를 세운다(worker.ts).
  return runAsSystem(() => claimJobInner(types));
}

async function claimJobInner(types?: JobType[]): Promise<Job | null> {
  const now = Date.now();
  // Optional lane filter: a worker claims ONLY its job types, so content and YouTube work
  // drain on separate processes without starving each other (SKIP LOCKED keeps them from
  // ever touching the same row). No filter → claim any type (single-worker fallback).
  const laneFilter = types && types.length ? "AND type = ANY($2::text[])" : "";
  const params: unknown[] = types && types.length ? [now, types] : [now];
  const { rows } = await getPool().query(
    `UPDATE job_queue SET
       status    = 'running',
       attempts  = attempts + 1,
       lockedAt  = $1,
       updatedAt = $1
     WHERE id = (
       SELECT id FROM job_queue
        WHERE status = 'pending' AND runAfter <= $1 AND attempts < maxAttempts ${laneFilter}
        ORDER BY runAfter ASC, createdAt ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id, type, payload, status, attempts,
               maxattempts AS "maxAttempts", runafter AS "runAfter",
               lockedat AS "lockedAt", error,
               createdat AS "createdAt", updatedat AS "updatedAt",
               tenant_id AS "tenantId"`,
    params,
  );
  return (rows[0] as Job | undefined) ?? null;
}

export async function completeJob(id: string): Promise<void> {
  const now = Date.now();
  await getPool().query(
    `UPDATE job_queue SET status = 'done', error = NULL, lockedAt = NULL, updatedAt = $2 WHERE id = $1`,
    [id, now],
  );
}

/**
 * Bump a running job's lock timestamp so `requeueStale` doesn't reclaim a job that is
 * still legitimately executing. Long jobs (content.analyze can exceed STALE_LOCK_MS on a
 * long master) MUST heartbeat, or the 30-min sweep hands the row back to another worker
 * mid-run and the two race on the same media work dir.
 *
 * `expectedLockedAt` is the lock value THIS worker last wrote (claim time, then whatever the
 * previous beat returned). The update is guarded on it, so once `requeueStale` reclaims the
 * row and another worker re-locks it (new lockedAt), a straggler beat from the old owner
 * matches nothing and is a no-op — it can never resurrect a reassigned job. Returns the new
 * lock value on success, or null when the row is gone / no longer owned (caller stops beating).
 */
export async function heartbeatJob(id: string, expectedLockedAt: number): Promise<number | null> {
  const now = Date.now();
  const { rows } = await getPool().query(
    `UPDATE job_queue SET lockedAt = $2, updatedAt = $2
       WHERE id = $1 AND status = 'running' AND lockedAt = $3
       RETURNING lockedat AS "lockedAt"`,
    [id, now, expectedLockedAt],
  );
  return rows.length ? (rows[0] as { lockedAt: number }).lockedAt : null;
}

/**
 * Reschedule with exponential backoff, or give up once maxAttempts is spent.
 * A dead job stays in the table — it is the record of what broke.
 */
export async function failJob(id: string, error: string): Promise<void> {
  const now = Date.now();
  const { rows } = await getPool().query(
    `SELECT attempts, maxattempts AS "maxAttempts" FROM job_queue WHERE id = $1`,
    [id],
  );
  const job = rows[0] as { attempts: number; maxAttempts: number } | undefined;
  if (!job) return;

  const exhausted = job.attempts >= job.maxAttempts;
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);

  // status = 'running' guard: only the row's live run may fail it. Without this, a
  // straggler failJob (e.g. the catch firing after completeJob already succeeded)
  // would flip a 'done' row back to 'pending' and re-run a finished job.
  await getPool().query(
    `UPDATE job_queue SET
       status    = $2,
       runAfter  = $3,
       lockedAt  = NULL,
       error     = $4,
       updatedAt = $5
     WHERE id = $1 AND status = 'running'`,
    [id, exhausted ? "failed" : "pending", now + backoff, error.slice(0, 1000), now],
  );
}

/**
 * A worker that dies mid-job leaves its row locked forever — hand those back.
 * A crash never reaches failJob, so exhaustion must be enforced here too: a job whose
 * attempts are spent goes to 'failed' instead of 'pending', or a job that OOM-kills the
 * worker would crash-loop forever (claimJob's attempts filter is the second half of this).
 */
export function requeueStale(): Promise<number> {
  // 죽은 워커 회수 — 테넌트를 가리지 않는 운영 작업.
  return runAsSystem(requeueStaleInner);
}

async function requeueStaleInner(): Promise<number> {
  const now = Date.now();
  const { rowCount } = await getPool().query(
    `UPDATE job_queue SET
       status    = CASE WHEN attempts >= maxAttempts THEN 'failed' ELSE 'pending' END,
       error     = CASE WHEN attempts >= maxAttempts
                        THEN COALESCE(error, 'worker died mid-job (attempts exhausted)')
                        ELSE error END,
       lockedAt  = NULL,
       updatedAt = $1
      WHERE status = 'running' AND lockedAt IS NOT NULL AND lockedAt < $2`,
    [now, now - STALE_LOCK_MS],
  );
  return rowCount ?? 0;
}

/**
 * Last time a job with this dedupeKey finished ('done'). Lets due-checks gate on "when did
 * we last TRY" rather than on data rows a zero-result run never writes (e.g. video.comments
 * on a video with no comments would otherwise be "due" on every sweep forever).
 */
export async function lastDoneJobAt(type: JobType, dedupeKey: string): Promise<number | null> {
  const { rows } = await getPool().query(
    `SELECT MAX(updatedAt) AS t FROM job_queue
      WHERE type = $1 AND dedupeKey = $2 AND status = 'done'`,
    [type, dedupeKey],
  );
  const t = rows[0]?.t;
  return t == null ? null : Number(t);
}

/**
 * List individual jobs for the ops dashboard — newest activity first. Postgres lowercases
 * unquoted identifiers, so every camelCase column is aliased (same as claimJob's RETURNING).
 */
export async function listJobs(limit = 100): Promise<Job[]> {
  const { rows } = await getPool().query(
    `SELECT id, type, payload, status, attempts,
            maxattempts AS "maxAttempts", runafter AS "runAfter",
            lockedat AS "lockedAt", error,
            createdat AS "createdAt", updatedat AS "updatedAt"
       FROM job_queue
      ORDER BY updatedAt DESC
      LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return rows as Job[];
}

export async function queueStats(): Promise<Record<JobStatus, number>> {
  const { rows } = await getPool().query(
    `SELECT status, COUNT(*)::int AS n FROM job_queue GROUP BY status`,
  );
  const stats = { pending: 0, running: 0, done: 0, failed: 0 } as Record<JobStatus, number>;
  for (const r of rows as { status: JobStatus; n: number }[]) stats[r.status] = r.n;
  return stats;
}

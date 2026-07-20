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
import { getPool } from "./db-pg.ts";

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
  // Distribution: resumable-upload a rendered clip to a connected YouTube channel.
  | "distribution.publish";

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
}

/** A job stuck in `running` this long is assumed to be a crashed worker. */
const STALE_LOCK_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

// Captured in the node-pg-migrate baseline (migrations/0001_baseline.cjs). Safety net
// only — new schema changes go in NEW numbered migrations, not here. Both are IF NOT
// EXISTS and coexist. See docs/ops/migrations.md.
export async function initQueue(): Promise<void> {
  const pool = getPool();
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
export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; delayMs?: number } = {},
): Promise<string | null> {
  const now = Date.now();
  const id = `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const { rows } = await getPool().query(
    `INSERT INTO job_queue (id, type, payload, status, runAfter, dedupeKey, createdAt, updatedAt)
     VALUES ($1, $2, $3::jsonb, 'pending', $4, $5, $6, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, type, JSON.stringify(payload), now + (opts.delayMs ?? 0), opts.dedupeKey ?? null, now],
  );
  return rows[0]?.id ?? null;
}

/**
 * Take the next due job. SKIP LOCKED means concurrent workers step over each other's
 * rows instead of blocking, so this is safe to call from many processes at once.
 */
export async function claimJob(types?: JobType[]): Promise<Job | null> {
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
               createdat AS "createdAt", updatedat AS "updatedAt"`,
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
export async function requeueStale(): Promise<number> {
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

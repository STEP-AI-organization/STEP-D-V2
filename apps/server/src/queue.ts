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
  | "content.analyze";

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

// Also captured in the node-pg-migrate baseline (migrations/1784246400000_baseline-*.cjs).
// Both are IF NOT EXISTS and coexist as a safety net — keep them in sync. See docs/ops/migrations.md.
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
        WHERE status = 'pending' AND runAfter <= $1 ${laneFilter}
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

  await getPool().query(
    `UPDATE job_queue SET
       status    = $2,
       runAfter  = $3,
       lockedAt  = NULL,
       error     = $4,
       updatedAt = $5
     WHERE id = $1`,
    [id, exhausted ? "failed" : "pending", now + backoff, error.slice(0, 1000), now],
  );
}

/** A worker that dies mid-job leaves its row locked forever — hand those back. */
export async function requeueStale(): Promise<number> {
  const now = Date.now();
  const { rowCount } = await getPool().query(
    `UPDATE job_queue SET status = 'pending', lockedAt = NULL, updatedAt = $1
      WHERE status = 'running' AND lockedAt IS NOT NULL AND lockedAt < $2`,
    [now, now - STALE_LOCK_MS],
  );
  return rowCount ?? 0;
}

export async function queueStats(): Promise<Record<JobStatus, number>> {
  const { rows } = await getPool().query(
    `SELECT status, COUNT(*)::int AS n FROM job_queue GROUP BY status`,
  );
  const stats = { pending: 0, running: 0, done: 0, failed: 0 } as Record<JobStatus, number>;
  for (const r of rows as { status: JobStatus; n: number }[]) stats[r.status] = r.n;
  return stats;
}

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
  // 네이버 TV 업로드 — 공개 API 가 없어 브라우저 자동화. `naver` 레인(사무실 PC) 전용.
  | "naver.publish"
  | "channel.analyze"
  | "video.analyze"
  | "video.hotwatch"
  | "video.comments"
  // Content pipeline (uploaded episodes): STT → refine → scenes → vision → shorts.
  // Distinct from the video.* YouTube-analytics jobs above.
  | "media.prepare"
  | "content.analyze"
  // AI Shorts reframing: clip-only proxy + face/safety planner (content worker).
  | "clip.reframe"
  /**
   * 클립 렌더(ffmpeg 인코딩)를 **사무실 PC 로 넘기는** 잡. 2026-08-31 신설.
   *
   * 왜 잡인가: 렌더는 CPU 를 통째로 쓰는 유일한 일이고(건당 50~90초), 그래서 순방이
   * `AUTOMATION_MAX_RENDERS_PER_TICK=8` 로 스스로를 묶고 있다. 노는 사무실 PC(8코어)에
   * 넘기면 그 상한이 풀린다. **클라우드에서 WIN2 로 밀어넣을 수는 없으므로**(NAT 뒤 ·
   * deploy-win2.md "밀지 않고 당긴다") 큐에 놓고 당겨가게 한다.
   *
   * 핸들러는 렌더를 **직접 하지 않는다** — 로컬 서버의 `/api/clips/:id/export` 를 부른다.
   * 렌더 로직(자막·훅 프리롤·오버레이)이 그 라우트에 있고, 워커에서 복제하면 두 벌이 갈라진다.
   */
  | "clip.render"
  // 세로 4택 비교(vertical-candidates-v1): 후보 4종 plan + contact sheet + 프록시를
  // 임시 GCS 경로에 만든다. 정식 clip.reframe 상태는 건드리지 않는다(비교 뷰어 전용).
  | "reframe.compare"
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
  // 이미 발행된 영상의 제목·설명·태그를 라이브에 반영 (videos.update · part=snippet).
  // 재업로드가 아니다 — 발행된 건은 재발행 대신 이걸로만 고친다(중복 공개 방지). youtube 레인.
  | "distribution.updatemeta"
  // 예약 게시 확인 — 예약(scheduled)으로 올린 영상이 실제로 공개됐는지 유튜브에 되묻는다.
  // 안 되물으면 배포 화면이 "예약됨" 에 영구 고정된다(AENA youtube-reconcile.job 이식).
  | "youtube.reconcile"
  // 콘텐츠 공장: 소스 영상 하나 → 분석·채택·렌더·배포까지 완주시키는 상태기계.
  // 한 걸음 전진하고 재큐한다 — 16분짜리 분석을 기다리며 워커를 붙잡지 않기 위해.
  // 자동 배포 순방 — **테넌트별로** 하나씩 돈다(격리가 곧 잡 분리다).
  | "automation.cycle"
  | "factory.orchestrate"
  // 공장: private 로 올린 영상을 유예 후 공개로 전환 (되돌릴 시간을 벌기 위한 장치).
  | "factory.publicize"
  // 썸네일: 프로그램 채널의 기존 썸네일을 모아 스타일 프로파일을 만든다 (프로그램당 1회성).
  // 채택 시 채널별 업로드 메타를 미리 만든다 — 발행 모달이 빈칸 없이 열리게.
  | "clip.metadata"
  | "thumbnail.style"
  // 썸네일: 회차 1건 → 후보 N장. 인물은 사람이 등록한 사진에서만 가져온다.
  | "thumbnail.generate"
  // 네이버 자동 로그인 — 저장된 자격증명으로 세션을 되살린다(만료 때마다 사람을 부르지
  // 않으려는 것). 브라우저가 필요해 **naver 레인**(윈도우2)에서만 돈다.
  | "naver.login"
  // 커머스: 클립의 상품 쿼리로 쿠팡 제휴 링크를 발급한다 (`COMMERCE_LINKS_ENABLED` 게이트).
  // 로그인된 파트너스 콘솔을 브라우저로 몰기 때문에 **머신 전용 레인**(commerce)이다.
  // 최종승인(누적 판매 15만원) 후 공식 딥링크 API 로 바뀌면 클라우드 레인으로 옮긴다.
  | "commerce.link"
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
  "clip.reframe": 2,
  "reframe.compare": 2,
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
  const laneFilter = types && types.length ? "AND q.type = ANY($2::text[])" : "";
  const params: unknown[] = types && types.length ? [now, types] : [now];

  // 정지된 회사의 잡은 집지 않는다 (0단계 · 회사 정지 실효화).
  //
  // 여기가 **모든 잡이 반드시 지나는 유일한 길목**이라 큐잉 경로가 몇 개든 상관없이 막힌다.
  // 큐잉 시점 차단만으로는 이미 큐에 들어와 있던 잡을 못 막는데, 정지는 보통 잡이 쌓인
  // 뒤에 걸린다.
  //
  // 실패하는 게 아니라 **건너뛴다** — 회사가 다시 active 가 되면 그대로 이어서 돈다.
  //
  // ⚠️ `NOT EXISTS (… AND status <> 'active')` 지, `EXISTS (… AND status = 'active')` 가
  // 아니다. 시스템 스코프 잡은 tenant_id 가 '*' 라 tenants 에 행이 없다 — 후자로 쓰면
  // **시스템 잡이 전부 영영 안 돈다.** 여기서는 "모르면 통과"가 맞고, 모르는 tenant_id 로
  // 잡을 넣는 경로는 시스템 자신뿐이다.
  const suspendedFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM tenants t
           WHERE t.id = q.tenant_id AND t.status <> 'active'
        )`;

  // 회사 공정성 (5단계). 순수 FIFO 면 **한 회사가 큐를 독점한다** — A 가 100건을 먼저
  // 넣으면 그 뒤에 온 B 의 1건은 100건이 다 끝날 때까지 기다린다. 회사가 하나일 땐 안
  // 아프지만 늘면 바로 "우리 것만 왜 안 도나"가 된다.
  //
  // 정렬 1순위를 **그 회사가 마지막으로 잡을 집힌 시각**으로 둔다. 한 번도 안 집힌 회사는
  // 0 이라 제일 앞에 온다. 같은 회사 안에서는 기존대로 FIFO 다.
  //
  // 실측(로컬 PG · A 100건 선점 + B·C 1건씩): FIFO 는 앞 10건이 전부 A 였고,
  // 이 정렬은 A=8 · B·C 가 각각 2·3번째에 차례를 받았다.
  //
  // 굶기지 않는 것이 목적이지 균등 분배가 아니다 — A 가 여전히 대부분을 가져가되,
  // B 가 **무한정 밀리지 않는다**는 것만 보장한다.
  const fairOrder = `
        COALESCE((
          SELECT MAX(s.lockedAt) FROM job_queue s
           WHERE s.tenant_id = q.tenant_id AND s.lockedAt IS NOT NULL
        ), 0) ASC,`;

  const { rows } = await getPool().query(
    `UPDATE job_queue SET
       status    = 'running',
       attempts  = attempts + 1,
       lockedAt  = $1,
       updatedAt = $1
     WHERE id = (
       SELECT q.id FROM job_queue q
        WHERE q.status = 'pending' AND q.runAfter <= $1
          AND q.attempts < q.maxAttempts ${laneFilter}${suspendedFilter}
        ORDER BY ${fairOrder} q.runAfter ASC, q.createdAt ASC
        FOR UPDATE OF q SKIP LOCKED
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
    // 4000자. 예전 1000자는 파이썬 스택트레이스나 stderr 꼬리를 잘라먹었다 —
    // 잡이 왜 죽었는지가 컬럼 안에서 끝나야 운영자가 로그를 뒤지지 않는다.
    [id, exhausted ? "failed" : "pending", now + backoff, error.slice(0, 4000), now],
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

/**
 * 대기 중인 잡을 **타입별로** 센다.
 *
 * `queueStats()` 는 상태별 4개 정수라 "pending 51" 까지만 알려준다. 그런데 워커 레인은
 * 4개(content·youtube·gebd·naver)라, 어느 레인이 막혔는지 구분할 수 없다 — 장애 대응의
 * 첫 질문에 답을 못 한다.
 *
 * ⚠️ 이 함수가 없어서 실제로 라우트 하나가 죽어 있었다. `/api/admin/worker-vm/wake` 가
 * `queueStats().pending_by_type` 이라는 **존재하지 않는 필드**를 읽어 항상 0 을 세고
 * "no pending jobs" 를 돌려줬다(2026-08-12 발견). 가정하지 말고 실제로 세게 한다.
 */
export async function pendingByType(): Promise<Record<string, number>> {
  const { rows } = await getPool().query(
    `SELECT type, COUNT(*)::int AS n FROM job_queue WHERE status = 'pending' GROUP BY type`,
  );
  const out: Record<string, number> = {};
  for (const r of rows as { type: string; n: number }[]) out[r.type] = r.n;
  return out;
}

/** 가장 오래 기다린 대기 잡의 나이(ms). 없으면 0. 큐가 흐르는지 보는 가장 빠른 신호다. */
export async function oldestPendingAgeMs(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT MIN(runAfter)::bigint AS oldest FROM job_queue WHERE status = 'pending'`,
  );
  const oldest = Number(rows[0]?.oldest ?? 0);
  return oldest > 0 ? Math.max(0, Date.now() - oldest) : 0;
}

/**
 * 특정 타입의 가장 오래 기다린 대기 잡 나이(ms). 없으면 0.
 *
 * 전용 머신에 넘긴 잡이 **아무도 안 집어가고 있는지**를 보는 신호다 — 사무실 PC 가 꺼져
 * 있으면 `clip.render` 가 쌓이기만 한다. 그때 클라우드가 대신 하도록 판단하는 근거.
 */
export async function oldestPendingAgeForType(type: JobType): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT MIN(runAfter)::bigint AS oldest FROM job_queue WHERE status = 'pending' AND type = $1`,
    [type],
  );
  const oldest = Number(rows[0]?.oldest ?? 0);
  return oldest > 0 ? Math.max(0, Date.now() - oldest) : 0;
}

/**
 * 이 dedupeKey 로 **가장 최근에 만들어진** 잡 한 건. 없으면 null.
 *
 * 잡으로 넘긴 일의 결과를 넘긴 쪽이 되읽는 통로다. 이게 없으면 "큐에 넣었다" 까지만 알고
 * **그 뒤에 영구 실패했는지를 영영 모른다** — 넣은 쪽은 성공으로 알고 계속 다시 넣는다
 * (2026-08-31 clip.render 에서 실제로 그럴 뻔했다).
 */
export async function lastJobByDedupe(
  type: JobType, dedupeKey: string,
): Promise<{ status: JobStatus; error: string | null; attempts: number; updatedAt: number } | null> {
  const { rows } = await getPool().query(
    `SELECT status, error, attempts, updatedAt AS "updatedAt" FROM job_queue
      WHERE type = $1 AND dedupeKey = $2
      ORDER BY createdAt DESC LIMIT 1`,
    [type, dedupeKey],
  );
  const r = rows[0];
  return r
    ? { status: r.status as JobStatus, error: r.error ?? null, attempts: Number(r.attempts ?? 0), updatedAt: Number(r.updatedAt ?? 0) }
    : null;
}

export async function queueStats(): Promise<Record<JobStatus, number>> {
  const { rows } = await getPool().query(
    `SELECT status, COUNT(*)::int AS n FROM job_queue GROUP BY status`,
  );
  const stats = { pending: 0, running: 0, done: 0, failed: 0 } as Record<JobStatus, number>;
  for (const r of rows as { status: JobStatus; n: number }[]) stats[r.status] = r.n;
  return stats;
}

/**
 * 큐 적체 즉시 킥 — content 워커(Cloud Run Job)를 enqueue 시점에 실행한다 (2026-09-16 · 서지 대응).
 *
 * 왜: content 워커는 Cloud Scheduler 15분 틱으로만 깨어나, 서지(여러 회차 동시 유입) 때 분석
 * 착수가 최대 15분 밀렸다. 잡이 들어오는 순간 `jobs:run`(taskCount=4 오버라이드)을 불러 착수
 * 지연을 초 단위로 줄인다. Job 템플릿은 **tasks=1 · parallelism=4** (2026-09-16 gcloud 적용 ·
 * cloud.sh 는 이 값을 안 건드린다) — 빈 스케줄 틱은 1태스크로 싸게, 킥 실행만 4병렬로 뜬다.
 *
 * 실패 방향 안전: 이 모듈의 어떤 실패도 enqueue 를 막지 않는다(warn 1줄 · fire-and-forget).
 * 스케줄러 틱이 15분 내 안전망으로 처리한다. 로컬·워커 프로세스에서는 아예 안 나간다(게이트).
 *
 * ⚠️ import 0 개의 잎 모듈로 유지할 것 — queue.ts 가 정적 import 하므로 여기서 db-pg 등을
 * 물면 queue → kick → db-pg → pipeline/* → queue 순환이 생긴다.
 */

/** 킥 대상 — worker.ts JOB_LANES.content 와 **같은 목록**이어야 한다(worker-kick.test.ts 가
 *  소스 스캔으로 대조). 다른 레인(youtube·머신 전용)은 킥하지 않는다 — content Job 을
 *  깨워봐야 그 레인 잡을 못 집는다. */
export const KICK_TYPES: ReadonlySet<string> = new Set([
  "media.transcode", "media.prepare", "content.analyze", "match.align", "match.segment",
  "match.learn", "thumbnail.style", "thumbnail.generate", "clip.metadata", "clip.reframe",
  "reframe.compare", "clip.subblur",
]);

/** 디바운스 간격 — 이 안의 연속 enqueue(서지의 정체)는 첫 킥의 4태스크가 함께 소화한다.
 *  태스크는 큐가 빌 때까지 안 죽으므로(드레인) 뒤따르는 잡도 즉시 잡힌다. */
export const KICK_MIN_INTERVAL_MS = 60_000;

/** 순수 판정 — 테스트용 export. */
export function shouldKick(now: number, lastKickAt: number): boolean {
  return now - lastKickAt >= KICK_MIN_INTERVAL_MS;
}

let lastKickAt = 0;

/**
 * content 레인 잡이 큐에 들어왔다 — 필요하면 워커를 즉시 깨운다. 동기 반환(잡 삽입을 안 막는다).
 *
 * 게이트: `K_SERVICE` 는 Cloud Run **서비스**(stepd-server·stepd-render)에만 있다.
 * 워커 Job(`CLOUD_RUN_JOB`)·GPU VM·로컬은 스킵 — 워커발 재큐(post-gebd 등)가 자기 자신을
 * 증식시키지 않고, 로컬 dev 는 프로덕션 워커를 깨우지 않는다. WORKER_JOBS 로 판별하지 않는
 * 이유: `all` 워커는 그 env 없이 뜬다.
 */
export function maybeKickContentWorker(type: string): void {
  if (!KICK_TYPES.has(type)) return;
  if (!process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) return;
  const now = Date.now();
  if (!shouldKick(now, lastKickAt)) return;
  lastKickAt = now;
  void runKick().catch((e) => {
    console.warn("[worker-kick] 실패(스케줄러 틱이 15분 내 처리):", String(e).slice(0, 200));
  });
}

/** Cloud Run 메타데이터 서버 액세스 토큰 — index.ts gebd-vm/wake 와 같은 패턴(raw fetch). */
async function metadataToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function runKick(): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT || "step-d";
  const region = process.env.WORKER_KICK_REGION || "us-central1";
  const job = process.env.WORKER_KICK_JOB || "stepd-worker-content";
  const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}:run`;
  const token = await metadataToken();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  // taskCount 는 pending 을 세지 않고 4 고정. 남는 태스크는 드레인이라 수 초에 끝난다(킥당
  // ~₩6) — 세는 쿼리(runAsSystem+DB)가 아끼는 돈보다 비싸고, DB 를 물면 잎이 아니게 된다.
  let res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({ overrides: { taskCount: 4 } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 403) {
    // runWithOverrides 권한이 없는 환경 — 오버라이드 없이 1태스크라도 즉시 띄운다.
    res = await fetch(url, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(5_000) });
  }
  if (!res.ok) {
    throw new Error(`jobs:run ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  console.log("[worker-kick] content 워커 즉시 실행 (tasks=4)");
}

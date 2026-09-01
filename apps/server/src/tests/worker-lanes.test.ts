/**
 * 워커 레인 불변식 — **모든 잡 타입은 실제로 도는 레인에 속한다.**
 *
 * 이 파일이 존재하는 이유는 하나다. 2026-08-12 에 `thumbnail.style`·`thumbnail.generate` 가
 * 어느 레인에도 없이 `ALL_LANE_TYPES`(= `WORKER_JOBS=all` 워커만 집는 목록)에만 있었다.
 * 그런데 프로덕션에 뜨는 워커는 `content` 와 `youtube` 뿐이라 **아무도 그 잡을 claim 하지
 * 않았다.** 라우트는 `{jobId}` 로 성공을 돌려주므로 화면에는 "생성 중" 으로만 보이고,
 * 큐에는 영원히 pending 으로 남았다.
 *
 * 증상이 "실패" 가 아니라 "무반응" 이라 로그에도 아무것도 안 찍힌다. 사람이 눈치채는 경로가
 * 없다 — 그래서 테스트로 잠근다. **잡 타입을 새로 추가하면 여기서 걸린다.**
 *
 * 순수 함수로 증명할 수 없는 종류라 `publish-guard.test.ts` 의 소스 스캔 관용구를 따른다:
 * 파일을 읽어 선언을 파싱하고, 어긋나면 `무엇이` 빠졌는지 이름으로 보고한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

/** `queue.ts` 의 JobType 유니온에서 잡 타입 전부를 뽑는다. */
function declaredJobTypes(): string[] {
  const src = read("pipeline/queue.ts");
  const m = src.match(/export type JobType\s*=([\s\S]*?);/);
  assert.ok(m, "queue.ts 에서 JobType 유니온을 못 찾았다 — 이 테스트의 파싱을 고쳐야 한다");
  return [...new Set([...m![1].matchAll(/"([a-z]+\.[a-z]+)"/g)].map((x) => x[1]))].sort();
}

/** `worker.ts` 의 JOB_LANES 를 레인별 타입 목록으로 파싱한다. */
function lanes(): Record<string, string[]> {
  const src = read("worker.ts");
  const m = src.match(/const JOB_LANES[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(m, "worker.ts 에서 JOB_LANES 를 못 찾았다");
  const out: Record<string, string[]> = {};
  for (const [, lane, body] of m![1].matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
    out[lane] = [...body.matchAll(/"([a-z]+\.[a-z]+)"/g)].map((x) => x[1]);
  }
  return out;
}

describe("워커 레인 — 잡이 큐에 갇히지 않는다", () => {
  it("모든 JobType 이 어느 레인엔가 속한다", () => {
    const declared = declaredJobTypes();
    const assigned = new Set(Object.values(lanes()).flat());
    const orphans = declared.filter((t) => !assigned.has(t));
    assert.deepEqual(
      orphans, [],
      `레인 없는 잡 타입: ${orphans.join(", ")} — 큐잉은 되는데 아무 워커도 claim 하지 않는다. ` +
      "worker.ts 의 JOB_LANES 에 넣을 것.",
    );
  });

  it("레인은 서로 겹치지 않는다 — 두 워커가 같은 잡을 다투면 안 된다", () => {
    const l = lanes();
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [lane, types] of Object.entries(l)) {
      for (const t of types) {
        const prev = seen.get(t);
        if (prev) dupes.push(`${t} (${prev} · ${lane})`);
        else seen.set(t, lane);
      }
    }
    assert.deepEqual(dupes, [], `여러 레인에 중복 배정된 잡: ${dupes.join(" / ")}`);
  });

  it("ALL_LANE_TYPES 는 머신 전용 레인(gebd·naver·download)을 포함하지 않는다", () => {
    // "all" 워커가 GPU 나 한국 IP 가 필요한 잡을 집으면 100% 실패한다.
    // 2026-08-11 에 실제로 all 워커가 naver.publish 를 집어가 재시도만 쌓였다.
    // 2026-08-14 부터 youtube.download 도 머신 전용(download 레인) — 데이터센터 IP 는
    // 유튜브 봇 판정에 상시 걸려 윈도우2(한국 IP)만 받을 수 있다.
    const src = read("worker.ts");
    const m = src.match(/ALL_LANE_TYPES[^=]*=\s*\[([\s\S]*?)\];/);
    assert.ok(m, "worker.ts 에서 ALL_LANE_TYPES 를 못 찾았다");
    const inAll = new Set([...m![1].matchAll(/"([a-z]+\.[a-z]+)"/g)].map((x) => x[1]));
    const l = lanes();
    // 스프레드(...JOB_LANES.content 등)로 들어오는 것까지 합쳐서 본다.
    for (const lane of [...m![1].matchAll(/JOB_LANES\.(\w+)/g)].map((x) => x[1])) {
      for (const t of l[lane] ?? []) inAll.add(t);
    }
    const leaked = [...(l.gebd ?? []), ...(l.naver ?? []), ...(l.download ?? [])].filter((t) => inAll.has(t));
    assert.deepEqual(
      leaked, [],
      `머신 전용 잡이 "all" 범위에 샜다: ${leaked.join(", ")} — GPU/한국 IP 가 없는 워커가 집으면 반드시 실패한다.`,
    );
  });
});

describe("파괴적 어드민 라우트는 인가를 거친다", () => {
  /**
   * `requireOpsAccess` 는 만들어져 있었는데 **어디서도 호출되지 않았다**(2026-08-12).
   * 그동안 `/api/admin/reset` 은 `body.confirm === "RESET"` 하나로 전 미디어 행 + GCS 객체를
   * 지울 수 있었다. 정의만 있고 배선이 없는 가드는 없는 것과 같다 — 그걸 테스트가 잡는다.
   */
  const DESTRUCTIVE = [
    "/api/admin/reset",
    "/api/admin/queue/purge",
    "/api/admin/remux/:id",
    "/api/admin/worker-vm/wake",
    "/api/admin/gebd-vm/wake",
  ];

  it("각 라우트 핸들러가 인가 헬퍼를 부른다", () => {
    const src = read("index.ts");
    const missing: string[] = [];
    for (const route of DESTRUCTIVE) {
      const idx = src.indexOf(`app.post("${route}"`);
      if (idx < 0) { missing.push(`${route} (라우트 자체를 못 찾음)`); continue; }
      // 핸들러 앞부분만 본다 — 뒤쪽 다른 라우트의 가드를 잘못 세지 않게.
      // requireOpsOrInternal 은 requireOpsAccess 로 위임하는 가드(머신 호출은 내부 토큰 허용) —
      // 인자가 (c, via) 라 `(c` 로 매칭한다.
      const head = src.slice(idx, idx + 1200);
      if (!/require(OpsAccess|Superadmin|OpsOrInternal)\(c\b/.test(head)) missing.push(route);
    }
    assert.deepEqual(
      missing, [],
      `인가 없이 열려 있는 파괴적 라우트: ${missing.join(", ")}`,
    );
  });
});

/**
 * YouTube OAuth 자격증명은 **그걸 쓰는 레인에서만** 필요하다. 이 목록에서 레인이 빠지면
 * 그 워커는 쓰지도 않을 시크릿을 요구하며 **부팅 즉시 죽는다** — 그런데 작업 스케줄러는
 * Running 으로 보여서 원인이 안 보인다(2026-08-12·08-14 윈도우2 실측, 2026-08-31 render 재발).
 * 세 번 겪었으면 기계가 봐야 한다.
 */
describe("YouTube 시크릿이 필요한 레인 판정", () => {
  const src = fs.readFileSync(path.join(SRC, "worker.ts"), "utf-8");

  it("youtube 잡이 없는 레인은 전부 YT_FREE_LANES 에 있다", () => {
    const m = /const YT_FREE_LANES = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, "YT_FREE_LANES 를 찾지 못했다");
    const free = new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));

    const all = lanes();
    const ytJobs = new Set(all.youtube);
    for (const [lane, jobs] of Object.entries(all)) {
      if (lane === "youtube" || lane === "content") continue;   // 클라우드 레인 — 시크릿이 있다
      const touchesYouTube = jobs.some((j) => ytJobs.has(j));
      if (!touchesYouTube) {
        assert.ok(free.has(lane),
          `레인 '${lane}' 은 YouTube 잡이 없는데 YT_FREE_LANES 에 없다 — 그 워커는 부팅 즉시 죽는다`);
      }
    }
  });
});

#!/usr/bin/env node
/**
 * CI 가 도는 것을 **로컬에서 그대로** 돌린다.
 *
 *   pnpm ci:local           전부 (typecheck · 서버 · 네이티브 · core · 웹빌드 · e2e)
 *   pnpm ci:local --fast    e2e·웹빌드 빼고 (PR 올리기 전 빠른 확인)
 *   pnpm ci:local --no-e2e  DB 가 없을 때
 *
 * ⚠️ 스크립트 이름이 `ci` 가 아니라 `ci:local` 인 이유: **`pnpm ci` 는 pnpm 내장 명령이다**
 *    (`npm ci` 와 같은 lockfile 설치). package.json 에 `"ci"` 를 넣어도 내장이 이기고,
 *    `pnpm ci --fast` 는 `ERROR Unknown option: 'fast'` 로 죽는다(2026-09-11 실측).
 *
 * ## 왜 이게 필요한가
 *
 * CI 는 job 세 개로 갈라져 있다(`check` · `web-build` · `e2e`). 로컬에서 같은 것을 보려면
 * 명령 셋을 따로 알아야 하고, e2e 는 Postgres 컨테이너까지 띄워야 한다. 그걸 모르면
 * **PR 을 올린 뒤에야 CI 에서 처음 안다** — 특히 `pnpm check` 에는 **웹 빌드와 e2e 가 없다.**
 * (`pnpm -r typecheck` 는 `tsc --noEmit` 이라 Next 프리렌더 오류를 못 잡는다.)
 *
 * ## ⚠️ 이 파일이 CI 와 갈라지면 의미가 없다
 *
 * "로컬에선 초록인데 CI 는 빨강" 을 없애려고 만든 건데, 명령이 달라지면 **그 상황을 이 파일이
 * 만들어낸다.** 그래서 `ci-local-parity.test.ts` 가 `.github/workflows/ci.yml` 의 `run:` 줄과
 * 아래 STEPS 를 대조한다 — CI 에 단계를 추가하면 여기도 추가해야 테스트가 통과한다.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * CI 의 각 단계. `cmd` 는 ci.yml 의 `run:` 과 **글자 그대로 같아야 한다**(위 주석 참조).
 * `group` 은 ci.yml 의 job 이름과 짝이 맞는다.
 */
export const STEPS = [
  { group: "check", name: "전 패키지 typecheck", cmd: "pnpm -r typecheck" },
  { group: "check", name: "서버 테스트", cmd: "pnpm --filter @stepd/server --fail-if-no-match test" },
  { group: "check", name: "네이티브 테스트", cmd: "pnpm --filter stepaistudio --fail-if-no-match test" },
  { group: "check", name: "core 파이썬 테스트", cmd: "node scripts/test-core.mjs --required" },
  {
    group: "web-build", name: "웹 빌드",
    cmd: "pnpm --filter @stepd/web --fail-if-no-match build",
    // ci.yml 과 같은 값. 빌드타임에 서버를 부르지 않으므로 실제 주소는 필요 없다.
    env: { NEXT_PUBLIC_API_URL: "/api/proxy/api" },
  },
  { group: "e2e", name: "e2e (Postgres + 진짜 서버)", cmd: "pnpm test:e2e", needsPostgres: true },
];

// ── Postgres ────────────────────────────────────────────────────────────────
const PG_HOST = "127.0.0.1";
const PG_PORT = 5432;
const PG_CONTAINER = "stepd-e2e-pg";
// ⚠️ 그냥 postgres:16 은 안 된다 — 마이그레이션 0009 가 `CREATE EXTENSION vector` 를 쓴다.
const PG_IMAGE = "pgvector/pgvector:pg16";

function tcpOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(port, host);
  });
}

function have(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore", shell: true }).status === 0;
}

/** e2e 용 Postgres 를 확보한다. 이미 떠 있으면 그대로 쓴다. */
async function ensurePostgres() {
  if (await tcpOpen(PG_HOST, PG_PORT)) {
    say(`Postgres 이미 떠 있음 (${PG_HOST}:${PG_PORT}) — 그대로 쓴다`);
    return true;
  }
  if (!have("docker")) {
    warn(`Postgres(${PG_HOST}:${PG_PORT}) 가 없고 docker 도 없다 — e2e 를 건너뛴다.`);
    warn(`  띄우려면: docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres --name ${PG_CONTAINER} ${PG_IMAGE}`);
    return false;
  }
  say(`Postgres 기동 (${PG_IMAGE})…`);
  spawnSync("docker", ["rm", "-f", PG_CONTAINER], { stdio: "ignore", shell: true });
  const up = spawnSync(
    "docker",
    ["run", "--rm", "-d", "-p", `${PG_PORT}:5432`, "-e", "POSTGRES_PASSWORD=postgres", "--name", PG_CONTAINER, PG_IMAGE],
    { stdio: "ignore", shell: true },
  );
  if (up.status !== 0) { warn("docker run 실패 — e2e 를 건너뛴다."); return false; }

  for (let i = 0; i < 60; i++) {
    const ready = spawnSync("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "ignore", shell: true });
    if (ready.status === 0) { say("Postgres 준비됨"); return true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  warn("Postgres 가 60초 안에 안 떴다 — e2e 를 건너뛴다.");
  return false;
}

// ── 출력 ────────────────────────────────────────────────────────────────────
const C = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", off: "\x1b[0m" };
const say = (m) => console.log(`${C.cyan}==>${C.off} ${m}`);
const warn = (m) => console.log(`${C.yellow}  !!${C.off} ${m}`);

function run(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    say(`${step.name}  ${C.dim}${step.cmd}${C.off}`);
    // 윈도우의 pnpm 은 .cmd 셔임이라 shell 이 필요하다. 아래 명령들엔 셸이 다시 해석할
    // 만한 인자(정규식·따옴표)가 없으므로 안전하다 — 그런 인자를 STEPS 에 넣지 말 것.
    const child = spawn(step.cmd, {
      cwd: ROOT, shell: true, stdio: "inherit",
      env: { ...process.env, ...(step.env ?? {}) },
    });
    child.on("exit", (code) => resolve({ ...step, ok: code === 0, code: code ?? 1, ms: Date.now() - t0 }));
    child.on("error", () => resolve({ ...step, ok: false, code: 1, ms: Date.now() - t0 }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const fast = argv.includes("--fast") || argv.includes("--quick");
  const noE2e = argv.includes("--no-e2e") || fast;
  const noWeb = argv.includes("--no-web") || fast;

  let steps = STEPS.filter((s) => !(noE2e && s.group === "e2e") && !(noWeb && s.group === "web-build"));

  if (steps.some((s) => s.needsPostgres) && !(await ensurePostgres())) {
    steps = steps.filter((s) => !s.needsPostgres);
  }

  const results = [];
  for (const step of steps) {
    const r = await run(step);
    results.push(r);
    // 멈추지 않고 끝까지 돌린다 — 한 번에 전부 보는 게 낫다(CI 도 job 을 병렬로 돈다).
  }

  const skipped = STEPS.filter((s) => !steps.includes(s));
  console.log(`\n${C.cyan}== 결과 ==${C.off}`);
  for (const r of results) {
    const mark = r.ok ? `${C.green}PASS${C.off}` : `${C.red}FAIL${C.off}`;
    console.log(`  ${mark}  ${r.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  for (const s of skipped) console.log(`  ${C.yellow}SKIP${C.off}  ${s.name}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${C.red}${failed.length}개 실패${C.off} — ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  if (skipped.length) {
    console.log(`\n${C.yellow}전부 통과 — 단 ${skipped.length}개는 안 돌았다${C.off} (CI 는 이것도 돈다)`);
    process.exit(0);
  }
  console.log(`\n${C.green}전부 통과 — CI 가 도는 것과 같다${C.off}`);
}

// 테스트가 STEPS 만 import 할 수 있게, 직접 실행일 때만 돈다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

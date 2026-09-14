/**
 * 웹 스모크 — **진짜 크롬**이 **진짜 프로덕션 빌드**를 연다.
 *
 * ## 왜 필요했나
 *
 * 웹 관문은 오래 `next build` 하나뿐이었다. 그건 타입과 프리렌더만 본다 — 브라우저에서
 * 실제로 무슨 일이 벌어지는지는 아무도 안 봤다. 이 리포에는 그 공백이 낸 사고가 기록돼 있다:
 * 워커가 프로덕션에서도 tsx 로 돌아 `page.evaluate` 에 넘긴 함수에 esbuild 의 `__name` 이
 * 딸려 갔고, 브라우저에서 전량 실패했다. **유닛 테스트로는 안 잡혔다.**
 *
 * ## 무엇을 검증하고 무엇을 안 하나
 *
 * **동작만 본다 — 화면의 글자·DOM 은 안 본다.** 프론트가 개편 중이라 셀렉터에 걸면 스모크가
 * 매주 빨개지고, 그러면 사람이 무시하게 된다(관문의 죽음). 대신 셀렉터가 바뀌어도 그대로인 것,
 * 그리고 **유닛으로는 증명이 안 되는 것**만 고정한다:
 *
 *   · 미들웨어가 실제로 리다이렉트하는가 (엣지 런타임은 빌드해야만 돈다)
 *   · 부팅 시 `/api/state` 를 부르는가
 *   · 분석이 도는 동안 **`/api/state/progress` 로 갈아타는가** ← 2026-09-14 배선. 서버 쪽은
 *     e2e 가 보지만 클라이언트 쪽 판정(`isActive`·`applyProgress`)은 여기서만 증명된다
 *   · 304 를 받았을 때 화면이 빈 상태로 돌아가지 않는가
 *   · 페이지가 예외를 던지지 않는가
 *
 * 서버는 띄우지 않는다. API 는 Playwright 라우트 가로채기로 흉내낸다 — 이 스모크가 묻는 것은
 * "서버가 맞게 답하는가"(그건 `apps/server` e2e 의 몫)가 아니라 **"브라우저가 맞게 부르는가"** 다.
 *
 * ## 실행
 *
 *   pnpm --filter @stepd/web smoke
 *
 * `NEXT_PUBLIC_API_URL=/api/proxy/api` 로 빌드한다 — **프로덕션과 같은 값이어야** 미들웨어가
 * 켜진다(`src/middleware.ts` 의 `GATE_ENABLED`). 로컬 기본값으로 빌드하면 관문이 꺼진 채라
 * 정작 검증하려던 것이 안 돈다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 4300);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * 프로덕션과 같은 값 — 이게 아니면 미들웨어가 안 켜진다.
 * `src/tests/smoke/app.smoke.ts` 의 `API` 와 **같아야 한다**(거기서 이 접두사로 가로챈다).
 * 그쪽은 일부러 env 를 안 쓴다 — 이유는 그 파일 주석 참조(Git Bash MSYS 경로 변환).
 */
const API_BASE = "/api/proxy/api";

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

/**
 * ⚠️ **`shell: true` 를 node 실행에 쓰지 말 것.**
 *
 * 처음엔 윈도우라서 전부 `shell: true` 로 띄웠는데, `process.execPath` 가
 * `C:\Program Files\nodejs\node.exe` 라 **경로의 공백이 셸에서 쪼개진다.** 증상이 고약하다 —
 * 에러가 안 나고 자식이 그냥 안 뜨며, 부모는 `exit` 이벤트를 영영 기다린다(빌드·서버는
 * 멀쩡히 떠 있어서 "테스트가 느린 것" 처럼 보인다. 실측 19분 무응답).
 *
 * node 는 셸 없이 직접 띄운다. `npx`(.cmd 배치)만 셸이 필요하다.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: WEB_DIR,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: process.platform === "win32" && cmd !== process.execPath,
    });
    p.on("error", (e) => {
      console.error(`[smoke] ${cmd} 실행 실패:`, e);
      resolve(1);
    });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      // 미들웨어가 켜져 있으므로 `/login`(공개 경로)으로 확인한다 — 보호 경로는 307 이라
      // "떴다" 와 "리다이렉트됐다" 가 섞인다.
      const res = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`웹이 ${timeoutMs}ms 안에 뜨지 않았습니다 (마지막 오류: ${String(lastErr)})`);
}

async function main(): Promise<void> {
  // ⚠️ 기본 `.next` 에 빌드한다. 이 빌드에는 `NEXT_PUBLIC_API_URL` 이 **번들에 박혀** 있으므로
  //    스모크를 돌린 뒤의 `.next` 는 로컬 개발용이 아니다. `next dev` 는 어차피 다시 만들지만,
  //    `next start` 로 로컬을 띄워 보던 중이었다면 한 번 다시 빌드할 것.
  log(`프로덕션 빌드 (NEXT_PUBLIC_API_URL=${API_BASE})…`);
  const buildCode = await run("npx", ["next", "build"], { NEXT_PUBLIC_API_URL: API_BASE });
  if (buildCode !== 0) throw new Error(`빌드 실패 (exit ${buildCode})`);

  log(`서버 기동 (:${PORT})…`);
  let server: ChildProcess | undefined;
  let testCode = 1;
  try {
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      cwd: WEB_DIR,
      env: { ...process.env, NEXT_PUBLIC_API_URL: API_BASE },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    server.on("exit", (code, signal) => {
      // 테스트 도중 죽으면 전부 조용히 실패한다 — 그 사실을 눈에 보이게 찍는다.
      if (!shuttingDown) console.error(`[smoke] ⚠️ 웹 서버가 먼저 종료됐습니다 (code=${code} signal=${signal})`);
    });
    await waitForServer();
    log("웹 준비됨 — 스모크 실행");

    testCode = await run(
      process.execPath,
      ["--import", "tsx", "--test", "src/tests/smoke/**/*.smoke.ts"],
      { SMOKE_BASE_URL: BASE_URL },
    );
  } finally {
    shuttingDown = true;
    if (server && server.exitCode === null) server.kill("SIGTERM");
  }

  process.exit(testCode);
}

let shuttingDown = false;

main().catch((e) => {
  console.error("[smoke] 실패:", e);
  process.exit(1);
});

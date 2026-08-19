/**
 * 네이버 로그인 도우미 — **편집자(실무자) 배포용 단일 실행파일** 소스.
 *
 * naver-login-upload.mts 와 같은 일(STEP D 로그인 → 네이버 로그인 → 세션 서버 등록)을
 * 하지만, 개발 환경(pnpm·리포)이 없는 편집자 PC 에서 더블클릭으로 돈다.
 *
 * ## 왜 playwright 가 아니라 raw CDP 인가
 * bun 컴파일 바이너리에서 playwright 는 launch(파이프)도 connectOverCDP(내장 ws)도
 * 안 붙는다 (2026-08-12 실측: 둘 다 타임아웃). 그래서 시스템 Edge/Chrome 을 직접
 * spawn 하고 **bun 네이티브 WebSocket 으로 CDP** 를 말한다. 필요한 것은 탭 열기
 * (Target.createTarget)와 쿠키 읽기(Storage.getCookies)뿐이라 CDP 로 충분하다.
 *
 * 빌드(리포에서):
 *   cd apps/server && bun build --compile --target=bun-windows-x64 \
 *     scripts/naver-login-tool.mts --outfile stepd-naver-login.exe
 * 배포: gs://stepd-media/tools/stepd-naver-login.exe → 웹 배포채널 화면의 다운로드 버튼이
 *   GET /api/naver/login-tool (서명 URL 302) 로 내려준다.
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const api = (arg("--api") ?? "https://stepd.stepai.kr/api/proxy").replace(/\/$/, "");
const web = (arg("--web") ?? "https://stepd.stepai.kr").replace(/\/$/, "");
let sessionCookie = arg("--session") ?? "";
/**
 * 어느 네이버 계정의 로그인인가 — 우선순위: `--account` 인자 > **실행파일 이름** > 물어보기.
 *
 * 파일명 경로가 정상 경로다. 웹의 계정 카드에서 받으면 서버가
 * `stepd-naver-login--nva_abc123.exe` 로 이름을 박아 내려준다(GET /api/naver/login-tool?account=).
 * 카드에서 이미 고른 계정을 도우미가 또 묻지 않게 하려는 것 — 계정이 둘 이상이면 그때 번호를
 * 잘못 눌러 **다른 계정에 세션이 들어가는** 사고가 난다. 브라우저가 `(1)` 을 붙여도 읽힌다.
 */
const accountArg = arg("--account") ?? accountKeyFromExeName();
function accountKeyFromExeName(): string | undefined {
  try {
    // bun 컴파일 바이너리에서 execPath 는 exe 자신이다. 소스로 돌릴 땐 bun/node 라 안 잡힌다.
    const base = path.basename(process.execPath);
    return /(nva_[a-z0-9]+)/i.exec(base)?.[1];
  } catch { return undefined; }
}

const SESSION_COOKIE = "stepd_session";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
async function pause(msg = "\n아무 키나(Enter) 누르면 창이 닫힙니다...") {
  await ask(msg);
  rl.close();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeaders(): Record<string, string> {
  return sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {};
}

async function apiJson(p: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${api}${p}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as any)?.message ?? (body as any)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`${p} → ${msg}`);
  }
  return body;
}

console.log("STEP D 네이버 로그인 도우미");
console.log("──────────────────────────");
console.log("브라우저 창이 뜨면 ① STEP D 로그인 → ② 네이버 로그인 순서로 진행하세요.");
console.log("아이디·비밀번호는 브라우저에만 들어가고 이 프로그램은 저장하지 않습니다.\n");

if (process.argv.includes("--smoke")) {
  // 계정 키 해석 결과를 같이 찍는다 — 파일명 파싱은 **컴파일된 exe 안에서만** 확인되는
  // 동작이라(process.execPath 가 bun 이 아니라 exe 자신), 이게 없으면 빌드 후 검증할 방법이 없다.
  console.log(`[smoke] exe=${path.basename(process.execPath)} account=${accountArg ?? "(없음 → 물어봄)"}`);
  console.log("[smoke] ok");
  process.exit(0);
}

// ── 브라우저 spawn + CDP ───────────────────────────────────────────────────────

const EDGE_PATHS = [
  `${process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)"}/Microsoft/Edge/Application/msedge.exe`,
  `${process.env["ProgramFiles"] ?? "C:/Program Files"}/Microsoft/Edge/Application/msedge.exe`,
  `${process.env["ProgramFiles"] ?? "C:/Program Files"}/Google/Chrome/Application/chrome.exe`,
  `${process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)"}/Google/Chrome/Application/chrome.exe`,
  `${process.env["LOCALAPPDATA"] ?? ""}/Google/Chrome/Application/chrome.exe`,
];

interface Cdp {
  call: (method: string, params?: Record<string, unknown>) => Promise<any>;
  openTab: (url: string) => Promise<void>;
  cleanup: () => void;
}

async function launchBrowser(headless: boolean): Promise<Cdp> {
  const exe = EDGE_PATHS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) throw new Error("Edge/Chrome 브라우저를 찾지 못했습니다 — Microsoft Edge 를 설치해 주세요.");
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "stepd-naver-"));
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ], { stdio: "ignore" });
  const cleanup = () => {
    try { child.kill(); } catch { /* 이미 죽음 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 잠김 무시 */ }
  };

  // CDP HTTP 가 뜰 때까지 (최대 30초).
  let wsUrl = "";
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { wsUrl = ((await r.json()) as any).webSocketDebuggerUrl; break; }
    } catch { /* 아직 */ }
    if (child.exitCode !== null) break;
    await sleep(300);
  }
  if (!wsUrl) { cleanup(); throw new Error(`브라우저 CDP 가 뜨지 않았습니다 (exit=${child.exitCode ?? "실행 중"})`); }

  // 브라우저 레벨 WS 하나로 전부 처리한다 (Storage.getCookies · Target.createTarget).
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("CDP WebSocket 연결 실패"));
  });
  let seq = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message ?? "CDP error"));
        else p.res(m.result);
      }
    } catch { /* 이벤트 무시 */ }
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP ${method} 타임아웃`)); } }, 15_000);
    });
  const openTab = async (url: string) => { await call("Target.createTarget", { url }); };
  return { call, openTab, cleanup };
}

/** 브라우저 전체 쿠키 (CDP Storage.getCookies — 컨텍스트 미지정 = 기본 컨텍스트 전부). */
async function allCookies(cdp: Cdp): Promise<any[]> {
  const r = await cdp.call("Storage.getCookies");
  return Array.isArray(r?.cookies) ? r.cookies : [];
}

if (process.argv.includes("--launch-test")) {
  try {
    const cdp = await launchBrowser(true);
    await cdp.openTab("about:blank");
    const n = (await allCookies(cdp)).length;
    cdp.cleanup();
    console.log(`[launch-test] ok (cdp · cookies=${n})`);
    process.exit(0);
  } catch (e) {
    console.log(`[launch-test] 실패: ${String(e).split("\n")[0].slice(0, 160)}`);
    process.exit(1);
  }
}

const cdp = await launchBrowser(false);

try {
  // ── 1) STEP D 로그인 ────────────────────────────────────────────────────────
  if (!sessionCookie) {
    await cdp.openTab(`${web}/login`);
    console.log("① 브라우저에서 STEP D 에 로그인하세요.");
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      const found = (await allCookies(cdp)).find((k) => k.name === SESSION_COOKIE);
      if (found) { sessionCookie = found.value; break; }
      await sleep(1000);
    }
    if (!sessionCookie) throw new Error("STEP D 로그인이 확인되지 않았습니다 (5분 초과).");
    console.log("   STEP D 로그인 확인됨.");
  }

  // ── 2) 어느 네이버 계정에 붙일지 ─────────────────────────────────────────────
  //
  // 목록은 **항상** 불러온다 — 계정 키가 있어도 그 계정이 아직 있는지·이름이 뭔지 확인해서
  // 사람에게 보여줘야 한다. 어느 계정에 붙는지 모른 채 로그인하는 상황을 만들지 않는다.
  const { accounts } = await apiJson("/api/naver/accounts");
  const usable = (accounts ?? []).filter((a: any) => a.status !== "disabled");
  if (usable.length === 0) {
    throw new Error("등록된 네이버 계정이 없습니다 — 배포채널 화면에서 '＋ 네이버 계정 추가'를 먼저 하세요.");
  }

  let accountId: string | undefined;
  if (accountArg) {
    // id·accountKey 둘 다로 찾는다(현재는 같은 값이지만 갈라져도 안 깨지게).
    const hit = usable.find((a: any) => a.id === accountArg || a.accountKey === accountArg);
    if (!hit) {
      throw new Error(
        `계정 '${accountArg}' 을(를) 찾을 수 없습니다 — 삭제됐거나 사용 중지됐습니다. ` +
        `배포채널 화면에서 다시 내려받으세요.`);
    }
    accountId = hit.id;
    console.log(`② 계정: ${hit.label}  ← 웹에서 고른 계정`);
  } else if (usable.length === 1) {
    accountId = usable[0].id;
    console.log(`② 계정: ${usable[0].label}`);
  } else {
    // 폴백 — 웹 카드가 아니라 예전 링크·직접 실행으로 받은 경우. 계정이 둘 이상이면
    // 여기서 잘못 고르면 세션이 엉뚱한 계정에 들어가므로, 고른 이름을 다시 찍어 확인시킨다.
    console.log("② 어느 계정의 로그인인가요?");
    usable.forEach((a: any, i: number) => console.log(`   ${i + 1}. ${a.label} (${a.target})`));
    while (!accountId) {
      const n = Number((await ask("   번호 입력: ")).trim());
      if (Number.isInteger(n) && n >= 1 && n <= usable.length) {
        accountId = usable[n - 1].id;
        console.log(`   선택: ${usable[n - 1].label}`);
      }
    }
  }

  // ── 3) 네이버 로그인 ────────────────────────────────────────────────────────
  await cdp.openTab("https://nid.naver.com/nidlogin.login");
  console.log("③ 브라우저에서 네이버 로그인을 완료하세요 (2차인증 포함).");
  {
    // 로그인 완료 판정 = 네이버 인증 쿠키(NID_AUT·NID_SES)가 생겼는가.
    const until = Date.now() + 5 * 60_000;
    let ok = false;
    while (Date.now() < until) {
      const names = new Set((await allCookies(cdp)).filter((k) => String(k.domain).includes("naver.com")).map((k) => k.name));
      if (names.has("NID_AUT") && names.has("NID_SES")) { ok = true; break; }
      await sleep(1000);
    }
    if (!ok) console.log("   로그인 완료를 감지 못했습니다 — 현재 상태를 그대로 올립니다.");
  }

  // TV·클립 두 도메인 쿠키를 함께 담는다 — 탭을 열어 도메인별 쿠키가 붙게 한다.
  await cdp.openTab("https://tv.naver.com/studio");
  await cdp.openTab("https://clipcreators.naver.com/web/upload");
  await sleep(4000);

  // ── 4) 네이버 쿠키만 storageState 로 변환해 서버 등록 ───────────────────────
  const naver = (await allCookies(cdp)).filter((k) => String(k.domain).includes("naver.com"));
  if (naver.length === 0) throw new Error("네이버 쿠키가 하나도 없습니다 — 로그인이 끝나지 않았습니다.");
  const storageState = {
    cookies: naver.map((k) => ({
      name: k.name, value: k.value, domain: k.domain, path: k.path ?? "/",
      // CDP 는 세션 쿠키를 expires 없이 주기도 한다 — playwright 규약은 -1.
      expires: typeof k.expires === "number" && k.expires > 0 ? k.expires : -1,
      httpOnly: !!k.httpOnly, secure: !!k.secure,
      sameSite: k.sameSite === "Strict" ? "Strict" : k.sameSite === "None" ? "None" : "Lax",
    })),
    origins: [],
  };

  await apiJson(`/api/naver/accounts/${accountId}/session`, {
    method: "PUT",
    body: JSON.stringify({ storageState }),
  });
  console.log(`\n✔ 완료! 로그인 세션이 등록됐습니다 (쿠키 ${storageState.cookies.length}개).`);
  console.log("  배포채널 화면을 새로고침하면 '로그인 필요'가 사라집니다.");
} catch (err) {
  console.error("\n✖ 실패:", err instanceof Error ? err.message : err);
} finally {
  cdp.cleanup();
  await pause();
  process.exit(0);
}

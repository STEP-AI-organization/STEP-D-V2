/**
 * 쿠팡파트너스 로그인 도우미 — **실무자 배포용 단일 실행파일** 소스.
 *
 * 웹(배포채널 화면)에서 버튼 하나로 받아 더블클릭하면, 브라우저가 뜨고 사람이 두 번
 * 로그인하는 것으로 끝난다. 개발 환경(pnpm·리포)이 없는 PC 에서도 돈다 —
 * `commerce-login-upload.mts`(개발자용)와 같은 일을 하지만 그쪽은 리포가 있어야 한다.
 *
 * ## 왜 도우미(exe)인가 — 웹만으로는 불가능하다
 *
 * 세션을 받으려면 **쿠팡 도메인의 쿠키**를 읽어야 하는데, `stepd.stepai.kr` 의 웹페이지는
 * 교차 출처라 그걸 절대 읽을 수 없다(iframe 도 CSP·X-Frame-Options 로 막히고, 읽더라도
 * 쿠키는 못 본다). 브라우저를 우리가 띄워야만 읽을 수 있다 — 네이버가 같은 이유로 같은
 * 구조를 쓴다(`naver-login-tool.mts`).
 *
 * ## 왜 playwright 가 아니라 raw CDP 인가
 * bun 컴파일 바이너리에서 playwright 는 launch(파이프)도 connectOverCDP(내장 ws)도 안 붙는다
 * (2026-08-12 실측). 그래서 시스템 Edge/Chrome 을 직접 spawn 하고 **bun 네이티브 WebSocket
 * 으로 CDP** 를 말한다. 필요한 건 탭 열기와 쿠키 읽기뿐이라 CDP 로 충분하다.
 *
 * ⚠️ **headless 로 띄우지 않는다.** 쿠팡은 세션이 유효해도 headless 를 차단한다
 * (2026-08-27 실측 · Access Denied). 사람이 로그인해야 하니 어차피 창이 떠야 한다.
 *
 * 빌드(리포에서):
 *   cd apps/server && bun build --compile --target=bun-windows-x64 \
 *     scripts/coupang-login-tool.mts --outfile stepd-coupang-login.exe
 * 배포: gs://stepd-media/tools/stepd-coupang-login.exe → 웹 배포채널 화면의 다운로드 버튼이
 *   GET /api/commerce/login-tool (서명 URL 302) 로 내려준다.
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

const SESSION_COOKIE = "stepd_session";
/** 쿠팡 로그인 완료 판정에 쓰는 인증 쿠키 (2026-08-27 실측 · 전부 httpOnly+secure). */
const AUTH_COOKIES = ["CT_AT", "CSID", "CUPT"];

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

console.log("STEP D 쿠팡파트너스 로그인 도우미");
console.log("────────────────────────────────");
console.log("브라우저 창이 뜨면 ① STEP D 로그인 → ② 쿠팡파트너스 로그인 순서로 진행하세요.");
console.log("아이디·비밀번호는 브라우저에만 들어가고 이 프로그램은 저장하지 않습니다.\n");

if (process.argv.includes("--smoke")) {
  console.log(`[smoke] exe=${path.basename(process.execPath)} api=${api} web=${web}`);
  console.log("[smoke] ok");
  process.exit(0);
}

// ── 브라우저 spawn + CDP ───────────────────────────────────────────────────────

const BROWSER_PATHS = [
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

async function launchBrowser(): Promise<Cdp> {
  const exe = BROWSER_PATHS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) throw new Error("Edge/Chrome 브라우저를 찾지 못했습니다 — Microsoft Edge 를 설치해 주세요.");
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "stepd-coupang-"));
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    // 쿠팡은 자동화 흔적이 보이면 막는다. 사람이 직접 로그인하는 창이라 숨겨 둔다.
    "--disable-blink-features=AutomationControlled",
    "about:blank",
  ], { stdio: "ignore" });
  const cleanup = () => {
    try { child.kill(); } catch { /* 이미 죽음 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 잠김 무시 */ }
  };

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

async function allCookies(cdp: Cdp): Promise<any[]> {
  const r = await cdp.call("Storage.getCookies");
  return Array.isArray(r?.cookies) ? r.cookies : [];
}

if (process.argv.includes("--launch-test")) {
  try {
    const cdp = await launchBrowser();
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

const cdp = await launchBrowser();

try {
  // ── 1) STEP D 로그인 (어느 워크스페이스인지가 여기서 정해진다) ────────────────
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

  // ── 2) 계정 확인 (워크스페이스당 하나) ───────────────────────────────────────
  //
  // 네이버처럼 여러 개 중에 고르지 않는다 — 커미션 정산이 계정 단위라 하나만 둔다.
  // 없으면 여기서 만든다(웹에서 미리 안 만들었어도 도우미만으로 끝나게).
  const info = await apiJson("/api/commerce/account");
  let account = info?.account;
  if (!account) {
    const name = (await ask("② 이 워크스페이스의 쿠팡파트너스 계정 이름 (예: ENA 법인): ")).trim()
      || "쿠팡파트너스";
    account = (await apiJson("/api/commerce/account", {
      method: "PUT", body: JSON.stringify({ label: name }),
    }))?.account;
    console.log(`   등록: ${account?.label ?? name}`);
  } else {
    console.log(`② 계정: ${account.label}`);
  }
  if (info?.sessionKeyReady === false) {
    throw new Error("서버에 세션 암호화 키(COMMERCE_SESSION_KEY)가 없어 등록할 수 없습니다 — 운영팀에 문의하세요.");
  }
  console.log("   ⚠️ 이 계정으로 커미션이 정산됩니다. 회사 법인 계정이 맞는지 확인하세요.");

  // ── 3) 쿠팡파트너스 로그인 ───────────────────────────────────────────────────
  await cdp.openTab("https://partners.coupang.com/");
  console.log("③ 브라우저에서 쿠팡파트너스에 로그인하세요 (2차인증 포함).");
  {
    const until = Date.now() + 10 * 60_000;
    let ok = false;
    while (Date.now() < until) {
      const names = new Set(
        (await allCookies(cdp)).filter((k) => String(k.domain).includes("coupang.com")).map((k) => k.name));
      if (AUTH_COOKIES.some((n) => names.has(n)) && names.has("member_srl")) { ok = true; break; }
      await sleep(1000);
    }
    if (!ok) console.log("   로그인 완료를 감지 못했습니다 — 현재 상태를 그대로 올립니다.");
  }

  // 콘솔 도메인 쿠키가 확실히 붙도록 한 번 더 열어 준다.
  await cdp.openTab("https://partners.coupang.com/#affiliate/ws");
  await sleep(4000);

  // ── 4) 쿠팡 쿠키만 storageState 로 변환해 서버 등록 ──────────────────────────
  //
  // ⚠️ **쿠팡 도메인만 고른다.** 전부 올리면 위에서 받은 STEP D 세션 쿠키까지 섞여 들어가,
  //    나중에 이 세션을 푸는 사람이 우리 서비스 계정까지 갖게 된다(네이버에서 겪은 함정).
  const cookies = (await allCookies(cdp)).filter((k) => String(k.domain).includes("coupang.com"));
  if (cookies.length === 0) throw new Error("쿠팡 쿠키가 하나도 없습니다 — 로그인이 끝나지 않았습니다.");
  const storageState = {
    cookies: cookies.map((k) => ({
      name: k.name, value: k.value, domain: k.domain, path: k.path ?? "/",
      // CDP 는 세션 쿠키를 expires 없이 주기도 한다 — playwright 규약은 -1.
      expires: typeof k.expires === "number" && k.expires > 0 ? k.expires : -1,
      httpOnly: !!k.httpOnly, secure: !!k.secure,
      sameSite: k.sameSite === "Strict" ? "Strict" : k.sameSite === "None" ? "None" : "Lax",
    })),
    origins: [],
  };

  await apiJson("/api/commerce/account/session", {
    method: "PUT",
    body: JSON.stringify({ storageState }),
  });
  console.log(`\n✔ 완료! 로그인 세션이 등록됐습니다 (쿠키 ${storageState.cookies.length}개).`);
  console.log("  배포채널 화면을 새로고침하면 '연결됨' 으로 바뀝니다.");
} catch (err) {
  console.error("\n✖ 실패:", err instanceof Error ? err.message : err);
} finally {
  cdp.cleanup();
  await pause();
  process.exit(0);
}

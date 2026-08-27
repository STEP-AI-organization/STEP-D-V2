/**
 * 쿠팡파트너스 로그인 → **서버에 세션 등록**까지 한 번에.
 *
 *   pnpm --filter @stepd/server commerce:login -- --api https://stepd-server-xxx.run.app
 *   pnpm --filter @stepd/server commerce:login -- --label "ENA 법인"
 *
 * 회사마다 **자기 법인 파트너스 계정**을 써야 한다(커미션 정산이 계정 단위다). 이 스크립트가
 * 그 온보딩 한 번을 담당한다 — 브라우저 창이 뜨고 사람은 **두 번 로그인**한다:
 * STEP D 에 한 번(내가 어느 워크스페이스인지), 쿠팡파트너스에 한 번(어느 계정인지).
 * 그러면 세션이 서버에 봉인돼 올라가고, **어느 워커 PC 든** 그걸 받아 쓴다.
 *
 * ⚠️ 세션 쿠키는 그 계정의 **전체 권한**이다(쿠키만 주입해도 로그인된다 · 2차인증 통과 상태).
 *    서버는 `COMMERCE_SESSION_KEY` 로 봉인해 저장하고, 키가 없으면 저장을 거부한다 —
 *    그 경우 이 스크립트도 실패한다(평문으로 우회하지 않는다).
 *
 * ⚠️ 프로덕션은 `AUTH_REQUIRED=1` 이라 인증 없는 PUT 은 401 이다. 브라우저에서 이미
 *    로그인하는 김에 그 세션 쿠키를 그대로 쓴다(네이버 스크립트와 같은 방식).
 */
import { chromium, type BrowserContext } from "playwright";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const api = (arg("--api") ?? process.env.STEPD_API_BASE ?? "http://127.0.0.1:4100").replace(/\/$/, "");
const web = (arg("--web") ?? api).replace(/\/$/, "");
const label = arg("--label") ?? "쿠팡파트너스";
let sessionCookie = arg("--session") ?? process.env.STEPD_SESSION ?? "";

const SESSION_COOKIE = "stepd_session";
const PARTNERS = "https://partners.coupang.com";

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${body?.message ?? body?.error ?? `${res.status} ${res.statusText}`}`);
  return body;
}

// ⚠️ headless 로 띄우지 마라 — 쿠팡은 세션이 유효해도 headless 를 차단한다(실측 2026-08-27).
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });

const grabSessionCookie = async (c: BrowserContext) =>
  (await c.cookies()).find((k) => k.name === SESSION_COOKIE)?.value ?? "";

try {
  // ── 1) STEP D 로그인 (어느 워크스페이스 계정인지 정해진다) ───────────────────
  if (!sessionCookie) {
    const page = await ctx.newPage();
    await page.goto(`${web}/login`, { waitUntil: "domcontentloaded" }).catch(() => {});
    console.log("① 브라우저에서 STEP D 에 로그인하세요.");
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      sessionCookie = await grabSessionCookie(ctx);
      if (sessionCookie) break;
      await page.waitForTimeout(1000);
    }
    if (sessionCookie) console.log("   STEP D 로그인 확인됨.");
    else console.log("   세션 쿠키를 못 찾았습니다 — 인증 없이 시도합니다(로컬 서버라면 정상).");
    await page.close();
  }

  // ── 2) 계정 행 확보 (없으면 만든다) ────────────────────────────────────────
  const { account } = await apiJson("/api/commerce/account");
  if (!account) {
    await apiJson("/api/commerce/account", { method: "PUT", body: JSON.stringify({ label }) });
    console.log(`② 계정 등록: ${label}`);
  } else {
    console.log(`② 계정: ${account.label} (${account.id})`);
  }

  // ── 3) 쿠팡파트너스 로그인 ─────────────────────────────────────────────────
  const page = await ctx.newPage();
  await page.goto(PARTNERS, { waitUntil: "domcontentloaded" });
  console.log("③ 브라우저에서 쿠팡파트너스에 로그인하세요 (2차인증 포함).");

  // 로그인 완료 판정은 URL 이 아니라 **콘솔 API 가 계정 신원을 돌려주는가**로 한다 —
  // 비로그인 상태에서도 rCode 는 0 이라 그것만 보면 안 된다(email 이 null 로 온다).
  const until = Date.now() + 10 * 60_000;
  let who: string | null = null;
  while (Date.now() < until) {
    who = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/v1/config", { credentials: "include" });
        const j = (await r.json()) as any;
        return j?.data?.settings?.email ?? null;
      } catch { return null; }
    }).catch(() => null);
    if (who) break;
    await page.waitForTimeout(2000);
  }
  if (!who) throw new Error("로그인이 확인되지 않았습니다 (10분 대기). 다시 시도하세요.");
  console.log(`   로그인 확인됨: ${who}`);

  // ── 4) 쿠팡 쿠키만 골라 올린다 ─────────────────────────────────────────────
  // ⚠️ storageState 를 통째로 올리면 위에서 받은 **STEP D 세션 쿠키까지** 같이 올라간다 —
  //    우리 서비스 로그인 쿠키를 남의 세션 blob 안에 묻어 두는 셈이다(네이버에서 겪은 함정).
  const full = await ctx.storageState();
  const storageState = {
    cookies: full.cookies.filter((k) => k.domain.includes("coupang.com")),
    origins: full.origins.filter((o) => o.origin.includes("coupang.com")),
  };
  if (storageState.cookies.length === 0) throw new Error("쿠팡 쿠키가 하나도 없습니다 — 로그인이 끝나지 않았습니다.");

  await apiJson("/api/commerce/account/session", {
    method: "PUT",
    body: JSON.stringify({ storageState }),
  });
  console.log(`✔ 세션 등록 완료 — 이제 이 워크스페이스의 링크는 ${who} 계정으로 발급됩니다 ` +
    `(쿠키 ${storageState.cookies.length}개).`);
} catch (err) {
  console.error("세션 등록 실패:", err instanceof Error ? err.message : err);
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(1);
}

await ctx.close();
await browser.close();
process.exit(0);

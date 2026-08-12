/**
 * 네이버 로그인 → **서버에 세션 등록**까지 한 번에.
 *
 *   pnpm --filter @stepd/server naver:login:upload -- --api https://stepd-server-xxx.run.app
 *   pnpm --filter @stepd/server naver:login:upload -- --account nva_xxx      # 계정 지정
 *
 * 사용자 동선을 "로그인만 하면 끝" 으로 만드는 도구다. 브라우저 창 하나가 뜨고, 사람은
 * **두 번 로그인**한다 — STEP D 에 한 번(내가 누구인지), 네이버에 한 번(어느 채널인지).
 * 그러면 세션이 서버에 올라가고 **어느 워커 머신이든** 받아 쓴다 — 워커 PC 앞에 갈 필요가 없다.
 *
 * ⚠️ 왜 STEP D 로그인이 필요한가: 프로덕션은 `AUTH_REQUIRED=1` 이라 인증 없는 PUT 은 401 이다.
 *    예전 버전은 이걸 안 보내서 **로컬 서버에만 등록됐다** — 프로덕션에 올리려 하면 조용히
 *    401 로 끝났다. 브라우저에서 이미 로그인하는 김에 그 세션 쿠키를 그대로 쓴다.
 *    (API 키 경로는 라우트 화이트리스트가 따로라 여기서는 쓰지 않는다.)
 *
 * ⚠️ 네이버 세션 쿠키는 그 계정의 전체 권한이다. 서버는 NAVER_SESSION_KEY 로 암호화해
 *    저장하고, 키가 없으면 저장을 거부한다(평문 저장 안 함). 그 경우 이 스크립트도 실패한다.
 */
import { chromium, type BrowserContext } from "playwright";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const accountArg = arg("--account");
const api = (arg("--api") ?? process.env.STEPD_API_BASE ?? "http://127.0.0.1:4100").replace(/\/$/, "");
/** 세션 쿠키를 이미 갖고 있으면 STEP D 로그인 단계를 건너뛴다(재실행·자동화용). */
let sessionCookie = arg("--session") ?? process.env.STEPD_SESSION ?? "";

/** 웹 로그인 화면의 출처. API 와 같은 오리진이면 그대로, 아니면 --web 으로 준다. */
const web = (arg("--web") ?? api).replace(/\/$/, "");

const SESSION_COOKIE = "stepd_session";

function authHeaders(): Record<string, string> {
  return sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {};
}

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`${path} → ${msg}`);
  }
  return body;
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });

/** 브라우저에서 STEP D 세션 쿠키를 건져온다. 이미 로그인돼 있으면 바로 잡힌다. */
async function grabSessionCookie(c: BrowserContext): Promise<string> {
  const found = (await c.cookies()).find((k) => k.name === SESSION_COOKIE);
  return found?.value ?? "";
}

try {
  // ── 1) STEP D 로그인 (인증이 필요한 서버일 때만) ────────────────────────────
  if (!sessionCookie) {
    const page = await ctx.newPage();
    await page.goto(`${web}/login`, { waitUntil: "domcontentloaded" }).catch(() => {});
    console.log("① 브라우저에서 STEP D 에 로그인하세요.");
    // 로그인 완료를 URL 로 판정하지 않는다 — 로그인 후 어디로 보내는지는 화면 사정이다.
    // 쿠키가 생겼는가만 본다. 5분 안에 안 생기면 인증 없이 진행해 본다(로컬 서버는 그래도 된다).
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

  // ── 2) 어느 계정에 붙일지 ───────────────────────────────────────────────────
  let accountId = accountArg;
  if (!accountId) {
    const { accounts } = await apiJson("/api/naver/accounts");
    const usable = (accounts ?? []).filter((a: any) => a.status !== "disabled");
    if (usable.length === 0) {
      throw new Error("등록된 네이버 계정이 없습니다 — 배포채널 화면에서 계정을 먼저 추가하세요.");
    }
    if (usable.length > 1) {
      console.error("계정이 여러 개입니다. --account 로 지정하세요:");
      for (const a of usable) console.error(`  ${a.id}  ${a.label} (${a.target})`);
      throw new Error("계정 미지정");
    }
    // 하나뿐이면 그걸 쓴다. 여럿일 때 임의로 고르지 않는 이유는 명확하다 —
    // 다른 고객사 채널에 세션을 덮어쓰면 발행이 그쪽으로 나간다.
    accountId = usable[0].id;
    console.log(`② 계정: ${usable[0].label} (${accountId})`);
  }

  // ── 3) 네이버 로그인 ────────────────────────────────────────────────────────
  const page = await ctx.newPage();
  await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "domcontentloaded" });
  console.log("③ 브라우저에서 네이버 로그인을 완료하세요 (2차인증 포함).");
  await page.waitForURL((u) => !u.toString().includes("nid.naver.com"), { timeout: 5 * 60_000 })
    .catch(() => console.log("   로그인 완료를 감지 못했습니다 — 현재 상태를 그대로 올립니다."));

  // TV·클립 두 도메인 쿠키를 함께 담는다. 한쪽만 담으면 다른 쪽 발행에서 세션 만료로 죽는다.
  for (const u of ["https://tv.naver.com/studio", "https://clipcreators.naver.com/web/upload"]) {
    await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  // ⚠️ **네이버 쿠키만 골라 올린다.** ctx.storageState() 를 그대로 쓰면 위에서 받은
  //    STEP D 세션 쿠키까지 같이 올라간다 — 우리 서비스 로그인 쿠키를 네이버 세션 blob 안에
  //    묻어 두는 셈이라, 나중에 그 blob 을 푸는 사람이 우리 계정도 갖게 된다.
  const full = await ctx.storageState();
  const storageState = {
    cookies: full.cookies.filter((k) => /(^|\.)naver\.com$/.test(k.domain.replace(/^\./, "")) ||
                                        k.domain.includes("naver.com")),
    origins: full.origins.filter((o) => o.origin.includes("naver.com")),
  };
  if (storageState.cookies.length === 0) {
    throw new Error("네이버 쿠키가 하나도 없습니다 — 로그인이 끝나지 않았습니다.");
  }

  // ── 4) 서버에 등록 ──────────────────────────────────────────────────────────
  await apiJson(`/api/naver/accounts/${accountId}/session`, {
    method: "PUT",
    body: JSON.stringify({ storageState }),
  });
  console.log(`✔ 세션 등록 완료 — 계정 ${accountId} 이 이제 발행에 쓰입니다 (쿠키 ${storageState.cookies.length}개).`);
} catch (err) {
  console.error("세션 등록 실패:", err instanceof Error ? err.message : err);
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(1);
}

await ctx.close();
await browser.close();
process.exit(0);

/**
 * 네이버 로그인 → **서버에 세션 등록**까지 한 번에.
 *
 *   pnpm --filter @stepd/server naver:login:upload -- --account <accountId> [--api <base>]
 *
 * 사용자 동선을 "로그인만 하면 끝" 으로 만드는 도구다. 브라우저가 뜨고 사람이 로그인하면,
 * 그 세션을 서버에 올려서 **어느 워커 머신이든** 받아 쓰게 한다 — 워커 PC 앞에 갈 필요가 없다.
 *
 * ⚠️ 세션 쿠키는 그 계정의 전체 권한이다. 서버는 NAVER_SESSION_KEY 로 암호화해 저장하고,
 *    키가 없으면 저장을 거부한다(평문 저장 안 함). 그 경우 이 스크립트도 실패한다.
 */
import { chromium } from "playwright";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const accountId = arg("--account");
const api = (arg("--api") ?? process.env.INTERNAL_API_BASE ?? "http://127.0.0.1:4100").replace(/\/$/, "");
if (!accountId) { console.error("사용: naver:login:upload -- --account <accountId> [--api <base>]"); process.exit(1); }

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
const page = await ctx.newPage();
await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "domcontentloaded" });
console.log("브라우저에서 네이버 로그인을 완료하세요 (2차인증 포함).");
await page.waitForURL((u) => !u.toString().includes("nid.naver.com"), { timeout: 5 * 60_000 })
  .catch(() => console.log("로그인 완료를 감지 못했습니다 — 현재 상태를 그대로 올립니다."));

// TV·클립 두 도메인 쿠키를 함께 담는다.
for (const u of ["https://tv.naver.com/studio", "https://clipcreators.naver.com/web/upload"]) {
  await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
}
const storageState = await ctx.storageState();
await ctx.close(); await browser.close();

const res = await fetch(`${api}/api/naver/accounts/${accountId}/session`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ storageState }),
});
const body = await res.json().catch(() => null) as any;
if (!res.ok) {
  console.error(`세션 등록 실패 (${res.status}):`, body?.message ?? body?.error ?? "");
  process.exit(1);
}
console.log(`세션 등록 완료 — 계정 ${accountId} 이 이제 발행에 쓰입니다.`);
process.exit(0);

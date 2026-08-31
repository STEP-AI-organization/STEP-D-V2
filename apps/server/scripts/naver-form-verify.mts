/**
 * 네이버 클립 **폼 검증** — 카테고리 선택과 등록 예약이 실제 화면에서 먹는지 확인한다.
 *
 *   pnpm --filter @stepd/server naver:verify -- --account nva_xxx --video <경로>
 *   pnpm --filter @stepd/server naver:verify -- --account nva_xxx --video <경로> --primary 엔터 --secondary 드라마
 *
 * **등록도 임시저장도 절대 누르지 않는다.** 폼을 띄워 `pickCategory` · `setSchedule` 을
 * 발행 경로와 **같은 함수로** 돌려보고 결과만 읽은 뒤 브라우저를 닫는다.
 *
 * ⚠️ 그래도 **영상 바이트는 네이버로 올라간다** — 파일을 넣어야 메타데이터 폼이 렌더되기
 *    때문이다(2단계 구조). 네이버가 자체적으로 초안을 남길 가능성은 있다.
 *
 * 왜 필요한가: 카테고리·예약은 셀렉터에 기대는 브라우저 자동화라 **네이버가 화면을 바꾸면
 * 조용히 깨진다.** 그런데 그 사실이 드러나는 자리는 실제 발행이고, 거기서 실패하면 회차
 * 영상 수백 MB 를 이미 내려받은 뒤다. 이 스크립트는 발행 없이 그 두 축만 먼저 때려본다.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  openNaverContext, NAVER_TARGETS, pickCategory, setSchedule,
} from "../src/naver-tv.ts";
import { resolveCategory, DEFAULT_CATEGORY } from "../src/naver-categories.ts";
import { hasNaverSession, materializeNaverSession } from "../src/naver-session.ts";
import { getNaverAccount, getNaverSessionBlob } from "../src/db-pg.ts";
import { openSession } from "../src/naver-session-store.ts";
import { runAsSystem } from "../src/tenant.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const accountKey = arg("account");
/** DB 행 id — 세션이 이 PC 에 없어 서버 보관본을 받아야 할 때 쓴다(없으면 account 를 id 로 본다). */
const accountId = arg("account-id");
const videoPath = arg("video");
const primary = arg("primary") ?? "엔터";
const secondary = arg("secondary") ?? "드라마";

if (!videoPath || !fs.existsSync(videoPath)) {
  console.error(`영상 파일이 필요하다: --video <경로> (준 값: ${videoPath ?? "(없음)"})`);
  console.error("파일을 넣어야 메타데이터 폼이 렌더된다 — 네이버 클립은 2단계 구조다.");
  process.exit(1);
}

// 표에 없는 값이면 브라우저를 열기 전에 끝낸다 — 발행 워커와 같은 순서다.
const resolved = resolveCategory(primary, secondary);
if (!resolved.ok) {
  console.error(`카테고리 확인 실패: ${resolved.reason}`);
  process.exit(1);
}
const want = resolved.category;

// 기본값(엔터/엔터)으로 검증하면 "고른 것" 과 "원래 그 값인 것" 이 구분되지 않는다.
if (want.primary === DEFAULT_CATEGORY.primary && want.secondary === DEFAULT_CATEGORY.secondary) {
  console.warn("⚠️ 기본값으로 검증 중 — 선택이 실제로 먹었는지 구분되지 않는다. 다른 2차를 줄 것.");
}

const T = NAVER_TARGETS.clip;
const dir = path.join(os.homedir(), ".stepd", "naver-form-verify");
fs.mkdirSync(dir, { recursive: true });

const when = new Date(Date.now() + 3 * 60 * 60_000);   // 3시간 뒤 (분 눈금 때문에 여유를 둔다)
const results: { step: string; ok: boolean; detail: string }[] = [];
/** 두 검증까지 못 갔으면 통과로 셀 수 없다 — 중단은 성공이 아니다. */
let aborted: string | null = null;
const note = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// 이 PC 에 세션 파일이 없으면 **서버 보관본을 받아 푼다** — 워커(naver.publish)가 하는 것과
// 같은 순서다. 운영자가 웹에서 로그인해 올린 새 계정은 이 경로로만 이 PC 에 들어온다.
// 검증이 이 단계를 건너뛰면 "새로 로그인했는데도 만료" 라는 엉뚱한 결론이 나온다.
if (accountKey && !hasNaverSession(accountKey)) {
  // 개발 도구라 테넌트 문맥이 없다 — 횡단 스코프로 연다(워커는 잡의 테넌트로 연다).
  const acct = await runAsSystem(() => getNaverAccount(accountId ?? accountKey));
  if (!acct) {
    console.error(`계정을 못 찾았다: ${accountId ?? accountKey}`);
    console.error("--account 는 세션 키(nva_…), --account-id 는 DB 행 id 다. 둘 중 맞는 쪽을 줄 것.");
    process.exit(1);
  }
  const state = openSession(await runAsSystem(() => getNaverSessionBlob(acct.id)));
  if (!state) {
    console.error(`${acct.label}(${acct.accountKey}): 이 PC 에도 서버에도 세션이 없다 — 로그인이 먼저다.`);
    process.exit(1);
  }
  materializeNaverSession(acct.accountKey, state);
  console.log(`OK   세션 내려받기 — 서버 보관본을 이 PC 에 풀었다 (${acct.label} · ${acct.accountKey})`);
}

const { browser, ctx } = await openNaverContext(false, accountKey);
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

try {
  await page.goto(T.uploadUrl, { waitUntil: "domcontentloaded" });

  // ⚠️ **URL 로도 봐야 한다.** 클립 스튜디오는 껍데기를 먼저 그린 뒤 인증이 깨졌으면
  //    비동기로 nid.naver.com 으로 넘긴다. 폼 셀렉터만 세면 그 순간엔 0 이라 "진입 성공"
  //    으로 지나가고, 3분 뒤 "메타 폼이 안 뜬다" 로 엉뚱하게 실패한다(2026-08-31 실측 —
  //    세션 만료였는데 화면 개편으로 오해할 뻔했다).
  await page.waitForTimeout(6000);
  const onLogin = /nid\.naver\.com/.test(page.url())
    || (await page.locator('form[name="frmNIDLogin"], input#id').count()) > 0;
  if (onLogin) {
    note("세션", false, `만료 — 로그인 화면으로 넘어갔다 (${page.url()})`);
    throw new Error("session expired");
  }
  note("업로드 페이지 진입", true, page.url());

  // 1단계: 파일 투입 → 2단계 메타 폼이 같은 URL 에 렌더된다.
  await page.setInputFiles(T.sel.fileInput, videoPath);
  note("파일 투입", true, path.basename(videoPath));

  // 폼이 뜰 때까지 기다린다 — 인코딩 시간이 있어 넉넉히 준다.
  const form = page.locator(T.sel.description);
  await form.waitFor({ state: "visible", timeout: 180_000 });
  note("메타데이터 폼 렌더", true);

  // 설명은 필수(최소 10자)다. 카테고리·예약 컨트롤이 설명 입력에 좌우되지는 않지만,
  // 실제 발행과 같은 상태에서 보려고 채운다.
  await form.fill("폼 검증용 입력입니다. 등록하지 않습니다.").catch(() => {});

  // ── 검증 ① 카테고리 ──────────────────────────────────────────────────────
  try {
    await pickCategory(page, want);
    note("카테고리 선택", true, `${want.primary} / ${want.secondary}`);
  } catch (e) {
    note("카테고리 선택", false, e instanceof Error ? e.message : String(e));
  }

  // ── 검증 ② 등록 예약 ─────────────────────────────────────────────────────
  try {
    const ok = await setSchedule(page, when);
    note("등록 예약", ok, `${when.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  } catch (e) {
    note("등록 예약", false, e instanceof Error ? e.message : String(e));
  }

  const shot = path.join(dir, `verify-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(`\n스크린샷: ${shot}`);
} catch (e) {
  aborted = e instanceof Error ? e.message : String(e);
  const shot = path.join(dir, `verify-fail-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.error(`\n중단: ${aborted}`);
  console.error(`스크린샷: ${shot} — 무엇이 떠 있었는지는 이 그림이 말한다`);
} finally {
  // **아무것도 제출하지 않고 닫는다.**
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
}

// ⚠️ 중단했으면 "통과" 를 말하지 않는다. 예전엔 여기서 지나온 단계만 세서, 세션 만료로
//    폼도 못 본 실행이 "2/2 통과" 라고 끝났다(2026-08-31). 검증 도구가 거짓 초록을 내면
//    안 한 것만 못하다.
const failed = results.filter((r) => !r.ok);
const CHECKS = ["카테고리 선택", "등록 예약"];
const missing = CHECKS.filter((k) => !results.some((r) => r.step === k));
if (aborted || missing.length) {
  console.log(`\n=== 검증 못 함 ===`);
  if (aborted) console.log(`중단 사유: ${aborted}`);
  if (missing.length) console.log(`확인 못 한 항목: ${missing.join(" · ")}`);
  process.exit(1);
}
console.log(`\n=== 결과: ${results.length - failed.length}/${results.length} 통과 ===`);
process.exit(failed.length ? 1 : 0);

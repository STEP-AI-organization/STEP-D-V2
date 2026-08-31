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

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const accountKey = arg("account");
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
const note = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const { browser, ctx } = await openNaverContext(false, accountKey);
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

try {
  await page.goto(T.uploadUrl, { waitUntil: "networkidle" });
  const loggedOut = await page.locator('form[name="frmNIDLogin"], input#id').count();
  if (loggedOut) {
    note("로그인", false, "세션 만료 — naver:login 을 다시 돌려야 한다");
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
  const shot = path.join(dir, `verify-fail-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.error(`\n중단: ${e instanceof Error ? e.message : String(e)}`);
  console.error(`스크린샷: ${shot}`);
} finally {
  // **아무것도 제출하지 않고 닫는다.**
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 결과: ${results.length - failed.length}/${results.length} 통과 ===`);
process.exit(failed.length ? 1 : 0);

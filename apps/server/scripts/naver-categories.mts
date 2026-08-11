/**
 * 네이버 클립 카테고리(1차→2차) 전체 추출.
 *
 *   pnpm --filter @stepd/server naver:categories <영상경로>
 *
 * 카테고리 셀렉트는 파일을 넣어야 나타나는 2단계 폼 안에 있어 짧은 영상 하나를 실제로
 * 올려야 한다. **등록/임시저장은 누르지 않는다.**
 *
 * 2026-08-11 실측 함정 두 가지:
 *  - 옵션은 `role=option` 이 아니라 클래스에 "Option" 이 든 요소다. role 로 찾으면 0개가
 *    나오고, `li` 로 폴백하면 **사이드바 메뉴(대시보드·콘텐츠…)를 긁는다** — 실제로 당했다.
 *  - 트리거는 클래스 해시가 배포마다 바뀌므로 화면 문구("1차 카테고리")로 잡는다.
 */
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { openNaverContext, NAVER_TARGETS } from "../src/naver-tv.ts";

const video = process.argv[2];
if (!video || !fs.existsSync(video)) { console.error("사용: naver:categories <영상경로>"); process.exit(1); }
const out = path.join(os.homedir(), ".stepd", "naver-probe");
fs.mkdirSync(out, { recursive: true });

const P1 = 'button:has-text("1차 카테고리")';
const P2 = 'button:has-text("2차 카테고리")';
const OPT = '[class*="Option"]';

const { browser, ctx } = await openNaverContext(false);
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);
const log: string[] = [];
const say = (m: string) => { console.log(m); log.push(m); };

try {
  await page.goto(NAVER_TARGETS.clip.uploadUrl, { waitUntil: "networkidle" });
  // 숨은 input 에 직접 넣으면 SPA 가 change 이벤트를 못 받아 **조용히 1단계에 머문다**
  // (실측: 같은 코드가 어떤 실행에선 되고 어떤 실행에선 안 됨). filechooser 가 확실하다.
  await page.waitForTimeout(2000);
  await page.locator('input[type="file"]').first().setInputFiles(video);
  await page.locator(P1).first().waitFor({ state: "visible", timeout: 240_000 });
  say("2단계 폼 진입");

  const readOptions = async (): Promise<string[]> =>
    (await page.locator(OPT).allTextContents()).map((s) => s.trim()).filter((s) => s && s.length < 30);

  await page.locator(P1).first().click();
  await page.waitForTimeout(1500);
  const primaries = await readOptions();
  say(`1차 ${primaries.length}개`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);

  const tree: Record<string, string[]> = {};
  for (const p1 of primaries) {
    await page.locator(P1).first().click().catch(() => {});
    await page.waitForTimeout(700);
    await page.locator(OPT).filter({ hasText: p1 }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    await page.locator(P2).first().click().catch(() => {});
    await page.waitForTimeout(900);
    tree[p1] = await readOptions();
    say(`  ${p1} → ${tree[p1].length}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
  fs.writeFileSync(path.join(out, "clip-categories.json"), JSON.stringify(tree, null, 2), "utf-8");
  say("저장 완료");
} catch (e: any) {
  say("FAIL: " + (e?.message ?? e));
  await page.screenshot({ path: path.join(out, "cat-fail.png"), fullPage: true }).catch(() => {});
} finally {
  fs.writeFileSync(path.join(out, "cats-run.log"), log.join("\n"), "utf-8");
  await ctx.close(); await browser.close();
}
process.exit(0);

/** TV 2차 카테고리 드롭다운만 정밀 관찰. */
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { openNaverContext, NAVER_TARGETS } from "../src/naver-tv.ts";
const out = path.join(os.homedir(), ".stepd", "naver-probe");
const { browser, ctx } = await openNaverContext(false);
const page = await ctx.newPage();
page.setDefaultTimeout(45_000);
const L: string[] = [];
await page.goto(NAVER_TARGETS.tv.uploadUrl, { waitUntil: "networkidle" });
for (let i = 0; i < 3; i++) {
  if (!(await page.locator('[role="dialog"]').count())) break;
  const ok = await page.locator('[role="dialog"] button:has-text("닫기")').first().click({ timeout: 4000 }).then(() => true).catch(() => false);
  if (!ok) await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
}
await page.locator('button:has-text("동영상 업로드")').first().click({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.locator('input[type="file"]').first().setInputFiles(process.argv[2]);
await page.waitForTimeout(22000);

const dump = async (tag: string) => {
  L.push(`--- ${tag} ---`);
  for (const sel of ['[class*="Option"]', '[role="option"]', '[role="listbox"]', 'ul li', '[class*="Dropdown"]', '[class*="dropdown"]', '[class*="Select"]']) {
    L.push(`${sel}: ${await page.locator(sel).count()}`);
  }
  L.push("visible option texts: " + JSON.stringify(
    (await page.locator('[class*="Option"], [role="option"]').allTextContents()).slice(0, 30)));
};

// 1차 열기 → 엔터 선택
await page.locator('button:has-text("1차 카테고리")').first().click().catch((e) => L.push("p1 click: " + e.message));
await page.waitForTimeout(1200);
await dump("1차 열림");
await page.locator('[class*="Option"], [role="option"]').filter({ hasText: /^\s*엔터\s*$/ }).first().click().catch((e) => L.push("p1 pick: " + e.message));
await page.waitForTimeout(1500);

// 2차 열기
const sec = page.locator('button:has-text("2차 카테고리")');
L.push(`2차 트리거 개수: ${await sec.count()} · disabled=${await sec.first().isDisabled().catch(() => "?")}`);
await sec.first().click().catch((e) => L.push("p2 click: " + e.message));
await page.waitForTimeout(1500);
await dump("2차 열림");
fs.writeFileSync(path.join(out, "tv-cat.txt"), L.join("\n"), "utf-8");
await page.screenshot({ path: path.join(out, "tv-cat.png"), fullPage: true }).catch(() => {});
await ctx.close(); await browser.close(); process.exit(0);

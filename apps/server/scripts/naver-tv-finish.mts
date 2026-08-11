/** 네이버 TV 상세 패널 구조 덤프 — 제출 버튼·카테고리 확인용. */
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
  await page.waitForTimeout(900);
}
await page.locator('button:has-text("동영상 업로드")').first().click({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.locator('input[type="file"]').first().setInputFiles(process.argv[2]);
await page.waitForTimeout(25000);
L.push("url: " + page.url());
// 상세 패널 안의 입력·버튼
L.push("inputs: " + JSON.stringify(await page.locator("input, textarea").evaluateAll(
  (els) => els.map((e) => ({ tag: e.tagName, ph: (e as HTMLInputElement).placeholder || null,
    cls: (typeof e.className === "string" ? e.className.slice(0, 45) : null) })))));
L.push("buttons: " + JSON.stringify((await page.locator("button").allTextContents()).map((t) => t.trim()).filter(Boolean).slice(0, 45)));
L.push("body: " + (await page.locator("body").innerText()).split("\n").join(" | ").slice(-1400));
fs.writeFileSync(path.join(out, "tv-detail.txt"), L.join("\n\n"), "utf-8");
await page.screenshot({ path: path.join(out, "tv-detail.png"), fullPage: true }).catch(() => {});
await ctx.close(); await browser.close(); process.exit(0);

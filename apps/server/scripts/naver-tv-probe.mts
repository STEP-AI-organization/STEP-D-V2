/** 네이버 TV 크리에이터 스튜디오 — 직접 진입 가능 여부 + 업로드 모달 구조. */
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { openNaverContext } from "../src/naver/naver-tv.ts";
const out = path.join(os.homedir(), ".stepd", "naver-probe");
fs.mkdirSync(out, { recursive: true });
const { browser, ctx } = await openNaverContext(false);
const page = await ctx.newPage();
page.setDefaultTimeout(45_000);
const lines: string[] = [];

// 1) 채널ID 없이 루트로 들어가면 자기 채널로 리다이렉트되는지
await page.goto("https://creator.tv.naver.com/", { waitUntil: "networkidle" }).catch((e) => lines.push("goto: " + e.message));
await page.waitForTimeout(3000);
lines.push(`creator root -> ${page.url()}`);

// 1-b) 진입 시 떠 있는 모달(공지/온보딩)을 닫는다 — dimmed 레이어가 클릭을 전부 막는다
for (let i = 0; i < 3; i++) {
  const dlg = page.locator('[role="dialog"]');
  if (!(await dlg.count().catch(() => 0))) break;
  const closed = await page.locator('[role="dialog"] button:has-text("닫기"), [role="dialog"] button[aria-label="닫기"]')
    .first().click({ timeout: 5000 }).then(() => true).catch(() => false);
  if (!closed) await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1200);
}
lines.push(`dialogs after close: ${await page.locator('[role="dialog"]').count()}`);

// 2) 업로드 모달 열기
await page.locator('button:has-text("동영상 업로드")').first().click().catch((e) => lines.push("open fail: " + e.message));
await page.waitForTimeout(3000);
lines.push(`after open: ${page.url()}`);
lines.push(`file inputs: ${await page.locator('input[type="file"]').count()}`);
lines.push("buttons: " + JSON.stringify((await page.locator("button").allTextContents()).filter(Boolean).slice(0, 25)));
const video = process.argv[2];
if (video) {
  await page.locator('input[type="file"]').first().setInputFiles(video);
  await page.waitForTimeout(25000);
  lines.push(`after file: ${page.url()}`);
  lines.push(`textareas: ${await page.locator("textarea").count()} · textInputs: ${await page.locator('input[type=text], input:not([type])').count()}`);
  lines.push("phs: " + JSON.stringify(await page.locator("input, textarea").evaluateAll(
    (els) => els.map((e) => (e as HTMLInputElement).placeholder || e.getAttribute("aria-label")).filter(Boolean))));
  lines.push("buttons2: " + JSON.stringify((await page.locator("button").allTextContents()).filter(Boolean).slice(0, 30)));
}
lines.push("body: " + (await page.locator("body").innerText()).split("\n").join(" | ").slice(0, 700));
fs.writeFileSync(path.join(out, "tv-modal.txt"), lines.join("\n"), "utf-8");
await page.screenshot({ path: path.join(out, "tv-modal.png"), fullPage: true }).catch(() => {});
await ctx.close(); await browser.close(); process.exit(0);

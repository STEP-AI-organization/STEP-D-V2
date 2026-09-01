/** 네이버 TV 콘텐츠 목록 상태 확인 — 초안인지 공개인지. */
import { openNaverContext } from "../src/naver/naver-tv.ts";
const { browser, ctx } = await openNaverContext(false);
const page = await ctx.newPage();
page.setDefaultTimeout(45_000);
await page.goto("https://creator.tv.naver.com/", { waitUntil: "networkidle" });
for (let i = 0; i < 3; i++) {
  if (!(await page.locator('[role="dialog"]').count())) break;
  const ok = await page.locator('[role="dialog"] button:has-text("닫기")').first().click({ timeout: 4000 }).then(() => true).catch(() => false);
  if (!ok) await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
}
await page.goto(page.url().replace("/dashboard", "/content/video"), { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
const txt = (await page.locator("body").innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
const i = txt.findIndex((t) => t.includes("동영상 전체"));
console.log(txt.slice(i, i + 40).join(" | "));
await ctx.close(); await browser.close(); process.exit(0);

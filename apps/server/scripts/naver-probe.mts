/**
 * 네이버 업로드 페이지 DOM 프로브 — 셀렉터를 실측으로 맞추기 위한 개발 도구.
 *
 *   pnpm --filter @stepd/server naver:probe clip
 *   pnpm --filter @stepd/server naver:probe clip <영상경로>   # 2단계(메타데이터 폼)까지
 *
 * 영상 경로를 주면 파일을 실제로 넣어 다음 화면을 띄운다 — **바이트가 네이버로 올라간다.**
 * 제출(발행)은 절대 하지 않는다. 그래도 임시저장이 남을 수 있으니 계정을 확인할 것.
 */
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
import { openNaverContext, NAVER_TARGETS } from "../src/naver/naver-tv.ts";

const target = (process.argv[2] ?? "clip") as "tv" | "clip";
const videoPath = process.argv[3];
const T = NAVER_TARGETS[target];
const dir = path.join(os.homedir(), ".stepd", "naver-probe");
fs.mkdirSync(dir, { recursive: true });

// tsx 가 화살표함수에 __name 헬퍼를 주입해 evaluate 가 깨진다 → 문자열로 넘긴다.
const DUMP = `(() => {
  var q = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var d = function(e){ return {
    tag: e.tagName.toLowerCase(), type: e.type || null, name: e.name || null,
    id: e.id || null, cls: (typeof e.className === "string" ? e.className.slice(0,60) : null),
    ph: e.placeholder || null, aria: e.getAttribute("aria-label") || null,
    text: (e.textContent||"").trim().slice(0,30) || null }; };
  return {
    fileInputs: q('input[type=file]').map(d),
    textInputs: q('input[type=text], input:not([type])').map(d).slice(0,15),
    textareas: q('textarea').map(d).slice(0,10),
    editables: q('[contenteditable=true]').map(d).slice(0,10),
    buttons: q('button').map(d).slice(0,30),
    bodyText: document.body.innerText.split(String.fromCharCode(10)).join(' | ').slice(0,900)
  };
})()`;

const { browser, ctx } = await openNaverContext(false);
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);
await page.goto(T.uploadUrl, { waitUntil: "networkidle" }).catch((e) => console.log("goto:", e.message));
await page.waitForTimeout(2500);
console.log("URL   :", page.url());
console.log("LOGIN :", /nid\.naver\.com|login/.test(page.url()) ? "NO" : "YES");

let stage = "1";
if (videoPath) {
  if (!fs.existsSync(videoPath)) { console.error("파일 없음:", videoPath); process.exit(1); }
  console.log("파일 투입:", videoPath);
  await page.locator('input[type="file"]').first().setInputFiles(videoPath);
  // 업로드 진행 + 폼 렌더까지 여유 있게 기다린다(진행률 UI 가 뜨는 동안 DOM 이 계속 바뀐다).
  await page.waitForTimeout(20_000);
  stage = "2";
  console.log("URL(2단계):", page.url());
}
console.log(JSON.stringify(await page.evaluate(DUMP), null, 1));
const shot = path.join(dir, `${target}-stage${stage}.png`);
await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
console.log("SHOT  :", shot);
await ctx.close(); await browser.close(); process.exit(0);

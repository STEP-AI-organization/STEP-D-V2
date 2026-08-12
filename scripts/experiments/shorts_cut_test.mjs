/**
 * shorts.json 추천 결과를 실제 컷 스냅 로직으로 잘라내 검증.
 * 각 쇼츠마다 raw(스냅 없음) vs snap(word+frame) 두 파일 생성.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [, , videoArg, refinedArg, shortsArg, outDirArg] = process.argv;
const video = videoArg || "C:/tmp/ytest_J2XZyU5OIII.mp4";
const refined = refinedArg || "C:/tmp/ytest_analyze/refined.json";
const shortsFile = shortsArg || "C:/tmp/ytest_analyze/shorts.json";
const outDir = outDirArg || "C:/tmp/ytest_shorts";

import { mkdirSync } from "node:fs";
mkdirSync(outDir, { recursive: true });

const segs = JSON.parse(readFileSync(refined, "utf-8"));
const segments = Array.isArray(segs) ? segs : segs.segments;
const shorts = JSON.parse(readFileSync(shortsFile, "utf-8"));
const list = Array.isArray(shorts) ? shorts : shorts.shorts || [];

// index.ts snap logic
function snapToWordBoundary(target, transcript, mode, tolerance = 0.4) {
  if (!Array.isArray(transcript)) return target;
  let best = null;
  for (const s of transcript) {
    const segStart = Number(s?.start);
    const segEnd = Number(s?.end);
    if (!isFinite(segStart) || !isFinite(segEnd)) continue;
    if (segEnd < target - tolerance || segStart > target + tolerance) continue;
    const raw = s?.words;
    const wordList = Array.isArray(raw) && raw.length
      ? raw.map(w => ({ start: Number(w?.start), end: Number(w?.end) }))
           .filter(w => isFinite(w.start) && isFinite(w.end))
      : [{ start: segStart, end: segEnd }];
    for (const w of wordList) {
      if (w.start <= target && target <= w.end) {
        return mode === "start" ? w.start : w.end;
      }
      const cand = mode === "start" ? w.start : w.end;
      const shift = Math.abs(cand - target);
      if (shift <= tolerance && (best === null || shift < Math.abs(best - target))) best = cand;
    }
  }
  return best ?? target;
}
const FPS = 29.97;
const snapFrame = t => Math.round(t * FPS) / FPS;

for (let i = 0; i < list.length; i++) {
  const s = list[i];
  const st = Number(s.start), en = Number(s.end);
  const title = (s.title || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);

  const snapSt = snapFrame(snapToWordBoundary(st, segments, "start"));
  const snapEn = snapFrame(snapToWordBoundary(en, segments, "end"));

  console.log(`── #${i+1} "${title}"`);
  console.log(`   raw : ${st.toFixed(2)}s → ${en.toFixed(2)}s (${(en-st).toFixed(1)}s)`);
  console.log(`   snap: ${snapSt.toFixed(3)}s → ${snapEn.toFixed(3)}s (${(snapEn-snapSt).toFixed(2)}s) · ${((snapSt-st)*1000).toFixed(0)}ms/${((snapEn-en)*1000).toFixed(0)}ms`);

  for (const [label, so, eo] of [["raw", st, en], ["snap", snapSt, snapEn]]) {
    const out = `${outDir}/short_${String(i+1).padStart(2,"0")}_${label}_${title}.mp4`;
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-ss", String(so), "-i", video, "-t", String(eo - so),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", out,
    ], { stdio: "inherit" });
  }
}

console.log(`\n✓ ${outDir}/`);

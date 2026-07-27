// Snap 함수 실측 — 실 whisper 결과(/c/tmp/stt_probe_result.json)로 word+frame snap 검증.
// 목적: 요청 boundary가 대사 중간이거나 무음 gap일 때 각각 예상대로 동작하는지.

import { readFileSync } from "node:fs";

// index.ts와 동일 로직 (JS로 복사)
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
      if (shift <= tolerance && (best === null || shift < Math.abs(best - target))) {
        best = cand;
      }
    }
  }
  return best ?? target;
}

function snapToFrame(t, fps) {
  if (!fps || fps <= 0) return t;
  return Math.round(t * fps) / fps;
}

const raw = readFileSync("C:/tmp/stt_probe_result.json");
const data = JSON.parse(raw.toString("utf-8"));
const fps = data.fps;
const segs = data.segments;

console.log(`전사 세그 ${segs.length}개 · fps=${fps.toFixed(3)} (1 frame=${(1000/fps).toFixed(2)}ms)\n`);

// 실측 케이스: 각 세그의 mid, start-0.1, end+0.1, 무음 gap 등
const cases = [];
for (let i = 0; i < segs.length; i++) {
  const s = segs[i];
  cases.push({ label: `seg#${i} mid`,       t: (s.start + s.end) / 2 });
  cases.push({ label: `seg#${i} start-0.05`, t: s.start - 0.05 });
  cases.push({ label: `seg#${i} start+0.2`,  t: s.start + 0.2 });
  cases.push({ label: `seg#${i} end-0.2`,    t: s.end - 0.2 });
  cases.push({ label: `seg#${i} end+0.05`,   t: s.end + 0.05 });
}
// 무음 gap 케이스
if (segs.length > 1) {
  for (let i = 1; i < segs.length; i++) {
    const gap = (segs[i-1].end + segs[i].start) / 2;
    if (segs[i].start - segs[i-1].end > 1.0) {
      cases.push({ label: `gap seg#${i-1}→#${i}`, t: gap });
    }
  }
}

console.log("target(원) → wordSnap(start/end) → frameSnap  Δ_ms");
console.log("─".repeat(90));
let wordChanged = 0, frameChanged = 0, tot = cases.length;
for (const {label, t} of cases) {
  const ws = snapToWordBoundary(t, segs, "start");
  const we = snapToWordBoundary(t, segs, "end");
  const fs = snapToFrame(ws, fps);
  const dwStart = (ws - t) * 1000;
  const dwEnd = (we - t) * 1000;
  const df = (fs - ws) * 1000;
  if (Math.abs(dwStart) > 0.01 || Math.abs(dwEnd) > 0.01) wordChanged++;
  if (Math.abs(df) > 0.01) frameChanged++;
  console.log(
    `${label.padEnd(20)} ${t.toFixed(3)} → ` +
    `s=${ws.toFixed(3)}(${dwStart >= 0 ? "+" : ""}${dwStart.toFixed(1)}ms) ` +
    `e=${we.toFixed(3)}(${dwEnd >= 0 ? "+" : ""}${dwEnd.toFixed(1)}ms) ` +
    `→ f=${fs.toFixed(4)}(${df >= 0 ? "+" : ""}${df.toFixed(2)}ms)`
  );
}
console.log("─".repeat(90));
console.log(`요약: ${tot}개 · word snap 이동 ${wordChanged}개 · frame snap 이동 ${frameChanged}개`);

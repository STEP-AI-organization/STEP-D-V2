/**
 * 드리프트 의심 지점 자동 스캔 — 전체 세그의 통계·이상치 리포트.
 *
 * 감지:
 *   1) 큰 세그 갭 (>5s) — VAD가 침묵으로 오판 or Gemini 창 경계 dropout
 *   2) 비정상 word duration (>2s, <0.05s) — whisper 할루시네이션/음악 오독
 *   3) 겹치는 세그 (start[i+1] < end[i]) — 세그 정렬 붕괴
 *   4) 30s 청크 경계(faster-whisper 내부 30s단위)에 유난히 몰린 boundary
 *   5) seg 안 word gap > 1s (침묵 삼킴)
 *   6) 후반 세그의 word 평균 duration이 초반보다 크면 timestamp stretch 조짐
 */
import { readFileSync } from "node:fs";

const path = process.argv[2] || "C:/tmp/stt_probe_result.json";
const data = JSON.parse(readFileSync(path, "utf-8"));
const segs = data.segments;
const fps = data.fps;

console.log(`전사 세그 ${segs.length}개 · fps=${fps.toFixed(3)}`);
console.log(`전체 커버 ${segs[0].start.toFixed(1)}s → ${segs[segs.length-1].end.toFixed(1)}s`);
console.log();

// 1) 큰 세그 갭
console.log("── 큰 세그 gap (>5s) ──");
for (let i = 1; i < segs.length; i++) {
  const gap = segs[i].start - segs[i-1].end;
  if (gap > 5) {
    console.log(`  seg#${i-1}(${segs[i-1].end.toFixed(1)}s) → seg#${i}(${segs[i].start.toFixed(1)}s) gap=${gap.toFixed(1)}s`);
  }
}
console.log();

// 2) 이상 word duration
console.log("── 비정상 word (dur > 2s or < 0.05s) ──");
let bad = 0;
for (let i = 0; i < segs.length; i++) {
  for (const w of (segs[i].words || [])) {
    const d = w.end - w.start;
    if (d > 2.0 || d < 0.05) {
      if (bad < 15) console.log(`  seg#${i} @${w.start.toFixed(2)}s "${(w.word||'').trim()}" dur=${(d*1000).toFixed(0)}ms`);
      bad++;
    }
  }
}
if (bad >= 15) console.log(`  ... 총 ${bad}개 이상 word`);
if (bad === 0) console.log("  (없음)");
console.log();

// 3) 겹치는 세그
console.log("── 겹치는 세그 (start[i+1] < end[i]) ──");
let ov = 0;
for (let i = 1; i < segs.length; i++) {
  if (segs[i].start < segs[i-1].end - 0.01) {
    if (ov < 10) console.log(`  seg#${i-1}(→${segs[i-1].end.toFixed(2)}) vs seg#${i}(${segs[i].start.toFixed(2)}→)`);
    ov++;
  }
}
if (ov === 0) console.log("  (없음)");
else console.log(`  총 ${ov}개 겹침`);
console.log();

// 4) 30s 청크 경계 몰림
console.log("── 30s 청크 경계 부근 세그 시작 (drift 위험 지대) ──");
const chunkStarts = [];
for (const s of segs) {
  const mod = s.start % 30;
  if (mod < 0.5 || mod > 29.5) {
    chunkStarts.push({ start: s.start, mod });
  }
}
if (chunkStarts.length < 8) {
  for (const c of chunkStarts) console.log(`  @${c.start.toFixed(2)}s (mod30=${c.mod.toFixed(2)})`);
} else {
  console.log(`  ${chunkStarts.length}개 세그가 청크 경계 ±0.5s (전체 ${segs.length}개 중 ${(100*chunkStarts.length/segs.length).toFixed(1)}%)`);
}
console.log();

// 5) 세그 안 word gap
console.log("── seg 내 word 간 큰 gap (>1s · 침묵 삼킴) ──");
let ig = 0;
for (let i = 0; i < segs.length; i++) {
  const ws = segs[i].words || [];
  for (let j = 1; j < ws.length; j++) {
    const g = ws[j].start - ws[j-1].end;
    if (g > 1.0) {
      if (ig < 10) console.log(`  seg#${i} ${ws[j-1].end.toFixed(2)}s→${ws[j].start.toFixed(2)}s gap=${g.toFixed(2)}s`);
      ig++;
    }
  }
}
if (ig === 0) console.log("  (없음)");
else if (ig >= 10) console.log(`  ... 총 ${ig}개`);
console.log();

// 6) 후반부 word duration 비교 (drift stretch 조짐)
console.log("── 전·후반 word duration 평균 (stretch drift 조짐) ──");
const wallWords = [];
for (const s of segs) for (const w of (s.words || [])) wallWords.push(w);
if (wallWords.length > 20) {
  const q1 = wallWords.slice(0, Math.floor(wallWords.length / 4));
  const q4 = wallWords.slice(-Math.floor(wallWords.length / 4));
  const avg = (a) => a.reduce((s, w) => s + (w.end - w.start), 0) / a.length;
  const a1 = avg(q1) * 1000;
  const a4 = avg(q4) * 1000;
  const rel = ((a4 - a1) / a1) * 100;
  console.log(`  전 25% 평균: ${a1.toFixed(0)}ms`);
  console.log(`  후 25% 평균: ${a4.toFixed(0)}ms (${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%)`);
  if (Math.abs(rel) > 15) console.log("  ⚠ 15% 이상 차이 · 후반부 timestamp 팽창/축소 의심");
  else console.log("  ✓ 15% 이내 · stretch 드리프트 미미");
}
console.log();

// 7) 30s 청크 경계에서의 gap 분포 확인
console.log("── 30s 배수 boundary 전후 gap ──");
for (let boundary = 30; boundary <= segs[segs.length-1].end; boundary += 30) {
  const before = segs.filter(s => s.end <= boundary && s.end > boundary - 5).pop();
  const after = segs.find(s => s.start >= boundary && s.start < boundary + 5);
  if (before && after) {
    const gap = after.start - before.end;
    if (gap > 2) console.log(`  @${boundary}s: ${before.end.toFixed(2)}s→${after.start.toFixed(2)}s gap=${gap.toFixed(2)}s`);
  }
}

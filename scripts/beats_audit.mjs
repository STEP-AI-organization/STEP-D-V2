/**
 * beats.json audit — beat 경계·안 대사·요약이 실제 흐름과 맞는지.
 * shots(shot boundary) 대비 beat이 어떻게 grouping됐는지도 확인.
 */
import { readFileSync } from "node:fs";

const beats = JSON.parse(readFileSync("C:/tmp/ytest_analyze/beats.json", "utf-8"));
const refined = JSON.parse(readFileSync("C:/tmp/ytest_analyze/refined.json", "utf-8"));
const shots = JSON.parse(readFileSync("C:/tmp/ytest_analyze/shots.json", "utf-8"));
const segs = Array.isArray(refined) ? refined : refined.segments;

const beatList = Array.isArray(beats) ? beats : beats.beats || [];
const shotList = Array.isArray(shots) ? shots : shots.shots || shots.boundaries || [];

console.log(`beat ${beatList.length}개 · shot boundary ${shotList.length}개 · refined ${segs.length}세그\n`);

for (let i = 0; i < beatList.length; i++) {
  const b = beatList[i];
  const st = Number(b.start ?? b.startTime ?? 0);
  const en = Number(b.end ?? b.endTime ?? 0);
  const dur = en - st;
  const title = b.title || b.name || b.label || "-";
  const summary = b.summary || b.description || b.text || "";
  const type = b.type || b.beat_type || b.kind || "-";

  const inRange = segs.filter(g => g.start >= st - 0.5 && g.end <= en + 0.5 && (g.text || "").trim());
  const dialoguePreview = inRange.slice(0, 8).map(g => (g.text || "").trim()).join(" ");
  const truncated = dialoguePreview.length > 200 ? dialoguePreview.slice(0, 200) + "…" : dialoguePreview;

  const shotsInBeat = shotList.filter(s => {
    const sst = Number(s.start ?? s.t ?? s.time ?? 0);
    return sst >= st - 0.5 && sst <= en + 0.5;
  }).length;

  console.log(`── beat #${i+1} [${st.toFixed(1)}s → ${en.toFixed(1)}s] (${dur.toFixed(0)}s) type=${type}`);
  console.log(`   TITLE  : ${title}`);
  if (summary) console.log(`   SUMMARY: ${String(summary).slice(0, 200)}`);
  console.log(`   대사 ${inRange.length}세그 · shot boundary ${shotsInBeat}개 in range`);
  console.log(`   ${truncated}\n`);
}

// beat 커버율 · 경계 겹침·구멍 검사
console.log("── beat 커버 검사 ──");
let coverStart = null, coverEnd = null, gaps = 0, overlaps = 0;
const sorted = [...beatList].sort((a, b) => Number(a.start||0) - Number(b.start||0));
for (let i = 0; i < sorted.length; i++) {
  const st = Number(sorted[i].start ?? 0), en = Number(sorted[i].end ?? 0);
  if (coverStart === null) coverStart = st;
  coverEnd = Math.max(coverEnd ?? 0, en);
  if (i > 0) {
    const prevEn = Number(sorted[i-1].end ?? 0);
    const gap = st - prevEn;
    if (gap > 5) { console.log(`   gap ${gap.toFixed(1)}s @ ${prevEn.toFixed(1)}→${st.toFixed(1)}`); gaps++; }
    if (gap < -0.5) { console.log(`   overlap ${(-gap).toFixed(1)}s @ ${st.toFixed(1)}`); overlaps++; }
  }
}
console.log(`   커버: ${coverStart?.toFixed(1)}s → ${coverEnd?.toFixed(1)}s (${(coverEnd - coverStart).toFixed(0)}s)`);
console.log(`   전체 592s 대비 커버율: ${(100 * (coverEnd - coverStart) / 592).toFixed(0)}%`);
console.log(`   gaps=${gaps} · overlaps=${overlaps}`);

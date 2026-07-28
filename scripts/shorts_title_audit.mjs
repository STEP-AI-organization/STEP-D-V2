/**
 * 쇼츠 제목 vs 실제 컷 안 대사 · 얼마나 매칭되나 audit.
 * 각 쇼츠 구간 안의 refined 세그를 뽑아 대사 요약 · 제목·근거·hook과 대조.
 */
import { readFileSync } from "node:fs";

const analyze = JSON.parse(readFileSync("C:/tmp/ytest_analyze/analysis.json", "utf-8"));
const refined = JSON.parse(readFileSync("C:/tmp/ytest_analyze/refined.json", "utf-8"));
const segs = Array.isArray(refined) ? refined : refined.segments;
const shorts = analyze.shorts || [];

console.log(`쇼츠 ${shorts.length}개 audit (구간 안 실제 대사 vs 제목)\n`);

for (let i = 0; i < shorts.length; i++) {
  const s = shorts[i];
  const st = Number(s.start), en = Number(s.end);

  const inRange = segs.filter(g => g.start >= st - 0.5 && g.end <= en + 0.5 && (g.text || "").trim());
  const text = inRange.map(g => (g.text || "").trim()).join(" ");
  const preview = text.length > 300 ? text.slice(0, 300) + "…" : text;

  console.log(`── #${i+1} [${st}s→${en}s] (${(en-st).toFixed(0)}s)`);
  console.log(`   TITLE : ${s.title || "-"}`);
  console.log(`   HOOK  : ${s.hook || s.reason || "-"}`);
  if (s.tags) console.log(`   TAGS  : ${JSON.stringify(s.tags).slice(0,120)}`);
  if (s.rationale) console.log(`   RATIO : ${String(s.rationale).slice(0,140)}`);
  console.log(`   대사(${inRange.length}세그):`);
  console.log(`     ${preview}`);
  console.log();
}

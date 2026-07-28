/**
 * 컷 스냅 실측 — snap 로직이 실제로 대사 안 자르는지 검증.
 *
 * 방법: refined.json의 세그 몇 개를 골라 "일부러 대사 도중에 컷" 케이스 만든 뒤,
 *   1) raw:     그 값 그대로 ffmpeg -ss/-t로 잘라냄 (대사 중간 절단)
 *   2) snapped: snapToWordBoundary + snapToFrame 적용한 값으로 잘라냄 (대사 완결)
 * 각 케이스마다 두 파일을 나란히 만들어 A/B 재생 비교.
 *
 * 사용: node scripts/cut_snap_compare.mjs
 * 출력: C:/tmp/cut_raw_N.mp4 · C:/tmp/cut_snap_N.mp4 (N=1..5)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VIDEO = "C:/Users/STEPAI05/STEPD-repo/core/TpQgkCs0TzE.mp4";
const STT = "C:/tmp/refined_result.json";
const data = JSON.parse(readFileSync(STT, "utf-8"));
const segs = data.segments;
const fps = data.fps || 29.97;

// index.ts의 snap 로직 (동일)
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
  return fps > 0 ? Math.round(t * fps) / fps : t;
}

// 실측 케이스 선정 — 세그 중 words 배열이 3+개이고 실제 대사가 있는 것 5개
const candidates = segs
  .filter(s => (s.words || []).length >= 3 && (s.text || "").length >= 10)
  .filter((_, i, arr) => {
    // 골고루 뽑아 전·중·후반 커버
    const stride = Math.floor(arr.length / 5);
    return i % stride === 0;
  })
  .slice(0, 5);

console.log(`fps=${fps.toFixed(2)} · 세그 총 ${segs.length}개 · 실측 케이스 ${candidates.length}개\n`);

for (let idx = 0; idx < candidates.length; idx++) {
  const s = candidates[idx];
  const words = s.words;
  const firstWordEnd = words[0].end;
  const lastWordStart = words[words.length - 1].start;

  // 일부러 "대사 도중에 시작 · 대사 도중에 끝" 만들기
  //   raw start = words[0] 중간
  //   raw end   = words[last] 중간
  // 이러면 raw 컷은 첫 단어 후반부·마지막 단어 전반부만 걸침 → 부자연스러운 절단.
  const rawStart = (words[0].start + firstWordEnd) / 2;
  const rawEnd = (lastWordStart + words[words.length - 1].end) / 2;

  const snapStart = snapToFrame(snapToWordBoundary(rawStart, segs, "start"), fps);
  const snapEnd = snapToFrame(snapToWordBoundary(rawEnd, segs, "end"), fps);

  console.log(`── 케이스 #${idx + 1} · 세그 [${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s]`);
  console.log(`   text : ${(s.text || "").slice(0, 80)}`);
  console.log(`   raw  : ${rawStart.toFixed(3)}s → ${rawEnd.toFixed(3)}s (dur ${(rawEnd - rawStart).toFixed(2)}s)`);
  console.log(`   snap : ${snapStart.toFixed(3)}s → ${snapEnd.toFixed(3)}s (dur ${(snapEnd - snapStart).toFixed(2)}s)`);
  console.log(`   shift: start ${((snapStart - rawStart) * 1000).toFixed(0)}ms · end ${((snapEnd - rawEnd) * 1000).toFixed(0)}ms`);

  for (const [label, st, en] of [["raw", rawStart, rawEnd], ["snap", snapStart, snapEnd]]) {
    const out = `C:/tmp/cut_${label}_${idx + 1}.mp4`;
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-ss", String(st),
      "-i", VIDEO,
      "-t", String(en - st),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac",
      out,
    ], { stdio: "inherit" });
  }
  console.log(`   ✓ C:/tmp/cut_raw_${idx + 1}.mp4 · C:/tmp/cut_snap_${idx + 1}.mp4\n`);
}

console.log("=== 실측 완료 ===");
console.log("각 케이스마다 두 파일 A/B 재생 비교:");
console.log("  · raw_N.mp4 : 대사 중간에서 시작/끊김");
console.log("  · snap_N.mp4: word 경계 스냅으로 대사 완결");

/**
 * STT 싱크 검증용 자막 burn — whisper words를 karaoke ASS로 만들어 원본에 태워냄.
 * 결과 재생 시:
 *   1) 세그 텍스트가 화면 하단에 나타남 (start~end)
 *   2) 각 단어가 말과 동시에 하이라이트됨 (karaoke \k)
 *   3) 상단에 요청 시각 vs word 시각 오차 없음을 눈으로 확인
 *
 * 사용: node scripts/stt_sync_burn.mjs <video> <stt.json> <out.mp4>
 * 기본: /tmp/stt_test.mp4 · C:/tmp/stt_probe_result.json · C:/tmp/stt_sync_check.mp4
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [,, videoArg, sttArg, outArg] = process.argv;
const video = videoArg || "C:/Users/STEPAI05/AppData/Local/Temp/stt_test.mp4";
const sttPath = sttArg || "C:/tmp/stt_probe_result.json";
const out = outArg || "C:/tmp/stt_sync_check.mp4";
const assPath = "C:/tmp/stt_sync_check.ass";

const data = JSON.parse(readFileSync(sttPath, "utf-8"));
const segs = data.segments;

// ASS 시간 포맷: H:MM:SS.cc (centiseconds)
function ts(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const cs = Math.round((s - whole) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// 화면에 각 세그마다 하단 노랑 자막 + 상단 시각 표시. 각 word는 \k centiseconds로 karaoke.
const events = [];
for (const s of segs) {
  const words = s.words || [];
  if (!words.length) continue;

  // Karaoke: \kNN 은 그 word가 NN centiseconds 후에 하이라이트됨
  // ASS는 word 앞 시각을 event start와 맞춰야 하니 첫 word 앞 침묵도 계산.
  const evStart = words[0].start;
  const evEnd = words[words.length - 1].end;
  let karaoke = "";
  let cursor = evStart;
  for (const w of words) {
    const gap = Math.max(0, w.start - cursor);
    if (gap > 0.01) karaoke += `{\\k${Math.round(gap * 100)}}`;  // 침묵/gap
    const dur = Math.max(1, Math.round((w.end - w.start) * 100));
    karaoke += `{\\k${dur}\\c&H00FFFF&}${(w.word || "").trim()}{\\c&HFFFFFF&} `;
    cursor = w.end;
  }
  // 하단 karaoke 자막
  events.push(`Dialogue: 0,${ts(evStart)},${ts(evEnd)},Bottom,,0,0,0,,${karaoke.trim()}`);
  // 상단 시각 라벨 (요청 boundary가 정확한지 눈으로 확인)
  events.push(`Dialogue: 0,${ts(evStart)},${ts(evEnd)},Top,,0,0,0,,` +
    `{\\c&H00FF00&}[${evStart.toFixed(2)}s → ${evEnd.toFixed(2)}s · ${words.length} words]`);
}

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bottom,Malgun Gothic,56,&H00FFFFFF,&H0000FFFF,&H00000000,&H88000000,1,0,0,0,100,100,0,0,1,3,2,2,60,60,80,1
Style: Top,Consolas,32,&H00FFFFFF,&H00808080,&H00000000,&H88000000,1,0,0,0,100,100,0,0,1,2,1,8,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;

writeFileSync(assPath, ass, "utf-8");
console.log(`[burn] ASS → ${assPath} (${events.length} events)`);

// ffmpeg subtitles filter (ASS 경로에 콜론·백슬래시 escape 필요)
const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
console.log(`[burn] burning subs into ${out} ...`);
execFileSync("ffmpeg", [
  "-y", "-v", "warning", "-stats",
  "-i", video,
  "-vf", `ass='${escapedAss}'`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
  "-c:a", "copy",
  out,
], { stdio: "inherit" });

console.log(`\n✓ 확인용 영상 → ${out}`);
console.log(`  · 하단 노랑: 세그 자막(단어별 karaoke — 말과 동시에 밝아짐)`);
console.log(`  · 상단 초록: 요청 시각 [start → end · words 개수]`);
console.log(`  · 재생하며 하단 자막이 실제 대사와 일치하는지 확인`);

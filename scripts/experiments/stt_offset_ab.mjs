/**
 * Offset A/B — WhisperX word timestamp에 +Nms를 더해 재burn.
 * 3개 파일 나란히 만들어 어느 offset이 청각적으로 맞는지 눈으로 결정.
 *
 * 사용: node scripts/stt_offset_ab.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const video = "C:/Users/STEPAI05/STEPD-repo/core/TpQgkCs0TzE.mp4";
const sttPath = "C:/tmp/whisperx_result.json";
const OFFSETS_MS = [100, 150, 200];

const data = JSON.parse(readFileSync(sttPath, "utf-8"));
const segs = data.segments;

function ts(sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const cs = Math.round((s - whole) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

for (const offsetMs of OFFSETS_MS) {
  const shift = offsetMs / 1000;
  const assPath = `C:/tmp/stt_sync_off${offsetMs}.ass`;
  const outMp4 = `C:/tmp/stt_sync_off${offsetMs}.mp4`;

  const events = [];
  for (const s of segs) {
    const words = s.words || [];
    if (!words.length) continue;
    const evStart = words[0].start + shift;
    const evEnd = words[words.length - 1].end + shift;
    let karaoke = "";
    let cursor = evStart;
    for (const w of words) {
      const ws = w.start + shift;
      const we = w.end + shift;
      const gap = Math.max(0, ws - cursor);
      if (gap > 0.01) karaoke += `{\\k${Math.round(gap * 100)}}`;
      const dur = Math.max(1, Math.round((we - ws) * 100));
      karaoke += `{\\k${dur}\\c&H00FFFF&}${(w.word || "").trim()}{\\c&HFFFFFF&} `;
      cursor = we;
    }
    events.push(`Dialogue: 0,${ts(evStart)},${ts(evEnd)},Bottom,,0,0,0,,${karaoke.trim()}`);
    events.push(`Dialogue: 0,${ts(evStart)},${ts(evEnd)},Top,,0,0,0,,` +
      `{\\c&H00FF00&}[offset +${offsetMs}ms] ${evStart.toFixed(2)}s → ${evEnd.toFixed(2)}s`);
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

  const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  console.log(`\n[burn +${offsetMs}ms] → ${outMp4}`);
  execFileSync("ffmpeg", [
    "-y", "-v", "warning", "-stats",
    "-i", video,
    "-vf", `ass='${escapedAss}'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "copy",
    outMp4,
  ], { stdio: "inherit" });
}

console.log("\n\n=== 완료 ===");
for (const o of OFFSETS_MS) {
  console.log(`  +${o}ms → C:/tmp/stt_sync_off${o}.mp4`);
}
console.log("\n세 개 재생 비교 · 어느 게 청각과 정확히 맞는지 판정 부탁");

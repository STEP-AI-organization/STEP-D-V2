/**
 * 이미 python -m core.analyze로 생성된 결과를 DB에 수동 삽입 (재분석 없이 UI에 뜨게).
 *
 * 사용:
 *   pnpm --filter @stepd/server exec tsx ../../scripts/ingest_analysis.ts \
 *     --video C:/tmp/ytest_J2XZyU5OIII.mp4 \
 *     --analyze-dir C:/tmp/ytest_analyze \
 *     --program-title "환승연애4" \
 *     --episode-title "1화 - 첫 방송"
 *
 * 동작:
 *   1) mp4 → repo/storage/uploads/{mediaId}.mp4로 복사 (로컬 storage 모드)
 *   2) program(entities) upsert
 *   3) episode(entities) prepend
 *   4) media(media 테이블) insert
 *   5) content_analysis 삽입 (status=done, data=analysis.json)
 *   6) transcript(shared 테이블) 삽입
 */
import fs from "node:fs";
import path from "node:path";
import { initDb, insertMedia, putEntity, prependEntity, saveContentAnalysis, saveTranscript, getPool } from "../apps/server/src/db-pg.ts";
import { newId } from "../apps/server/src/pipeline.ts";
import type { MediaRow } from "../apps/server/src/db-pg.ts";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`--${name} 필요`);
}

async function main() {
  const video = arg("video");
  const analyzeDir = arg("analyze-dir");
  const programTitle = arg("program-title", "실측");
  const episodeTitle = arg("episode-title", path.basename(video, path.extname(video)));

  await initDb();

  // 1) 파일 복사
  const mediaId = newId("m");
  const ext = path.extname(video) || ".mp4";
  const storageRoot = process.env.STEPD_STORAGE_DIR || path.resolve("storage");
  const objectPath = `uploads/${mediaId}${ext}`;
  const dest = path.join(storageRoot, objectPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(video, dest, { force: true });
  console.log(`[ingest] video → ${dest}`);

  // 2) 프로그램 (이미 있으면 title만 유지)
  const programId = `p_${programTitle.replace(/[^\w가-힣]/g, "_").slice(0, 24)}`;
  await putEntity("program", programId, {
    id: programId,
    title: programTitle,
    targetAge: 25,
    profile: {},
  });
  console.log(`[ingest] program ${programId} · "${programTitle}"`);

  // 3) 에피소드
  const { rows: epRows } = await getPool().query<{ m: number }>(
    `SELECT COALESCE(MAX((data->>'episodeNumber')::int), 0) AS m
       FROM entities WHERE kind = 'episode' AND data->>'programId' = $1`,
    [programId],
  );
  const episodeNumber = Number(epRows[0]?.m ?? 0) + 1;
  const episodeId = newId("e");
  const today = new Date();
  const broadDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const episode = {
    id: episodeId,
    programId,
    programTitle,
    episodeNumber,
    broadDate,
    targetAge: 25,
    // pipeline stage=done — 이미 결과가 있으니 UI가 완료 상태로 표시.
    pipeline: { stage: "done", stageStatus: "done", note: "실측 결과 수동 삽입", progress: 100 },
  };
  await prependEntity("episode", episodeId, episode);
  console.log(`[ingest] episode ${episodeId} · #${episodeNumber} "${episodeTitle}"`);

  // 4) 미디어 (probe 결과는 analysis.json manifest 재활용 시도 · 없으면 기본)
  let meta = { durationSec: 0, width: 0, height: 0, codec: "h264", hasAudio: true };
  try {
    const mani = JSON.parse(fs.readFileSync(path.join(analyzeDir, "manifest.json"), "utf-8"));
    if (mani.video_size) {} // no meta on manifest, ok
  } catch {}
  // ffprobe 재활용 (스크립트에서 직접)
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", video,
    ], { encoding: "utf-8" });
    const d = JSON.parse(out);
    const v = (d.streams || []).find((s: any) => s.codec_type === "video");
    const a = (d.streams || []).find((s: any) => s.codec_type === "audio");
    meta = {
      durationSec: parseFloat(d.format?.duration || "0") || 0,
      width: v?.width || 0,
      height: v?.height || 0,
      codec: v?.codec_name || "h264",
      hasAudio: !!a,
    };
  } catch {}

  const stat = fs.statSync(video);
  const row: MediaRow = {
    id: mediaId,
    episodeId,
    role: "master",
    title: episodeTitle,
    filename: path.basename(video),
    path: dest,
    mime: "video/mp4",
    size: stat.size,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    codec: meta.codec,
    hasAudio: meta.hasAudio ? 1 : 0,
    thumbPath: null,
    createdAt: Date.now(),
  };
  await insertMedia(row);
  console.log(`[ingest] media ${mediaId} · ${meta.durationSec.toFixed(1)}s @ ${meta.width}x${meta.height}`);

  // 5) content_analysis 삽입
  const analysis = JSON.parse(fs.readFileSync(path.join(analyzeDir, "analysis.json"), "utf-8"));
  await saveContentAnalysis(mediaId, { data: analysis });
  console.log(`[ingest] content_analysis · shorts=${(analysis.shorts||[]).length} transcript=${(analysis.transcript||[]).length}`);

  // 6) transcript 별도 테이블
  const refinedPath = path.join(analyzeDir, "refined.json");
  if (fs.existsSync(refinedPath)) {
    const refined = JSON.parse(fs.readFileSync(refinedPath, "utf-8"));
    const segments = Array.isArray(refined) ? refined : refined.segments || [];
    await saveTranscript(mediaId, {
      segments: segments as any,
      language: "ko",
      provider: "hybrid",
      source: "refined",
    });
    console.log(`[ingest] transcript · ${segments.length} segs`);
  }

  console.log(`\n✓ 완료. 프론트에서 확인:`);
  console.log(`   http://localhost:3000/episodes/${episodeId}`);
  console.log(`   또는 http://localhost:3000/ 에서 "${programTitle}" > #${episodeNumber}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

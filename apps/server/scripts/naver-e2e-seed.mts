/**
 * 네이버 발행 E2E 준비 — 로컬 DB 에 프로그램/회차/클립을 심고 naver.publish 를 큐잉한다.
 * 프로덕션 데이터는 건드리지 않는다(로컬 Postgres + 로컬 스토리지 전용).
 */
import fs from "node:fs";
import path from "node:path";
import { initDb, insertMedia, putEntity } from "../src/db-pg.ts";
import { initQueue, enqueue } from "../src/queue.ts";
import { runWithTenant, DEFAULT_TENANT_ID } from "../src/tenant.ts";

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error("사용: naver:e2e-seed <영상경로>"); process.exit(1); }

await initDb();
await initQueue();

// 잡·엔티티 모두 테넌트 스코프 안에서만 쓸 수 있다(워커도 runWithTenant 로 돈다).
await runWithTenant({ scope: DEFAULT_TENANT_ID, via: "system" }, async () => {
  const stamp = Date.now().toString(36);
  const programId = `prog_e2e_${stamp}`;
  const episodeId = `ep_e2e_${stamp}`;
  const clipId = `clip_e2e_${stamp}`;
  const mediaId = `med_e2e_${stamp}`;

  // 로컬 스토리지에 복사 — 워커가 여기서 작업 폴더로 내려받는다.
  const storageDir = process.env.STEPD_STORAGE_DIR ?? path.resolve("../../tmp/local-storage");
  const dest = path.join(storageDir, "clips", `${mediaId}.mp4`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);

  await putEntity("program", programId, { id: programId, title: "나는 SOLO", tenantName: "STEP AI" });
  await putEntity("episode", episodeId, { id: episodeId, programId, title: "16기 3회" });
  await insertMedia({
    id: mediaId, episodeId, role: "clip", title: "E2E 테스트 클립",
    filename: `${mediaId}.mp4`, path: dest, mime: "video/mp4",
    size: fs.statSync(dest).size, durationSec: 10, width: 1080, height: 1920,
    codec: "h264", hasAudio: 1, thumbPath: null, createdAt: Date.now(),
  });
  await putEntity("clip", clipId, {
    id: clipId, episodeId, mediaId, title: "나는솔로 16기 — 큐 경유 발행 테스트",
    synopsis: "워커 큐를 거쳐 올라간 클립입니다. 다운로드·업로드·정리까지 전 구간 확인용.",
    status: "ready", rendered: true, distributions: [],
  });

  const jobId = await enqueue("naver.publish", {
    clipId, target: "clip",
    description: "워커 큐를 거쳐 올라간 클립입니다. 다운로드·업로드·정리까지 전 구간 확인용.",
    publishAt: Date.now() + 3 * 60 * 60 * 1000,   // 3시간 뒤 예약 — 즉시 공개 회피
  });
  console.log(JSON.stringify({ programId, episodeId, clipId, mediaId, jobId, dest }, null, 1));
});

process.exit(0);

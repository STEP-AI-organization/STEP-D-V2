/**
 * Queue worker — runs on a small GCE VM, not on Cloud Run.
 *
 * Why a VM: Cloud Run throttles CPU the moment a request ends and caps requests at
 * 600s, so neither a fire-and-forget kick nor a long backfill can be trusted there.
 * A plain always-on process has neither limit, and the heavy pipeline stages
 * (STT, vision, render) will need that headroom.
 *
 *   Cloud Run  →  enqueue()  →  job_queue (Cloud SQL)  →  this worker  →  YouTube APIs
 *
 * Run:  pnpm --filter @stepd/server worker
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initDb,
  listYouTubeChannels,
  getYouTubeChannelByChannelId,
  markYouTubeChannelRevoked,
  updateYouTubeTokens,
  listChannelVideos,
  getChannelVideoByVideoId,
  insertVideoStat,
  getVideoAnalytics,
  upsertVideoAnalytics,
  upsertVideoRetention,
  getLatestCommentFetchedAt,
  upsertVideoComment,
  getEntity,
  putEntity,
  getMedia,
  updateMediaSource,
  markContentAnalysisPending,
  upsertShortSourceMap,
  listSourceMapsMissingSegment,
  setShortSourceSegment,
  listShortSourceMaps,
  setChannelPointProfile,
  type YouTubeChannel,
} from "./db-pg.ts";
import { probe, captureThumbnail } from "./ffmpeg.ts";
import {
  prepareProgramAssets, publishStyleProfile, publishThumbnails, tempAssetRoot,
} from "./thumbnail-assets.ts";
import { uploadFile, uploadPath, thumbPath } from "./storage-gcs.ts";
import { initQueue, claimJob, completeJob, failJob, requeueStale, heartbeatJob, enqueue, lastDoneJobAt, queueStats, type Job, type JobType } from "./queue.ts";
import { runChannelPipeline } from "./channel-pipeline.ts";
import { runContentAnalyze, newestMtimeMs } from "./content-pipeline.ts";
import {
  withAccessToken,
  fetchVideoAnalytics,
  fetchVideosBatch,
  fetchVideoComments,
  uploadVideoResumable,
  updateVideoPrivacy,
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
import { createReadStream, parseObjectPath, fileExists } from "./storage-gcs.ts";
import { youtubeUploadEnabled, UPLOAD_DISABLED_MESSAGE } from "./upload-gate.ts";
import {
  FRESH_VIDEO_WINDOW_MS,
  VIDEO_ANALYZE_FRESH_INTERVAL_MS,
  VIDEO_ANALYZE_AGED_INTERVAL_MS,
  VIDEO_COMMENTS_INTERVAL_MS,
  VIDEO_COMMENTS_MAX_RESULTS,
  HOTWATCH_WINDOW_MS,
  HOTWATCH_POLL_MS,
} from "./config.ts";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** How long to wait before asking for work again when the queue is empty. */
const IDLE_POLL_MS = 5_000;
/** How often to sweep every channel and enqueue the ones that are due. */
const TICK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Job-type lanes so content and YouTube work run on SEPARATE worker processes and never
 * starve each other (run one process with WORKER_JOBS=content, another with =youtube). A
 * heavy content.analyze (STT/vision, minutes) no longer blocks the flood of light video.*
 * jobs, and vice versa. Unset / "all" keeps the legacy single worker that drains everything.
 */
const JOB_LANES: Record<"content" | "youtube" | "gebd", JobType[]> = {
  // match.align도 content 레인 — 파이썬·ffmpeg로 오디오를 돌리는 무거운 잡이라
  // YouTube API 레인(짧고 쿼터 위주)에 섞으면 그쪽을 막는다.
  content: ["content.analyze", "youtube.download", "match.align", "match.segment", "match.learn"],
  // factory.* 도 youtube 레인 — 상태기계 한 걸음은 DB 몇 번 읽고 재큐하는 게 전부라
  // 짧고, 배포(distribution.publish)와 같은 레인에 있어야 순서가 자연스럽다.
  youtube: ["channel.analyze", "video.analyze", "video.hotwatch", "video.comments",
            "distribution.publish", "factory.orchestrate", "factory.publicize"],
  // gebd 는 GPU T4 spot VM 전용 lane. content lane 이 이 잡을 claim 하면 GPU 없는 곳에서
  // Docker mmaction2 를 못 돌린다. 그래서 별도 프로세스 (WORKER_JOBS=gebd) 로만 픽업.
  gebd: ["gebd.detect"],
};
/**
 * Drain mode — Cloud Run Jobs 용. 큐가 빌 때까지 처리하고 **종료**한다.
 *
 * 기본(상시) 모드는 5초 폴링 무한루프라 프로세스가 계속 떠 있어야 하고, 그게 idle 과금의
 * 유일한 이유다. 실측(프로덕션 job_queue 8만 건)에서 잡의 99.98%는 YouTube API 대기라
 * CPU 를 거의 안 쓴다 — 상시 프로세스를 둘 이유가 폴링뿐이다.
 * drain 모드에서는 Cloud Scheduler 가 주기적으로 Job 을 깨우고, 처리할 게 없으면 즉시 끝난다.
 *
 * DRAIN_MAX_MS 를 넘기면 **새 잡을 claim 하지 않는다**(진행 중인 건 끝까지 간다).
 * Cloud Run Job 타임아웃에 걸려 잡 도중에 죽는 걸 피하려는 것 — 남은 건 다음 실행이 가져간다.
 */
const DRAIN_MODE = process.argv.includes("--drain")
  || (process.env.WORKER_MODE ?? "").trim().toLowerCase() === "drain";
const DRAIN_MAX_MS = Number(process.env.DRAIN_MAX_MS ?? 50 * 60 * 1000);

const WORKER_JOBS = (process.env.WORKER_JOBS ?? "all").trim().toLowerCase();
const CLAIM_TYPES: JobType[] | undefined =
  WORKER_JOBS === "content" ? JOB_LANES.content
  : WORKER_JOBS === "youtube" ? JOB_LANES.youtube
  : WORKER_JOBS === "gebd" ? JOB_LANES.gebd
  : undefined; // "all" → claim every type
/** The channel sweep enqueues YouTube work, so content/gebd-only workers must not run it. */
const RUNS_SWEEP = WORKER_JOBS !== "content" && WORKER_JOBS !== "gebd";

let stopping = false;

/** Analytics reports need this scope; channels connected before the split lack it. */
const YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/**
 * A job may ask for exactly one successor to be enqueued *after* it completes. This
 * exists for `video.hotwatch`, which re-schedules itself: enqueuing inline would hit
 * the queue's dedupe unique index (which counts the still-'running' current row) and
 * silently drop the successor, ending the poll after one tick. Returning it here lets
 * the loop enqueue once this job is 'done' and no longer collides.
 */
interface FollowUp {
  type: JobType;
  payload: Record<string, unknown>;
  opts?: { dedupeKey?: string; delayMs?: number };
}

function isoDay(days = 0): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function persistTokensFor(ch: YouTubeChannel): PersistTokens {
  // Targeted two-column write — never a full-row upsert from this snapshot (see B6).
  return ({ accessToken, expiresAt }) => updateYouTubeTokens(ch.channelId, accessToken, expiresAt);
}

function withChannelToken<T>(ch: YouTubeChannel, call: (token: string) => Promise<T>): Promise<T> {
  return withAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch), call);
}

/** A dead refresh token means the creator must reconnect — park the channel (status-only). */
async function markChannelRevoked(channelId: string): Promise<void> {
  await markYouTubeChannelRevoked(channelId);
}

/**
 * Resolve a channel that can actually be called, or null for the non-retryable cases
 * (gone, revoked, no token). Returning null lets the handler complete the job instead
 * of failing it into a pointless backoff loop.
 */
async function loadActiveChannel(channelId: string): Promise<YouTubeChannel | null> {
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) { console.warn(`[worker] channel ${channelId} not found — dropping job`); return null; }
  if (ch.status === "revoked") { console.warn(`[worker] channel ${channelId} revoked — skipping`); return null; }
  if (!ch.refreshToken) { console.warn(`[worker] channel ${channelId} has no refresh token — skipping`); return null; }
  return ch;
}

async function handle(job: Job): Promise<FollowUp | void> {
  switch (job.type) {
    case "channel.analyze": return handleChannelAnalyze(job);
    case "video.analyze":   return handleVideoAnalyze(job);
    case "video.hotwatch":  return handleVideoHotwatch(job);
    case "video.comments":  return handleVideoComments(job);
    case "distribution.publish": return handleDistributionPublish(job);
    case "content.analyze": { await runContentAnalyze(String(job.payload.mediaId ?? ""), Boolean(job.payload.fast)); return; }
    case "youtube.download": return handleYoutubeDownload(job);
    case "match.align": return handleMatchAlign(job);
    case "match.segment": return handleMatchSegment(job);
    case "match.learn": return handleMatchLearn(job);
    case "gebd.detect": return handleGebdDetect(job);
    case "factory.orchestrate": return handleFactoryOrchestrate(job);
    case "factory.publicize": return handleFactoryPublicize(job);
    case "thumbnail.style": return handleThumbnailStyle(job);
    case "thumbnail.generate": return handleThumbnailGenerate(job);
    default:
      throw new Error(`unknown job type: ${(job as Job).type}`);
  }
}

/**
 * GEBD 장면 경계 탐지 · GPU T4 spot VM lane (WORKER_JOBS=gebd) 에서만 픽업.
 * payload: { mediaId, videoGcsPath, workdirGcsPrefix }
 *   1. videoGcsPath 를 /tmp 에 다운로드
 *   2. GEBD Docker 컨테이너 실행 (mmaction2 + CUDA · nvidia-container-toolkit)
 *   3. boundaries.json 결과를 workdirGcsPrefix/boundaries.json 에 업로드
 *   4. content.analyze 재개 트리거 (dedupeKey 로 재큐)
 * VM 은 idle 10분 후 auto-shutdown (deploy/gebd-vm.sh 참고).
 */
async function handleGebdDetect(job: Job): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const fs2 = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  const mediaId = String(job.payload.mediaId ?? "");
  const videoGcs = String(job.payload.videoGcsPath ?? "");
  const workdirPrefix = String(job.payload.workdirGcsPrefix ?? "");
  if (!mediaId || !videoGcs || !workdirPrefix) {
    throw new Error("gebd.detect requires payload.mediaId, videoGcsPath, workdirGcsPrefix");
  }

  // 기본값은 **로컬에 tar 로 로드한 원본 이미지**다. 예전 기본값
  // (`asia-northeast3-docker.pkg.dev/step-d/stepd/gebd-mmaction2`)은 **존재하지 않는 저장소**를
  // 가리켰다 — AR 에는 stepd-api·stepd-server 뿐이고 `stepd` 저장소가 없다(2026-08-07 확인).
  // 클라우드 GPU 로 옮길 땐 이 env 로 AR 경로를 넘길 것.
  const image = process.env.GEBD_IMAGE || "event-boundary-detection:latest";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `gebd-${mediaId}-`));
  try {
    // 1) 미디어 다운.
    //
    // ⚠️ payload 의 경로는 **버킷 상대 경로**다 (`uploads/m_xxx.mp4` · storage-gcs.ts:uploadPath).
    // `gs://` 접두사가 없어서 그대로 넘기면 gsutil 이 **로컬 파일로 해석**해 실패한다.
    // 실측(2026-08-07): 이 때문에 gebd.detect 가 한 번도 성공하지 못했다.
    // `gcloud storage` 를 쓴다 — gsutil 은 번들 파이썬을 못 찾는 환경이 있다(로컬 실측).
    const bucket = process.env.GCS_BUCKET || "stepd-media";
    const asGsUrl = (p: string) => (p.startsWith("gs://") ? p : `gs://${bucket}/${p.replace(/^\/+/, "")}`);

    const localMp4 = path.join(tmpDir, "source.mp4");
    const dl = spawnSync("gcloud", ["storage", "cp", asGsUrl(videoGcs), localMp4], { encoding: "utf8" });
    if (dl.status !== 0) throw new Error(`영상 다운로드 실패: ${(dl.stderr || dl.stdout || "").slice(0, 300)}`);

    // 2) GEBD Docker 실행.
    //
    // ⚠️ 2026-08-07 수정. 예전 코드는 `/workspace/input` · `/workspace/output` 을 마운트하고
    // **커맨드 없이** 이미지를 띄웠다 — 이미지에 그런 ENTRYPOINT 가 없어서 GPU 가 있어도
    // 무조건 실패했다(상상된 인터페이스에 맞춰 쓰여 있었다).
    //
    // 실제 계약(deploy/gebd/scripts/run_long_v3.sh):
    //   /gebd/input/source.mp4   원본
    //   /gebd/models/*.pt        가중치 (1.58GB · 이미지에 안 굽는다)
    //   /gebd/scripts /gebd/cla /gebd/prepare   리포에서 스테이징
    //   /gebd/out/boundaries.json                산출
    //   env VIDEO · CHUNK_SEC · CORES
    //
    // CHUNK_SEC=300 · CORES=1 은 실측으로 정한 값이다. 바꾸면 깨진다 —
    // 300 은 FEATURE_LEN 과 같아 0 패딩이 없고, CORES>1 은 parmap 이 산출물을 날린다.
    const stage = path.join(tmpDir, "stage");
    const outDir = path.join(stage, "out");
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(path.join(stage, "input"), { recursive: true });
    await fs.mkdir(path.join(stage, "models"), { recursive: true });
    await fs.rename(localMp4, path.join(stage, "input", "source.mp4"));

    // 리포의 GEBD 자산(스크립트·cla·prepare)을 스테이징. prepare/module.py 의 1초 세그먼트
    // 수정이 여기 있다 — 빠지면 0.3행/초가 나와 경계 시각이 통째로 어긋난다.
    const assetsRoot = process.env.GEBD_ASSETS
      || path.resolve(process.cwd(), "..", "..", "deploy", "gebd");
    for (const d of ["scripts", "cla", "prepare"]) {
      await fs.cp(path.join(assetsRoot, d), path.join(stage, d), { recursive: true });
    }

    // 가중치: 로컬 경로(GEBD_MODEL) 우선, 없으면 GCS(GEBD_MODEL_GCS)에서 받는다.
    const modelLocal = process.env.GEBD_MODEL;
    const modelGcs = process.env.GEBD_MODEL_GCS;
    const modelDest = path.join(stage, "models", "model_cla_f_0_s_-1_7728.pt");
    if (modelLocal) {
      await fs.cp(modelLocal, modelDest);
    } else if (modelGcs) {
      const mg = spawnSync("gsutil", ["cp", modelGcs, modelDest], { encoding: "utf8" });
      if (mg.status !== 0) throw new Error(`가중치 다운로드 실패: ${mg.stderr?.slice(0, 300)}`);
    } else {
      throw new Error("GEBD_MODEL 또는 GEBD_MODEL_GCS 가 필요하다 (가중치 1.58GB · 이미지에 없음)");
    }

    const dockerArgs = [
      "run", "--rm", "--gpus", "all",
      "-v", `${stage}:/gebd`,
      "-e", "VIDEO=/gebd/input/source.mp4",
      "-e", `CHUNK_SEC=${process.env.GEBD_CHUNK_SEC || "300"}`,
      "-e", `CORES=${process.env.GEBD_CORES || "1"}`,
      image,
      "bash", "/gebd/scripts/run_long_v3.sh",
    ];
    // 실측 58.6분 회차 = 10.7분. 90~120분 회차 + 이미지 pull 을 감안해 45분.
    const dk = spawnSync("docker", dockerArgs, { encoding: "utf8", timeout: 45 * 60 * 1000 });
    if (dk.status !== 0) throw new Error(`docker run 실패 (exit ${dk.status}): ${(dk.stderr || "").slice(0, 500)}`);

    // 3) boundaries.json GCS 업로드
    const boundariesLocal = path.join(outDir, "boundaries.json");
    // 여기도 버킷 상대 경로(`analysis/{mediaId}`)라 gs:// 로 만들어야 한다.
    const boundariesRemote = asGsUrl(`${workdirPrefix.replace(/\/$/, "")}/boundaries.json`);
    if (!fs2.existsSync(boundariesLocal)) {
      throw new Error("boundaries.json 이 생성되지 않았다 — 컨테이너 로그 확인");
    }
    const up = spawnSync("gcloud", ["storage", "cp", boundariesLocal, boundariesRemote], { encoding: "utf8" });
    if (up.status !== 0) throw new Error(`업로드 실패: ${(up.stderr || up.stdout || "").slice(0, 300)}`);

    // 4) content.analyze 재개 · dedupeKey 새로 (직전 것과 다르게) 해서 다시 큐잉
    await enqueue(
      "content.analyze",
      { mediaId, resumedFromGebd: true },
      { dedupeKey: `content.analyze:${mediaId}:post-gebd:${Date.now()}` },
    );
    console.log(`[worker/gebd] ${mediaId} boundaries.json → ${boundariesRemote} · content.analyze 재개 큐잉`);
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function handleChannelAnalyze(job: Job): Promise<void> {
  const channelId = String(job.payload.channelId ?? "");
  if (!channelId) throw new Error("channel.analyze requires payload.channelId");

  // `force` only on the job enqueued at connect time — the periodic sweep leaves it
  // off so the pipeline's own staleness windows protect the YouTube quota.
  const force = Boolean(job.payload.force);
  const result = await runChannelPipeline(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, channelId, { force });

  if (result.error) throw new Error(result.error);
  console.log(`[worker] ${job.type} ${channelId}`, JSON.stringify(result));

  // Fan out per-video analytics/comments for the recent uploads that are due.
  await enqueueDueVideoJobs(channelId);
}

/**
 * After a channel run, queue per-video jobs for EVERY synced upload that's due — no count
 * cap. The staleness gates below (fresh daily / aged weekly) are what bound the Analytics
 * quota (video.analyze costs 4 calls), so a re-run only re-pulls videos actually due.
 */
async function enqueueDueVideoJobs(channelId: string): Promise<void> {
  const ch = await loadActiveChannel(channelId);
  if (!ch) return;
  // The video.analyze handler unconditionally skips channels without the analytics scope,
  // so nothing ever lands in video_analytics and `!prev` would re-queue every upload on
  // every sweep forever. Gate the fan-out on the same condition the handler uses.
  const canAnalyze = !ch.scope || ch.scope.includes(YT_ANALYTICS_SCOPE);

  const targets = await listChannelVideos(channelId); // every synced upload
  const now = Date.now();
  let analyzeQueued = 0;
  let commentsQueued = 0;

  for (const v of targets) {
    const ageMs = now - Date.parse(v.publishedAt);
    const fresh = Number.isFinite(ageMs) && ageMs < FRESH_VIDEO_WINDOW_MS;

    const prev = await getVideoAnalytics(v.videoId);
    const interval = fresh ? VIDEO_ANALYZE_FRESH_INTERVAL_MS : VIDEO_ANALYZE_AGED_INTERVAL_MS;
    if (canAnalyze && (!prev || now - prev.fetchedAt >= interval)) {
      const id = await enqueue("video.analyze", { videoId: v.videoId, channelId }, {
        dedupeKey: `video.analyze:${v.videoId}`,
      });
      if (id) analyzeQueued++;
    }

    // Comments only for fresh videos, at most daily. Due-ness must consider the last
    // ATTEMPT, not just stored rows — a video with zero (or disabled) comments writes
    // nothing, and gating on rows alone would burn an API call every sweep for 7 days.
    if (fresh) {
      const lastStored = await getLatestCommentFetchedAt(v.videoId);
      const lastTried = await lastDoneJobAt("video.comments", `video.comments:${v.videoId}`);
      const last = Math.max(lastStored ?? 0, lastTried ?? 0) || null;
      if (last == null || now - last >= VIDEO_COMMENTS_INTERVAL_MS) {
        const id = await enqueue("video.comments", { videoId: v.videoId, channelId }, {
          dedupeKey: `video.comments:${v.videoId}`,
        });
        if (id) commentsQueued++;
      }
    }
  }

  if (analyzeQueued || commentsQueued) {
    console.log(`[worker] channel ${channelId}: queued ${analyzeQueued} video.analyze, ${commentsQueued} video.comments`);
  }
}

async function handleVideoAnalyze(job: Job): Promise<void> {
  const videoId = String(job.payload.videoId ?? "");
  const channelId = String(job.payload.channelId ?? "");
  if (!videoId || !channelId) throw new Error("video.analyze requires videoId + channelId");

  const ch = await loadActiveChannel(channelId);
  if (!ch) return;
  if (ch.scope && !ch.scope.includes(YT_ANALYTICS_SCOPE)) {
    console.warn(`[worker] video.analyze ${videoId}: channel ${channelId} lacks analytics scope — skipping`);
    return;
  }

  // Lifetime window: from the upload's publish day (clamped so it can't exceed today).
  const video = await getChannelVideoByVideoId(videoId);
  const endDate = isoDay(0);
  let startDate = (video?.publishedAt ?? isoDay(365)).slice(0, 10);
  if (startDate > endDate) startDate = endDate;

  const result = await withChannelToken(ch, (token) =>
    fetchVideoAnalytics(token, videoId, { startDate, endDate }),
  );

  const now = Date.now();
  await upsertVideoAnalytics({
    videoId,
    channelId,
    fetchedAt: now,
    summary: result.summary,
    trafficSources: result.trafficSources,
    demographics: result.demographics,
  });
  await upsertVideoRetention({ videoId, channelId, fetchedAt: now, curve: result.retention });

  console.log(
    `[worker] video.analyze ${videoId}: summary=${Object.keys(result.summary).length} ` +
    `retention=${result.retention.length} traffic=${result.trafficSources.length} demo=${result.demographics.length}`,
  );
}

async function handleVideoHotwatch(job: Job): Promise<FollowUp | void> {
  const videoId = String(job.payload.videoId ?? "");
  const channelId = String(job.payload.channelId ?? "");
  if (!videoId || !channelId) throw new Error("video.hotwatch requires videoId + channelId");

  const ch = await loadActiveChannel(channelId);
  if (!ch) return;

  const stats = await withChannelToken(ch, (token) => fetchVideosBatch(token, [videoId]));
  const s = stats.get(videoId);
  const now = Date.now();

  if (!s) {
    // Video gone (deleted/private) — nothing to snapshot, stop the poll.
    console.warn(`[worker] video.hotwatch ${videoId}: no stats (removed?) — ending poll`);
    return;
  }

  // Unconditional snapshot: hourly high density is the point of hotwatch. The 6h sync
  // path guards on 1h and defers to these.
  await insertVideoStat({
    id: `vs_${videoId}_${now}`,
    videoId,
    channelId,
    snapshotAt: now,
    viewCount: s.viewCount,
    likeCount: s.likeCount,
    commentCount: s.commentCount,
  });

  let publishedAt = String(job.payload.publishedAt ?? "");
  if (!publishedAt) publishedAt = (await getChannelVideoByVideoId(videoId))?.publishedAt ?? "";
  const ageMs = publishedAt ? now - Date.parse(publishedAt) : NaN;

  if (Number.isFinite(ageMs) && ageMs < HOTWATCH_WINDOW_MS) {
    return {
      type: "video.hotwatch",
      payload: { videoId, channelId, publishedAt },
      opts: { dedupeKey: `video.hotwatch:${videoId}`, delayMs: HOTWATCH_POLL_MS },
    };
  }
  console.log(`[worker] video.hotwatch ${videoId}: 48h window closed — done`);
}

async function handleVideoComments(job: Job): Promise<void> {
  const videoId = String(job.payload.videoId ?? "");
  const channelId = String(job.payload.channelId ?? "");
  if (!videoId || !channelId) throw new Error("video.comments requires videoId + channelId");

  const ch = await loadActiveChannel(channelId);
  if (!ch) return;

  const comments = await withChannelToken(ch, (token) =>
    fetchVideoComments(token, videoId, VIDEO_COMMENTS_MAX_RESULTS),
  );

  const now = Date.now();
  for (const cm of comments) {
    await upsertVideoComment({
      id: cm.id,
      videoId,
      channelId,
      author: cm.author,
      text: cm.text,
      likeCount: cm.likeCount,
      publishedAt: cm.publishedAt,
      fetchedAt: now,
    });
  }
  console.log(`[worker] video.comments ${videoId}: ${comments.length} threads`);
}

// ── youtube.download — ingest a YouTube URL as a master media ─────────────────────
//
// The API route only creates the episode + a placeholder media row and queues this job;
// the actual yt-dlp download runs here on the VM (Cloud Run can't hold a multi-GB file
// or a long download). Once the file is in GCS the flow rejoins the normal upload path:
// media row gets the real facts, then content.analyze is enqueued.

const YT_DLP = process.env.YT_DLP ?? "yt-dlp";
// 계정 쿠키 파일 경로. 있으면 모든 yt-dlp 호출에 --cookies로 붙는다 — 지역제한·봇차단·
// 레이트리밋을 계정 인증으로 우회한다(공개 VM IP는 대량 다운로드 시 곧 403 당한다).
// 값은 Secret Manager(stepd-ytdlp-cookies)에 있고, worker.env가 파일로 떨군다.
const YTDLP_COOKIES = process.env.YTDLP_COOKIES ?? "";

// Failed-forever downloads keep their .part files (see the catch below) so a retry resumes.
// But once a job exhausts maxAttempts it's dead and nothing ever deletes its (possibly
// multi-GB) partial — this sweep reclaims those, mirroring content-pipeline's WORK_ROOT TTL.
const YT_WORK_ROOT = path.join(os.tmpdir(), "stepd-youtube");
const YT_WORK_TTL_MS = 48 * 60 * 60 * 1000;

function sweepStaleYoutubeDirs(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(YT_WORK_ROOT, { withFileTypes: true });
  } catch {
    return; // root doesn't exist yet
  }
  const cutoff = Date.now() - YT_WORK_TTL_MS;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(YT_WORK_ROOT, e.name);
    try {
      // newestMtimeMs: a growing .part file updates its own mtime, not the dir's —
      // dir-mtime-only would let a sibling worker sweep an ACTIVE download at the TTL edge.
      if (newestMtimeMs(dir) < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[worker] youtube.download: swept stale work dir ${e.name}`);
      }
    } catch {
      // raced/locked — next sweep gets it
    }
  }
}

function runYtDlp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // 쿠키 파일이 실제로 존재할 때만 붙인다 — 경로만 있고 파일이 없으면 yt-dlp가 죽는다.
    const withCookies = YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)
      ? ["--cookies", YTDLP_COOKIES, ...args]
      : args;
    const child = spawn(YT_DLP, withCookies, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT"
        ? new Error("yt-dlp가 설치되어 있지 않습니다 — worker VM에서 deploy/worker-pipeline-setup.sh를 재실행하세요")
        : err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function handleYoutubeDownload(job: Job): Promise<void> {
  const mediaId = String(job.payload.mediaId ?? "");
  const url = String(job.payload.url ?? "");
  if (!mediaId || !url) throw new Error("youtube.download requires mediaId + url");

  const media = await getMedia(mediaId);
  if (!media) { console.warn(`[worker] youtube.download: media ${mediaId} gone — dropping`); return; }

  const setEpisodeNote = async (note: string, stageStatus: string, progress: number) => {
    if (!media.episodeId) return;
    const ep = await getEntity<Record<string, unknown>>("episode", media.episodeId);
    if (ep) {
      await putEntity("episode", media.episodeId, {
        ...ep,
        pipeline: { stage: "analyze", stageStatus, note, progress },
      });
    }
  };

  sweepStaleYoutubeDirs();
  // Stable per-media dir: a retried job resumes yt-dlp's .part file instead of restarting.
  const workDir = path.join(YT_WORK_ROOT, mediaId);
  fs.mkdirSync(workDir, { recursive: true });
  // fast(자막만 빠른 추천): 오디오만 받는다 — STT엔 소리만 필요. 풀 영상(수백MB~2GB) 대신
  // ~수십MB로 5-10배 빠르다. 단 이 미디어로 나중에 풀 파이프라인(시각 분석)은 못 돌린다.
  const fast = Boolean(job.payload.fast);
  const outPath = path.join(workDir, fast ? "source.m4a" : "source.mp4");

  try {
    await setEpisodeNote("YouTube 영상 다운로드 중…", "progress", 10);

    await runYtDlp(fast
      ? ["--no-playlist", "--no-progress", "-f", "bestaudio[ext=m4a]/bestaudio/best", "-o", outPath, url]
      : ["--no-playlist", "--no-progress",
         "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
         "--merge-output-format", "mp4", "-o", outPath, url]);

    // yt-dlp가 컨테이너에 따라 다른 확장자로 저장할 수 있어(webm 등) 정확 경로가 없으면 glob 폴백.
    let realPath = outPath;
    if (!fs.existsSync(realPath)) {
      const base = path.basename(outPath, path.extname(outPath)); // "source"
      const hit = fs.readdirSync(workDir).find((f) => f.startsWith(base + ".") && !f.endsWith(".part"));
      if (hit) realPath = path.join(workDir, hit);
    }
    if (!fs.existsSync(realPath)) throw new Error("yt-dlp가 출력 파일을 만들지 못했습니다");

    // A crash mid-merge leaves a truncated file that a retried yt-dlp treats as
    // "already downloaded" — so a broken probe here means a corrupt file, not a soft
    // degrade. Delete it and fail the attempt so the retry downloads fresh.
    let meta: Awaited<ReturnType<typeof probe>>;
    try {
      meta = await probe(realPath);
      if (!(meta.durationSec > 0)) throw new Error(`probe returned duration ${meta.durationSec}`);
    } catch (e: any) {
      fs.rmSync(realPath, { force: true });
      throw new Error(`다운로드 파일 손상(probe 실패) — 재시도 시 새로 받습니다: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    let thumbStored: string | null = null;
    if (!fast) {  // 오디오만 받은 경우 썸네일(비디오 프레임)이 없으므로 건너뛴다
      const thumbTmp = path.join(workDir, "thumb.jpg");
      try {
        await captureThumbnail(realPath, Math.max(1, meta.durationSec * 0.1), thumbTmp);
        thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
      } catch (e) {
        console.error(`[worker] youtube.download ${mediaId}: thumbnail failed`, e);
      }
    }

    const ext = fast ? (path.extname(realPath) || ".m4a") : ".mp4";
    const storedPath = await uploadFile(uploadPath(mediaId, ext), realPath);
    const size = fs.statSync(realPath).size;

    await updateMediaSource(mediaId, {
      path: storedPath,
      mime: fast ? "audio/mp4" : "video/mp4",
      size,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      codec: meta.codec,
      hasAudio: meta.hasAudio ? 1 : 0,
      thumbPath: thumbStored,
    });

    await markContentAnalysisPending(mediaId);
    // fast를 content.analyze로 이어 전달 — 대량 배치용.
    await enqueue("content.analyze", { mediaId, ...(fast ? { fast: true } : {}) }, { dedupeKey: `content.analyze:${mediaId}` });
    await setEpisodeNote("AI 장면 분석 대기 중…", "progress", 30);
    console.log(`[worker] youtube.download ${mediaId}: ${size} bytes → ${storedPath}`);

    // Success only — a failed attempt keeps its .part files so the retry resumes.
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    await setEpisodeNote("YouTube 다운로드 실패 — 자동 재시도 대기", "error", 0).catch(() => {});
    throw err;
  }
}

// ── match.align — 숏폼이 롱폼의 어느 구간에서 나왔는지 오디오로 추적 ────────────────
//
// 롱폼 하나에서 숏폼이 10개 넘게 나오는 일이 흔해서 구간을 전부 손으로 찍는 건 비현실적이다.
// 숏폼은 롱폼 오디오를 그대로 잘라 쓰므로, core/align.py 가 스펙트로그램 상호상관으로 시작
// 지점을 찾아낸다(Gemini 불필요, CPU만). 롱폼 오디오는 한 번만 받아 재사용한다.
//
// 자동 결과는 source='auto' + confidence 로 저장하고 confirmedAt 은 비워 둔다 — 틀린 구간이
// 사람이 찍은 것과 구분 없이 섞이면 학습 데이터가 조용히 오염되기 때문이다. Lab에서 사람이
// 확인하면 그때 manual 로 승격된다.

const ALIGN_ROOT = path.join(os.tmpdir(), "stepd-align");
// content-pipeline과 같은 파이썬/루트를 쓴다 (워커 VM은 CORE_PYTHON을 env로 지정).
const CORE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CORE_PYTHON_BIN =
  process.env.CORE_PYTHON || path.join(CORE_REPO_ROOT, "core", ".venv310", "Scripts", "python.exe");

function ytAudioUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** yt-dlp로 오디오만 받는다 (영상 트랙은 정렬에 불필요 — 다운로드 시간·용량을 크게 줄인다). */
async function fetchAudio(videoId: string, dest: string): Promise<void> {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return; // 롱폼 재사용
  await runYtDlp(["-q", "--no-playlist", "-f", "bestaudio/best", "-o", dest, ytAudioUrl(videoId)]);
  if (!fs.existsSync(dest)) throw new Error(`오디오를 받지 못했습니다: ${videoId}`);
}

interface AlignOut {
  ok: boolean;
  offset_sec: number;
  duration_sec: number;
  score: number;
  peak_ratio: number;
  reason?: string;
}

/**
 * 숏폼들을 한 번의 호출로 정렬한다 — core.align이 롱폼 특징을 한 번만 계산하도록.
 * 숏폼마다 호출하면 61분 롱폼을 매번 다시 디코딩해 16개에 20분을 넘긴다.
 * 반환은 입력 순서와 1:1.
 */
function runAlign(longPath: string, shortPaths: string[]): Promise<AlignOut[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.align", longPath, ...shortPaths], {
      cwd: CORE_REPO_ROOT,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errText = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (errText += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`core.align exited ${code}: ${errText.slice(-300)}`));
      try {
        const lines = out.trim().split("\n").filter((l) => l.trim().startsWith("{"));
        resolve(lines.map((l) => JSON.parse(l) as AlignOut));
      } catch (e) {
        reject(new Error(`core.align 출력 파싱 실패: ${String(e)} / ${out.slice(-200)}`));
      }
    });
  });
}


// ── 썸네일 엔진 ───────────────────────────────────────────────────────────────
// core/thumbnail 이 실제 일을 한다. 여기서는 스폰과 결과 파싱만.
// 결과는 stdout 마지막의 `@@RESULT {json}` 한 줄로 온다.

function runThumbnailCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-X", "utf8", "-m", "core.thumbnail.cli", ...args], {
      cwd: CORE_REPO_ROOT,
      env: { ...process.env, ...extraEnv, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errText = "";
    proc.stdout.on("data", (d) => { const t = String(d); out += t; process.stdout.write(t); });
    proc.stderr.on("data", (d) => (errText += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("@@RESULT "));
      if (!line) {
        return reject(new Error(`thumbnail cli 결과 없음 (exit ${code}): ${errText.slice(-300)}`));
      }
      try {
        resolve(JSON.parse(line.slice("@@RESULT ".length)) as Record<string, unknown>);
      } catch (e) {
        reject(new Error(`thumbnail cli 출력 파싱 실패: ${String(e)}`));
      }
    });
  });
}

/** 프로그램 채널의 기존 썸네일 → 스타일 프로파일. 프로그램당 1회성(갱신 시 재실행). */

// ── 콘텐츠 공장 ───────────────────────────────────────────────────────────────
// 상태기계 한 걸음 전진 후 재큐. 16분짜리 분석을 기다리며 워커를 붙잡지 않는다.

async function handleFactoryOrchestrate(job: Job): Promise<void> {
  const factoryJobId = String(job.payload.factoryJobId ?? "");
  if (!factoryJobId) throw new Error("factoryJobId 필요");

  const { advance } = await import("./factory.ts");
  const { job: fj, retryInMs } = await advance(factoryJobId);
  console.log(`[worker] factory.orchestrate ${factoryJobId} → ${fj.state}` +
    (fj.note ? ` (${fj.note})` : "") + (fj.error ? ` ERROR ${fj.error}` : ""));

  if (retryInMs !== null) {
    await enqueue("factory.orchestrate", { factoryJobId },
      { dedupeKey: `factory.orchestrate:${factoryJobId}:${fj.state}:${Date.now()}`,
        delayMs: retryInMs });
  }
}

/** 채널 토큰을 얻어 공개 범위를 바꾼다. distribution.publish 가 쓰는 경로와 같은 방식. */
async function setYoutubePrivacy(
  channelId: string | undefined,
  videoId: string,
  privacy: "public" | "unlisted" | "private",
): Promise<void> {
  if (!channelId) throw new Error("youtubeChannelId 없음 — 어느 채널 토큰을 쓸지 알 수 없다");
  const ch = await loadActiveChannel(channelId);
  if (!ch) throw new Error(`채널 ${channelId} 토큰 없음/철회됨`);
  await withChannelToken(ch, (token) => updateVideoPrivacy(token, videoId, privacy));
}

/** private 로 올린 영상을 공개로 전환. 이 잡이 돌기 전에 취소하면 되돌린 것이 된다. */
async function handleFactoryPublicize(job: Job): Promise<void> {
  const factoryJobId = String(job.payload.factoryJobId ?? "");
  const { getEntity, putEntity } = await import("./db-pg.ts");
  const fj = await getEntity<any>("factoryJob", factoryJobId);
  if (!fj) throw new Error(`factoryJob ${factoryJobId} 없음`);

  let switched = 0;
  for (const clipId of (fj.clipIds ?? [])) {
    const clip = await getEntity<any>("clip", clipId);
    const dist = (clip?.distributions ?? []).find((d: any) => d.channel === "youtube");
    if (!clip || !dist?.externalId) continue;
    try {
      await setYoutubePrivacy(dist.youtubeChannelId, dist.externalId, "public");
      switched += 1;
    } catch (e) {
      console.warn(`[factory] 공개 전환 실패 ${clipId}: ${String(e).slice(0, 160)}`);
    }
  }
  await putEntity("factoryJob", factoryJobId, {
    ...fj, state: "done", note: `공개 전환 ${switched}/${(fj.clipIds ?? []).length}`,
    updatedAt: Date.now(),
  });
  console.log(`[worker] factory.publicize ${factoryJobId} · ${switched}건 공개`);
}

async function handleThumbnailStyle(job: Job): Promise<void> {
  const programId = String(job.payload.programId ?? "");
  // 재생목록 URL 을 권한다 — 큰 채널은 프로그램·기수가 재생목록으로 나뉘어 있고,
  // 채널 전체로 학습하면 여러 프로그램 톤이 뭉개진다.
  const sourceUrl = String(job.payload.sourceUrl ?? job.payload.channelUrl ?? "");
  if (!programId || !sourceUrl) throw new Error("programId·sourceUrl 필요");

  // 산출물을 임시 루트에 쓰고 스토리지로 올린다 — 워커 디스크는 재시작하면 사라진다.
  const root = tempAssetRoot(`style-${programId}-${Date.now()}`);
  const result = await runThumbnailCli([
    "style",
    "--program-id", programId,
    "--source-url", sourceUrl,
    "--title", String(job.payload.title ?? ""),
    "--limit", String(job.payload.limit ?? 50),
    "--sample", String(job.payload.sample ?? 20),
  ], { THUMB_ASSETS_DIR: root });
  if (!result.ok) throw new Error(String(result.error ?? "style 실패"));

  const localStyleDir = path.join(root, "thumbnail-style", programId);
  const uploaded = await publishStyleProfile(programId, localStyleDir);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`[worker] thumbnail.style ${programId} · 업로드 ${uploaded}개`,
    JSON.stringify(result));
}

/** 회차 1건 → 썸네일 후보. 인물 미등록이면 실패로 남긴다(재시도해도 같다). */
async function handleThumbnailGenerate(job: Job): Promise<void> {
  const mediaId = String(job.payload.mediaId ?? "");
  const programId = String(job.payload.programId ?? "");
  if (!mediaId || !programId) throw new Error("mediaId·programId 필요");

  const storage = process.env.STEPD_STORAGE_DIR || path.join(CORE_REPO_ROOT, "tmp", "local-storage");
  const analysisDir = path.join(storage, "analysis", mediaId);
  const video = path.join(storage, "uploads", `${mediaId}.mp4`);
  const outDir = path.join(os.tmpdir(), "stepd-thumb-out", mediaId);

  // 이 프로그램의 스타일 프로파일·출연자 사진만 내려받는다 (회차마다 전체를 뒤지지 않게).
  const assets = await prepareProgramAssets(programId, `gen-${mediaId}-${Date.now()}`);
  if (!assets.castFiles) {
    fs.rmSync(assets.root, { recursive: true, force: true });
    throw new Error(`cast_not_registered: ${programId} 에 등록된 출연자 사진이 없습니다`);
  }

  try {
    const result = await runThumbnailCli([
      "generate",
      "--media-id", mediaId,
      "--program-id", programId,
      "--title", String(job.payload.title ?? ""),
      "--analysis-dir", analysisDir,
      "--video", fs.existsSync(video) ? video : "",
      "--out", outDir,
      "--candidates", String(job.payload.candidates ?? 3),
    ], { THUMB_ASSETS_DIR: assets.root });
    if (!result.ok) {
      // 인물 미등록은 사람이 고쳐야 하는 것 — 메시지를 그대로 남긴다.
      throw new Error(`${result.error}${result.missing ? ` (${(result.missing as string[]).join(", ")})` : ""}`);
    }
    const stored = await publishThumbnails(mediaId, (result.files as string[]) ?? []);
    console.log(`[worker] thumbnail.generate ${mediaId} · 후보 ${stored.length}장`,
      JSON.stringify({ ...result, stored }));
  } finally {
    fs.rmSync(assets.root, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function handleMatchAlign(job: Job): Promise<void> {
  const channelId = String(job.payload.channelId ?? "");
  const longVideoId = String(job.payload.longVideoId ?? "");
  const shortIds = Array.isArray(job.payload.shortVideoIds)
    ? (job.payload.shortVideoIds as unknown[]).map(String)
    : [];
  if (!channelId || !longVideoId || !shortIds.length) {
    throw new Error("match.align requires channelId + longVideoId + shortVideoIds[]");
  }

  fs.mkdirSync(ALIGN_ROOT, { recursive: true });
  const dir = path.join(ALIGN_ROOT, longVideoId.replace(/[^\w-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const longPath = path.join(dir, "long.m4a");

  let ok = 0;
  let low = 0;
  try {
    await fetchAudio(longVideoId, longPath);

    // 오디오를 먼저 다 받고, 정렬은 한 번의 파이썬 호출로 (롱폼 특징 재계산 방지).
    const ready: { id: string; path: string }[] = [];
    for (const sid of shortIds) {
      const p = path.join(dir, `${sid.replace(/[^\w-]/g, "_")}.m4a`);
      try {
        await fetchAudio(sid, p);
        ready.push({ id: sid, path: p });
      } catch (e) {
        console.error(`[worker] match.align ${sid} 다운로드 실패:`, e);
      }
    }
    if (!ready.length) throw new Error("정렬할 숏폼 오디오를 하나도 받지 못했습니다");

    const results = await runAlign(longPath, ready.map((r) => r.path));
    for (let i = 0; i < ready.length; i++) {
      const r = results[i];
      const sid = ready[i].id;
      if (!r) continue;
      if (!r.ok) {
        low++;
        console.warn(`[worker] match.align ${sid}: 신뢰도 미달 — ${r.reason ?? ""}`);
        continue;
      }
      await upsertShortSourceMap({
        shortVideoId: sid,
        channelId,
        longVideoId,
        segStart: r.offset_sec,
        segEnd: r.offset_sec + r.duration_sec,
        source: "auto",
        confidence: r.score,
        note: null,
      });
      ok++;
    }
    console.log(`[worker] match.align ${longVideoId}: ${ok}건 추정, ${low}건 신뢰도 미달`);
  } finally {
    // 롱폼 오디오는 25분짜리라 남겨두면 VM 디스크를 먹는다. 잡 단위로 정리.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── match.segment — 매칭 구간의 LEARN 입력(자막·장면요약) 채우기 ──────────────────
//
// core/segment.py가 구간을 보고 Gemini 1회로 자막·장면요약·감정·훅을 만든다. 롱폼을
// 편당 한 번만 받고 그 안의 구간을 여러 개 처리하므로, 롱폼 단위로 묶어 스폰한다.
// (구간마다 yt-dlp --download-sections를 쓰면 사실상 전체를 재인코딩해 훨씬 비싸다.)

interface SegmentOut {
  id?: string;
  transcript?: string;
  scene_summary?: string;
  emotion?: string;
  hook?: string;
  error?: string;
}

/** 롱폼 1편 + 구간 여러 개 → 구간별 설명 (파이썬 1회 스폰). */
function runSegment(longVideoId: string, spans: { id: string; start: number; end: number }[]): Promise<SegmentOut[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.segment", ytAudioUrl(longVideoId), "-"], {
      cwd: CORE_REPO_ROOT,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let errText = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (errText += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`core.segment exited ${code}: ${errText.slice(-300)}`));
      try {
        resolve(
          out.trim().split("\n")
            .filter((l) => l.trim().startsWith("{"))
            .map((l) => JSON.parse(l) as SegmentOut),
        );
      } catch (e) {
        reject(new Error(`core.segment 출력 파싱 실패: ${String(e)} / ${out.slice(-200)}`));
      }
    });
    proc.stdin.write(JSON.stringify(spans));
    proc.stdin.end();
  });
}

async function handleMatchSegment(job: Job): Promise<void> {
  const channelId = String(job.payload.channelId ?? "");
  if (!channelId) throw new Error("match.segment requires payload.channelId");
  const limit = Number(job.payload.limitLongforms) || 3; // 잡 하나가 오래 붙잡지 않게

  const pending = await listSourceMapsMissingSegment(channelId);
  if (!pending.length) {
    console.log(`[worker] match.segment ${channelId}: 채울 구간 없음`);
    return;
  }
  // 롱폼별로 묶는다 — 다운로드를 편당 1회로 줄이는 게 이 잡의 핵심.
  const byLong = new Map<string, typeof pending>();
  for (const m of pending) {
    const arr = byLong.get(m.longVideoId) ?? [];
    arr.push(m);
    byLong.set(m.longVideoId, arr);
  }

  let done = 0;
  let failed = 0;
  for (const [longVideoId, maps] of [...byLong.entries()].slice(0, limit)) {
    try {
      const results = await runSegment(
        longVideoId,
        maps.map((m) => ({ id: m.shortVideoId, start: m.segStart, end: m.segEnd })),
      );
      for (const r of results) {
        if (!r.id) continue;
        if (r.error || !r.scene_summary) {
          failed++;
          console.warn(`[worker] match.segment ${r.id}: ${r.error ?? "요약 없음"}`);
          continue;
        }
        await setShortSourceSegment(r.id, r);
        done++;
      }
    } catch (e) {
      failed += maps.length;
      console.error(`[worker] match.segment ${longVideoId} 실패:`, e);
    }
  }

  // 남은 롱폼이 있으면 스스로 이어서 — 한 잡이 수십 편을 붙들지 않게 나눠 돈다.
  const left = byLong.size - Math.min(limit, byLong.size);
  console.log(`[worker] match.segment ${channelId}: ${done}건 채움, ${failed}건 실패, 롱폼 ${left}편 남음`);
  if (left > 0) {
    await enqueue("match.segment", { channelId, limitLongforms: limit },
      { dedupeKey: `match.segment:${channelId}`, delayMs: 5_000 }).catch(() => null);
  }
}

// ── match.learn — 채널 매칭 데이터에서 고성과 규칙을 학습 ──────────────────────────
//
// 자동화의 마지막 단계: 매칭·구간설명이 채워진 채널에서 core.learn_profile로 규칙을 뽑아
// youtube_channels.pointProfile에 저장한다. 이후 그 채널 영상을 분석하면 content-pipeline이
// 이 프로파일을 --profile로 넘겨 recommend가 채널에 맞는 후보를 고른다(기존 스티어링 배선).
//
// 미설명 구간이 남아 있으면 match.segment를 먼저 돌리고 재큐한다 — 설명 없이 학습하면
// 표본이 얇아 규칙이 부실하다.

/** LEARN 데이터셋(export)을 만들어 core.learn_profile에 넘기고 결과를 받는다. */
function runLearn(channelId: string, exportJson: string): Promise<{ profile: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.learn_profile", "-"], {
      cwd: CORE_REPO_ROOT,
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (err += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`core.learn_profile exited ${code}: ${err.slice(-300)}`));
      try {
        resolve({ profile: JSON.parse(out), text: out });
      } catch (e) {
        reject(new Error(`learn_profile 출력 파싱 실패: ${String(e)} / ${out.slice(-200)}`));
      }
    });
    proc.stdin.write(exportJson);
    proc.stdin.end();
  });
}

async function handleMatchLearn(job: Job): Promise<void> {
  const channelId = String(job.payload.channelId ?? "");
  if (!channelId) throw new Error("match.learn requires payload.channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) { console.warn(`[worker] match.learn: channel ${channelId} gone`); return; }

  // 미설명 구간이 남았으면 설명부터 채우고 학습을 뒤로 미룬다(설명 없이 학습하면 표본 부실).
  const missing = await listSourceMapsMissingSegment(channelId);
  if (missing.length > 0) {
    console.log(`[worker] match.learn ${channelId}: 미설명 ${missing.length}건 → 먼저 채우고 재시도`);
    await enqueue("match.segment", { channelId, limitLongforms: 10 },
      { dedupeKey: `match.segment:${channelId}` }).catch(() => null);
    await enqueue("match.learn", { channelId },
      { dedupeKey: `match.learn:${channelId}`, delayMs: 10 * 60_000 }).catch(() => null);
    return;
  }

  // export를 서버에서 만들지 않고 여기서 직접 구성 (같은 로직). 성과 tier는 index.ts의
  // export 라우트와 동일하게 ±90일 중앙값 대비 배수 — 여기선 저장된 seg* 컬럼을 함께 싣는다.
  const maps = await listShortSourceMaps(channelId);
  const videos = await listChannelVideos(channelId);
  const byId = new Map(videos.map((v) => [v.videoId, v]));
  const shorts = videos.filter((v) => Boolean(v.isShort) || (Number(v.durationSec) || 0) <= 180);
  const WINDOW = 90 * 24 * 3600 * 1000;
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const pairs = maps.map((m) => {
    const sv = byId.get(m.shortVideoId);
    const lv = byId.get(m.longVideoId);
    const t = sv ? Date.parse(sv.publishedAt) : 0;
    const peers = shorts.filter((v) => Math.abs(Date.parse(v.publishedAt) - t) <= WINDOW)
      .map((v) => Number(v.viewCount) || 0);
    const base = median(peers.length >= 3 ? peers : shorts.map((v) => Number(v.viewCount) || 0));
    const views = Number(sv?.viewCount) || 0;
    const ratio = base > 0 ? views / base : 0;
    return {
      pair_id: m.shortVideoId,
      performance: { ratio: Number(ratio.toFixed(3)), tier: ratio >= 2 ? "high" : ratio >= 0.7 ? "mid" : "low" },
      short: { title: sv?.title ?? null, views },
      source: {
        longVideoId: m.longVideoId, title: lv?.title ?? null,
        segStart: m.segStart, segEnd: m.segEnd, segLenSec: Number((m.segEnd - m.segStart).toFixed(1)),
        transcript: (m as { segTranscript?: string }).segTranscript ?? null,
        scene_summary: (m as { segSummary?: string }).segSummary ?? null,
        hook: (m as { segHook?: string }).segHook ?? null,
        emotion: (m as { segEmotion?: string }).segEmotion ?? null,
      },
      note: m.note,
    };
  });

  const exportJson = JSON.stringify({ channelId, channelName: ch.channelName, count: pairs.length, pairs });
  const { profile } = await runLearn(channelId, exportJson);
  await setChannelPointProfile(channelId, profile);

  const p = profile as { ready?: boolean; confidence?: number; sample?: unknown };
  console.log(`[worker] match.learn ${channelId}: 저장 (ready=${p.ready} conf=${p.confidence ?? "-"} sample=${JSON.stringify(p.sample ?? {})})`);
}

// ── distribution.publish — upload a rendered clip to YouTube ──────────────────────
//
// The heavy half of POST /api/distributions/publish. Cloud Run only queues the intent
// (marking the clip's youtube distribution 'pending'); the upload runs here where CPU and
// wall-clock aren't capped. On success we record the videoId and flip 'pending'→'published'
// (or 'scheduled' when a future publishAt is set); on failure we flip 'pending'→'failed' with
// the reason so the operator can retry from the distribution board. We deliberately swallow
// upload errors (mark failed, don't throw) so the state machine is deterministic — the queue's
// blind backoff-retry would fight with the explicit failed state and could re-upload a clip
// that partially succeeded. Genuine transient retries go through the /retry endpoint.

/** Collect a web ReadableStream into a Buffer. Rendered clips are small enough for the VM. */
async function streamToBuffer(web: ReadableStream): Promise<Buffer> {
  const reader = (web as any).getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Upsert one channel's entry in a clip's distributions array (mutating a fresh copy). */
function upsertDistribution(distributions: any[], channel: string, value: Record<string, unknown>): any[] {
  const next = (distributions ?? []).map((d: any) => ({ ...d }));
  const existing = next.find((d: any) => d.channel === channel);
  if (existing) Object.assign(existing, value);
  else next.push({ channel, ...value });
  return next;
}

/** Re-read the clip (avoid clobbering concurrent edits) and mark its youtube dist failed. */
async function markDistributionFailed(clipId: string, channel: string, error: string): Promise<void> {
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return;
  const distributions = upsertDistribution(clip.distributions, channel, { status: "failed", error });
  await putEntity("clip", clipId, { ...clip, distributions });
}

/** ISO RFC3339 if `raw` parses to a FUTURE instant, else null (upload immediately). */
function futurePublishAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  return new Date(t).toISOString();
}

async function handleDistributionPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const channelId = String(job.payload.channelId ?? "");
  if (!clipId || !channelId) throw new Error("distribution.publish requires clipId + channelId");

  // Gate (2/3): stop before reading the clip, the token, or a single byte of video. This is
  // what catches jobs the route never vetted — ones queued while uploads were enabled and
  // still sitting in job_queue after they were turned off, or queued by any future caller.
  // Return (don't throw): throwing hands the job to the queue's blind backoff-retry, which
  // would re-attempt forever while the flag is off.
  if (!youtubeUploadEnabled()) {
    console.warn(`[worker] distribution.publish ${clipId}: blocked — YouTube 실업로드 비활성 (YOUTUBE_UPLOAD_ENABLED 미설정)`);
    // Record WHY on the board rather than leaving 'pending' (which reads as "업로드 중"),
    // and never as published. markDistributionFailed only writes status+error — it cannot
    // set externalId/publishedVideoId, so no clip can look uploaded because of this path.
    await markDistributionFailed(clipId, "youtube", UPLOAD_DISABLED_MESSAGE).catch(() => {});
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.publish: clip ${clipId} gone — dropping`); return; }

  // The deliverable is the single render (plan §2.4); without it there is nothing to ship.
  const mediaId = clip.mediaId;
  if (!mediaId) { await markDistributionFailed(clipId, "youtube", "클립이 아직 렌더되지 않았습니다 (익스포트 필요)"); return; }
  const media = await getMedia(mediaId);
  if (!media) { await markDistributionFailed(clipId, "youtube", "렌더된 영상 파일을 찾을 수 없습니다"); return; }

  const ch = await loadActiveChannel(channelId);
  if (!ch) { await markDistributionFailed(clipId, "youtube", "업로드할 YouTube 채널이 연결되지 않았거나 재연결이 필요합니다"); return; }

  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { await markDistributionFailed(clipId, "youtube", "스토리지에 영상 파일이 없습니다"); return; }

  const publishAt = futurePublishAt(job.payload.publishAt);
  const privacy = publishAt
    ? "private"
    : (["public", "unlisted", "private"].includes(String(job.payload.privacy))
        ? (String(job.payload.privacy) as "public" | "unlisted" | "private")
        : "public");

  try {
    const body = await streamToBuffer(createReadStream(objPath));
    const { videoId } = await withChannelToken(ch, (token) =>
      uploadVideoResumable(
        token,
        { body, contentType: media.mime || "video/mp4" },
        {
          title: clip.title ?? "무제 클립",
          description: clip.synopsis ?? "",
          tags: Array.isArray(clip.tags) ? clip.tags : undefined,
          privacyStatus: privacy,
          publishAt,
        },
      ),
    );

    // A future publishAt means YouTube holds the video private until then — report 'scheduled'.
    const finalStatus = publishAt ? "scheduled" : "published";
    const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
    const distributions = upsertDistribution(fresh.distributions, "youtube", {
      status: finalStatus, externalId: videoId, youtubeChannelId: channelId, error: undefined,
      ...(publishAt ? { reserveDate: publishAt } : {}),
    });
    await putEntity("clip", clipId, {
      ...fresh, status: "published", publishedVideoId: videoId, distributions,
    });
    console.log(`[worker] distribution.publish ${clipId} → youtube ${videoId} (${finalStatus})`);
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      // Refresh can never succeed again — park the channel AND surface the failure on the clip.
      await markChannelRevoked(channelId).catch(() => {});
      await markDistributionFailed(clipId, "youtube", "YouTube 채널 재연결이 필요합니다 (토큰 만료/취소)");
      console.error(`[worker] distribution.publish ${clipId}: token revoked — channel ${channelId} parked`);
      return;
    }
    const message = String(err?.message ?? err);
    await markDistributionFailed(clipId, "youtube", message);
    console.error(`[worker] distribution.publish ${clipId} failed:`, message);
  }
}

/** Enqueue every live channel. Dedupe keeps a slow channel from stacking up jobs. */
async function sweepDueChannels(): Promise<void> {
  const channels = await listYouTubeChannels();
  let queued = 0;

  for (const ch of channels) {
    if (ch.status === "revoked") continue;
    const id = await enqueue("channel.analyze", { channelId: ch.channelId }, {
      dedupeKey: `channel.analyze:${ch.channelId}`,
    });
    if (id) queued++;
  }

  if (queued) console.log(`[worker] sweep queued ${queued}/${channels.length} channels`);
}

async function loop(): Promise<void> {
  const startedAt = Date.now();
  let drained = 0;
  while (!stopping) {
    // drain 모드는 예산 시간이 지나면 **새 잡을 안 집는다**. 남은 건 다음 실행이 가져간다.
    if (DRAIN_MODE && Date.now() - startedAt > DRAIN_MAX_MS) {
      console.log(`[worker] drain 예산(${Math.round(DRAIN_MAX_MS / 60000)}분) 초과 — ${drained}건 처리 후 종료`);
      return;
    }
    let job: Job | null = null;
    try {
      job = await claimJob(CLAIM_TYPES);
    } catch (err) {
      console.error("[worker] claim failed", err);
      if (DRAIN_MODE) return;   // 큐 접근 자체가 실패 — 다음 실행에 맡긴다
      await sleep(IDLE_POLL_MS);
      continue;
    }

    if (!job) {
      if (DRAIN_MODE) {
        console.log(`[worker] 큐 비었음 — ${drained}건 처리 후 종료`);
        return;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }
    drained++;

    // Keep the lock fresh while the job runs, so requeueStale (30-min sweep) never hands a
    // still-executing long job (content.analyze) to a second worker. 5-min cadence, well
    // under the 30-min stale window. Track the lock value we own so heartbeatJob's guard can
    // reject a beat once the row has been reclaimed and reassigned (see queue.ts).
    let ownedLock = job.lockedAt ?? 0;
    const beat = setInterval(() => {
      void heartbeatJob(job!.id, ownedLock)
        .then((next) => {
          if (next != null) ownedLock = next;
          else {
            // Row reclaimed (loop starvation) and re-locked by another worker — stop beating
            // so a straggler beat can't keep overwriting the new owner's lock and starve its
            // own stale-sweep. (completeJob on this run may still flip the row to done; that's
            // the pre-existing reclaim edge, not made worse here.)
            clearInterval(beat);
            console.warn(`[worker] job ${job!.id}: lock lost to another worker — heartbeat stopped`);
          }
        })
        .catch((err) => console.error("[worker] heartbeat failed", err));
    }, 5 * 60 * 1000);
    if (typeof beat.unref === "function") beat.unref();
    // ⚠️ 이벤트 루프 앵커 — **절대 unref 하지 말 것.**
    // content-pipeline 은 python 자식과 stdout/stderr 파이프를 전부 unref 한다(Windows 에서
    // 자식 native crash 가 워커까지 kill 하던 문제 대응). drain 모드에는 폴링 setInterval 도
    // 없고(=null) 위 heartbeat 도 unref 다. 그래서 잡이 도는 동안 루프를 붙잡는 참조가 pg 풀
    // 소켓밖에 안 남는데, DB 무활동 구간(58분 회차의 STT 처럼 한 스테이지가 수 분간 조용한
    // 경우)이 오면 풀이 유휴로 닫히면서 이벤트 루프가 비고 **Node 가 exit(0) 으로 조용히
    // 끝난다.** 컨테이너는 '성공'으로 사라지고 잡은 running 인 채 남아 재시도만 반복한다.
    // (실측 2026-08-08: 컨테이너 시작 44~46초 만에 종료 · 에러 로그 0줄 · succeededCount=1)
    const keepAlive = setInterval(() => {}, 30_000);
    try {
      const followUp = await handle(job);
      clearInterval(beat);
      await completeJob(job.id);
      // Enqueue any successor only now that this row is 'done', so a self-scheduling
      // job (hotwatch) can reuse its own dedupeKey without colliding with itself.
      // Isolated try/catch: an enqueue failure must not fall into the outer catch's
      // failJob after completeJob already succeeded (failJob's status guard is the
      // second line of defense, but the job must also not be reported as failed).
      if (followUp) {
        try {
          const id = await enqueue(followUp.type, followUp.payload, followUp.opts);
          if (!id) console.warn(`[worker] follow-up ${followUp.type} for ${job.id} was deduped`);
        } catch (e) {
          console.error(`[worker] follow-up enqueue failed for ${job.id} (${followUp.type}):`, e);
        }
      }
    } catch (err: any) {
      clearInterval(beat);
      if (err instanceof TokenRevokedError) {
        // Refreshing can never succeed again — park the channel and stop retrying.
        const channelId = String(job.payload.channelId ?? "");
        if (channelId) await markChannelRevoked(channelId).catch(() => {});
        console.error(`[worker] job ${job.id} (${job.type}): token revoked — channel ${channelId} parked`);
        await completeJob(job.id);
        continue;
      }
      const message = String(err?.message ?? err);
      console.error(`[worker] job ${job.id} (${job.type}) failed:`, message);
      // failJob decides retry-with-backoff vs. dead — the worker never loops hot.
      await failJob(job.id, message);
    } finally {
      clearInterval(keepAlive);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // A long content.analyze (many minutes of Gemini calls) must survive a stray async error —
  // e.g. an unhandled stream 'error' or a rejected promise from a background tick — which
  // would otherwise kill the whole worker mid-job and leave it crash-looping. Log loudly and
  // keep going; the per-job try/catch already parks genuine job failures.
  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandledRejection (surviving):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaughtException (surviving):", err);
  });

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error("[worker] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are required");
    process.exit(1);
  }

  await initDb();
  await initQueue();
  console.log("[worker] db + queue ready");
  // State of the upload gate, logged once at boot so an operator can tell from the log alone
  // whether this worker can publish. Prints the mode only — never the token/secret values.
  console.log(
    `[worker] YouTube 실업로드: ${youtubeUploadEnabled() ? "ENABLED (실제 업로드됨)" : "DISABLED (기본값 — YOUTUBE_UPLOAD_ENABLED 미설정)"}`,
  );

  // Jobs left 'running' by a crashed worker would otherwise sit locked forever.
  const recovered = await requeueStale();
  if (recovered) console.log(`[worker] requeued ${recovered} stale job(s)`);

  console.log("[worker] queue:", JSON.stringify(await queueStats()));

  if (RUNS_SWEEP) await sweepDueChannels();
  // drain 모드는 Scheduler 가 주기적으로 깨우므로 내부 타이머가 필요 없다.
  // (setInterval 을 걸면 Node 이벤트 루프가 살아 있어 잡을 다 처리하고도 안 끝난다.)
  const tick = DRAIN_MODE ? null : setInterval(() => {
    if (RUNS_SWEEP) void sweepDueChannels().catch((err) => console.error("[worker] sweep failed", err));
    void requeueStale().catch((err) => console.error("[worker] requeue failed", err));
  }, TICK_INTERVAL_MS);

  // Let the in-flight job finish; systemd restarts us either way.
  const shutdown = (sig: string) => {
    console.log(`[worker] ${sig} — finishing current job then exiting`);
    stopping = true;
    if (tick) clearInterval(tick);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(
    `[worker] lane=${WORKER_JOBS} · claims=${CLAIM_TYPES ? CLAIM_TYPES.join(",") : "all"} · sweep=${RUNS_SWEEP}`
    + (DRAIN_MODE ? ` · mode=drain (큐 비면 종료 · 예산 ${Math.round(DRAIN_MAX_MS / 60000)}분)` : " — polling for jobs"),
  );
  await loop();
  console.log("[worker] stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

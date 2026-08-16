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
  listChannelsForSweep,
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
  creditBalance,
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
  appendGateAudit,
  getRawPool,
} from "./db-pg.ts";
import { clipGate } from "./publish-dispatch.ts";
import { checkCredits } from "./credits.ts";
import { billableMinutes } from "./billing.ts";
import { probe, captureThumbnail } from "./ffmpeg.ts";
import {
  prepareProgramAssets, publishStyleProfile, publishThumbnails, tempAssetRoot, pullPrefix,
} from "./thumbnail-assets.ts";
import { uploadFile, uploadPath, thumbPath } from "./storage-gcs.ts";
import { initQueue, claimJob, completeJob, failJob, requeueStale, heartbeatJob, enqueue, lastDoneJobAt, queueStats, type Job, type JobType } from "./queue.ts";
import { runWithTenant, runAsSystem, DEFAULT_TENANT_ID } from "./tenant.ts";
import { runAutomationCycle } from "./automation-cycle.ts";
import { runChannelPipeline } from "./channel-pipeline.ts";
import { runClipReframe, runContentAnalyze, newestMtimeMs } from "./content-pipeline.ts";
import {
  withAccessToken,
  fetchVideoAnalytics,
  fetchVideosBatch,
  fetchVideoComments,
  uploadVideoResumable,
  setVideoThumbnail,
  updateVideoPrivacy,
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
import {
  createReadStream, parseObjectPath, fileExists, signedReadUrl, readFile, listPrefix,
} from "./storage-gcs.ts";
import { pipeline } from "node:stream/promises";
import {
  youtubeUploadEnabled, UPLOAD_DISABLED_MESSAGE,
  tiktokUploadEnabled, TIKTOK_UPLOAD_DISABLED_MESSAGE,
  instagramUploadEnabled, INSTAGRAM_UPLOAD_DISABLED_MESSAGE,
  facebookUploadEnabled, FACEBOOK_UPLOAD_DISABLED_MESSAGE,
} from "./upload-gate.ts";
import { withTikTokToken, uploadDraftToTikTok, TikTokTokenRevokedError } from "./tiktok.ts";
import {
  getTikTokAccountByOpenId, updateTikTokTokens, markTikTokAccountDisconnected, appendRuleRun,
} from "./db-pg.ts";
import { publishInstagramReel, refreshInstagramToken } from "./instagram.ts";
import { publishFacebookReel } from "./facebook.ts";
import {
  listInstagramAccounts, getMetaAccountByPageId, updateInstagramToken, parkInstagramAccountExpired,
} from "./db-pg.ts";
import { naverUploadEnabled, NAVER_DISABLED_MESSAGE } from "./naver-gate.ts";
import { hasNaverSession, materializeNaverSession } from "./naver-session.ts";
import { getNaverAccount, markNaverAccount, getNaverSessionBlob } from "./db-pg.ts";
import { openSession } from "./naver-session-store.ts";
import { uploadToNaver, NAVER_TARGETS, type NaverTarget } from "./naver-tv.ts";
import { prepareWorkPath, cleanupWorkFile, sweepStaleWorkFiles } from "./naver-workdir.ts";
import { upsertDistribution } from "./publish-guard.ts";
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
const JOB_LANES: Record<"content" | "youtube" | "gebd" | "naver" | "download", JobType[]> = {
  // match.align도 content 레인 — 파이썬·ffmpeg로 오디오를 돌리는 무거운 잡이라
  // YouTube API 레인(짧고 쿼터 위주)에 섞으면 그쪽을 막는다.
  // thumbnail.* 도 content 레인. 성격이 같다 — core/thumbnail 파이썬을 스폰하고 이미지 생성
  // API 를 부르는 무거운 잡이다.
  // ⚠️ 2026-08-12 이전에는 이 둘이 **어느 레인에도 없고** ALL_LANE_TYPES 에만 있었다.
  //    그런데 프로덕션에 뜨는 워커는 WORKER_JOBS=content 와 =youtube 뿐이라(all 워커 없음)
  //    큐잉은 되는데 **아무도 claim 하지 않아 영원히 pending** 이었다. 라우트는 {jobId} 로
  //    성공을 돌려주므로 화면에서는 "생성 중" 으로만 보인다 — 이 리포의 전형적 조용한 실패다.
  //    아래 "모든 JobType 은 실제로 도는 레인에 속한다" 테스트가 재발을 막는다.
  content: ["content.analyze", "match.align", "match.segment", "match.learn",
            "thumbnail.style", "thumbnail.generate", "clip.metadata", "clip.reframe"],
  // factory.* 도 youtube 레인 — 상태기계 한 걸음은 DB 몇 번 읽고 재큐하는 게 전부라
  // 짧고, 배포(distribution.publish)와 같은 레인에 있어야 순서가 자연스럽다.
  // automation.cycle 도 youtube 레인 — 순방 한 바퀴는 DB 를 훑고 dispatchPublish 를 부르는
  // 게 전부라 짧고, 그 결과가 distribution.publish 로 이어지므로 같은 레인이 자연스럽다.
  youtube: ["channel.analyze", "video.analyze", "video.hotwatch", "video.comments",
            "distribution.publish", "factory.orchestrate", "factory.publicize",
            "automation.cycle"],
  // naver 는 **사무실 상시 PC 전용 lane**. 네이버는 공개 업로드 API 가 없어 브라우저
  // 자동화가 유일한데, 해외 데이터센터 IP(Cloud Run) 로 로그인하면 캡차·2차인증에 막힌다.
  // 그래서 한국 가정/사무실 IP 의 놀고 있는 PC 한 대에서만 이 레인을 돌린다.
  // 세션(storageState)도 그 PC 로컬에만 둔다 — 쿠키를 클라우드로 올리지 않는다.
  naver: ["naver.publish"],
  // download 도 **사무실 PC 전용 lane** (naver 와 같은 머신, 윈도우2). 유튜브가 데이터센터
  // IP(Cloud Run)를 봇으로 판정해 다운로드가 상시 실패한다(2026-08-14 실측: 쿠키를 물려도
  // "Sign in to confirm you're not a bot"). 한국 가정/사무실 IP 에서만 안정적으로 받아지므로
  // 다운로드는 윈도우2가 받고 GCS 에 올린 뒤, 분석(content.analyze)은 클라우드가 잇는다.
  download: ["youtube.download"],
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
/** 머신 전용 레인(gebd·naver)을 제외한 전체 타입 — "all" 워커가 집는 범위. */
const ALL_LANE_TYPES: JobType[] = [...JOB_LANES.content, ...JOB_LANES.youtube];
const CLAIM_TYPES: JobType[] | undefined =
  WORKER_JOBS === "content" ? JOB_LANES.content
  : WORKER_JOBS === "youtube" ? JOB_LANES.youtube
  : WORKER_JOBS === "gebd" ? JOB_LANES.gebd
  : WORKER_JOBS === "naver" ? JOB_LANES.naver
  : WORKER_JOBS === "download" ? JOB_LANES.download
  // 윈도우2 는 네이버 발행과 유튜브 다운로드를 한 프로세스로 돌린다(런처가 고정).
  : WORKER_JOBS === "naver,download" || WORKER_JOBS === "download,naver"
    ? [...JOB_LANES.naver, ...JOB_LANES.download]
  // "all" 은 **머신 전용 레인을 빼고** 전부 집는다. gebd 는 GPU 가, naver 는 Playwright·
  // 한국 IP·로그인 세션이 있는 PC 가 필요해서, 아무 워커나 집으면 100% 실패한다.
  // (실측 2026-08-11: all 워커가 naver.publish 를 집어가 재시도만 쌓았다.)
  : ALL_LANE_TYPES;
/** The channel sweep enqueues YouTube work, so content/gebd-only workers must not run it. */
// naver 워커도 sweep 을 돌리지 않는다 — 사무실 PC 한 대일 뿐이고, sweep 은
// youtube 레인이 책임진다. 두 곳에서 돌면 같은 잡을 두 번 되살린다.
// ⚠️ **조합 문자열까지 넣어야 한다.** 윈도우2 런처는 WORKER_JOBS 를 "naver,download" 로
// 못 박는데(worker-naver.mts), 예전 판정은 정확히 "naver" 일 때만 걸러서 사무실 PC 가
// 자동배포 순방과 채널 스윕까지 돌리고 있었다 — 프로덕션 자동배포 주기가 Cloud Scheduler
// 가 아니라 그 PC 의 가동 여부에 좌우된다는 뜻이다. CLAIM_TYPES·YT_FREE 와 같은 방식.
const NO_SWEEP = new Set(["content", "gebd", "naver", "download", "naver,download", "download,naver"]);
const RUNS_SWEEP = !NO_SWEEP.has(WORKER_JOBS);

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
    case "naver.publish": return handleNaverPublish(job);
    case "content.analyze": {
      await runContentAnalyze(String(job.payload.mediaId ?? ""), Boolean(job.payload.fast),
        { n: Number(job.attempts ?? 0), max: Number(job.maxAttempts ?? 0) });
      return;
    }
    case "clip.reframe": {
      await runClipReframe({
        clipId: String(job.payload.clipId ?? ""),
        inputFingerprint: String(job.payload.inputFingerprint ?? ""),
        requestId: String(job.payload.requestId ?? ""),
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      return;
    }
    case "youtube.download": return handleYoutubeDownload(job);
    case "match.align": return handleMatchAlign(job);
    case "match.segment": return handleMatchSegment(job);
    case "match.learn": return handleMatchLearn(job);
    case "gebd.detect": return handleGebdDetect(job);
    case "automation.cycle": return handleAutomationCycle(job);
    case "factory.orchestrate": return handleFactoryOrchestrate(job);
    case "factory.publicize": return handleFactoryPublicize(job);
    case "clip.metadata": return handleClipMetadata(job);
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
  // 쿠키 파일이 실제로 존재할 때만 붙인다 — 경로만 있고 파일이 없으면 yt-dlp가 죽는다.
  // ⚠️ yt-dlp 는 --cookies 파일을 실행 종료 시 **다시 쓴다**(세션 쿠키 갱신 저장). Cloud Run
  // 시크릿 마운트는 읽기 전용이라 그대로 넘기면 EROFS 로 다운로드 전체가 죽는다(2026-08-14
  // 실측: "Read-only file system: /secrets/ytdlp/cookies.txt") — 쓰기 가능한 tmp 사본을 넘긴다.
  let cookiesTmp: string | null = null;
  if (YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)) {
    cookiesTmp = path.join(os.tmpdir(), `ytdlp-cookies-${process.pid}-${Date.now()}.txt`);
    fs.copyFileSync(YTDLP_COOKIES, cookiesTmp);
  }
  const withCookies = cookiesTmp ? ["--cookies", cookiesTmp, ...args] : args;
  return new Promise<void>((resolve, reject) => {
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
  }).finally(() => {
    // tmpfs(RAM) 잔류 방지 — 쿠키 사본은 실행마다 지운다.
    if (cookiesTmp) { try { fs.unlinkSync(cookiesTmp); } catch {} }
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
    // 분석 자동 큐잉 전 크레딧 재확인 — 등록 라우트(402)는 러닝타임을 몰라 "잔액 0 이하"만
    // 봤다. 지금은 실제 길이를 아니 factory·/analyze 라우트와 같은 정밀 판정을 한다.
    // 막히면 잡 **실패가 아니라 스킵**이다: 다운로드 자체는 성공했고, 여기서 던지면 큐가
    // 백오프 재시도를 돌며 매번 같은 사유로 죽는 재큐잉 루프가 된다. 사유는 에피소드
    // 파이프라인 노트로 사람에게 남긴다 — 충전 후 화면의 '분석 시작'으로 재개하면 된다.
    const verdict = checkCredits({
      balance: await creditBalance(),
      needMinutes: billableMinutes(meta.durationSec),
    });
    if (!verdict.allow) {
      await setEpisodeNote(`크레딧 부족 — 충전 후 분석을 시작해 주세요 (${verdict.reason})`, "idle", 0);
      console.warn(`[worker] youtube.download ${mediaId}: content.analyze 큐잉 스킵 — ${verdict.reason}`);
    } else {
      // fast를 content.analyze로 이어 전달 — 대량 배치용.
      await enqueue("content.analyze", { mediaId, ...(fast ? { fast: true } : {}) }, { dedupeKey: `content.analyze:${mediaId}` });
      await setEpisodeNote("AI 장면 분석 대기 중…", "progress", 30);
    }
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
 * 숏폼들을 한 번의 호출로 정렬한다 — core.stt.align 이 롱폼 특징을 한 번만 계산하도록.
 * 숏폼마다 호출하면 61분 롱폼을 매번 다시 디코딩해 16개에 20분을 넘긴다.
 * 반환은 입력 순서와 1:1.
 */
function runAlign(longPath: string, shortPaths: string[]): Promise<AlignOut[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.stt.align", longPath, ...shortPaths], {
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
      if (code !== 0) return reject(new Error(`core.stt.align exited ${code}: ${errText.slice(-300)}`));
      try {
        const lines = out.trim().split("\n").filter((l) => l.trim().startsWith("{"));
        resolve(lines.map((l) => JSON.parse(l) as AlignOut));
      } catch (e) {
        reject(new Error(`core.stt.align 출력 파싱 실패: ${String(e)} / ${out.slice(-200)}`));
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

/**
 * 자동 배포 순방 — 한 테넌트분. 워커가 이미 `job.tenantId` 로 컨텍스트를 세운 뒤 부르므로
 * 여기서 읽는 규칙·프로그램·채널은 전부 그 워크스페이스 것뿐이다(RLS).
 *
 * 던지지 않는다 — 순방이 실패해서 큐 백오프를 타면 같은 회차를 반복 평가하게 된다.
 * 다음 순방에 다시 보면 되는 일이다.
 */
async function handleAutomationCycle(job: Job): Promise<void> {
  try {
    const report = await runAutomationCycle();
    if (report.rulesEvaluated > 0 || report.idleReason) {
      console.log(`[worker] automation.cycle ${job.tenantId}:`, JSON.stringify(report));
    }
  } catch (e) {
    console.error(`[worker] automation.cycle ${job.tenantId} 실패(다음 순방에 재시도):`, e);
  }
}

/**
 * 순방 팬아웃 — **여기만 시스템 스코프다.** 테넌트 목록을 읽고, 각 테넌트의 컨텍스트
 * *안에서* 잡을 넣는다. 잡 행의 tenant_id 가 그때 정해지고, 워커가 그걸로 다시 컨텍스트를
 * 세운다. 순방 자체를 시스템 스코프로 돌리면 A 의 규칙이 B 의 채널을 볼 수 있다.
 */
export async function fanOutAutomationCycles(): Promise<number> {
  const tenants = await runAsSystem(async () => {
    const { rows } = await getRawPool().query("SELECT id FROM tenants");
    return rows.map((r: { id: string }) => r.id);
  });

  let n = 0;
  for (const tenantId of tenants) {
    // dedupeKey 로 같은 테넌트의 순방이 겹쳐 쌓이지 않게 한다.
    const id = await runWithTenant({ scope: tenantId, via: "system" }, () =>
      enqueue("automation.cycle", {}, { dedupeKey: `automation.cycle:${tenantId}`, maxAttempts: 1 }),
    );
    if (id) n += 1;
  }
  return n;
}

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
  // 결과는 **실제 배포 행을 세어** 정한다 — 공개 전환 성공 여부와 무관하게 무조건 done 을
  // 찍으면, 업로드가 전멸한 잡도 호출자에게 성공으로 보인다.
  const { summarizeOutcome } = await import("./factory.ts");
  const out = await summarizeOutcome(fj);
  await putEntity("factoryJob", factoryJobId, {
    ...fj, state: out.state, ...(out.error ? { error: out.error } : {}),
    note: `게시 ${out.counts.published}/${out.counts.clips} · 공개 전환 ${switched}건`,
    updatedAt: Date.now(),
  });
  console.log(`[worker] factory.publicize ${factoryJobId} · ${switched}건 공개 · ${out.state}`);
}

/**
 * 채택된 클립의 채널별 업로드 메타데이터를 미리 만든다.
 *
 * 생성 로직은 서버 라우트에 있다(`/api/clips/:id/generate-metadata`) — 프롬프트·채널 규칙·
 * 저장이 한 곳에 있어야 화면에서 누른 것과 자동 생성이 **같은 결과**를 낸다. 워커는
 * 그 라우트를 부르기만 한다.
 *
 * ⚠️ 실패해도 던지지 않는다. 메타는 발행 화면에서 다시 만들 수 있고, 여기서 재시도를
 * 쌓아 봐야 같은 이유로 또 실패한다(대개 입력 부족이다). 사유만 남긴다.
 */
async function handleClipMetadata(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  if (!clipId) { console.error("[worker] clip.metadata: clipId 누락 — 버림"); return; }
  try {
    // 워커 → 서버 내부 호출. 인증(IAM ID 토큰 + 내부 토큰)은 factory 가 이미 풀어 둔 문제라
    // 복제하지 않고 그대로 쓴다 — 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
    const { apiBase, internalHeaders } = await import("./factory.ts");
    const res = await fetch(`${apiBase()}/api/clips/${clipId}/generate-metadata`, {
      method: "POST", headers: await internalHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[worker] clip.metadata ${clipId} 실패 (${res.status}): ${body.slice(0, 300)}`);
      return;
    }
    console.log(`[worker] clip.metadata ${clipId} 완료`);
  } catch (e) {
    console.error(`[worker] clip.metadata ${clipId} 실패:`, e instanceof Error ? e.message : e);
  }
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

  const outDir = path.join(os.tmpdir(), "stepd-thumb-out", mediaId);

  // 이 프로그램의 스타일 프로파일·출연자 사진만 내려받는다 (회차마다 전체를 뒤지지 않게).
  const assets = await prepareProgramAssets(programId, `gen-${mediaId}-${Date.now()}`);
  if (!assets.castFiles) {
    fs.rmSync(assets.root, { recursive: true, force: true });
    throw new Error(`cast_not_registered: ${programId} 에 등록된 출연자 사진이 없습니다`);
  }

  // 분석 산출물(narrative.json 등)과 원본 영상도 **에셋과 같은 배관**으로 내려받는다.
  // 예전엔 로컬 스토리지 경로를 그대로 파이썬에 넘겼는데, 프로덕션은 GCS 모드라 그 경로가
  // 컨테이너에 존재하지 않는다 → core/thumbnail 이 narrative.json 을 못 읽고 매번 죽었다.
  // 사용자 화면엔 '생성 중' 만 남고 후보는 영원히 안 나온다(전형적인 조용한 실패).
  const analysisDir = path.join(assets.root, "analysis", mediaId);
  fs.mkdirSync(analysisDir, { recursive: true });
  const pulled = await pullPrefix(`analysis/${mediaId}`, analysisDir);
  if (!fs.existsSync(path.join(analysisDir, "narrative.json"))) {
    fs.rmSync(assets.root, { recursive: true, force: true });
    throw new Error(`analysis_missing: ${mediaId} 의 분석 산출물(narrative.json)이 없습니다 — 회차 분석을 먼저 끝내야 합니다 (내려받은 파일 ${pulled}개)`);
  }

  // 배경 프레임 단계는 원본 영상이 필요하다. GCS 모드면 tmp 로 받아 쓰고 끝나면 지운다
  // (Cloud Run 의 /tmp 는 RAM 이다 — 안 지우면 메모리가 쌓인다).
  let video = "";
  try {
    const media = await getMedia(mediaId);
    const objPath = media ? parseObjectPath(media.path) : null;
    if (objPath && await fileExists(objPath)) {
      const local = path.join(assets.root, `${mediaId}.mp4`);
      const rs = await createReadStream(objPath);
      await pipeline(rs, fs.createWriteStream(local));
      video = local;
    }
  } catch (e) {
    console.warn(`[worker] thumbnail.generate ${mediaId}: 원본 영상 준비 실패 — 배경 프레임 없이 진행`,
      e instanceof Error ? e.message : e);
  }

  try {
    const result = await runThumbnailCli([
      "generate",
      "--media-id", mediaId,
      "--program-id", programId,
      "--title", String(job.payload.title ?? ""),
      "--analysis-dir", analysisDir,
      "--video", video,
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
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.scenes.segment", ytAudioUrl(longVideoId), "-"], {
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
      if (code !== 0) return reject(new Error(`core.scenes.segment exited ${code}: ${errText.slice(-300)}`));
      try {
        resolve(
          out.trim().split("\n")
            .filter((l) => l.trim().startsWith("{"))
            .map((l) => JSON.parse(l) as SegmentOut),
        );
      } catch (e) {
        reject(new Error(`core.scenes.segment 출력 파싱 실패: ${String(e)} / ${out.slice(-200)}`));
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
// 자동화의 마지막 단계: 매칭·구간설명이 채워진 채널에서 core.recommend.learn_profile 로 규칙을 뽑아
// youtube_channels.pointProfile에 저장한다. 이후 그 채널 영상을 분석하면 content-pipeline이
// 이 프로파일을 --profile로 넘겨 recommend가 채널에 맞는 후보를 고른다(기존 스티어링 배선).
//
// 미설명 구간이 남아 있으면 match.segment를 먼저 돌리고 재큐한다 — 설명 없이 학습하면
// 표본이 얇아 규칙이 부실하다.

/** LEARN 데이터셋(export)을 만들어 core.recommend.learn_profile 에 넘기고 결과를 받는다. */
function runLearn(channelId: string, exportJson: string): Promise<{ profile: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CORE_PYTHON_BIN, ["-m", "core.recommend.learn_profile", "-"], {
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
      if (code !== 0) return reject(new Error(`core.recommend.learn_profile exited ${code}: ${err.slice(-300)}`));
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

// upsertDistribution 은 publish-guard.ts 로 이동 (index.ts 와 두 벌이었다).

/** Re-read the clip (avoid clobbering concurrent edits) and mark its dist failed. */
async function markDistributionFailed(
  clipId: string, channel: string, error: string, accountId?: string,
): Promise<void> {
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return;
  // 실패도 **같은 계정 항목**에 겹쳐 써야 한다 — 정체성 없이 쓰면 같은 플랫폼
  // 다른 계정의 기록을 덮는다(upsertDistribution 이 채널+계정으로 매칭한다).
  const value: Record<string, unknown> = { status: "failed", error };
  const accountField = channel === "youtube" ? "youtubeChannelId"
    : channel === "tiktok" ? "tiktokOpenId"
    : channel === "instagram" ? "igUserId"
    : channel === "facebook" ? "metaPageId"
    : "naverAccountId";
  if (accountId) value[accountField] = accountId;
  const distributions = upsertDistribution(clip.distributions, channel, value);
  await putEntity("clip", clipId, { ...clip, distributions });

  // 자동 규칙이 만든 클립이면 **자동화 실행 로그에도** 실패를 남긴다.
  // 순방은 큐에 넣은 시점에 'published' 를 적는다 — 워커가 실패시켜도 그 줄이 남으면
  // 화면은 "오늘 3건 게시" 라고 말하는데 채널엔 아무것도 없고, 할당량만 소진된다.
  // 이 줄이 그 슬롯을 되돌리고(publishedTodayKst), 운영자에게 실패를 보이게 한다.
  if (clip.automationRuleId) {
    await appendRuleRun({
      ruleId: String(clip.automationRuleId), clipId, result: "failed",
      detail: `${channel} 게시 실패 — ${String(error).slice(0, 200)}`,
      accountKey: accountId ? `${channel}:${accountId}` : null,
    }).catch(() => { /* 로그 실패가 배포 처리를 막을 이유는 없다 */ });
  }
}

/**
 * 이 클립으로 유튜브에 올릴 썸네일을 고른다.
 *
 * 우선순위 — **사람이 고른 것 → AI 생성물 → 렌더 프레임**.
 *  1. `clip.thumbnailUrl` : 추천에서 채택할 때 사람이 고른 변형(16:9 우선).
 *  2. `thumbnails/{masterMediaId}/` : 썸네일 생성 기능(thumbnail.generate)이 만든 후보.
 *     회차 단위라 클립마다 다르지는 않지만, 자동 프레임보다는 훨씬 낫다.
 *  3. 렌더된 클립 자체의 대표 프레임(clip media 의 thumbPath) — 항상 있다(export 가 뽑는다).
 *
 * 셋 다 없으면 null 을 돌려주고 호출부가 그냥 진행한다 — 썸네일 때문에 배포를 막지 않는다.
 */
async function resolveClipThumbnail(
  clip: any,
): Promise<{ body: Buffer; contentType: string; source: string } | null> {
  const mime = (p: string) => (/\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg");
  const load = async (objPath: string, source: string) => {
    if (!objPath || !(await fileExists(objPath).catch(() => false))) return null;
    const body = await readFile(objPath);
    return { body, contentType: mime(objPath), source };
  };

  // 1) 사람이 고른 변형. 저장된 값이 URL 형태(/media/... · /api/...)일 수 있어 오브젝트 경로만 받는다.
  const chosen = String(clip?.thumbnailUrl ?? "");
  if (chosen && !chosen.startsWith("/") && !/^https?:/i.test(chosen)) {
    const hit = await load(parseObjectPath(chosen), "chosen").catch(() => null);
    if (hit) return hit;
  }

  // 2) 썸네일 생성 기능의 산출물 (회차 단위).
  const masterId = String(clip?.sourceMediaId ?? "");
  if (masterId) {
    try {
      const { thumbnailPrefix } = await import("./thumbnail-assets.ts");
      const paths = (await listPrefix(`${thumbnailPrefix(masterId)}/`))
        .filter((p) => /\.(png|jpe?g|webp)$/i.test(p))
        .sort();
      if (paths.length) {
        const hit = await load(paths[0], "ai").catch(() => null);
        if (hit) return hit;
      }
    } catch { /* 목록 조회 실패는 폴백으로 간다 */ }
  }

  // 3) 렌더 결과의 대표 프레임 — export 가 항상 하나 뽑아 둔다.
  const clipMediaId = String(clip?.mediaId ?? "");
  if (clipMediaId) {
    const m = await getMedia(clipMediaId).catch(() => null);
    if (m?.thumbPath) {
      const hit = await load(parseObjectPath(m.thumbPath), "frame").catch(() => null);
      if (hit) return hit;
    }
  }
  return null;
}

/** ISO RFC3339 if `raw` parses to a FUTURE instant, else null (upload immediately). */
function futurePublishAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  return new Date(t).toISOString();
}

/**
 * 배포 잡 실행 — 큐를 소비하는 쪽.
 *
 * **던지지 않는다.** 실패는 전부 배포 상태에 사유로 남기고 정상 종료한다.
 * 던지면 큐가 지수 백오프로 최대 5회 자동 재시도하는데, F4-4 는 그걸 금지한다(⊘) —
 * 업로드가 실제로 시작된 뒤 재시도되면 중복 게시가 난다. 재시도는 사람이 누른다.
 */

// ── naver.publish — 네이버 TV 업로드 (브라우저 자동화 · 사무실 PC 전용 레인) ─────────
//
// 이 잡은 `WORKER_JOBS=naver` 로 뜬 워커만 집는다. Cloud Run 에서 집으면 Playwright 도,
// 한국 IP 도 없어서 100% 실패한다.
//
// distribution.publish 와 마찬가지로 **자동 재시도를 하지 않는다.** 브라우저 자동화 실패는
// 대개 DOM 개편·세션 만료라서 재시도해도 같은 결과고, 계정 잠금 위험만 키운다.

/**
 * 이 채널로 나갈 메타데이터.
 *
 * `/api/clips/:id/generate-metadata` 가 채널별로 만들어 둔 것을 쓴다. 없으면 예전처럼
 * clip.title·synopsis 로 폴백한다 — 메타를 아직 안 만든 옛 클립도 발행은 돼야 한다.
 *
 * ⚠️ **생성만 하고 여기서 안 쓰면 아무 의미가 없다.** 이 리포의 최빈 실패가 그거다
 * (기능은 있는데 출력이 소비처에 미도달). 채널 규칙의 titlePrefix·hashtagTemplate 도
 * 그렇게 1년 가까이 아무 데도 안 갔다.
 */
function metaForChannel(clip: any, channel: string): { title: string; description: string; tags?: string[] } {
  const m = clip?.channelMeta?.[channel];
  if (m && (m.title || m.description)) {
    return {
      title: String(m.title ?? clip.title ?? "무제 클립"),
      description: String(m.description ?? ""),
      tags: Array.isArray(m.tags) && m.tags.length ? m.tags : undefined,
    };
  }
  return {
    title: String(clip?.title ?? "무제 클립"),
    description: String(clip?.synopsis ?? ""),
    tags: Array.isArray(clip?.tags) ? clip.tags : undefined,
  };
}

async function handleNaverPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  if (!clipId) { console.error("[worker] naver.publish: clipId 누락 — 버림"); return; }
  // target 미지정은 tv 로 본다(기존 페이로드 호환). 오타는 조용히 tv 로 넘기지 말고 버린다 —
  // "클립에 올린 줄 알았는데 TV 에 올라간" 실패가 제일 나쁘다.
  const rawTarget = String(job.payload.target ?? "tv");
  if (!(rawTarget in NAVER_TARGETS)) {
    console.error(`[worker] naver.publish: 알 수 없는 target '${rawTarget}' — 버림`);
    return;
  }
  const target = rawTarget as NaverTarget;
  const channel = NAVER_TARGETS[target].channel;

  // 어느 네이버 계정으로 올릴지 — 실패 기록도 이 계정 항목에 남아야 해서(다계정 덮어쓰기
  // 방지) fail 보다 먼저 읽는다. 계정 미지정이면 레거시 단일 세션.
  const accountId = typeof job.payload.naverAccountId === "string" ? job.payload.naverAccountId : "";

  const fail = async (msg: string) => {
    console.error(`[worker] naver.publish ${clipId} (${channel}) 실패:`, msg);
    await markDistributionFailed(clipId, channel, msg, accountId || undefined).catch(() => {});
  };

  try {
    // 게이트는 업로드 직전에도 다시 본다(naver-tv.ts). 여기서는 빨리 걸러 잡을 낭비하지 않는다.
    if (!naverUploadEnabled()) return void (await fail(NAVER_DISABLED_MESSAGE));
    const clip = await getEntity<any>("clip", clipId);
    if (!clip) { console.warn(`[worker] naver.publish: clip ${clipId} 없음 — 버림`); return; }

    // B2B 다계정에서 **이 검증이 제일 중요하다** —
    // A사 클립이 B사 채널에 올라가는 사고를 막는다.
    let accountKey: string | undefined;
    if (accountId) {
      const acct = await getNaverAccount(accountId);
      if (!acct) return void (await fail(`네이버 계정 ${accountId} 없음`));
      if (acct.status === "disabled") return void (await fail(`네이버 계정 '${acct.label}' 이 비활성입니다`));
      // 잡의 테넌트와 계정의 테넌트가 다르면 **절대** 올리지 않는다. RLS 가 이미 막지만,
      // 워커에는 시스템 스코프로 도는 구간이 있어 여기서 한 번 더 본다.
      const jobTenant = job.tenantId || DEFAULT_TENANT_ID;
      if (acct.tenantId !== jobTenant) {
        return void (await fail(
          `테넌트 불일치 — 잡(${jobTenant}) vs 계정(${acct.tenantId}). 다른 고객사 채널에 올릴 뻔했습니다`));
      }
      if (!hasNaverSession(acct.accountKey)) {
        // 이 머신에 없으면 서버 보관본을 받아 푼다 — 운영자가 웹에서 로그인해 올린 것.
        // 이 경로가 있어야 워커 PC 앞에 가지 않아도 새 계정이 돌아간다.
        const state = openSession(await getNaverSessionBlob(acct.id));
        if (state) {
          materializeNaverSession(acct.accountKey, state);
          console.log(`[worker] '${acct.label}' 세션을 서버에서 받아왔다`);
        } else {
          await markNaverAccount(acct.id, { status: "session_expired" }).catch(() => {});
          return void (await fail(
            `'${acct.label}' 세션 없음 — 웹에서 로그인해 세션을 등록하거나, 워커 PC 에서 ` +
            `\`naver:login --account ${acct.accountKey}\` 를 실행하세요`));
        }
      }
      accountKey = acct.accountKey;
    } else if (!hasNaverSession()) {
      return void (await fail("네이버 세션이 없습니다 — 워커 PC 에서 `naver:login` 실행"));
    }
    if (!clip.mediaId) return void (await fail("클립이 아직 렌더되지 않았습니다 (익스포트 필요)"));
    const media = await getMedia(clip.mediaId);
    if (!media) return void (await fail("렌더된 영상 파일을 찾을 수 없습니다"));

    const objPath = parseObjectPath(media.path);
    if (!(await fileExists(objPath))) return void (await fail("스토리지에 영상 파일이 없습니다"));

    // Playwright 는 **로컬 파일 경로**만 받는다 — GCS 스트림을 그대로 못 넘긴다.
    // 임시폴더에 랜덤 이름으로 던지면 회차가 쌓일 때 뭐가 뭔지 알 수 없어서,
    // 회사/프로그램/회차로 갈라 둔다. 자세한 규칙은 naver-workdir.ts.
    const episode = clip.episodeId ? await getEntity<any>("episode", clip.episodeId) : null;
    const program = episode?.programId ? await getEntity<any>("program", episode.programId) : null;
    const { file: localPath } = prepareWorkPath({
      workspace: program?.tenantName ?? program?.broadcaster ?? episode?.tenantName,
      program: program?.title ?? program?.name,
      episode: episode?.title ?? episode?.episodeNo,
      clipId,
    });
    try {
      await pipeline(createReadStream(objPath), fs.createWriteStream(localPath));
      // 설명·태그는 **배포 시점에 사람이 넣은 값이 우선**이다. 클립은 제목 칸이 없고 설명
      // 300자가 전부라, 분석이 만든 synopsis 를 그대로 쓰면 잘리거나 어색하다.
      // 페이로드에 없을 때만 클립 메타로 폴백한다.
      const naverMeta = metaForChannel(clip, channel);
      const description = typeof job.payload.description === "string"
        ? job.payload.description
        : (clip.synopsis ?? "");
      const tags = Array.isArray(job.payload.tags)
        ? (job.payload.tags as unknown[]).map(String)
        : (Array.isArray(clip.tags) ? clip.tags : undefined);

      // 카테고리는 페이로드 → 프로그램 설정 순으로 본다. 자동 판정하지 않는다
      // (틀린 분류로 발행되면 되돌리기가 번거롭다 — 사람이 프로그램별로 한 번 정한다).
      const pc = (job.payload.category ?? {}) as { primary?: string; secondary?: string };
      const category = pc.primary && pc.secondary
        ? { primary: String(pc.primary), secondary: String(pc.secondary) }
        : undefined;

      // 등록 예약 — 과거 시각은 무시한다(네이버가 거부하고, 무시하면 즉시 등록된다).
      const rawAt = Number(job.payload.publishAt ?? 0);
      const publishAt = Number.isFinite(rawAt) && rawAt > Date.now() ? rawAt : undefined;

      const r = await uploadToNaver({
        target,
        accountKey,
        videoPath: localPath,
        publishAt,
        // 발행 시점에 사람이 넣은 값 > 채널별 메타 > 클립 기본값 순서.
        title: naverMeta.title,
        description: description || naverMeta.description,
        tags: tags ?? naverMeta.tags,
        category,
        artifactDir: path.join(os.homedir(), ".stepd", "naver-artifacts"),
      });
      if (!r.ok) {
        return void (await fail(`${r.error ?? "업로드 실패"}${r.screenshotPath ? ` (스크린샷: ${r.screenshotPath})` : ""}`));
      }
      const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
      await putEntity("clip", clipId, {
        ...fresh,
        // 계정 정체성을 함께 남긴다 — 관문(pending)이 만든 같은 계정 항목을 갱신하고,
        // 순방의 중복 게시 판정(hasAccountDistribution)이 계정 단위로 성립한다.
        distributions: upsertDistribution(fresh.distributions, channel, {
          status: "published", url: r.url ?? null, publishedAt: Date.now(),
          ...(accountId ? { naverAccountId: accountId } : {}),
        }),
      });
      if (accountId) await markNaverAccount(accountId, { lastPublishAt: Date.now(), status: "active" }).catch(() => {});
      console.log(`[worker] naver.publish ${clipId} (${channel}) 완료 → ${r.url ?? "(URL 미확인)"}`);

      // 발행 사이에 최소 간격. 짧은 시간에 몰아넣으면 네이버가 불안정해진다
      // (2026-08-11 실측: 30분에 10여 건 올리자 파일 투입이 조용히 실패하기 시작).
      // 정확한 한도는 모른다 — 아는 건 "몰아넣으면 깨진다" 뿐이라 보수적으로 잡는다.
      const gap = Number(process.env.NAVER_MIN_GAP_MS ?? 60_000);
      if (gap > 0) {
        console.log(`[worker] 다음 네이버 잡까지 ${Math.round(gap / 1000)}초 대기`);
        await sleep(gap);
      }
    } finally {
      // 클립 영상은 수백 MB 다. 성공·실패 무관하게 지운다 — GCS 에 원본이 있으니 언제든
      // 다시 받을 수 있고, 남기면 워커 PC 디스크가 금방 찬다. 폴더는 남긴다.
      cleanupWorkFile(localPath);
    }
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleDistributionPublish(job: Job): Promise<void> {
  // 같은 잡 타입을 channel 로 가른다 — 잡 타입을 늘리면 레인 배정이 또 필요하다.
  // 구 페이로드(channel 없음)는 전부 YouTube 다.
  const channel = String(job.payload.channel ?? "youtube");
  try {
    if (channel === "tiktok") await runTikTokDraftPublish(job);
    else if (channel === "instagram") await runInstagramPublish(job);
    else if (channel === "facebook") await runFacebookPublish(job);
    else await runDistributionPublish(job);
  } catch (err) {
    const clipId = String(job.payload.clipId ?? "");
    const accountId = channel === "tiktok" ? String(job.payload.tiktokOpenId ?? "")
      : channel === "instagram" ? String(job.payload.igUserId ?? "")
      : channel === "facebook" ? String(job.payload.metaPageId ?? "")
      : String(job.payload.channelId ?? "");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] distribution.publish ${clipId} (${channel}) 실패(재시도 안 함):`, err);
    if (clipId) await markDistributionFailed(clipId, channel, msg, accountId || undefined).catch(() => {});
    // 여기서 throw 하지 않는 것이 요점이다. 자동 재시도 금지(F4-4 ⊘).
  }
}

/**
 * TikTok 받은함 드래프트 업로드 — YouTube 경로와 같은 뼈대(게이트 재확인 → 킬스위치 →
 * 계정·클립·파일 검증 → 업로드 → 계정 정체성 포함 기록). 다른 점은 둘이다:
 * ① 파일을 /tmp 로 내려받아 올린다 — **작업 후 반드시 지운다.** Cloud Run 의 /tmp 는
 *    RAM(tmpfs) 이라 안 지우면 잡마다 메모리가 쌓여 OOM 난다.
 * ② clip.status 를 'published' 로 승격하지 않는다 — 초안은 공개 게시가 아니다. 최종 게시는
 *    크리에이터가 앱에서 하고, 우리 기록은 배포 항목(tiktokPublishId)까지다.
 */
async function runTikTokDraftPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const openId = String(job.payload.tiktokOpenId ?? "");
  if (!clipId || !openId) {
    console.error("[worker] distribution.publish(tiktok): clipId/tiktokOpenId 누락 — 버림");
    return;
  }

  // 게이트 재확인 — 큐에 앉아 있는 동안 권리 이슈가 새로 등록될 수 있다 (YouTube 와 동일).
  const gate = await clipGate(clipId);
  if (!gate.allowed) {
    console.warn(`[worker] distribution.publish(tiktok) ${clipId}: 게이트 미통과 — ${gate.reason}`);
    await markDistributionFailed(clipId, "tiktok", gate.reason, openId).catch(() => {});
    await appendGateAudit({
      subjectType: "clip", subjectId: clipId, action: "publish.blocked",
      fromState: gate.state, toState: "blocked", actor: "worker",
      basis: `업로드 직전 재확인 · ${gate.reason}`,
    }).catch(() => {});
    return;
  }

  // 킬스위치 (2/3) — 게이트가 켜진 동안 큐잉됐다가 꺼진 뒤 남은 잡을 막는다.
  // return (throw 금지): 던지면 백오프 재시도가 스위치 꺼진 내내 재시도만 쌓는다.
  if (!tiktokUploadEnabled()) {
    console.warn(`[worker] distribution.publish(tiktok) ${clipId}: blocked — TikTok 실업로드 비활성`);
    await markDistributionFailed(clipId, "tiktok", TIKTOK_UPLOAD_DISABLED_MESSAGE, openId).catch(() => {});
    return;
  }

  const acct = await getTikTokAccountByOpenId(openId);
  if (!acct || acct.status !== "active" || !acct.refreshToken) {
    await markDistributionFailed(clipId, "tiktok",
      "TikTok 계정이 연결되지 않았거나 재연결이 필요합니다", openId);
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.publish(tiktok): clip ${clipId} gone — dropping`); return; }
  const mediaId = clip.mediaId;
  if (!mediaId) { await markDistributionFailed(clipId, "tiktok", "클립이 아직 렌더되지 않았습니다 (익스포트 필요)", openId); return; }
  const media = await getMedia(mediaId);
  if (!media) { await markDistributionFailed(clipId, "tiktok", "렌더된 영상 파일을 찾을 수 없습니다", openId); return; }
  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { await markDistributionFailed(clipId, "tiktok", "스토리지에 영상 파일이 없습니다", openId); return; }

  const tmpPath = path.join(os.tmpdir(), `stepd-tiktok-${clipId}-${Date.now()}.mp4`);
  try {
    await pipeline(createReadStream(objPath), fs.createWriteStream(tmpPath));
    const body = await fs.promises.readFile(tmpPath);
    const { publishId } = await withTikTokToken(
      acct,
      // targeted 컬럼 write — 잡 시작 스냅샷으로 전체 행을 덮으면 동시 재연결 토큰을 밟는다(B6).
      (t) => updateTikTokTokens(acct.openId, t.accessToken, t.refreshToken, t.expiresAt, t.refreshExpiresAt),
      (token) => uploadDraftToTikTok(token, { body, contentType: media.mime || "video/mp4" }),
    );

    const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
    await putEntity("clip", clipId, {
      ...fresh,
      distributions: upsertDistribution(fresh.distributions, "tiktok", {
        status: "published", tiktokPublishId: publishId, tiktokOpenId: openId,
        publishedAt: Date.now(), error: undefined,
      }),
    });
    console.log(`[worker] distribution.publish(tiktok) ${clipId} → 받은함 초안 ${publishId} (@${acct.username ?? acct.displayName})`);
  } catch (err) {
    if (err instanceof TikTokTokenRevokedError) {
      // 죽은 토큰을 함께 넘긴다 — 재연결이 이미 끝났으면 파킹이 no-op 이 된다.
      await markTikTokAccountDisconnected(openId, acct.refreshToken).catch(() => {});
      await markDistributionFailed(clipId, "tiktok", "TikTok 계정 재연결이 필요합니다 (토큰 만료/취소)", openId);
      console.error(`[worker] distribution.publish(tiktok) ${clipId}: token revoked — ${openId} parked`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await markDistributionFailed(clipId, "tiktok", message, openId);
    console.error(`[worker] distribution.publish(tiktok) ${clipId} failed:`, message);
  } finally {
    // Cloud Run /tmp = tmpfs(RAM). 성공·실패 무관하게 지운다 — 안 지우면 OOM.
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Instagram Reels 게시 (우리쪽 발사 · IG 비즈니스 로그인 토큰 · graph.instagram.com).
 * TikTok/YouTube 와 같은 뼈대: 게이트 재확인 → 킬스위치 → 계정 → 클립/미디어 → 게시.
 * 다른 점: IG 는 바이트가 아니라 **퍼블릭 video_url** 을 받으므로 GCS signed URL 을 넘긴다.
 * 예약은 잡을 그 시각까지 지연(publish-dispatch delayMs)시켜 맞춘다 — 여기서는 즉시 게시한다.
 * 멱등: distributions.instagram.igMediaId 가 있으면 이미 게시 → 스킵(수동 재시도 중복 방지).
 */
async function runInstagramPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const igUserId = String(job.payload.igUserId ?? "");
  if (!clipId || !igUserId) { console.error("[worker] distribution.publish(instagram): clipId/igUserId 누락 — 버림"); return; }

  const gate = await clipGate(clipId);
  if (!gate.allowed) {
    await markDistributionFailed(clipId, "instagram", gate.reason, igUserId).catch(() => {});
    await appendGateAudit({ subjectType: "clip", subjectId: clipId, action: "publish.blocked", fromState: gate.state, toState: "blocked", actor: "worker", basis: `업로드 직전 재확인 · ${gate.reason}` }).catch(() => {});
    return;
  }
  if (!instagramUploadEnabled()) {
    await markDistributionFailed(clipId, "instagram", INSTAGRAM_UPLOAD_DISABLED_MESSAGE, igUserId).catch(() => {});
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.publish(instagram): clip ${clipId} gone — dropping`); return; }
  // 멱등 — **이 계정으로** 이미 게시됐으면 다시 만들지 않는다(IG 는 되돌리기 번거롭다).
  // 채널 단독 매칭이면 다계정 규칙에서 두 번째 계정 잡이 첫 계정의 igMediaId 를 보고
  // 스킵돼 그 계정 행이 pending 으로 영구 방치된다 — upsertDistribution 의 채널+계정
  // 매칭과 같은 기준으로 본다.
  const existing = (clip.distributions ?? []).find(
    (d: any) => d.channel === "instagram" && (d.igUserId == null || d.igUserId === igUserId));
  if (existing?.igMediaId) { console.log(`[worker] distribution.publish(instagram) ${clipId}: 이미 게시(${existing.igMediaId}) — 스킵`); return; }

  const acct = (await listInstagramAccounts()).find((a) => a.igUserId === igUserId);
  if (!acct || acct.status === "disconnected" || !acct.accessToken) {
    await markDistributionFailed(clipId, "instagram", "Instagram 계정이 연결되지 않았거나 재연결이 필요합니다", igUserId);
    return;
  }
  // IG 토큰은 **60일짜리**다. 만료 전에 같은 토큰을 연장해야 하고, 넘기면 재연결뿐이다.
  // 연장을 아무 데서도 안 걸면 어느 날부터 IG 만 조용히 전건 실패한다(계정은 계속 'active'
  // 로 보인다) — 게시 직전이 확실한 시점이라 여기서 잇는다.
  const igExpiresAt = Number((acct as any).expiresAt ?? 0);
  if (igExpiresAt > 0 && igExpiresAt <= Date.now()) {
    await parkInstagramAccountExpired(igUserId).catch(() => {});
    await markDistributionFailed(clipId, "instagram",
      "Instagram 토큰이 만료됐습니다 — 배포채널에서 다시 연결해 주세요", igUserId);
    return;
  }
  if (igExpiresAt > 0 && igExpiresAt - Date.now() < 7 * 24 * 3600_000) {
    try {
      const next = await refreshInstagramToken(acct.accessToken);
      await updateInstagramToken(igUserId, next.accessToken, next.expiresAt);
      acct.accessToken = next.accessToken;
      console.log(`[worker] Instagram 토큰 연장 ${igUserId} → ${new Date(next.expiresAt).toISOString()}`);
    } catch (e) {
      // 연장 실패는 게시를 막을 이유가 아니다 — 아직 유효한 토큰이 손에 있다.
      console.warn(`[worker] Instagram 토큰 연장 실패(${igUserId}):`, e instanceof Error ? e.message : e);
    }
  }
  const mediaId = clip.mediaId;
  if (!mediaId) { await markDistributionFailed(clipId, "instagram", "클립이 아직 렌더되지 않았습니다 (익스포트 필요)", igUserId); return; }
  const media = await getMedia(mediaId);
  if (!media) { await markDistributionFailed(clipId, "instagram", "렌더된 영상 파일을 찾을 수 없습니다", igUserId); return; }
  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { await markDistributionFailed(clipId, "instagram", "스토리지에 영상 파일이 없습니다", igUserId); return; }

  let videoUrl: string;
  try {
    videoUrl = await signedReadUrl(objPath, 60 * 60 * 1000); // Meta 가 직접 fetch — 1h signed URL
  } catch {
    await markDistributionFailed(clipId, "instagram", "Instagram 게시는 GCS 모드가 필요합니다 (video_url 을 Meta 가 직접 받음)", igUserId);
    return;
  }

  const meta = metaForChannel(clip, "instagram");
  const { mediaId: igMediaId, permalink } = await publishInstagramReel({
    igUserId, accessToken: acct.accessToken, videoUrl,
    caption: [meta.title, meta.description].filter(Boolean).join("\n\n") || undefined,
  });

  // 게시 성공 즉시 igMediaId 기록 — permalink 는 이미 위에서 받았으므로 한 번의 write 로 충분.
  const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
  await putEntity("clip", clipId, {
    ...fresh,
    distributions: upsertDistribution(fresh.distributions, "instagram", {
      status: "published", externalId: igMediaId, igMediaId, igUserId,
      publishedAt: Date.now(), error: undefined,
      ...(permalink ? { permalink } : {}),
    }),
  });
  console.log(`[worker] distribution.publish(instagram) ${clipId} → IG reel ${igMediaId} (@${acct.username ?? igUserId})`);
}

/**
 * Facebook Reels 게시 (네이티브 예약 · Meta 페이지 토큰 · graph.facebook.com).
 * FB 는 예약을 API 가 잡으므로 잡은 즉시 돈다 — scheduleDate 를 scheduled_publish_time 으로 넘긴다.
 * 바이트 3-phase 업로드라 /tmp 로 내려받아 올린다(끝나면 삭제 · tmpfs OOM 방지).
 * 멱등: distributions.facebook.fbVideoId + published/scheduled 면 스킵(부분실패 후 재시도 중복 완화).
 */
async function runFacebookPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const pageId = String(job.payload.metaPageId ?? "");
  if (!clipId || !pageId) { console.error("[worker] distribution.publish(facebook): clipId/metaPageId 누락 — 버림"); return; }

  const gate = await clipGate(clipId);
  if (!gate.allowed) {
    await markDistributionFailed(clipId, "facebook", gate.reason, pageId).catch(() => {});
    await appendGateAudit({ subjectType: "clip", subjectId: clipId, action: "publish.blocked", fromState: gate.state, toState: "blocked", actor: "worker", basis: `업로드 직전 재확인 · ${gate.reason}` }).catch(() => {});
    return;
  }
  if (!facebookUploadEnabled()) {
    await markDistributionFailed(clipId, "facebook", FACEBOOK_UPLOAD_DISABLED_MESSAGE, pageId).catch(() => {});
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.publish(facebook): clip ${clipId} gone — dropping`); return; }
  // 계정 인지 멱등 — instagram 분기와 같은 이유(다계정에서 남의 게시를 내 것으로 오인 금지).
  const existing = (clip.distributions ?? []).find(
    (d: any) => d.channel === "facebook" && (d.metaPageId == null || d.metaPageId === pageId));
  if (existing?.fbVideoId && (existing.status === "published" || existing.status === "scheduled")) {
    console.log(`[worker] distribution.publish(facebook) ${clipId}: 이미 게시(${existing.fbVideoId}) — 스킵`); return;
  }

  const acct = await getMetaAccountByPageId(pageId);
  if (!acct || !acct.pageAccessToken) {
    await markDistributionFailed(clipId, "facebook", "Facebook 페이지가 연결되지 않았거나 재연결이 필요합니다", pageId);
    return;
  }
  const mediaId = clip.mediaId;
  if (!mediaId) { await markDistributionFailed(clipId, "facebook", "클립이 아직 렌더되지 않았습니다 (익스포트 필요)", pageId); return; }
  const media = await getMedia(mediaId);
  if (!media) { await markDistributionFailed(clipId, "facebook", "렌더된 영상 파일을 찾을 수 없습니다", pageId); return; }
  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { await markDistributionFailed(clipId, "facebook", "스토리지에 영상 파일이 없습니다", pageId); return; }

  // 예약 시각(epoch 초) — scheduleDate 가 미래일 때만 SCHEDULED, 아니면 즉시 공개.
  const rawDate = typeof job.payload.scheduleDate === "string" ? Date.parse(job.payload.scheduleDate) : NaN;
  const scheduledPublishSec = Number.isFinite(rawDate) && rawDate > Date.now() ? Math.floor(rawDate / 1000) : undefined;

  const tmpPath = path.join(os.tmpdir(), `stepd-fb-${clipId}-${Date.now()}.mp4`);
  try {
    await pipeline(createReadStream(objPath), fs.createWriteStream(tmpPath));
    const video = await fs.promises.readFile(tmpPath);
    const meta = metaForChannel(clip, "facebook");
    const { videoId, scheduled, permalink } = await publishFacebookReel({
      pageId, pageToken: acct.pageAccessToken, video,
      title: meta.title, description: meta.description, scheduledPublishSec,
    });
    const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
    await putEntity("clip", clipId, {
      ...fresh,
      distributions: upsertDistribution(fresh.distributions, "facebook", {
        status: scheduled ? "scheduled" : "published", externalId: videoId, fbVideoId: videoId, metaPageId: pageId,
        publishedAt: Date.now(), error: undefined,
        ...(scheduled && job.payload.scheduleDate ? { reserveDate: String(job.payload.scheduleDate) } : {}),
        ...(permalink ? { permalink } : {}),
      }),
    });
    console.log(`[worker] distribution.publish(facebook) ${clipId} → FB reel ${videoId} (${scheduled ? "scheduled" : "published"} · ${acct.pageName ?? pageId})`);
  } finally {
    // Cloud Run /tmp = tmpfs(RAM). 성공·실패 무관하게 지운다.
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}

async function runDistributionPublish(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const channelId = String(job.payload.channelId ?? "");
  if (!clipId || !channelId) {
    console.error("[worker] distribution.publish: clipId/channelId 누락 — 버림");
    return;
  }

  // 게이트 (강제 지점 · 마지막 방어선). 큐에 앉아 있는 동안 권리 이슈가 새로 등록될 수 있다.
  // 관문에서 통과했더라도 **올리기 직전에 다시 본다** — 통과 시점과 업로드 시점 사이가
  // 몇 분에서 몇 시간까지 벌어지기 때문이다.
  const gate = await clipGate(clipId);
  if (!gate.allowed) {
    console.warn(`[worker] distribution.publish ${clipId}: 게이트 미통과 — ${gate.reason}`);
    await markDistributionFailed(clipId, "youtube", gate.reason, channelId).catch(() => {});
    await appendGateAudit({
      subjectType: "clip", subjectId: clipId, action: "publish.blocked",
      fromState: gate.state, toState: "blocked", actor: "worker",
      basis: `업로드 직전 재확인 · ${gate.reason}`,
    }).catch(() => {});
    return;
  }

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
    await markDistributionFailed(clipId, "youtube", UPLOAD_DISABLED_MESSAGE, channelId).catch(() => {});
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.publish: clip ${clipId} gone — dropping`); return; }

  // The deliverable is the single render (plan §2.4); without it there is nothing to ship.
  const mediaId = clip.mediaId;
  if (!mediaId) { await markDistributionFailed(clipId, "youtube", "클립이 아직 렌더되지 않았습니다 (익스포트 필요)", channelId); return; }
  const media = await getMedia(mediaId);
  if (!media) { await markDistributionFailed(clipId, "youtube", "렌더된 영상 파일을 찾을 수 없습니다", channelId); return; }

  const ch = await loadActiveChannel(channelId);
  if (!ch) { await markDistributionFailed(clipId, "youtube", "업로드할 YouTube 채널이 연결되지 않았거나 재연결이 필요합니다", channelId); return; }

  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { await markDistributionFailed(clipId, "youtube", "스토리지에 영상 파일이 없습니다", channelId); return; }

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
          ...metaForChannel(clip, "youtube"),
          privacyStatus: privacy,
          publishAt,
        },
      ),
    );

    // 커스텀 썸네일 — **롱폼 클립에는 사실상 필수다**(쇼츠는 유튜브가 프레임을 쓴다).
    // 업로드는 이미 끝났으므로 여기서 실패해도 배포를 실패로 돌리지 않는다. 사유만 남긴다.
    try {
      const thumb = await resolveClipThumbnail(clip);
      if (thumb) {
        await withChannelToken(ch, (token) => setVideoThumbnail(token, videoId, thumb));
        console.log(`[worker] youtube 썸네일 설정 ${clipId} → ${videoId} (${thumb.source})`);
      } else {
        console.warn(`[worker] youtube 썸네일 없음 ${clipId} — 유튜브 자동 프레임으로 나간다`);
      }
    } catch (e) {
      console.warn(`[worker] youtube 썸네일 설정 실패 ${clipId}:`,
        e instanceof Error ? e.message.slice(0, 200) : e);
    }

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
      await markDistributionFailed(clipId, "youtube", "YouTube 채널 재연결이 필요합니다 (토큰 만료/취소)", channelId);
      console.error(`[worker] distribution.publish ${clipId}: token revoked — channel ${channelId} parked`);
      return;
    }
    const message = String(err?.message ?? err);
    await markDistributionFailed(clipId, "youtube", message, channelId);
    console.error(`[worker] distribution.publish ${clipId} failed:`, message);
  }
}

/** Enqueue every live channel. Dedupe keeps a slow channel from stacking up jobs. */
async function sweepDueChannels(): Promise<void> {
  // 스윕은 전 테넌트를 훑지만(listChannelsForSweep 이 시스템 스코프), **잡은 채널 소유자의
  // 테넌트로 만든다** — 시스템 스코프인 채로 enqueue 하면 무소속 잡이 되어 FK 에서 죽는다.
  const channels = await listChannelsForSweep();
  let queued = 0;

  for (const ch of channels) {
    if (ch.status === "revoked") continue;
    const id = await runWithTenant({ scope: ch.tenantId, via: "system" }, () =>
      enqueue("channel.analyze", { channelId: ch.channelId }, {
        dedupeKey: `channel.analyze:${ch.channelId}`,
      }),
    );
    if (id) queued++;
  }

  if (queued) console.log(`[worker] sweep queued ${queued}/${channels.length} channels`);
}

/**
 * 순방 주기. 기본 10분 — 회차 하나가 분석되는 데 수십 분이 걸리므로 더 자주 돌 이유가 없고,
 * 매 순방이 규칙 수만큼 DB 를 훑는다. 0 이면 워커가 순방을 만들지 않는다
 * (Cloud Scheduler 로만 돌리고 싶을 때).
 */
const CYCLE_EVERY_MS = Number(process.env.AUTOMATION_CYCLE_MS ?? 10 * 60 * 1000);

async function loop(): Promise<void> {
  const startedAt = Date.now();
  let drained = 0;
  let lastFanOut = 0;
  while (!stopping) {
    // 순방 팬아웃 — 테넌트마다 잡을 하나씩 넣는다. dedupeKey 로 겹쳐 쌓이지 않는다.
    // drain 모드에서는 만들지 않는다: 큐를 비우고 끝나야 하는데 스스로 일을 늘리면 안 끝난다.
    // 순방 잡은 youtube 레인이 집는다 — 그 레인을 안 도는 워커가 만들면 아무도 안 집는다.
    if (RUNS_SWEEP && !DRAIN_MODE && CYCLE_EVERY_MS > 0 && Date.now() - lastFanOut > CYCLE_EVERY_MS) {
      lastFanOut = Date.now();
      try {
        const n = await fanOutAutomationCycles();
        if (n > 0) console.log(`[worker] 자동 배포 순방 ${n}개 테넌트 큐잉`);
      } catch (err) {
        console.error("[worker] 순방 팬아웃 실패(다음 주기에 재시도)", err);
      }
    }
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

    // 잡은 시스템 스코프로 집었지만(누구 것인지 모른 채 집으므로), **실행은 그 잡의 테넌트로**
    // 한다. 이 안에서 일어나는 모든 DB 접근·타이머(heartbeat)·자식 프로세스 콜백이 같은
    // 컨텍스트를 물려받아, 핸들러가 남의 테넌트 데이터를 건드릴 방법이 없어진다.
    await runWithTenant({ scope: job.tenantId || DEFAULT_TENANT_ID, via: "job" }, () => runJob(job!));
  }
}

async function runJob(job: Job): Promise<void> {
  {
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
        return;   // (루프에서 runJob 으로 분리되며 continue → return)
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

  // YouTube OAuth 자격증명은 **그걸 쓰는 레인에서만** 필요하다.
  // 네이버·GEBD·download 워커는 YouTube API 를 건드리지 않는데(다운로드는 yt-dlp 뿐,
  // OAuth 무관), 여기서 막으면 그 머신에 쓰지도 않을 시크릿을 넣어야 워커가 뜬다
  // (2026-08-12 윈도우2 실측 · 2026-08-14 naver,download 조합에서 재발 — 워커가 부팅
  // 즉시 죽는데 작업 스케줄러는 Running 으로 보여 원인이 안 보였다).
  const YT_FREE = new Set(["naver", "gebd", "download", "naver,download", "download,naver"]);
  const NEEDS_YT = !YT_FREE.has(WORKER_JOBS);
  if (NEEDS_YT && (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)) {
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

  // 부팅 로그의 큐 요약은 운영 지표라 전 테넌트 합계로 본다.
  console.log("[worker] queue:", JSON.stringify(await runAsSystem(queueStats)));

  if (RUNS_SWEEP) await sweepDueChannels();

  // ── 자동 배포 순방 (drain) ──────────────────────────────────────────────────
  // drain 워커는 Scheduler 가 주기적으로 깨운다. 그때 자동 배포 순방을 **한 번** 팬아웃한다
  // (반복 아님 — 한 번이라 큐는 여전히 비고 종료된다). 이게 **프로덕션의 자동 배포 주기**다:
  // 예전엔 loop() 의 10분 타이머가 순방을 돌렸는데 그건 `!DRAIN_MODE` 라 프로덕션(drain)에선
  // 아무도 순방을 안 돌려 "규칙을 만들어도 저절로 안 나감" 이었다. AUTOMATION_CYCLE_MS=0 이면
  // 자동 순방을 끈다(수동 "지금 실행"만).
  if (RUNS_SWEEP && DRAIN_MODE && CYCLE_EVERY_MS > 0) {
    try {
      const n = await fanOutAutomationCycles();
      if (n > 0) console.log(`[worker] drain 기동 자동 배포 순방 팬아웃 — ${n}개 테넌트`);
    } catch (err) {
      console.error("[worker] drain 순방 팬아웃 실패(다음 기동에 재시도)", err);
    }
  }

  // 상시(비-drain) 모드는 Scheduler 가 없으므로 내부 타이머가 순방·정리를 돌린다.
  // (drain 에 setInterval 을 걸면 Node 이벤트 루프가 살아 있어 잡을 다 처리하고도 안 끝난다.)
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
  // naver 레인은 로컬 작업 폴더에 mp4 를 내려받는다. 잡이 중간에 죽으면 파일이 남으므로
  // 기동 시 한 번 훑는다(3일 지난 것). 다른 레인은 이 폴더를 안 쓴다.
  if (WORKER_JOBS === "naver") {
    const swept = sweepStaleWorkFiles();
    if (swept) console.log(`[worker] naver 작업폴더 정리 — 오래된 mp4 ${swept}개 삭제`);
  }

  await loop();
  console.log("[worker] stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

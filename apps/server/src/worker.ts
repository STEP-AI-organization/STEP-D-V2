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
  addCreditEntry,
  getEntity,
  listEntities,
  putEntity,
  getMedia,
  updateMediaSource,
  updateMediaPath,
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
import { checkCredits } from "./billing/credits.ts";
import { topupAndRecheck } from "./billing/auto-topup.ts";
import { billableMinutes } from "./billing/billing.ts";
import { probe, captureThumbnail, remuxFaststart, needsMp4Normalize, normalizedMp4Path, normalizeToMp4, extractSourceCaptions, transcodeToH264 } from "./media/ffmpeg.ts";
import {
  prepareProgramAssets, publishStyleProfile, publishThumbnails, tempAssetRoot, pullPrefix,
} from "./media/thumbnail-assets.ts";
import { uploadFile, uploadPath, thumbPath, promoteUpload } from "./media/storage-gcs.ts";
import { initQueue, claimJob, completeJob, failJob, requeueStale, heartbeatJob, enqueue, lastDoneJobAt, pruneDoneJobs, queueStats, type Job, type JobType } from "./queue.ts";
import { runWithTenant, runAsSystem, DEFAULT_TENANT_ID } from "./tenant.ts";
import { recordAutoPublishForReport, recordAutoPublishFailureForReport } from "./publish-notify.ts";
import { runAutomationCycle } from "./automation-cycle.ts";
import { runChannelPipeline, shouldSweepChannel } from "./channel-pipeline.ts";
import { runClipReframe, runContentAnalyze, runReframeCompare, newestMtimeMs } from "./content-pipeline.ts";
import {
  withAccessToken,
  fetchVideoAnalytics,
  fetchVideosBatch,
  fetchVideoComments,
  uploadVideoResumable,
  setVideoThumbnail,
  updateVideoPrivacy,
  updateVideoMetadata,
  getVideoCategoryId,
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
import {
  createReadStream, parseObjectPath, fileExists, fileSize, signedReadUrl, readFile, listPrefix,
} from "./media/storage-gcs.ts";
import { pipeline } from "node:stream/promises";
import {
  youtubeUploadEnabled, UPLOAD_DISABLED_MESSAGE,
  tiktokUploadEnabled, tiktokDirectPostEnabled, TIKTOK_UPLOAD_DISABLED_MESSAGE,
  instagramUploadEnabled, INSTAGRAM_UPLOAD_DISABLED_MESSAGE,
  facebookUploadEnabled, FACEBOOK_UPLOAD_DISABLED_MESSAGE,
} from "./upload-gate.ts";
import { withTikTokToken, uploadDraftToTikTok, uploadDirectPostToTikTok, TikTokTokenRevokedError } from "./social/tiktok.ts";
import {
  getTikTokAccountByOpenId, updateTikTokTokens, markTikTokAccountDisconnected, appendRuleRun,
} from "./db-pg.ts";
import { publishInstagramReel, refreshInstagramToken } from "./social/instagram.ts";
import { publishFacebookReel } from "./social/facebook.ts";
import {
  listInstagramAccounts, getMetaAccountByPageId, updateInstagramToken, parkInstagramAccountExpired,
} from "./db-pg.ts";
import { naverUploadEnabled, NAVER_DISABLED_MESSAGE } from "./naver/naver-gate.ts";
import { hasNaverSession, materializeNaverSession, saveNaverSession } from "./naver/naver-session.ts";
import {
  getNaverAccount, markNaverAccount, getNaverSessionBlob, setNaverSessionBlob,
  getNaverCredentialBlob, markNaverCredential,
} from "./db-pg.ts";
import { openSession, sealSession } from "./naver/naver-session-store.ts";
import { uploadToNaver, loginWithCredentials, NaverSessionExpiredError, NAVER_TARGETS, type NaverTarget } from "./naver/naver-tv.ts";
import { resolveCategory, categoryForGenre } from "./naver/naver-categories.ts";
import { openCredential } from "./naver/naver-cred-store.ts";
import { prepareWorkPath, cleanupWorkFile, sweepStaleWorkFiles } from "./naver/naver-workdir.ts";
import { upsertDistribution } from "./publish-guard.ts";
import { commerceLinksEnabled, usableLinks, withCommerceLinks, type ProductCandidate } from "./commerce/commerce.ts";
import {
  issueCoupangLinks, issueLinkForCandidate, PartnersSessionExpiredError,
} from "./commerce/coupang-partners.ts";
import { openCommerceSession, sealCommerceSession } from "./commerce/commerce-session-store.ts";
import {
  getCommerceAccount, getCommerceSessionBlob, markCommerceIssued,
  markCommerceSessionExpired, setCommerceSessionBlob,
} from "./db-pg.ts";
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
const JOB_LANES: Record<"content" | "youtube" | "gebd" | "naver" | "download" | "commerce" | "render", JobType[]> = {
  // match.align도 content 레인 — 파이썬·ffmpeg로 오디오를 돌리는 무거운 잡이라
  // YouTube API 레인(짧고 쿼터 위주)에 섞으면 그쪽을 막는다.
  // thumbnail.* 도 content 레인. 성격이 같다 — core/thumbnail 파이썬을 스폰하고 이미지 생성
  // API 를 부르는 무거운 잡이다.
  // ⚠️ 2026-08-12 이전에는 이 둘이 **어느 레인에도 없고** ALL_LANE_TYPES 에만 있었다.
  //    그런데 프로덕션에 뜨는 워커는 WORKER_JOBS=content 와 =youtube 뿐이라(all 워커 없음)
  //    큐잉은 되는데 **아무도 claim 하지 않아 영원히 pending** 이었다. 라우트는 {jobId} 로
  //    성공을 돌려주므로 화면에서는 "생성 중" 으로만 보인다 — 이 리포의 전형적 조용한 실패다.
  //    아래 "모든 JobType 은 실제로 도는 레인에 속한다" 테스트가 재발을 막는다.
  // media.transcode 도 content 레인 (2026-09-01 이동 · 원래 render 레인이었다).
  // 이유는 **돈**이다: 이 잡은 GCS 에서 원본을 받아 다시 올린다. 사무실 PC(render 레인)로
  // 보내면 인터넷 egress 가 붙어(≈₩165/GB) 회차당 ₩45 인데, 같은 리전 Cloud Run 은
  // egress 0 원이고 컴퓨트만 ≈₩14 다. **CPU 가 공짜라도 바이트는 공짜가 아니다.**
  content: ["media.transcode", "media.prepare", "content.analyze", "match.align", "match.segment", "match.learn",
            "thumbnail.style", "thumbnail.generate", "clip.metadata", "clip.reframe",
            // 세로 4택 비교 — clip.reframe 와 같은 성격(프록시 ffmpeg + 파이썬 비전).
            "reframe.compare"],
  // factory.* 도 youtube 레인 — 상태기계 한 걸음은 DB 몇 번 읽고 재큐하는 게 전부라
  // 짧고, 배포(distribution.publish)와 같은 레인에 있어야 순서가 자연스럽다.
  // automation.cycle 도 youtube 레인 — 순방 한 바퀴는 DB 를 훑고 dispatchPublish 를 부르는
  // 게 전부라 짧고, 그 결과가 distribution.publish 로 이어지므로 같은 레인이 자연스럽다.
  youtube: ["channel.analyze", "video.analyze", "video.hotwatch", "video.comments",
            "distribution.publish", "distribution.updatemeta", "factory.orchestrate",
            "factory.publicize", "automation.cycle", "youtube.reconcile"],
  // naver 는 **사무실 상시 PC 전용 lane**. 네이버는 공개 업로드 API 가 없어 브라우저
  // 자동화가 유일한데, 해외 데이터센터 IP(Cloud Run) 로 로그인하면 캡차·2차인증에 막힌다.
  // 그래서 한국 가정/사무실 IP 의 놀고 있는 PC 한 대에서만 이 레인을 돌린다.
  // 세션(storageState)도 그 PC 로컬에만 둔다 — 쿠키를 클라우드로 올리지 않는다.
  // naver.login 도 여기 — 로그인 폼은 자동화 탐지가 제일 센 자리라 한국 IP + 창 있는
  // 브라우저가 필요하다(발행과 같은 조건).
  naver: ["naver.publish", "naver.login"],
  // download 도 **사무실 PC 전용 lane** (naver 와 같은 머신, 윈도우2). 유튜브가 데이터센터
  // IP(Cloud Run)를 봇으로 판정해 다운로드가 상시 실패한다(2026-08-14 실측: 쿠키를 물려도
  // "Sign in to confirm you're not a bot"). 한국 가정/사무실 IP 에서만 안정적으로 받아지므로
  // 다운로드는 윈도우2가 받고 GCS 에 올린 뒤, 분석(content.analyze)은 클라우드가 잇는다.
  download: ["youtube.download"],
  // gebd 는 GPU T4 spot VM 전용 lane. content lane 이 이 잡을 claim 하면 GPU 없는 곳에서
  // Docker mmaction2 를 못 돌린다. 그래서 별도 프로세스 (WORKER_JOBS=gebd) 로만 픽업.
  gebd: ["gebd.detect"],
  // commerce 도 **머신 전용 lane** — naver 와 같은 이유다. 쿠팡파트너스는 최종승인 전까지
  // 공개 API 가 없어 로그인된 콘솔을 브라우저로 몰아야 하는데, 그 세션은 특정 PC 의 크롬
  // 프로필에만 산다(쿠키를 클라우드로 올리지 않는다 — 고객사 자격증명을 우리가 보관하지
  // 않는다는 원칙). 승인 후 공식 딥링크 API 로 바뀌면 이 레인은 없어지고 클라우드로 간다.
  commerce: ["commerce.link"],
  // render 도 **머신 전용 lane** — 다만 이유가 다르다. 한국 IP 나 브라우저가 아니라 **CPU** 다.
  // 렌더는 건당 50~90초로 이 리포에서 CPU 를 통째로 쓰는 유일한 일이고, 그래서 순방이
  // AUTOMATION_MAX_RENDERS_PER_TICK 으로 스스로를 묶는다. 노는 사무실 PC(8코어)가 당겨가면
  // 그 상한이 풀린다. ⚠️ 이 레인이 안 도는 동안 잡이 쌓이면 **순방이 직접 렌더한다**
  // (automation-cycle 의 정체 감지) — 사무실 PC 가 꺼져 있다고 고객 배포가 멈추면 안 된다.
  render: ["clip.render"],
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
/**
 * `WORKER_JOBS` 를 **레인 이름 목록**으로 읽는다 — `"naver,download,commerce"` 처럼 조합을
 * 그대로 받는다.
 *
 * ⚠️ 예전에는 조합마다 정확한 문자열을 하나씩 비교했다(`"naver,download"` · `"download,naver"`).
 *    레인이 늘 때마다 경우의 수가 곱으로 늘고, **빠뜨린 조합은 조용히 `all` 로 떨어져** 그 PC 가
 *    남의 레인 잡까지 집어간다. 실제로 그 방식 때문에 사무실 PC 가 자동배포 순방까지 돌린 적이
 *    있다. 그래서 목록 파싱으로 바꾸고, **모르는 이름은 조용히 넘기지 않고 던진다** —
 *    오타가 all 워커로 둔갑하는 게 이 자리의 유일한 위험한 실패다.
 */
const KNOWN_LANES = Object.keys(JOB_LANES) as (keyof typeof JOB_LANES)[];
const REQUESTED_LANES = WORKER_JOBS.split(",").map((s) => s.trim()).filter(Boolean);
if (WORKER_JOBS !== "all") {
  const unknown = REQUESTED_LANES.filter((l) => !KNOWN_LANES.includes(l as any));
  if (unknown.length > 0) {
    throw new Error(
      `WORKER_JOBS 에 알 수 없는 레인: ${unknown.join(", ")} — 쓸 수 있는 값: ${KNOWN_LANES.join(" · ")} 또는 all. ` +
      "오타를 조용히 all 로 처리하지 않는다(그러면 이 워커가 남의 레인 잡을 집어 실패시킨다).",
    );
  }
}
const SELECTED_LANES = REQUESTED_LANES.filter((l): l is keyof typeof JOB_LANES =>
  KNOWN_LANES.includes(l as any));
// "all" 은 **머신 전용 레인을 빼고** 전부 집는다. gebd 는 GPU 가, naver·commerce 는 한국 IP·
// 로그인 세션이 있는 PC 가 필요해서, 아무 워커나 집으면 100% 실패한다.
// (실측 2026-08-11: all 워커가 naver.publish 를 집어가 재시도만 쌓았다.)
const CLAIM_TYPES: JobType[] = SELECTED_LANES.length > 0
  ? [...new Set(SELECTED_LANES.flatMap((l) => JOB_LANES[l]))]
  : ALL_LANE_TYPES;

/**
 * 채널 sweep 은 YouTube 잡을 큐잉하므로 **youtube 레인을 맡은 워커만** 돌린다.
 * 머신 전용 워커(사무실 PC 등)가 같이 돌리면 자동배포 주기가 그 PC 가동 여부에 좌우된다.
 * 레인 목록으로 판정하므로 조합이 늘어도 자동으로 맞는다(예전엔 조합 문자열을 빠뜨려 샜다).
 */
const RUNS_SWEEP = SELECTED_LANES.length === 0 || SELECTED_LANES.includes("youtube");

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
    case "clip.render": return handleClipRender(job);
    case "media.transcode": return handleMediaTranscode(job);
    case "distribution.updatemeta": return handleDistributionUpdateMeta(job);
    case "naver.publish": return handleNaverPublish(job);
    case "naver.login": { await handleNaverLogin(job); return; }
    case "media.prepare": return handleMediaPrepare(job);
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
    case "reframe.compare": {
      await runReframeCompare({
        clipId: String(job.payload.clipId ?? ""),
        compareId: String(job.payload.compareId ?? ""),
      });
      return;
    }
    case "youtube.download": return handleYoutubeDownload(job);
    case "match.align": return handleMatchAlign(job);
    case "match.segment": return handleMatchSegment(job);
    case "match.learn": return handleMatchLearn(job);
    case "gebd.detect": return handleGebdDetect(job);
    case "automation.cycle": return handleAutomationCycle(job);
    case "youtube.reconcile": return handleYoutubeReconcile(job);
    case "factory.orchestrate": return handleFactoryOrchestrate(job);
    case "factory.publicize": return handleFactoryPublicize(job);
    case "clip.metadata": return handleClipMetadata(job);
    case "commerce.link": return handleCommerceLink(job);
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

  // ⚠️ **채널이 "not due" 면 팬아웃도 건너뛴다.** 예전엔 skip 결과와 무관하게 무조건 돌아서,
  // 아무것도 안 한 실행에서도 채널의 전 업로드를 훑고 영상마다 DB 를 왕복했다 — 실측
  // (2026-08-31) 하루 ~26만 쿼리. 스윕이 15분마다 깨우는데 채널 신선도 간격은 6시간이라,
  // 96회 중 92회가 그 헛일이었다.
  //
  // 팬아웃 주기가 15분 → 최대 6시간(VIDEO_SYNC_INTERVAL_MS)이 되지만, 영상 잡 자체의 간격은
  // 24시간·7일이라 여전히 4배 촘촘하다 — 기능 손실 없음.
  // ⚠️ 다만 **6시간이 팬아웃의 상한**이 된다: config 의 영상 잡 간격을 6시간 밑으로 내리면
  // 그 값이 조용히 안 지켜진다(config.ts 상수 옆에도 같은 경고를 적어 뒀다).
  if (result.skipped === "not due") return;

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
// player_client 오버라이드. **기본은 오버라이드 없음(빈 값)** — yt-dlp 가 알아서 고르게 둔다.
//
// 이력: 2026-08-18 에 기본 client 의 미디어 데이터가 403 이라 `web_safari` 를 강제했는데,
// 2026-08-19 재측정에서 **그 우회가 오히려 원인**이 됐다. 같은 URL 로 로컬(한국 IP) 실측:
//   yt-dlp 2026.07.04(stable 최신) + 기본 client → 미디어 403        ← 옛 증상 재현
//   yt-dlp 2026.07.04            + web_safari   → No video formats found
//   yt-dlp 2026.08.18(nightly)   + web_safari   → No video formats found  ← 이게 지금 실패
//   yt-dlp 2026.08.18(nightly)   + 기본 client  → **정상 다운로드**
// 즉 진짜 변수는 client 가 아니라 **yt-dlp 버전**이었다. web_safari·mweb·tv_simply 는 이제
// GVS PO 토큰을 요구해 포맷이 통째로 비어 나온다. 그래서 강제를 걷고, 대신 워커 PC 가
// yt-dlp 를 매 회차 nightly 로 자가 갱신한다(deploy/naver-pc/self-update.ps1).
//   ⚠️ stable 채널은 이 문제에 못 쓴다 — 최신 stable 이 2026.07.04 로 6주 묵어 403 이 난다.
// 다시 특정 client 가 필요해지면 env(YTDLP_PLAYER_CLIENT)로 코드 변경 없이 되돌린다.
const YTDLP_PLAYER_CLIENT = process.env.YTDLP_PLAYER_CLIENT ?? "";

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

// ── media.prepare — regional staging → primary bucket → probe/thumb → analysis ─────
//
// The browser uploads straight to a Seoul GCS bucket. /media/finalize only creates the
// placeholder rows and enqueues this job, so its HTTP response is not held open by a
// cross-region copy or ffprobe. This worker promotes the object over Google's backbone,
// reads just the ranges needed for metadata/thumbnail, then starts content.analyze.
async function handleMediaPrepare(job: Job): Promise<void> {
  const mediaId = String(job.payload.mediaId ?? "");
  if (!mediaId) throw new Error("media.prepare requires mediaId");

  const media = await getMedia(mediaId);
  if (!media) {
    console.warn(`[worker] media.prepare: media ${mediaId} gone — dropping job`);
    return;
  }
  const objectPath = parseObjectPath(media.path);
  const fast = Boolean(job.payload.fast);

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

  try {
    await setEpisodeNote("서울 업로드 완료 · 분석 저장소로 이동 중…", "progress", 10);
    const storedPath = await promoteUpload(objectPath);
    // ⚠️ **바이트를 옮겼으면 DB 도 즉시 그 사실을 알아야 한다** (2026-08-26 감사).
    // promoteUpload 는 객체를 운영 버킷으로 옮기는데, 아래 remux·probe 중 하나라도 죽으면
    // updateMediaSource 까지 못 가서 DB 는 **옛 업로드 경로 + durationSec=0** 인 채로 남는다.
    // 그런데 다운로드는 항상 운영 버킷을 읽으므로(storage-gcs parseObjectPath/createReadStream)
    // 분석은 그 파일을 잘 받아 간다 — "길이는 0 인데 파일은 있는" 상태가 굳고, 크레딧 게이트도
    // 차감도 0 이라 공짜 분석이 반복된다. 경로만 먼저 박아 그 어긋남을 없앤다(targeted write).
    await updateMediaPath(mediaId, storedPath).catch((e: unknown) =>
      console.warn(`[worker] media.prepare ${mediaId}: 경로 기록 실패:`, e instanceof Error ? e.message : e));
    const workDir = path.join(os.tmpdir(), "stepd-media-prepare", mediaId);
    fs.mkdirSync(workDir, { recursive: true });

    // Preserve the old finalize behaviour, but do it off-request. Small fragmented MP4s
    // become progressive/fast-start files; long masters skip this disk-heavy step and go
    // straight to range-based probing. The size is storage-authoritative, never client data.
    let size = await fileSize(objectPath);
    let readUrl = await signedReadUrl(objectPath);
    let storedMediaPath = storedPath;
    let mediaMime = media.mime || "video/mp4";

    // ── 1) 원본을 먼저 재본다 — 무엇을 해야 할지는 프로브 결과가 정한다.
    let meta = await probe(readUrl);
    if (!(meta.durationSec > 0)) throw new Error(`probe returned duration ${meta.durationSec}`);

    // ── 2) 웹·파이프라인 공용 mp4 로 정규화 (MXF 등) ────────────────────────────
    // 사용자 결정 2026-08-27: "웹에서는 오로지 MXF 를 mp4 로 전환 후 다룬다."
    // 원본은 **지우지 않는다**(방송사 소재) — 같은 폴더에 `.mp4` 를 새로 올리고 DB 만 그쪽을
    // 가리키게 한다. 그래서 이후 모든 단계(브라우저 재생·core 분석·렌더)가 mp4 하나만 본다.
    // 입력은 서명 URL 이다 — 20~50GB 를 /tmp(=RAM) 에 내려받으면 그 자체로 OOM 이다.
    const normalize = needsMp4Normalize(meta);
    // 정규화하면 meta·readUrl 이 **변환본**을 가리키게 된다 — 자막·인벤토리는 원본에서
    // 건져야 하므로 그 전에 붙잡아 둔다.
    const srcMeta = meta;
    const srcReadUrl = readUrl;
    if (normalize.needed) {
      const mp4Tmp = path.join(workDir, "normalized.mp4");
      // 원본과 같은 경로가 나오면 안 된다 — 규칙은 ffmpeg.ts `normalizedMp4Path` 에 있다.
      const mp4ObjectPath = normalizedMp4Path(objectPath);
      await setEpisodeNote(`원본을 mp4 로 변환 중… (${normalize.reasons.join(" · ")})`, "progress", 15);
      console.log(`[worker] media.prepare ${mediaId}: mp4 정규화 시작 — ${normalize.reasons.join(" · ")}`);
      const t0 = Date.now();
      await normalizeToMp4(readUrl, mp4Tmp, { probe: meta });
      storedMediaPath = await uploadFile(mp4ObjectPath, mp4Tmp);
      size = fs.statSync(mp4Tmp).size;
      mediaMime = "video/mp4";
      readUrl = await signedReadUrl(mp4ObjectPath);
      // 변환본 기준으로 메타를 다시 잡는다 — 이후 계산(길이·해상도·fps)은 전부 이 파일 것이다.
      meta = await probe(readUrl);
      if (!(meta.durationSec > 0)) throw new Error(`normalized probe returned duration ${meta.durationSec}`);
      fs.rmSync(mp4Tmp, { force: true });
      console.log(`[worker] media.prepare ${mediaId}: mp4 정규화 완료 `
        + `(${Math.round(size / 1e6)}MB · ${Math.round((Date.now() - t0) / 1000)}s · 원본 보존 ${objectPath})`);

      // ── 원본 부가 데이터 인벤토리 ────────────────────────────────────────────
      // MXF 는 "굽기 전 재료" 라 자막·대사 트랙이 따로 들어 있다(사용자 2026-08-27).
      // 무엇이 들어 있었는지 **로그로 남긴다** — 방송사마다 자막 자리·트랙 배치가 달라서,
      // 첫 실파일 로그를 보고 STT 대체·트랙 선택을 정한다(추측으로 배선하지 않는다).
      const inv = srcMeta.sourceStreams
        .map((st) => `${st.index}:${st.type}/${st.codec}`
          + (st.channels ? `(${st.channels}ch)` : "")
          + (st.title || st.language ? `[${st.title ?? st.language}]` : ""))
        .join(" · ");
      console.log(`[worker] media.prepare ${mediaId}: 원본 스트림 — ${inv}`);

      // 자막이 있으면 건져 둔다. **있으면 쓰고 없으면 STT** — 실패는 조용히 넘긴다.
      try {
        const srtTmp = path.join(workDir, "source-captions.srt");
        const cap = await extractSourceCaptions(srcReadUrl, srtTmp, srcMeta);
        if (cap) {
          await uploadFile(`analysis/${mediaId}/source-captions.srt`, cap.path);
          console.log(`[worker] media.prepare ${mediaId}: 원본 자막 ${cap.cues}줄 확보 `
            + `(${cap.source === "stream" ? "자막 트랙" : "영상 임베드 CEA-608"}) — STT 대체 후보`);
          fs.rmSync(cap.path, { force: true });
        } else {
          console.log(`[worker] media.prepare ${mediaId}: 원본 자막 없음 — STT 로 진행`);
        }
      } catch (e) {
        console.warn(`[worker] media.prepare ${mediaId}: 자막 추출 건너뜀 —`,
          e instanceof Error ? e.message.slice(0, 120) : e);
      }
    } else {
      // 이미 mp4/h264/aac — 종전 경로 그대로(작은 파일만 faststart 리먹스).
      const remuxMax = (Number(process.env.REMUX_MAX_MB) || 512) * 1024 * 1024;
      if (size > 0 && size <= remuxMax) {
        const webTmp = path.join(workDir, "web.mp4");
        try {
          await remuxFaststart(readUrl, webTmp);
          await uploadFile(objectPath, webTmp);
          size = fs.statSync(webTmp).size;
          readUrl = await signedReadUrl(objectPath);
          meta = await probe(readUrl);
          console.log(`[worker] media.prepare ${mediaId}: remuxed progressive (${size} bytes)`);
        } catch (err) {
          console.error(`[worker] media.prepare ${mediaId}: remux failed, keeping original`, err);
        }
      }
    }

    let thumbStored: string | null = null;
    try {
      const thumbTmp = path.join(workDir, "thumb.jpg");
      await captureThumbnail(readUrl, Math.max(1, meta.durationSec * 0.1), thumbTmp);
      thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
    } catch (err) {
      // Thumbnail is helpful, not a gate for analysis.
      console.error(`[worker] media.prepare ${mediaId}: thumbnail failed`, err);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    await updateMediaSource(mediaId, {
      // 정규화했으면 **변환본 경로**가 정본이다 — 이후 분석·재생·렌더가 전부 이걸 읽는다.
      path: storedMediaPath,
      mime: mediaMime,
      size,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      codec: meta.codec,
      hasAudio: meta.hasAudio ? 1 : 0,
      thumbPath: thumbStored,
      // 프레임 정합 메타(0046) — Premiere 플러그인이 추천 구간을 1프레임 오차로 꽂는 근거.
      // **정규화 후 값**을 저장한다(편집·재생·렌더가 전부 그 파일을 보므로 그게 정본이다).
      fps: meta.fps,
      startTimecode: meta.startTimecode,
      audioStreams: meta.audioStreams,
    });

    let verdict = checkCredits({
      balance: await creditBalance(),
      needMinutes: billableMinutes(meta.durationSec),
    });
    if (!verdict.allow) {
      // 부족 → 저장 카드 자동 충전 시도 후 재판정 (라우트 402 게이트와 같은 방향 · ENA 스펙).
      verdict = (await topupAndRecheck(billableMinutes(meta.durationSec))) ?? verdict;
    }
    if (!verdict.allow) {
      await setEpisodeNote(`크레딧 부족 — 충전 후 분석을 시작해 주세요 (${verdict.reason})`, "idle", 0);
      return;
    }

    await markContentAnalysisPending(mediaId);
    await enqueue(
      "content.analyze",
      { mediaId, ...(fast ? { fast: true } : {}) },
      { dedupeKey: `content.analyze:${mediaId}` },
    );
    await setEpisodeNote("AI 장면 분석 대기 중…", "progress", 20);
    console.log(`[worker] media.prepare ${mediaId}: promoted, probed, analysis queued`);
  } catch (err) {
    // probe/signing failures can occur before the thumbnail block's normal cleanup.
    fs.rmSync(path.join(os.tmpdir(), "stepd-media-prepare", mediaId), { recursive: true, force: true });
    await setEpisodeNote("업로드 후처리 실패 — 자동 재시도 대기", "error", 0).catch(() => {});
    throw err;
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
  // player_client 강제(위 주석) — youtube: 로 스코프해 비-유튜브 URL 엔 무해하다.
  const clientArgs = YTDLP_PLAYER_CLIENT
    ? ["--extractor-args", `youtube:player_client=${YTDLP_PLAYER_CLIENT}`]
    : [];
  const base = [...clientArgs, ...args];
  const withCookies = cookiesTmp ? ["--cookies", cookiesTmp, ...base] : base;
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
         // ⚠️ **H.264(avc1)를 먼저 고른다.** `ext=mp4` 만으로는 부족하다 — 유튜브는 VP9 도
         //    mp4 컨테이너로 준다. 그 파일은 ffmpeg·우리 파이프라인에서는 멀쩡히 돌지만
         //    **프리미어가 MP4 안의 VP9 를 못 읽어** 오디오만 있는 파일처럼 보인다
         //    (2026-08-31 실측: 편집자 화면에 파형만 뜸 · 영상 트랙 없음).
         //    편집자에게 원본을 넘기는 경로가 생긴 이상 이건 우리 문제다.
         //    못 찾으면 예전 체인으로 물러난다 — 다운로드 자체가 실패하는 게 더 나쁘다.
         "-f", "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]"
             + "/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
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

    // ⚠️ **프리미어가 읽는 코덱으로 여기서 바꾼다.** 유튜브는 VP9 도 mp4 로 주는데,
    //    그 파일은 ffmpeg·우리 파이프라인에선 멀쩡하지만 **프리미어가 영상 트랙을 못 읽어**
    //    편집자 화면엔 오디오 파형만 뜬다(실측 2026-08-31).
    //
    //    포맷 선택에서 avc1 을 먼저 고르게 했지만(위 -f), 그게 없는 영상도 있다. 그때 여기서
    //    굽는다 — **파일이 이미 이 PC 에 있는 유일한 순간**이라 다운로드·전송이 0원이다.
    //    나중에 media.transcode 로 하면 GCS 에서 다시 받아야 해서 회차당 ₩45 안팎이 든다.
    if (!fast && PREMIERE_UNREADABLE_CODECS.has(String(meta.codec ?? "").toLowerCase())) {
      const h264Path = path.join(workDir, "source-h264.mp4");
      try {
        console.log(`[youtube.download] ${mediaId} codec=${meta.codec} → h264 변환 (프리미어 호환)`);
        await transcodeToH264(realPath, h264Path);
        const after = await probe(h264Path);
        // 길이가 어긋나면 원본을 쓴다 — 깨진 변환본을 올리는 게 최악이다.
        if (after.durationSec > 0 && Math.abs(after.durationSec - meta.durationSec) <= 2) {
          fs.rmSync(realPath, { force: true });
          realPath = h264Path;
          meta = after;
        } else {
          console.warn(`[youtube.download] ${mediaId} 변환 길이 불일치 — 원본을 그대로 씁니다`);
          fs.rmSync(h264Path, { force: true });
        }
      } catch (e: any) {
        // 변환 실패는 다운로드를 죽이지 않는다 — 분석은 VP9 로도 돈다. 편집만 불편할 뿐이고,
        // 그건 나중에 media.transcode 로 따라잡을 수 있다.
        console.warn(`[youtube.download] ${mediaId} h264 변환 실패(원본 사용): ${String(e?.message ?? e).slice(0, 200)}`);
        fs.rmSync(h264Path, { force: true });
      }
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
    let verdict = checkCredits({
      balance: await creditBalance(),
      needMinutes: billableMinutes(meta.durationSec),
    });
    if (!verdict.allow) {
      // 부족 → 저장 카드 자동 충전 시도 후 재판정 (라우트 402 게이트와 같은 방향 · ENA 스펙).
      verdict = (await topupAndRecheck(billableMinutes(meta.durationSec))) ?? verdict;
    }
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

// ── youtube.reconcile — 예약 게시 확인 (AENA youtube-reconcile.job.ts 이식) ───────
//
// 우리는 예약(publishAt)으로 올린 뒤 배포 행을 'scheduled' 로 적고 **다시 확인하지 않았다.**
// 유튜브가 예약 시각에 실제로 공개해도 화면은 영원히 "예약됨" 이라, 채널에 가 보면 예약이
// 없는데 우리만 예약이라고 우긴다(2026-08-21 사용자 지적). AENA 가 같은 걸 먼저 겪고
// (2026-07-21) 고친 방식을 그대로 가져온다 — videos.list 로 실제 privacyStatus 를 되읽는다.
//
// AENA 에서 그대로 가져온 설계 4가지(이유가 다 실측에서 나왔다):
//  ① **폴링 창** — 예약 10분 전 ~ 24시간 후만 본다. 안 그러면 오래된 행을 영원히 조회한다.
//  ② **채널별 그룹핑 + 배치(50개)** — videos.list 는 id 를 50개까지 묶어 1 unit 이다.
//     ⚠️ 예약 영상의 privacyStatus 는 **소유자 토큰**이 아니면 안 보인다 → 크로스채널 배치 불가.
//  ③ **확정 신호(public)일 때만 전환** — 조회 실패·private·unlisted·응답 누락은 상태 유지.
//     오판해서 '게시됨' 으로 바꾸면 사람이 확인할 기회를 잃는다.
//  ④ **배치 단위 로그** — 건별로 남기면 quota 초과 시 하루 수백~수천 줄이 된다.
const YT_RECONCILE_BATCH = 50;
const YT_RECONCILE_LOOKAHEAD_MS = 10 * 60_000;      // 예약 10분 전부터 본다
const YT_RECONCILE_LOOKBEHIND_MS = 24 * 3600_000;   // 지난 지 24시간까지만 본다
// 게시 후 공개범위 되읽기 창 — 사람이 유튜브 스튜디오에서 비공개→공개로 바꿔도 우리 기록은
// 업로드 시점 값이라 고객사 화면이 계속 '비공개' 배지를 달았다(2026-08-26 ENA 실전).
// 게시 7일까지만 되읽는다 — 그 뒤 변경은 드물고, 오래된 행을 영원히 조회하면 quota 낭비.
const YT_PRIVACY_REFRESH_WINDOW_MS = 7 * 24 * 3600_000;

async function handleYoutubeReconcile(_job: Job): Promise<void> {
  const clips = await listEntities<any>("clip");
  const now = Date.now();

  /** 채널별로 (클립, videoId) 를 모은다 — 소유자 토큰으로만 조회할 수 있어서 반드시 채널별.
   *  kind: scheduled = 예약 공개 확정 감시(기존) · refresh = 게시된 행의 공개범위 되읽기. */
  const byChannel = new Map<string, {
    clipId: string; videoId: string; kind: "scheduled" | "refresh"; privacy?: string;
  }[]>();
  for (const clip of clips) {
    for (const d of (clip?.distributions ?? []) as any[]) {
      if (d?.channel !== "youtube") continue;
      const videoId = typeof d.externalId === "string" ? d.externalId : "";
      const channelId = typeof d.youtubeChannelId === "string" ? d.youtubeChannelId : "";
      if (!videoId || !channelId) continue;
      if (d?.status === "scheduled") {
        // 폴링 창 — reserveDate 를 못 읽으면(형식 이상) 창 제한 없이 본다(AENA 와 동일).
        const due = typeof d.reserveDate === "string" ? Date.parse(d.reserveDate) : NaN;
        if (Number.isFinite(due)
          && (due > now + YT_RECONCILE_LOOKAHEAD_MS || due < now - YT_RECONCILE_LOOKBEHIND_MS)) continue;
        const arr = byChannel.get(channelId) ?? [];
        arr.push({ clipId: clip.id, videoId, kind: "scheduled" });
        byChannel.set(channelId, arr);
      } else if (d?.status === "published" && typeof d.privacy === "string") {
        // 게시 7일 안의 행만 — 스튜디오에서 사람이 바꾼 공개범위를 따라간다.
        const at = Number(d.publishedAt);
        if (!Number.isFinite(at) || now - at > YT_PRIVACY_REFRESH_WINDOW_MS) continue;
        const arr = byChannel.get(channelId) ?? [];
        arr.push({ clipId: clip.id, videoId, kind: "refresh", privacy: d.privacy });
        byChannel.set(channelId, arr);
      }
    }
  }
  if (byChannel.size === 0) return;

  let confirmed = 0;
  for (const [channelId, items] of byChannel) {
    const ch = await loadActiveChannel(channelId);
    if (!ch) continue; // 토큰 없음/철회 — 다음 주기 재시도
    for (let i = 0; i < items.length; i += YT_RECONCILE_BATCH) {
      const batch = items.slice(i, i + YT_RECONCILE_BATCH);
      try {
        const ids = batch.map((b) => b.videoId).join(",");
        const statusById = await withChannelToken(ch, async (token) => {
          const res = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(ids)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const data = await res.json().catch(() => null) as any;
          if (!res.ok) throw new Error(`videos.list ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
          const m = new Map<string, string | undefined>();
          // ⚠️ items 순서는 요청 순서와 다르고, 삭제된 영상은 응답에서 **빠진다** — id 로 매칭한다.
          for (const it of (data?.items ?? []) as any[]) if (it?.id) m.set(it.id, it.status?.privacyStatus);
          return m;
        });
        for (const b of batch) {
          const actual = statusById.get(b.videoId);
          if (b.kind === "refresh") {
            // 되읽기 — 실제 privacyStatus 가 기록과 다르면 그대로 따라간다(승격이 아니라
            // 동기화: public·unlisted·private 어느 방향이든). 응답 누락(삭제·조회 실패)은
            // 손대지 않는다 — 모르는 걸 지어내지 않는다.
            if (!actual || actual === b.privacy) continue;
            const fresh = (await getEntity<any>("clip", b.clipId)) ?? null;
            if (!fresh) continue;
            await putEntity("clip", b.clipId, {
              ...fresh,
              distributions: upsertDistribution(fresh.distributions, "youtube", {
                externalId: b.videoId, youtubeChannelId: channelId, privacy: actual,
              }),
            });
            confirmed += 1;
            continue;
          }
          if (actual !== "public") continue; // 확정 신호가 아니면 손대지 않는다
          const fresh = (await getEntity<any>("clip", b.clipId)) ?? null;
          if (!fresh) continue;
          await putEntity("clip", b.clipId, {
            ...fresh,
            distributions: upsertDistribution(fresh.distributions, "youtube", {
              status: "published", externalId: b.videoId, youtubeChannelId: channelId,
              // 공개 확정 시각·공개범위 — 고객사 화면 정렬·표기용(2026-08-25 aena 감사).
              // upsertDistribution 은 merge 라 기존 title·reserveDate 는 보존된다.
              publishedAt: Date.now(), privacy: "public",
            }),
          });
          confirmed += 1;
        }
      } catch (e) {
        // 배치 단위 로그 1건 — 건별로 남기면 quota 초과 시 로그가 폭증한다(AENA 실측).
        console.warn(`[worker] youtube.reconcile 배치 실패 (채널 ${channelId} · ${batch.length}건):`,
          e instanceof Error ? e.message.slice(0, 200) : e);
      }
    }
  }
  if (confirmed > 0) console.log(`[worker] youtube.reconcile — 예약 게시 확인 ${confirmed}건 → published`);
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

/**
 * 예약 게시 확인 팬아웃 — 순방과 같은 자리에서 같은 주기로 돈다.
 *
 * 테넌트마다 하나씩 넣는다(순방과 같은 이유 — 격리가 곧 잡 분리다). dedupeKey 로 겹쳐
 * 쌓이지 않는다. 처리할 예약이 없으면 핸들러가 즉시 끝나므로 빈 순방 비용은 사실상 0 이다.
 */
export async function fanOutYoutubeReconcile(): Promise<number> {
  const tenants = await runAsSystem(async () => {
    const { rows } = await getRawPool().query("SELECT id FROM tenants");
    return rows.map((r: { id: string }) => r.id);
  });

  let n = 0;
  for (const tenantId of tenants) {
    const id = await runWithTenant({ scope: tenantId, via: "system" }, () =>
      enqueue("youtube.reconcile", {}, { dedupeKey: `youtube.reconcile:${tenantId}`, maxAttempts: 1 }),
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

/**
 * 쿠팡 제휴 링크 발급 — 클립의 상품 쿼리(`clip.commerce.queries`)로 링크를 만들어 붙인다.
 *
 * **머신 전용 레인**(WORKER_JOBS=commerce). 로그인된 파트너스 콘솔이 뜬 PC 에서만 돈다.
 * ⚠️ 게이트를 켰는데 이 레인 워커를 안 띄우면 잡이 **조용히 pending 으로 쌓인다** —
 *    이 리포의 전형적 실패 모드다. 게이트를 켤 때 워커도 같이 띄울 것.
 *
 * 발행을 막지 않는 것이 설계 원칙이다: 링크가 늦거나 실패해도 쇼츠는 그대로 나가고
 * (`withCommerceLinks` 가 링크 없으면 원문을 돌려준다), 나중에 붙으면 그때부터 붙는다.
 */
async function handleCommerceLink(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  if (!clipId) { console.error("[worker] commerce.link: clipId 누락 — 버림"); return; }

  // 킬스위치 — 켜져 있는 동안 큐잉됐다가 꺼진 뒤 남은 잡을 막는다. throw 금지(재시도만 쌓인다).
  if (!commerceLinksEnabled()) {
    console.warn(`[worker] commerce.link ${clipId}: blocked — 커머스 링크 비활성(COMMERCE_LINKS_ENABLED)`);
    return;
  }

  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] commerce.link: clip ${clipId} 없음 — 버림`); return; }

  // **어느 회사 계정으로 발급할 것인가** — 이 잡에서 제일 중요한 판정이다.
  // 커미션 정산이 계정 단위라, 계정을 잘못 고르면 수익이 엉뚱한 회사로 귀속된다.
  const acct = await resolveCommerceAccount(job, clipId);
  if (!acct) return;

  // 교체(pick) 경로 — 검토 화면에서 "이거 말고 저거" 를 고른 경우. 검색 없이 그 후보로만 발급한다.
  const pick = job.payload.pick as { query?: string; productId?: number } | undefined;
  if (pick?.query && pick?.productId) {
    await runCommercePick(clipId, clip, String(pick.query), Number(pick.productId), acct);
    return;
  }

  const queries: { query: string; reason?: string }[] = Array.isArray(clip.commerce?.queries)
    ? clip.commerce.queries
        .map((q: any) => ({
          query: String(q?.query ?? q ?? "").trim(),
          reason: q?.reason ? String(q.reason) : undefined,
        }))
        .filter((q: any) => q.query)
    : [];
  if (queries.length === 0) {
    console.log(`[worker] commerce.link ${clipId}: 상품 쿼리가 없다 — 할 일 없음`);
    return;
  }

  // 이미 발급된 쿼리는 건너뛴다 — 재실행이 링크를 중복 생성하지 않게(멱등).
  // ⚠️ 승인/거절 상태와 무관하다: 사람이 거절한 상품을 재실행이 되살리면 안 된다.
  const existing = usableLinks(clip.commerce?.links, Number.MAX_SAFE_INTEGER);
  const done = new Set(existing.map((l) => l.query.toLowerCase()));
  const todo = queries.filter((q) => !done.has(q.query.toLowerCase()));
  if (todo.length === 0) {
    console.log(`[worker] commerce.link ${clipId}: 이미 전부 발급됨 (${existing.length}건)`);
    return;
  }

  // 브라우저 문제(PartnersUnavailableError)는 던져서 큐 백오프에 맡긴다 — 사람이 PC 를 켜면
  // 다음 시도에 붙는다. 세션 만료는 재시도해도 영원히 안 되므로 계정에 표시하고 조용히 끝낸다.
  let results;
  try {
    const batch = await issueCoupangLinks(todo, acct.session);
    results = batch.results;
    await persistRefreshedSession(acct, batch.storageState);
  } catch (e) {
    if (e instanceof PartnersSessionExpiredError) return void (await onSessionExpired(acct, clipId, e));
    throw e;
  }

  const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
  const merged = [...usableLinks(fresh.commerce?.links, Number.MAX_SAFE_INTEGER)];
  const seen = new Set(merged.map((l) => l.query.toLowerCase()));
  const candidates: Record<string, ProductCandidate[]> = { ...(fresh.commerce?.candidates ?? {}) };
  for (const r of results) {
    if (r.candidates?.length) candidates[r.query] = r.candidates;
    if (r.ok && r.link && !seen.has(r.link.query.toLowerCase())) {
      merged.push(r.link);   // status 없음 = pending. 승인 전에는 설명란에 안 나간다.
      seen.add(r.link.query.toLowerCase());
    }
  }
  await putEntity("clip", clipId, {
    ...fresh,
    commerce: { ...(fresh.commerce ?? {}), links: merged, candidates, linkedAt: Date.now() },
  });
  await markCommerceIssued(acct.id).catch(() => {});

  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(
    `[worker] commerce.link ${clipId}: ${okCount}/${todo.length}건 발급 · 검토 대기 ` +
      `(총 ${merged.length}건 · 계정 ${acct.label})` +
      (failed.length ? ` · 실패: ${failed.map((f) => `${f.query}(${f.error})`).join(" / ")}` : ""),
  );
}

/** 이 잡이 쓸 계정 + 세션. 못 정하면 **아무것도 하지 않는다**(공용 계정 폴백 없음). */
interface ResolvedAccount { id: string; label: string; session: unknown | null }

/**
 * 어느 회사 계정으로 발급할지 정한다.
 *
 * **폴백이 없는 것이 요점이다.** 계정이 없다고 공용 계정으로 흘려보내면 A사 콘텐츠의 커미션이
 * B사(혹은 우리) 계정으로 들어간다 — 에러가 아니라 "성공" 으로 보이는 종류라 아무도 모른다.
 * `naver.publish` 가 "A사 클립이 B사 채널에 올라가는 사고를 막는다" 며 하는 대조와 같은 자리다.
 */
async function resolveCommerceAccount(job: Job, clipId: string): Promise<ResolvedAccount | null> {
  const acct = await getCommerceAccount("coupang").catch(() => undefined);
  if (!acct) {
    // 개발기 전용 탈출구 — 명시적으로 켰을 때만. 프로덕션에서 조용히 켜지지 않게 기본 OFF.
    if (String(process.env.COMMERCE_DEV_CDP ?? "").trim() === "1") {
      console.warn(`[worker] commerce.link ${clipId}: ⚠️ 개발 모드(COMMERCE_DEV_CDP=1) — ` +
        "이 PC 에 로그인된 크롬 계정으로 발급합니다. 수익 귀속이 그 계정으로 갑니다.");
      return { id: "dev-cdp", label: "개발기 CDP", session: null };
    }
    console.warn(`[worker] commerce.link ${clipId}: 이 워크스페이스에 등록된 쿠팡파트너스 계정이 없습니다 — ` +
      "발급하지 않습니다(공용 계정으로 대신 발급하면 수익이 엉뚱한 회사로 귀속됩니다).");
    return null;
  }
  if (acct.status === "disabled") {
    console.warn(`[worker] commerce.link ${clipId}: 계정 '${acct.label}' 이 비활성입니다 — 건너뜁니다.`);
    return null;
  }
  // RLS 가 이미 테넌트로 걸러 주지만, 워커에는 시스템 스코프로 도는 구간이 있어 한 번 더 본다.
  const jobTenant = job.tenantId || DEFAULT_TENANT_ID;
  if (acct.tenantId !== jobTenant) {
    console.error(`[worker] commerce.link ${clipId}: 테넌트 불일치 — 잡(${jobTenant}) vs 계정(${acct.tenantId}). ` +
      "다른 회사 계정으로 발급할 뻔했습니다.");
    return null;
  }

  const blob = await getCommerceSessionBlob(acct.id);
  const session = openCommerceSession(blob);
  if (!session) {
    console.warn(`[worker] commerce.link ${clipId}: 계정 '${acct.label}' 에 쓸 수 있는 세션이 없습니다 — ` +
      "그 계정으로 다시 로그인해 세션을 등록해야 합니다.");
    await markCommerceSessionExpired(acct.id).catch(() => {});
    return null;
  }
  return { id: acct.id, label: acct.label, session };
}

/** 쿠키가 회전하므로 실행 후 세션을 갱신해 둔다 — 안 하면 세션이 일찍 죽는다. */
async function persistRefreshedSession(acct: ResolvedAccount, state: unknown | null): Promise<void> {
  if (!state || acct.id === "dev-cdp") return;
  try {
    await setCommerceSessionBlob(acct.id, sealCommerceSession(state));
  } catch (e) {
    // 키 미설정 등 — 발급 자체는 성공했으므로 잡을 실패시키지 않는다. 다음에 세션이 만료될 뿐.
    console.warn("[worker] commerce.link: 세션 갱신 저장 실패:", e instanceof Error ? e.message : e);
  }
}

/** 세션 만료는 재시도로 안 풀린다 — 계정에 표시해 사람이 보게 하고 잡은 조용히 끝낸다. */
async function onSessionExpired(acct: ResolvedAccount, clipId: string, e: Error): Promise<void> {
  console.error(`[worker] commerce.link ${clipId}: ${e.message} (계정 ${acct.label})`);
  if (acct.id !== "dev-cdp") await markCommerceSessionExpired(acct.id).catch(() => {});
}

/** 검토 화면의 상품 교체 — 저장된 후보 중 productId 로 지목된 것으로 링크를 다시 발급한다. */
async function runCommercePick(
  clipId: string, clip: any, query: string, productId: number, acct: ResolvedAccount,
): Promise<void> {
  const candidates: ProductCandidate[] = (clip.commerce?.candidates ?? {})[query] ?? [];
  const chosen = candidates.find((c) => Number(c.productId) === productId);
  if (!chosen) {
    console.warn(`[worker] commerce.link ${clipId}: 후보 ${productId} 를 '${query}' 에서 못 찾음 — 버림`);
    return;
  }
  const reason = (clip.commerce?.queries ?? []).find((q: any) => q?.query === query)?.reason;
  let res;
  try {
    const out = await issueLinkForCandidate(chosen, query, reason ? String(reason) : undefined, acct.session);
    res = out.result;
    await persistRefreshedSession(acct, out.storageState);
  } catch (e) {
    if (e instanceof PartnersSessionExpiredError) return void (await onSessionExpired(acct, clipId, e));
    throw e;
  }
  if (!res.ok || !res.link) {
    console.error(`[worker] commerce.link ${clipId} 교체 실패 (${query}): ${res.error}`);
    return;
  }

  const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
  const links = usableLinks(fresh.commerce?.links, Number.MAX_SAFE_INTEGER);
  const prev = links.find((l) => l.query.toLowerCase() === query.toLowerCase());
  // 교체는 **명시적 선택**이라 그대로 승인 상태로 둔다 — 고르고 또 승인하게 만들 이유가 없다.
  const next = links.filter((l) => l.query.toLowerCase() !== query.toLowerCase());
  next.push({ ...res.link, status: "approved", decidedBy: prev?.decidedBy, decidedAt: Date.now() });

  // 후보 목록은 **건드리지 않는다** — 방금 뺀 상품으로 되돌아갈 수 있어야 하고,
  // 목록에 현재 상품도 함께 들어 있다(coupang-partners.ts 의 candidates 구성).
  await putEntity("clip", clipId, {
    ...fresh,
    commerce: { ...(fresh.commerce ?? {}), links: next, linkedAt: Date.now() },
  });
  console.log(`[worker] commerce.link ${clipId} 교체 완료 (${query}) → ${res.link.productName}`);
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
  const thumbMode = String(job.payload.mode ?? "") === "frame" ? "frame" : "ai";

  // 이 프로그램의 스타일 프로파일·출연자 사진만 내려받는다 (회차마다 전체를 뒤지지 않게).
  const assets = await prepareProgramAssets(programId, `gen-${mediaId}-${Date.now()}`);
  // ⚠️ 출연자 사진은 **ai 방식에서만** 전제조건이다. frame 방식은 실제 화면을 그대로 쓰므로
  // 인물 등록이 필요 없다 — 여기서 같이 막으면 아카이브 회차는 어느 방식으로도 썸네일을
  // 못 만든다(그게 이 방식을 만든 이유다).
  if (thumbMode === "ai" && !assets.castFiles) {
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
  // narrative.json 은 **ai 방식의 기획 입력**이다. frame 방식은 자막 한 줄만 있으면 되고
  // 그건 analysis.json(추천 제목)에서 가져오거나 호출자가 직접 준다.
  if (thumbMode === "ai" && !fs.existsSync(path.join(analysisDir, "narrative.json"))) {
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
      // 두 방식(사용자 확정 2026-08-16) — ai=서사+인물 누끼 생성 · frame=실제 프레임+자막.
      // frame 은 등록 인물이 없어도 되고 얼굴이 원본 그대로라, 캐스트가 안 채워진 아카이브에
      // 쓸 수 있는 유일한 방식이다.
      "--mode", thumbMode,
      ...(job.payload.caption ? ["--caption", String(job.payload.caption)] : []),
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

  // 배포 크레딧 환급 — 차감된 행(dispatch 가 creditChargeKey 를 심는다)이 실패하면 1크레딧을
  // 돌려준다(사용자 2026-08-26 "실패하면 돌려줘야 함"). dedupe 키가 chargeKey 기반이라 같은
  // 실패가 두 번 지나가도 원장에는 한 번만 쌓인다. 환급 후 플래그를 내려 재시도가 새로 차감한다.
  const rows: any[] = Array.isArray(clip.distributions) ? clip.distributions : [];
  const prev = rows.find((d) => d?.channel === channel
    && (!accountId || !d?.[accountField] || String(d[accountField]) === String(accountId)));
  if (prev?.creditCharged === true && typeof prev?.creditChargeKey === "string" && prev.creditChargeKey) {
    // 환급량 = 차감 시점에 행에 박아둔 값 — 단가가 바뀌어도 옛 차감은 옛 값대로 돌아간다.
    const refund = Number(prev.creditChargeCredits) > 0 ? Math.floor(Number(prev.creditChargeCredits)) : 1;
    await addCreditEntry({
      delta: refund, reason: "publish_refund",
      note: `${channel} 배포 실패 환급 · ${clipId}`,
      actor: "worker", dedupeKey: `${prev.creditChargeKey}:refund`,
    }).catch((e) => console.warn(`[worker] 배포 환급 실패 ${clipId}:`, e instanceof Error ? e.message : e));
    value.creditCharged = false;
  }

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
    // 담당자 메일에도 실린다 — 실행 로그는 화면에 들어와야 보이지만, 리포트는 찾아간다.
    // 실패는 **자동 재시도가 없는** 상태라(F4-4) 사람이 눌러야 풀리는데, 예전 리포트는
    // 성공만 적립해 "20건 중 17건 게시 · 확인 필요 0" 이라고 말했다(2026-08-26).
    // 실패 뒤 재시도가 성공하면 그 적립이 이 줄을 지운다. 던지지 않는 함수다.
    await recordAutoPublishFailureForReport({
      clip: { ...clip, distributions }, clipId,
      title: String(metaForChannel(clip, channel as any)?.title ?? clip.title ?? "").trim() || String(clip.title ?? ""),
      channel, accountId,
      channelLabel: accountId ? await publishChannelLabel(channel, accountId) : undefined,
      error,
    });
  }
}

/**
 * 배포 채널의 **사람이 읽는 이름** — 리포트가 생 계정 ID 대신 쓴다(2026-08-26).
 * 못 찾으면 undefined 를 돌려 리포트가 계정 ID 를 감추게 둔다. 던지지 않는다.
 */
async function publishChannelLabel(channel: string, accountId: string): Promise<string | undefined> {
  try {
    if (channel === "youtube") {
      const ch = await getYouTubeChannelByChannelId(accountId);
      return String((ch as any)?.channelName ?? "").trim() || undefined;
    }
  } catch { /* 이름은 부속 정보 — 실패해도 배포 처리를 막지 않는다 */ }
  return undefined;
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
  // 유튜브 상한. **여기서 걸러야 한다** — 상한 초과를 업로드 직전에 던지면 그 자리에서
  // 끝나서(catch 는 경고만) 다음 후보로 못 넘어가고 썸네일이 아예 안 붙는다.
  // AI 썸네일은 1280×720 PNG 라 2MB 를 넘길 수 있는 반면, 렌더 프레임은 JPEG 라 작다.
  const MAX_BYTES = 2 * 1024 * 1024;
  const load = async (objPath: string, source: string) => {
    if (!objPath || !(await fileExists(objPath).catch(() => false))) return null;
    const body = await readFile(objPath);
    if (body.byteLength > MAX_BYTES) {
      console.warn(`[worker] 썸네일 후보가 2MB 초과 — 건너뜀 (${source} · ${Math.round(body.byteLength / 1024)}KB · ${objPath})`);
      return null;
    }
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
      const { thumbnailPrefix } = await import("./media/thumbnail-assets.ts");
      const paths = (await listPrefix(`${thumbnailPrefix(masterId)}/`))
        .filter((p) => /\.(png|jpe?g|webp)$/i.test(p))
        .sort();
      // 후보가 여럿이면 하나가 용량 초과여도 다음 것을 본다 — 첫 장만 보고 포기하지 않는다.
      for (const p of paths) {
        const hit = await load(p, "ai").catch(() => null);
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
/**
 * 발행 텍스트에서 내부 화자 라벨을 지운다. "남성 출연자 2"·"화자 3" 은 STT/화자분리 산출물이라
 * cast 미등록 프로그램에서는 synopsis/설명에 그대로 남는다 — 시청자용 발행문(유튜브 설명 등)에
 * 절대 새면 안 된다(2026-08-18 실측: 설명에 "남성 출연자 2가 …" 노출). 주격조사(이/가)는 자-받침에
 * 맞게 '가'로 정규화한다. 근본 해결은 생성 메타(buildMetadataPrompt)를 발행에 배선하는 것(L2).
 */
function stripSpeakerLabels(s: string): string {
  return String(s)
    // Diarization labels are internal metadata; never expose them in viewer-facing copy.
    .replace(/(남성|여성)?\s*(출연자|화자|참가자)\s*\d+\s*(이|가)/g, "출연자가")
    .replace(/(남성|여성)?\s*(출연자|화자|참가자)\s*\d+/g, "출연자")
    .replace(/\b(?:speaker|participant|guest)\s*\d+\b/gi, "출연자")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function metaForChannel(clip: any, channel: string): { title: string; description: string; tags?: string[] } {
  // 커머스 제휴 링크 + 대가성 문구는 **여기서** 붙는다 — 발행 직전 조립 시점이다.
  //
  // 저장된 설명 본문에 미리 구워 넣지 않는 이유가 둘이다:
  //  ① 대가성 문구는 사람이 지울 수 없어야 한다. 편집 화면에 노출되는 값에 넣으면 언젠가
  //     지워지고, 그 순간 고객사의 파트너스 계정이 정지된다(누락 = 정지 사유).
  //  ② 링크 발급이 늦어도 발행이 안 막힌다. 링크가 없으면 원문을 그대로 돌려준다.
  // 게이트 OFF·링크 없음·YouTube 외 채널이면 아무것도 하지 않는다(commerce.ts).
  const withLinks = (description: string) => withCommerceLinks(description, clip?.commerce?.links, channel);

  const m = clip?.channelMeta?.[channel];
  if (m && (m.title || m.description)) {
    return {
      title: stripSpeakerLabels(String(m.title ?? clip.title ?? "무제 클립")),
      description: withLinks(stripSpeakerLabels(String(m.description ?? ""))),
      tags: Array.isArray(m.tags) && m.tags.length ? m.tags : undefined,
    };
  }
  return {
    title: stripSpeakerLabels(String(clip?.title ?? "무제 클립")),
    description: withLinks(stripSpeakerLabels(String(clip?.synopsis ?? ""))),
    tags: Array.isArray(clip?.tags) ? clip.tags : undefined,
  };
}

/**
 * 네이버 자동 로그인 — 저장된 자격증명으로 세션을 되살린다.
 *
 * 두 자리에서 불린다: 사람이 자격증명을 막 저장했을 때(검증), 발행이 세션 만료로 막혔을 때(복구).
 * **성공하면 세션을 서버에 저장**하므로 다른 워커도 바로 쓴다.
 *
 * ⚠️ 실패 종류를 구분해서 다룬다:
 *  - `bad_credentials` → **자격증명을 지운다.** 틀린 비번으로 반복 시도하면 계정이 잠긴다
 *    (세션 만료보다 훨씬 나쁘다 — 사람이 네이버에서 직접 풀어야 한다).
 *  - `challenge`(캡차·2차인증) → 비번은 맞을 수 있으니 남기고, 사람을 부른다.
 */
async function handleNaverLogin(job: Job): Promise<boolean> {
  const accountId = String(job.payload.accountId ?? "");
  if (!accountId) { console.error("[worker] naver.login: accountId 누락 — 버림"); return false; }

  const acct = await getNaverAccount(accountId);
  if (!acct) { console.warn(`[worker] naver.login: 계정 ${accountId} 없음 — 버림`); return false; }
  const jobTenant = job.tenantId || DEFAULT_TENANT_ID;
  if (acct.tenantId !== jobTenant) {
    console.error(`[worker] naver.login ${accountId}: 테넌트 불일치 — 잡(${jobTenant}) vs 계정(${acct.tenantId})`);
    return false;
  }

  const cred = openCredential(await getNaverCredentialBlob(accountId));
  if (!cred) {
    console.warn(`[worker] naver.login ${accountId}: 자격증명이 없거나 못 풀었다 (NAVER_CRED_KEY 확인)`);
    await markNaverCredential(accountId, "failed", "자격증명을 읽지 못했습니다 (키 불일치 또는 미저장)").catch(() => {});
    return false;
  }

  console.log(`[worker] naver.login ${accountId} (${acct.label}) — 자동 로그인 시도`);
  const res = await loginWithCredentials(cred.id, cred.pw);
  if (res.ok) {
    saveNaverSession(res.state, acct.accountKey);                 // 이 PC 가 바로 쓰게
    await setNaverSessionBlob(accountId, sealSession(res.state));  // 다른 워커도 쓰게
    await markNaverCredential(accountId, "verified", null);
    await markNaverAccount(accountId, { status: "active", lastLoginAt: Date.now() }).catch(() => {});
    console.log(`[worker] naver.login ${accountId}: 성공 — 세션 갱신`);
    return true;
  }

  // 실패 — 종류에 따라 자격증명을 지울지 남길지 가른다.
  const clear = res.kind === "bad_credentials";
  await markNaverCredential(accountId, "failed", res.message, { clear });
  await markNaverAccount(accountId, { status: "session_expired" }).catch(() => {});
  console.error(`[worker] naver.login ${accountId}: ${res.kind} — ${res.message}` +
    (clear ? " (자격증명 삭제: 반복 시도는 계정 잠금을 부른다)" : " (자격증명 유지: 사람이 한 번 로그인해야 한다)"));
  return false;
}

/**
 * 세션이 죽었을 때 **발행 도중에** 스스로 되살린다. 자격증명이 없으면 그냥 false.
 *
 * 재시도를 한 번으로 묶는 게 중요하다 — 실패하는 자격증명으로 발행마다 로그인을 시도하면
 * 네이버가 계정을 잠근다. 그래서 `naver.login` 이 실패 시 자격증명을 지우고(bad_credentials),
 * 여기서는 그 결과만 본다.
 */
async function tryAutoRelogin(job: Job, acct: { id: string; label: string; accountKey: string }): Promise<boolean> {
  const blob = await getNaverCredentialBlob(acct.id).catch(() => null);
  if (!blob) return false;
  console.log(`[worker] '${acct.label}' 세션 만료 — 저장된 자격증명으로 자동 재로그인 시도`);
  const ok = await handleNaverLogin({ ...job, payload: { accountId: acct.id } } as Job).catch((e) => {
    console.error("[worker] 자동 재로그인 실패:", e instanceof Error ? e.message : e);
    return false;
  });
  return ok === true && hasNaverSession(acct.accountKey);
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
    // 여기서는 킬스위치만 빨리 본다 — 잡을 낭비하지 않게.
    // ⚠️ 권리 게이트는 2026-08-31 에 제거됐다(사용자 결정: "실전에서 필요가 없음").
    if (!naverUploadEnabled()) return void (await fail(NAVER_DISABLED_MESSAGE));
    const clip = await getEntity<any>("clip", clipId);
    if (!clip) { console.warn(`[worker] naver.publish: clip ${clipId} 없음 — 버림`); return; }

    // B2B 다계정에서 **이 검증이 제일 중요하다** —
    // A사 클립이 B사 채널에 올라가는 사고를 막는다.
    let accountKey: string | undefined;
    // ⚠️ 블록 밖에 둔다 — 업로드 중 세션 만료를 잡아 재로그인할 때 이 계정이 필요하다.
    // 예전엔 `if (accountId)` 안의 const 라, 만료 복구 경로에서 계정을 못 봤다.
    let acct: Awaited<ReturnType<typeof getNaverAccount>> | undefined;
    if (accountId) {
      acct = await getNaverAccount(accountId);
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
        } else if (await tryAutoRelogin(job, acct)) {
          // 자격증명이 있으면 **사람을 부르기 전에 스스로 되살린다.** 세션은 만료되게 마련이고
          // (실측: 9일), 그때마다 사람이 브라우저를 여는 게 이 기능의 원래 부담이었다.
          console.log(`[worker] '${acct.label}' 자동 재로그인으로 세션 복구 — 발행 계속`);
        } else {
          await markNaverAccount(acct.id, { status: "session_expired" }).catch(() => {});
          return void (await fail(
            `'${acct.label}' 세션 없음 — 웹 배포채널 화면에서 다시 로그인하세요 ` +
            `(아이디·비번을 저장해 두면 다음부터는 자동으로 복구됩니다)`));
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

    // 카테고리는 **페이로드 → 프로그램 설정 → 장르 유도** 순이다. 영상 내용을 보고
    // 자동 판정하지 않는다 — 틀린 분류로 발행되면 네이버에서 손으로 고쳐야 한다.
    // 장르 유도는 추측이 아니라 사람이 프로그램에 지정한 장르를 옮기는 것뿐이다.
    const pc = (job.payload.category ?? {}) as { primary?: string; secondary?: string };
    const prog = (program?.naverCategory ?? {}) as { primary?: string; secondary?: string };
    const wanted = pc.primary && pc.secondary
      ? { primary: String(pc.primary), secondary: String(pc.secondary) }
      : prog.primary && prog.secondary
        ? { primary: String(prog.primary), secondary: String(prog.secondary) }
        : categoryForGenre(program?.pipelineGenre ?? program?.section);

    // ⚠️ **영상을 내려받기 전에** 표와 맞춰 본다. 회차 영상은 수백 MB 라, 확인이 다운로드
    // 뒤에 있으면 틀린 카테고리 하나 때문에 그걸 매번 버린다. 예전엔 화면에 없는 값이면
    // 목록의 첫 항목으로 조용히 대체돼서, 엉뚱한 분류로 발행되고도 "발행 완료" 로 보였다.
    const resolved = resolveCategory(wanted.primary, wanted.secondary);
    if (!resolved.ok) return void (await fail(`카테고리 확인 실패 — ${resolved.reason}`));
    const category = resolved.category;

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

      // 등록 예약 — 과거 시각은 무시한다(네이버가 거부하고, 무시하면 즉시 등록된다).
      const rawAt = Number(job.payload.publishAt ?? 0);
      const publishAt = Number.isFinite(rawAt) && rawAt > Date.now() ? rawAt : undefined;

      const upload = () => uploadToNaver({
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

      // ⚠️ **만료는 여기서만 잡힌다.** 자동 재로그인은 위쪽에서 "세션 파일이 아예 없을 때"만
      // 돌았는데, 정작 고치려던 상황(세션이 **있는데 만료됨**)은 파일이 남아 있어 그 분기를
      // 통과해 버렸다. 만료는 uploadToNaver 가 NaverSessionExpiredError 를 **던지는** 경로로
      // 빠져서(naver-tv.ts) 바깥 catch 가 그냥 실패로 기록했다 — 자격증명을 저장해 뒀어도
      // 재로그인은 한 번도 시도되지 않았고, 그날 예약분이 전부 실패했다.
      // 여기서 한 번만 되살리고 재시도한다(무한 재시도는 계정 잠금 경로다).
      let r: Awaited<ReturnType<typeof uploadToNaver>>;
      try {
        r = await upload();
      } catch (e) {
        if (!(e instanceof NaverSessionExpiredError) || !acct) throw e;
        console.warn(`[worker] naver.publish ${clipId}: 세션 만료 — 자동 재로그인 시도`);
        if (!(await tryAutoRelogin(job, acct))) {
          await markNaverAccount(acct.id, { status: "session_expired" }).catch(() => {});
          return void (await fail(
            `'${acct.label}' 세션이 만료됐습니다 — 웹 배포채널 화면에서 다시 로그인하세요 ` +
            `(아이디·비번을 저장해 두면 다음부터는 자동으로 복구됩니다)`));
        }
        console.log(`[worker] '${acct.label}' 자동 재로그인 성공 — 업로드 재시도`);
        r = await upload();
      }
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

/**
 * 클립 렌더 — **직접 인코딩하지 않고** 서버의 `/api/clips/:id/export` 를 부른다.
 *
 * 왜 복제하지 않는가: 렌더 로직(자막 ASS·훅 프리롤·오버레이 PNG·리프레임 플랜)이 전부 그
 * 라우트에 있다. 워커에 옮겨 적으면 두 벌이 갈라지고, 갈라진 순간부터 "편집기 미리보기와
 * 결과물이 다르다" 가 시작된다.
 *
 * 그래서 이 잡의 값은 **어느 CPU 가 그 라우트를 실행하느냐**에 있다. `RENDER_API_BASE` 를
 * 사무실 PC 의 로컬 서버(`http://127.0.0.1:4100`)로 두면 그 PC 가 굽고, 안 두면 종전처럼
 * 클라우드가 굽는다. 코드는 한 벌 그대로다.
 */
/**
 * 원본을 **프리미어가 읽는 코덱**으로 바꾼다 (실측 2026-08-31: VP9-in-MP4 → 오디오만 보임).
 *
 * 원칙 셋:
 *  ① **필요할 때만 손댄다.** 이미 h264 면 아무것도 하지 않는다. 재인코딩은 화질을 한 번 깎는
 *     일이라, "혹시 몰라서" 돌리면 라이브러리 전체가 한 세대 나빠진다.
 *  ② 바꾸는 대상은 **유튜브에서 받은 코덱(vp9·vp8)** 뿐이다. 고객사가 올린 원본(ProRes·MXF·
 *     h264)은 건드리지 않는다 — 그건 되돌릴 수 없는 원본이다.
 *  ③ 오디오는 **그대로 복사**한다. 소리를 다시 굽는 건 STT·자막 싱크에 아무 이득이 없다.
 *
 * 같은 경로에 덮어쓴다. 원본 백업을 남기지 않는 이유: 대상이 유튜브 다운로드본이라 언제든
 * 다시 받을 수 있고, 사본을 두면 라이브러리 저장 비용이 그대로 두 배가 된다.
 */
async function handleMediaTranscode(job: Job): Promise<void> {
  const mediaId = String(job.payload.mediaId ?? "");
  if (!mediaId) throw new Error("media.transcode: mediaId 없음");
  const media = await getMedia(mediaId);
  if (!media) { console.warn(`[transcode] ${mediaId} 없음 — 건너뜀`); return; }

  const objPath = parseObjectPath(media.path);
  if (!(await fileExists(objPath))) { console.warn(`[transcode] ${mediaId} 파일 없음 — 건너뜀`); return; }

  const dir = path.join(os.tmpdir(), "stepd-transcode");
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${mediaId}-src.mp4`);
  const out = path.join(dir, `${mediaId}-h264.mp4`);
  const cleanup = () => { for (const f of [src, out]) { try { fs.unlinkSync(f); } catch { /* 없으면 그만 */ } } };

  try {
    await pipeline(createReadStream(objPath), fs.createWriteStream(src));
    const before = await probe(src);
    const codec = String(before?.codec ?? "").toLowerCase();
    if (!PREMIERE_UNREADABLE_CODECS.has(codec)) {
      console.log(`[transcode] ${mediaId} codec=${codec || "?"} — 손대지 않음`);
      cleanup();
      return;
    }

    console.log(`[transcode] ${mediaId} ${codec} → h264 시작 (${(media.size / 1048576).toFixed(0)}MB)`);
    await transcodeToH264(src, out);
    const after = await probe(out);
    if (!after || !(after.durationSec > 0)) throw new Error("변환 결과를 읽지 못했습니다");
    // 길이가 크게 어긋나면 **덮어쓰지 않는다** — 깨진 결과로 원본을 대체하는 게 최악이다.
    if (before?.durationSec && Math.abs(after.durationSec - before.durationSec) > 2) {
      throw new Error(`길이 불일치 (원본 ${before.durationSec.toFixed(1)}s → 결과 ${after.durationSec.toFixed(1)}s)`);
    }

    await uploadFile(objPath, out);
    await updateMediaSource(mediaId, {
      path: media.path, mime: "video/mp4", size: fs.statSync(out).size,
      durationSec: after.durationSec, width: after.width, height: after.height,
      codec: after.codec, hasAudio: after.hasAudio ? 1 : 0, thumbPath: media.thumbPath ?? null,
      fps: after.fps ?? 0, startTimecode: after.startTimecode ?? "",
      audioStreams: after.audioStreams ?? 0,
    });
    console.log(`[transcode] ${mediaId} 완료 → ${after.codec} ${after.width}×${after.height}`);
  } finally {
    cleanup();
  }
}

/**
 * **프리미어가 못 읽는 코덱**만 — 이 목록 밖은 손대지 않는다.
 * 서버(index.ts PREMIERE_UNREADABLE_CODECS)와 **같은 목록**이어야 한다. 한쪽만 늘리면
 * "라우트는 큐에 넣는데 워커가 건너뛰는" 조용한 불일치가 된다.
 */
const PREMIERE_UNREADABLE_CODECS = new Set(["vp9", "vp8"]);

async function handleClipRender(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  if (!clipId) throw new Error("clip.render: clipId 없음");
  const channel = job.payload.channel ? String(job.payload.channel) : null;

  const { apiBase, internalHeaders } = await import("./factory.ts");
  const base = (process.env.RENDER_API_BASE || "").trim().replace(/\/+$/, "") || apiBase();
  const res = await fetch(`${base}/api/clips/${clipId}/export`, {
    method: "POST",
    headers: { ...(await internalHeaders()), "content-type": "application/json" },
    body: JSON.stringify(channel ? { channel } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 던진다 — 큐의 재시도·백오프가 이 잡의 안전망이다(순방이 또 넣지 않는다: dedupeKey).
    throw new Error(`export ${res.status} ${body.slice(0, 200)}`);
  }
  console.log(`[render] ${clipId} 완료 (${base.includes("127.0.0.1") || base.includes("localhost") ? "로컬" : "원격"})`);
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
 * 이미 발행된 YouTube 영상의 제목·설명·태그를 라이브에 반영 (videos.update · part=snippet).
 *
 * "발행됐으면 재업로드 말고 제목만 고친다"(사용자 방향 2026-08-24)의 실제 반영 경로. 재업로드가
 * 아니라 **기존 영상 수정**이라 새 영상이 안 생긴다(중복 없음). YouTube 만 지원 — 네이버는 공개
 * API 가 없고(Playwright), Meta/TikTok 은 게시 후 편집 제약이 커서 제외. 소스는 사용자가 저장한
 * 채널 메타(clip.channelMeta.youtube), 없으면 파이프라인 기본 메타(metaForChannel).
 */
async function handleDistributionUpdateMeta(job: Job): Promise<void> {
  const clipId = String(job.payload.clipId ?? "");
  const channel = String(job.payload.channel ?? "youtube");
  if (!clipId) { console.warn("[worker] distribution.updatemeta: clipId 누락 — 버림"); return; }
  if (channel !== "youtube") {
    console.warn(`[worker] distribution.updatemeta ${clipId}: ${channel} 은 라이브 메타 반영 미지원 — 버림`);
    return;
  }
  // 이미 라이브인 영상 수정이라 새 발행은 아니지만, 외부 쓰기라 발행 게이트와 같은 posture 를 쓴다.
  if (!youtubeUploadEnabled()) {
    console.warn(`[worker] distribution.updatemeta ${clipId}: blocked — YouTube 실업로드 비활성`);
    return;
  }
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) { console.warn(`[worker] distribution.updatemeta: clip ${clipId} gone — dropping`); return; }

  const row = (clip.distributions ?? []).find((d: any) => d.channel === "youtube" && d.externalId);
  if (!row?.externalId) {
    console.warn(`[worker] distribution.updatemeta ${clipId}: 발행된 유튜브 영상이 없음(externalId 없음) — 버림`);
    return;
  }
  const videoId = String(row.externalId);
  const channelId = row.youtubeChannelId ? String(row.youtubeChannelId) : undefined;
  if (!channelId) {
    console.warn(`[worker] distribution.updatemeta ${clipId}: youtubeChannelId 없음 — 버림`);
    return;
  }
  const ch = await loadActiveChannel(channelId);
  if (!ch) {
    console.warn(`[worker] distribution.updatemeta ${clipId}: 채널 미연결/재연결 필요 (${channelId}) — 버림`);
    return;
  }

  // 소스: 사용자가 저장한 채널 메타 우선, 없으면 파이프라인 기본.
  const saved = clip.channelMeta?.youtube ?? null;
  const base = metaForChannel(clip, "youtube");
  const title = (String(saved?.title ?? base.title ?? "").trim()) || base.title;
  // ⚠️ 저장본(saved)을 그대로 쓰면 커머스 블록이 **벗겨진다** — metaForChannel 이 붙인 것을
  //    우회하는 경로이기 때문이다. 이미 붙어 있으면 그냥 통과하므로(멱등) 여기서 한 번 더 건다.
  //    안 그러면 "발행 땐 링크가 있었는데 제목 수정 한 번에 링크·대가성 문구가 사라지는" 사고가 난다.
  const description = withCommerceLinks(
    String(saved?.description ?? base.description ?? ""), clip?.commerce?.links, "youtube");
  const tags = Array.isArray(saved?.tags) && saved.tags.length ? saved.tags : base.tags;

  try {
    await withChannelToken(ch, async (token) => {
      const categoryId = (await getVideoCategoryId(token, videoId)) ?? "22";
      await updateVideoMetadata(token, videoId, { title, description, tags, categoryId });
    });
    console.log(`[worker] distribution.updatemeta ${clipId} → youtube ${videoId} 제목/메타 반영 완료`);
  } catch (err) {
    // 재업로드가 아니라 수정이라 실패해도 중복 위험이 없다 — 사유만 남긴다. 자동 재시도 금지(F4-4 ⊘).
    console.error(`[worker] distribution.updatemeta ${clipId} (${videoId}) 실패(재시도 안 함):`,
      err instanceof Error ? err.message : err);
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
    const file = { body, contentType: media.mime || "video/mp4" };
    // targeted 컬럼 write — 잡 시작 스냅샷으로 전체 행을 덮으면 동시 재연결 토큰을 밟는다(B6).
    const persist = (t: { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }) =>
      updateTikTokTokens(acct.openId, t.accessToken, t.refreshToken, t.expiresAt, t.refreshExpiresAt);

    if (tiktokDirectPostEnabled()) {
      // 다이렉트 게시 — 채널에 바로 공개(선행조건: 앱 심사 + video.publish 재연결 · upload-gate.ts).
      const meta = metaForChannel(clip, "tiktok");
      const { publishId, postId, privacyLevel } = await withTikTokToken(acct, persist,
        (token) => uploadDirectPostToTikTok(token, file, { title: meta.title }));
      const url = postId && acct.username
        ? `https://www.tiktok.com/@${acct.username}/video/${postId}` : undefined;
      const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
      await putEntity("clip", clipId, {
        ...fresh,
        distributions: upsertDistribution(fresh.distributions, "tiktok", {
          status: "published", tiktokPublishId: publishId, tiktokOpenId: openId,
          // privacy 를 남긴다 — 미심사(샌드박스) 앱은 SELF_ONLY 로 강제되는데, 기록이 없으면
          // "게시됐는데 남들에겐 안 보임"의 원인을 나중에 찾을 수 없다.
          privacy: privacyLevel,
          ...(postId ? { externalId: postId } : {}), ...(url ? { url } : {}),
          publishedAt: Date.now(), error: undefined,
        }),
      });
      console.log(`[worker] distribution.publish(tiktok) ${clipId} → 다이렉트 게시 ${postId ?? publishId} · ${privacyLevel} (@${acct.username ?? acct.displayName})`);
      return;
    }

    const { publishId } = await withTikTokToken(acct, persist,
      (token) => uploadDraftToTikTok(token, file));

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
  // 폴백은 unlisted — "전체공개는 사람이 정하는 일"(automation-cycle 원칙 주석).
  // 구값 public 은 privacy 를 안 실은 호출(재시도 등)이 전체공개로 승격되는 구멍이었다
  // (2026-08-25 전면 체크 major — dispatch·retry 에 privacy 배선을 넣으며 함께 봉인).
  const privacy = publishAt
    ? "private"
    : (["public", "unlisted", "private"].includes(String(job.payload.privacy))
        ? (String(job.payload.privacy) as "public" | "unlisted" | "private")
        : "unlisted");

  // A future publishAt means YouTube holds the video private until then — report 'scheduled'.
  const finalStatus = publishAt ? "scheduled" : "published";

  // ⚠️ **업로드 성공 후의 이 쓰기가 실패하면 영상은 이미 라이브인데 externalId 를 잃는다** —
  // 그러면 재시도가 그 실패 행을 다시 올려 **같은 영상을 중복 공개**한다(감사 #1). 그래서
  // published 기록은 몇 번 재시도하고, 정상 경로와 catch(후속 실패) 양쪽에서 같은 경로로 부른다.
  const recordPublished = async (videoId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
        const distributions = upsertDistribution(fresh.distributions, "youtube", {
          status: finalStatus, externalId: videoId, youtubeChannelId: channelId, error: undefined,
          // 고객사 화면(aena)이 "무슨 제목으로·언제·어떤 공개범위로 나갔나"를 배포 행만 보고
          // 말할 수 있게 기록한다 — clip.title 은 내부 원제라 실제 업로드 제목(channelMeta)과
          // 다르다(2026-08-25 aena 연동 감사). 타 채널(naver·IG·FB·TikTok)은 이미
          // publishedAt 을 기록하고 있었는데 유튜브만 빠져 있었다.
          title: meta.title, privacy,
          ...(publishAt ? { reserveDate: publishAt } : { publishedAt: Date.now() }),
        });
        await putEntity("clip", clipId, {
          ...fresh, status: "published", publishedVideoId: videoId, distributions,
        });
        return true;
      } catch (e) {
        console.warn(`[worker] distribution.publish ${clipId}: published 기록 실패(시도 ${attempt + 1}/3):`,
          e instanceof Error ? e.message.slice(0, 200) : e);
        await sleep(500 * (attempt + 1));
      }
    }
    return false;
  };

  let uploadedVideoId: string | undefined;
  const meta = metaForChannel(clip, "youtube");
  // 자동배포 리포트 적립 — 게시가 **기록까지 끝난 뒤에만** 부른다(성공·후속실패 양쪽 경로).
  // 메일은 여기서 안 나간다: 순방이 "오늘 몫 완료" 를 판정하면 묶어서 한 통 보낸다
  // (publish-notify.ts · 2026-08-26 리포트 전환). 던지지 않는 함수라 배포 상태 영향 없음.
  const notify = (videoId: string) => recordAutoPublishForReport({
    clip, title: meta.title, channel: "youtube", accountId: channelId,
    // 채널 행의 사람이 읽는 이름은 channelName 이다 — title 로 읽으면 항상 비어서
    // accountId(생 채널 ID)가 리포트 제목줄에 그대로 노출됐다(2026-08-26 ENA 메일).
    channelLabel: String((ch as any)?.channelName ?? "").trim() || undefined,
    videoId, publishAt, clipId,
  });
  try {
    const body = await streamToBuffer(createReadStream(objPath));
    const { videoId } = await withChannelToken(ch, (token) =>
      uploadVideoResumable(
        token,
        { body, contentType: media.mime || "video/mp4" },
        {
          ...meta,
          privacyStatus: privacy,
          publishAt,
        },
      ),
    );
    uploadedVideoId = videoId;   // 이 지점 이후의 어떤 실패도 '실패' 로 찍으면 안 된다(영상은 라이브).

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

    const ok = await recordPublished(videoId);
    if (!ok) {
      console.error(`[worker] distribution.publish ${clipId}: 업로드 성공(${videoId})했으나 published 기록 실패 — `
        + `externalId 유실 위험(수동 확인 필요). 실패로는 찍지 않는다(중복 업로드 방지).`);
      return;
    }
    console.log(`[worker] distribution.publish ${clipId} → youtube ${videoId} (${finalStatus})`);
    await notify(videoId);
  } catch (err: any) {
    // 업로드가 이미 성공했으면(영상이 라이브) **절대 실패로 찍지 않는다** — 실패로 찍으면
    // 재시도가 같은 영상을 중복 업로드한다(#1). externalId 를 살려 published 로 기록한다.
    if (uploadedVideoId) {
      const ok = await recordPublished(uploadedVideoId);
      console.error(`[worker] distribution.publish ${clipId}: 업로드 성공(${uploadedVideoId}) 후 후속 단계 실패 — `
        + `published ${ok ? "기록 완료" : "기록도 실패(externalId 유실 위험 · 수동 확인 필요)"}. 재시도 중복 방지.`,
        err instanceof Error ? err.message.slice(0, 200) : err);
      // 영상은 라이브다 — 담당자 알림도 성공 경로와 똑같이 보낸다(기록이 된 경우에만).
      if (ok) await notify(uploadedVideoId);
      return;
    }
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
  let skipped = 0;
  const now = Date.now();

  for (const ch of channels) {
    if (!shouldSweepChannel(ch, now)) { skipped++; continue; }
    const id = await runWithTenant({ scope: ch.tenantId, via: "system" }, () =>
      enqueue("channel.analyze", { channelId: ch.channelId }, {
        dedupeKey: `channel.analyze:${ch.channelId}`,
      }),
    );
    if (id) queued++;
  }

  // 항상 찍는다 — `queued=0` 도 정보다. 이게 없으면 "게이트가 과하게 막고 있는 것"과
  // "돌 필요가 없는 것"을 구분할 수 없고, 동기화가 멈춘 걸 아무도 모른다.
  console.log(`[worker] sweep queued ${queued}/${channels.length} (skipped ${skipped}: 비활성·not due)`);
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
      try {
        await fanOutYoutubeReconcile();
      } catch (err) {
        console.error("[worker] 예약 확인 팬아웃 실패(다음 주기에 재시도)", err);
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
  // ⚠️ 레인 **이름**으로 판정한다. 예전엔 WORKER_JOBS 문자열 전체를 집합과 비교해서,
  //    조합이 하나 늘 때마다("naver,download,commerce") 목록에서 빠지고 그 순간 이 워커가
  //    쓰지도 않을 YouTube 시크릿을 요구하며 **부팅 즉시 죽었다.**
  // ⚠️ **새 레인을 만들면 여기부터 본다.** render 를 추가한 2026-08-31 에도 똑같이 걸렸다 —
  //    워커가 부팅 즉시 죽는데 작업 스케줄러는 Running 으로 보인다. worker-lanes.test.ts 가
  //    "youtube 잡이 없는 레인은 전부 여기 있어야 한다" 를 강제한다.
  const YT_FREE_LANES = new Set(["naver", "gebd", "download", "commerce", "render"]);
  const NEEDS_YT = SELECTED_LANES.length === 0 || SELECTED_LANES.some((l) => !YT_FREE_LANES.has(l));
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

  // 오래된 완료 잡 정리 — 지우는 코드가 아예 없어 43,231행까지 쌓여 있었다(실측 2026-08-31).
  // 스윕과 같은 레인에서 기동당 한 묶음씩만 지운다: 한 번에 다 지우면 그동안 claim 이 락을
  // 기다린다. 실패해도 잡 처리를 막지 않는다 — 정리는 부수적인 일이다.
  if (RUNS_SWEEP) {
    const pruned = await pruneDoneJobs().catch((e) => {
      console.warn("[worker] job_queue 정리 실패(무시):", e instanceof Error ? e.message : e);
      return 0;
    });
    if (pruned) console.log(`[worker] job_queue 완료 잡 ${pruned}건 정리`);
  }

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
    // 예약 게시 확인도 같이 — 순방과 독립이라 순방이 실패해도 돈다(catch 를 따로 둔 이유).
    try {
      const n = await fanOutYoutubeReconcile();
      if (n > 0) console.log(`[worker] drain 기동 예약 게시 확인 팬아웃 — ${n}개 테넌트`);
    } catch (err) {
      console.error("[worker] drain 예약 확인 팬아웃 실패(다음 기동에 재시도)", err);
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
  // (레인 이름으로 판정 — 예전 `=== "naver"` 비교는 윈도우2 의 실제 값이 "naver,download" 라
  //  **한 번도 돌지 않았다.** 그 PC 에 mp4 가 계속 쌓이고 있었다는 뜻이다.)
  if (SELECTED_LANES.includes("naver")) {
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

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
import {
  initDb,
  listYouTubeChannels,
  getYouTubeChannelByChannelId,
  upsertYouTubeChannel,
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
  type YouTubeChannel,
} from "./db-pg.ts";
import { initQueue, claimJob, completeJob, failJob, requeueStale, enqueue, queueStats, type Job, type JobType } from "./queue.ts";
import { runChannelPipeline } from "./channel-pipeline.ts";
import { runContentAnalyze } from "./content-pipeline.ts";
import {
  withAccessToken,
  fetchVideoAnalytics,
  fetchVideosBatch,
  fetchVideoComments,
  uploadVideoResumable,
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
import { createReadStream, parseObjectPath, fileExists } from "./storage-gcs.ts";
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
const JOB_LANES: Record<"content" | "youtube", JobType[]> = {
  content: ["content.analyze"],
  youtube: ["channel.analyze", "video.analyze", "video.hotwatch", "video.comments", "distribution.publish"],
};
const WORKER_JOBS = (process.env.WORKER_JOBS ?? "all").trim().toLowerCase();
const CLAIM_TYPES: JobType[] | undefined =
  WORKER_JOBS === "content" ? JOB_LANES.content
  : WORKER_JOBS === "youtube" ? JOB_LANES.youtube
  : undefined; // "all" → claim every type
/** The channel sweep enqueues YouTube work, so a content-only worker must not run it. */
const RUNS_SWEEP = WORKER_JOBS !== "content";

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
  return ({ accessToken, expiresAt }) => upsertYouTubeChannel({ ...ch, accessToken, expiresAt });
}

function withChannelToken<T>(ch: YouTubeChannel, call: (token: string) => Promise<T>): Promise<T> {
  return withAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch), call);
}

/** A dead refresh token means the creator must reconnect — park the channel. */
async function markChannelRevoked(channelId: string): Promise<void> {
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (ch) await upsertYouTubeChannel({ ...ch, status: "revoked" });
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
    case "content.analyze": { await runContentAnalyze(String(job.payload.mediaId ?? "")); return; }
    default:
      throw new Error(`unknown job type: ${(job as Job).type}`);
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
  const targets = await listChannelVideos(channelId); // every synced upload
  const now = Date.now();
  let analyzeQueued = 0;
  let commentsQueued = 0;

  for (const v of targets) {
    const ageMs = now - Date.parse(v.publishedAt);
    const fresh = Number.isFinite(ageMs) && ageMs < FRESH_VIDEO_WINDOW_MS;

    const prev = await getVideoAnalytics(v.videoId);
    const interval = fresh ? VIDEO_ANALYZE_FRESH_INTERVAL_MS : VIDEO_ANALYZE_AGED_INTERVAL_MS;
    if (!prev || now - prev.fetchedAt >= interval) {
      const id = await enqueue("video.analyze", { videoId: v.videoId, channelId }, {
        dedupeKey: `video.analyze:${v.videoId}`,
      });
      if (id) analyzeQueued++;
    }

    // Comments only for fresh videos, at most daily.
    if (fresh) {
      const last = await getLatestCommentFetchedAt(v.videoId);
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
  while (!stopping) {
    let job: Job | null = null;
    try {
      job = await claimJob(CLAIM_TYPES);
    } catch (err) {
      console.error("[worker] claim failed", err);
      await sleep(IDLE_POLL_MS);
      continue;
    }

    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    try {
      const followUp = await handle(job);
      await completeJob(job.id);
      // Enqueue any successor only now that this row is 'done', so a self-scheduling
      // job (hotwatch) can reuse its own dedupeKey without colliding with itself.
      if (followUp) {
        const id = await enqueue(followUp.type, followUp.payload, followUp.opts);
        if (!id) console.warn(`[worker] follow-up ${followUp.type} for ${job.id} was deduped`);
      }
    } catch (err: any) {
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

  // Jobs left 'running' by a crashed worker would otherwise sit locked forever.
  const recovered = await requeueStale();
  if (recovered) console.log(`[worker] requeued ${recovered} stale job(s)`);

  console.log("[worker] queue:", JSON.stringify(await queueStats()));

  if (RUNS_SWEEP) await sweepDueChannels();
  const tick = setInterval(() => {
    if (RUNS_SWEEP) void sweepDueChannels().catch((err) => console.error("[worker] sweep failed", err));
    void requeueStale().catch((err) => console.error("[worker] requeue failed", err));
  }, TICK_INTERVAL_MS);

  // Let the in-flight job finish; systemd restarts us either way.
  const shutdown = (sig: string) => {
    console.log(`[worker] ${sig} — finishing current job then exiting`);
    stopping = true;
    clearInterval(tick);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(
    `[worker] lane=${WORKER_JOBS} · claims=${CLAIM_TYPES ? CLAIM_TYPES.join(",") : "all"} · sweep=${RUNS_SWEEP} — polling for jobs`,
  );
  await loop();
  console.log("[worker] stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

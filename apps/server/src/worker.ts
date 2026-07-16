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
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
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
      job = await claimJob();
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

  await sweepDueChannels();
  const tick = setInterval(() => {
    void sweepDueChannels().catch((err) => console.error("[worker] sweep failed", err));
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

  console.log("[worker] polling for jobs");
  await loop();
  console.log("[worker] stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

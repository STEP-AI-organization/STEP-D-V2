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
import { initDb } from "./db-pg.ts";
import { listYouTubeChannels } from "./db-pg.ts";
import { initQueue, claimJob, completeJob, failJob, requeueStale, enqueue, queueStats, type Job } from "./queue.ts";
import { runChannelPipeline } from "./channel-pipeline.ts";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** How long to wait before asking for work again when the queue is empty. */
const IDLE_POLL_MS = 5_000;
/** How often to sweep every channel and enqueue the ones that are due. */
const TICK_INTERVAL_MS = 15 * 60 * 1000;

let stopping = false;

async function handle(job: Job): Promise<void> {
  switch (job.type) {
    case "channel.analyze": {
      const channelId = String(job.payload.channelId ?? "");
      if (!channelId) throw new Error("channel.analyze requires payload.channelId");

      // `force` only on the job enqueued at connect time — the periodic sweep leaves
      // it off so the pipeline's own staleness windows protect the YouTube quota.
      const force = Boolean(job.payload.force);
      const result = await runChannelPipeline(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, channelId, { force });

      if (result.error) throw new Error(result.error);
      console.log(`[worker] ${job.type} ${channelId}`, JSON.stringify(result));
      return;
    }
    default:
      throw new Error(`unknown job type: ${job.type}`);
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
      await handle(job);
      await completeJob(job.id);
    } catch (err: any) {
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

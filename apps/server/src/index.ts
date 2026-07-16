/**
 * STEP-D backend — Hono on Node + PostgreSQL + Cloud Storage (GCS).
 *
 * Production: DATABASE_URL + GCS_BUCKET env vars.
 * Development: local SQLite fallback not used — see db-pg.ts for local PG.
 * Video processing: real ffmpeg (system-installed, baked into Docker image).
 */
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  initDb,
  getState,
  getEntity,
  putEntity,
  prependEntity,
  listMedia,
  getMedia,
  insertMedia,
  mediaPublic,
  listYouTubeChannels,
  getYouTubeChannelByChannelId,
  upsertYouTubeChannel,
  deleteYouTubeChannel,
  listChannelVideos,
  upsertChannelVideo,
  getChannelVideoByVideoId,
  deleteChannelVideo,
  deleteChannelVideosForChannel,
  getUncheckedShortVideoIds,
  setChannelVideoShort,
  countUncheckedShortVideos,
  insertVideoStat,
  getVideoStats,
  getLatestVideoStat,
  getChannelViewTrend,
  getChannelTrendSummary,
  getChannelAnalytics,
  markContentAnalysisPending,
  getContentAnalysis,
  getVideoAnalytics,
  getVideoRetention,
  listVideoComments,
  getPool,
  type MediaRow,
  type YouTubeChannel,
  type ChannelVideo,
} from "./db-pg.ts";
import { hasFfmpeg, probe, captureThumbnail, trimEncode, remuxFaststart, renderShort } from "./ffmpeg.ts";
import { newId } from "./pipeline.ts";
import {
  syncChannelVideos,
  classifyShorts,
  fetchChannelAnalytics,
  withAccessToken,
  refreshChannelToken,
  TokenRevokedError,
  type PersistTokens,
} from "./youtube.ts";
import { SHORTS_PROBE_MAX_PER_SYNC, SHORTS_PROBE_CONCURRENCY } from "./config.ts";
import { runChannelPipeline, runDueChannels } from "./channel-pipeline.ts";
import { initQueue, enqueue, queueStats } from "./queue.ts";
import {
  uploadPath,
  thumbPath,
  clipPath,
  writeFile,
  uploadFile,
  fileSize,
  fileExists,
  createReadStream,
  parseObjectPath,
  useGcs,
  createResumableSession,
  signedReadUrl,
  deleteFile,
  deletePrefix,
} from "./storage-gcs.ts";

// Sync init — no CPU throttling issues on Cloud Run
let dbReady = false;
const FFMPEG = hasFfmpeg();
console.log(`[stepd-server] ffmpeg available: ${FFMPEG}`);

// Init DB in background — don't block server startup
initDb()
  .then(() => initQueue())
  .then(() => { dbReady = true; console.log("[stepd-server] database + queue ready"); })
  .catch((err) => console.error("[stepd-server] database init failed (server still running):", err));
console.log(`[stepd-server] storage mode: ${useGcs() ? "GCS" : "local"}`);

const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: false }));

// ── health ──────────────────────────────────────────────────────────────────
app.get("/health", async (c) => {
  return c.json({ ok: dbReady, ffmpeg: FFMPEG });
});

// ── full state (web InitialData + media) ──────────────────────────────────────
app.get("/api/state", async (c) => c.json(await getState()));

// ── create a program (content root — must exist before any upload) ──
app.post("/api/programs", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title required" }, 400);

  const section =
    typeof body.section === "string" && body.section.trim() ? body.section.trim() : "예능";
  const targetAge = typeof body.targetAge === "number" ? body.targetAge : 0;
  const cast = Array.isArray(body.cast)
    ? body.cast.filter((x: unknown): x is string => typeof x === "string")
    : [];

  // SMR feed metadata (program-level, set once — docs/plans/publish-fields-ux-plan.md §5.1③).
  const smr: { programCode?: string; category?: string; weekdays?: number[] } = {};
  if (typeof body.programCode === "string" && body.programCode.trim()) {
    smr.programCode = body.programCode.trim().toLowerCase();
  }
  if (typeof body.category === "string" && body.category.trim()) {
    smr.category = body.category.trim();
  }
  if (Array.isArray(body.weekdays)) {
    const days = body.weekdays.filter((n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 6);
    if (days.length) smr.weekdays = days;
  }

  const id = newId("p");
  const program = {
    id,
    title,
    section,
    targetAge,
    cast,
    episodeCount: 0,
    status: "active" as const,
    ...(Object.keys(smr).length ? { smr } : {}),
  };
  await prependEntity("program", id, program);
  return c.json({ program });
});

// ── admin: wipe all content (programs/episodes/recommendations/clips + media). Irreversible. ──
app.post("/api/admin/reset", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== "RESET") return c.json({ error: "body.confirm must be 'RESET'" }, 400);

  // Remove stored files first (best-effort) so GCS/local don't accrue orphans.
  const media = await listMedia();
  for (const m of media) {
    try { await deleteFile(parseObjectPath(m.path)); } catch {}
    if (m.thumbPath) { try { await deleteFile(parseObjectPath(m.thumbPath)); } catch {} }
    // Analysis artifacts (scene frames + stage outputs) live under analysis/{mediaId}/.
    try { await deletePrefix(`analysis/${m.id}`); } catch {}
  }

  const pool = getPool();
  await pool.query("DELETE FROM entities WHERE kind IN ('program','episode','recommendation','clip')");
  await pool.query("DELETE FROM media");
  try { await pool.query("DELETE FROM content_analysis"); } catch {}

  return c.json({ ok: true, deletedMedia: media.length });
});

// ── admin: drain the YouTube-analytics job flood + re-kick content.analyze ──
app.post("/api/admin/queue/purge", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== "PURGE") return c.json({ error: "body.confirm must be 'PURGE'" }, 400);
  const pool = getPool();
  const now = Date.now();
  // Drop the video.* backlog (comments/analytics) — safe to delete, re-enqueued on the
  // next channel tick. This is what starves content.analyze.
  const del = await pool.query(
    "DELETE FROM job_queue WHERE type LIKE 'video.%' AND status IN ('pending','failed')",
  );
  // Drop zombie content.analyze jobs whose media no longer exists (e.g. left over from a
  // reset). They fail "media not found" forever and, being oldest, block the real job.
  const dead = await pool.query(
    "DELETE FROM job_queue WHERE type='content.analyze' AND (payload->>'mediaId') NOT IN (SELECT id FROM media)",
  );
  // Free the surviving content.analyze jobs (stuck 'running' from a crash, or waiting) so
  // the worker runs them now.
  const rst = await pool.query(
    "UPDATE job_queue SET status='pending', lockedAt=NULL, runAfter=$1, attempts=0, updatedAt=$1 WHERE type='content.analyze' AND status IN ('running','pending')",
    [now],
  );
  // Guarantee every master media has a runnable analyze job (dedupe skips ones already
  // in flight) — covers the case where the job was lost/never created.
  const masters = await pool.query("SELECT id FROM media WHERE role = 'master'");
  let reQueued = 0;
  for (const m of masters.rows as { id: string }[]) {
    const id = await enqueue("content.analyze", { mediaId: m.id }, { dedupeKey: `content.analyze:${m.id}` });
    if (id) reQueued++;
  }
  return c.json({
    ok: true,
    deletedVideoJobs: del.rowCount ?? 0,
    deletedZombieContentJobs: dead.rowCount ?? 0,
    resetContentJobs: rst.rowCount ?? 0,
    reQueuedContentJobs: reQueued,
  });
});

// ── admin: remux an existing master to progressive mp4 in place (for files uploaded
//    before the ingest remux, or to re-fix a fragmented upload). ──
app.post("/api/admin/remux/:id", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);
  if (!FFMPEG || !useGcs()) return c.json({ error: "ffmpeg + GCS required" }, 400);
  const objPath = parseObjectPath(m.path);
  if (!(await fileExists(objPath))) return c.json({ error: "file not found in storage" }, 404);

  const tmpDir = path.resolve("/tmp/stepd-uploads");
  fs.mkdirSync(tmpDir, { recursive: true });
  const webTmp = path.join(tmpDir, `${m.id}-web.mp4`);
  try {
    const inUrl = await signedReadUrl(objPath);
    await remuxFaststart(inUrl, webTmp);
    await uploadFile(objPath, webTmp);
    return c.json({ ok: true, size: fs.statSync(webTmp).size });
  } catch (e) {
    return c.json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  } finally {
    try { fs.unlinkSync(webTmp); } catch {}
  }
});

// ── video streaming ───────────────────────────────────────────────────────────
app.get("/api/media/:id/stream", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);

  const objPath = parseObjectPath(m.path);
  const exists = await fileExists(objPath);
  if (!exists) return c.json({ error: "media file not found" }, 404);

  // GCS mode: redirect the player straight to a signed Cloud Storage URL and let it stream
  // directly from GCS — native range support, no size cap, CDN-fast. Routing a 74 MB video
  // through the Vercel proxy + Cloud Run chokes (proxy caps large responses). Same principle
  // as direct-to-GCS upload: the bytes should never pass through our servers.
  if (useGcs()) {
    const url = await signedReadUrl(objPath, 6 * 60 * 60 * 1000); // 6h — comfortably covers playback
    return c.redirect(url, 302);
  }

  // Local dev (no GCS): serve the file directly in bounded 206 chunks.
  const size = await fileSize(objPath);
  const range = c.req.header("range");
  const CHUNK = 4 * 1024 * 1024;
  let start = 0;
  let reqEnd = size - 1;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match?.[1]) start = parseInt(match[1], 10);
    if (match?.[2]) reqEnd = parseInt(match[2], 10);
  }
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(reqEnd) || reqEnd >= size) reqEnd = size - 1;
  if (start > reqEnd || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const end = Math.min(reqEnd, start + CHUNK - 1, size - 1);

  const stream = createReadStream(objPath, start, end);
  return new Response(stream, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": m.mime,
      "Cache-Control": "no-store",
    },
  });
});

// ── signed playback URL (browser sets <video src> to this → streams straight from GCS,
//    no proxy/redirect in the byte path; the reliable way to serve media). ──
app.get("/api/media/:id/stream-url", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);
  const objPath = parseObjectPath(m.path);
  if (!(await fileExists(objPath))) return c.json({ error: "media file not found" }, 404);
  if (useGcs()) {
    const url = await signedReadUrl(objPath, 6 * 60 * 60 * 1000); // 6h
    return c.json({ url, direct: true });
  }
  // Local dev: no GCS — fall back to the chunked stream endpoint (web prefixes apiBase).
  return c.json({ url: `/media/${m.id}/stream`, direct: false });
});

// ── thumbnail ─────────────────────────────────────────────────────────────────
app.get("/api/media/:id/thumb", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m || !m.thumbPath) return c.json({ error: "no thumbnail" }, 404);

  const objPath = parseObjectPath(m.thumbPath);
  const exists = await fileExists(objPath);
  if (!exists) return c.json({ error: "no thumbnail" }, 404);

  const stream = createReadStream(objPath);
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" },
  });
});

// ── content analysis result (AI pipeline: transcript + scenes + shorts) ─────────
app.get("/api/media/:id/analysis", async (c) => {
  const row = await getContentAnalysis(c.req.param("id"));
  if (!row) return c.json({ status: "none" }, 404);
  return c.json(row);
});

// ── stored scene frames (uploaded by the worker to analysis/{mediaId}/scene_frames/) ──
// scenes[].frame in the analysis data is "scene_frames/scene_0001.jpg" — the web/Lab
// fetch it here. 404 for pre-persistence analyses (framesStored !== true).
app.get("/api/media/:id/analysis/frames/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^scene_\d+\.jpg$/.test(name)) return c.json({ error: "bad frame name" }, 400);

  const objPath = `analysis/${c.req.param("id")}/scene_frames/${name}`;
  if (!(await fileExists(objPath))) return c.json({ error: "not found" }, 404);

  return new Response(createReadStream(objPath), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" },
  });
});

// ── upload a real video → episode + master media + heuristic recommendations ───
// Shared tail of the upload flow: create the episode, master media row, heuristic
// recommendations, and enqueue content analysis. Both the legacy multipart upload and
// the direct-to-GCS finalize path funnel through here so the two stay in lockstep.
async function buildEpisodeAndMedia(opts: {
  mediaId: string;
  programId: string;
  program: { id: string; title: string; targetAge: number };
  storedPath: string;
  filename: string;
  title: string;
  mime: string;
  size: number;
  meta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean };
  thumbPath: string | null;
}) {
  const { mediaId, programId, program, storedPath, filename, title, mime, size, meta } = opts;

  const state = await getState();
  const episodes = state.episodes as Array<{ programId: string; episodeNumber: number }>;
  const nextEpNum =
    Math.max(0, ...episodes.filter((e) => e.programId === programId).map((e) => e.episodeNumber)) + 1;
  const episodeId = newId("e");
  const today = new Date();
  const broadDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const episode = {
    id: episodeId,
    programId,
    programTitle: program.title,
    episodeNumber: nextEpNum,
    broadDate,
    targetAge: program.targetAge,
    // Truthful status: the AI content pipeline is enqueued, not done. The worker flips
    // this to recommend/done once shorts land (content-pipeline.ts).
    pipeline: { stage: "analyze", stageStatus: "progress", note: "AI 장면 분석 중…", progress: 30 },
  };
  await prependEntity("episode", episodeId, episode);

  const row: MediaRow = {
    id: mediaId,
    episodeId,
    role: "master",
    title,
    filename,
    path: storedPath,
    mime: mime || "video/mp4",
    size,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    codec: meta.codec,
    hasAudio: meta.hasAudio ? 1 : 0,
    thumbPath: opts.thumbPath,
    createdAt: Date.now(),
  };
  await insertMedia(row);

  // No heuristic placeholder recommendations — real segments come from the AI content
  // pipeline (content.analyze) on the worker. Uploads start with an empty recommend board.
  try {
    await markContentAnalysisPending(mediaId);
    await enqueue("content.analyze", { mediaId }, { dedupeKey: `content.analyze:${mediaId}` });
  } catch (err) {
    console.error("[upload] failed to enqueue content.analyze", err);
  }

  return { media: mediaPublic(row), episode, recommendations: [] };
}

// ── large upload, step 1: open a resumable session — bytes go browser → GCS directly ──
// The file never passes through Cloud Run, so the 32 MB request cap, in-memory buffering,
// and the 600 s request timeout no longer apply. Multi-hour masters upload fine.
app.post("/api/media/upload-init", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const programId =
    typeof body.programId === "string" && body.programId ? String(body.programId) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  const filename =
    typeof body.filename === "string" && body.filename ? String(body.filename) : "video.mp4";
  const contentType =
    typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";
  const mediaId = newId("m");
  const ext = path.extname(filename) || ".mp4";
  const objectPath = uploadPath(mediaId, ext);

  // Local dev (no GCS): there is no direct upload target — tell the client to fall back
  // to the legacy multipart /upload endpoint (fine for the small files used in dev).
  if (!useGcs()) return c.json({ mode: "multipart", mediaId, objectPath });

  try {
    const origin = c.req.header("origin") || undefined;
    const sessionUrl = await createResumableSession(objectPath, contentType, origin);
    return c.json({ mode: "resumable", mediaId, objectPath, sessionUrl });
  } catch (err) {
    console.error("[upload-init] resumable session failed", err);
    return c.json({ error: "failed to init upload" }, 500);
  }
});

// ── large upload, step 2: bytes are already in GCS → build episode/media, probe via signed URL ──
app.post("/api/media/finalize", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const mediaId = typeof body.mediaId === "string" ? String(body.mediaId) : "";
  const objectPath = typeof body.objectPath === "string" ? String(body.objectPath) : "";
  if (!mediaId || !objectPath) return c.json({ error: "mediaId and objectPath required" }, 400);
  if (!useGcs()) return c.json({ error: "finalize is GCS-mode only" }, 400);

  const programId =
    typeof body.programId === "string" && body.programId ? String(body.programId) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  // Confirm the object actually landed in GCS before we build rows around it.
  if (!(await fileExists(objectPath))) return c.json({ error: "upload not found in storage" }, 400);

  const filename =
    typeof body.filename === "string" && body.filename ? String(body.filename) : `${mediaId}.mp4`;
  const title = typeof body.title === "string" && body.title ? String(body.title) : filename;
  const mime =
    typeof body.contentType === "string" && body.contentType ? String(body.contentType) : "video/mp4";
  let size =
    typeof body.size === "number" && body.size > 0 ? body.size : await fileSize(objectPath).catch(() => 0);
  const storedPath = `gs://${process.env.GCS_BUCKET}/${objectPath}`;

  // Normalize to a browser-streamable progressive mp4. Uploaded files are often fragmented
  // (fMP4: tiny init moov + moof/mdat fragments) which a plain <video> can't play smoothly.
  // Remux container-only (-c copy, no re-encode → seconds) to moov-at-front progressive and
  // replace the object in place. Size-guarded so Cloud Run's RAM-backed /tmp doesn't OOM;
  // larger masters keep the original (a disk-backed worker remux can cover those later).
  const REMUX_MAX = 1500 * 1024 * 1024; // 1.5 GB
  if (FFMPEG && size > 0 && size <= REMUX_MAX) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const webTmp = path.join(tmpDir, `${mediaId}-web.mp4`);
    try {
      const inUrl = await signedReadUrl(objectPath);
      await remuxFaststart(inUrl, webTmp);
      await uploadFile(objectPath, webTmp); // overwrite fMP4 with progressive
      size = fs.statSync(webTmp).size;
      console.log(`[finalize] remuxed ${mediaId} → progressive mp4 (${size} bytes)`);
    } catch (e) {
      console.error("[finalize] remux failed — keeping original (may not stream if fragmented):", e);
    } finally {
      try { fs.unlinkSync(webTmp); } catch {}
    }
  }

  // Probe + thumbnail by handing ffmpeg a short-lived signed URL. ffmpeg range-reads only
  // the bytes it needs (header for probe, one frame for the thumb) — no multi-GB download,
  // so Cloud Run memory stays flat regardless of source length.
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (FFMPEG) {
    try {
      const readUrl = await signedReadUrl(objectPath);
      meta = await probe(readUrl).catch((e) => {
        console.error("[finalize] probe failed", e);
        return meta;
      });
      const tmpDir = path.resolve("/tmp/stepd-uploads");
      fs.mkdirSync(tmpDir, { recursive: true });
      const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
      try {
        await captureThumbnail(readUrl, Math.max(1, meta.durationSec * 0.1), thumbTmp);
        thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
      } catch (e) {
        console.error("[finalize] thumbnail failed", e);
      } finally {
        // /tmp is RAM-backed on Cloud Run — clear the thumb temp regardless of outcome.
        try { fs.unlinkSync(thumbTmp); } catch {}
      }
    } catch (err) {
      // Most likely the runtime SA lacks signBlob — degrade gracefully (duration 0 → default recs).
      console.error("[finalize] signed-url probe unavailable (grant signBlob to the Cloud Run SA):", err);
    }
  }

  const result = await buildEpisodeAndMedia({
    mediaId, programId, program, storedPath,
    filename, title, mime, size, meta, thumbPath: thumbStored,
  });
  return c.json(result);
});

app.post("/api/media/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);

  const programId = typeof body["programId"] === "string" && body["programId"] ? String(body["programId"]) : "p1";
  const program = await getEntity<{ id: string; title: string; targetAge: number }>("program", programId);
  if (!program) return c.json({ error: "program not found" }, 400);

  const mediaId = newId("m");
  const ext = path.extname(file.name) || ".mp4";
  const buffer = Buffer.from(await file.arrayBuffer());
  const objPath = uploadPath(mediaId, ext);

  // Write to GCS (or local fallback). NOTE: this path buffers the whole file in memory
  // and is subject to Cloud Run's ~32 MB request cap — it's only for small/local uploads.
  // Large masters go through /upload-init + /finalize (direct-to-GCS resumable).
  const storedPath = await writeFile(objPath, buffer);

  // Probe + thumbnail from a local temp copy (ffmpeg reads the filesystem).
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  let thumbStored: string | null = null;
  if (FFMPEG) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${mediaId}${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
    try {
      meta = await probe(tmpPath);
      await captureThumbnail(tmpPath, Math.max(1, meta.durationSec * 0.1), thumbTmp);
      thumbStored = await uploadFile(thumbPath(mediaId), thumbTmp);
    } catch {
      /* probe/thumb are best-effort */
    } finally {
      // /tmp is RAM-backed on Cloud Run — clear both temps even if probe/thumb failed.
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(thumbTmp); } catch {}
    }
  }

  const title = typeof body["title"] === "string" && body["title"] ? String(body["title"]) : file.name;
  const result = await buildEpisodeAndMedia({
    mediaId, programId, program, storedPath,
    filename: file.name, title, mime: file.type || "video/mp4", size: file.size,
    meta, thumbPath: thumbStored,
  });
  return c.json(result);
});

// ── construct F: editorState → reframe dims + ASS overlay ──────────────────────
//
// The web editor authors overlays in a fixed-aspect preview stage (percent positions,
// px font sizes). To bake WYSIWYG we map: position% → output px, and font px → output px
// via a canonical stage size (portrait H≈640, landscape W≈900 — the CSS clamps in
// editor-preview.tsx). ASS PlayRes == output size so \pos maps 1:1.
function renderDims(aspect: string): { W: number; H: number; stageH: number } {
  switch (aspect) {
    case "16:9": return { W: 1920, H: 1080, stageH: (900 * 1080) / 1920 };
    case "1:1":  return { W: 1080, H: 1080, stageH: 900 };
    case "4:5":  return { W: 1080, H: 1350, stageH: 640 };
    case "9:16":
    default:     return { W: 1080, H: 1920, stageH: 640 };
  }
}
/** #RRGGBB → ASS &H00BBGGRR (opaque). */
function hexToAss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  if (!m) return "&H00FFFFFF&";
  return `&H00${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}`.toUpperCase() + "&";
}
function assEscape(text: string): string {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/[{}]/g, (ch) => "\\" + ch).replace(/\r?\n/g, "\\N");
}
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}
/**
 * Window a master-timeline transcript ({start,end,text} seconds) to a render window and
 * rebase to render-relative seconds (0-based). Keeps only segments that overlap
 * [winStart, winEnd] and carry text — the spoken subtitles that belong on this clip.
 */
function windowCaptions(
  transcript: unknown,
  winStart: number,
  winEnd: number,
): { start: number; end: number; text: string }[] {
  if (!Array.isArray(transcript)) return [];
  const dur = winEnd - winStart;
  const out: { start: number; end: number; text: string }[] = [];
  for (const s of transcript) {
    const st = Number((s as any)?.start);
    const en = Number((s as any)?.end);
    const text = String((s as any)?.text ?? "").trim();
    if (!text || !isFinite(st) || !isFinite(en) || en <= winStart || st >= winEnd) continue;
    const rs = Math.max(0, st - winStart);
    const re = Math.min(dur, en - winStart);
    if (re > rs + 0.05) out.push({ start: rs, end: re, text });
  }
  return out;
}

/**
 * Build an ASS file to burn at render time — the EditorState overlays (title/channel/
 * elements, Default style) PLUS the STT caption track (spoken subtitles, Caption style,
 * bottom-center per shorts convention). `captions` are render-relative seconds (see
 * windowCaptions). Returns null when there is nothing to burn. This is what replaces the
 * preview's static sample caption with the real transcript.
 */
function buildEditorAss(
  es: any,
  W: number,
  H: number,
  stageH: number,
  durSec: number,
  captions?: { start: number; end: number; text: string }[],
): string | null {
  const scale = H / stageH;
  const end = assTime(durSec);
  const ev: string[] = [];
  const put = (an: number, x: number, y: number, fs: number, color: string, bord: number, bordColor: string, text: string) =>
    ev.push(`Dialogue: 0,0:00:00.00,${end},Default,,0,0,0,,{\\an${an}\\pos(${x},${y})\\fs${fs}\\c${color}\\b1\\bord${bord}\\3c${bordColor}\\shad1}${assEscape(text)}`);

  if (es && typeof es === "object") {
    let yOff = 0;
    for (const t of Array.isArray(es.titleLines) ? es.titleLines : []) {
      if (!t?.text?.trim()) continue;
      const fs = Math.max(12, Math.round((t.size ?? 30) * scale));
      const x = Math.round(((es.titleX ?? 50) / 100) * W);
      const y = Math.round(((es.titleY ?? 8) / 100) * H) + yOff;
      const an = es.titleAlign === "left" ? 7 : es.titleAlign === "right" ? 9 : 8;
      put(an, x, y, fs, hexToAss(t.color ?? "#FFFFFF"), 2, "&H00000000&", t.text);
      yOff += Math.round(fs * 1.15);
    }
    if (es.showChannel && es.channelName?.trim()) {
      const fs = Math.max(12, Math.round(14 * scale * 1.2));
      put(8, Math.round(0.5 * W), Math.round(((es.channelY ?? 82) / 100) * H), fs, "&H00FFFFFF&", 2, "&H00000000&", "▶ " + es.channelName);
    }
    for (const el of Array.isArray(es.elements) ? es.elements : []) {
      if (!el?.text?.trim()) continue;
      const fs = Math.max(12, Math.round((el.size ?? (el.type === "arrow" ? 40 : 14)) * scale));
      put(5, Math.round(((el.x ?? 50) / 100) * W), Math.round(((el.y ?? 50) / 100) * H), fs, "&H0016120D&", 3, "&H00FFFFFF&", el.text);
    }
  }

  // STT captions — bottom-center Caption style. On unless editorState explicitly turns
  // them off (captionsOn === false). karaoke \k needs word timings; refined transcript is
  // sentence-level, so we show one Dialogue per segment.
  const capOn = es && typeof es === "object" ? es.captionsOn !== false : true;
  if (capOn) {
    for (const cap of Array.isArray(captions) ? captions : []) {
      const text = String(cap.text ?? "").trim();
      if (!text || !(cap.end > cap.start)) continue;
      ev.push(`Dialogue: 0,${assTime(cap.start)},${assTime(cap.end)},Caption,,0,0,0,,${assEscape(text)}`);
    }
  }

  if (!ev.length) return null;
  const capFs = Math.round(H * 0.042);
  const capMV = Math.round(H * 0.14);
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,Noto Sans CJK KR,48,&H00FFFFFF,&H00000000,&H00000000,1,1,2,1,5,20,20,20,1\n` +
    `Style: Caption,Noto Sans CJK KR,${capFs},&H00FFFFFF,&H00000000,&H80000000,1,1,3,1,2,60,60,${capMV},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    ev.join("\n") + "\n"
  );
}

/**
 * Render one clip's segment into the final deliverable — the ONE expensive render (plan
 * §2.4 deferred-render invariant), called only from /clips/:id/export. Reframes to the
 * chosen aspect (blur-cover 9:16) and burns the editorState overlays via libass. A plain
 * 16:9 highlight with no overlay takes the cheap trim path. Returns the new clip media +
 * probe metadata, or null if the master is missing / the render fails.
 */
async function renderClipMedia(opts: {
  master: MediaRow;
  episodeId: string;
  startTime: number;
  endTime: number;
  title: string;
  editorState?: any;
  aspect?: string;
  captions?: { start: number; end: number; text: string }[];
}): Promise<
  | { clipMediaId: string; clipStored: string; thumbStored: string | null;
      cmeta: { durationSec: number; width: number; height: number; codec: string; hasAudio: boolean } }
  | null
> {
  const { master, episodeId, startTime, endTime, title, editorState } = opts;
  const aspect = opts.aspect ?? editorState?.aspect ?? "9:16";
  const masterObjPath = parseObjectPath(master.path);
  if (!(await fileExists(masterObjPath))) return null;

  const tmpDir = path.resolve("/tmp/stepd-clips");
  fs.mkdirSync(tmpDir, { recursive: true });
  const clipMediaId = newId("m");
  const clipObjPath = clipPath(clipMediaId);
  const tmpPath = path.join(tmpDir, `${clipMediaId}.mp4`);
  const thumbTmp = path.join(tmpDir, `${clipMediaId}.jpg`);
  const assTmp = path.join(tmpDir, `${clipMediaId}.ass`);

  const { W, H, stageH } = renderDims(aspect);
  const ass = buildEditorAss(editorState, W, H, stageH, endTime - startTime, opts.captions);
  if (ass) fs.writeFileSync(assTmp, ass, "utf-8");

  // ffmpeg reads the master directly. For GCS we hand it a short-lived signed URL and seek
  // via HTTP range (-ss before -i) — only the requested segment is fetched, so a multi-hour
  // master never lands in Cloud Run's RAM.
  const srcPath = useGcs() ? await signedReadUrl(masterObjPath) : master.path;
  try {
    if (!ass && aspect === "16:9") {
      await trimEncode(srcPath, startTime, endTime, tmpPath);
    } else {
      await renderShort({ inputPath: srcPath, startTime, endTime, outputPath: tmpPath, width: W, height: H, assPath: ass ? assTmp : null });
    }
    const cmeta = await probe(tmpPath).catch(() => ({
      durationSec: Math.max(1, endTime - startTime), width: W, height: H, codec: "h264", hasAudio: true,
    }));
    const clipStored = await uploadFile(clipObjPath, tmpPath);

    await captureThumbnail(tmpPath, Math.min(1, cmeta.durationSec / 2), thumbTmp).catch(() => {});
    let thumbStored: string | null = null;
    if (fs.existsSync(thumbTmp)) thumbStored = await uploadFile(thumbPath(clipMediaId), thumbTmp);

    const cRow: MediaRow = {
      id: clipMediaId, episodeId, role: "clip", title,
      filename: `${title}.mp4`, path: clipStored, mime: "video/mp4",
      size: fs.statSync(tmpPath).size, durationSec: cmeta.durationSec,
      width: cmeta.width, height: cmeta.height, codec: cmeta.codec, hasAudio: cmeta.hasAudio ? 1 : 0,
      thumbPath: thumbStored, createdAt: Date.now(),
    };
    await insertMedia(cRow);
    return { clipMediaId, clipStored, thumbStored, cmeta };
  } catch (err) {
    console.error("[render] render failed:", err);
    return null;
  } finally {
    // /tmp is RAM-backed on Cloud Run — always clear the temps.
    try { fs.unlinkSync(tmpPath); } catch {}
    try { fs.unlinkSync(thumbTmp); } catch {}
    try { fs.unlinkSync(assTmp); } catch {}
  }
}

// ── adopt recommendation → clip (METADATA ONLY — no render, plan §2.4) ─────────
//
// Adopt confirms the segment + decision; it does NOT encode. The expensive 9:16 +
// subtitle bake happens exactly once, later, at /clips/:id/export. Until then the
// editor previews the segment by streaming the master windowed to [startTime,endTime]
// (editor-shell falls back to sourceMediaId / master when clip.mediaId is absent).
app.post("/api/recommendations/:id/adopt", async (c) => {
  const recId = c.req.param("id");
  const rec = await getEntity<any>("recommendation", recId);
  if (!rec) return c.json({ error: "recommendation not found" }, 404);
  if (rec.status !== "pending") return c.json({ clipId: rec.adoptedClipId });

  const episode = await getEntity<any>("episode", rec.episodeId);
  const allMedia = await listMedia();
  const master = allMedia.find((m) => m.episodeId === rec.episodeId && m.role === "master");
  const chosen = rec.thumbnailCandidates?.find((t: any) => t.id === rec.selectedThumbnailId) ?? rec.thumbnailCandidates?.[0];

  const clipId = newId("c");
  const clip: any = {
    id: clipId,
    episodeId: rec.episodeId,
    programTitle: episode?.programTitle ?? "",
    title: rec.title,
    clipType: rec.kind === "short" ? "T6" : "TZ",
    targetAge: episode?.targetAge ?? 0,
    aspectRatio: rec.kind === "short" ? "9:16-crop-main" : "16:9",
    durationSec: Math.max(1, rec.endTime - rec.startTime),
    thumbnailLabel: chosen?.label,
    thumbnailUrl: rec.thumbnailUrl,
    synopsis: rec.editNote ?? undefined,
    // Decision-only state: not yet rendered. Segment + source drive render-free preview
    // and the later single render.
    status: "editing",
    rendered: false,
    startTime: rec.startTime,
    endTime: rec.endTime,
    sourceMediaId: master?.id,
    sourceRecommendationId: rec.id,
    distributions: [],
  };

  await prependEntity("clip", clipId, clip);
  await putEntity("recommendation", recId, { ...rec, status: "adopted", adoptedClipId: clipId });
  return c.json({ clipId, clip });
});

// ── reject recommendation ─────────────────────────────────────────────────────
app.post("/api/recommendations/:id/reject", async (c) => {
  const recId = c.req.param("id");
  const rec = await getEntity<any>("recommendation", recId);
  if (!rec) return c.json({ error: "recommendation not found" }, 404);
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({ reason: "기타" }));
  await putEntity("recommendation", recId, { ...rec, status: "rejected", rejectReason: reason ?? "기타" });
  return c.json({ ok: true });
});

// ── publish clips to one channel ──────────────────────────────────────────────
app.post("/api/distributions/publish", async (c) => {
  const b = await c.req.json<{
    clipIds: string[];
    channel: string;
    reserveDate?: string;
    scheduled?: boolean;
    platforms?: string[];
  }>();
  const status = b.scheduled ? "scheduled" : "published";
  // Only rendered clips ship (plan §2.4: distribution consumes the final render, never a
  // draft). A clip is renderable-shipped once it has an encoded media (mediaId) or is
  // already live. Un-rendered adopts are skipped and reported so the caller can prompt export.
  const skipped: string[] = [];
  for (const clipId of b.clipIds) {
    const clip = await getEntity<any>("clip", clipId);
    if (!clip) continue;
    const isRendered = clip.rendered === true || Boolean(clip.mediaId) || clip.status === "published";
    if (!isRendered) { skipped.push(clipId); continue; }
    const dists = [...(clip.distributions ?? [])];
    const value: any = { channel: b.channel, status, reserveDate: b.reserveDate, error: undefined };
    if (b.channel === "meta" && b.platforms) value.platforms = b.platforms;
    const existing = dists.find((d: any) => d.channel === b.channel);
    if (existing) Object.assign(existing, value);
    else dists.push(value);
    await putEntity("clip", clipId, { ...clip, status: "published", distributions: dists });
  }
  return c.json({ ok: true, ...(skipped.length ? { skipped } : {}) });
});

// ── retry a failed distribution ───────────────────────────────────────────────
app.post("/api/distributions/retry", async (c) => {
  const b = await c.req.json<{ clipId: string; channel: string }>();
  const clip = await getEntity<any>("clip", b.clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);
  const dists = (clip.distributions ?? []).map((d: any) =>
    d.channel === b.channel ? { ...d, status: "published", error: undefined } : d,
  );
  await putEntity("clip", b.clipId, { ...clip, distributions: dists });
  return c.json({ ok: true });
});

// ── link a clip to the YouTube video it was published as ──────────────────────
//
// The minimal join between our clip metadata and the per-video YouTube metrics
// (video_analytics / video_retention / video_comments). Manual for now — pass the
// published videoId; pass null/"" to unlink. We don't require the video to be synced
// yet, so `videoKnown` tells the caller whether metrics already exist for it.
app.patch("/api/clips/:id/link-video", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const body = await c.req.json<{ videoId?: string | null }>().catch(() => ({ videoId: undefined }));
  if (!("videoId" in body)) return c.json({ error: "videoId is required" }, 400);

  const videoId = body.videoId ? String(body.videoId).trim() : null;
  const videoKnown = videoId ? Boolean(await getChannelVideoByVideoId(videoId)) : false;

  await putEntity("clip", clipId, { ...clip, publishedVideoId: videoId });
  return c.json({ ok: true, clipId, publishedVideoId: videoId, videoKnown });
});

// ── persist the editor's decision blob (revision JSON) ────────────────────────
//
// Save = metadata only, never a render (plan §2.4 deferred-render invariant). We store
// the whole EditorState on the clip entity; the actual 9:16 + subtitle bake happens
// once, later, at final export. Reopening the editor restores from this.
app.patch("/api/clips/:id/editor", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const body = await c.req.json<{ editorState?: unknown }>().catch(() => ({ editorState: undefined }));
  if (typeof body.editorState !== "object" || body.editorState === null) {
    return c.json({ error: "editorState is required" }, 400);
  }

  await putEntity("clip", clipId, { ...clip, editorState: body.editorState });
  return c.json({ ok: true, clipId });
});

// ── export/render a clip → the single expensive render (plan §2.4) ────────────
//
// The ONLY place ffmpeg bakes the deliverable. Idempotent: a render-revision hash of
// the operator's decisions (segment + aspect + editorState) caches the result, so
// re-confirming identical decisions returns the existing render instead of re-encoding.
// (v1 trims the segment; the 9:16 reframe + ASS subtitle bake — construct F — layers in
//  here later without changing this contract.)
app.post("/api/clips/:id/export", async (c) => {
  const clipId = c.req.param("id");
  const clip = await getEntity<any>("clip", clipId);
  if (!clip) return c.json({ error: "clip not found" }, 404);

  const start = Number(clip.startTime ?? 0);
  const end = Number(clip.endTime ?? start + (clip.durationSec ?? 0));
  if (!(end > start)) return c.json({ error: "clip has no valid segment to render" }, 400);

  // STT transcript for the master (spoken subtitles). Segments are master-timeline seconds;
  // we window them to the render range below. A fingerprint (count + updatedAt) goes into the
  // revision hash so a re-transcribe invalidates the cached render.
  const ca = clip.sourceMediaId ? await getContentAnalysis(clip.sourceMediaId) : undefined;
  const transcript = (ca?.data as any)?.transcript;
  const captionsFp = { n: Array.isArray(transcript) ? transcript.length : 0, u: ca?.updatedAt ?? 0 };

  const revision = crypto
    .createHash("sha256")
    .update(JSON.stringify({ start, end, aspectRatio: clip.aspectRatio, editorState: clip.editorState ?? null, captionsFp }))
    .digest("hex")
    .slice(0, 16);

  // Cache hit: identical decisions already rendered — don't re-encode.
  if (clip.rendered && clip.renderRevision === revision && clip.mediaId) {
    return c.json({ clipId, clip, cached: true });
  }

  const allMedia = await listMedia();
  const master =
    (clip.sourceMediaId ? allMedia.find((m) => m.id === clip.sourceMediaId) : undefined) ??
    allMedia.find((m) => m.episodeId === clip.episodeId && m.role === "master");
  if (!master || !FFMPEG) {
    return c.json({ error: "no master video or ffmpeg unavailable to render" }, 409);
  }

  // Apply the editor's fine trim within the adopted segment (trimIn/trimOut are relative to
  // the segment). Clamp so the render never escapes [start, end] — the AI-selected window is
  // the outer bound; F just reflects the editor's decisions inside it (§2.4).
  const es = clip.editorState;
  const segLen = end - start;
  const inRel = Math.min(Math.max(0, Number(es?.trimIn ?? 0)), Math.max(0, segLen - 0.1));
  const outRel = Math.min(Math.max(inRel + 0.1, Number(es?.trimOut ?? segLen)), segLen);
  const renderStart = start + inRel;
  const renderEnd = start + outRel;

  // Spoken subtitles that fall inside the render window, rebased to 0.
  const captions = windowCaptions(transcript, renderStart, renderEnd);

  const rendered = await renderClipMedia({
    master, episodeId: clip.episodeId,
    startTime: renderStart, endTime: renderEnd,
    title: clip.title, editorState: es, aspect: es?.aspect, captions,
  });
  if (!rendered) return c.json({ error: "render failed" }, 500);

  const next = {
    ...clip,
    status: "ready",
    rendered: true,
    renderRevision: revision,
    mediaId: rendered.clipMediaId,
    sourceMediaId: master.id,
    videoUrl: `/media/${rendered.clipMediaId}/stream`,
    durationSec: rendered.cmeta.durationSec || clip.durationSec,
  };
  await putEntity("clip", clipId, next);
  return c.json({ clipId, clip: next });
});

// ── YouTube OAuth & channel management ────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 4000);

/**
 * Two consent modes, two scope sets.
 *
 * analytics — an external creator connecting their own channel so we can read its
 *   metrics. Read-only on purpose: these refresh tokens sit in our DB, and a leaked
 *   write-scoped token would let an attacker edit or delete a partner's videos.
 * publish — our own channels, which we upload to.
 */
export type ConsentMode = "analytics" | "publish";

const YT_ANALYTICS_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly", // channel + video metadata (Data API)
  "https://www.googleapis.com/auth/yt-analytics.readonly", // watch time, traffic, demographics
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly", // revenue (monetized channels only)
].join(" ");

const YT_PUBLISH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.channel-memberships.creator",
].join(" ");

/** Analytics needs this scope; channels connected before the split won't have it. */
const YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/** Must byte-match a redirect URI registered on the OAuth client in GCP. */
const OAUTH_CALLBACK_PATH = "/api/youtube/oauth/callback";

function redirectUri(): string {
  return `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}${OAUTH_CALLBACK_PATH}`;
}

function scopesFor(mode: ConsentMode): string {
  return mode === "publish" ? YT_PUBLISH_SCOPES : YT_ANALYTICS_SCOPES;
}

function googleAuthUrl(state: string, mode: ConsentMode): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopesFor(mode),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>;
}

async function fetchYtChannelInfo(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`YouTube API failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string } }[] };
  if (!data.items?.length) throw new Error("No YouTube channel found for this account");
  const ch = data.items[0];
  return {
    channelId: ch.id,
    channelName: ch.snippet.title,
    thumbnail: ch.snippet.thumbnails?.default?.url ?? null,
    subscribers: ch.statistics?.subscriberCount ?? "0",
  };
}


interface OAuthState {
  channel?: string;
  mode?: ConsentMode;
  /** Where to send the browser after connecting — the page the flow started from. */
  return?: string;
}

function decodeState(raw: string | undefined): OAuthState {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString()) as OAuthState;
  } catch {
    return {};
  }
}

/**
 * Only allow same-site relative paths as a post-OAuth destination, so a crafted
 * `return` can't turn this into an open redirect. Anything else falls back to
 * /register (the external-creator landing page).
 */
function safeReturn(path: string | undefined): string {
  if (path && /^\/[A-Za-z0-9/_-]*$/.test(path) && !path.startsWith("//")) return path;
  return "/register";
}

app.get("/api/youtube/auth", (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
  const channelUrl = c.req.query("channel") ?? "";
  const mode: ConsentMode = c.req.query("mode") === "publish" ? "publish" : "analytics";
  const returnTo = safeReturn(c.req.query("return"));
  const state = Buffer.from(JSON.stringify({ channel: channelUrl, mode, return: returnTo })).toString("base64");
  return c.redirect(googleAuthUrl(state, mode));
});

const oauthCallback = async (c: Context) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const st = decodeState(c.req.query("state"));
  const returnTo = safeReturn(st.return);

  if (error) return c.redirect(`${returnTo}?error=access_denied`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    const tokens = await exchangeCode(code);
    const channelInfo = await fetchYtChannelInfo(tokens.access_token);
    const channel: YouTubeChannel = {
      id: channelInfo.channelId,
      channelId: channelInfo.channelId,
      channelName: channelInfo.channelName,
      channelUrl: st.channel || null,
      thumbnail: channelInfo.thumbnail,
      subscribers: channelInfo.subscribers,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
      email: null,
      status: "active",
      connectedAt: Date.now(),
    };

    await upsertYouTubeChannel(channel);

    // Channel-level analysis (video sync + daily analytics + revenue) is light, so run it
    // HERE on Cloud Run, awaited inside the request — CPU is available while we haven't
    // responded yet (the throttle only hits work left running after the response). This
    // keeps it off the shared worker queue, which is reserved for the heavy per-video and
    // content jobs, so a fresh connect isn't stuck behind that backlog.
    try {
      await runChannelPipeline(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, channel.channelId, { force: true });
    } catch (err) {
      console.error("[oauth/callback] inline channel analysis failed; worker will retry", err);
    }
    // Fan out the heavy part — per-video analytics for every upload — to the worker. force
    // is off: if the inline run above already synced, the worker skips the re-sync and just
    // enqueues the per-video jobs; if it failed, the channel is still due so the worker runs it.
    await enqueue("channel.analyze", { channelId: channel.channelId, force: false }, {
      dedupeKey: `channel.analyze:${channel.channelId}`,
    });

    const params = new URLSearchParams({ success: "1", channelId: channel.channelId, channelName: channel.channelName });
    return c.redirect(`${returnTo}?${params}`);
  } catch (err: any) {
    console.error("[oauth/callback]", err);
    return c.redirect(`${returnTo}?error=${encodeURIComponent(err.message)}`);
  }
};

// The path registered in GCP. The bare /callback is kept so links already sent out
// (and the legacy client config) keep working.
app.get(OAUTH_CALLBACK_PATH, oauthCallback);
app.get("/api/youtube/callback", oauthCallback);

app.get("/api/youtube/channels", async (c) => {
  const channels = (await listYouTubeChannels()).map((ch: YouTubeChannel) => ({
    channelId: ch.channelId,
    channelName: ch.channelName,
    channelUrl: ch.channelUrl,
    thumbnail: ch.thumbnail,
    subscribers: ch.subscribers,
    status: ch.status,
    connectedAt: ch.connectedAt,
    email: ch.email,
    // Progress signals so the onboarding flow knows when the analyze job settled
    // (and can finish fast on channels that simply have no uploads).
    lastSyncedAt: ch.lastSyncedAt ?? null,
    lastAnalyzedAt: ch.lastAnalyzedAt ?? null,
    // Did this channel's consent include the revenue (monetary) scope? Lets the UI tell
    // "connected without revenue permission" apart from "has permission but $0 revenue".
    hasMonetaryScope: (ch.scope ?? "").includes("yt-analytics-monetary.readonly"),
    lastError: ch.lastError ?? null,
  }));
  return c.json({ channels });
});

app.delete("/api/youtube/channels/:channelId", async (c) => {
  await deleteYouTubeChannel(c.req.param("channelId"));
  return c.json({ ok: true });
});

app.post("/api/youtube/refresh", async (c) => {
  const { channelId } = await c.req.json<{ channelId: string }>();
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token" }, 400);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    await refreshChannelToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch));
    return c.json({ ok: true, expiresAt: ch.expiresAt });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    return c.json({ error: err.message }, 500);
  }
});

// ── YouTube Analytics (channel analysis) ─────────────────────────────────

/** YYYY-MM-DD, `days` ago (Analytics API only accepts this format). */
function isoDay(days = 0): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Writes a refreshed access token (and its expiry) back to the channel row. */
function persistTokensFor(ch: YouTubeChannel): PersistTokens {
  return ({ accessToken, expiresAt }) =>
    upsertYouTubeChannel({ ...ch, accessToken, expiresAt });
}

/** A dead refresh token means the creator must reconnect — park the channel. */
async function markRevoked(ch: YouTubeChannel): Promise<void> {
  await upsertYouTubeChannel({ ...ch, status: "revoked" });
}

/**
 * Channel analysis report. Defaults to the last 90 days broken down by day.
 *
 *   GET /api/youtube/analytics/:channelId
 *       ?start=2026-01-01&end=2026-07-14
 *       &dimensions=day|video|insightTrafficSourceType|ageGroup,gender
 *       &metrics=views,estimatedMinutesWatched,...
 */
app.get("/api/youtube/analytics/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token for this channel" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  // Channels connected before the scope split have no analytics grant — Google would
  // answer 403, so say plainly that the creator has to reconnect.
  if (ch.scope && !ch.scope.includes(YT_ANALYTICS_SCOPE)) {
    return c.json({
      error: "channel_needs_reconsent",
      message: "This channel was connected without the analytics scope. Ask the creator to reconnect via /register.",
      scope: ch.scope,
    }, 409);
  }

  try {
    const report = await withAccessToken(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      ch,
      persistTokensFor(ch),
      (accessToken) =>
        fetchChannelAnalytics(accessToken, {
          startDate: c.req.query("start") ?? isoDay(90),
          endDate: c.req.query("end") ?? isoDay(0),
          dimensions: c.req.query("dimensions") ?? "day",
          metrics: c.req.query("metrics") ?? undefined,
          sort: c.req.query("sort") ?? undefined,
          maxResults: Number(c.req.query("maxResults")) || undefined,
        }),
    );
    return c.json({ channelId, channelName: ch.channelName, ...report });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    console.error("[youtube/analytics]", err);
    return c.json({ error: err.message }, 500);
  }
});

// ── Analysis pipeline (scheduler-driven) ─────────────────────────────────

/**
 * Cloud Scheduler hits this. Runs every channel that is due — and a freshly
 * connected channel is always due, so this also catches anything the on-connect
 * kick failed to finish before Cloud Run throttled it.
 *
 * The service is IAM-protected (no public invoker), so the scheduler's OIDC token
 * is the auth; there is no separate shared secret to leak.
 */
app.post("/api/youtube/pipeline/run", async (c) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  const started = Date.now();
  const results = await runDueChannels(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  const ran = results.filter((r) => !r.skipped);

  console.log(`[pipeline/run] ${ran.length}/${results.length} channels in ${Date.now() - started}ms`);
  return c.json({
    ok: true,
    channels: results.length,
    ran: ran.length,
    tookMs: Date.now() - started,
    results,
  });
});

/** Queue a single channel for the worker to pick up now. */
app.post("/api/youtube/pipeline/run/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const jobId = await enqueue("channel.analyze", { channelId, force: true }, {
    dedupeKey: `channel.analyze:${channelId}`,
  });
  return c.json({
    ok: true,
    channelId,
    jobId,
    queued: jobId !== null,
    note: jobId ? "queued" : "a run for this channel is already in flight",
  });
});

/** Queue depth — the quickest way to tell whether the worker VM is alive. */
app.get("/api/queue/stats", async (c) => c.json(await queueStats()));

/** Stored daily analytics for a channel — served from our DB, not YouTube. */
app.get("/api/youtube/analytics/:channelId/daily", async (c) => {
  const channelId = c.req.param("channelId");
  const days = Number(c.req.query("days")) || 90;
  const fromDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await getChannelAnalytics(channelId, fromDay);
  return c.json({ channelId, days: rows.length, rows });
});

// ── YouTube video sync & trends ──────────────────────────────────────────

app.post("/api/youtube/sync/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token for this channel" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    // syncChannelVideos refreshes and persists the token itself (expiry included).
    const result = await syncChannelVideos(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch, persistTokensFor(ch));

    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const v of result.videos) {
      const existing = await getChannelVideoByVideoId(v.videoId);
      const cv: ChannelVideo = {
        id: existing?.id ?? `cv_${v.videoId}`,
        channelId,
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        thumbnail: v.thumbnail,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
        lastSynced: now,
      };
      await upsertChannelVideo(cv);

      const lastStat = await getLatestVideoStat(v.videoId);
      if (!lastStat || (now - lastStat.snapshotAt) > 3_600_000) {
        await insertVideoStat({
          id: `vs_${v.videoId}_${now}`,
          videoId: v.videoId,
          channelId,
          snapshotAt: now,
          viewCount: v.viewCount,
          likeCount: v.likeCount,
          commentCount: v.commentCount,
        });
      }

      if (existing) updated++;
      else inserted++;
    }

    // Verify Shorts by probing youtube.com/shorts/<id> — the Data API has no Shorts flag
    // and duration is unreliable. Cached per video (shortCheckedAt), so this only probes
    // not-yet-classified uploads; a large backlog spreads across successive syncs.
    const uncheckedIds = await getUncheckedShortVideoIds(channelId, SHORTS_PROBE_MAX_PER_SYNC);
    const verdicts = await classifyShorts(uncheckedIds, SHORTS_PROBE_CONCURRENCY);
    for (const [videoId, isShort] of verdicts) {
      await setChannelVideoShort(videoId, isShort, now);
    }
    const shortsPending = await countUncheckedShortVideos(channelId);

    return c.json({
      ok: true,
      channelId,
      videoCount: result.videos.length,
      inserted,
      updated,
      snapshotCount: result.videos.length,
      shortsClassified: verdicts.size,
      shortsPending,
    });
  } catch (err: any) {
    if (err instanceof TokenRevokedError) {
      await markRevoked(ch);
      return c.json({ error: "revoked", message: "Refresh token is no longer valid — the channel must be reconnected." }, 409);
    }
    console.error("[sync]", err);
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/youtube/videos/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);

  const videos = await listChannelVideos(channelId);
  return c.json({ channelId, channelName: ch.channelName, videoCount: videos.length, videos });
});

app.get("/api/youtube/trends/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);

  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const trend = await getChannelViewTrend(channelId, days);
  const summary = await getChannelTrendSummary(channelId, days);

  return c.json({
    channelId,
    channelName: ch.channelName,
    days,
    trend,
    summary,
  });
});

app.get("/api/youtube/trends/video/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const video = await getChannelVideoByVideoId(videoId);
  if (!video) return c.json({ error: "video not found" }, 404);

  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const stats = await getVideoStats(videoId, days);

  const dailyData = new Map<string, { views: number; likes: number; comments: number }>();
  for (const s of stats) {
    // snapshotAt is BIGINT → node-postgres returns it as a string; new Date(str) would be
    // Invalid Date and .toISOString() throws (500). Coerce to number (infra.md §3 함정2).
    const date = new Date(Number(s.snapshotAt)).toISOString().slice(0, 10);
    dailyData.set(date, {
      views: Number(s.viewCount),
      likes: Number(s.likeCount),
      comments: Number(s.commentCount),
    });
  }

  const trend = Array.from(dailyData.entries()).map(([date, d]) => ({
    date,
    ...d,
  }));

  return c.json({ video, trend });
});

/**
 * Everything the video.analyze / video.comments jobs collected for one upload, served
 * from our DB (no live YouTube call). Empty sections just mean the job hasn't run yet
 * or YouTube had no data for that report.
 */
app.get("/api/youtube/videos/:videoId/analytics", async (c) => {
  const videoId = c.req.param("videoId");
  const video = await getChannelVideoByVideoId(videoId);
  if (!video) return c.json({ error: "video not found" }, 404);

  const [analytics, retention, comments] = await Promise.all([
    getVideoAnalytics(videoId),
    getVideoRetention(videoId),
    listVideoComments(videoId),
  ]);

  return c.json({
    video,
    summary: analytics?.summary ?? {},
    trafficSources: analytics?.trafficSources ?? [],
    demographics: analytics?.demographics ?? [],
    retention: retention?.curve ?? [],
    comments,
    fetchedAt: analytics?.fetchedAt ?? null,
  });
});

app.delete("/api/youtube/videos/:videoId", async (c) => {
  await deleteChannelVideo(c.req.param("videoId"));
  return c.json({ ok: true });
});

// ── Lab (실험 admin) ──────────────────────────────────────────────────────────
// Serves the core pipeline's local outputs to the standalone admin frontend.
// This reads repo-root core/ directly — a LOCAL-DEV shim. In production the core
// pipeline runs on the worker VM and its results live in the DB/GCS; these routes
// would then read from there. Kept on this single server so "one backend" holds.
const LAB_CORE_DIR = process.env.CORE_DIR
  ? path.resolve(process.env.CORE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../core");
const ADMIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../admin");

function labJson(name: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(LAB_CORE_DIR, name), "utf-8"));
  } catch {
    return null;
  }
}

/** Combined lab payload: video + stats + raw/refined transcript + scenes. */
app.get("/api/lab/data", (c) => {
  const pipe = (labJson("pipeline_output.json") as any) || {};
  const refined = (labJson("refined_segments.json") as any[]) || [];
  const scenes = (labJson("scenes.json") as any[]) || [];
  // shorts.json: legacy bare array, or {genre, shorts} since the two-phase recommender.
  const shortsRaw = labJson("shorts.json") as any;
  const shorts: any[] = Array.isArray(shortsRaw) ? shortsRaw : (shortsRaw?.shorts ?? []);
  const raw = pipe.segments || [];
  const videoName = pipe.video ? path.basename(pipe.video) : null;
  const talk = scenes.filter((s) => s?.has_dialogue).length;
  return c.json({
    video: videoName ? "/api/lab/video" : null,
    video_name: videoName,
    stats: {
      duration: pipe.duration ?? null,
      segments: raw.length,
      refined: refined.length,
      scenes: scenes.length,
      scenes_dialogue: talk,
      scenes_silent: scenes.length - talk,
      shorts: shorts.length,
    },
    raw,
    refined,
    scenes,
    shorts,
  });
});

/** Scene frame by basename (path-traversal guarded). */
app.get("/api/lab/frames/:name", (c) => {
  const name = path.basename(c.req.param("name"));
  const file = path.join(LAB_CORE_DIR, "scene_frames", name);
  if (!file.startsWith(path.join(LAB_CORE_DIR, "scene_frames")) || !fs.existsSync(file)) {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(fs.readFileSync(file), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" },
  });
});

/** Source video with HTTP range support (so <video> seeking works). */
app.get("/api/lab/video", (c) => {
  const pipe = labJson("pipeline_output.json") as any;
  const name = pipe?.video ? path.basename(pipe.video) : null;
  if (!name) return c.json({ error: "no video" }, 404);
  const file = path.join(LAB_CORE_DIR, name);
  if (!fs.existsSync(file)) return c.json({ error: "not found" }, 404);

  const size = fs.statSync(file).size;
  const range = c.req.header("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": "video/mp4",
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: { "Content-Length": String(size), "Content-Type": "video/mp4", "Accept-Ranges": "bytes" },
  });
});

/** Serve the admin frontend locally (in prod it deploys to Vercel separately). */
app.get("/lab", (c) => {
  try {
    return c.html(fs.readFileSync(path.join(ADMIN_DIR, "index.html"), "utf-8"));
  } catch {
    return c.text("admin/index.html not found", 404);
  }
});

// ── start ─────────────────────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[stepd-server] listening on http://localhost:${info.port}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[stepd-server] SIGTERM received, shutting down...");
  // Pool cleanup happens automatically via idle timeout
  process.exit(0);
});
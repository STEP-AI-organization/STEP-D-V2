/**
 * STEP-D backend — Hono on Node + PostgreSQL + Cloud Storage (GCS).
 *
 * Production: DATABASE_URL + GCS_BUCKET env vars.
 * Development: local SQLite fallback not used — see db-pg.ts for local PG.
 * Video processing: real ffmpeg (system-installed, baked into Docker image).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  initDb,
  getState,
  getEntity,
  putEntity,
  prependEntity,
  listMedia,
  getMedia,
  insertMedia,
  updateMediaThumb,
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
  insertVideoStat,
  getVideoStats,
  getLatestVideoStat,
  getChannelViewTrend,
  getChannelTrendSummary,
  getPool,
  type MediaRow,
  type YouTubeChannel,
  type ChannelVideo,
} from "./db-pg.ts";
import { hasFfmpeg, probe, captureThumbnail, trimEncode } from "./ffmpeg.ts";
import { buildRecommendations, newId } from "./pipeline.ts";
import { syncChannelVideos } from "./youtube.ts";
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
} from "./storage-gcs.ts";

let dbReady = false;
let FFMPEG = false;

// Init DB in background — don't block server startup
initDb()
  .then(() => { dbReady = true; console.log("[stepd-server] database ready"); })
  .catch((err) => console.error("[stepd-server] database init failed (server still running):", err));

hasFfmpeg()
  .then((f) => { FFMPEG = f; console.log(`[stepd-server] ffmpeg available: ${FFMPEG}`); })
  .catch((err) => console.error("[stepd-server] hasFfmpeg error:", err));
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

// ── video streaming (HTTP range) ──────────────────────────────────────────────
app.get("/api/media/:id/stream", async (c) => {
  const m = await getMedia(c.req.param("id"));
  if (!m) return c.json({ error: "media not found" }, 404);

  const objPath = parseObjectPath(m.path);
  const exists = await fileExists(objPath);
  if (!exists) return c.json({ error: "media file not found" }, 404);

  const size = await fileSize(objPath);
  const range = c.req.header("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
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
  }

  const stream = createReadStream(objPath);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Content-Type": m.mime,
      "Cache-Control": "no-store",
    },
  });
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

// ── upload a real video → episode + master media + heuristic recommendations ───
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

  // Write to GCS (or local fallback)
  const storedPath = await writeFile(objPath, buffer);

  // Probe real metadata (local temp file needed for ffmpeg).
  let meta = { durationSec: 0, width: 0, height: 0, codec: "", hasAudio: false };
  if (FFMPEG) {
    // Save to temp for ffmpeg probe
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${mediaId}${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    try {
      meta = await probe(tmpPath);
    } catch {
      /* keep zeros */
    }
  }

  const title = typeof body["title"] === "string" && body["title"] ? String(body["title"]) : file.name;

  // New episode for this source.
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
    pipeline: { stage: "recommend", stageStatus: "done", note: "업로드 영상 · 추천 생성됨", progress: 100 },
  };
  await prependEntity("episode", episodeId, episode);

  // Master media row.
  const row: MediaRow = {
    id: mediaId,
    episodeId,
    role: "master",
    title,
    filename: file.name,
    path: storedPath,
    mime: file.type || "video/mp4",
    size: file.size,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    codec: meta.codec,
    hasAudio: meta.hasAudio ? 1 : 0,
    thumbPath: null,
    createdAt: Date.now(),
  };
  await insertMedia(row);

  // Thumbnail at ~10%.
  if (FFMPEG) {
    const tmpDir = path.resolve("/tmp/stepd-uploads");
    const tmpPath = path.join(tmpDir, `${mediaId}${ext}`);
    if (fs.existsSync(tmpPath)) {
      try {
        const thumbObjPath = thumbPath(mediaId);
        const thumbTmp = path.join(tmpDir, `${mediaId}.jpg`);
        await captureThumbnail(tmpPath, Math.max(1, meta.durationSec * 0.1), thumbTmp);
        const thumbStored = await uploadFile(thumbObjPath, thumbTmp);
        await updateMediaThumb(mediaId, thumbStored);
        row.thumbPath = thumbStored;
        // Cleanup temp
        try { fs.unlinkSync(tmpPath); } catch {}
        try { fs.unlinkSync(thumbTmp); } catch {}
      } catch {
        /* optional */
      }
    }
  }

  // Heuristic recommendations tied to the real duration.
  const recs = buildRecommendations(episodeId, meta.durationSec || 300);
  for (const r of recs) {
    await prependEntity("recommendation", r.id, r);
  }

  return c.json({ media: mediaPublic(row), episode, recommendations: recs });
});

// ── adopt recommendation → clip (real trim-encode when a master video exists) ──
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
    synopsis: rec.editNote ?? undefined,
    status: "ready",
    sourceRecommendationId: rec.id,
    distributions: [],
  };

  // Real clip: trim-encode the segment from the master video.
  if (master && FFMPEG) {
    const masterObjPath = parseObjectPath(master.path);
    const masterExists = await fileExists(masterObjPath);
    if (masterExists) {
      try {
        const tmpDir = path.resolve("/tmp/stepd-clips");
        fs.mkdirSync(tmpDir, { recursive: true });
        const clipMediaId = newId("m");
        const clipObjPath = clipPath(clipMediaId);
        const tmpPath = path.join(tmpDir, `${clipMediaId}.mp4`);

        // Download master to temp for ffmpeg processing
        if (useGcs()) {
          const { Storage } = await import("@google-cloud/storage");
          const storage = new Storage();
          const bucket = storage.bucket(process.env.GCS_BUCKET!);
          await bucket.file(masterObjPath).download({ destination: tmpPath });
        } else {
          fs.cpSync(master.path, tmpPath, { force: true });
        }

        await trimEncode(master.path, rec.startTime, rec.endTime, tmpPath);
        const cmeta = await probe(tmpPath).catch(() => ({
          durationSec: clip.durationSec, width: 0, height: 0, codec: "h264", hasAudio: true,
        }));

        // Upload clip to GCS
        const clipStored = await uploadFile(clipObjPath, tmpPath);

        // Thumbnail
        const thumbObjPath = thumbPath(clipMediaId);
        const thumbTmp = path.join(tmpDir, `${clipMediaId}.jpg`);
        await captureThumbnail(tmpPath, Math.min(1, cmeta.durationSec / 2), thumbTmp).catch(() => {});
        let thumbStored: string | null = null;
        if (fs.existsSync(thumbTmp)) {
          thumbStored = await uploadFile(thumbObjPath, thumbTmp);
        }

        const cRow: MediaRow = {
          id: clipMediaId, episodeId: rec.episodeId, role: "clip", title: clip.title,
          filename: `${clip.title}.mp4`, path: clipStored, mime: "video/mp4",
          size: fs.statSync(tmpPath).size, durationSec: cmeta.durationSec,
          width: cmeta.width, height: cmeta.height, codec: cmeta.codec, hasAudio: cmeta.hasAudio ? 1 : 0,
          thumbPath: thumbStored, createdAt: Date.now(),
        };
        await insertMedia(cRow);
        clip.mediaId = clipMediaId;
        clip.videoUrl = `/api/media/${clipMediaId}/stream`;
        clip.sourceMediaId = master.id;

        // Cleanup temp
        try { fs.unlinkSync(tmpPath); } catch {}
        try { fs.unlinkSync(thumbTmp); } catch {}
      } catch (err) {
        console.error("[adopt] trim-encode failed:", err);
      }
    }
  }

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
  for (const clipId of b.clipIds) {
    const clip = await getEntity<any>("clip", clipId);
    if (!clip) continue;
    const dists = [...(clip.distributions ?? [])];
    const value: any = { channel: b.channel, status, reserveDate: b.reserveDate, error: undefined };
    if (b.channel === "meta" && b.platforms) value.platforms = b.platforms;
    const existing = dists.find((d: any) => d.channel === b.channel);
    if (existing) Object.assign(existing, value);
    else dists.push(value);
    await putEntity("clip", clipId, { ...clip, status: "published", distributions: dists });
  }
  return c.json({ ok: true });
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

// ── YouTube OAuth & channel management ────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const YT_SCOPES = "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.channel-memberships.creator https://www.googleapis.com/auth/youtube.force-ssl";
const PORT = Number(process.env.PORT ?? 4000);

function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}/api/youtube/callback`,
    response_type: "code",
    scope: YT_SCOPES,
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
    redirect_uri: `${process.env.PUBLIC_URL ?? `http://localhost:${PORT}`}/api/youtube/callback`,
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

async function refreshAccessToken(refreshToken: string) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

app.get("/api/youtube/auth", (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
  const channelUrl = c.req.query("channel") ?? "";
  const state = channelUrl ? Buffer.from(JSON.stringify({ channel: channelUrl })).toString("base64") : "";
  return c.redirect(googleAuthUrl(state));
});

app.get("/api/youtube/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  if (error) return c.redirect(`/register?error=access_denied`);
  if (!code) return c.json({ error: "missing code" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    const tokens = await exchangeCode(code);
    const channelInfo = await fetchYtChannelInfo(tokens.access_token);
    const channel: YouTubeChannel = {
      id: channelInfo.channelId,
      channelId: channelInfo.channelId,
      channelName: channelInfo.channelName,
      channelUrl: null,
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

    const state = c.req.query("state");
    if (state) {
      try {
        const st = JSON.parse(Buffer.from(state, "base64").toString());
        if (st.channel) channel.channelUrl = st.channel;
      } catch { /* ignore */ }
    }

    await upsertYouTubeChannel(channel);
    const params = new URLSearchParams({ success: "1", channelId: channel.channelId, channelName: channel.channelName });
    return c.redirect(`/register?${params}`);
  } catch (err: any) {
    console.error("[oauth/callback]", err);
    return c.redirect(`/register?error=${encodeURIComponent(err.message)}`);
  }
});

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

  try {
    const data = await refreshAccessToken(ch.refreshToken);
    await upsertYouTubeChannel({ ...ch, accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return c.json({ ok: true, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── YouTube video sync & trends ──────────────────────────────────────────

app.post("/api/youtube/sync/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const ch = await getYouTubeChannelByChannelId(channelId);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  if (!ch.refreshToken) return c.json({ error: "no refresh token for this channel" }, 400);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return c.json({ error: "OAuth not configured" }, 500);

  try {
    const result = await syncChannelVideos(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ch);

    if (result.refreshedToken && result.refreshedToken !== ch.accessToken) {
      await upsertYouTubeChannel({ ...ch, accessToken: result.refreshedToken });
    }

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

    return c.json({
      ok: true,
      channelId,
      videoCount: result.videos.length,
      inserted,
      updated,
      snapshotCount: result.videos.length,
    });
  } catch (err: any) {
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
    const date = new Date(s.snapshotAt).toISOString().slice(0, 10);
    dailyData.set(date, { views: s.viewCount, likes: s.likeCount, comments: s.commentCount });
  }

  const trend = Array.from(dailyData.entries()).map(([date, d]) => ({
    date,
    ...d,
  }));

  return c.json({ video, trend });
});

app.delete("/api/youtube/videos/:videoId", async (c) => {
  await deleteChannelVideo(c.req.param("videoId"));
  return c.json({ ok: true });
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
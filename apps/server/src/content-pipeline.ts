/**
 * Content-analysis job runner (worker side).
 *
 * Pulls the uploaded video, runs the GPU-free Python pipeline (core/analyze.py:
 * STT → refine → scenes → frame analysis(vision+names) → two-phase shorts), and
 * stores the result JSON in content_analysis. Kept in its own module so worker.ts
 * only needs a one-line case.
 *
 * Failure recovery: each media gets a STABLE work dir (not a fresh mkdtemp), and
 * core/analyze.py checkpoints every stage into it — so a queue retry resumes from
 * the last finished stage instead of re-paying STT/vision. The dir is removed on
 * success and swept after 48h either way.
 *
 * Progress: the pipeline emits `@@PROGRESS {stage,pct,note}` lines on stdout; we
 * mirror them onto the episode's pipeline field so the UI shows real stage progress
 * instead of an eternal "분석 중…".
 *
 * Persistence: scene frames + stage outputs are uploaded to storage under
 * analysis/{mediaId}/ after a successful run (framesBase in the saved data), so
 * frames survive for the Lab/editor and a future re-analysis can start from them.
 *
 * The pipeline is spawned as `python -m core.analyze` — set CORE_PYTHON to the
 * worker's venv (core/.venv/bin/python); locally it defaults to core/.venv310.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import {
  getMedia, saveContentAnalysis, saveTranscript, saveEpisodeCast, listProgramCast,
  prependEntity, getPool, getEntity, putEntity,
} from "./db-pg.ts";
import type { TranscriptSegment } from "./db-pg.ts";
import { toCoreRegistry, timelineToRows } from "./cast.ts";
import { createReadStream, parseObjectPath, uploadFile } from "./storage-gcs.ts";
import { newId } from "./pipeline.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CORE_PYTHON =
  process.env.CORE_PYTHON ||
  path.join(REPO_ROOT, "core", ".venv310", "Scripts", "python.exe");

/** Stable per-media work dirs live here so a retry can resume from checkpoints. */
const WORK_ROOT = path.join(os.tmpdir(), "stepd-content");
/** Work dirs older than this are dead (job gave up or succeeded long ago) — sweep. */
const WORK_DIR_TTL_MS = 48 * 60 * 60 * 1000;

/** Stage outputs core/analyze.py checkpoints into the work dir (upload order). */
const CHECKPOINT_FILES = ["analysis.json", "scenes.json", "cast.json", "shorts.json", "refined.json", "stt.json", "manifest.json"];

function workDirFor(mediaId: string): string {
  return path.join(WORK_ROOT, mediaId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/** Remove abandoned work dirs so failed-forever jobs don't fill the VM disk. */
function sweepStaleWorkDirs(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(WORK_ROOT, { withFileTypes: true });
  } catch {
    return; // root doesn't exist yet
  }
  const cutoff = Date.now() - WORK_DIR_TTL_MS;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(WORK_ROOT, e.name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[worker] content.analyze: swept stale work dir ${e.name}`);
      }
    } catch {
      // raced/locked — next sweep gets it
    }
  }
}

async function downloadToTemp(storedPath: string, dest: string): Promise<void> {
  // Works for both GCS and the local-storage fallback (createReadStream abstracts it).
  const src = Readable.fromWeb(createReadStream(parseObjectPath(storedPath)) as any);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    // Attach error handlers to BOTH ends. A source error (missing object, no GCS access)
    // must REJECT this promise so the job fails cleanly — pipe() does not forward source
    // errors to the destination, so without this it bubbles up and crashes the worker.
    src.on("error", reject);
    out.on("error", reject);
    src.pipe(out).on("finish", () => resolve());
  });
}

/** Pipeline progress line: `@@PROGRESS {"stage":"stt","pct":12,"note":"…"}`. */
type Progress = { stage?: string; pct?: number; note?: string };

function runAnalyze(
  videoPath: string,
  outDir: string,
  onProgress: (p: Progress) => void,
  profilePath?: string,
  castPath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-u", "-m", "core.analyze", videoPath, "--out", outDir];
    if (profilePath) args.push("--profile", profilePath);
    if (castPath) args.push("--cast", castPath);
    const proc = spawn(
      CORE_PYTHON,
      args,
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: "",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          STT_PROVIDER: process.env.STT_PROVIDER || "gemini",
          GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || "step-d",
          VERTEX_LOCATION: process.env.VERTEX_LOCATION || "asia-northeast3",
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    // Parse progress markers out of stdout; everything else passes through to the log.
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (line.startsWith("@@PROGRESS ")) {
        try {
          onProgress(JSON.parse(line.slice("@@PROGRESS ".length)) as Progress);
        } catch {
          // mangled marker — ignore, it's progress not data
        }
        return;
      }
      console.log(`[core] ${line}`);
    });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`core.analyze exited ${code}`)),
    );
    proc.on("error", reject);
  });
}

// One AI-recommended short from core/recommend.py.
type Short = {
  rank?: number; appeal?: number; start?: number; end?: number;
  title?: string; reason?: string; tags?: string[];
  /** (후보 × 배포처) matrix from core/channels.py apply_channel_fit — absent when the
   *  analysis ran without destinations, or on any pre-matrix run. */
  channel_scores?: Record<string, ChannelScore>;
};

/** One (candidate × destination) cell — core/channels.py channel_fit(). */
type ChannelScore = {
  fit?: number; score?: number; rank?: number;
  usable?: boolean; lengthSec?: number;
  len_fit?: number; hook_w?: number; caption_fit?: number; aspect_fit?: number;
};

const MIN_SHORT_SEC = 3;

/** Map an AI short → a recommendation entity matching the web's board shape. */
function recFromShort(episodeId: string, s: Short) {
  const start = Number(s.start) || 0;
  const end = Number(s.end) || 0;
  const id = newId("r");
  const mid = start + (end - start) * 0.4;
  const rank = typeof s.rank === "number" ? s.rank : 3;
  // The model scores appeal itself (1–5, 절대평가); 6-rank is only the legacy fallback.
  const appeal = typeof s.appeal === "number" ? s.appeal : 6 - rank;
  return {
    id,
    episodeId,
    kind: "short",
    title: s.title || "쇼츠 추천",
    appeal: Math.max(1, Math.min(5, appeal)),
    startTime: start,
    endTime: end,
    editNote: s.reason || "",
    tags: Array.isArray(s.tags) ? s.tags : [],
    status: "pending",
    thumbnailCandidates: [
      { id: `${id}-t1`, label: "시작", time: start + 0.5 },
      { id: `${id}-t2`, label: "핵심", time: mid },
      { id: `${id}-t3`, label: "끝", time: Math.max(start + 1, end - 1) },
    ],
    selectedThumbnailId: `${id}-t2`,
    adoptedClipId: null,
    // Carried so adopt can derive the clip's target destination (F3) without re-running the
    // analysis. Null (not omitted) when the matrix never ran — adopt treats that as "no
    // suggestion" and leaves targetChannel unset.
    channelScores: s.channel_scores ?? null,
  };
}

/**
 * Surface the AI shorts on the episode's recommendation board.
 * Idempotent: clears any prior recs for the episode first, so a re-run replaces
 * rather than duplicates. Degenerate spans are dropped, not silently stretched.
 */
async function writeRecommendationsFromShorts(
  episodeId: string,
  shorts: Short[],
  durationSec: number,
): Promise<number> {
  const valid = shorts.filter((s) => {
    const start = Number(s.start) || 0;
    const end = Number(s.end) || 0;
    const ok = end - start >= MIN_SHORT_SEC && (!durationSec || start < durationSec);
    if (!ok) console.warn(`[worker] dropping invalid short ${start}~${end}s "${s.title ?? ""}"`);
    return ok;
  });
  await getPool().query(
    "DELETE FROM entities WHERE kind = 'recommendation' AND data->>'episodeId' = $1",
    [episodeId],
  );
  const sorted = [...valid].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  // Insert worst-rank first so prepend leaves rank 1 at the front of the board.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const rec = recFromShort(episodeId, sorted[i]);
    await prependEntity("recommendation", rec.id, rec);
  }
  return sorted.length;
}

/** Reflect pipeline progress on the episode so the UI shows real status, not a guess. */
async function setEpisodePipeline(episodeId: string, pipeline: Record<string, unknown>): Promise<void> {
  const ep = await getEntity<Record<string, unknown>>("episode", episodeId);
  if (ep) await putEntity("episode", episodeId, { ...ep, pipeline });
}

/**
 * Upload the run's artifacts (stage outputs + scene frames) to storage under
 * analysis/{mediaId}/ so they outlive the work dir. Returns the object-path base,
 * or null if nothing could be uploaded — persistence failure must not fail the job.
 */
async function persistArtifacts(work: string, mediaId: string): Promise<{ base: string; frames: number } | null> {
  const base = `analysis/${mediaId}`;
  try {
    for (const name of CHECKPOINT_FILES) {
      const local = path.join(work, name);
      if (fs.existsSync(local)) await uploadFile(`${base}/${name}`, local);
    }
    const framesDir = path.join(work, "scene_frames");
    let frames: string[] = [];
    if (fs.existsSync(framesDir)) {
      frames = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg"));
      const CONCURRENCY = 8;
      for (let i = 0; i < frames.length; i += CONCURRENCY) {
        await Promise.all(
          frames.slice(i, i + CONCURRENCY).map((f) =>
            uploadFile(`${base}/scene_frames/${f}`, path.join(framesDir, f)),
          ),
        );
      }
    }
    return { base, frames: frames.length };
  } catch (e) {
    console.error(`[worker] content.analyze ${mediaId}: artifact persistence failed (continuing)`, e);
    return null;
  }
}

/**
 * Mirror the run's transcript into the canonical `transcript` table (shared by the
 * caption/render/framing/highlight consumers). Additive — content_analysis keeps its own
 * `data.transcript` copy, so this never removes the existing read path. Non-fatal: a
 * transcript-store failure (e.g. table not yet migrated) must not fail the analysis job.
 */
async function persistTranscript(
  mediaId: string,
  segments: unknown,
  source: "refined" | "raw",
): Promise<void> {
  if (!Array.isArray(segments) || segments.length === 0) return;
  try {
    await saveTranscript(mediaId, {
      segments: segments as TranscriptSegment[],
      // core/analyze.py transcribes with language="ko"; provider is the worker's STT choice.
      language: "ko",
      provider: process.env.STT_PROVIDER || "gemini",
      source,
    });
  } catch (e) {
    console.error(`[worker] content.analyze ${mediaId}: transcript persistence failed (continuing)`, e);
  }
}

/**
 * Mirror the run's cast timeline into `episode_cast`. Non-fatal: a cast-store failure
 * (e.g. table not yet migrated) must not fail an otherwise successful analysis — the
 * timeline also lives in content_analysis.data.cast. Returns the row count written.
 */
async function persistCast(mediaId: string, cast: unknown): Promise<number> {
  const rows = timelineToRows(cast);
  if (!rows.length) return 0;
  try {
    return await saveEpisodeCast(mediaId, rows);
  } catch (e) {
    console.error(`[worker] content.analyze ${mediaId}: cast persistence failed (continuing)`, e);
    return 0;
  }
}

/** Read a checkpoint JSON from the work dir, or undefined. */
function readCheckpoint<T>(work: string, name: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(work, name), "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * On failure, salvage whatever stages DID finish into content_analysis so partial
 * work (a full transcript, scored scenes) is visible and never silently lost —
 * the checkpoints also stay on disk for the retry to resume from.
 */
function collectPartial(work: string): Record<string, unknown> | undefined {
  const refined = readCheckpoint<unknown[]>(work, "refined.json");
  const stt = readCheckpoint<{ segments?: unknown[] }>(work, "stt.json");
  const scenes = readCheckpoint<unknown[]>(work, "scenes.json");
  const cast = readCheckpoint<Record<string, unknown>>(work, "cast.json");
  const transcript = refined ?? stt?.segments;
  if (!transcript && !scenes) return undefined;
  return {
    partial: true,
    stagesDone: [
      ...(stt?.segments ? ["stt"] : []),
      ...(refined ? ["refine"] : []),
      ...(scenes ? ["scenes"] : []),
      ...(cast ? ["cast"] : []),
    ],
    ...(transcript ? { transcript } : {}),
    ...(scenes ? { scenes } : {}),
    ...(cast ? { cast } : {}),
  };
}

/** Run the full content pipeline for one uploaded media and persist the result. */
export async function runContentAnalyze(mediaId: string): Promise<void> {
  const media = await getMedia(mediaId);
  if (!media) throw new Error(`content.analyze: media ${mediaId} not found`);

  sweepStaleWorkDirs();
  const work = workDirFor(mediaId);
  fs.mkdirSync(work, { recursive: true });
  const videoPath = path.join(work, `source${path.extname(media.filename) || ".mp4"}`);

  try {
    // A retry reuses the already-downloaded source (size must match — a mismatch
    // means the previous download was cut off, so pull it again).
    const have = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : -1;
    if (have === media.size && have > 0) {
      console.log(`[worker] content.analyze ${mediaId}: reusing downloaded source (resume)`);
    } else {
      await downloadToTemp(media.path, videoPath);
    }

    // Mirror pipeline progress onto the episode (throttled — every line is a DB write).
    let lastPct = -10;
    let lastWrite = 0;
    let chain = Promise.resolve();
    const onProgress = (p: Progress) => {
      const pct = Math.max(0, Math.min(99, Number(p.pct) || 0));
      const now = Date.now();
      if (pct - lastPct < 2 && now - lastWrite < 3000) return;
      lastPct = pct;
      lastWrite = now;
      if (!media.episodeId) return;
      chain = chain
        .then(() =>
          setEpisodePipeline(media.episodeId!, {
            stage: "analyze",
            stageStatus: "progress",
            note: p.note || "AI 분석 중…",
            progress: pct,
          }),
        )
        .catch((e) => console.error("[worker] progress update failed", e));
    };

    // Program context (if set) → two priors for the pick, both resolved via episode→program
    // and written next to the video so core reads them locally:
    //   profile.json — 이해 프로파일 → program-fit multiplier
    //   cast.json    — 출연자 레지스트리 → name captions normalized onto real people
    // Either missing is fine: the pipeline degrades to its prior behaviour (no program fit /
    // every detected name stays an unmatched candidate).
    let profilePath: string | undefined;
    let castPath: string | undefined;
    try {
      const episode = media.episodeId ? await getEntity<any>("episode", media.episodeId) : undefined;
      const program = episode?.programId ? await getEntity<any>("program", episode.programId) : undefined;
      if (program?.profile && typeof program.profile === "object") {
        profilePath = path.join(work, "profile.json");
        fs.writeFileSync(profilePath, JSON.stringify(program.profile), "utf-8");
      }
      if (episode?.programId) {
        const roster = await listProgramCast(episode.programId);
        if (roster.length) {
          castPath = path.join(work, "cast_registry.json");
          fs.writeFileSync(castPath, JSON.stringify(toCoreRegistry(roster)), "utf-8");
          console.log(`[worker] content.analyze ${mediaId}: cast registry ${roster.length} members`);
        }
      }
    } catch (e) {
      console.error("[worker] program context resolve failed (proceeding without):", e);
    }

    await runAnalyze(videoPath, work, onProgress, profilePath, castPath);
    await chain.catch(() => {});

    const analysis = JSON.parse(fs.readFileSync(path.join(work, "analysis.json"), "utf-8"));

    // Persist frames + stage outputs before anything can throw them away — they power
    // the Lab/editor views and let a future re-analysis start from stored stages.
    const stored = await persistArtifacts(work, mediaId);
    await saveContentAnalysis(mediaId, {
      data: {
        ...analysis,
        ...(stored ? { framesBase: stored.base, framesStored: stored.frames > 0 } : { framesStored: false }),
      },
    });

    // Also land the transcript in the canonical shared table (refined segments carry the
    // word-level timings from the whisper path). Consumers read it there; content_analysis
    // still holds its own copy, so this is purely additive.
    await persistTranscript(mediaId, analysis?.transcript, "refined");

    // Land the "출연자 × 등장 구간" timeline in its own table (queryable per person, and the
    // seat for the operator's confirm/reject). content_analysis.data.cast keeps the run's
    // own copy, so this is additive.
    const castRows = await persistCast(mediaId, analysis?.cast);

    const shorts: Short[] = Array.isArray(analysis?.shorts) ? analysis.shorts : [];
    // Surface the AI shorts on the episode's recommendation board (the product payoff).
    let wrote = 0;
    if (media.episodeId && shorts.length) {
      try {
        wrote = await writeRecommendationsFromShorts(media.episodeId, shorts, media.durationSec ?? 0);
      } catch (e) {
        console.error(`[worker] content.analyze ${mediaId}: failed to write recommendations`, e);
      }
    }
    console.log(
      `[worker] content.analyze ${mediaId}: ${analysis?.scenes?.length ?? 0} scenes, ` +
      `${shorts.length} shorts, ${wrote} recs, ${castRows} cast, genre=${analysis?.genre ?? "-"}, ` +
      `frames=${stored ? stored.frames : "not-stored"}`,
    );

    if (media.episodeId) {
      await setEpisodePipeline(media.episodeId, {
        stage: "recommend",
        stageStatus: "done",
        note: wrote ? `AI 쇼츠 추천 ${wrote}건` : "분석 완료 · 추천 없음",
        progress: 100,
      }).catch((e) => console.error("[worker] failed to update episode pipeline", e));
    }

    // Success — the work dir (video + frames + checkpoints) has served its purpose.
    fs.rmSync(work, { recursive: true, force: true });
  } catch (err: any) {
    const partial = collectPartial(work);
    // Persist whatever frames + stage outputs DID complete before the crash, so a partial
    // run is still viewable in the Lab/editor. Without this, collectPartial's salvaged
    // scenes reference frames that never left the worker's local work dir (which isn't
    // web-reachable), and the Lab shows scenes with broken images. Non-fatal, and only
    // worth doing when something was actually salvaged.
    const stored = partial ? await persistArtifacts(work, mediaId) : null;
    await saveContentAnalysis(mediaId, {
      error: String(err?.message ?? err).slice(0, 1000),
      ...(partial
        ? {
            data: {
              ...partial,
              ...(stored ? { framesBase: stored.base, framesStored: stored.frames > 0 } : {}),
            },
          }
        : {}),
    });
    // Consolidate the partial transcript into the shared table too (refine may not have
    // run yet — fall back to the raw STT segments collectPartial salvaged).
    if (partial) {
      const p = partial as { transcript?: unknown; stagesDone?: unknown; cast?: unknown };
      const refined = Array.isArray(p.stagesDone) && p.stagesDone.includes("refine");
      await persistTranscript(mediaId, p.transcript, refined ? "refined" : "raw");
      // The cast stage runs before recommend, so a late crash still has a full timeline.
      await persistCast(mediaId, p.cast);
    }
    if (media.episodeId) {
      await setEpisodePipeline(media.episodeId, {
        stage: "analyze",
        stageStatus: "error",
        blockedReason: "AI 분석 실패 — 재시도 대기 (완료된 단계는 보존됨)",
      }).catch(() => {});
    }
    // Keep the work dir: the queue retry resumes from its checkpoints. The 48h sweep
    // cleans it up if the job never comes back.
    console.log(`[worker] content.analyze ${mediaId}: work dir kept for resume (${work})`);
    throw err;
  }
}

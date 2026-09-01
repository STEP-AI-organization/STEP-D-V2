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
  getMedia, getContentAnalysis, saveContentAnalysis, saveTranscript, saveEpisodeCast, listProgramCast,
  getChannelPointProfile, listVideoComments,
  getPool, getEntity, putEntity, upsertSearchSegments,
  recordUsage,
  addCreditEntry,
  creditBalance,
  compareAndSetClipReframe,
  updateMediaDuration,
} from "./db-pg.ts";
import type { TranscriptSegment, SearchSegmentRow } from "./db-pg.ts";
import { billableMinutes, estimatedCostKrw, usageDedupeKey } from "./billing/billing.ts";
import { probe } from "./media/ffmpeg.ts";
import { autoTopupNeedsAttention, checkCredits, usageDedupeKey as creditUsageKey } from "./billing/credits.ts";
import { maybeAutoTopup, topupAndRecheck } from "./billing/auto-topup.ts";
import { toCoreRegistry, timelineToRows } from "./cast.ts";
import { createReadStream, parseObjectPath, readFile, uploadFile, useGcs } from "./media/storage-gcs.ts";
import { enqueue } from "./queue.ts";
import { newId } from "./pipeline.ts";
import {
  compareArtifactPrefix,
  contactFrameName,
  contactSheetTimes,
  normalizeBeatIds,
  normalizeReframePlan,
  reframeFingerprint,
  reframePlanHash,
  summarizeReframePlan,
  type ClipReframeState,
} from "./media/reframe.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * core/ 파이썬 인터프리터. env 없이도 리포의 venv 를 찾아가므로 CORE_PYTHON 은 선택이다
 * — venv 위치가 다를 때만 지정한다. 맨 "python" 으로 폴백하면 시스템 파이썬이 잡혀
 * 의존성 없이 죽으므로 폴백하지 않는다.
 */
export const CORE_PYTHON =
  process.env.CORE_PYTHON ||
  path.join(
    REPO_ROOT, "core", ".venv310",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );

/** core/ 소스 위치. CORE_DIR 로 덮어쓸 수 있다. */
export const CORE_DIR = process.env.CORE_DIR
  ? path.resolve(process.env.CORE_DIR)
  : path.join(REPO_ROOT, "core");

/** Stable per-media work dirs live here so a retry can resume from checkpoints. */
const WORK_ROOT = path.join(os.tmpdir(), "stepd-content");
/** Work dirs older than this are dead (job gave up or succeeded long ago) — sweep. */
const WORK_DIR_TTL_MS = 48 * 60 * 60 * 1000;

/** Stage outputs core/analyze.py checkpoints into the work dir (upload order). */
// 워커가 GCS 로 왕복시키는 체크포인트. 여기 빠지면 재실행 때 그 스테이지를 다시 돈다 —
// chyron.json 은 재생성이 회당 ₩150 이라 특히 중요. (signals/genre 는 ₩0 이지만 일관성 위해 포함)
const CHECKPOINT_FILES = ["analysis.json", "scenes.json", "cast.json", "timeline.json", "narrative.json", "shorts.json", "refined.json", "faces.json", "ppl.json", "stt.json", "manifest.json", "comments.json", "viewer_signals.json", "beats.json", "boundaries.json", "shots.json", "scene_type.json", "signals.json", "genre.json", "chyron.json"];

/**
 * Watchdog: kill the python child after this long with NO stdout output. A hung Vertex
 * call would otherwise keep the job 'running' forever — the heartbeat refreshes the lock
 * indefinitely, so requeueStale can never reclaim it and the content lane wedges.
 */
// 2026-07-23: 90분+ 영상 정밀 분석에서 30분 무출력 관찰됨(faces·ppl 프레임 뽑기 순차 처리 구간).
// 60분으로 상향 · 환경변수로 더 늘릴 수 있음. 완전 무출력 시나리오만 잘라내는 안전망.
const STALL_TIMEOUT_MS = (Number(process.env.CORE_ANALYZE_STALL_MIN) || 60) * 60 * 1000;

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
      if (newestMtimeMs(dir) < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[worker] content.analyze: swept stale work dir ${e.name}`);
      }
    } catch {
      // raced/locked — next sweep gets it
    }
  }
}

/**
 * Staleness = newest mtime of the dir OR any direct child. The dir's own mtime only moves
 * on create/rename — a long in-place write (a growing download, an appended log) leaves it
 * untouched, and judging by dir mtime alone would let a sibling worker sweep an ACTIVE dir.
 */
export function newestMtimeMs(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs;
  for (const f of fs.readdirSync(dir)) {
    try {
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      // entry vanished mid-scan
    }
  }
  return newest;
}

export interface ClipReframeJobInput {
  clipId: string;
  inputFingerprint: string;
  requestId: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * Run the clip-only vision planner. The worker stores the full planner response as an
 * analysis artifact, while the clip entity receives only the validated renderer contract.
 * All state writes are request/fingerprint CAS operations, so changing trim or selecting
 * basic mode makes this job harmless even if Python is already running.
 */
export async function runClipReframe(input: ClipReframeJobInput): Promise<void> {
  const { clipId, inputFingerprint, requestId } = input;
  if (!clipId || !inputFingerprint || !requestId) {
    throw new Error("clip.reframe requires clipId, inputFingerprint and requestId");
  }

  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) throw new Error(`clip.reframe: clip ${clipId} not found`);
  let currentFingerprint: string;
  try {
    currentFingerprint = reframeFingerprint(clip);
  } catch (error) {
    throw new Error(`clip.reframe: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (currentFingerprint !== inputFingerprint) return;

  const current = clip.reframe && typeof clip.reframe === "object"
    ? clip.reframe as ClipReframeState
    : null;
  if (current?.mode !== "ai_multi" || current.requestId !== requestId) return;
  const now = Date.now();
  const running: ClipReframeState = {
    ...current,
    mode: "ai_multi",
    status: "running",
    timeBase: "master_absolute",
    revision: now,
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  const claimed = await compareAndSetClipReframe(clipId, inputFingerprint, requestId, running);
  if (!claimed) return;

  const mediaId = String(clip.sourceMediaId ?? "");
  const media = mediaId ? await getMedia(mediaId) : undefined;
  const clipStart = Number(clip.startTime);
  const clipEnd = Number(clip.endTime);
  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || !(clipEnd > clipStart)) {
    await failClipReframe(input, running, "invalid_clip_range", "AI 리프레임 구간이 올바르지 않습니다.");
    throw new Error("clip.reframe: clip range must be finite and end after start");
  }
  if (!media) {
    await failClipReframe(input, running, "source_media_missing", "AI 리프레임 원본 영상을 찾을 수 없습니다.");
    throw new Error(`clip.reframe: source media ${mediaId || "(empty)"} not found`);
  }

  const safeClipId = clipId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `stepd-reframe-${safeClipId}-`));
  try {
    const proxyPath = path.join(work, "proxy.mp4");
    const beatsPath = path.join(work, "beats.json");
    const shotsPath = path.join(work, "shots.json");
    const outputPath = path.join(work, "plan.json");
    const debugPath = path.join(work, "debug.json");

    await materializeAnalysisInput(mediaId, "beats.json", beatsPath);
    const hasShots = await materializeOptionalAnalysisInput(mediaId, "shots.json", shotsPath);
    const sourcePath = useGcs()
      ? await signedProxySource(media.path)
      : media.path;
    await runChild(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", clipStart.toFixed(6), "-i", sourcePath, "-t", (clipEnd - clipStart).toFixed(6),
        "-map", "0:v:0", "-an", "-vf", "fps=5,scale=640:-2:flags=lanczos",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart",
        proxyPath,
      ],
      { label: "reframe proxy", timeoutMs: 15 * 60 * 1000 },
    );

    const args = [
      "-u", "-m", "core.reframe",
      "--video", proxyPath,
      "--clip-start", clipStart.toFixed(6),
      "--clip-end", clipEnd.toFixed(6),
      "--beats", beatsPath,
      "--source-width", String(Math.max(0, Number(media.width) || 0)),
      "--source-height", String(Math.max(0, Number(media.height) || 0)),
      "--output", outputPath,
    ];
    if (hasShots) args.push("--shots", shotsPath);
    const modelPath = process.env.REFRAME_FACE_MODEL?.trim();
    if (modelPath) args.push("--model", modelPath);
    await runChild(CORE_PYTHON, args, {
      cwd: REPO_ROOT,
      label: "core.reframe",
      timeoutMs: (Number(process.env.REFRAME_TIMEOUT_MIN) || 20) * 60 * 1000,
      env: { PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    const raw = JSON.parse(await fs.promises.readFile(outputPath, "utf8")) as Record<string, unknown>;
    const plan = normalizeReframePlan(raw, { start: clipStart, end: clipEnd });
    const planHash = reframePlanHash(plan);
    const summary = summarizeReframePlan(plan);
    const artifactPath = `analysis/${mediaId}/reframe/${safeClipId}/${inputFingerprint}.json`;
    const debug = {
      generatedAt: Date.now(),
      clipId,
      sourceMediaId: mediaId,
      inputFingerprint,
      requestId,
      requestedBeatIds: normalizeBeatIds(clip.beatIds),
      planner: raw,
    };
    await fs.promises.writeFile(debugPath, JSON.stringify(debug, null, 2), "utf8");
    await uploadFile(artifactPath, debugPath);

    const latest = await getEntity<Record<string, unknown>>("clip", clipId);
    const latestState = latest?.reframe && typeof latest.reframe === "object"
      ? latest.reframe as ClipReframeState
      : running;
    const completedAt = Date.now();
    const ready: ClipReframeState = {
      ...latestState,
      mode: "ai_multi",
      status: "ready",
      timeBase: "master_absolute",
      revision: completedAt,
      inputFingerprint,
      requestId,
      plan,
      planHash,
      ...summary,
      modelVersion: typeof raw.scoreVersion === "string" ? raw.scoreVersion : undefined,
      artifactPath,
      completedAt,
      updatedAt: completedAt,
      error: null,
    };
    await compareAndSetClipReframe(clipId, inputFingerprint, requestId, ready);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /beats/i.test(message) ? "beats_unavailable" : "planner_failed";
    await failClipReframe(input, running, code, message);
    throw error;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function failClipReframe(
  input: ClipReframeJobInput,
  base: ClipReframeState,
  code: string,
  message: string,
): Promise<void> {
  const at = Date.now();
  const finalAttempt = input.attempt >= input.maxAttempts;
  const failed: ClipReframeState = {
    ...base,
    status: finalAttempt ? "failed" : "queued",
    revision: at,
    updatedAt: at,
    error: { code, message: message.slice(0, 600), at },
  };
  await compareAndSetClipReframe(input.clipId, input.inputFingerprint, input.requestId, failed);
}

export interface ReframeCompareJobInput {
  clipId: string;
  compareId: string;
}

/**
 * 세로 4택 비교 산출물 생성 (vertical-candidates-v1 · reframe-compare-viewer-plan §1·§4).
 *
 * 정식 clip.reframe 상태를 **읽지도 쓰지도 않는다** — 산출물(후보 plan·contact sheet·
 * 프록시)은 임시 GCS 경로 `analysis/{mediaId}/reframe-compare/…/{compareId}/` 에만 산다.
 * compareId = 요청 시점의 reframeFingerprint 라 같은 입력 재요청은 같은 경로를 덮어쓰는
 * 멱등이고, 트림·beat 가 바뀌면 fingerprint 불일치로 조용히 끝난다(낡은 산출물 생산 금지).
 * index.json 은 **마지막에** 올린다 — 존재 자체가 "완료" 신호다(라우트가 이걸 본다).
 */
export async function runReframeCompare(input: ReframeCompareJobInput): Promise<void> {
  const { clipId, compareId } = input;
  if (!clipId || !compareId) throw new Error("reframe.compare requires clipId and compareId");
  const clip = await getEntity<Record<string, unknown>>("clip", clipId);
  if (!clip) throw new Error(`reframe.compare: clip ${clipId} not found`);
  let currentFingerprint: string;
  try {
    currentFingerprint = reframeFingerprint(clip);
  } catch (error) {
    throw new Error(`reframe.compare: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (currentFingerprint !== compareId) return;

  const mediaId = String(clip.sourceMediaId ?? "");
  const media = mediaId ? await getMedia(mediaId) : undefined;
  const clipStart = Number(clip.startTime);
  const clipEnd = Number(clip.endTime);
  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || !(clipEnd > clipStart)) {
    throw new Error("reframe.compare: clip range must be finite and end after start");
  }
  if (!media) throw new Error(`reframe.compare: source media ${mediaId || "(empty)"} not found`);

  const safeClipId = clipId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `stepd-refcmp-${safeClipId}-`));
  try {
    const proxyPath = path.join(work, "proxy.mp4");
    const beatsPath = path.join(work, "beats.json");
    const shotsPath = path.join(work, "shots.json");
    const planPath = path.join(work, "plan.json");
    const candidatesPath = path.join(work, "candidates.json");

    await materializeAnalysisInput(mediaId, "beats.json", beatsPath);
    const hasShots = await materializeOptionalAnalysisInput(mediaId, "shots.json", shotsPath);
    const sourcePath = useGcs() ? await signedProxySource(media.path) : media.path;
    // clip.reframe 와 같은 프록시 사양(5fps·640px) — 비전 입력과 뷰어 프리뷰를 겸한다.
    await runChild(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", clipStart.toFixed(6), "-i", sourcePath, "-t", (clipEnd - clipStart).toFixed(6),
        "-map", "0:v:0", "-an", "-vf", "fps=5,scale=640:-2:flags=lanczos",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart",
        proxyPath,
      ],
      { label: "reframe compare proxy", timeoutMs: 15 * 60 * 1000 },
    );

    const args = [
      "-u", "-m", "core.reframe",
      "--video", proxyPath,
      "--clip-start", clipStart.toFixed(6),
      "--clip-end", clipEnd.toFixed(6),
      "--beats", beatsPath,
      "--source-width", String(Math.max(0, Number(media.width) || 0)),
      "--source-height", String(Math.max(0, Number(media.height) || 0)),
      "--output", planPath,
      "--candidates-output", candidatesPath,
    ];
    if (hasShots) args.push("--shots", shotsPath);
    const modelPath = process.env.REFRAME_FACE_MODEL?.trim();
    if (modelPath) args.push("--model", modelPath);
    await runChild(CORE_PYTHON, args, {
      cwd: REPO_ROOT,
      label: "core.reframe (compare)",
      timeoutMs: (Number(process.env.REFRAME_TIMEOUT_MIN) || 20) * 60 * 1000,
      env: { PYTHONPATH: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    const candidates = JSON.parse(await fs.promises.readFile(candidatesPath, "utf8")) as {
      timeline?: Array<{ start: number; end: number; layout: string }>;
      switchesPerMinute?: number;
    };

    // ── Contact sheet (§3): 시작·끝·분위수 + 샷 경계 + 레이아웃 전환 지점 ──
    let shotTimes: number[] = [];
    if (hasShots) {
      try {
        const rawShots = JSON.parse(await fs.promises.readFile(shotsPath, "utf8")) as unknown;
        const list = Array.isArray(rawShots)
          ? rawShots
          : Array.isArray((rawShots as { shots?: unknown[] })?.shots)
            ? (rawShots as { shots: unknown[] }).shots
            : [];
        shotTimes = list.map(Number).filter((t) => Number.isFinite(t));
      } catch { /* 샷은 보강 정보 — 없어도 시트는 성립한다 */ }
    }
    const layoutSwitches = (candidates.timeline ?? []).slice(1).map((run) => Number(run.start));
    const times = contactSheetTimes({
      start: clipStart, end: clipEnd, shots: shotTimes, layoutSwitches,
    });
    const frameNames: string[] = [];
    // 5fps 리샘플 프록시는 실제 길이가 (end-start)보다 짧을 수 있다 — 끝 지점 시킹이 EOF 를
    // 넘어가면 ffmpeg 는 exit 0 인 채 **프레임 0장**을 내고, 업로드가 ENOENT 로 터졌다
    // (2026-08-25 프로덕션 E2E 실측). 시킹을 끝-0.4초로 조이고, 그래도 빈 출력이면 그 장만
    // 건너뛴다 — contact sheet 는 보조물이라 한 장 때문에 잡 전체가 죽으면 안 된다.
    const maxRel = Math.max(0, clipEnd - clipStart - 0.4);
    for (const t of times) {
      const name = contactFrameName(t);
      const framePath = path.join(work, name);
      const rel = Math.min(Math.max(0, t - clipStart), maxRel);
      await runChild(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-ss", rel.toFixed(3), "-i", proxyPath,
          "-frames:v", "1", "-q:v", "4", framePath,
        ],
        { label: "compare frame", timeoutMs: 60 * 1000 },
      );
      if (fs.existsSync(framePath)) frameNames.push(name);
      else console.warn(`[worker] reframe.compare ${clipId}: 프레임 ${name} 빈 출력 — 건너뜀 (t=${t.toFixed(2)})`);
    }

    const prefix = compareArtifactPrefix(mediaId, clipId, compareId);
    await uploadFile(`${prefix}/candidates.json`, candidatesPath);
    await uploadFile(`${prefix}/proxy.mp4`, proxyPath);
    for (const name of frameNames) {
      await uploadFile(`${prefix}/${name}`, path.join(work, name));
    }
    const manifestPath = path.join(work, "index.json");
    await fs.promises.writeFile(manifestPath, JSON.stringify({
      version: 1,
      status: "ready",
      clipId,
      sourceMediaId: mediaId,
      compareId,
      clipStart,
      clipEnd,
      generatedAt: Date.now(),
      frames: frameNames,
      files: { candidates: "candidates.json", proxy: "proxy.mp4" },
      switchesPerMinute: candidates.switchesPerMinute ?? null,
    }, null, 2), "utf8");
    await uploadFile(`${prefix}/index.json`, manifestPath);
    console.log(`[worker] reframe.compare ${clipId}: ${frameNames.length} frames → ${prefix}`);
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function materializeAnalysisInput(
  mediaId: string,
  name: string,
  dest: string,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFile(`analysis/${mediaId}/${name}`);
  } catch {
    throw new Error(`${name} is unavailable for source media ${mediaId}`);
  }
  // Keep the complete source Beat timeline. beatIds on the clip are lineage/debug only;
  // filtering here would turn intervening Beats into synthetic Fit gaps and change meaning.
  await fs.promises.writeFile(dest, raw);
}

async function materializeOptionalAnalysisInput(mediaId: string, name: string, dest: string): Promise<boolean> {
  try {
    await fs.promises.writeFile(dest, await readFile(`analysis/${mediaId}/${name}`));
    return true;
  } catch {
    return false;
  }
}

async function signedProxySource(storedPath: string): Promise<string> {
  const { signedReadUrl } = await import("./media/storage-gcs.ts");
  return signedReadUrl(parseObjectPath(storedPath), 30 * 60 * 1000);
}

async function runChild(
  command: string,
  args: string[],
  opts: {
    label: string;
    timeoutMs: number;
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const tail: string[] = [];
    const collect = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        console.log(`[${opts.label}] ${line}`);
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${opts.label} ${timedOut ? "timed out" : `exited ${code}`}: ${tail.join("\n").slice(-3000)}`));
    });
  });
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

// The in-flight python child, killed on process exit so a worker restart doesn't leave an
// orphan racing the retried job on the same work dir (SIGKILL of node can't be caught, but
// normal exits and uncaught-exception exits can).
let activeChild: ReturnType<typeof spawn> | null = null;
process.on("exit", () => {
  if (activeChild && activeChild.exitCode == null) activeChild.kill("SIGKILL");
});

function runAnalyze(
  videoPath: string,
  outDir: string,
  onProgress: (p: Progress) => void,
  profilePath?: string,
  castPath?: string,
  fast?: boolean,
  programContextPath?: string,
  genre?: string,
  mediaId?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-u", "-m", "core.analyze", videoPath, "--out", outDir];
    if (mediaId) args.push("--media", mediaId);  // 검색 세그먼트 id 프리픽스 정합
    if (profilePath) args.push("--profile", profilePath);
    if (castPath) args.push("--cast", castPath);
    // 사용자가 프로그램 정보(시놉시스·태그·크레딧 등)를 입력해두면 recommend/retitle
    // 프롬프트에 컨텍스트 블록으로 주입 → AI가 이 프로그램의 결에 맞게 판단.
    if (programContextPath) args.push("--program-context", programContextPath);
    // 파이프라인 트랙 명시(variety|drama). 미지정이면 코어가 auto — Gemini 판정으로 부정확할 수
    // 있어 사용자가 EditProgramDialog에서 지정하는 게 정답. 씬 청크·shot 임계·recommend 팩 결정.
    if (genre === "variety" || genre === "drama") args.push("--genre", genre);
    if (fast) args.push("--fast");  // 자막만으로 빠른 추천 (시각 분석 스킵)
    // 2026-07-23: Windows에서 python native crash(0xC0000005) 가 tsx 워커 프로세스까지 kill
    // 하는 문제 관찰 (job object 공유로 인한 cascade). detached:true 로 별도 process group
    // 만들어 격리. stderr도 inherit → pipe로 signal 전파 차단.
    const isWindows = process.platform === "win32";
    // 이 실행이 시작된 시각 — 산출물이 "이번 것" 인지 "복원된 지난 회차 것" 인지 가른다.
    const spawnedAt = Date.now();
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
          // ⚠️ 이 값은 자식 env 에 **항상** 주입되므로 core 쪽 기본값보다 이게 이긴다.
          //    예전 기본값 "hybrid" 는 torch/faster-whisper 를 요구하는데 워커 이미지는
          //    그 스택을 일부러 뺐고, run_refine 도 hybrid≠soniox 로 보아 유료 Gemini
          //    정제를 한 번 더 돌렸다. 확정 스택인 "soniox" 로 맞춘다.
          //    (프로덕션 워커는 STT_PROVIDER=soniox 를 명시하므로 지문 변화 없음)
          STT_PROVIDER: process.env.STT_PROVIDER || "soniox",
          GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || "step-d",
          VERTEX_LOCATION: process.env.VERTEX_LOCATION || "asia-northeast3",
        },
        stdio: ["ignore", "pipe", "pipe"],  // stderr pipe (inherit 시 워커까지 kill 관찰)
        detached: isWindows,  // Windows job object 이탈 · 자식 crash가 부모 워커까지 kill되는 것 방지
        windowsHide: true,
      },
    );
    activeChild = proc;
    // 2026-07-23: proc.unref() — 워커가 python subprocess 종료를 wait하지 않게 함.
    // Python native crash 시 close event 처리 도중 워커까지 kill되던 이슈 대응.
    // stdin 읽기 안 함(ignore) + stdout/stderr는 pipe 로 별도 처리 후 unref.
    if (typeof proc.unref === "function") proc.unref();
    if (proc.stdin && typeof (proc.stdin as any).unref === "function") (proc.stdin as any).unref();
    if (proc.stdout && typeof (proc.stdout as any).unref === "function") (proc.stdout as any).unref();
    if (proc.stderr && typeof (proc.stderr as any).unref === "function") (proc.stderr as any).unref();
    // stderr 는 로그로 흘리되 **마지막 몇 줄은 붙잡아 둔다.**
    //
    // ⚠️ 예전에는 콘솔로만 보내고 버렸다. 그래서 파이썬이 죽으면 잡에 남는 건
    //    `core.analyze exited 1` 한 줄뿐이었고, 실제 트레이스백은 컨테이너 로그에만 있었다
    //    — 가장 비싼 잡(회차당 ≈₩285)이 정보가 가장 적었다. 운영자는 어드민 잡 표에서
    //    종료코드만 보고 원인을 알 수 없었다.
    //    같은 문제를 이미 해결해 둔 곳이 리포 안에 있다: 썸네일 스폰과 match.align 은
    //    `stderr.slice(-N)` 을 에러에 붙인다. 같은 방식을 여기에도 쓴다.
    const errTail: string[] = [];
    const ERR_TAIL_LINES = 40;
    if (proc.stderr) {
      const errRl = readline.createInterface({ input: proc.stderr });
      errRl.on("line", (line) => {
        console.error(`[core:err] ${line}`);
        errTail.push(line);
        if (errTail.length > ERR_TAIL_LINES) errTail.shift();
      });
    }
    /** 실패 메시지에 붙일 파이썬 stderr 꼬리. 없으면 빈 문자열. */
    const tail = () => (errTail.length ? `\n--- python stderr (마지막 ${errTail.length}줄) ---\n${errTail.join("\n")}` : "");

    // Stall watchdog: every stdout line re-arms it. The pipeline prints per-window/-frame/
    // -batch progress on stdout, so a long silence means a hung call, not slow work.
    let stalled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        console.error(`[worker] core.analyze: no output for ${STALL_TIMEOUT_MS / 60000}min — killing child`);
        proc.kill("SIGKILL");
      }, STALL_TIMEOUT_MS);
      if (typeof stallTimer.unref === "function") stallTimer.unref();
    };
    armStall();

    // Parse progress markers out of stdout; everything else passes through to the log.
    // @@COMPLETE 마커 감지 시 즉시 resolve — python close 이벤트 안 기다림.
    // Windows에서 python native cleanup crash로 exit code non-zero 되어도 결과는 유효
    // (analysis.json 이미 write됨). 2026-07-23 워커 안정성 개선.
    let earlyResolved = false;
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      armStall();
      if (line.startsWith("@@PROGRESS ")) {
        try {
          onProgress(JSON.parse(line.slice("@@PROGRESS ".length)) as Progress);
        } catch {
          // mangled marker — ignore, it's progress not data
        }
        return;
      }
      if (line.startsWith("@@COMPLETE ")) {
        console.log(`[core] ${line}`);
        if (!earlyResolved) {
          earlyResolved = true;
          if (stallTimer) clearTimeout(stallTimer);
          resolve();  // 조기 resolve. python이 이후 crash해도 이미 완료 처리됨
        }
        return;
      }
      console.log(`[core] ${line}`);
    });
    proc.on("close", (code) => {
      // 2026-07-26: close handler 자체를 try/catch로 감쌈 · 여기서 뿜는 예외가 워커 프로세스를
      // 죽여왔다 (Windows subprocess pipe close 이벤트 순서 문제 · uncaughtException 훅으로도
      // 못 잡힘 관찰). 절대 여기서 throw 나가지 않게.
      try {
        if (stallTimer) clearTimeout(stallTimer);
        activeChild = null;
        if (earlyResolved) return;
        if (stalled) {
          reject(new Error(
            `core.analyze stalled (${STALL_TIMEOUT_MS / 60000}min without output) — killed${tail()}`));
          return;
        }
        if (code === 0) { resolve(); return; }
        // ⚠️ **이번 실행이 만든 analysis.json 일 때만** 결과로 인정한다.
        //
        // 재분석은 시작할 때 GCS 체크포인트(analysis.json 포함)를 작업 디렉토리로 되돌린다.
        // 그래서 "파일이 있으면 성공" 으로 보면, 파이썬이 죽어도 **지난 회차 결과**를 이번
        // 분석 결과로 저장하고 회차를 progress:100·done 으로 찍어 버린다(크레딧까지 차감,
        // 실패 흔적 0). 바깥 catch 에는 같은 mtime 가드가 이미 있는데 여기서 먼저 resolve
        // 해버려 그 가드가 실행되지 않았다.
        const analysisPath = path.join(outDir, "analysis.json");
        const producedAt = (() => {
          try { return fs.statSync(analysisPath).mtimeMs; } catch { return 0; }
        })();
        if (producedAt >= spawnedAt) {
          console.warn(`[worker] core.analyze exited ${code} · @@COMPLETE 없음 · 이번 실행이 만든 analysis.json 존재하므로 결과 사용`);
          resolve();
          return;
        }
        if (producedAt > 0) {
          console.error(`[worker] core.analyze exited ${code} · analysis.json 은 지난 회차 것(mtime ${new Date(producedAt).toISOString()}) — 실패로 처리`);
        }
        reject(new Error(`core.analyze exited ${code}${tail()}`));
      } catch (e) {
        // ⚠️ 예전엔 여기서 삼키고 `resolve()` 했다 — **실패가 성공이 됐다.**
        //    close 핸들러에서 예외가 나가면 워커가 죽는다는 2026-07-26 관찰은 유효하므로
        //    throw 는 여전히 막되, **결과는 실패로 돌린다.** 조용한 성공보다 시끄러운 실패가 낫다.
        const why = e instanceof Error ? e.message : String(e);
        console.error("[worker] core.analyze close handler 예외:", e);
        try { reject(new Error(`core.analyze close handler 실패: ${why}${tail()}`)); } catch { /* 이미 정산됨 */ }
      }
    });
    proc.on("error", (err) => {
      try {
        if (stallTimer) clearTimeout(stallTimer);
        activeChild = null;
        // native crash 시 close도 error도 함께 fire될 수 있음 · earlyResolved면 무시.
        if (earlyResolved) return;
        console.warn("[worker] python subprocess error:", err.message);
        reject(err);
      } catch (e) {
        console.error("[worker] error handler err (swallowed):", e);
      }
    });
  });
}

// One AI-recommended short from core/recommend.py.
type Short = {
  rank?: number; appeal?: number; start?: number; end?: number;
  title?: string; reason?: string; tags?: string[];
  /** Core Beat lineage used by the downstream AI reframe planner. */
  beat_ids?: Array<number | string>;
  /** 3축 직교 스코어(각 0-10, 2026-07-23~). ⚠️ 2026-08-06 이후 회차는 **비어 있다** —
   *  LLM 점수는 실행마다 달라져 A/B 판정이 불가능해서 결정론 스코어로 교체했다. score_parts 참고. */
  hook_strength?: number; payoff?: number; completeness?: number;
  /** score100 의 근거 (2026-08-06~). signal·hook·length·closure 각 0-1 + has_signals. */
  score_parts?: Record<string, number | boolean>;
  /** 3축 가중합 0-100 (hook 0.40·payoff 0.35·completeness 0.25). 프론트 메인 스코어. */
  score100?: number;
  /** 쇼츠 첫 3초 hook intro (2026-07-31 · docs/plans/shorts-hook-intro-3sec.md).
   *  core/recommend.py propose_shorts_beat_only 가 채운다. 이탈 방지용 attention retention. */
  hook_quote?: string;         // 실 대사 원문 인용 (STT 그대로 · 30자 이내)
  hook_time_sec?: number | null; // hook 대사 시각 (쇼츠 시작 상대 · 첫 5초 이내 권장)
  hook_intro_caption?: string; // 어그로 편집자막 (20자 · "충격 고백!" 톤)
  /** 두 줄 제목 — core/recommend 가 **필수로** 뽑는다(title 은 폴백 한 줄).
   *  line1 = 상단 setup(오해·질문) · line2 = 하단 payoff(반전·정답) · color = line2 톤.
   *  ⚠️ 이 타입에 없어서 아래 매핑이 못 읽었고(2026-08-19까지), 그래서 추천에 두 줄이
   *  실리지 않아 제목 편집이 늘 한 줄로 떴다 — 타입 누락이 곧 데이터 유실이었다. */
  title_line1?: string;
  title_line2?: string;
  title_line2_color?: string;  // blue|red|yellow|green
  /** 처음 제목 생성 단계(_retitle_final_windows)에서 뽑힌 대체 제목 후보들.
   *  기본 title을 포함할 수도 있고 아닐 수도 있음 — 프론트는 dedupe 처리. */
  title_candidates?: string[];
  /** (후보 × 배포처) matrix from core/channels.py apply_channel_fit — absent when the
   *  analysis ran without destinations, or on any pre-matrix run. */
  channel_scores?: Record<string, ChannelScore>;
  /** 숏폼인가 롱폼인가 — core 가 붙인다. "clip"·"highlight" 는 가로형 본편(3분+). */
  type?: string;
  /** 롱폼의 화면비 힌트. core 의 클립은 "16:9". */
  aspect?: string;
  /** 8분 이상 = 유튜브 미드롤 광고 가능(2020-07 이후 기준). */
  monetizable?: boolean;
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
  const titleMain = s.title || "쇼츠 추천";
  const titleCandidates = Array.isArray(s.title_candidates)
    ? Array.from(new Set([titleMain, ...s.title_candidates.filter((t) => typeof t === "string" && t.trim())]))
    : undefined;
  // ⚠️ core 가 붙인 `type` 을 버리면 **클립이 영원히 안 나간다.** 예전엔 여기서 전부
  // "short" 로 못박아, 자동배포 규칙에서 미디어 종류를 '클립'으로 골라도 후보가 0건이었다
  // (automation.ts selectCandidates 가 kind 로 거른다). 롱폼은 가로형이 기본이다.
  const isClip = s.type === "clip" || s.type === "highlight";
  return {
    id,
    episodeId,
    kind: isClip ? "clip" : "short",
    /** 채택 시 렌더 화면비의 출발점 — 클립은 본편 그대로 가로형. */
    aspectRatio: typeof s.aspect === "string" && s.aspect ? s.aspect : (isClip ? "16:9" : undefined),
    /** 8분 이상이면 유튜브 미드롤 광고를 붙일 수 있다 — 화면이 이걸 배지로 보여준다. */
    monetizable: s.monetizable === true ? true : undefined,
    title: titleMain,
    titleCandidates,
    // 두 줄 제목 (2026-07-29 설계 · 2026-08-19 배선). recommend 가 **필수로** 뽑는데
    // (core/recommend/recommend.py: "title_line1 + title_line2 를 필수로 뽑는다") 여기서
    // 안 읽어서 추천 엔티티에 실리지 않았다 → 채택된 클립의 titleLine1/2 가 늘 undefined →
    // makeInitialEditorState 가 한 줄 분기로 떨어져 **제목 편집에 컴포넌트가 하나만** 떴다.
    // 소비처(에디터·factory)는 멀쩡한데 생산처에서 끊긴 경우라 파리티 테스트도 초록이었다.
    // 실측(2026-08-19): shorts.json 8/8 · 20/20 전부 두 줄을 갖고 있었다.
    titleLine1: typeof s.title_line1 === "string" && s.title_line1.trim() ? s.title_line1.trim() : undefined,
    titleLine2: typeof s.title_line2 === "string" && s.title_line2.trim() ? s.title_line2.trim() : undefined,
    // 둘째 줄 강조색(blue|red|yellow|green). 색까지 안 실으면 AI 가 고른 톤(폭로=red 등)이
    // 사라지고 항상 파랑으로 굳는다 — 줄만 살리고 색을 버리면 같은 종류의 누락이 남는다.
    titleLine2Color: typeof s.title_line2_color === "string" && s.title_line2_color.trim()
      ? s.title_line2_color.trim().toLowerCase() : undefined,
    appeal: Math.max(1, Math.min(5, appeal)),
    // 신규 스코어(있으면 그대로 전달). 프론트 카드가 score100 우선 표시.
    score100: typeof s.score100 === "number" ? s.score100 : undefined,
    hookStrength: typeof s.hook_strength === "number" ? s.hook_strength : undefined,
    payoff: typeof s.payoff === "number" ? s.payoff : undefined,
    completeness: typeof s.completeness === "number" ? s.completeness : undefined,
    // score100 근거 (2026-08-06~). 이게 없으면 카드가 "왜 이 점수인지" 를 못 보여준다 —
    // 3축을 걷어낸 자리를 대체한다.
    scoreParts: s.score_parts && typeof s.score_parts === "object" ? s.score_parts : undefined,
    // 쇼츠 첫 3초 hook intro (2026-07-31). core가 채운 값을 rec 엔티티로 흘려보내 카드·에디터가
    // 미리보기·편집할 수 있게 한다. 비어 있으면 undefined (옛 회차/미생성 안전).
    hookQuote: typeof s.hook_quote === "string" && s.hook_quote.trim() ? s.hook_quote.trim() : undefined,
    hookTimeSec: typeof s.hook_time_sec === "number" ? s.hook_time_sec : undefined,
    hookIntroCaption:
      typeof s.hook_intro_caption === "string" && s.hook_intro_caption.trim()
        ? s.hook_intro_caption.trim()
        : undefined,
    startTime: start,
    endTime: end,
    editNote: s.reason || "",
    beatIds: normalizeBeatIds(s.beat_ids),
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
 * 파이프라인 → program 역방향 동기화 (2026-07-24).
 *
 * 워커가 확정한 얼굴 클러스터↔이름 매핑(faces.json.mapping)을 프로그램 상세로 반영:
 * 1) mapping 확정 이름 중 program.cast에 없는 것 append (기존 이름 유지, orphan 정리 안 함)
 * 2) 확정 이름의 program.castPhotos[name]이 비어있으면 클러스터 대표 프레임을 dataURL로 세팅
 *
 * 이렇게 하면 사용자는 프로그램 만들자마자 분석 한 번 돌리면 출연자 목록·사진이 자동 채워짐.
 * 다음 회차 분석엔 이 채워진 정보(cast_registry + castPhotos embedding)가 다시 primary source로
 * 넘어가 정확도가 계속 올라감.
 */
export async function syncProgramFromFacesForMedia(
  programId: string,
  mediaId: string,
): Promise<{ addedNames: string[]; addedPhotos: string[]; workDirExists: boolean }> {
  const work = workDirFor(mediaId);
  if (!fs.existsSync(work)) {
    return { addedNames: [], addedPhotos: [], workDirExists: false };
  }
  const r = await syncProgramFromFaces(programId, work);
  return { ...r, workDirExists: true };
}

async function syncProgramFromFaces(
  programId: string,
  workDir: string,
): Promise<{ addedNames: string[]; addedPhotos: string[] }> {
  const facesPath = path.join(workDir, "faces.json");
  if (!fs.existsSync(facesPath)) return { addedNames: [], addedPhotos: [] };
  let faces: any;
  try { faces = JSON.parse(fs.readFileSync(facesPath, "utf-8")); }
  catch { return { addedNames: [], addedPhotos: [] }; }
  const mapping = (faces?.mapping || {}) as Record<string, string>;
  const clusters = (faces?.clusters || {}) as Record<string, any>;
  // 확정 이름만: '?', 'NARR', 공백, 알려진 sentinel 제외.
  const confirmed: { label: string; name: string }[] = [];
  const RESERVED = new Set(["?", "NARR", "narr", "unknown", "N/A", "-"]);
  for (const [lbl, nm] of Object.entries(mapping)) {
    const clean = String(nm || "").trim();
    if (!clean || RESERVED.has(clean)) continue;
    confirmed.push({ label: lbl, name: clean });
  }
  if (confirmed.length === 0) return { addedNames: [], addedPhotos: [] };

  const program = await getEntity<any>("program", programId);
  if (!program) return { addedNames: [], addedPhotos: [] };

  const prevCast: string[] = Array.isArray(program.cast) ? program.cast.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
  const prevCastSet = new Set(prevCast);
  const nextCast = [...prevCast];
  const addedNames: string[] = [];
  for (const { name } of confirmed) {
    if (!prevCastSet.has(name)) {
      nextCast.push(name);
      prevCastSet.add(name);
      addedNames.push(name);
    }
  }

  const prevPhotos = (program.castPhotos && typeof program.castPhotos === "object")
    ? { ...program.castPhotos } as Record<string, string>
    : {};
  const addedPhotos: string[] = [];
  for (const { label, name } of confirmed) {
    if (prevPhotos[name]) continue; // 이미 사용자·이전 sync가 채운 사진 유지
    const meta = clusters[label];
    const reps = Array.isArray(meta?.representative_frames) ? meta.representative_frames : [];
    if (reps.length === 0) continue;
    const relPath = String(reps[0]);
    const absPath = path.join(workDir, relPath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const buf = fs.readFileSync(absPath);
      if (buf.length > 256 * 1024) continue; // UI 상한과 같은 제한
      const ext = relPath.toLowerCase().endsWith(".png") ? "png"
        : relPath.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
      prevPhotos[name] = `data:image/${ext};base64,${buf.toString("base64")}`;
      addedPhotos.push(name);
    } catch { /* 다음 이름 계속 */ }
  }

  if (addedNames.length === 0 && addedPhotos.length === 0) return { addedNames: [], addedPhotos: [] };
  const nextProgram = { ...program, cast: nextCast, castPhotos: prevPhotos };
  await putEntity("program", programId, nextProgram);
  return { addedNames, addedPhotos };
}


/**
 * Surface the AI shorts on the episode's recommendation board.
 * Idempotent: on a re-run it clears prior *pending* recs and re-inserts fresh ones,
 * but PRESERVES operator decisions (adopted/rejected) — those carry a clip link and
 * a reject reason that a blind delete would orphan. New recs that overlap a preserved
 * decision are skipped so the same span isn't offered (and re-adopted) twice.
 * Degenerate spans are dropped, not silently stretched.
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
  // Snapshot operator-decided recs (anything not 'pending') BEFORE deleting, so we can
  // both keep them and avoid re-offering their spans.
  const { rows: kept } = await getPool().query<{ startTime: number; endTime: number }>(
    `SELECT (data->>'startTime')::float8 AS "startTime", (data->>'endTime')::float8 AS "endTime"
       FROM entities
      WHERE kind = 'recommendation'
        AND data->>'episodeId' = $1
        AND COALESCE(data->>'status', 'pending') <> 'pending'`,
    [episodeId],
  );
  // Two spans "overlap" when they share >50% of the shorter span — enough to treat the
  // new pick as the same clip the operator already handled.
  const overlapsKept = (start: number, end: number) =>
    kept.some((k) => {
      const inter = Math.min(end, k.endTime) - Math.max(start, k.startTime);
      if (inter <= 0) return false;
      const shorter = Math.min(end - start, k.endTime - k.startTime) || 1;
      return inter / shorter > 0.5;
    });
  const fresh = valid.filter((s) => !overlapsKept(Number(s.start) || 0, Number(s.end) || 0));
  const sorted = [...fresh].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  // Delete + re-insert as ONE transaction: an error mid-insert must not leave the board
  // half-emptied while the analysis job records success (nothing would ever retry it).
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM entities WHERE kind = 'recommendation' AND data->>'episodeId' = $1
         AND COALESCE(data->>'status', 'pending') = 'pending'`,
      [episodeId],
    );
    // Insert worst-rank first so prepend semantics leave rank 1 at the front of the board.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const rec = recFromShort(episodeId, sorted[i]);
      const { rows } = await client.query(
        "SELECT COALESCE(MIN(ord), 0) - 1 AS m FROM entities WHERE kind = 'recommendation'",
      );
      await client.query(
        `INSERT INTO entities (kind, id, data, ord) VALUES ('recommendation', $1, $2::jsonb, $3)
         ON CONFLICT (kind, id) DO UPDATE SET data = $2::jsonb, ord = $3`,
        [rec.id, JSON.stringify(rec), rows[0].m],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return sorted.length;
  }

  /**
   * 썸네일 생성 스테이지 (Phase 1+2+3 분리: Planner → Generator → Compositor).
   * analysis.json이 이미 있고 shorts[]가 확정된 시점에서 호출된다.
   * 각 shorts(추천)당 1~3개 variant 썸네일 생성 → GCS 업로드 → recommendation.data.thumbnails[] 갱신.
   */
  async function runThumbnailGeneration(
    mediaId: string,
    episodeId: string,
    shorts: Short[],
    workDir: string,
  ): Promise<void> {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { uploadFile } = await import("./media/storage-gcs.ts");
    const { getPool, putEntity } = await import("./db-pg.ts");

    // workDir 안에 썸네일 출력 폴더
    const thumbOutDir = path.join(workDir, "thumbnails");
    fs.mkdirSync(thumbOutDir, { recursive: true });

    // GCS 에서 template references 를 workdir/thumbnail-refs/ 로 sync (Cloud Run 이 GCS 에 저장한 것)
    // 로컬 pm2 워커에서도 GCS ADC 로 접근 가능 · assets/thumbnail-reference/ 로컬 파일이 없을 수도 있으니.
    const refsCacheDir = path.join(workDir, "thumbnail-refs");
    try {
      const { useGcs, readFile, fileExists } = await import("./media/storage-gcs.ts");
      if (useGcs()) {
        const manifestGcs = "templates/thumbnail/manifest.json";
        if (await fileExists(manifestGcs)) {
          fs.mkdirSync(refsCacheDir, { recursive: true });
          fs.mkdirSync(path.join(refsCacheDir, "cleaned"), { recursive: true });
          const manifestBuf = await readFile(manifestGcs);
          const entries = JSON.parse(manifestBuf.toString("utf-8"));
          // 로컬 manifest 는 path 를 상대경로 (파일명) 로 재작성
          const localEntries: any[] = [];
          for (const e of entries) {
            const fname = String(e.path || "").split("/").pop() || "";
            if (!fname) continue;
            const origGcs = String(e.path).startsWith("templates/")
              ? String(e.path)
              : `templates/thumbnail/${fname}`;
            try {
              const b = await readFile(origGcs);
              fs.writeFileSync(path.join(refsCacheDir, fname), b);
            } catch (err) { console.warn(`[thumb-sync] orig fail ${e.id}`, err); continue; }
            const local: any = { ...e, path: fname };
            if (e.cleaned_path) {
              const cf = String(e.cleaned_path).split("/").pop() || "";
              const cGcs = String(e.cleaned_path).startsWith("templates/")
                ? String(e.cleaned_path)
                : `templates/thumbnail/cleaned/${cf}`;
              try {
                const cb = await readFile(cGcs);
                fs.writeFileSync(path.join(refsCacheDir, "cleaned", cf), cb);
                local.cleaned_path = `cleaned/${cf}`;
              } catch (err) { console.warn(`[thumb-sync] cleaned fail ${e.id}`, err); }
            }
            localEntries.push(local);
          }
          fs.writeFileSync(path.join(refsCacheDir, "manifest.json"),
                           JSON.stringify(localEntries, null, 2), "utf-8");
          console.log(`[thumb-sync] ${localEntries.length} refs → ${refsCacheDir}`);
        }
      }
    } catch (err) {
      console.warn("[thumb-sync] GCS sync failed (falling back to local assets/)", err);
    }

    // shorts_context.json 생성 (planner가 읽음)
    const shortsContextPath = path.join(workDir, "shorts_context.json");
    // analysis.json에서 shorts 정보 추출
    const analysisPath = path.join(workDir, "analysis.json");
    let analysis: any = {};
    if (fs.existsSync(analysisPath)) {
      analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
    }

    // program_context.json이 있으면 그것 사용, 없으면 최소 컨텍스트 구성
    let programInfo = analysis.program || {};
    if (!programInfo.title) {
      // program_context.json에서 로드 시도
      const pcPath = path.join(workDir, "program_context.json");
      if (fs.existsSync(pcPath)) {
        programInfo = JSON.parse(fs.readFileSync(pcPath, "utf-8"));
      }
    }

    for (const short of shorts) {
      const shortId = `s${short.rank ?? 1}`;
      const variantCount = 3; // 각 shorts당 3개 variant

      // shorts_context 구성 (planner용)
      const shortsCtx = {
        title: short.title || "쇼츠",
        description: short.reason || "",
        cast_names: programInfo.cast || [],
        program: programInfo,
      };
      fs.writeFileSync(shortsContextPath, JSON.stringify(shortsCtx), "utf-8");

      // 썸네일 세션 실행 (Planner → Generator → Compositor 다종 생성)
      // python -m core.thumbnail --media-dir <workDir> --out <thumbOutDir>/<shortId> --multi 3
      const shortThumbOutDir = path.join(thumbOutDir, shortId);
      fs.mkdirSync(shortThumbOutDir, { recursive: true });

      const args = ["-m", "core.thumbnail", "--media-dir", workDir, "--out", shortThumbOutDir, "--multi", String(variantCount)];
      const isWindows = process.platform === "win32";

      console.log(`[thumbnail] Spawning: ${CORE_PYTHON} ${args.join(" ")}`);

      const child = spawn(CORE_PYTHON, args, {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: "",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          // 워커가 GCS 에서 sync 한 refs 있으면 pipeline 이 이것 우선 사용
          ...(fs.existsSync(path.join(refsCacheDir, "manifest.json"))
            ? { THUMBNAIL_REFS_DIR: refsCacheDir }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: isWindows,
        windowsHide: true,
      });

      let stdout = "";
      child.stdout.on("data", (d) => { stdout += String(d); });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += String(d); });

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`core.thumbnail exited ${code}: ${stderr.slice(-800)}`));
        });
        child.on("error", reject);
      });

      // 파이썬 실행 결과 분석 (multi_session.json)
      const multiLogPath = path.join(shortThumbOutDir, "multi_session.json");
      if (!fs.existsSync(multiLogPath)) {
        console.warn(`[thumbnail] ${mediaId}/${shortId} failed: no multi_session.json output`);
        continue;
      }

      const results = JSON.parse(fs.readFileSync(multiLogPath, "utf-8")) as any[];

      for (const result of results) {
        if (result.status !== "completed" || !result.exported_paths) {
          console.warn(`[thumbnail] ${mediaId}/${shortId} variant failed: ${result.error}`);
          continue;
        }

        const variantId = result.variant_id || `v${result.exported_paths["16:9"]?.match(/_v(\d+)_/)?.[1] || 1}`;

        // GCS 업로드: analysis/{mediaId}/thumbnails/{shortId}/{variantId}_{ratio}.png
        const uploaded: Record<string, string> = {};
        for (const [ratio, localPath] of Object.entries(result.exported_paths as Record<string, string>)) {
          const ratioStr = ratio.replace(":", "x");
          const gcsPath = `analysis/${mediaId}/thumbnails/${shortId}/${variantId}_${ratioStr}.png`;
          try {
            await uploadFile(gcsPath, localPath);
            uploaded[ratio] = gcsPath;
            console.log(`[thumbnail] ${mediaId}: uploaded ${ratio} → ${gcsPath}`);
          } catch (e) {
            console.error(`[thumbnail] ${mediaId}: upload failed for ${ratio}`, e);
          }
        }

        // recommendation 엔티티의 thumbnails 필드 업데이트
        const { rows } = await getPool().query(
          `SELECT id, data FROM entities WHERE kind = 'recommendation' AND data->>'episodeId' = $1 AND (data->>'startTime')::float8 = $2`,
          [episodeId, Number(short.start) || 0]
        );
        if (rows.length > 0) {
          const rec = rows[0];
          const recData = typeof rec.data === "string" ? JSON.parse(rec.data) : rec.data;
          const thumbnails = Array.isArray(recData.thumbnails) ? recData.thumbnails : [];
          const existingIndex = thumbnails.findIndex((thumbnail: any) => thumbnail?.id === variantId);
          const thumbnail = {
            id: variantId,
            urls: uploaded,
            aspect_ratios: Object.keys(uploaded),
            frame_source_sec: Number(short.start) + 0.5,
            caption_text: short.title || "",
            caption_tone: "기본",
            layout_preset: "variety",
            person_bbox_used: result.plan?.person?.face_bbox_canvas || [],
            generated_at: Date.now(),
            // The first successful generated variant is the default selection.
            chosen: thumbnails.length === 0,
          };
          if (existingIndex >= 0) thumbnails[existingIndex] = { ...thumbnails[existingIndex], ...thumbnail, chosen: Boolean(thumbnails[existingIndex]?.chosen) };
          else thumbnails.push(thumbnail);
          const selectedThumbnailId = recData.selectedThumbnailId && thumbnails.some((item: any) => item.id === recData.selectedThumbnailId)
            ? recData.selectedThumbnailId
            : thumbnails.find((item: any) => item.chosen)?.id ?? thumbnails[0]?.id;
          recData.selectedThumbnailId = selectedThumbnailId;
          recData.thumbnails = thumbnails.map((item: any) => ({ ...item, chosen: item.id === selectedThumbnailId }));
          await putEntity("recommendation", rec.id, recData);
        }
      }
    }
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
      if (!fs.existsSync(local)) continue;
      // ⚠️ fallback 이 만든 boundaries.json 을 올리면 **GEBD 결과를 덮어쓴다.**
      // 순서가 이렇게 된다: ①content.analyze 가 fallback 으로 완주 ②gebd.detect 가 정밀
      // boundaries.json 을 GCS 에 올림 ③재분석이 다시 fallback 을 만들어 **②를 덮음**.
      // 실측(2026-08-07): 재분석 로그가 `source=shots_fallback` 이었다 — GPU 를 돌린 게 헛일이 된다.
      // GEBD 산출물(source="gebd")만 올린다. fallback 은 어차피 매 실행 재생성되므로 손해가 없다.
      if (name === "boundaries.json") {
        try {
          const src = JSON.parse(fs.readFileSync(local, "utf8"))?.source;
          if (src !== "gebd") continue;
        } catch { continue; }
      }
      await uploadFile(`${base}/${name}`, local);
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
    // face_clusters/ — 얼굴 클러스터별 대표 크롭. UI 인물 매핑 화면에서 <img src>로 뜸.
    const faceDir = path.join(work, "face_clusters");
    if (fs.existsSync(faceDir)) {
      const faceFiles = fs.readdirSync(faceDir).filter((f) => f.endsWith(".jpg"));
      const CONCURRENCY = 8;
      for (let i = 0; i < faceFiles.length; i += CONCURRENCY) {
        await Promise.all(
          faceFiles.slice(i, i + CONCURRENCY).map((f) =>
            uploadFile(`${base}/face_clusters/${f}`, path.join(faceDir, f)),
          ),
        );
      }
    }
    // ppl_frames/ — PPL 검출 구간별 대표 프레임. UI PPL 카드에서 썸네일로 뜸.
    const pplDir = path.join(work, "ppl_frames");
    if (fs.existsSync(pplDir)) {
      const pplFiles = fs.readdirSync(pplDir).filter((f) => f.endsWith(".jpg"));
      const CONCURRENCY = 8;
      for (let i = 0; i < pplFiles.length; i += CONCURRENCY) {
        await Promise.all(
          pplFiles.slice(i, i + CONCURRENCY).map((f) =>
            uploadFile(`${base}/ppl_frames/${f}`, path.join(pplDir, f)),
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
      provider: process.env.STT_PROVIDER || "soniox",
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

/** Run the content pipeline for one uploaded media and persist the result.
 *  `fast`(잡 페이로드 fast:true) — 자막만으로 빠른 추천, 시각 분석 스킵(~10배). 기본 false=풀. */
export async function runContentAnalyze(
  mediaId: string, fast = false,
  /** 이 잡의 시도 횟수 — 마지막 시도면 "재시도 대기" 라고 거짓 안내하지 않기 위해 쓴다. */
  attempt?: { n: number; max: number },
): Promise<void> {
  // 잡 페이로드 fast:true 또는 워커 전역 CORE_ANALYZE_FAST=1 이면 빠른 모드. 대량 배치용 전역 스위치.
  fast = fast || process.env.CORE_ANALYZE_FAST === "1";
  const media = await getMedia(mediaId);
  if (!media) throw new Error(`content.analyze: media ${mediaId} not found`);

  // ── 크레딧 게이트 — **분석을 시작하는 마지막 길목** (2026-08-26 사용자 확정 규칙) ──
  //
  // 규칙: "잔액 40 에 60분 영상이 들어오면 분석에 들어가면 안 된다. 돈 받고 시작."
  // 즉 불변식은 **잔액 ≥ 이 영상의 필요 크레딧** 이다.
  //
  // 큐잉 시점 게이트(라우트·factory·media.prepare·youtube.download)만으로는 이 불변식이
  // 지켜지지 않았다. 세 가지 구멍이 있었다:
  //   1. **길이를 모르면 통과**했다 — creditBlockReason 은 need<=0 이면 null 을 돌려주고
  //      checkCredits 도 need===0 을 allow 로 본다. 프로브 실패·업로드 직후처럼 durationSec 이
  //      0 인 미디어는 잔액이 0 이어도 60분 분석이 시작됐다.
  //   2. **큐잉과 실행 사이가 벌어진다** — 차감은 분석이 끝난 뒤라(아래 recordUsage 부근),
  //      큐잉 때 통과한 영상 여러 개가 전부 같은 잔액을 보고 통과한 뒤 순서대로 실행된다.
  //   3. **게이트를 안 거치는 큐잉 경로**가 있다(어드민 큐 정리·GEBD 완료 후 재큐잉).
  //
  // 여기는 그 셋이 모두 합류하는 **한 지점**이다. 실행 직전이라 길이도 이미 확정돼 있고,
  // 앞 영상의 차감도 이미 반영돼 있다. 부족하면 자동 결제를 먼저 시도하고(고정 정책),
  // 그래도 모자라면 **시작하지 않는다** — 던져서 잡을 실패시킨다(조용한 통과 금지).
  //
  // ⚠️ **길이를 모르는 미디어(durationSec=0)를 그냥 통과시키면 안 된다.** 그 상태에 영구히
  // 갇히는 실제 경로가 있다: handleMediaPrepare 가 promoteUpload(바이트를 운영 버킷으로)를
  // updateMediaSource 보다 **먼저** 하므로, 그 사이 probe 실패로 죽으면 DB 는 durationSec=0
  // 인데 바이트는 운영 버킷에 있다 → 다운로드는 성공하고 → need=0 이라 게이트가 꺼지고 →
  // 차감도 billableMinutes(0)=0 이라 안 된다. **잔액 0 으로 60분 분석이 공짜로, 재분석마다
  // 반복해서** 돌아간다(2026-08-26 감사). 그래서 길이를 모르면 통과가 아니라 **여기서 잰다.**
  const gateCredits = async (durationSec: number, where: string): Promise<void> => {
    const need = billableMinutes(durationSec ?? 0);
    if (need <= 0) return;                    // 호출부가 길이 확정 책임을 진다(아래 2단 배선)
    let verdict = checkCredits({ balance: await creditBalance(), needMinutes: need });
    if (!verdict.allow) {
      // 저장 카드가 있으면 여기서 채워진다 — "돈 받고 시작" 의 '돈 받는' 자리.
      verdict = (await topupAndRecheck(need)) ?? verdict;
    }
    if (verdict.allow) return;
    // 회차 화면이 오지 않을 완료를 기다리지 않게 사유를 남긴다(자동배포 순방의
    // episodeAnalysisState 가 이 문구의 '크레딧/충전'을 읽어 blocked 로 센다).
    if (media.episodeId) {
      await setEpisodePipeline(media.episodeId, {
        stage: "credit", stageStatus: "warn",
        note: `크레딧 부족 — ${verdict.reason} 충전 후 다시 시작해 주세요.`,
      }).catch(() => {});
    }
    throw new Error(`content.analyze: 크레딧 부족으로 시작하지 않음 (${where} · 필요 ${need}분) — ${verdict.reason}`);
  };

  // 1단 — 아는 길이로 먼저 막는다. 여기서 걸리면 다운로드 이그레스도 안 쓴다.
  await gateCredits(media.durationSec ?? 0, "큐잉 길이");

  sweepStaleWorkDirs();
  const work = workDirFor(mediaId);
  fs.mkdirSync(work, { recursive: true });

  // ── GCS → workdir 체크포인트 복원 (2026-08-07 신설) ────────────────────────
  //
  // ⚠️ 이게 없으면 **Cloud Run Jobs 에서 파이프라인이 성립하지 않는다.**
  // CHECKPOINT_FILES 는 여태 **업로드에만** 쓰였다. 옛 워커는 GCE VM 이라 workdir 가 디스크에
  // 남아서 문제가 없었는데, Cloud Run Job 은 실행마다 **새 컨테이너**라 workdir 가 늘 비어 있다.
  // 그래서 실측으로 세 가지가 깨졌다:
  //   1. gebd.detect 가 올린 boundaries.json 이 안 내려와 **GEBD 결과가 영영 소비되지 않음**
  //   2. AUTO_GEBD 가 "boundaries.json 없음"을 매번 보고 gebd.detect 를 **무한 재큐**
  //   3. stt.json 이 없으니 재시도마다 **STT 를 다시 구매** (회차당 ₩135)
  // 지문(manifest.json)은 같이 복원돼야 의미가 있다 — 없으면 전 단계가 재생성된다.
  if (useGcs()) {
    let restored = 0;
    await Promise.all(
      CHECKPOINT_FILES.map(async (name) => {
        const local = path.join(work, name);
        if (fs.existsSync(local)) return;            // 이번 실행이 이미 만든 것은 건드리지 않는다
        try {
          const buf = await readFile(`analysis/${mediaId}/${name}`);
          fs.writeFileSync(local, buf);
          restored++;
        } catch { /* 없으면 그만 — 첫 분석이면 정상이다 */ }
      }),
    );
    if (restored) console.log(`[worker] content.analyze ${mediaId}: 체크포인트 ${restored}개 GCS 복원`);
  }

  const videoPath = path.join(work, `source${path.extname(media.filename) || ".mp4"}`);

  // Hoisted so the catch can drain in-flight progress writes before writing the error
  // status — otherwise a late "progress 40%" write can overwrite "error" (last writer wins).
  let chain = Promise.resolve();

  try {
    // A retry reuses the already-downloaded source (size must match — a mismatch
    // means the previous download was cut off, so pull it again).
    const have = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : -1;
    if (have === media.size && have > 0) {
      console.log(`[worker] content.analyze ${mediaId}: reusing downloaded source (resume)`);
    } else {
      await downloadToTemp(media.path, videoPath);
    }

    // ── 2단 크레딧 게이트 — **길이를 모르던 미디어는 여기서 확정하고 다시 잰다** ──
    //
    // 소스가 로컬에 있으니 이제 진짜 길이를 알 수 있다. 이 백필이 없으면 durationSec=0 에
    // 갇힌 미디어는 ① 게이트를 통과하고 ② 차감도 0 이라 **재분석할 때마다 영구히 공짜**다
    // (2026-08-26 감사 · handleMediaPrepare 의 promote→probe 순서 때문에 실제로 생긴다).
    // 파이썬 스폰(회차당 ≈₩800) **앞**이라 여기서 막으면 실원가는 다운로드 이그레스뿐이다.
    // 백필은 실패해도 분석을 막지 않는다 — 다만 그 경우 길이는 여전히 미상이라 아래 가드가 선다.
    if (!(Number(media.durationSec) > 0)) {
      let probed = 0;
      try {
        probed = Number((await probe(videoPath)).durationSec) || 0;
      } catch (e) {
        console.warn(`[worker] content.analyze ${mediaId}: 길이 재측정 실패:`,
          e instanceof Error ? e.message : e);
      }
      if (probed > 0) {
        // DB 에 박아 둔다 — 차감(billableMinutes)도 이 값을 읽으므로, 백필하지 않으면
        // 게이트만 통과시키고 정산은 0 으로 하는 반쪽이 된다.
        await updateMediaDuration(mediaId, probed).catch((e: unknown) =>
          console.warn(`[worker] content.analyze ${mediaId}: 길이 저장 실패:`, e instanceof Error ? e.message : e));
        media.durationSec = probed;
        await gateCredits(probed, "실측 길이");
      } else {
        // 길이를 끝내 모르면 **시작하지 않는다.** 모르면 안 내보낸다 — 통과시키면
        // 원가는 나가는데 차감은 0 인 무료 분석이 된다.
        throw new Error(
          `content.analyze: 영상 길이를 확인하지 못해 시작하지 않음 (mediaId=${mediaId}) — 원본이 정상인지 확인해 주세요.`,
        );
      }
    }

    // GEBD 자동 트리거 (2026-08-06 · 장면전환 모델을 워커에 배선).
    // 조건: AUTO_GEBD=1 · GCS_BUCKET 세팅 (gebd.detect 는 gsutil+Docker+GPU 전제 = GEBD VM) ·
    // boundaries.json 미존재. GEBD 잡이 별도로 완주하면 content.analyze 를 새 dedupeKey 로 재큐 →
    // 재개 시 boundaries.json 를 소비해 정밀 beats/shorts. 지금 실행은 fallback 로 완주 (blocking 안 함).
    // 로컬 워커는 gsutil/Docker 없으므로 자동 skip.
    if (process.env.AUTO_GEBD === "1" && process.env.GCS_BUCKET) {
      try {
        const boundariesLocal = path.join(work, "boundaries.json");
        if (!fs.existsSync(boundariesLocal)) {
          const workdirGcsPrefix = `analysis/${mediaId}`;
          const gebdId = await enqueue(
            "gebd.detect",
            { mediaId, videoGcsPath: media.path, workdirGcsPrefix },
            { dedupeKey: `gebd.detect:${mediaId}` },
          );
          if (gebdId) console.log(`[worker] content.analyze ${mediaId}: gebd.detect 큐잉 (${gebdId}) — 완주 후 재분석 예정`);
        }
      } catch (e) {
        console.warn(`[worker] content.analyze ${mediaId}: gebd 큐잉 실패 (무시)`, e);
      }
    }

    // Mirror pipeline progress onto the episode (throttled — every line is a DB write).
    let lastPct = -10;
    let lastWrite = 0;
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
    let programContextPath: string | undefined;
    // 파이프라인 트랙 — try 블록 안에서 결정된 값을 밖에서 runAnalyze 호출할 때 써야 하므로 hoist.
    let pipelineGenre: string | undefined;
    try {
      const episode = media.episodeId ? await getEntity<any>("episode", media.episodeId) : undefined;
      const program = episode?.programId ? await getEntity<any>("program", episode.programId) : undefined;
      if (program?.pipelineGenre === "variety" || program?.pipelineGenre === "drama") {
        pipelineGenre = program.pipelineGenre;
      }
      // 우선순위: 사람이 입력한 프로그램 프로파일 > 학습된 채널 프로파일. 둘 다 recommend가
      // 같은 형식으로 읽는다. 채널 프로파일은 learn_profile이 만든 recommend_profile을 쓴다.
      let profileObj: unknown = program?.profile && typeof program.profile === "object" ? program.profile : null;
      if (!profileObj && episode?.sourceChannelId) {
        const cp = await getChannelPointProfile(episode.sourceChannelId);
        const prof = cp?.profile as { recommend_profile?: unknown; confidence?: number } | null;
        const rp = prof?.recommend_profile;
        const conf = Number(prof?.confidence) || 0;
        // ⚠️ 신뢰도 게이트: 저신뢰(소표본) 프로파일은 자동 적용하지 않는다. 2026-07-21 A/B 실측 —
        // conf 0.6 프로파일이 홀드아웃 Hit@5를 0.67→0.33으로 오히려 떨어뜨렸다(hookWeights가
        // 5개 훅에 균일 1.3으로 뭉개져 랭킹을 흔듦). 검증 없이 적용하면 회귀다. 기준은 실측 후
        // 상향 가능. CHANNEL_PROFILE_MIN_CONF로 조정.
        const minConf = Number(process.env.CHANNEL_PROFILE_MIN_CONF) || 0.75;
        if (rp && typeof rp === "object" && conf >= minConf) {
          profileObj = rp;
          console.log(`[worker] content.analyze ${mediaId}: 채널 학습 프로파일 적용 (conf ${conf} ≥ ${minConf})`);
        } else if (rp) {
          console.log(`[worker] content.analyze ${mediaId}: 채널 프로파일 있으나 신뢰도 미달(conf ${conf} < ${minConf}) — 미적용`);
        }
      }
      if (profileObj) {
        profilePath = path.join(work, "profile.json");
        fs.writeFileSync(profilePath, JSON.stringify(profileObj), "utf-8");
      }
      if (episode?.programId) {
        const roster = await listProgramCast(episode.programId);
        if (roster.length) {
          castPath = path.join(work, "cast_registry.json");
          fs.writeFileSync(castPath, JSON.stringify(toCoreRegistry(roster)), "utf-8");
          console.log(`[worker] content.analyze ${mediaId}: cast registry ${roster.length} members`);
        }
        // 프로그램 상세 페이지에서 등록한 캐스트 인물 사진(program.castPhotos: name → data URL)을
        // work/cast_photos/{safe_name}.{ext}로 풀어 놓는다. faces.py가 이 폴더를 스캔해서
        // 인물 embedding을 뽑고 클러스터에 이름을 자동 매칭한다. 사진 없는 캐스트는 스킵.
        const castPhotos = program?.castPhotos && typeof program.castPhotos === "object"
          ? (program.castPhotos as Record<string, string>)
          : undefined;
        if (castPhotos && Object.keys(castPhotos).length > 0) {
          const photosDir = path.join(work, "cast_photos");
          fs.mkdirSync(photosDir, { recursive: true });
          let written = 0;
          for (const [name, dataUrl] of Object.entries(castPhotos)) {
            if (typeof dataUrl !== "string") continue;
            // "data:image/jpeg;base64,AAAA…" → mime + base64. mime 없으면 image/jpeg 폴백.
            const m = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl);
            if (!m) continue;
            const mime = m[1];
            const buf = Buffer.from(m[2], "base64");
            const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
            // 파일명 안전화 — 한글은 그대로 두되 슬래시·백슬래시·NUL만 제거.
            const safe = name.replace(/[/\\\0]/g, "_").trim().slice(0, 60) || `cast_${written}`;
            try {
              fs.writeFileSync(path.join(photosDir, `${safe}.${ext}`), buf);
              written++;
            } catch (e) {
              console.warn(`[worker] cast photo write skipped (${safe}):`, e);
            }
          }
          if (written > 0) {
            console.log(`[worker] content.analyze ${mediaId}: cast photos ${written} written to ${photosDir}`);
          }
        }
      }
      // 프로그램 정보(시놉시스·태그·크레딧 등) — 사용자가 상세 페이지에서 입력. 하나라도
      // 채워져 있으면 program_context.json 로 넘겨 AI 프롬프트에 반영.
      if (program) {
        const ctx: Record<string, unknown> = {};
        for (const k of [
          "title", "section", "synopsis", "broadcaster", "schedule",
          "firstAiredDate", "currentInfo", "director", "spinoff", "awards",
          // 운영자 커스텀 프롬프트 2종 — core/recommend 가 "## 프로그램별 운영자 지시" 블록으로
          // 소비한다(titlePrompt=제목 생성 · recommendPrompt=beat 조합 추천). 다른 core 소비처
          // (refine·beat_annot·thumbnail)는 전부 allowlist 렌더라 이 키가 새지 않는다.
          "titlePrompt", "recommendPrompt",
        ] as const) {
          const v = (program as Record<string, unknown>)[k];
          if (typeof v === "string" && v.trim()) ctx[k] = v.trim();
        }
        if (Array.isArray(program.moods)) {
          const moods = (program.moods as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
          if (moods.length) ctx.moods = moods;
        }
        if (typeof program.targetAge === "number") ctx.targetAge = program.targetAge;
        if (Object.keys(ctx).length > 0) {
          programContextPath = path.join(work, "program_context.json");
          fs.writeFileSync(programContextPath, JSON.stringify(ctx), "utf-8");
          console.log(`[worker] content.analyze ${mediaId}: program context (${Object.keys(ctx).join(",")})`);
        }
      }

      // 시청자 댓글 → viewer_signals 배선 (2026-07-28). 이 롱폼이 유튜브에서 온
      // 영상(from-youtube 경로)이면 episode.sourceVideoId 가 남아있고, 그 videoId 로
      // 이미 수집돼 있는 상위 좋아요 댓글을 뽑아 work/comments.json 으로 넘긴다.
      // core.analyze 가 이 파일을 감지해 build_viewer_signals 로 profile에 병합 →
      // recommend 프롬프트에 시청자 실측 반응(상위 순간·시간 언급·감정) 컨텍스트가 들어감.
      // 댓글 없음/외부 채널(연동 안 됨) 케이스는 파일 미생성 → 기존과 동일 동작.
      const sourceVideoId = typeof episode?.sourceVideoId === "string" ? episode.sourceVideoId : "";
      if (sourceVideoId) {
        try {
          const comments = await listVideoComments(sourceVideoId, 100);
          if (comments.length > 0) {
            const commentsPath = path.join(work, "comments.json");
            const slim = comments.map((c) => ({
              text: c.text,
              likeCount: Number(c.likeCount) || 0,
              publishedAt: c.publishedAt,
            }));
            fs.writeFileSync(commentsPath, JSON.stringify(slim), "utf-8");
            console.log(`[worker] content.analyze ${mediaId}: viewer comments ${comments.length} → comments.json (videoId=${sourceVideoId})`);
          }
        } catch (e) {
          console.warn(`[worker] content.analyze ${mediaId}: viewer comments load skipped:`, e);
        }
      }
    } catch (e) {
      console.error("[worker] program context resolve failed (proceeding without):", e);
    }

    // 2026-07-23: runAnalyze reject 되어도 analysis.json 있으면 결과 사용 (native cleanup crash 등).
    // 워커 안정성 개선의 두 번째 축 — 파일 있으면 DB write 반드시 진행, 없으면 진짜 실패.
    //
    // ⚠️ 단, **이번 실행이 만든 파일일 때만**이다(2026-08-12 보강).
    // 작업 디렉토리는 미디어별로 고정이고 실패 시 일부러 보존한다. 그래서 재시도에서
    // 파이썬이 즉시 죽으면(venv 소실·CUDA·import OOM) 지난 회차의 analysis.json 이 그대로
    // 남아 있어, 크래시가 경고로 강등되고 **옛 분석이 새 분석으로 저장되며 크레딧까지 차감**됐다.
    // 시작 시각보다 새로운 파일만 "이번 산출물" 로 인정한다.
    const runStartedAt = Date.now();
    try {
      await runAnalyze(videoPath, work, onProgress, profilePath, castPath, fast, programContextPath, pipelineGenre, mediaId);
    } catch (e) {
      const analysisPath = path.join(work, "analysis.json");
      if (!fs.existsSync(analysisPath)) throw e;
      const producedAt = fs.statSync(analysisPath).mtimeMs;
      if (producedAt < runStartedAt) {
        console.error(`[worker] content.analyze ${mediaId}: analysis.json 이 지난 회차 것이다 ` +
          `(mtime ${new Date(producedAt).toISOString()} < 시작 ${new Date(runStartedAt).toISOString()}) — 실패로 처리`);
        throw e;
      }
      console.warn(`[worker] content.analyze ${mediaId}: runAnalyze 실패 (${(e as Error).message}) — 이번 회차 analysis.json 있어 진행`);
    }
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

    // 검색 세그먼트를 pgvector(search_segments)에 적재 — core.analyze가 workdir에 남긴
    // segments.json(=beat 재조립 + 임베딩)을 읽어 upsert. 검색은 이걸로 굴러간다.
    // 추가 연산 0(인덱싱은 analyze 안에서 이미 끝남) · 실패해도 분석 성립(non-fatal).
    // 적재 직전 서버 쪽 실메타데이터를 주입한다: program_id·회차·방영일(episode 엔티티 조인)
    // + rights.ppl(파이프라인 PPL 검출과 구간 오버랩). 이게 있어야 "그 프로 작년 편" 필터가
    // 실제로 동작한다(설계 §4 — 방송사 쿼리는 semantic보다 필터).
    try {
      const segPath = path.join(work, "segments.json");
      if (fs.existsSync(segPath)) {
        const segDoc = JSON.parse(fs.readFileSync(segPath, "utf-8")) as { segments?: SearchSegmentRow[] };
        const segs = Array.isArray(segDoc?.segments) ? segDoc.segments : [];
        if (segs.length) {
          // episode → program_id·회차·방영일
          const ep = media.episodeId ? await getEntity<{ programId?: string; episodeNumber?: number; broadDate?: string }>("episode", media.episodeId) : undefined;
          // PPL 구간 (분석 산출)
          const pplIntervals: Array<{ start: number; end: number }> = Array.isArray(analysis?.ppl?.detections)
            ? analysis.ppl.detections
                .filter((d: { start?: number; end?: number }) => typeof d.start === "number" && typeof d.end === "number")
                .map((d: { start: number; end: number }) => ({ start: d.start, end: d.end }))
            : [];
          const overlapsPpl = (s: number, e: number) => pplIntervals.some((iv) => Math.min(e, iv.end) - Math.max(s, iv.start) > 0);

          for (const seg of segs) {
            (seg as { program_id?: string | null }).program_id = ep?.programId ?? null;
            seg.scope = {
              ...(seg.scope ?? {}),
              episode: ep?.episodeNumber != null ? String(ep.episodeNumber) : (seg.scope?.episode ?? null),
              aired_at: ep?.broadDate ?? seg.scope?.aired_at ?? null,
            };
            // ⚠️ 여기서 seg.rights.ppl 을 자동으로 써 넣던 코드를 뺐다 (FLOWS F3 — 자동 판정 없음).
            // 파이프라인이 찾은 PPL 구간은 **검색 힌트**일 뿐 권리 판정이 아니다. 이걸 권리
            // 필드에 쓰면 "시스템이 등록한 이슈"가 생기고, 사람이 등록하지 않은 것이 게이트를
            // 움직이게 된다. 권리 이슈는 rights_issue 테이블에만, 사람이 등록할 때만 생긴다.
            // 검출 결과는 아래 ppl_hint 로 남겨 검수 화면이 "여기 볼 만함"을 안내하는 데만 쓴다.
            if (overlapsPpl(seg.start, seg.end)) {
              seg.rights = { ...(seg.rights ?? {}), ppl_hint: true };
            }
          }
          const n = await upsertSearchSegments(mediaId, segs);
          const pplN = segs.filter((s) => (s.rights as { ppl_hint?: boolean })?.ppl_hint).length;
          console.log(`[worker] content.analyze ${mediaId}: 검색 세그먼트 ${n}개 적재 (program=${ep?.programId ?? "-"} ep=${ep?.episodeNumber ?? "-"} ppl구간=${pplN})`);
        }
      }
    } catch (e) {
      console.warn(`[worker] content.analyze ${mediaId}: 검색 세그먼트 적재 실패 (non-fatal):`, e);
    }

    // 프로그램 상세로 역방향 동기화: 확정 이름 → program.cast · 대표 프레임 → program.castPhotos.
    // 사용자가 처음 만든 프로그램이라도 첫 분석 후 자동으로 출연자·사진이 채워짐. 다음 분석엔
    // 이 사진이 다시 embedding matching primary source로 넘어가 정확도 계속 향상.
    try {
      const epForSync = media.episodeId ? await getEntity<any>("episode", media.episodeId) : undefined;
      if (epForSync?.programId) {
        const synced = await syncProgramFromFaces(epForSync.programId, work);
        if (synced.addedNames.length || synced.addedPhotos.length) {
          console.log(
            `[worker] content.analyze ${mediaId}: program 동기화 · 이름 +${synced.addedNames.length}` +
            ` (${synced.addedNames.slice(0, 5).join(",")}) · 사진 +${synced.addedPhotos.length}` +
            ` (${synced.addedPhotos.slice(0, 5).join(",")})`,
          );
        }
      }
    } catch (e) {
      console.warn(`[worker] content.analyze ${mediaId}: program sync 실패 (non-fatal):`, e);
    }

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

        // Thumbnail generation은 auto 하지 않는다 (2026-08-06). 회당 ₩500 낭비.
        // 편집자가 필요 시점에 별도 트리거로 생성 (POST /api/clips/:id/thumbnail 등).
        // 채택 안 된 shorts 는 어차피 썸네일 자원 낭비 · on-demand 가 정답.
        // env AUTO_THUMBNAIL=1 로 강제 활성화 가능 (프로파일링 시).
        if (process.env.AUTO_THUMBNAIL === "1" && media.episodeId && shorts.length) {
          try {
            await runThumbnailGeneration(mediaId, media.episodeId, shorts, work);
          } catch (e) {
            console.error(`[worker] content.analyze ${mediaId}: thumbnail generation failed`, e);
          }
        }

        if (media.episodeId) {
      await setEpisodePipeline(media.episodeId, {
        stage: "recommend",
        stageStatus: "done",
        note: wrote ? `AI 쇼츠 추천 ${wrote}건` : "분석 완료 · 추천 없음",
        progress: 100,
      }).catch((e) => console.error("[worker] failed to update episode pipeline", e));
    }

    // 사용량 기록 — 결제가 꺼져 있어도 남긴다. **원가 가시화는 결제와 독립적인 가치**다
    // (billing-portone-plan.md 3단계). dedupeKey 로 멱등이라 워커가 재시도해도 한 번만 쌓인다.
    // 실패해도 분석을 되돌리지 않는다 — 이미 원가는 썼고, 기록 실패로 결과를 버리는 게 더 나쁘다.
    try {
      const minutes = billableMinutes(media.durationSec ?? 0);
      if (minutes > 0) {
        await recordUsage({
          kind: "analyze_minutes",
          quantity: minutes,
          mediaId,
          costKrw: estimatedCostKrw(minutes),
          source: "web",
          dedupeKey: usageDedupeKey("analyze_minutes", mediaId),
        });

        // **크레딧 차감.** 이게 빠지면 잔액이 올라가기만 하고 절대 안 내려가 의미가 없어진다.
        // 원장(credit_ledger)이 과금의 진실이고 usage_events 는 운영 상세다 — 둘 다 남긴다.
        // 잔액이 모자라도 여기서는 그냥 마이너스로 간다: 이미 분석이 끝났고 원가는 나갔다.
        // 시작을 막는 건 큐잉 시점의 402 게이트가 할 일이다(결제 검증 후 배선).
        await addCreditEntry({
          delta: -minutes,
          reason: "usage",
          mediaId,
          note: `분석 ${minutes}분`,
          actor: "system",
          dedupeKey: creditUsageKey(mediaId),
        });

        // 잔액 사전 경고 — 500분 선을 **이번 차감으로 하향 통과했을 때 한 번**만 담당자
        // 메일(billing.notifyEmails). 매 차감마다 보내면 알림이 배경음이 된다.
        try {
          const after = await creditBalance();
          const { LOW_BALANCE_WARN_CREDITS, notifyLowBalance } = await import("./billing/billing-notify.ts");
          if (after < LOW_BALANCE_WARN_CREDITS && after + minutes >= LOW_BALANCE_WARN_CREDITS) {
            void notifyLowBalance(after);
          }
        } catch (e) {
          console.warn("[billing-notify] 잔액 경고 판정 실패(무시):", e instanceof Error ? e.message : e);
        }

        // 차감으로 잔액이 임계 아래로 떨어졌으면 저장 카드로 자동 충전(정책 켜진 경우만).
        // **best-effort** — 자동 충전 실패가 분석을 깨면 안 되므로 던지지 않고 로그만 남긴다.
        // 사용자에게 보이는 알림은 maybeAutoTopup 안에서 저장된다(호출부별 배선 금지).
        try {
          const r = await maybeAutoTopup();
          if (r.charged) console.log(`[auto-topup] ${mediaId}: +${r.credits} 크레딧 자동 충전`);
          // ⚠️ 사유 **문구**로 거르지 않는다. 예전엔 여기 정규식이 판정이라, 문구를 고치면
          // 판정이 깨지고 "미정산 정산했습니다" 같은 정상 결과도 매번 경고로 나갔다.
          // 판정의 정본은 credits.ts 의 심각도 표 하나뿐이다(화면 알림도 같은 걸 본다).
          else if (autoTopupNeedsAttention(r.code)) {
            console.warn(`[auto-topup] ${mediaId}: 자동 충전 안 됨 — ${r.reason}`);
          }
        } catch (e) {
          console.error("[auto-topup] 예외(무시):", e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error(`[worker] content.analyze ${mediaId}: 사용량 기록 실패(분석은 정상)`, e);
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
    // ⚠️ **완성본을 partial 로 덮지 않는다.** 재분석(이미 한 번 성공한 회차를 다시 돌리는 것)이
    // 실패하면 partial 에는 shorts·narrative 가 없어서, 그대로 저장하면 화면에서 추천과
    // 서사가 통째로 사라진다 — 재시도했을 뿐인데 기존 결과물이 눈앞에서 없어지는 셈이다.
    // 기존 블롭 위에 얹어, 이번에 건진 것만 갱신한다.
    const prevData = partial
      ? ((await getContentAnalysis(mediaId).catch(() => undefined))?.data as Record<string, unknown> | undefined)
      : undefined;
    await saveContentAnalysis(mediaId, {
      error: String(err?.message ?? err).slice(0, 1000),
      ...(partial
        ? {
            data: {
              ...(prevData ?? {}),
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
      // Drain any in-flight throttled progress write first, or it lands AFTER this and
      // the UI shows "AI 분석 중… 40%" instead of the error state until the next retry.
      await chain.catch(() => {});
      // 자동 재시도가 남았는지에 따라 문구를 가른다 — 소진됐는데 "재시도 대기" 라고 하면
      // 운영자는 오지 않을 재시도를 기다리며 정작 필요한 조치(분석 다시 시작)를 안 한다.
      const exhausted = attempt ? attempt.n >= attempt.max : false;
      await setEpisodePipeline(media.episodeId, {
        stage: "analyze",
        stageStatus: "error",
        blockedReason: exhausted
          ? "AI 분석 실패 — 자동 재시도가 끝났습니다. 분석을 다시 시작해 주세요 (완료된 단계는 보존됨)"
          : "AI 분석 실패 — 재시도 대기 (완료된 단계는 보존됨)",
      }).catch(() => {});
    }
    // Keep the work dir: the queue retry resumes from its checkpoints. The 48h sweep
    // cleans it up if the job never comes back.
    console.log(`[worker] content.analyze ${mediaId}: work dir kept for resume (${work})`);
    throw err;
  }
}

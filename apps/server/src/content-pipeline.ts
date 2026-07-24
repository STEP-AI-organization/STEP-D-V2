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
  getChannelPointProfile,
  getPool, getEntity, putEntity,
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
const CHECKPOINT_FILES = ["analysis.json", "scenes.json", "cast.json", "timeline.json", "narrative.json", "shorts.json", "refined.json", "faces.json", "ppl.json", "stt.json", "manifest.json"];

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
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-u", "-m", "core.analyze", videoPath, "--out", outDir];
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
          STT_PROVIDER: process.env.STT_PROVIDER || "hybrid",
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
    if (proc.stdin && typeof proc.stdin.unref === "function") proc.stdin.unref();
    if (proc.stdout && typeof proc.stdout.unref === "function") proc.stdout.unref();
    if (proc.stderr && typeof proc.stderr.unref === "function") proc.stderr.unref();
    // stderr는 로그로만 사용 (워커 프로세스에 영향 없게)
    if (proc.stderr) {
      const errRl = readline.createInterface({ input: proc.stderr });
      errRl.on("line", (line) => console.error(`[core:err] ${line}`));
    }

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
      if (stallTimer) clearTimeout(stallTimer);
      activeChild = null;
      if (earlyResolved) return;  // @@COMPLETE로 이미 resolve됨 · 뒤늦은 exit code 무시
      if (stalled) {
        reject(new Error(`core.analyze stalled (${STALL_TIMEOUT_MS / 60000}min without output) — killed`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      // Fallback: @@COMPLETE 없이 종료 (구 코드 or 예외) — analysis.json 있으면 사용
      const analysisPath = path.join(outDir, "analysis.json");
      if (fs.existsSync(analysisPath)) {
        console.warn(`[worker] core.analyze exited ${code} · @@COMPLETE 없음 · analysis.json 존재하므로 결과 사용`);
        resolve();
        return;
      }
      reject(new Error(`core.analyze exited ${code}`));
    });
    proc.on("error", (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      activeChild = null;
      reject(err);
    });
  });
}

// One AI-recommended short from core/recommend.py.
type Short = {
  rank?: number; appeal?: number; start?: number; end?: number;
  title?: string; reason?: string; tags?: string[];
  /** 3축 직교 스코어(각 0-10, 2026-07-23~). hook_strength·payoff·completeness — appeal은 이 셋에서 산출. */
  hook_strength?: number; payoff?: number; completeness?: number;
  /** 3축 가중합 0-100 (hook 0.40·payoff 0.35·completeness 0.25). 프론트 메인 스코어. */
  score100?: number;
  /** 처음 제목 생성 단계(_retitle_final_windows)에서 뽑힌 대체 제목 후보들.
   *  기본 title을 포함할 수도 있고 아닐 수도 있음 — 프론트는 dedupe 처리. */
  title_candidates?: string[];
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
  const titleMain = s.title || "쇼츠 추천";
  const titleCandidates = Array.isArray(s.title_candidates)
    ? Array.from(new Set([titleMain, ...s.title_candidates.filter((t) => typeof t === "string" && t.trim())]))
    : undefined;
  return {
    id,
    episodeId,
    kind: "short",
    title: titleMain,
    titleCandidates,
    appeal: Math.max(1, Math.min(5, appeal)),
    // 신규 스코어(있으면 그대로 전달). 프론트 카드가 score100 우선 표시.
    score100: typeof s.score100 === "number" ? s.score100 : undefined,
    hookStrength: typeof s.hook_strength === "number" ? s.hook_strength : undefined,
    payoff: typeof s.payoff === "number" ? s.payoff : undefined,
    completeness: typeof s.completeness === "number" ? s.completeness : undefined,
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

/** Run the content pipeline for one uploaded media and persist the result.
 *  `fast`(잡 페이로드 fast:true) — 자막만으로 빠른 추천, 시각 분석 스킵(~10배). 기본 false=풀. */
export async function runContentAnalyze(mediaId: string, fast = false): Promise<void> {
  // 잡 페이로드 fast:true 또는 워커 전역 CORE_ANALYZE_FAST=1 이면 빠른 모드. 대량 배치용 전역 스위치.
  fast = fast || process.env.CORE_ANALYZE_FAST === "1";
  const media = await getMedia(mediaId);
  if (!media) throw new Error(`content.analyze: media ${mediaId} not found`);

  sweepStaleWorkDirs();
  const work = workDirFor(mediaId);
  fs.mkdirSync(work, { recursive: true });
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
    } catch (e) {
      console.error("[worker] program context resolve failed (proceeding without):", e);
    }

    // 2026-07-23: runAnalyze reject 되어도 analysis.json 있으면 결과 사용 (native cleanup crash 등).
    // 워커 안정성 개선의 두 번째 축 — 파일 있으면 DB write 반드시 진행, 없으면 진짜 실패.
    try {
      await runAnalyze(videoPath, work, onProgress, profilePath, castPath, fast, programContextPath, pipelineGenre);
    } catch (e) {
      const analysisPath = path.join(work, "analysis.json");
      if (!fs.existsSync(analysisPath)) throw e;
      console.warn(`[worker] content.analyze ${mediaId}: runAnalyze 실패 (${(e as Error).message}) — analysis.json 있어 진행`);
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
      // Drain any in-flight throttled progress write first, or it lands AFTER this and
      // the UI shows "AI 분석 중… 40%" instead of the error state until the next retry.
      await chain.catch(() => {});
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

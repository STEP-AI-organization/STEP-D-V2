/**
 * Backend client (real-video mode). Talks to @stepd/server. When the server is
 * unreachable the store falls back to the in-memory mock, so the app still runs
 * standalone — this module is only used once a live server is detected.
 */
import type { DistributionChannel } from "@/lib/constants";
import type { Program, RenderChannel } from "@/lib/types";
import type { EditorState } from "@/lib/editor/presets";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "/api";

/** Absolute URL for a server-relative media path (stream/thumb). */
export function mediaUrl(relative: string | null | undefined): string | undefined {
  if (!relative) return undefined;
  return relative.startsWith("http") ? relative : `${API_BASE}${relative}`;
}

export interface ServerState {
  programs: unknown[];
  episodes: unknown[];
  recommendations: unknown[];
  clips: unknown[];
  jobs: unknown[];
  connections: { youtube: boolean; instagram: boolean; facebook: boolean; tiktok: boolean };
  media: unknown[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Probe + load full state. Rejects (fast) if the server isn't up. */
export async function fetchState(signal?: AbortSignal): Promise<ServerState> {
  const res = await fetch(`${API_BASE}/state`, { signal, cache: "no-store" });
  return json<ServerState>(res);
}

export interface AnalysisScene {
  index?: number;
  start: number;
  end?: number;
  duration?: number;
  text?: string;
  vision_reason?: string;
  vision_score?: number;
  vision_tags?: string[];
  has_dialogue?: boolean;
  on_screen_names?: string[];
}
/** One AI-recommended short (core.recommend output). */
export interface AnalysisShort {
  rank?: number;
  title?: string;
  start: number;
  end: number;
  reason?: string;
  tags?: string[];
  /** ⚠️ LLM 3축 (2026-07-23~08-06). 이후 회차는 **없다** — LLM 점수는 실행마다 달라져 제거. */
  hook_strength?: number;
  payoff?: number;
  completeness?: number;
  /** 0-100 메인 스코어. 2026-08-06~ 결정론 계산(signal·hook·length·closure). */
  score100?: number;
  /** score100 근거 (2026-08-06~). 3축을 대체한다. */
  score_parts?: Record<string, number | boolean>;
  /** 1~5 legacy compressed appeal. UI 호환용 — 신규 카드는 score100/3축을 우선 표시. */
  appeal?: number;
  /** 훅 카테고리 — "웃음"·"반전"·"감정고조"·"돌직구"·"질문"·"정보성"·"갈등"·"공감"·"기타". */
  hook?: string;
  /** 쇼츠 첫 3초 hook intro (2026-07-31 · docs/plans/shorts-hook-intro-3sec.md) — 이탈 방지.
   *  core/recommend.py propose_shorts_beat_only 가 채운다. 카드가 미리보기로 표시. */
  hook_quote?: string;        // 실 대사 원문 인용 (STT 그대로 · 30자 이내)
  hook_time_sec?: number | null; // hook 대사 시각 (쇼츠 시작 상대 · 초)
  hook_intro_caption?: string; // 어그로 편집자막 (20자 · "충격 고백!" 톤)
  /** 방송 실무 3-type (2026-07-23~): shortform(40~60s SNS) / clip(1~5분 SMR·재편집) / highlight(5~10분 회차 요약). */
  type?: "shortform" | "clip" | "highlight";
  /** highlight 전용 — 여러 시나리오를 시간순으로 이어붙인 편집 세그먼트 리스트. */
  segments?: { scenario_id?: number | null; start: number; end: number; title?: string }[];
  total_length_sec?: number;
}
/** One refined transcript segment (STT → refine). */
export interface AnalysisTranscriptSegment {
  start: number;
  end?: number;
  text?: string;
  appealScore?: number;
  /** STT 화자분리의 익명 라벨(발화자 1, 발화자 2 …). 운영자가 프론트에서 이름을 지정할 수 있다. */
  speaker?: string;
}
export interface NarrativeSegment {
  block_index: number;
  title: string;
  summary: string;
  key_moments: string[];
  characters: string[];
  start: number;
  end: number;
  /** Pass3 확장(2026-07-22, AENA 레퍼런스): 장소·브랜드·정서 톤. */
  locations?: string[];
  brands?: string[];
  emotional_tone?: string;
}
export interface NarrativeCharacter {
  name: string;
  role: string;
  total_screen_sec: number;
  key_relationships: string[];
  personality_traits: string[];
}
export interface NarrativeConflict {
  title: string;
  description: string;
  participants: string[];
  time_range: { start: number; end: number };
  resolution: string;
}
export interface NarrativeData {
  full_summary?: string;
  segments?: NarrativeSegment[];
  characters?: NarrativeCharacter[];
  key_conflicts?: NarrativeConflict[];
}
/** 하나의 PPL/브랜드 노출 구간 (core/ppl.py 산출). 인접 프레임은 병합된 상태. */
export interface PplDetection {
  brand: string;
  category?: string;
  position?: string;
  start: number;
  end: number;
  confidence: number;
  notes?: string;
  /** analysis/{mediaId}/ppl_frames/{name}.jpg — 대표 프레임 (peak confidence). */
  frame_ref?: string;
  /** 병합된 구간이 몇 개 샘플 프레임에 걸쳤는지. */
  frames_hit?: number;
}
export interface PplData {
  detections?: PplDetection[];
  /** 브랜드별 총 노출초 합계. */
  brand_summary?: Record<string, number>;
  total_frames_scanned?: number;
  total_detections?: number;
  detect_sec?: number;
  sample_sec?: number;
  error?: string;
  note?: string;
}

export interface MediaAnalysis {
  status: "pending" | "done" | "failed" | null;
  data?: {
    transcript?: AnalysisTranscriptSegment[];
    scenes?: AnalysisScene[];
    shorts?: AnalysisShort[];
    narrative?: NarrativeData | null;
    ppl?: PplData | null;
  } | null;
  error?: string | null;
}

/** PPL 결과 별도 폴링 — 분석 진행 중에도 도착하는 대로 UI에 반영 (faces와 동일 패턴). */
export async function getMediaPpl(mediaId: string): Promise<PplData> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/ppl`, { cache: "no-store" });
  if (!res.ok) throw new Error(`ppl fetch failed (${res.status})`);
  return res.json();
}
export function pplFrameUrl(apiBase: string, mediaId: string, framePath: string): string {
  // framePath = "ppl_frames/CJ_00012.jpg" — 파일명만 뽑아 라우트에 붙임.
  const name = framePath.split("/").pop() ?? framePath;
  return `${apiBase}/media/${mediaId}/analysis/ppl_frames/${name}`;
}

/** Content-pipeline result for one uploaded media (STT → scenes → shorts). */
export async function getMediaAnalysis(mediaId: string): Promise<MediaAnalysis> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/analysis`, { cache: "no-store" });
  if (!res.ok) throw new Error(`analysis fetch failed (${res.status})`);
  return res.json();
}

/** 얼굴 클러스터 메타(faces.py 출력). representative_frames는 서버-상대 경로("face_clusters/M1_0.jpg").
 *  UI는 이걸 `${API_BASE}/media/{id}/analysis/{path}` 로 붙여서 <img src>. */
export interface MediaFaceCluster {
  cluster_id: number;
  count: number;
  gender_hint: "M" | "F";
  representative_frames: string[];
}
export interface MediaFaces {
  clusters: Record<string, MediaFaceCluster>; // key: "M1", "F1", ...
  mapping: Record<string, string>;             // 사용자 매핑 결과: {"M1": "정숙", ...}
  labeled_segments?: number;
  total_frames_scanned?: number;
  total_faces_detected?: number;
  detect_sec?: number;
  note?: string;
}
export async function getMediaFaces(mediaId: string): Promise<MediaFaces> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/faces`, { cache: "no-store" });
  if (!res.ok) throw new Error(`faces fetch failed (${res.status})`);
  return res.json();
}
export function faceCropUrl(apiBase: string, mediaId: string, framePath: string): string {
  // framePath는 "face_clusters/M1_0.jpg" — 파일명만 뽑아 새 라우트에 붙임.
  const name = framePath.split("/").pop() ?? framePath;
  return `${apiBase}/media/${mediaId}/analysis/faces/${name}`;
}

/** 원본 영상의 특정 순간(t초) 정지 프레임 URL. 서버에서 캡처·캐시.
 *  쇼츠 카드·씬 카드·클립 카드가 시각 미리보기로 사용. */
export function frameUrl(apiBase: string, mediaId: string, t: number): string {
  return `${apiBase}/media/${mediaId}/frame?t=${Math.max(0, t).toFixed(2)}`;
}

/** 인물 매핑 저장 — {M1:"정숙", F2:"영자"}을 서버 faces.json에 병합 + refined.json speaker rename.
 *  빈 문자열 value("")는 해당 라벨 매핑 제거 (원 라벨 복원). */
export async function patchMediaFacesMapping(
  mediaId: string,
  mapping: Record<string, string>,
): Promise<{ ok: boolean; mapping: Record<string, string>; refined_rewritten: number }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/faces/mapping`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapping }),
  });
  if (!res.ok) throw new Error(`mapping save failed (${res.status})`);
  return res.json();
}

export interface EpisodeCastPerson {
  name: string;
  castId: string | null;
  role?: string;
  status?: string;
  matchType?: string;
  confidence?: number;
  sceneCount?: number;
  totalSec?: number;
  evidence?: string[];
  appearances?: Array<{ start: number; end: number; scenes: number[]; source: string }>;
}

export interface EpisodeCastResponse {
  mediaId: string;
  people: EpisodeCastPerson[];
  matchedCount: number;
  candidateCount: number;
}

export async function fetchEpisodeCast(mediaId: string): Promise<EpisodeCastResponse> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/cast`, { cache: "no-store" });
  if (!res.ok) throw new Error(`cast fetch failed (${res.status})`);
  return res.json();
}

/** Re-run the AI content pipeline for a media (operator recovery from a failed analysis).
 *  cast/profile 등이 바뀌면 fingerprint에서 걸러 필요한 스테이지만 재실행됨. fast=true면 정밀 스테이지 스킵. */
export async function reanalyzeMedia(mediaId: string, fast = false): Promise<{ ok: boolean; queued: boolean }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(fast ? { fast: true } : {}) }),
  });
  if (!res.ok) throw new Error(`재분석 요청 실패 (${res.status})`);
  return res.json();
}

/**
 * A playable video URL for a media id. In production this is a short-lived signed GCS URL
 * the <video> element streams directly from Cloud Storage (no proxy/redirect in the byte
 * path). In local dev it falls back to the server's chunked stream endpoint.
 */
export async function getStreamUrl(mediaId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/stream-url`, { cache: "no-store" });
  const data = await json<{ url: string; direct: boolean }>(res);
  return data.direct ? data.url : `${API_BASE}${data.url}`;
}

export interface CreateProgramInput {
  title: string;
  section?: string;
  targetAge?: number;
  cast?: string[];
  /** 파이프라인 분기 축(variety|drama). 미설정이면 워커가 auto 판정. */
  pipelineGenre?: "variety" | "drama";
  /** SMR feed metadata (program-level). */
  programCode?: string;
  category?: string;
  weekdays?: number[];
  // ── TV/OTT 프로그램 정보 (선택 필드) ────────────────────────────
  synopsis?: string;
  broadcaster?: string;
  schedule?: string;
  firstAiredDate?: string;
  currentInfo?: string;
  director?: string;
  spinoff?: string;
  awards?: string;
  moods?: string[];
  posterImageDataUrl?: string;
  castPhotos?: Record<string, string>;
}

/** Create a program (content root). Required before any episode/upload can exist. */
export async function createProgram(input: CreateProgramInput): Promise<{ program: Program }> {
  return json(
    await fetch(`${API_BASE}/programs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** Update a program in place. 서버 PATCH는 지정한 필드만 병합 — 여기 안 넣은 필드는 유지됨.
 *  cast는 전체 재정의(빈 배열로 덮어쓰면 캐스트 없음). 재분석 시 refine 지문에 cast_registry가
 *  들어가 있어, cast 바뀌면 다음 content.analyze에서 refined.json이 자동 재생성됨. */
export type UpdateProgramInput = Partial<CreateProgramInput>;
export async function updateProgram(id: string, patch: UpdateProgramInput): Promise<{ program: Program }> {
  return json(
    await fetch(`${API_BASE}/programs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export interface AutofillQuestion {
  field: string;
  question: string;
  suggestions: string[];
  allowOther: boolean;
}

export interface AutofillProgramResult {
  /** 팩트체크 통과 필드 — 사용자 확인 없이 채워도 안전. */
  draft: Partial<Record<
    "section" | "synopsis" | "broadcaster" | "schedule" | "firstAiredDate"
    | "currentInfo" | "director" | "spinoff" | "awards" | "moods",
    string | string[]
  >>;
  sources: { url: string; title: string }[];
  evidence: Record<string, string>;
  /** 팩트체크 못한 필드 — 사용자에게 물어봐서 확정 필요. */
  dropped: string[];
  /** 사용자에게 한 번에 던질 질문 (각 필드에 대해 suggestions + allowOther=기타 입력). */
  questions: AutofillQuestion[];
}

/** 프로그램 제목 기반 자동 채움 (Gemini + google_search grounding · 팩트체크 · 후속 질문 생성).
 *  결과는 서버 저장 없음 · 프론트가 questions 답 받아 병합 후 updateProgram으로 저장. */
export async function autofillProgram(id: string): Promise<AutofillProgramResult> {
  const res = await fetch(`${API_BASE}/programs/${id}/autofill`, { method: "POST" });
  return json<AutofillProgramResult>(res);
}

/** 얼굴 분석 → program 수동 sync (파이프라인 native crash 우회).
 *  최근 분석된 media에서 faces.json → cast·castPhotos 채움. mediaId 생략 시 자동 선택. */
export async function syncProgramFromAnalysis(id: string, mediaId?: string): Promise<{
  mediaId: string;
  workDirExists: boolean;
  addedNames: string[];
  addedPhotos: string[];
}> {
  const res = await fetch(`${API_BASE}/programs/${id}/sync-from-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mediaId ? { mediaId } : {}),
  });
  return json(res);
}

/** Persist the editor's decision blob on a clip (metadata only — no render, plan §2.4). */
export async function saveClipEditor(clipId: string, editorState: EditorState): Promise<void> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/editor`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editorState }),
  });
  await json<{ ok: boolean }>(res);
}

/** 에디터 '제목 후보' 탭의 '새로 생성' 배선 — 사용자 추가 지시(prompt)를 얹어 5개 재생성.
 *  결과는 세션 로컬(에디터에서만 보임) — 서버 저장 없음. 클릭 시 클립 제목만 갈아끼운다. */
export async function regenerateTitles(clipId: string, prompt: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/regenerate-titles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const data = await json<{ titles: string[] }>(res);
  return Array.isArray(data.titles) ? data.titles : [];
}

/** 메타데이터 버튼 '생성' 배선 — 자막 근거로 YouTube 업로드용 title/description/tags 자동 생성.
 *  서버 저장 X. 결과를 state.uploadMeta에 얹으면 됨. */
export async function generateUploadMetadata(
  clipId: string,
): Promise<{ title: string; description: string; tags: string[] }> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/generate-metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await json<{ title: string; description: string; tags: string[] }>(res);
  return {
    title: data.title ?? "",
    description: data.description ?? "",
    tags: Array.isArray(data.tags) ? data.tags : [],
  };
}

type UploadResult = { episode: { id: string }; media: unknown; recommendations: unknown[] };

// GCS resumable chunk size. MUST be a multiple of 256 KiB (GCS requirement); 16 MiB = 64×256 KiB.
const RESUMABLE_CHUNK = 16 * 1024 * 1024;
const CHUNK_RETRIES = 4;

/**
 * Upload a (possibly multi-hour, multi-GB) master video.
 *
 * The server first hands us a direct-to-GCS resumable session — the bytes stream
 * straight to Cloud Storage in chunks, bypassing Cloud Run entirely (no 32 MB request
 * cap, no server-side buffering, no request timeout, and a dropped chunk retries instead
 * of restarting the whole upload). We then call /finalize to build the episode + recs.
 *
 * On local dev (no GCS) the server replies mode:"multipart" and we fall back to the
 * old single-request upload, which is fine for the small files used there.
 */
export async function uploadVideo(
  file: File,
  programId: string,
  title?: string,
  onProgress?: (pct: number) => void,
  /** true = 빠른 분석(자막만, 시각 분석 스킵). 기본 false=정밀. content.analyze 잡 페이로드로 전달. */
  fast?: boolean,
): Promise<UploadResult> {
  const init = await json<
    | { mode: "resumable"; mediaId: string; objectPath: string; sessionUrl: string }
    | { mode: "multipart"; mediaId: string; objectPath: string }
  >(
    await fetch(`${API_BASE}/media/upload-init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "video/mp4",
        programId,
        title,
      }),
    }),
  );

  if (init.mode === "multipart") return uploadVideoMultipart(file, programId, title, onProgress, fast);

  await uploadResumable(init.sessionUrl, file, onProgress);

  return json<UploadResult>(
    await fetch(`${API_BASE}/media/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: init.mediaId,
        objectPath: init.objectPath,
        programId,
        title,
        filename: file.name,
        contentType: file.type || "video/mp4",
        size: file.size,
        ...(fast ? { fast: true } : {}),
      }),
    }),
  );
}

/**
 * Import a YouTube video by URL. The server only creates the episode + a placeholder
 * media row and queues the download on the worker VM (yt-dlp → GCS → content.analyze),
 * so this resolves immediately — progress then shows on the episode's pipeline status.
 */
export async function importYoutubeVideo(
  url: string,
  programId: string,
  title?: string,
  fast?: boolean,
): Promise<{ episodeId: string; mediaId: string }> {
  const res = await json<{ episode: { id: string }; media: { id: string } }>(
    await fetch(`${API_BASE}/media/from-youtube`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, programId, title, ...(fast ? { fast: true } : {}) }),
    }),
  );
  return { episodeId: res.episode.id, mediaId: res.media.id };
}

/** PUT the file to a GCS resumable session URI in chunks, resuming on transient failures. */
async function uploadResumable(
  sessionUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const total = file.size;
  let offset = 0;

  while (offset < total) {
    let end = Math.min(offset + RESUMABLE_CHUNK, total);

    let res: ChunkResponse | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      // Re-slice from the CURRENT offset each attempt — after a committed-offset resync a
      // stale slice's Content-Range would mismatch and GCS 400s the whole upload.
      end = Math.min(offset + RESUMABLE_CHUNK, total);
      const chunk = file.slice(offset, end);
      try {
        res = await putChunk(sessionUrl, chunk, offset, end - 1, total, (loaded) => {
          if (onProgress) onProgress(Math.min(99, Math.round(((offset + loaded) / total) * 100)));
        });
        break;
      } catch (err) {
        // Network drop mid-chunk — re-sync the committed offset from GCS, then retry.
        lastErr = err;
        const committed = await queryCommittedOffset(sessionUrl, total).catch(() => null);
        if (committed !== null && committed > offset) {
          offset = committed;
          if (offset >= total) return;
        }
      }
    }
    if (!res) throw new Error(`upload chunk failed after retries: ${lastErr ?? "unknown error"}`);

    if (res.status === 200 || res.status === 201) {
      offset = total;
    } else if (res.status === 308) {
      // Chunk accepted, more to come. Trust the Range header if CORS exposes it; else advance.
      const next = parseRangeEnd(res.range);
      offset = next !== null ? next + 1 : end;
    } else {
      throw new Error(`upload chunk rejected: ${res.status} ${res.body}`);
    }
  }
  if (onProgress) onProgress(100);
}

type ChunkResponse = { status: number; range: string | null; body: string };

function putChunk(
  sessionUrl: string,
  chunk: Blob,
  start: number,
  endInclusive: number,
  total: number,
  onProgress?: (loaded: number) => void,
): Promise<ChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${endInclusive}/${total}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () =>
      resolve({ status: xhr.status, range: xhr.getResponseHeader("Range"), body: xhr.responseText });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(chunk);
  });
}

/** Ask GCS how many bytes it has committed (PUT with an empty body + `bytes *​/total`). */
function queryCommittedOffset(sessionUrl: string, total: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const next = parseRangeEnd(xhr.getResponseHeader("Range"));
        resolve(next !== null ? next + 1 : 0);
      } else if (xhr.status === 200 || xhr.status === 201) {
        resolve(total); // already complete
      } else {
        resolve(null);
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send();
  });
}

/** "bytes=0-16777215" → 16777215. Returns null when the header is absent (CORS not exposing it). */
function parseRangeEnd(range: string | null): number | null {
  if (!range) return null;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? parseInt(m[1], 10) : null;
}

/** Legacy single-request multipart upload — used only in local dev (no GCS). */
function uploadVideoMultipart(
  file: File,
  programId: string,
  title: string | undefined,
  onProgress?: (pct: number) => void,
  fast?: boolean,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("programId", programId);
    if (title) form.append("title", title);
    if (fast) form.append("fast", "true");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/media/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

// `clip` is absent when the rec was already adopted (server returns just the clipId).
export async function adoptRec(recId: string): Promise<{ clipId: string; clip?: unknown }> {
  return json(await fetch(`${API_BASE}/recommendations/${recId}/adopt`, { method: "POST" }));
}

/** Persist the single thumbnail variant selected for a recommendation. */
export async function selectRecommendationThumbnail(recId: string, variantId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/recommendations/${recId}/thumbnail`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variantId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

/**
 * Confirm/export a clip — the single expensive render (plan §2.4). The server bakes the
 * deliverable once and caches by revision hash, so re-exporting identical decisions is a
 * no-op. Returns the updated (rendered, status:"ready") clip.
 *
 * `channel` picks the destination render preset (F3): the frame (SMR renders 16:9, Shorts/
 * Reels 9:16) and the hard length cap. Omit it to render the clip's own aspect over the full
 * segment. `capped` comes back set when the preset's maxSec shortened the deliverable — show
 * it; the operator's segment was longer than what shipped.
 */
export async function exportClip(
  clipId: string,
  channel?: RenderChannel,
): Promise<{
  clipId: string;
  clip: unknown;
  cached?: boolean;
  preset?: string | null;
  capped?: { maxSec: number; requestedSec: number } | null;
  /** 첫 3초 hook 프리롤이 이 렌더에 적용됐는지 ("첫 3초 훅" 토글 ON + hookTimeSec 존재). */
  hookPreroll?: boolean;
}> {
  return json(
    await fetch(`${API_BASE}/clips/${clipId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel ?? "" }),
    }),
  );
}

export async function rejectRec(recId: string, reason: string): Promise<void> {
  const res = await fetch(`${API_BASE}/recommendations/${recId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

export async function publishClips(
  clipIds: string[],
  channel: DistributionChannel,
  opts: { reserveDate?: string; scheduled?: boolean },
): Promise<void> {
  const res = await fetch(`${API_BASE}/distributions/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds, channel, ...opts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

export async function retryDist(clipId: string, channel: DistributionChannel): Promise<void> {
  const res = await fetch(`${API_BASE}/distributions/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipId, channel }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

// ── YouTube channels ───────────────────────────────────────────────────────────

export interface YouTubeChannelInfo {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  thumbnail: string | null;
  subscribers: string | null;
  status: string;
  connectedAt: number;
  email: string | null;
  /** BIGINT epoch (as string) or null — set once the analyze job's steps land. */
  lastSyncedAt?: number | string | null;
  lastAnalyzedAt?: number | string | null;
  /** True if the consent granted the revenue (monetary) scope. */
  hasMonetaryScope?: boolean;
  /** Last pipeline error for this channel, if any. */
  lastError?: string | null;
}

export async function fetchYouTubeChannels(): Promise<YouTubeChannelInfo[]> {
  const res = await fetch(`${API_BASE}/youtube/channels`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { channels: YouTubeChannelInfo[] };
  return data.channels;
}

/**
 * `analytics` (default) asks an external creator for read-only access so we can
 * pull their channel metrics. `publish` asks for upload rights and is only for
 * our own channels — never send it to a partner.
 */
export type ConsentMode = "analytics" | "publish";

export function getYouTubeAuthUrl(
  channelUrl?: string,
  mode: ConsentMode = "analytics",
  returnTo?: string,
): string {
  const params = new URLSearchParams({ mode });
  if (channelUrl) params.set("channel", channelUrl);
  if (returnTo) params.set("return", returnTo);
  return `${API_BASE}/youtube/auth?${params}`;
}

export interface ChannelAnalytics {
  channelId: string;
  channelName: string;
  columns: string[];
  rows: Record<string, string | number>[];
}

export async function fetchChannelAnalytics(
  channelId: string,
  opts: { start?: string; end?: string; dimensions?: string; metrics?: string } = {},
): Promise<ChannelAnalytics> {
  const params = new URLSearchParams(
    Object.entries(opts).filter(([, v]) => v) as [string, string][],
  );
  const res = await fetch(`${API_BASE}/youtube/analytics/${channelId}?${params}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Analytics failed (${res.status})`);
  return res.json();
}

export async function deleteYouTubeChannel(channelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/youtube/channels/${channelId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

// ── Meta (Facebook + Instagram) accounts ───────────────────────────────────────

export interface MetaAccountInfo {
  publicId: string;
  pageId: string;
  pageName: string;
  pageProfilePictureUrl: string | null;
  igUserId: string | null;
  igUsername: string | null;
  igProfilePictureUrl: string | null;
  status: string;
  connectedAt: number;
}

export async function fetchMetaAccounts(): Promise<MetaAccountInfo[]> {
  const res = await fetch(`${API_BASE}/meta/accounts`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as { accounts: MetaAccountInfo[] };
  return data.accounts;
}

export function getMetaAuthUrl(returnTo?: string, rerequest = false): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return", returnTo);
  if (rerequest) params.set("rerequest", "1");
  const qs = params.toString();
  return `${API_BASE}/meta/auth${qs ? `?${qs}` : ""}`;
}

export async function deleteMetaAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/meta/accounts/${publicId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// ── TikTok accounts ────────────────────────────────────────────────────────────

export interface TikTokAccountInfo {
  publicId: string;
  openId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  scope: string;
  status: string;
  connectedAt: number;
  expiresAt: number;
  refreshExpiresAt: number;
}

export async function fetchTikTokAccounts(): Promise<TikTokAccountInfo[]> {
  const res = await fetch(`${API_BASE}/tiktok/accounts`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as { accounts: TikTokAccountInfo[] };
  return data.accounts;
}

export function getTikTokAuthUrl(returnTo?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return", returnTo);
  const qs = params.toString();
  return `${API_BASE}/tiktok/auth${qs ? `?${qs}` : ""}`;
}

export async function deleteTikTokAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tiktok/accounts/${publicId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/**
 * Ask the worker to (re)analyze a channel now. Returns immediately — the run happens
 * in the background. `queued: false` means a run for this channel is already in flight.
 */
export async function triggerChannelAnalysis(
  channelId: string,
): Promise<{ ok: boolean; queued: boolean; note: string }> {
  const res = await fetch(`${API_BASE}/youtube/pipeline/run/${channelId}`, { method: "POST" });
  if (!res.ok) throw new Error(`analysis trigger failed (${res.status})`);
  return res.json();
}

export interface ChannelDailyRow {
  channelId: string;
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  subscribersGained: number;
  subscribersLost: number;
  fetchedAt: number;
}

/** Stored daily analytics the worker has collected (served from our DB, not YouTube). */
export async function fetchChannelDaily(
  channelId: string,
  days = 90,
): Promise<ChannelDailyRow[]> {
  const res = await fetch(`${API_BASE}/youtube/analytics/${channelId}/daily?days=${days}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { rows: Record<string, unknown>[] };
  // Postgres BIGINT comes back as a string over JSON (node-postgres avoids precision
  // loss), so coerce the numeric fields — otherwise `+=` in the UI concatenates.
  return (data.rows ?? []).map((r) => ({
    channelId: String(r.channelId),
    day: String(r.day),
    views: Number(r.views),
    estimatedMinutesWatched: Number(r.estimatedMinutesWatched),
    averageViewDuration: Number(r.averageViewDuration),
    averageViewPercentage: Number(r.averageViewPercentage),
    subscribersGained: Number(r.subscribersGained),
    subscribersLost: Number(r.subscribersLost),
    fetchedAt: Number(r.fetchedAt),
  }));
}

// ── Channel video sync & trends ────────────────────────────────────────────────

import type {
  YouTubeChannelVideo,
  ChannelTrendSummary,
  DailyTrend,
  VideoTrend,
  SyncResponse,
  TrendingResponse,
  VideoCategory,
} from "@/lib/types";

export async function syncChannelVideos(channelId: string): Promise<SyncResponse> {
  const res = await fetch(`${API_BASE}/youtube/sync/${channelId}`, { method: "POST" });
  return json<SyncResponse>(res);
}

export async function fetchChannelVideos(channelId: string): Promise<{
  channelId: string;
  channelName: string;
  videoCount: number;
  videos: YouTubeChannelVideo[];
}> {
  const res = await fetch(`${API_BASE}/youtube/videos/${channelId}`);
  return json(res);
}

export async function fetchChannelTrends(channelId: string, days = 30): Promise<{
  channelId: string;
  channelName: string;
  days: number;
  trend: DailyTrend[];
  summary: ChannelTrendSummary;
}> {
  const res = await fetch(`${API_BASE}/youtube/trends/${channelId}?days=${days}`);
  return json(res);
}

export async function fetchVideoTrend(videoId: string, days = 30): Promise<VideoTrend> {
  const res = await fetch(`${API_BASE}/youtube/trends/video/${videoId}?days=${days}`);
  return json<VideoTrend>(res);
}

// ── YouTube 트렌드 (mostPopular chart) — 편집자용 아이디어 참고 ────────────────

export async function fetchTrendingVideos(
  regionCode = "KR",
  categoryId = "",
  maxResults = 50,
): Promise<TrendingResponse> {
  const params = new URLSearchParams({ regionCode, maxResults: String(maxResults) });
  if (categoryId) params.set("categoryId", categoryId);
  const res = await fetch(`${API_BASE}/youtube/popular?${params}`);
  return json<TrendingResponse>(res);
}

export async function fetchVideoCategories(
  regionCode = "KR",
): Promise<{ regionCode: string; categories: VideoCategory[] }> {
  const res = await fetch(`${API_BASE}/youtube/video-categories?regionCode=${regionCode}`);
  return json(res);
}

export interface VideoAnalyticsSummary {
  views?: number;
  likes?: number;
  shares?: number;
  subscribersGained?: number;
  averageViewDuration?: number; // seconds
  averageViewPercentage?: number; // 0–100
  estimatedMinutesWatched?: number;
  // Revenue (monetized channels only; absent otherwise). USD.
  estimatedRevenue?: number;
  estimatedAdRevenue?: number;
  grossRevenue?: number;
  cpm?: number;
  playbackBasedCpm?: number;
  adImpressions?: number;
  monetizedPlaybacks?: number;
}
export interface VideoTrafficSource {
  source: string;
  views: number;
  estimatedMinutesWatched?: number;
}
export interface VideoDemographic {
  ageGroup?: string;
  gender?: string;
  percentage?: number;
}
export interface VideoComment {
  id: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string;
}
export interface VideoAnalytics {
  video: YouTubeChannelVideo;
  summary: VideoAnalyticsSummary;
  trafficSources: VideoTrafficSource[];
  demographics: VideoDemographic[];
  retention: { ratio: number; watchRatio: number }[];
  comments: VideoComment[];
  fetchedAt: number | null;
}

/** Rich per-video analytics (avg view duration/%, traffic sources, demographics,
 *  retention curve, top comments) collected by the video.analyze / video.comments jobs. */
export async function fetchVideoAnalytics(videoId: string): Promise<VideoAnalytics> {
  const res = await fetch(`${API_BASE}/youtube/videos/${videoId}/analytics`);
  return json<VideoAnalytics>(res);
}

/** 워커에 이 영상의 댓글 수집을 요청한다 (업로드 7일이 지난 영상은 자동 수집 대상이 아님).
 *  잡을 큐잉만 하므로, 완료 여부는 fetchVideoAnalytics를 다시 불러 확인해야 한다. */
export async function refreshVideoComments(
  videoId: string,
): Promise<{ queued: boolean; alreadyPending: boolean }> {
  const res = await fetch(`${API_BASE}/youtube/videos/${videoId}/comments/refresh`, {
    method: "POST",
  });
  return json(res);
}

export async function deleteTrackedVideo(videoId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/youtube/videos/${videoId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

/** 프로그램 하드 삭제 · cascade (모든 회차 · 미디어 · GCS 파일 · 추천/클립). */
export async function deleteProgram(programId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/programs/${programId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

/** 회차 하드 삭제 · cascade (미디어 · GCS 파일 · 추천/클립). */
export async function deleteEpisode(episodeId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/episodes/${episodeId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

// ── ops/diagnostics (superadmin /ops dashboard) ─────────────────────────────────
export interface OpsJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lockedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface OpsJobsResponse {
  jobs: OpsJob[];
  stats: { pending: number; running: number; done: number; failed: number };
}
/** Live job list + queue depth for the ops dashboard. */
export async function fetchOpsJobs(limit = 100): Promise<OpsJobsResponse> {
  return json<OpsJobsResponse>(await fetch(`${API_BASE}/admin/jobs?limit=${limit}`, { cache: "no-store" }));
}

export interface OpsMediaRow {
  mediaId: string;
  episodeId: string | null;
  title: string;
  durationSec: number;
  hasAudio: boolean;
  createdAt: number;
  analysis: {
    status: "pending" | "done" | "failed";
    error: string | null;
    genre: string | null;
    scenes: number | null;
    shorts: number | null;
    cast: number | null;
    stagesDone: string[] | null;
    hasData: boolean;
    tookMs: number;
    updatedAt: number;
  } | null;
  pipeline: { stage?: string; stageStatus?: string; progress?: number; note?: string; blockedReason?: string } | null;
}
/** Per-uploaded-video analysis summary (status, counts, error, live stage) for the dashboard. */
export async function fetchOpsMediaAnalysis(): Promise<{ media: OpsMediaRow[] }> {
  return json<{ media: OpsMediaRow[] }>(await fetch(`${API_BASE}/admin/media-analysis`, { cache: "no-store" }));
}

// ── 자연어 영상 검색 (search_segments · pgvector) ──────────────────────────────
/** 검색 결과 카드 하나 = 잘라서 바로 쓸 수 있는 구간(beat). */
export interface SearchResultCard {
  segmentId: string;
  mediaId: string;
  start: number;
  end: number;
  duration: number | null;
  characters: string[];
  sceneType: string | null;
  isShort: boolean;
  highlightScore: number | null;
  summary: string | null;
  dialogue: string | null;
  /** 권리·스포일러 상태 주석 (키→사람이 읽는 문구). 비면 이슈 없음. */
  rightsStatus: Record<string, string>;
  score: number;
  lex: number;
  vec: number;
}

/** 서버가 쿼리를 어떻게 필터로 쪼갰는지 (투명성). */
export interface SearchParsed {
  characters: string[];
  sceneType?: string;
  isShort?: boolean;
  airedFrom?: string;
  airedTo?: string;
  semantic: string;
  charactersUsed: string[];
}

export interface SearchResponse {
  query: string;
  /** 이 검색의 로그 키. 이후 click/export 이벤트를 같은 쿼리에 묶는다. */
  queryId?: string;
  parsed: SearchParsed;
  /** 의미 축(임베딩)이 실제로 걸렸는지. false면 키워드 축만으로 랭킹. */
  embedded: boolean;
  count: number;
  results: SearchResultCard[];
}

export interface SearchParams {
  q: string;
  program?: string;
  genre?: string;
  scopeType?: string;
  scopeId?: string;
  episode?: string;
  character?: string;        // 콤마 구분
  sceneType?: string;
  isShort?: boolean;
  airedFrom?: string;
  airedTo?: string;
  allowSpoiler?: boolean;
  topK?: number;
}

/** 자연어 쿼리로 검색. 필터는 파라미터, q는 LLM 파서가 필터+의미로 쪼갠다. */
export async function searchSegments(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set("q", params.q);
  if (params.program) qs.set("program", params.program);
  if (params.genre) qs.set("genre", params.genre);
  if (params.scopeType) qs.set("scope_type", params.scopeType);
  if (params.scopeId) qs.set("scope_id", params.scopeId);
  if (params.episode) qs.set("episode", params.episode);
  if (params.character) qs.set("character", params.character);
  if (params.sceneType) qs.set("scene_type", params.sceneType);
  if (params.isShort != null) qs.set("is_short", String(params.isShort));
  if (params.airedFrom) qs.set("aired_from", params.airedFrom);
  if (params.airedTo) qs.set("aired_to", params.airedTo);
  if (params.allowSpoiler) qs.set("allow_spoiler", "true");
  if (params.topK) qs.set("top_k", String(params.topK));
  return json<SearchResponse>(await fetch(`${API_BASE}/search?${qs}`, { signal, cache: "no-store" }));
}

// ── 검색 로그 (search_events) ──────────────────────────────────────────────────
// 어떤 결과를 실제로 골랐는지 / 경계를 얼마나 밀었는지가 랭킹·컷지점 학습의 지도 신호다.
// search 이벤트는 서버가 스스로 남기므로 여기선 그 이후 행동만 보낸다.

export interface SearchLogEvent {
  event: "click" | "export" | "boundary_adjust";
  /** searchSegments 응답의 queryId — 없으면 로그가 쿼리에 묶이지 않는다. */
  queryId?: string;
  segmentId?: string;
  mediaId?: string;
  clipId?: string;
  rank?: number;
  start?: number;
  end?: number;
  before?: { start?: number; end?: number };
  after?: { start?: number; end?: number };
}

/** fire-and-forget. 실패해도 UI 흐름을 막지 않는다 — 로그는 부가정보다. */
export function logSearchEvent(ev: SearchLogEvent): void {
  void fetch(`${API_BASE}/search/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev),
    keepalive: true,
  }).catch(() => {});
}

// ── 썸네일 엔진 (프로그램 단위) ────────────────────────────────────────────────
// 스타일 프로파일과 출연자 사진은 프로그램마다 한 번 준비하면 이후 회차에 자동 적용된다.

export interface ThumbnailStyleProfile {
  programId: string;
  title: string;
  /** 빈도·중앙값 집계. 키마다 [값, 횟수] 배열. */
  aggregate: Record<string, unknown> | null;
  /** 생성 프롬프트에 실제로 들어가는 한국어 문장. */
  prompt: string;
}

/** 없으면 null — 아직 학습 안 한 프로그램이다. */
export async function fetchThumbnailStyle(programId: string): Promise<ThumbnailStyleProfile | null> {
  const res = await fetch(`${API_BASE}/programs/${programId}/thumbnail-style`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`스타일 조회 실패 (${res.status})`);
  return (await res.json()) as ThumbnailStyleProfile;
}

/** sourceUrl 은 재생목록 URL 을 권장 — 채널 전체는 프로그램이 섞여 톤이 뭉개진다. */
export async function trainThumbnailStyle(
  programId: string,
  sourceUrl: string,
  opts: { limit?: number; sample?: number } = {},
): Promise<{ ok: boolean; jobId?: string }> {
  const res = await fetch(`${API_BASE}/programs/${programId}/thumbnail-style`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl, ...opts }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any)?.message ?? "학습 요청 실패");
  return (await res.json()) as { ok: boolean; jobId?: string };
}

export interface CastPhotoEntry {
  name: string;
  photos: number;
}

export async function fetchCastPhotos(programId: string): Promise<CastPhotoEntry[]> {
  const res = await fetch(`${API_BASE}/programs/${programId}/cast-photos`);
  if (!res.ok) return [];
  return ((await res.json()) as { cast: CastPhotoEntry[] }).cast ?? [];
}

export async function uploadCastPhoto(
  programId: string,
  name: string,
  file: File,
): Promise<void> {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  const res = await fetch(`${API_BASE}/programs/${programId}/cast-photos`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(((await res.json()) as any)?.message ?? "업로드 실패");
}

export async function deleteCastPhotos(programId: string, name: string): Promise<void> {
  await fetch(`${API_BASE}/programs/${programId}/cast-photos/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

/** 회차 → 썸네일 후보 생성 (워커 잡). 인물 미등록이면 잡이 실패로 남는다. */
export async function generateThumbnail(
  mediaId: string,
  programId: string,
  candidates = 3,
): Promise<{ ok: boolean; jobId?: string }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/thumbnail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ programId, candidates }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any)?.message ?? "썸네일 생성 요청 실패");
  return (await res.json()) as { ok: boolean; jobId?: string };
}

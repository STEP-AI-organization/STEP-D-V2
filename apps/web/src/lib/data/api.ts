/**
 * Backend client (real-video mode). Talks to @stepd/server. When the server is
 * unreachable the store falls back to the in-memory mock, so the app still runs
 * standalone — this module is only used once a live server is detected.
 */
import type { DistributionChannel } from "@/lib/constants";
import type { ClipReframe, Program, ProgramStatus, ReframeMode, RenderChannel } from "@/lib/types";
import type { EditorState } from "@/lib/editor/presets";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "/api";

/**
 * 렌더(clips/:id/export) 전용 베이스 — **stepd-render** 서비스로 가는 프록시(/api/render-proxy).
 * 렌더는 서버가 하는 가장 무거운 작업이라 동시 렌더가 메인 서버 CPU 를 뺏지 않게 전용 서비스
 * (concurrency=1·4vCPU)로 뺐다(사용자 2026-08-21). 프로덕션(프록시 경유)에서만 갈라지고,
 * 로컬 직결(NEXT_PUBLIC_API_URL 없음)이면 메인과 동일 — 로컬엔 렌더 서비스가 없다.
 */
export const RENDER_BASE =
  process.env.NEXT_PUBLIC_RENDER_URL?.replace(/\/$/, "")
  || (process.env.NEXT_PUBLIC_API_URL ? API_BASE.replace("/proxy/", "/render-proxy/") : API_BASE);

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

/** 상태코드와 서버 메시지를 함께 들고 다니는 에러. `admin/src/api.ts` 와 같은 모양이다. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 응답 → 결과. 실패면 **서버가 준 사유를 살려서** 던진다.
 *
 * ⚠️ 예전에는 `throw new Error(\`${res.status} ${res.statusText}\`)` 로 본문을 **읽지도 않았다.**
 * 그래서 서버가 공들여 쓴 한국어 사유가 전부 사라졌다 —
 * `"워크스페이스 관리는 owner/admin 만 가능합니다"` 가 화면에서는 `403 Forbidden` 이 됐다.
 * 사용자는 자기 권한 문제의 HTTP 상태코드를 듣고, 무엇을 해야 하는지는 못 듣는다.
 *
 * 서버는 라우트마다 `error` 또는 `message` 키를 쓴다(둘 다인 경우도 있다) — 둘 다 본다.
 * 같은 해법이 `admin/src/api.ts:20` 에 이미 있었다. 새로 만들지 않고 그 형태를 가져왔다.
 */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null) as {
      message?: string;
      error?: string | { code?: string; message?: string };
      code?: string;
    } | null;
    const nested = body?.error && typeof body.error === "object" ? body.error : undefined;
    const fallbackError = typeof body?.error === "string" ? body.error : undefined;
    throw new ApiError(
      res.status,
      body?.message ?? nested?.message ?? fallbackError ?? `${res.status} ${res.statusText}`,
      body?.code ?? nested?.code ?? fallbackError,
      body,
    );
  }
  return (await res.json()) as T;
}

/** 실패 응답에서 사람이 읽을 사유를 뽑는다. 본문이 없거나 JSON 이 아니면 상태줄로 물러난다. */
export async function errorMessageOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
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
/** One AI-recommended short (core.recommend.recommend output). */
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
  /** 방송 실무 3-type (2026-07-23~): shortform(40~60s SNS) / clip(1~5분 네이버·재편집) / highlight(5~10분 회차 요약). */
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
  /** 단어 타이밍(Soniox·whisper 경로). 자막을 화면 단위로 끊을 때 경계로 쓴다 — 없으면 음절 비례. */
  words?: { word: string; start: number; end: number }[];
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
  if (!res.ok) throw new ApiError(res.status, `ppl fetch failed: ${await errorMessageOf(res)}`);
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
  if (!res.ok) throw new ApiError(res.status, `analysis fetch failed: ${await errorMessageOf(res)}`);
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
  if (!res.ok) throw new ApiError(res.status, `faces fetch failed: ${await errorMessageOf(res)}`);
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
  if (!res.ok) throw new ApiError(res.status, `mapping save failed: ${await errorMessageOf(res)}`);
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
  if (!res.ok) throw new ApiError(res.status, `cast fetch failed: ${await errorMessageOf(res)}`);
  return res.json();
}

export type EpisodeCastStatus = "confirmed" | "rejected" | "candidate" | "matched";

/** 서버가 400/404 로 돌려주는 사유를 그대로 화면까지 올린다 — 인물 판단은 사람 몫이라 실패를 삼키면 안 된다. */
async function castJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** 인물 확정/제외 — 파이프라인은 후보를 제안만 하고, confirmed 로 가는 유일한 경로가 이 라우트다. */
export async function setEpisodeCastStatus(
  mediaId: string,
  name: string,
  status: EpisodeCastStatus,
  castId?: string,
): Promise<EpisodeCastPerson> {
  const r = await castJson<{ person: EpisodeCastPerson }>(
    await fetch(`${API_BASE}/media/${mediaId}/cast/${encodeURIComponent(name)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, ...(castId ? { castId } : {}) }),
    }),
  );
  return r.person;
}

/** 후보를 프로그램 명단에 등록 + 이 회차 확정까지 한 번에 (다음 회차부터 자동 매칭). */
export async function registerEpisodeCast(
  mediaId: string,
  name: string,
  input?: { name?: string; role?: string; aliases?: string[] },
): Promise<EpisodeCastPerson> {
  const r = await castJson<{ person: EpisodeCastPerson }>(
    await fetch(`${API_BASE}/media/${mediaId}/cast/${encodeURIComponent(name)}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    }),
  );
  return r.person;
}

/** Re-run the AI content pipeline for a media (operator recovery from a failed analysis).
 *  cast/profile 등이 바뀌면 fingerprint에서 걸러 필요한 스테이지만 재실행됨. fast=true면 정밀 스테이지 스킵. */
export async function reanalyzeMedia(mediaId: string, fast = false): Promise<{ ok: boolean; queued: boolean }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(fast ? { fast: true } : {}) }),
  });
  if (!res.ok) throw new ApiError(res.status, `재분석 요청 실패: ${await errorMessageOf(res)}`);
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
  /** 파이프라인 분기 축(variety|drama). 미설정이면 워커가 auto 판정.
   *  ""를 보내면 서버가 필드를 삭제한다(= 지정 해제 → auto 판정으로 복귀). */
  pipelineGenre?: "variety" | "drama" | "";
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
  brandIconDataUrl?: string;
  castPhotos?: Record<string, string>;
  // ── AI 프롬프트 — 프로그램별 추가 지시 (다음 분석부터 반영) ─────────────
  /** 제목 생성 추가 지시. ""를 보내면 서버가 필드를 삭제한다(pipelineGenre 와 같은 시맨틱). */
  titlePrompt?: string;
  /** 추천(BEAT 조합) 추가 지시. "" = 필드 삭제(지시 없음 복귀). */
  recommendPrompt?: string;
  // ── 편성 상태 · 담당 · 권리 윈도우 (FLOWS F10 · 2026-08-10) ──────────────
  /** 방영 중/종영/편성 예정. 사람이 지정한다 — 날짜로 자동 판정하지 않는다. */
  status?: ProgramStatus;
  /** 담당 PD 이름. "내 담당만" 필터가 이 값을 본다. */
  owner?: string;
  /** 디지털 권리 만료일 (YYYY-MM-DD). 임박하면 카드가 경고 톤이 된다 — 차단은 아니다. */
  rightsUntil?: string;
  /** 권리 자유 메모 (예: "해외 배포 불가 · 국내만"). */
  rightsNote?: string;
  /** 종영일 (YYYY-MM-DD). */
  endedDate?: string;
  /**
   * 네이버 클립 카테고리 기본값. `null` 을 보내면 서버가 필드를 삭제한다
   * (= 장르에서 유도). 서버가 저장 시점에 분류표와 대조하고, 없는 값이면 400 이다.
   */
  naverCategory?: { primary: string; secondary: string } | null;
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

/** 서버가 그린 **정적 오버레이 PNG**(제목·채널 텍스트)의 content-hash. null = 그릴 정적
 *  오버레이 없음(또는 canvas 미지원) → 에디터는 CSS 근사를 그대로 쓴다. */
export interface OverlayPngResponse {
  hash: string | null;
  width: number;
  height: number;
}

/**
 * 현재 editorState 로 정적 오버레이 PNG 를 서버에 렌더 요청하고 hash 를 받는다(AENA 방식).
 * 같은 입력이면 같은 hash → 서버가 캐시를 재사용한다. 이미지 src 는 프록시를 존중하도록
 * **클라이언트에서 API_BASE 로 합성**한다(서버가 준 절대경로 url 은 프록시를 안 탐).
 */
export async function renderClipOverlayPng(
  clipId: string,
  editorState: EditorState,
  aspect?: string,
  layer?: "title" | "channel",
): Promise<OverlayPngResponse> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/overlay-png`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editorState, ...(aspect ? { aspect } : {}), ...(layer ? { layer } : {}) }),
  });
  return json<OverlayPngResponse>(res);
}

/** 오버레이 PNG hash → `<img src>` (API_BASE 경유 = 프록시 존중). */
export function overlayPngSrc(clipId: string, hash: string): string {
  return `${API_BASE}/clips/${clipId}/overlay-png/${hash}`;
}

export interface ClipReframeResponse {
  clipId: string;
  reframe: ClipReframe;
}

export interface RequestClipReframeResponse extends ClipReframeResponse {
  reused: boolean;
  queued: boolean;
}

export async function getClipReframe(clipId: string): Promise<ClipReframeResponse> {
  return json(await fetch(`${API_BASE}/clips/${clipId}/reframe`, { cache: "no-store" }));
}

export async function requestClipReframe(
  clipId: string,
  mode: ReframeMode,
  retry = false,
): Promise<RequestClipReframeResponse> {
  return json(
    await fetch(`${API_BASE}/clips/${clipId}/reframe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...(retry ? { retry: true } : {}) }),
    }),
  );
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

// GCS resumable chunk size. MUST be a multiple of 256 KiB (GCS requirement).
// Long masters use larger chunks: on a 4 GB file, 16 MiB meant 256 sequential HTTP
// round-trips even on a fast uplink. 64 MiB cuts that to 64 without buffering the file
// (Blob.slice is a zero-copy view). Smaller uploads keep 16 MiB so a retry does not resend
// an unnecessarily large slice on an unstable connection.
const RESUMABLE_CHUNK_SMALL = 16 * 1024 * 1024;
const RESUMABLE_CHUNK_LARGE = 64 * 1024 * 1024;
const LARGE_UPLOAD_THRESHOLD = 1024 * 1024 * 1024;
const CHUNK_RETRIES = 6;

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
export interface UploadVideoOptions {
  title?: string;
  onProgress?: (pct: number) => void;
  /** 업로드 세션이 준비돼 파일 전송이 시작되는 순간. UI가 즉시 백그라운드로 빠질 때 쓴다. */
  onStarted?: () => void;
  /** true = 빠른 분석(자막만, 시각 분석 스킵). 기본 false=정밀. content.analyze 잡 페이로드로 전달. */
  fast?: boolean;
  /** 회차 번호 (F1 필수 입력). 생략하면 서버가 MAX+1 로 매긴다. */
  episodeNumber?: number;
  /** 방영일 YYYY-MM-DD (F1 기본값 = 오늘). */
  broadDate?: string;
  /** 분석 트랙 (F1 필수 입력) — 프로그램 기본값을 덮는다. */
  track?: "variety" | "drama";
  /** 자막 동시 업로드 여부. false 면 음성 인식으로 대체한다. */
  hasSubtitle?: boolean;
}

/** 같은 프로그램·같은 회차 번호 (서버 409 · FLOWS F1 ⊘). */
export class DuplicateEpisodeError extends Error {
  constructor(readonly episodeNumber: number) {
    super(`회차 ${episodeNumber} 은(는) 이미 이 프로그램에 있습니다.`);
    this.name = "DuplicateEpisodeError";
  }
}

/**
 * 업로드 Content-Type — **브라우저가 모르는 형식은 확장자로 정한다.**
 *
 * `.mxf` 같은 방송 컨테이너는 OS 에 MIME 등록이 없어 `File.type` 이 빈 문자열이다. 예전엔
 * 그때 `"video/mp4"` 로 폴백해서 **MXF 바이트가 video/mp4 로 GCS 에 저장**됐다 — 브라우저가
 * 재생을 시도하다 깨지고, 나중에 원인 추적도 어려웠다(2026-08-27 MXF 대응).
 * 재생용 mp4 는 서버가 업로드 직후 따로 만든다(worker media.prepare 정규화).
 */
export function uploadContentType(file: File): string {
  if (file.type) return file.type;
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  const byExt: Record<string, string> = {
    mxf: "application/mxf", mov: "video/quicktime", mkv: "video/x-matroska",
    avi: "video/x-msvideo", ts: "video/mp2t", m2ts: "video/mp2t",
    mpg: "video/mpeg", mpeg: "video/mpeg", wmv: "video/x-ms-wmv", mp4: "video/mp4",
  };
  return byExt[ext] ?? "application/octet-stream";
}

export async function uploadVideo(
  file: File,
  programId: string,
  opts: UploadVideoOptions = {},
): Promise<UploadResult> {
  const { title, onProgress, onStarted, fast, episodeNumber, broadDate, track, hasSubtitle } = opts;
  const meta = {
    programId,
    title,
    ...(episodeNumber !== undefined ? { episodeNumber } : {}),
    ...(broadDate ? { broadDate } : {}),
    ...(track ? { track } : {}),
    ...(hasSubtitle === false ? { hasSubtitle: false } : {}),
  };

  const initRes = await fetch(`${API_BASE}/media/upload-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: uploadContentType(file),
      ...meta,
    }),
  });
  // 업로드를 시작하기 전에 걸러 준다 — 몇 GB 를 올린 뒤 중복이라고 하면 시간을 통째로 잃는다.
  if (initRes.status === 409 && episodeNumber !== undefined) {
    throw new DuplicateEpisodeError(episodeNumber);
  }
  const init = await json<
    | { mode: "resumable"; mediaId: string; objectPath: string; sessionUrl: string }
    | { mode: "multipart"; mediaId: string; objectPath: string }
  >(initRes);

  if (init.mode === "multipart") {
    onStarted?.();
    return uploadVideoMultipart(file, programId, opts);
  }

  onStarted?.();
  await uploadResumable(init.sessionUrl, file, onProgress);

  const finalRes = await fetch(`${API_BASE}/media/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaId: init.mediaId,
      objectPath: init.objectPath,
      filename: file.name,
      contentType: uploadContentType(file),
      size: file.size,
      ...(fast ? { fast: true } : {}),
      ...meta,
    }),
  });
  // 업로드 도중에 다른 사람이 같은 번호를 먼저 만들었을 때 — 유일 인덱스가 잡는다.
  if (finalRes.status === 409 && episodeNumber !== undefined) {
    throw new DuplicateEpisodeError(episodeNumber);
  }
  return json<UploadResult>(finalRes);
}

/** 직접 업로드한 완성 영상의 서버 응답 — 회차 없이 바로 배포 가능한 클립이 만들어진다. */
export interface FinishedClipResult {
  clip: { id: string; title: string; aspectRatio?: string; mediaId?: string } | null;
  media: { id: string };
}

/**
 * 편집자가 우리 도구 밖에서 만든 **완성 영상**을 올려 바로 배포 가능한 클립으로 만든다.
 * 회차·분석 파이프라인을 태우지 않는다 — 파일 자체가 최종 산출물이다.
 *
 * upload-init(대용량 resumable) 을 그대로 재사용하되, 회차 번호는 넘기지 않고 finalize 대신
 * clip-finalize 를 부른다. 로컬(GCS 미설정)이면 clip-upload multipart 로 폴백한다.
 */
export interface FinishedClipOptions {
  title?: string;
  /** 회차 번호 — 기록되고, 같은 번호의 회차가 있으면 연결까지 된다. */
  episodeNumber?: number;
  /** 편집본 유형: shorts(숏폼) · clip(클립) · highlight(하이라이트). */
  editKind?: "shorts" | "clip" | "highlight";
  onProgress?: (pct: number) => void;
}

export async function uploadFinishedClip(
  file: File,
  programId: string,
  opts: FinishedClipOptions = {},
): Promise<FinishedClipResult> {
  const { title, episodeNumber, editKind, onProgress } = opts;

  const initRes = await fetch(`${API_BASE}/media/upload-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ programId, filename: file.name, contentType: uploadContentType(file) }),
  });
  const init = await json<
    | { mode: "resumable"; mediaId: string; objectPath: string; sessionUrl: string }
    | { mode: "multipart"; mediaId: string; objectPath: string }
  >(initRes);

  if (init.mode === "multipart") return uploadFinishedClipMultipart(file, programId, opts);

  await uploadResumable(init.sessionUrl, file, onProgress);

  const finalRes = await fetch(`${API_BASE}/media/clip-finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaId: init.mediaId,
      objectPath: init.objectPath,
      programId,
      filename: file.name,
      contentType: uploadContentType(file),
      size: file.size,
      title,
      episodeNumber,
      editKind,
    }),
  });
  return json<FinishedClipResult>(finalRes);
}

/** 로컬 dev · 소용량 multipart 폴백 (uploadVideoMultipart 와 같은 형태). */
function uploadFinishedClipMultipart(
  file: File,
  programId: string,
  opts: FinishedClipOptions,
): Promise<FinishedClipResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("programId", programId);
    if (opts.title) form.append("title", opts.title);
    if (opts.episodeNumber !== undefined) form.append("episodeNumber", String(opts.episodeNumber));
    if (opts.editKind) form.append("editKind", opts.editKind);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/media/clip-upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
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
  const chunkSize = total >= LARGE_UPLOAD_THRESHOLD
    ? RESUMABLE_CHUNK_LARGE
    : RESUMABLE_CHUNK_SMALL;
  let offset = 0;

  while (offset < total) {
    let end = Math.min(offset + chunkSize, total);

    let res: ChunkResponse | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      // Re-slice from the CURRENT offset each attempt — after a committed-offset resync a
      // stale slice's Content-Range would mismatch and GCS 400s the whole upload.
      end = Math.min(offset + chunkSize, total);
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
        // 지수 백오프 — 즉시 재시도하면 대역폭 포화(4개 동시 GB 업로드) 순간에 재시도가 순식간에
        // 소진돼 파일이 통째로 실패한다(사용자 2026-08-21 AENA 13GB 배치 중 "Failed to fetch").
        // 재시도 사이를 벌려(0.6→1.2→2.4→4.8→8s) 혼잡이 풀릴 시간을 준다.
        if (attempt < CHUNK_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)));
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
  opts: UploadVideoOptions,
): Promise<UploadResult> {
  const { title, onProgress, fast, episodeNumber, broadDate, track, hasSubtitle } = opts;
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("programId", programId);
    if (title) form.append("title", title);
    if (fast) form.append("fast", "true");
    if (episodeNumber !== undefined) form.append("episodeNumber", String(episodeNumber));
    if (broadDate) form.append("broadDate", broadDate);
    if (track) form.append("track", track);
    if (hasSubtitle === false) form.append("hasSubtitle", "false");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/media/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else if (xhr.status === 409 && episodeNumber !== undefined) {
        reject(new DuplicateEpisodeError(episodeNumber));
      } else reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

// `clip` is absent when the rec was already adopted (server returns just the clipId).
// orientation(가로/세로)은 채택 시 사람이 고른 값 — 서버가 clip.aspectRatio 로 세팅한다.
export async function adoptRec(
  recId: string,
  opts?: { orientation?: "portrait" | "landscape" },
): Promise<{ clipId: string; clip?: unknown }> {
  return json(await fetch(`${API_BASE}/recommendations/${recId}/adopt`, {
    method: "POST",
    ...(opts?.orientation
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orientation: opts.orientation }) }
      : {}),
  }));
}

// ── 자동 배포 (FLOWS F6 · 서버 migrations/0019) ──────────────────────────────────

export type RuleMediaKind = "short" | "clip" | "both";
export type GatePolicy = "approve_first" | "hold_on_issue";

export interface AutomationRule {
  id: string;
  programId: string;
  platform: string;
  accountId: string;
  mediaKind: RuleMediaKind;
  /** 채택 기준은 2026-08-26 삭제(점수 순 상위 하나로 고정) — 서버가 항상 "top3" 를 저장한다. */
  criterion?: string;
  gatePolicy: GatePolicy;
  window: string;
  enabled: boolean;
  /** 렌더 템플릿 (assets/shorts-template 이름). 미지정 = 프로그램 장르 자동. */
  templateId?: string;
  /**
   * 템플릿 위치 미세조정 — 자동배포 화면 슬라이더 (시드 기본값 위에 덮임).
   * 자막 오버레이(위치 %·크기 %·색·on/off)도 이 layout JSONB 안에 함께 담긴다
   * (automation_rule 에 자막 전용 컬럼 없이 라운드트립).
   */
  layout?: {
    titleY?: number; channelIconY?: number; channelBoxY?: number; channelIconSize?: number;
    /** 제목 강조색(#RRGGBB) — 미지정 = 템플릿 accent 색(표준=청록). */
    titleColor?: string;
    /** 자막 세로 위치(% · 화면 하단 기준). */
    subtitleY?: number;
    /** 자막 글자 크기(% · 화면 높이 기준). */
    subtitleSize?: number;
    /** 자막 색(#RRGGBB). */
    subtitleColor?: string;
    /** 자막 켜기 — 기본 true. false 면 자동 클립을 자막 없이 렌더. */
    subtitles?: boolean;
    /** 요소 표시 여부 — 미지정 = 표시. 고객마다 제목·로고·시간박스를 뺄 수 있다. */
    title?: boolean;
    logo?: boolean;
    timebox?: boolean;
  };
  /**
   * 자동 생성 숏폼의 리프레임 — 수동 채택(adopt-dialog)과 같은 값 체계.
   * "ai" = beat별 얼굴 추적 자동 크롭 · "none"(기본) = 중앙 고정 크롭.
   * 구버전 서버/규칙엔 없다 — 없으면 "none" 으로 읽는다.
   */
  reframe?: "ai" | "none";
  /**
   * 채택 형태 — 수동 채택과 같은 값 체계. 서버는 reframe=ai 를 portrait 에서만 허용하므로
   * reframe 을 보낼 땐 orientation 도 함께 보내야 한다. 미지정=추천 kind 기반(하위호환).
   */
  orientation?: "portrait" | "landscape";
  /** 다중 프로그램·채널 (2026-08-12). 배열이 있으면 배열이 정본, 없으면 단수 폴백. */
  programIds?: string[];
  channels?: { platform: string; accountId: string }[];
  /** 채널당 하루 게시 할당량 — 찰 때까지 확인 때마다 계속. 기본 3. */
  dailyQuota?: number;
  /** 활동 시간창(KST 시각). 기본 9~22. */
  activeStart?: number;
  activeEnd?: number;
  /**
   * 발행 요일 — ISO 1=월…7=일. `null`·`[]` = 매일(구 규칙 동작).
   * 서버 `ruleWeekdays` 가 정본이고 화면은 그대로 읽는다.
   */
  weekdays?: number[] | null;
  /**
   * 발행 시각 — KST "HH:MM". 하나라도 있으면 **하루 발행 수 = 이 개수**이고
   * `dailyQuota` 는 무시된다(서버 `perDayCount`). `null`·`[]` = 할당량 방식.
   */
  /** 발행 시간 슬롯 — 신형 {time,count}(시각당 개수 · 2026-08-25) · 구형 "HH:MM" 문자열(=1개). */
  slots?: (string | { time: string; count: number })[] | null;
  /**
   * 채널별 오늘 게시 수 — key = "platform:accountId" (서버 확장분 · 옵셔널).
   * 구버전 서버는 안 내려준다 — 없으면 화면은 "오늘 N/한도" 줄을 통째로 숨긴다.
   */
  publishedToday?: Record<string, number>;
}

export interface RuleRun {
  id: number; at: string; ruleId: string | null; clipId: string | null;
  result: string; detail: string;
  /** "platform:accountId" — 어느 채널로 나갔나(자동 배포 기록 표시용). */
  accountKey?: string | null;
}

export interface RuleHold { ruleId: string; clipId: string; reason: string; heldAt: string }

export async function fetchAutomation(): Promise<{
  rules: AutomationRule[];
  runs: RuleRun[];
  holds: RuleHold[];
  paused: boolean;
  /** 크레딧 부족 등 "왜 아무것도 안 하는지" — 빈 문자열이면 정상 가동. */
  idleReason: string;
  /**
   * 워크스페이스 크레딧 잔액 (서버 확장분 · 옵셔널). 상태 헤더가 "켜짐 / 크레딧 소진" 을
   * 가른다. 구버전 서버는 안 내려준다 — 없으면(undefined) 크레딧 사유는 idleReason 으로만.
   */
  credit?: number;
  /**
   * 마지막 순방(자동 확인) 시각 ISO (서버 확장분 · 옵셔널). 순방 심박이라 rule_run 이 한 줄도
   * 안 남은 순방도 잡는다. 구버전 서버는 안 내려준다 — 없으면 runs[0].at 폴백.
   */
  lastCycleAt?: string | null;
  /**
   * 순방 주기(ms · 서버 확장분 · 옵셔널). "다음 확인 예정" = lastCycleAt + cycleEveryMs 추정.
   * 0 이거나 없으면 다음 예정 표시를 숨긴다(주기 순방 꺼짐 · 수동 확인만).
   */
  cycleEveryMs?: number;
  /**
   * 채널별 실업로드 스위치 (서버 확장분 · 옵셔널). key = "platform:accountId" 또는 platform.
   * **명시적 false 만 "꺼짐"이다** — 키가 없으면 알 수 없음이므로 경고하지 않는다.
   * 구버전 서버는 필드 자체가 없다 — 그때는 게이트 경고를 전부 숨긴다.
   */
  gates?: Record<string, boolean>;
  /**
   * 자동배포 완료 알림을 받을 담당자 이메일 (서버 확장분 · 옵셔널). 빈 문자열 = 알림 끔.
   * 실업로드 성공 시 서버(워커)가 영상 제목·URL 을 이 주소로 보낸다.
   */
  notifyEmail?: string;
}> {
  return json(await fetch(`${API_BASE}/automation`, { cache: "no-store" }));
}

// ── 세로 4택 리프레임 비교 (reframe-compare-viewer-plan §4 · 내부 뷰어 전용) ──────

export interface ReframeCandidate {
  layout: string;
  eligible: boolean;
  score: number;
  reasonCodes: string[];
  cropWidthFraction: number;
  metrics: Record<string, number> | null;
  tracking?: { t: number; cx: number; cy: number; confidence?: number }[];
}

export interface ReframeCompareSegment {
  beatId: number | string;
  start: number;
  end: number;
  synthetic: boolean;
  candidates: ReframeCandidate[];
  selected: string;
  selectedReasons: string[];
  final: string;
  hysteresis: string[];
}

export interface ReframeCompareResult {
  clipId: string;
  compareId: string;
  status: "ready" | "queued" | "running" | "failed" | "not_found";
  error?: string;
  manifest?: {
    frames: string[];
    clipStart: number;
    clipEnd: number;
    switchesPerMinute: number | null;
  };
  candidates?: {
    layouts: string[];
    pendingAxes: string[];
    weights: Record<string, number>;
    segments: ReframeCompareSegment[];
    timeline: { start: number; end: number; layout: string }[];
    switchesPerMinute: number;
  };
}

/** 비교 작업 생성 — 같은 입력(트림·beat)이면 서버가 기존 산출물을 재사용한다(멱등). */
export async function createReframeCompare(
  clipId: string,
): Promise<{ compareId: string; status: string; reused: boolean }> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/reframe/candidates`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

export async function fetchReframeCompare(
  clipId: string, compareId: string,
): Promise<ReframeCompareResult> {
  const res = await fetch(
    `${API_BASE}/clips/${clipId}/reframe/candidates/${compareId}`, { cache: "no-store" },
  );
  if (res.status === 404) return { clipId, compareId, status: "not_found" };
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

/** 비교 산출물 파일 URL — 프록시 경유(API_BASE)라 서버가 준 절대경로 대신 여기서 조립한다. */
export function reframeCompareFileUrl(clipId: string, compareId: string, name: string): string {
  return `${API_BASE}/clips/${clipId}/reframe/candidates/${compareId}/file/${name}`;
}

// ── 리프레임 라벨 — 비교 뷰어의 "이 장면은 이 레이아웃" 1클릭 정답 (계획 §5) ──────

/** 서버 행 그대로(snake_case) — 뷰어 표시용 최소 필드만 쓴다. */
export interface ReframeLabelRow {
  id: number;
  beat_id: string | null;
  seg_start: number | null;
  seg_end: number | null;
  at_sec: number | null;
  chosen: string;
  machine: string | null;
  agree: boolean | null;
  note: string | null;
  created_at: number;
}

export async function saveReframeLabel(clipId: string, label: {
  compareId: string;
  beatId?: string;
  segStart?: number;
  segEnd?: number;
  atSec?: number;
  chosen: string;
  machine?: string;
  /** 그 순간의 후보 4종 점수·게이트 스냅샷 — 서버는 검증 없이 보존한다(라벨의 관찰 맥락). */
  context?: unknown;
  note?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/reframe/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(label),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

export async function fetchReframeLabels(clipId: string, compareId: string): Promise<ReframeLabelRow[]> {
  const res = await fetch(
    `${API_BASE}/clips/${clipId}/reframe/labels?compareId=${encodeURIComponent(compareId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  const data = await res.json();
  return Array.isArray(data?.rows) ? data.rows : [];
}

/** 자동배포 완료 알림 담당자 이메일 저장 — 빈 문자열이면 알림을 끈다. */
export async function setAutomationNotifyEmail(email: string): Promise<{ notifyEmail: string }> {
  const res = await fetch(`${API_BASE}/automation/notify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

export async function saveAutomationRule(
  rule: Omit<AutomationRule, "id"> & { id?: string },
): Promise<{ rule: AutomationRule; notice: string }> {
  const res = await fetch(`${API_BASE}/automation/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return res.json();
}

export async function deleteAutomationRule(id: string): Promise<{ notice: string }> {
  const res = await fetch(`${API_BASE}/automation/rules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

/** 미디어(클립) 삭제 — 클립 + 렌더 산출물 정리. 이미 채널에 올라간 영상은 안 내려간다. */
export async function deleteClip(id: string): Promise<{ notice: string }> {
  const res = await fetch(`${API_BASE}/clips/${id}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

/** 하이라이트 훅 재생성 (숏폼 전용) — Gemini 가 클립 자막에서 훅 대사 + 어그로 자막을 새로 뽑는다. */
export interface HookResult { hookTimeSec: number; hookQuote?: string; hookIntroCaption?: string }
export async function regenerateClipHook(id: string): Promise<HookResult> {
  const res = await fetch(`${API_BASE}/clips/${id}/regenerate-hook`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

export async function setAutomationPaused(paused: boolean): Promise<{ notice: string }> {
  const res = await fetch(`${API_BASE}/automation/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

/** 순방을 지금 한 번 돈다 — 현재 워크스페이스 규칙만 평가한다. */
export async function runAutomationNow(): Promise<{
  rulesEvaluated: number; adopted: number; published: number; held: number; idleReason: string;
}> {
  return json(await fetch(`${API_BASE}/automation/run`, { method: "POST", credentials: "include" }));
}

/** 보류 해제 — 사람이 확정하는 지점(F6 Invariant). */
export async function releaseAutomationHold(
  ruleId: string, clipId: string, actor: string,
): Promise<{ ok: boolean; notice: string }> {
  const res = await fetch(`${API_BASE}/automation/holds/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleId, clipId, actor }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return res.json();
}

/** 승인 대기 건 거부 — 이 (규칙·영상)은 나가지 않는다(승인과 대칭·반대 · 서버 rejectHold). */
export async function rejectAutomationHold(
  ruleId: string, clipId: string, actor: string,
): Promise<{ ok: boolean; notice: string }> {
  const res = await fetch(`${API_BASE}/automation/holds/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleId, clipId, actor }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return res.json();
}

// ── 썸네일 생성 (FLOWS F7) ──────────────────────────────────────────────────────
//
// 결과는 스토리지에 남는다 — 화면을 떠나도, 잡이 끝난 뒤에도. 그래서 완료 알림이 없고
// 대신 **언제든 다시 조회된다**(F7-5).

export interface ThumbnailCandidateFile { id: string; name: string; url: string }

export async function generateThumbnails(
  mediaId: string,
  input: { programId: string; prompt?: string; aspect?: "16:9" | "9:16"; candidates?: number },
): Promise<{ jobId: string }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/thumbnail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return res.json();
}

export async function fetchThumbnailCandidates(
  mediaId: string,
): Promise<{ candidates: ThumbnailCandidateFile[]; selected: string | null }> {
  return json(await fetch(`${API_BASE}/media/${mediaId}/thumbnails`, { cache: "no-store" }));
}

export async function selectThumbnailCandidate(mediaId: string, path: string): Promise<void> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/thumbnails/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

// ── 에셋 (FLOWS F8 · 서버 migrations/0016) ──────────────────────────────────────
//
// ⊘ 이름 변경 없음 · ⊘ 되돌리기 없음. 그래서 rename 함수가 없고, 삭제 전에 dryRun 으로
//   무엇이 함께 지워지는지 세어 본다.

export type AssetKind = "image" | "video" | "audio" | "font" | "other";
export type AssetSort = "recent" | "name" | "size";

export interface AssetFolder { path: string; parent: string; name: string }
export interface AssetFile {
  id: string; folder: string; name: string; kind: AssetKind;
  mime: string; size: number; storagePath: string; createdAt: string;
}

export async function fetchAssets(folder: string): Promise<{
  folder: string; folders: AssetFolder[]; files: AssetFile[];
}> {
  return json(await fetch(`${API_BASE}/assets?folder=${encodeURIComponent(folder)}`, { cache: "no-store" }));
}

export async function createAssetFolder(parent: string, name: string): Promise<AssetFolder> {
  const res = await fetch(`${API_BASE}/assets/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return (await res.json()).folder;
}

export async function moveAssetFolder(from: string, to: string): Promise<void> {
  const res = await fetch(`${API_BASE}/assets/folders/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
}

/** 폴더 삭제. dryRun 이면 지우지 않고 개수만 돌려준다 — 확인 문구가 숫자를 말해야 한다. */
export async function deleteAssetFolder(
  path: string,
  dryRun = false,
): Promise<{ folders: number; files: number }> {
  const res = await fetch(
    `${API_BASE}/assets/folders?path=${encodeURIComponent(path)}${dryRun ? "&dryRun=true" : ""}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return res.json();
}

export async function uploadAsset(folder: string, file: File): Promise<AssetFile> {
  const form = new FormData();
  form.append("file", file);
  form.append("folder", folder);
  const res = await fetch(`${API_BASE}/assets/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return (await res.json()).file;
}

export async function moveAssets(ids: string[], folder: string): Promise<number> {
  const res = await fetch(`${API_BASE}/assets/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, folder }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(b?.error ?? `${res.status}`);
  }
  return (await res.json()).moved;
}

export async function deleteAssets(ids: string[]): Promise<number> {
  const res = await fetch(`${API_BASE}/assets`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()).deleted;
}

export function assetRawUrl(id: string): string {
  return `${API_BASE}/assets/${id}/raw`;
}

// ── 채널별 업로드 판정 (서버 내부 호환 계약) ───────────────────────────────────
//
// 판정은 서버가 한다. 화면이 자기 나름대로 계산하면 규칙이 두 벌이 되고, 한쪽만 고치는
// 순간 "고를 수 있는데 실패하는" 채널이 생긴다.

export type ChannelRole = "main" | "sub" | "shorts_only" | "affiliate";

/**
 * 배포 모달에서 쓰는 서버 판정 대상.
 *
 * 응답 원본은 하위 호환 때문에 `rules` 키를 유지하지만, 프론트에서는 별도 채널 설정으로
 * 취급하지 않는다. 연결된 계정과 서버 기본 조건을 합친 읽기 전용 대상이다.
 */
export interface ChannelPublishTarget {
  platform: string;
  accountId: string;
  label: string;
  role: ChannelRole;
  maxSec: number | null;
  aspect: "9:16" | "16:9" | "any";
  titlePrefix: string;
  hashtagTemplate: string;
  tonePreset: string;
  privacy: "public" | "unlisted" | "private";
  /** 공개 유예(분) — 자동 게시를 이만큼 비공개로 잡아뒀다 공개한다. 0 = 즉시.
   *  공개 범위가 '공개'일 때만 적용된다(서버 automation-cycle::youtubeReleasePlan). */
  publishDelayMin?: number;
  scheduleWindow: string;
  enabled: boolean;
  /** true = 별도 저장값 없이 서버 안전 기본값으로 합성한 대상. */
  isDefault?: boolean;
}

export interface ChannelEligibility {
  ok: boolean;
  reason: string;
  code: string;
  blockedClipIds: string[];
}

export async function fetchChannelRules(): Promise<ChannelPublishTarget[]> {
  const res = await fetch(`${API_BASE}/channel-rules`, { cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()).rules as ChannelPublishTarget[];
}

export async function saveChannelRule(
  platform: string,
  accountId: string,
  patch: Partial<ChannelPublishTarget>,
): Promise<ChannelPublishTarget> {
  const res = await fetch(`${API_BASE}/channel-rules/${encodeURIComponent(platform)}/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()).rule as ChannelPublishTarget;
}

/** 배포 모달용 — 이 미디어들을 각 채널에 보낼 수 있는지. 키는 `platform:accountId`. */
export async function fetchChannelEligibility(
  clipIds: string[],
): Promise<{ rules: ChannelPublishTarget[]; eligibility: Record<string, ChannelEligibility> }> {
  return json(
    await fetch(`${API_BASE}/channel-rules/eligibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipIds }),
    }),
  );
}

// ── 로그인 (세션 쿠키 · HttpOnly) ──────────────────────────────────────────────
//
// 쿠키는 서버가 Set-Cookie 로 심고 JS 는 못 읽는다(HttpOnly). 그래서 모든 호출에
// `credentials: "include"` 가 필요하다 — 빼먹으면 로그인은 되는데 다음 요청이 익명이 된다.

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** 워크스페이스 관리 역할. */
  role: string;
  /** 방송 업무 역할 (FLOWS F9). */
  opsRole?: string;
  tenantId: string;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    // 계정 존재 여부를 흘리지 않는다 — 서버가 그러라고 더미 해시까지 돌린다.
    if (b?.error === "invalid_credentials") throw new Error("이메일 또는 비밀번호가 올바르지 않습니다.");
    // 회사 정지(403)처럼 **사용자가 할 일이 다른** 실패는 서버가 사람 말로 사유를 준다.
    // 이걸 버리고 error 코드만 띄우면 화면에 "workspace_blocked" 가 그대로 뜬다.
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return (await res.json()).user;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}

export async function acceptInvite(
  token: string,
  input: { password: string; name?: string },
): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/accept-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token, ...input }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return (await res.json()).user;
}

export async function changePassword(current: string, next: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ current, next }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
}

// ── 크레딧 (선불 · 포트원 일반결제) ─────────────────────────────────────────────
//
// 크레딧 1개 = 분석 1분. **결제 성공을 브라우저가 판단하지 않는다** — 결제창이 성공을
// 돌려줘도 크레딧은 서버가 웹훅으로 확정한다. 화면은 잔액을 다시 조회해 확인할 뿐이다.

export interface CreditLedgerRow {
  id: number; delta: number; reason: string;
  mediaId: string | null; paymentId: string | null; amountKrw: number | null;
  note: string; actor: string; occurredAt: string;
}

export interface CreditState {
  balance: number;
  unit: string;
  priceKrw: number | null;
  ledger: CreditLedgerRow[];
  /** 자동 충전이 조치 필요 사유로 실패 중이면 온다(서버 확장분 · 옵셔널). 화면 상단 빨간 배너의 생산자. */
  autoTopupAlert?: {
    code: string; message: string; hint: string;
    firstAt: string; lastAt: string; count: number; balance: number | null;
  } | null;
  /** 이번 달(KST) 분석 사용량(크레딧 · 서버 확장분). 게이지가 이 값을 그린다. */
  monthUsage?: number;
  /** 결제 알림 수신자 — 인보이스·자동 결제 실패 메일이 이 목록으로도 나간다. */
  notifyEmails?: string[];
}

export async function fetchCredits(): Promise<CreditState> {
  return json(await fetch(`${API_BASE}/credits`, { cache: "no-store", credentials: "include" }));
}

/** 결제 알림 수신자 저장(최대 5명) — 빈 배열이면 추가 수신자 없음. 관리자 전용(서버 403). */
export async function saveBillingNotifyEmails(emails: string[]): Promise<{ notifyEmails: string[] }> {
  const res = await fetch(`${API_BASE}/billing/notify-emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ emails }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return res.json();
}

// ── 인보이스 — 결제 완료된 충전 건마다 하나. PDF 는 브라우저가 이 데이터로 그린다. ──

export interface InvoiceRow {
  id: string;
  /** 표시용 번호 — 12자 랜덤형 토큰(결제마다 고정 · 날짜·내부 ID 미노출) — 결제 데이터에서 결정적으로 만든다. */
  number: string;
  paidAt: string;
  credits: number;
  /** 부가세 포함 총액. supply/vat 는 서버가 역산해 준다 — 화면이 다시 계산하지 않는다. */
  amountKrw: number;
  supplyKrw: number;
  vatKrw: number;
  origin: "auto" | "manual";
  description: string;
}

export interface InvoiceParty {
  name: string;
  bizNo: string;
  ceoName: string;
  address: string;
  email: string;
}

export interface InvoiceList {
  invoices: InvoiceRow[];
  supplier: InvoiceParty;
  buyer: InvoiceParty;
}

export async function fetchInvoices(): Promise<InvoiceList> {
  return json(await fetch(`${API_BASE}/credits/invoices`, { cache: "no-store", credentials: "include" }));
}

export interface TopupOrder {
  paymentId: string;
  credits: number;
  amountKrw: number;
  storeId: string;
  channelKey: string;
  orderName: string;
}

// ── 저장 카드(빌링키) ─────────────────────────────────────────────────────────
// 매번 카드를 다시 넣지 않게 한 번 등록해 두고 버튼으로 충전한다.
// 카드 번호는 브라우저 → 포트원으로 **직접** 가고 우리 서버에는 오지 않는다.

export interface SavedCard {
  registered: boolean;
  /** "신한 ****1234" — 카드 번호는 애초에 못 받는다. */
  label: string | null;
  /** 카드 모양 UI 재료 — 발급사/브랜드 + 마스킹 끝 4자리(포트원 빌링키 조회에서 채움). */
  brand?: string | null;
  last4?: string | null;
  createdAt: string | null;
  /** 서버에 빌링 채널키가 없으면 false — 등록 버튼을 아예 안 보여준다. */
  available: boolean;
  unavailableReason: string | null;
  /**
   * 저장된 구매자 3종 — **카드 등록/변경 화면의 프리필 재료**(2026-08-26).
   * 카드 관리 권한이 없는 사람에겐 서버가 null 을 준다(전화번호는 개인정보).
   * 예전엔 이 필드가 없어서, 서버가 전화번호를 갖고 있어도 '카드 변경' 이 빈 칸에서
   * 다시 시작했고 그 화면엔 입력란도 없어 400 으로 막혔다.
   */
  buyer: { fullName: string; email: string; phoneNumber: string } | null;
}

export async function fetchSavedCard(): Promise<SavedCard> {
  return json(await fetch(`${API_BASE}/billing/card`, { cache: "no-store", credentials: "include" }));
}

export interface CardIssuePrep {
  storeId: string;
  channelKey: string;
  billingKeyMethod: "CARD";
  issueId: string;
  issueName: string;
  customer: { fullName: string; email: string; phoneNumber: string };
}

/**
 * 카드 등록 준비 — 브라우저 SDK 에 넘길 값을 서버가 만든다.
 * 필수 고객정보(이름·이메일·휴대폰)가 빠지면 **결제창을 띄우기 전에** 400 으로 막는다.
 */
export async function prepareCardIssue(input: {
  fullName: string; email: string; phoneNumber: string;
}): Promise<CardIssuePrep> {
  const res = await fetch(`${API_BASE}/billing/card/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return res.json();
}

/** 발급된 빌링키 저장. 회사당 한 장 — 다시 등록하면 덮어쓴다. */
export async function saveCard(input: {
  billingKey: string; cardBrand?: string; cardLast4?: string;
  /** 빌링키 결제의 customer 필수 3종(이니시스) — 서버가 카드에 저장해 결제 때 보낸다. */
  buyer: { fullName: string; email: string; phoneNumber: string };
}): Promise<void> {
  const res = await fetch(`${API_BASE}/billing/card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
}

export async function deleteSavedCard(): Promise<void> {
  const res = await fetch(`${API_BASE}/billing/card`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/**
 * 자동 결제 정책 — **고정이다**(2026-08-26). 잔액이 소진되면 저장 카드로 자동 결제한다.
 * 값은 서버(credits.ts FIXED_AUTO_TOPUP)가 정하고 화면은 **보여주기만** 한다 —
 * 화면이 자기 상수를 들고 있으면 서버와 다른 금액을 말하게 되고 그게 곧 결제 분쟁이다.
 */
export interface AutoTopupPolicy {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
  maxPerDay: number;
  maxKrwPerMonth: number;
  updatedAt?: string | null;
  updatedBy?: string;
}

export interface AutoTopupState {
  policy: AutoTopupPolicy;
  /** 고정 정책인가 — 참이면 설정 UI 를 그리지 않는다(설정을 못 찾는 게 아니라 없는 것이다). */
  fixed: boolean;
  /** 꺼져 있으면 **왜** 꺼져 있는지(카드 없음·해지). 화면이 조치를 안내한다. */
  disabledReason: string | null;
}

export async function fetchAutoTopup(): Promise<AutoTopupState> {
  const r = await json<{ policy: AutoTopupPolicy; fixed?: boolean; disabledReason?: string | null }>(
    await fetch(`${API_BASE}/credits/auto-topup`, { cache: "no-store", credentials: "include" }),
  );
  return { policy: r.policy, fixed: r.fixed === true, disabledReason: r.disabledReason ?? null };
}

/**
 * 자동 결제 정책은 **고정이라 저장 API 가 없다** (2026-08-26).
 * 서버 `PUT /api/credits/auto-topup` 은 409 `policy_fixed` 로 닫혀 있고, 끄는 유일한 방법은
 * 결제 수단(카드) 삭제다 — `deleteSavedCard()` 를 쓸 것. 수동 실행(`/run`)도 설정 화면과
 * 함께 사라져 호출부가 없으므로 클라이언트 함수를 두지 않는다(죽은 export 금지).
 */

/**
 * 저장 카드로 충전. **결제창이 없다** — 서버가 바로 긁고 승인까지 확인한 뒤 응답한다.
 * 그래서 일반결제와 달리 웹훅을 기다릴 필요가 없고, 응답의 balance 가 이미 반영된 잔액이다.
 */
export async function topupWithCard(
  credits: number,
  idempotencyKey: string,
  // 구 카드(구매자 정보 미저장)의 폴백 — 서버는 카드 저장분을 우선 쓰고, 없으면 이 값으로
  // 결제한 뒤 카드에 백필한다.
  buyer?: { fullName: string; email: string; phoneNumber: string },
): Promise<{
  paymentId: string; credits: number; amountKrw: number; balance: number; duplicate?: boolean;
}> {
  const res = await fetch(`${API_BASE}/credits/topup/card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    // idempotencyKey: 성공할 때까지 같은 키를 재사용해야 재시도가 이중 결제가 안 된다(서버 필수).
    body: JSON.stringify({ credits, idempotencyKey, ...(buyer ? { buyer } : {}) }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return res.json();
}

/** 충전 주문 생성 — **결제창을 띄우기 전에** 서버가 금액을 확정한다. */
export async function createTopupOrder(credits: number, actor: string): Promise<TopupOrder> {
  const res = await fetch(`${API_BASE}/credits/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ credits, actor }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${res.status}`);
  }
  return res.json();
}

// ── 게이트: 권리·심의 (FLOWS F3 · 서버 migrations/0012) ─────────────────────────
//
// 게이트 상태는 저장돼 있지 않다 — 서버가 매번 계산해서 준다. 화면은 받은 값을 그리기만
// 하고, 자기 나름대로 "통과일 것 같다"를 만들지 않는다.

export type GateSubjectType = "episode" | "recommendation" | "clip";
export type GateState = "pass" | "rights_hold" | "conditional" | "review_pending" | "blocked";
export type IssueKind = "music" | "portrait" | "ppl" | "cast_hold" | "brand_blur" | "vod_window";
export type IssueResolution = "open" | "conditional" | "resolved" | "blocked";

export interface GateResult {
  state: GateState;
  label: string;
  allowed: boolean;
  reason: string;
  blocking: { id: string; kind: string; resolution: string }[];
}

export interface RightsIssue {
  id: string;
  subjectType: GateSubjectType;
  subjectId: string;
  kind: IssueKind | string;
  resolution: IssueResolution | string;
  bandStart: number | null;
  bandEnd: number | null;
  note: string;
  actor: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  inheritedFrom: string | null;
}

export async function fetchGate(
  subjectType: GateSubjectType,
  subjectId: string,
): Promise<{ gate: GateResult; issues: RightsIssue[]; judged: boolean }> {
  return json(await fetch(`${API_BASE}/gate/${subjectType}/${subjectId}`, { cache: "no-store" }));
}

/**
 * 여러 대상의 게이트를 한 번에 — 목록 화면용.
 * 대상마다 따로 부르면 N+1 이 되고, 느려지면 게이트 표시를 생략하고 싶어진다.
 */
export async function fetchGateBatch(
  subjectType: GateSubjectType,
  subjectIds: string[],
): Promise<{ gates: Record<string, GateResult>; issues: Record<string, RightsIssue[]> }> {
  if (subjectIds.length === 0) return { gates: {}, issues: {} };
  return json(
    await fetch(`${API_BASE}/gate/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectType, subjectIds }),
    }),
  );
}

/** 이슈 등록 — **사람만.** actor 없이 부르면 서버가 400 을 준다. */
export async function createRightsIssue(input: {
  subjectType: GateSubjectType;
  subjectId: string;
  kind: IssueKind;
  resolution: "open" | "conditional" | "blocked";
  bandStart?: number;
  bandEnd?: number;
  note: string;
  actor: string;
}): Promise<{ issue: RightsIssue; gate: GateResult }> {
  return json(
    await fetch(`${API_BASE}/rights-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

/** 해제/재개. resolved 로 바꿀 땐 근거 문장이 필수다(서버가 막는다). */
export async function updateRightsIssue(
  id: string,
  input: { resolution: IssueResolution; resolutionNote: string; actor: string },
): Promise<{ issue: RightsIssue; gate: GateResult }> {
  const res = await fetch(`${API_BASE}/rights-issues/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function deleteRightsIssue(id: string, actor: string): Promise<void> {
  const res = await fetch(`${API_BASE}/rights-issues/${id}?actor=${encodeURIComponent(actor)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** "이슈 없음" 판정 — 이것도 사람의 판단이다(F2 Invariant: 미판정과 구분). */
export async function judgeNoIssues(
  subjectType: GateSubjectType,
  subjectId: string,
  actor: string,
  note = "",
): Promise<{ gate: GateResult }> {
  return json(
    await fetch(`${API_BASE}/rights-judgement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectType, subjectId, actor, note }),
    }),
  );
}

export async function fetchGateAudit(
  subjectType: GateSubjectType,
  subjectId: string,
): Promise<Record<string, unknown>[]> {
  const r = await json<{ events: Record<string, unknown>[] }>(
    await fetch(`${API_BASE}/gate-audit/${subjectType}/${encodeURIComponent(subjectId)}`, { cache: "no-store" }),
  );
  return r.events;
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
 * `channel` picks the destination render preset (F3): the frame (네이버 TV renders 16:9, Shorts/
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
  // 렌더는 전용 서비스(stepd-render)로 — 메인 API 서버 CPU 를 안 뺏게(RENDER_BASE).
  return json(
    await fetch(`${RENDER_BASE}/clips/${clipId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel ?? "" }),
    }),
  );
}

/**
 * 프리미어로 넘긴다 — **맥락을 먼저 서버에 남기고, 그 다음 앱을 띄운다.**
 *
 * ⚠️ 브라우저가 실행 중인 프리미어 패널에 값을 직접 건넬 방법이 없다(UXP 는 OS→패널 입력이
 * 없다). 그래서 둘로 나뉜다: 이 함수가 **맥락**을 서버에 남기고(패널이 5초 폴링으로 집어간다),
 * `stepd://` 스킴이 **실행**을 맡는다(편집자 PC 에 launcher/install.ps1 로 한 번 등록).
 *
 * 순서를 지킨다 — 남기기 전에 앱을 띄우면 패널이 빈손으로 깨어난다.
 * 프리미어가 이미 떠 있으면 스킴 등록이 없어도 동작한다(폴링만으로 성립).
 */
export async function openInPremiere(payload: {
  programId?: string; episodeId?: string; clipId?: string; mediaId?: string; label?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/premiere/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
  // 스킴이 등록돼 있지 않으면 브라우저가 조용히 무시한다 — 그래도 맥락은 이미 남았으므로
  // 프리미어를 사람이 직접 켜도 패널이 그 회차로 따라간다.
  if (typeof window !== "undefined") window.location.href = "stepd://open";
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

/**
 * 배포 결과 — **제외된 건을 반드시 받는다** (FLOWS.md:70 ⊘ 조용히 제외 금지).
 * 서버가 게이트로 다시 판정하므로, 화면이 통과라고 본 것도 여기서 빠질 수 있다.
 */
export interface PublishOutcome {
  queued: string[];
  recorded: string[];
  skipped: { clipId: string; code: string; reason: string }[];
  notice: string;
}

export async function publishClips(
  clipIds: string[],
  channel: DistributionChannel,
  opts: {
    reserveDate?: string; scheduled?: boolean;
    /** YouTube: 어느 연결 채널로 올릴지 — 게시 가능 채널이 여럿이면 필수(서버가 추측하지 않는다). */
    youtubeChannelId?: string;
    /** 네이버: 어느 계정으로 올릴지 (다계정 필수). */
    naverAccountId?: string;
    /** 네이버 클립: 10자 이상 필수. */
    description?: string;
    naverCategory?: { primary: string; secondary: string };
    /** TikTok: 어느 계정 받은함으로 (게이트 ON 일 때만). */
    tiktokOpenId?: string;
    /** Instagram: 어느 IG 비즈니스 계정으로 (게이트 ON 일 때만). */
    igUserId?: string;
    /** Facebook: 어느 Meta 페이지로 (게이트 ON 일 때만). */
    metaPageId?: string;
  } = {},
): Promise<PublishOutcome> {
  const res = await fetch(`${API_BASE}/distributions/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds, channel, ...opts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
  const body = (await res.json().catch(() => null)) as Partial<PublishOutcome> | null;
  return {
    queued: body?.queued ?? [],
    recorded: body?.recorded ?? [],
    skipped: body?.skipped ?? [],
    notice: body?.notice ?? "",
  };
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
export type ConsentMode = "analytics" | "publish" | "all";

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

/** 연동해제 — 토큰만 끊고 채널 행·이력은 남긴다. 삭제와 다른 동작. */
export async function disconnectYouTubeChannel(channelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/youtube/channels/${channelId}/disconnect`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
}

// ── Meta (Facebook Pages) accounts ─────────────────────────────────────────────
// 2026-08-13 분리: Instagram 은 더 이상 이 흐름에 실려오지 않는다(아래 Instagram 섹션).
// ig* 필드는 분리 전에 연결된 행에만 남아 있다.

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
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
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
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** 연동해제 — 토큰만 끊고 계정 행은 남긴다. */
export async function disconnectMetaAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/meta/accounts/${publicId}/disconnect`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

// ── Instagram accounts (Instagram 비즈니스 로그인 — Facebook Page 경유 아님) ────

export interface InstagramAccountInfo {
  publicId: string;
  igUserId: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  /** long-lived 토큰 만료(~60일). 지나면 재연결해야 한다. */
  expiresAt: number;
  status: string;
  connectedAt: number;
}

export async function fetchInstagramAccounts(): Promise<InstagramAccountInfo[]> {
  const res = await fetch(`${API_BASE}/instagram/accounts`);
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  const data = (await res.json()) as { accounts: InstagramAccountInfo[] };
  return data.accounts;
}

export function getInstagramAuthUrl(returnTo?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return", returnTo);
  const qs = params.toString();
  return `${API_BASE}/instagram/auth${qs ? `?${qs}` : ""}`;
}

export async function deleteInstagramAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instagram/accounts/${publicId}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** 연동해제 — 토큰만 끊고 계정 행은 남긴다. */
export async function disconnectInstagramAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instagram/accounts/${publicId}/disconnect`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
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
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
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
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** 연동해제 — 토큰만 끊고 계정 행은 남긴다. */
export async function disconnectTikTokAccount(publicId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tiktok/accounts/${publicId}/disconnect`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/**
 * Ask the worker to (re)analyze a channel now. Returns immediately — the run happens
 * in the background. `queued: false` means a run for this channel is already in flight.
 */
export async function triggerChannelAnalysis(
  channelId: string,
): Promise<{ ok: boolean; queued: boolean; note: string }> {
  const res = await fetch(`${API_BASE}/youtube/pipeline/run/${channelId}`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, `analysis trigger failed: ${await errorMessageOf(res)}`);
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

/** 검색 히트 구간 다운로드 URL (`<a href download>` 용 — fetch 아님).
 *  서버가 캐시(analysis/{id}/segments/) 히트면 즉시, 미스면 trimEncode 후 서빙. */
export function segmentDownloadUrl(mediaId: string, start: number, end: number): string {
  return `${API_BASE}/media/${mediaId}/segment?start=${Math.max(0, start).toFixed(2)}&end=${end.toFixed(2)}`;
}

/** 서버가 쿼리를 어떻게 필터로 쪼갰는지 (투명성). */
export interface SearchParsed {
  /** q 없이 부른 기본 목록(하이라이트 순)이면 true. */
  empty?: boolean;
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
  /** 대표 썸네일 파일명 — 학습이 "그 채널의 전형"으로 뽑은 2장. */
  refs: string[];
  /** 학습에 쓴 수집 썸네일 전체 파일명. */
  thumbs: string[];
}

/** refs·thumbs 의 파일명 → 이미지 URL. */
export function thumbnailStyleImageUrl(programId: string, name: string): string {
  return `${API_BASE}/programs/${programId}/thumbnail-style/thumbs/${encodeURIComponent(name)}`;
}

/** 없으면 null — 아직 학습 안 한 프로그램이다. */
export async function fetchThumbnailStyle(programId: string): Promise<ThumbnailStyleProfile | null> {
  const res = await fetch(`${API_BASE}/programs/${programId}/thumbnail-style`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `스타일 조회 실패: ${await errorMessageOf(res)}`);
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

// ── 콘텐츠 공장 (내부용) ──────────────────────────────────────────────────────
// 외부용 /api/factory/* 는 x-factory-key 를 요구한다. 그 키를 브라우저에 내려보내면
// 유출되고, 유출되면 남이 우리 채널에 영상을 올릴 수 있다 — 화면은 내부 라우트를 쓴다.

export interface FactoryRunClip {
  clipId: string;
  title: string;
  rendered: boolean;
  // origin: "automation"·"factory"=자동 · "manual"·"retry"=수동 · 구 기록엔 없음(배지 생략)
  distributions: { channel: string; status: string; externalId: string | null; origin?: string }[];
}

export interface FactoryRunStatus {
  jobId: string;
  status: string;
  note: string | null;
  error: string | null;
  dryRun: boolean;
  updatedAt: number;
  clips: FactoryRunClip[];
}

/** 회차 하나를 공장에 태운다. targets = ["youtube:UC..."] */
export async function runFactory(
  mediaId: string,
  targets: string[],
  policy: { dryRun?: boolean; maxShorts?: number; publishPublic?: boolean } = {},
): Promise<{ jobId: string; status: string; reused?: boolean }> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/factory-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targets, policy }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    // 채널별 사유(problems)가 있으면 그걸 그대로 보여줘야 운영자가 고칠 수 있다.
    const detail = Array.isArray(body?.problems) ? ` — ${body.problems.join(" / ")}` : "";
    throw new Error((body?.message ?? `${res.status}`) + detail);
  }
  return body;
}

/** 이 회차의 공장 실행 상태. 실행한 적 없으면 null. */
export async function fetchFactoryRun(mediaId: string): Promise<FactoryRunStatus | null> {
  const res = await fetch(`${API_BASE}/media/${mediaId}/factory-run`);
  if (!res.ok) return null;
  return ((await res.json()) as { job: FactoryRunStatus | null }).job;
}

// ── 쇼츠 프레임 템플릿 ─────────────────────────────────────────────────────────

export interface FrameRect { x: number; y: number; w: number; h: number }
export interface FrameBand extends FrameRect { color: string; over: boolean }
export interface FrameTextSlot {
  slot: string;
  x: number;
  align: "center" | "left";
  y: number;
  size: number;
  color: string;
  borderw: number;
  bordercolor: string;
}
/** 좌표는 전부 **%** 다 — 편집기 캔버스와 export 가 같은 기준을 쓰게 서버에서 변환해 내려준다. */
export interface FrameTemplate {
  name: string;
  title: string;
  size: [number, number];
  video: FrameRect & { fit: "cover" | "contain" };
  bands: FrameBand[];
  overlayRegions: FrameRect[];
  text: FrameTextSlot[];
  overlayUrl: string;
}

export async function fetchShortsTemplates(): Promise<FrameTemplate[]> {
  const res = await fetch(`${API_BASE}/shorts-templates`, { cache: "no-store" });
  if (!res.ok) return [];
  return ((await res.json()) as { templates: FrameTemplate[] }).templates ?? [];
}

/** overlayUrl 은 서버 상대경로라 프록시 베이스를 붙여야 브라우저가 받을 수 있다. */
export function frameOverlaySrc(t: FrameTemplate): string {
  return t.overlayUrl.startsWith("http") ? t.overlayUrl : `${API_BASE}${t.overlayUrl.replace(/^\/api/, "")}`;
}

// ── 네이버 계정 (네이버 TV · 클립 · B2B 다계정) ────────────────────────────────
//
// 다른 채널과 근본적으로 다르다: 네이버는 **공개 업로드 API 가 없다.** 그래서 OAuth 가 없고,
// 사람이 한 번 로그인해서 만든 브라우저 세션을 등록하면 워커(사무실 PC)가 그걸로 대신 올린다.
//
// ⚠️ **세션 쿠키는 그 계정의 전체 권한이다.** 아이디·비번보다 오히려 즉시 쓸 수 있어 위험하다.
// 그래서 세션은 **올릴 때 한 번만** 오가고, 서버는 암호화해 저장한 뒤 다시는 돌려주지 않는다 —
// 조회 응답에 있는 건 "있다/없다 + 갱신 시각" 뿐이다.

export type NaverAccountStatus = "active" | "session_expired" | "disabled";

export interface NaverAccount {
  id: string;
  label: string;
  /** 우리가 발급한 불투명 키. 네이버 아이디가 아니다 — 워커 세션 파일 이름에 쓰인다. */
  accountKey: string;
  target: "clip" | "tv" | "both";
  status: NaverAccountStatus;
  /** 서버에 세션이 등록돼 있는가. 값 자체는 절대 내려오지 않는다. */
  hasSession: boolean;
  sessionUpdatedAt: number | null;
  lastLoginAt: number | null;
  lastPublishAt: number | null;
  /** 워커 PC 에서 직접 로그인할 때 그대로 실행할 명령. 옮겨 적다 틀리지 않게 서버가 만든다. */
  loginCommand: string;
}

export interface NaverAccountsResponse {
  accounts: NaverAccount[];
  /**
   * false 면 세션 등록이 503 이다(서버에 NAVER_SESSION_KEY 미설정).
   * 화면은 이 값으로 버튼을 미리 막는다 — 올려도 안 되는 버튼을 눌러보게 하는 게 더 나쁘다.
   */
  sessionStoreReady: boolean;
}

export interface NaverCategory {
  no: number;
  code: string;
  name: string;
  subs: { no: number; code: string; name: string }[];
}

/**
 * 클립 카테고리 분류표(1차 40 / 2차 144). 화면이 자유입력 대신 드롭다운을 그리는 근거다.
 *
 * 자유입력이던 시절엔 목록에 없는 문자열이 그대로 발행으로 넘어갔고, 브라우저 쪽에서
 * **첫 항목으로 조용히 대체**돼 엉뚱한 분류로 올라갔다. 고를 수 있는 값만 보여주면
 * 그 실수가 애초에 안 생긴다.
 */
export async function fetchNaverCategories(): Promise<NaverCategory[]> {
  const res = await fetch(`${API_BASE}/naver/categories`, { cache: "no-store" });
  if (!res.ok) throw new Error(await naverError(res));
  const body = (await res.json()) as { categories?: NaverCategory[] };
  return body.categories ?? [];
}

/**
 * 목록. **빈 배열로 삼키지 않는다** — 실패를 "계정 없음"으로 보여주면 사용자가 계정을
 * 다시 만들려 든다. 호출부가 에러를 표시하도록 던진다.
 */
export async function fetchNaverAccounts(): Promise<NaverAccountsResponse> {
  const res = await fetch(`${API_BASE}/naver/accounts`, { cache: "no-store" });
  if (!res.ok) throw new Error(await naverError(res));
  const body = (await res.json()) as Partial<NaverAccountsResponse>;
  return { accounts: body.accounts ?? [], sessionStoreReady: body.sessionStoreReady ?? false };
}

export async function createNaverAccount(
  label: string,
  target: NaverAccount["target"] = "both",
): Promise<NaverAccount> {
  const res = await fetch(`${API_BASE}/naver/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, target }),
  });
  if (!res.ok) throw new Error(await naverError(res));
  return (await res.json()) as NaverAccount;
}

export async function updateNaverAccount(
  id: string,
  patch: { label?: string; target?: NaverAccount["target"]; status?: NaverAccountStatus },
): Promise<void> {
  const res = await fetch(`${API_BASE}/naver/accounts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await naverError(res));
}

/** 상태만 바꾸는 단축 — 기존 호출부 호환. */
export async function setNaverAccountStatus(id: string, status: NaverAccountStatus): Promise<void> {
  await updateNaverAccount(id, { status });
}

/** 계정 삭제. 등록된 세션도 같은 행이라 함께 사라진다. */
export async function deleteNaverAccount(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/naver/accounts/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await naverError(res));
}

/**
 * 로그인 세션(Playwright storageState) 등록.
 *
 * 이걸 올리고 나면 워커가 어느 머신에서든 받아 쓴다 — 운영자가 워커 PC 앞에 갈 필요가 없다.
 */
export async function uploadNaverSession(id: string, storageState: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}/naver/accounts/${id}/session`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storageState }),
  });
  if (!res.ok) throw new Error(await naverError(res));
}

/** 세션만 폐기한다(계정 설정은 남긴다). 계정이 바뀌었을 때 쓴다. */
export async function clearNaverSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/naver/accounts/${id}/session`, { method: "DELETE" });
  if (!res.ok) throw new Error(await naverError(res));
}

/** 서버가 준 message 를 살려서 던진다 — "409" 만 뜨면 무엇을 고쳐야 할지 알 수 없다. */
async function naverError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
}

// ── 채널별 업로드 메타데이터 ────────────────────────────────────────────────────
//
// 클립 하나를 여러 채널에 올리는데 규격이 서로 다르다 — 네이버 클립은 **제목 필드가 없고**
// 설명 10자 이상 + 카테고리 필수, YouTube 는 제목 100자에 태그 필드가 따로다.
// 서버가 바탕 한 벌을 만들고 채널 맞춤은 결정론으로 한다(server: clip-metadata.ts).

export type MetaChannel =
  | "youtube" | "navertv" | "naverclip" | "instagram" | "facebook" | "tiktok";

export interface ChannelMeta {
  channel: MetaChannel;
  /** 그 채널에 제목 필드가 없으면 null (네이버 클립·인스타·틱톡). */
  title: string | null;
  description: string;
  tags: string[];
  /** 발행 전에 사람이 카테고리를 골라야 하는가. */
  needsCategory: boolean;
  /** 규격 위반 사유. 비어야 발행할 수 있다. */
  problems: string[];
  /** 사람이 고친 것 — 재생성이 덮지 않는다. */
  edited?: boolean;
}

/** 채널별 메타를 새로 만든다(사람이 고친 채널은 보존된다). */
export async function generateClipMetadata(
  clipId: string,
): Promise<{ channels: Record<string, ChannelMeta> }> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/generate-metadata`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { channels: Record<string, ChannelMeta> };
}

/** 사람이 고친 값을 저장한다. 저장 시점에 서버가 규격을 다시 본다. */
export async function saveClipMetadata(
  clipId: string,
  channel: MetaChannel,
  meta: { title?: string | null; description: string; tags: string[] },
): Promise<ChannelMeta> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/metadata/${channel}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return ((await res.json()) as { meta: ChannelMeta }).meta;
}

// ── 커머스 제휴 링크 검토 ─────────────────────────────────────────────────────
//
// 파이프라인이 상품을 찾아 링크까지 발급해 두지만 전부 `pending` 이라 설명란에 안 나간다.
// 사람이 보고 승인한 것만 나간다 — 이 함수들이 그 검토 화면의 통로다.

export type CommerceLinkStatus = "pending" | "approved" | "rejected";

export interface CommerceLink {
  provider: "coupang";
  query: string;
  /** 이 상품이 나온 장면 근거 — "왜 이게 붙었나" 를 설명한다. */
  reason?: string;
  productName: string;
  productUrl?: string;
  productId?: number;
  price?: number;
  imageUrl?: string;
  /** 제휴 단축 URL. ⚠️ **절대 열지 말 것** — 자기 클릭은 계정 정지 사유다. */
  url: string;
  status?: CommerceLinkStatus;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

/** 같은 검색어의 다른 상품 — 검토 화면에서 갈아끼울 수 있다. */
export interface CommerceCandidate {
  productId: number;
  itemId: number;
  vendorItemId: number;
  title: string;
  price?: number;
  imageUrl?: string;
  ratingCount?: number;
}

export interface ClipCommerce {
  enabled: boolean;
  queries: { query: string; reason?: string }[];
  links: CommerceLink[];
  candidates: Record<string, CommerceCandidate[]>;
  linkedAt: number | null;
  /** 승인분만 반영된 **실제 발행 설명란**. 화면이 따로 조립하지 않는다(서버가 정본). */
  preview: string;
  note: string | null;
}

export interface CommerceReviewRow {
  /** 이 클립에서 찾은 상품 쿼리 수. 링크가 0인데 이게 >0 이면 **발급이 아직 안 돈 것**이다. */
  queries: number;
  clipId: string;
  clipTitle: string;
  episodeId: string | null;
  programTitle: string | null;
  status: string | null;
  thumbUrl: string | null;
  pending: number;
  approved: number;
  rejected: number;
  links: CommerceLink[];
}

export interface CommerceReview {
  enabled: boolean;
  /** 회사 계정이 등록·활성인가. 아니면 발급이 보류된다(커미션 정산이 계정 단위라 폴백이 없다). */
  accountReady: boolean;
  total: number;
  pendingClips: number;
  /** 상품은 찾았는데 링크가 아직 없는 클립 수. */
  awaitingIssue: number;
  clips: CommerceReviewRow[];
}

/** 검토 대기 목록 — 클립을 하나씩 열지 않고 한 화면에서 훑는다. */
export async function fetchCommerceReview(): Promise<CommerceReview> {
  const res = await fetch(`${API_BASE}/commerce/review`);
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as CommerceReview;
}

/** 클립 하나의 상품·링크·대체 후보 + 발행 미리보기. */
export async function fetchClipCommerce(clipId: string): Promise<ClipCommerce> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/commerce`);
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as ClipCommerce;
}

/** 승인·거절 저장. 응답에 갱신된 미리보기가 함께 온다. */
export async function saveCommerceDecisions(
  clipId: string,
  decisions: { url: string; status: CommerceLinkStatus }[],
): Promise<{ links: CommerceLink[]; preview: string }> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/commerce`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { links: CommerceLink[]; preview: string };
}

/**
 * 링크 발급을 큐에 넣는다. `pick` 을 주면 그 상품으로 **교체**한다(교체는 곧 승인이다).
 * 발급은 로그인된 브라우저가 있는 PC 의 워커가 하므로 **비동기** — 잠시 뒤 다시 읽어야 한다.
 */
export async function issueCommerceLinks(
  clipId: string,
  pick?: { query: string; productId: number },
): Promise<{ jobId: string; queued: boolean }> {
  const res = await fetch(`${API_BASE}/clips/${clipId}/commerce/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pick ? { pick } : {}),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { jobId: string; queued: boolean };
}

/** 이 워크스페이스의 쿠팡파트너스 계정 상태. 세션 값은 서버가 절대 안 준다 — 있다/없다만. */
export interface CommerceAccount {
  id: string;
  label: string;
  status: "active" | "session_expired" | "disabled";
  sessionUpdatedAt: number | null;
  lastIssuedAt: number | null;
}

export async function fetchCommerceAccount(): Promise<{
  account: CommerceAccount | null;
  sessionKeyReady: boolean;
  enabled: boolean;
}> {
  const res = await fetch(`${API_BASE}/commerce/account`);
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { account: CommerceAccount | null; sessionKeyReady: boolean; enabled: boolean };
}

/** 계정 등록·수정(라벨·상태). 자격증명은 여기로 안 들어간다 — 세션은 아래 전용 함수로만. */
export async function saveCommerceAccount(
  label: string,
  status?: CommerceAccount["status"],
): Promise<{ account: CommerceAccount | null }> {
  const res = await fetch(`${API_BASE}/commerce/account`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, ...(status ? { status } : {}) }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { account: CommerceAccount | null };
}

/**
 * 로그인 세션(storageState) 등록.
 * ⚠️ 이 값은 그 계정의 **전체 권한**이다 — 화면 state 에 담지 말고 읽어서 곧장 보낼 것.
 */
export async function uploadCommerceSession(storageState: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}/commerce/account/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageState }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** 세션 폐기 = 그 계정으로의 발급 중단. 계정 행은 남는다. */
export async function clearCommerceSession(): Promise<void> {
  const res = await fetch(`${API_BASE}/commerce/account/session`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

// ── 네이버 자격증명 (자동 재로그인) ────────────────────────────────────────────
//
// 세션은 만료된다(실측 9일). 만료마다 사람이 브라우저를 여는 대신, 아이디·비번을 한 번
// 저장해 두면 워커가 스스로 세션을 되살린다.
// ⚠️ 값은 서버가 절대 돌려주지 않는다 — 화면이 볼 수 있는 건 있다/없다·검증상태뿐이다.

export interface NaverCredentialState {
  hasCred: boolean;
  /** pending=검증 대기 · verified=로그인 성공 확인 · failed=실패(사유는 error) */
  status: "pending" | "verified" | "failed" | null;
  updatedAt: number | null;
  error: string | null;
  reloginAt: number | null;
  credKeyReady: boolean;
}

export async function fetchNaverCredentialState(accountId: string): Promise<NaverCredentialState> {
  const res = await fetch(`${API_BASE}/naver/accounts/${accountId}/credentials`);
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as NaverCredentialState;
}

/**
 * 아이디·비번 저장 → 서버가 검증 잡을 큐잉한다(워커가 실제로 로그인해 본다).
 * ⚠️ 값을 화면 state 에 남기지 말 것 — 입력 즉시 보내고 폼을 비운다.
 */
export async function saveNaverCredentials(
  accountId: string, id: string, pw: string,
): Promise<{ maskedId: string; status: string; jobId: string }> {
  const res = await fetch(`${API_BASE}/naver/accounts/${accountId}/credentials`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, pw }),
  });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { maskedId: string; status: string; jobId: string };
}

export async function clearNaverCredentials(accountId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/naver/accounts/${accountId}/credentials`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
}

/** 지금 다시 로그인(세션 복구). 저장된 자격증명이 있어야 한다. */
export async function reloginNaverAccount(accountId: string): Promise<{ jobId: string }> {
  const res = await fetch(`${API_BASE}/naver/accounts/${accountId}/relogin`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, await errorMessageOf(res));
  return (await res.json()) as { jobId: string };
}

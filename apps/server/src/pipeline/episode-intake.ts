/**
 * 회차 원본 수용 규칙 (FLOWS F1) — 순수 모듈.
 *
 * index.ts 는 최상위에서 serve() 를 불러 테스트에서 import 할 수 없으므로,
 * 테스트로 고정해야 하는 규칙만 여기로 뗀다(publish-guard.ts · media-origin.ts 와 같은 이유).
 */

export type AnalyzeTrack = "variety" | "drama";

export interface EpisodePipelineState {
  stage: "analyze";
  stageStatus: "idle" | "progress" | "done" | "error" | "warn";
  note: string;
  progress: number;
}

/**
 * 업로드 직후 회차 상태 — **F1 Invariant: 업로드 완료 ≠ 분석 완료.**
 *
 * 예전에는 여기서 곧장 `progress: 30`, `stageStatus: "progress"` 를 박아 뒀다.
 * 워커가 잡을 집기도 전에 "분석 중 30%" 로 보이는 건 거짓말이고, 큐가 밀리면
 * 몇 시간째 30% 인 회차가 생긴다. 진짜 진행률은 워커가 @@PROGRESS 로 올려 준다.
 */
export function initialPipeline(pendingIngestNote?: string): EpisodePipelineState {
  return {
    stage: "analyze",
    stageStatus: "idle",
    note: pendingIngestNote ?? "분석 대기",
    progress: 0,
  };
}

/**
 * 요청 본문에서 회차 번호 뽑기. 숫자로 안 읽히면 undefined —
 * 그 경우 서버가 MAX+1 로 매긴다(F1 은 사람 입력을 필수로 하지만, 유튜브 가져오기처럼
 * 사람이 번호를 못 정하는 경로가 있다).
 */
export function readEpisodeNumber(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** 분석 트랙 — variety|drama 만 유효. 그 외는 undefined(프로그램 기본값 사용). */
export function readTrack(raw: unknown): AnalyzeTrack | undefined {
  return raw === "variety" || raw === "drama" ? raw : undefined;
}

/** YYYY-MM-DD 만 통과. 없거나 형식이 아니면 오늘(F1 "방영일 기본값은 오늘"). */
export function isoDateOrToday(raw: unknown, today: Date = new Date()): string {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

/**
 * 프로그램의 트랙에서 업로드 폼의 기본 트랙을 유추 (F1).
 * **미지정 프로그램은 비워 둔다** — 여기서 짐작하면 잘못된 트랙으로 분석이 돌고,
 * 씬 청크 크기·shot 임계·recommend 팩이 통째로 어긋난다.
 */
export function defaultTrackFor(pipelineGenre: unknown): AnalyzeTrack | "" {
  if (pipelineGenre === "drama") return "drama";
  if (pipelineGenre === "variety") return "variety";
  return "";
}

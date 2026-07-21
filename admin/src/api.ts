import type { LabChannel, LabData, LabMatchData, LabSourceMap } from "./types";

// Same-origin by default: served by apps/server at /lab locally, and proxied by Vercel
// (vercel.json rewrites /api/lab/* → Cloud Run) in production. `?api=` overrides for
// cross-origin dev against a remote server.
export const API = new URLSearchParams(location.search).get("api") || "";

/**
 * Write token for the mapping endpoints. /api/lab/* is publicly reachable and has no auth,
 * so writes carry a shared secret the server holds in LAB_WRITE_TOKEN.
 *
 * Baked in at build time (VITE_LAB_TOKEN) so the operator never types it. Note what this
 * does and doesn't buy: it stops drive-by/automated writes, but anyone who can LOAD this
 * page can read the token out of the bundle — the page itself must be gated by Vercel
 * Deployment Protection for that to matter. localStorage still wins if set, so a build
 * without the env var can be unblocked by hand.
 */
const TOKEN_KEY = "stepd-lab-token";
const BUILT_IN_TOKEN = (import.meta.env.VITE_LAB_TOKEN as string | undefined) ?? "";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || BUILT_IN_TOKEN;
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t.trim());

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function writeInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-lab-token": getToken(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export const fetchLabData = () => req<LabData>("/api/lab/data");

export const fetchMatchChannels = () =>
  req<{ channels: LabChannel[] }>("/api/lab/match/channels").then((r) => r.channels);

export const fetchMatchData = (channelId: string) =>
  req<LabMatchData>(`/api/lab/match/videos/${encodeURIComponent(channelId)}`);

export const saveMatch = (m: {
  shortVideoId: string;
  channelId: string;
  longVideoId: string;
  segStart: number;
  segEnd: number;
  note?: string;
}) => req<{ ok: true; map: LabSourceMap }>("/api/lab/match", writeInit("POST", m));

/** 선택한 숏폼들의 구간을 오디오 정렬로 자동 추적 (워커 잡 큐잉 — 결과는 재조회로 확인). */
export const autoAlign = (m: { channelId: string; longVideoId: string; shortVideoIds: string[] }) =>
  req<{ queued: boolean; alreadyPending: boolean; count: number }>(
    "/api/lab/match/auto",
    writeInit("POST", m),
  );

export interface BulkPreview {
  channelId: string;
  channelName: string;
  longforms: number;
  shorts: number;
  keywordGroups: number;
  plan: { longVideoId: string; longTitle: string; keywordHits: number; shortVideoIds: string[] }[];
}

/** 채널 전체 자동 매칭 계획 미리보기 (큐잉하지 않음). */
export const previewBulk = (channelId: string, limit = 100) =>
  req<BulkPreview>(`/api/lab/match/auto-bulk/preview/${encodeURIComponent(channelId)}?limit=${limit}`);

export const runBulk = (channelId: string, limit = 100) =>
  req<{ ok: true; queued: number; deduped: number; shorts: number; etaMinutes: number }>(
    "/api/lab/match/auto-bulk",
    writeInit("POST", { channelId, limit }),
  );

/** 연동된 모든 채널을 한 번에 (channelIds 생략 시 전체). */
export const runBulkAll = (limitPerChannel = 100) =>
  req<{
    ok: true; channels: number; queued: number; etaMinutes: number;
    results: { channelName: string; queued: number; shorts: number }[];
  }>("/api/lab/match/auto-bulk/all", writeInit("POST", { limitPerChannel }));

export interface MatchStatus {
  jobs: { pending: number; running: number; done: number; failed: number };
  matched: number;
  auto: number;
  confirmed: number;
  described?: number;
}
export const fetchMatchStatus = (channelId: string) =>
  req<MatchStatus>(`/api/lab/match/status/${encodeURIComponent(channelId)}`);

/** 매칭 구간의 자막·장면요약 채우기 (LEARN 입력 완성) 트리거. */
export const runSegment = (channelId: string) =>
  req<{ ok: true; queued: boolean; missing: number; longforms?: number }>(
    "/api/lab/match/segment",
    writeInit("POST", { channelId }),
  );

/** 채널 규칙 학습 트리거 (매칭·설명 데이터 → 고성과 규칙 → 채널 프로파일). */
export const runLearn = (channelId: string) =>
  req<{ ok: true; queued: boolean; alreadyPending: boolean }>(
    "/api/lab/match/learn",
    writeInit("POST", { channelId }),
  );

export interface LearnedProfile {
  ready?: boolean;
  confidence?: number;
  channel?: string;
  winning_patterns?: { pattern: string; why?: string; evidence?: string[] }[];
  avoid_patterns?: string[];
  optimal_length_sec?: { min: number; max: number };
  title_rules?: string[];
  sample?: { high: number; low: number; described: number };
  message?: string;
}
export const fetchLearnedProfile = (channelId: string) =>
  req<{ profile: LearnedProfile | null; at: number | null }>(
    `/api/lab/match/profile/${encodeURIComponent(channelId)}`,
  );

export const deleteMatch = (shortVideoId: string) =>
  req<{ ok: true }>(`/api/lab/match/${encodeURIComponent(shortVideoId)}`, writeInit("DELETE"));

export interface LearnPair {
  pair_id: string;
  short: { videoId: string; title: string | null; publishedAt: string | null; views: number; durationSec: number };
  performance: { baseline_median_views: number; ratio: number; tier: "high" | "mid" | "low" };
  source: {
    longVideoId: string; title: string | null; durationSec: number;
    segStart: number; segEnd: number; segLenSec: number;
    transcript_slice: string | null; scene_summary: string | null;
    emotion: string | null; hook: string | null;
  };
  note: string | null;
}

/** LEARN 입력 미리보기/내보내기 — 매칭된 쌍 + 채널 기준 상대 성과 티어. */
export const fetchMatchExport = (channelId: string) =>
  req<{ channelId: string; channelName: string; count: number; tally: Record<string, number>; pairs: LearnPair[] }>(
    `/api/lab/match/export/${encodeURIComponent(channelId)}`,
  );

export interface OverviewChannel {
  channelId: string;
  channelName: string;
  subscribers: number;
  longs: number;
  shorts: number;
  matched: number;
  auto: number;
  remaining: number;
  jobs: { pending: number; running: number; done: number; failed: number };
}
export const fetchOverview = () =>
  req<{ channels: OverviewChannel[] }>("/api/lab/match/overview").then((r) => r.channels);

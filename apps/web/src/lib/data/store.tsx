"use client";

/**
 * STEP-D — client data store (the single data seam).
 *
 * Two modes behind one identical `useAppData()` surface:
 *  - MOCK (default): in-memory seed + optimistic mutations. Runs with no backend.
 *  - SERVER: when @stepd/server is reachable, initial state loads from /api/state
 *    and mutations hit the API — so real uploaded videos, real trim-encoded clips,
 *    and persistence all work. Falls back to mock if the server is down.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Clip,
  Connections,
  Episode,
  InboxItem,
  JobEvent,
  MediaAsset,
  RenderChannel,
  Program,
  Recommendation,
} from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";
import { type InitialData } from "@/lib/data/repository";
import {
  API_BASE,
  fetchState,
  uploadVideo as apiUploadVideo,
  importYoutubeVideo as apiImportYoutubeVideo,
  createProgram as apiCreateProgram,
  updateProgram as apiUpdateProgram,
  deleteProgram as apiDeleteProgram,
  deleteEpisode as apiDeleteEpisode,
  type UpdateProgramInput,
  type UploadVideoOptions,
  adoptRec,
  exportClip as exportClipApi,
  rejectRec,
  selectRecommendationThumbnail as selectRecommendationThumbnailApi,
  retryDist,
  saveClipEditor as saveClipEditorApi,
  fetchYouTubeChannels,
  fetchMetaAccounts,
  fetchTikTokAccounts,
  fetchNaverAccounts,
} from "@/lib/data/api";
import type { EditorState } from "@/lib/editor/presets";

interface AppState {
  programs: Program[];
  episodes: Episode[];
  recommendations: Recommendation[];
  clips: Clip[];
  jobs: JobEvent[];
  connections: Connections;
}

const NO_CONNECTIONS: Connections = { youtube: false, instagram: false, facebook: false, tiktok: false, naver: false };

/** Empty starting state — screens show nothing/skeleton until /api/state loads, instead
 *  of flashing mock seed data for a moment on every refresh. */
const EMPTY_STATE: AppState = {
  programs: [],
  episodes: [],
  recommendations: [],
  clips: [],
  jobs: [],
  connections: NO_CONNECTIONS,
};

/**
 * 서버 getConnections(db-pg.ts) 는 kv 'connections' 를 읽어
 * {youtube,instagram,facebook,tiktok} 불리언으로 정규화해 보낸다. 그런데 그 kv 에 쓰는
 * 라우트가 서버에 하나도 없어서(빈 시드가 그대로 남는다) 값은 **항상 전부 false** 다 —
 * 실제 연결 여부는 계정 목록으로 판정한다(아래 accountConnections).
 * 여기서는 객체 모양일 때만 받고, 아니면 전부 미연결로 본다.
 */
function toConnections(value: unknown): Connections {
  if (value && typeof value === "object" && !Array.isArray(value) && "youtube" in value) {
    return value as Connections;
  }
  return NO_CONNECTIONS;
}

/**
 * Not every episode the server returns carries a pipeline (a seeded one does not),
 * and every screen dereferences `episode.pipeline.stageStatus` unguarded — one such
 * episode took the whole app down.
 */
function toEpisode(e: Partial<Episode>): Episode {
  return {
    ...e,
    pipeline: e.pipeline ?? { stage: "source", stageStatus: "idle" },
  } as Episode;
}

/** The server omits section/episodeCount/status, which our screens treat as required. */
function toProgram(p: Partial<Program>): Program {
  return {
    ...p,
    id: p.id ?? "",
    title: p.title ?? "(제목 없음)",
    section: p.section ?? "미분류",
    targetAge: p.targetAge ?? 0,
    episodeCount: p.episodeCount ?? 0,
    status: p.status ?? "active",
  } as Program;
}

/**
 * What an export reports back. `capped` is set when the destination preset's maxSec made the
 * deliverable shorter than the segment the operator chose — surfaced, never swallowed.
 */
export interface ExportResult {
  capped: { maxSec: number; requestedSec: number } | null;
  /** 첫 3초 hook 프리롤이 적용됐는지 — export 후 토스트로 편집자에게 알림. */
  hookPreroll?: boolean;
}

interface AppData extends AppState {
  // real-video backend
  media: MediaAsset[];
  apiBase: string;
  serverConnected: boolean;
  /** True until the first /api/state load settles — screens can show a skeleton meanwhile. */
  loading: boolean;
  // derived, live
  inbox: InboxItem[];
  badgeCounts: { inbox: number; recommendations: number; distributionFailed: number };
  // selectors
  getEpisode: (id: string) => Episode | undefined;
  getProgram: (id: string) => Program | undefined;
  recsForEpisode: (episodeId: string) => Recommendation[];
  clipsForEpisode: (episodeId: string) => Clip[];
  mediaForEpisode: (episodeId: string, role?: string) => MediaAsset | undefined;
  // actions
  adoptRecommendation: (id: string) => Promise<string>;
  /**
   * Confirm/export a clip — triggers the single server render (plan §2.4). Draft until here.
   * `channel` applies that destination's render preset (frame + length cap); omit for 원본 유지.
   */
  exportClip: (clipId: string, channel?: RenderChannel) => Promise<ExportResult>;
  /** Persist the editor's decision blob on a clip (metadata only, no render). */
  saveClipEditor: (clipId: string, editorState: EditorState) => Promise<void>;
  /** 실패하면 낙관적 반려를 되돌린 뒤 **reject 한다** — 호출부가 사유를 사용자에게 보일 수 있게. */
  rejectRecommendation: (id: string, reason: string) => Promise<void>;
  selectThumbnail: (recId: string, thumbId: string) => Promise<void>;
  /** 재시도 요청. 실패 시 상태를 failed 로 되돌리고 reject 한다. */
  retryDistribution: (clipId: string, channel: DistributionChannel) => Promise<void>;
  /** Upload a real video → creates an episode + recommendations. Returns episodeId.
   *  `fast=true` → 자막만 · 시각 분석 스킵 (빠른 분석 모드). 기본 false = 정밀 분석. */
  uploadVideo: (file: File, programId: string, opts?: UploadVideoOptions) => Promise<string>;
  /** Queue a YouTube URL import — the worker downloads then analyzes. Returns episodeId. */
  importYoutube: (url: string, programId: string, title?: string, fast?: boolean) => Promise<string>;
  /** Create a program (content root). Returns the new programId. */
  createProgram: (input: {
    title: string;
    section?: string;
    targetAge?: number;
    cast?: string[];
    programCode?: string;
    category?: string;
    weekdays?: number[];
  }) => Promise<string>;
  /** Update a program in place. cast 갱신이 주 용도 — 다음 재분석부터 refine 프롬프트에 반영. */
  updateProgram: (id: string, patch: UpdateProgramInput) => Promise<void>;
  /** 프로그램 하드 삭제 (cascade). 회차·미디어·GCS 파일·추천/클립 모두 정리. */
  deleteProgram: (id: string) => Promise<void>;
  /** 회차 하드 삭제 (cascade). 미디어·GCS 파일·추천/클립 모두 정리. */
  deleteEpisode: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

// 게시(publish) 낙관적 갱신 헬퍼(applyPublish·fireServerPublish·publishToChannel·PublishOpts)는
// 삭제했다(2026-08-11) — 소비처가 0 이다. 현재 배포 다이얼로그(components/publish/publish-dialog.tsx)는
// store 를 거치지 않고 api.publishClips 를 직접 부른 뒤 refresh 로 서버 상태를 다시 읽는다.
// 되살릴 때는 서버 규칙(publish-guard: YouTube 만 실제 업로드 → pending/scheduled,
// Meta·TikTok 은 recorded)을 그대로 반영할 것 — 클립 자체를 published 로 올리면 거짓말이 된다.

const AppDataContext = createContext<AppData | null>(null);

// New-id helper. Runs only on client interaction (post-hydration), so Date.now is safe.
let idCounter = 0;
function newId(prefix: string) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

function deriveInbox(state: AppState): InboxItem[] {
  const items: InboxItem[] = [];

  // Recommendations awaiting review, grouped by episode.
  for (const ep of state.episodes) {
    const pending = state.recommendations.filter(
      (r) => r.episodeId === ep.id && r.status === "pending",
    ).length;
    if (pending > 0 && ep.pipeline.stage === "recommend") {
      items.push({
        id: `inbox-rec-${ep.id}`,
        kind: "recommend-review",
        title: "채택 대기 추천",
        subtitle: `${ep.programTitle} ${ep.episodeNumber}화`,
        episodeId: ep.id,
        count: pending,
        tone: "progress",
      });
    }
  }

  // Failed distributions needing retry.
  for (const clip of state.clips) {
    // 안전장치: 옛/불완전 클립엔 distributions 필드가 없을 수 있음 (seed·mock·마이그레이션 도중).
    const dists = clip.distributions ?? [];
    const failed = dists.filter((d) => d.status === "failed");
    if (failed.length > 0) {
      items.push({
        id: `inbox-failed-${clip.id}`,
        kind: "distribution-failed",
        title: "배포 실패 · 재시도 필요",
        subtitle: `${clip.title} · ${failed.map((f) => f.channel).join(", ")}`,
        episodeId: clip.episodeId,
        count: failed.length,
        tone: "error",
      });
    }
  }

  // Ready clips not yet published anywhere.
  for (const clip of state.clips) {
    const dists = clip.distributions ?? [];
    const anyLive = dists.some(
      (d) => d.status === "published" || d.status === "scheduled",
    );
    if (clip.status === "ready" && !anyLive) {
      items.push({
        id: `inbox-publish-${clip.id}`,
        kind: "publish-pending",
        title: "배포 대기 클립",
        subtitle: clip.title,
        episodeId: clip.episodeId,
        count: 1,
        tone: "idle",
      });
    }
  }

  return items;
}

function deriveBadges(state: AppState, inbox: InboxItem[]) {
  return {
    inbox: inbox.length,
    recommendations: state.recommendations.filter((r) => r.status === "pending").length,
    distributionFailed: state.clips.reduce(
      (n, c) => n + (c.distributions ?? []).filter((d) => d.status === "failed").length,
      0,
    ),
  };
}

export function AppDataProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Seed data. Defaults to the mock; the SERVER mode replaces it on mount. */
  initial?: InitialData;
}) {
  const [state, setState] = useState<AppState>(() => initial ?? EMPTY_STATE);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [serverConnected, setServerConnected] = useState(false);
  // Loading until the first /api/state settles (unless seeded via `initial`). Screens can
  // gate on this instead of rendering the empty state as if the data were really empty.
  const [loading, setLoading] = useState(() => !initial);
  const connectedRef = useRef(false);
  // Bumped by every optimistic mutation. A /api/state poll that started BEFORE a mutation
  // must not clobber the optimistic state with its pre-action snapshot — refresh() captures
  // the epoch before the fetch and skips the wholesale replace if it moved (the next
  // scheduled poll picks up fresh server state).
  const mutationEpochRef = useRef(0);

  const applyServerState = useCallback((s: Awaited<ReturnType<typeof fetchState>>) => {
    // 옛/불완전 clip에 distributions·기타 배열 필드가 없으면 빈 배열로 정규화 —
    // 8+ 컴포넌트가 clip.distributions.map/find/filter를 직접 호출해서 undefined면 크래시.
    // seed·mock·옛 스키마 저장분에서 흔한 문제.
    const clips = (s.clips as Partial<Clip>[]).map((c) => ({
      ...c,
      distributions: c.distributions ?? [],
    } as Clip));
    setState({
      programs: (s.programs as Partial<Program>[]).map(toProgram),
      episodes: (s.episodes as Partial<Episode>[]).map(toEpisode),
      recommendations: s.recommendations as Recommendation[],
      clips,
      jobs: s.jobs as JobEvent[],
      connections: toConnections(s.connections),
    });
    setMedia(s.media as MediaAsset[]);
    connectedRef.current = true;
    setServerConnected(true);
  }, []);

  const refresh = useCallback(async () => {
    const epoch = mutationEpochRef.current;
    try {
      const s = await fetchState();
      if (epoch === mutationEpochRef.current) applyServerState(s);
    } catch {
      connectedRef.current = false;
      setServerConnected(false);
    }
  }, [applyServerState]);

  // Detect a live backend on mount; if present, switch to server state.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchState();
        if (alive) applyServerState(s);
      } catch {
        /* server unreachable — leave the store empty (no mock fallback) */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyServerState]);

  // ── 채널 연결 여부 (배포 준비 체크의 근거) ──────────────────────────────────────
  // /api/state 의 connections 는 kv 'connections' 를 그대로 실어 보내는데, 서버에 그 kv 를
  // 쓰는 라우트가 없어 항상 전부 false 다 — 그걸 그대로 믿으면 "채널 연결" 체크가 영원히
  // 통과하지 못한다. 실제 연결은 계정 목록(YouTube·Meta·TikTok)으로 판정한다.
  // 조회 실패는 false 로 둔다(fail-closed) — 연결됐다고 잘못 말하는 쪽이 더 나쁘다.
  // ⚠️ 현재 이 값을 읽는 화면이 없다(lib/publish/requirements.evaluateChannel 배선 대기).
  const [accountConnections, setAccountConnections] = useState<Connections | null>(null);
  useEffect(() => {
    if (!serverConnected) {
      setAccountConnections(null);
      return;
    }
    let alive = true;
    (async () => {
      const [youtube, meta, tiktok, naver] = await Promise.all([
        fetchYouTubeChannels().catch(() => []),
        fetchMetaAccounts().catch(() => []),
        fetchTikTokAccounts().catch(() => []),
        // 실패해도 "연결 안 됨"으로만 떨어진다 — 여기서 던지면 나머지 연결 상태까지 못 읽는다.
        fetchNaverAccounts().then((r) => r.accounts).catch(() => []),
      ]);
      if (!alive) return;
      setAccountConnections({
        youtube: youtube.some((c) => c.status === "active"),
        instagram: meta.some((a) => a.status === "active" && !!a.igUserId),
        facebook: meta.some((a) => a.status === "active"),
        tiktok: tiktok.some((a) => a.status === "active"),
        // 네이버는 계정이 있는 것만으로는 부족하다 — **로그인 세션이 있어야** 발행이 된다.
        naver: naver.some((a) => a.status !== "disabled" && a.hasSession),
      });
    })();
    return () => {
      alive = false;
    };
  }, [serverConnected]);

  // ── adaptive /api/state polling ────────────────────────────────────────────────
  // The content pipeline runs for minutes on the worker and reports progress via
  // episode.pipeline, but a one-shot mount fetch leaves the dashboard/회차 진행률 frozen
  // until the operator hits F5. Poll on a cadence that reflects what's happening:
  //   · active work in flight (a running job or a stage 'progress')  → fast (8s)
  //   · connected but idle                                           → slow heartbeat (45s)
  //   · disconnected                                                 → reconnect probe (15s)
  // Read the latest state through a ref so the self-scheduling loop never re-subscribes.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const nextDelay = () => {
      if (!connectedRef.current) return 15_000;
      const s = stateRef.current;
      // `분석 대기`(idle + analyze)도 활성으로 친다 — 워커가 잡을 집는 순간을 보려면
      // 그 전부터 폴링이 돌고 있어야 한다. 업로드 직후 회차가 여기 들어오므로
      // 이걸 빼면 "분석 대기"에서 화면이 멈춘 것처럼 보인다.
      const active =
        s.jobs.some((j) => j.status === "running") ||
        s.episodes.some(
          (e) =>
            e.pipeline?.stageStatus === "progress" ||
            (e.pipeline?.stageStatus === "idle" && e.pipeline?.stage === "analyze"),
        );
      return active ? 8_000 : 45_000;
    };
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (alive) timer = setTimeout(tick, nextDelay());
    };
    timer = setTimeout(tick, nextDelay());
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const adoptRecommendation = useCallback(async (id: string): Promise<string> => {
    // SERVER: adopt confirms the segment as a DRAFT clip (metadata only, no render — §2.4).
    // The single render happens later via exportClip().
    if (connectedRef.current) {
      const { clipId, clip } = await adoptRec(id);
      mutationEpochRef.current++;
      setState((prev) => ({
        ...prev,
        recommendations: prev.recommendations.map((r) =>
          r.id === id ? { ...r, status: "adopted", adoptedClipId: clipId } : r,
        ),
        // Already-adopted recs come back with clipId only — never insert an undefined clip.
        clips: clip
          ? [clip as Clip, ...prev.clips.filter((c) => c.id !== clipId)]
          : prev.clips,
      }));
      // No clip in the response: pull the real one from the server.
      if (!clip) void refresh();
      return clipId;
    }

    // MOCK: optimistic clip with a simulated encode→ready.
    const clipId = newId("c");
    setState((prev) => {
      const rec = prev.recommendations.find((r) => r.id === id);
      if (!rec || rec.status !== "pending") return prev;
      const ep = prev.episodes.find((e) => e.id === rec.episodeId);
      const chosen =
        rec.thumbnailCandidates?.find((t) => t.id === rec.selectedThumbnailId) ??
        rec.thumbnailCandidates?.[0];
      const clip: Clip = {
        id: clipId,
        episodeId: rec.episodeId,
        programTitle: ep?.programTitle ?? "",
        title: rec.title,
        clipType: rec.kind === "short" ? "T6" : "TZ",
        targetAge: ep?.targetAge ?? 0,
        aspectRatio: rec.kind === "short" ? "9:16-crop-main" : "16:9",
        durationSec: Math.max(1, rec.endTime - rec.startTime),
        thumbnailLabel: chosen?.label,
        status: "encoding",
        sourceRecommendationId: rec.id,
        distributions: [],
      };
      const jobId = newId("j");
      const job: JobEvent = {
        id: jobId,
        label: `${clip.title} · 인코딩→등록`,
        stage: "encode",
        status: "running",
        progress: 10,
        episodeId: rec.episodeId,
      };
      window.setTimeout(() => {
        setState((s) => ({
          ...s,
          clips: s.clips.map((c) => (c.id === clipId ? { ...c, status: "ready" } : c)),
          jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, status: "done", progress: 100 } : j)),
        }));
      }, 1600);
      return {
        ...prev,
        recommendations: prev.recommendations.map((r) =>
          r.id === id ? { ...r, status: "adopted", adoptedClipId: clipId } : r,
        ),
        clips: [clip, ...prev.clips],
        jobs: [job, ...prev.jobs],
      };
    });
    return clipId;
  }, [refresh]);

  const exportClip = useCallback(async (clipId: string, channel?: RenderChannel): Promise<ExportResult> => {
    // SERVER: the single expensive render (plan §2.4). Server bakes once + caches by
    // revision hash, then returns the rendered (status:"ready") clip. `channel` picks the
    // destination render preset (F3); omitted = 원본 유지 (the clip's own aspect, no cap).
    if (connectedRef.current) {
      const { clip, capped, hookPreroll } = await exportClipApi(clipId, channel);
      mutationEpochRef.current++;
      setState((prev) => ({
        ...prev,
        clips: prev.clips.map((c) => (c.id === clipId ? (clip as Clip) : c)),
      }));
      // Handed back so the caller can tell the operator the deliverable is shorter than the
      // segment they picked — a cap must never pass silently.
      return { capped: capped ?? null, hookPreroll: !!hookPreroll };
    }
    // MOCK: simulate the encode → ready transition so the flow works standalone.
    setState((prev) => ({
      ...prev,
      clips: prev.clips.map((c) => (c.id === clipId ? { ...c, status: "encoding" } : c)),
    }));
    window.setTimeout(() => {
      setState((s) => ({
        ...s,
        clips: s.clips.map((c) =>
          c.id === clipId ? { ...c, status: "ready", rendered: true } : c,
        ),
      }));
    }, 1200);
    return { capped: null };
  }, []);

  const rejectRecommendation = useCallback(async (id: string, reason: string): Promise<void> => {
    mutationEpochRef.current++;
    let prevRec: Recommendation | undefined;
    setState((prev) => {
      prevRec = prev.recommendations.find((r) => r.id === id);
      return {
        ...prev,
        recommendations: prev.recommendations.map((r) =>
          r.id === id ? { ...r, status: "rejected", rejectReason: reason } : r,
        ),
      };
    });
    if (!connectedRef.current) return;
    try {
      await rejectRec(id, reason);
    } catch (error) {
      // Roll back the optimistic reject so the board doesn't lie about server state.
      setState((prev) => ({
        ...prev,
        recommendations: prev.recommendations.map((r) =>
          r.id === id && prevRec ? prevRec : r,
        ),
      }));
      throw error;
    }
  }, []);

  const selectThumbnail = useCallback(async (recId: string, thumbId: string): Promise<void> => {
    mutationEpochRef.current++;
    let previous: Recommendation | undefined;
    setState((prev) => ({
      ...prev,
      recommendations: prev.recommendations.map((r) => {
        if (r.id !== recId) return r;
        previous = r;
        return {
          ...r,
          selectedThumbnailId: thumbId,
          thumbnails: r.thumbnails?.map((thumbnail) => ({ ...thumbnail, chosen: thumbnail.id === thumbId })),
        };
      }),
    }));
    if (!previous || !connectedRef.current) return;
    try {
      await selectRecommendationThumbnailApi(recId, thumbId);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        recommendations: prev.recommendations.map((r) => r.id === recId ? previous! : r),
      }));
      throw error;
    }
  }, []);

  const retryDistribution = useCallback(async (clipId: string, channel: DistributionChannel): Promise<void> => {
    mutationEpochRef.current++;
    // Optimistic: mark ONLY this clip's channel in-flight (pending) — retry queues an
    // upload, it doesn't instantly publish. The /api/state poll reconciles to the real
    // published/failed status. Previously this marked EVERY failed job across all episodes
    // 'done' and hard-set 'published', so the board lied on any server error.
    setState((prev) => {
      const target = prev.clips.find((c) => c.id === clipId);
      return {
        ...prev,
        clips: prev.clips.map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                distributions: (clip.distributions ?? []).map((d) =>
                  d.channel === channel ? { ...d, status: "pending", error: undefined } : d,
                ),
              }
            : clip,
        ),
        // Only the retried clip's own episode jobs move to running — never a blanket sweep.
        jobs: prev.jobs.map((j) =>
          target && j.episodeId === target.episodeId && j.status === "failed"
            ? { ...j, status: "running", needsAction: false }
            : j,
        ),
      };
    });
    if (connectedRef.current) {
      try {
        await retryDist(clipId, channel);
      } catch (error) {
        // Roll back so the board reflects reality instead of a phantom success.
        // 사유는 서버 메시지를 그대로 남긴다 — "재시도 요청 실패"만으론 원인을 알 수 없다.
        const message = error instanceof Error ? error.message : String(error);
        setState((prev) => ({
          ...prev,
          clips: prev.clips.map((clip) =>
            clip.id === clipId
              ? {
                  ...clip,
                  distributions: (clip.distributions ?? []).map((d) =>
                    d.channel === channel ? { ...d, status: "failed", error: message } : d,
                  ),
                }
              : clip,
          ),
        }));
        throw error;
      }
    }
  }, []);

  const uploadVideo = useCallback(
    async (file: File, programId: string, opts: UploadVideoOptions = {}): Promise<string> => {
      if (!connectedRef.current) throw new Error("영상 업로드는 백엔드 서버가 필요합니다 (pnpm dev:server).");
      const res = await apiUploadVideo(file, programId, opts);
      await refresh();
      return res.episode.id;
    },
    [refresh],
  );

  const importYoutube = useCallback(
    async (url: string, programId: string, title?: string, fast?: boolean): Promise<string> => {
      if (!connectedRef.current) throw new Error("YouTube 가져오기는 백엔드 서버가 필요합니다 (pnpm dev:server).");
      const res = await apiImportYoutubeVideo(url, programId, title, fast);
      await refresh();
      return res.episodeId;
    },
    [refresh],
  );

  const createProgram = useCallback(
    async (input: {
      title: string;
      section?: string;
      targetAge?: number;
      cast?: string[];
      programCode?: string;
      category?: string;
      weekdays?: number[];
    }): Promise<string> => {
      if (connectedRef.current) {
        const res = await apiCreateProgram(input);
        await refresh();
        return res.program.id;
      }
      // Mock mode: keep the demo working standalone by adding to local state.
      const id = `p-${Date.now()}`;
      const program: Program = {
        id,
        title: input.title,
        section: input.section ?? "예능",
        targetAge: (input.targetAge ?? 0) as Program["targetAge"],
        cast: input.cast ?? [],
        episodeCount: 0,
        status: "active",
      };
      setState((prev) => ({ ...prev, programs: [program, ...prev.programs] }));
      return id;
    },
    [refresh],
  );

  const updateProgram = useCallback(
    async (id: string, patch: UpdateProgramInput): Promise<void> => {
      if (!connectedRef.current) {
        // Mock mode: patch local state directly.
        mutationEpochRef.current++;
        setState((prev) => ({
          ...prev,
          programs: prev.programs.map((p) => {
            if (p.id !== id) return p;
            const merged: Program = { ...p };
            if (patch.title != null) merged.title = patch.title;
            if (patch.section != null) merged.section = patch.section;
            if (patch.targetAge != null) merged.targetAge = patch.targetAge as Program["targetAge"];
            if (patch.cast != null) merged.cast = patch.cast;
            return merged;
          }),
        }));
        return;
      }
      await apiUpdateProgram(id, patch);
      await refresh();
    },
    [refresh],
  );

  const deleteProgram = useCallback(
    async (id: string): Promise<void> => {
      mutationEpochRef.current++;
      if (connectedRef.current) {
        await apiDeleteProgram(id);
        await refresh();
        return;
      }
      // Mock/offline mode: prune program + its child episodes/recommendations/clips locally.
      setState((prev) => {
        const epIds = new Set(prev.episodes.filter((e) => e.programId === id).map((e) => e.id));
        return {
          ...prev,
          programs: prev.programs.filter((p) => p.id !== id),
          episodes: prev.episodes.filter((e) => e.programId !== id),
          recommendations: prev.recommendations.filter((r) => !epIds.has(r.episodeId)),
          clips: prev.clips.filter((c) => !epIds.has(c.episodeId)),
        };
      });
    },
    [refresh],
  );

  const deleteEpisode = useCallback(
    async (id: string): Promise<void> => {
      mutationEpochRef.current++;
      if (connectedRef.current) {
        await apiDeleteEpisode(id);
        await refresh();
        return;
      }
      setState((prev) => ({
        ...prev,
        episodes: prev.episodes.filter((e) => e.id !== id),
        recommendations: prev.recommendations.filter((r) => r.episodeId !== id),
        clips: prev.clips.filter((c) => c.episodeId !== id),
      }));
    },
    [refresh],
  );

  const saveClipEditor = useCallback(async (clipId: string, editorState: EditorState) => {
    mutationEpochRef.current++;
    // 서버가 master-absolute trim을 받으면 clip.startTime/endTime을 그 트림에 맞춰 옮기고
    // editorState.trim은 세그먼트 상대(0..segLen)로 정규화한다. 로컬 스토어도 같은 규칙으로
    // 동기 반영해두면 저장 직후 UI 다시 그릴 때 서버 응답 없이도 일치한다.
    const normalize = editorState.trimBase === "master"
      ? { startTime: editorState.trimIn, endTime: editorState.trimOut, durationSec: editorState.trimOut - editorState.trimIn }
      : {};
    setState((prev) => ({
      ...prev,
      clips: prev.clips.map((c) => (c.id === clipId ? { ...c, ...normalize, editorState } : c)),
    }));
    if (connectedRef.current) {
      await saveClipEditorApi(clipId, editorState);
    }
  }, []);

  const value = useMemo<AppData>(() => {
    const inbox = deriveInbox(state);
    return {
      ...state,
      // 계정 목록에서 판정한 값이 있으면 그게 진실이다 (state.connections 는 계보 엣지).
      connections: accountConnections ?? state.connections,
      media,
      apiBase: API_BASE,
      serverConnected,
      loading,
      inbox,
      badgeCounts: deriveBadges(state, inbox),
      getEpisode: (id) => state.episodes.find((e) => e.id === id),
      getProgram: (id) => state.programs.find((p) => p.id === id),
      recsForEpisode: (episodeId) => state.recommendations.filter((r) => r.episodeId === episodeId),
      clipsForEpisode: (episodeId) => state.clips.filter((c) => c.episodeId === episodeId),
      mediaForEpisode: (episodeId, role = "master") =>
        media.find((m) => m.episodeId === episodeId && m.role === role),
      adoptRecommendation,
      exportClip,
      saveClipEditor,
      rejectRecommendation,
      selectThumbnail,
      retryDistribution,
      uploadVideo,
      importYoutube,
      createProgram,
      updateProgram,
      deleteProgram,
      deleteEpisode,
      refresh,
    };
  }, [
    state,
    accountConnections,
    media,
    serverConnected,
    loading,
    adoptRecommendation,
    exportClip,
    saveClipEditor,
    rejectRecommendation,
    selectThumbnail,
    retryDistribution,
    uploadVideo,
    importYoutube,
    createProgram,
    updateProgram,
    deleteProgram,
    deleteEpisode,
    refresh,
  ]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within <AppDataProvider>");
  return ctx;
}

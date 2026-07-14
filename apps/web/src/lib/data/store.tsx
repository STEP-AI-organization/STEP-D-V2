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
  MetaPlatform,
  Program,
  Recommendation,
} from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";
import { seedInitialData, type InitialData } from "@/lib/data/repository";
import {
  API_BASE,
  fetchState,
  uploadVideo as apiUploadVideo,
  adoptRec,
  rejectRec,
  publishClips,
  retryDist,
} from "@/lib/data/api";

interface AppState {
  programs: Program[];
  episodes: Episode[];
  recommendations: Recommendation[];
  clips: Clip[];
  jobs: JobEvent[];
  connections: Connections;
}

interface AppData extends AppState {
  // real-video backend
  media: MediaAsset[];
  apiBase: string;
  serverConnected: boolean;
  // derived, live
  inbox: InboxItem[];
  badgeCounts: { inbox: number; recommendations: number; distributionFailed: number };
  // selectors
  getEpisode: (id: string) => Episode | undefined;
  getProgram: (id: string) => Program | undefined;
  getClip: (id: string) => Clip | undefined;
  recsForEpisode: (episodeId: string) => Recommendation[];
  clipsForEpisode: (episodeId: string) => Clip[];
  mediaForEpisode: (episodeId: string, role?: string) => MediaAsset | undefined;
  // actions
  adoptRecommendation: (id: string) => Promise<string>;
  rejectRecommendation: (id: string, reason: string) => void;
  selectThumbnail: (recId: string, thumbId: string) => void;
  publishClip: (clipId: string, channels: DistributionChannel[], opts?: PublishOpts) => void;
  bulkPublish: (clipIds: string[], channels: DistributionChannel[], opts?: PublishOpts) => void;
  /** Publish selected clips to a SINGLE channel independently (Readiness model). */
  publishToChannel: (clipIds: string[], channel: DistributionChannel, opts?: PublishOpts) => void;
  retryDistribution: (clipId: string, channel: DistributionChannel) => void;
  /** Upload a real video → creates an episode + recommendations. Returns episodeId. */
  uploadVideo: (file: File, programId: string, title?: string, onProgress?: (pct: number) => void) => Promise<string>;
  refresh: () => Promise<void>;
}

export interface PublishOpts {
  reserveDate?: string;
  scheduled?: boolean;
  /** Meta target surfaces, persisted onto the distribution state. */
  platforms?: MetaPlatform[];
}

/** Pure: apply a publish to the matching clips' channel states. */
function applyPublish(
  clips: Clip[],
  ids: Set<string>,
  channels: DistributionChannel[],
  opts?: PublishOpts,
): Clip[] {
  return clips.map((clip) => {
    if (!ids.has(clip.id)) return clip;
    const next = clip.distributions.map((d) => ({ ...d }));
    for (const channel of channels) {
      const value = {
        channel,
        status: (opts?.scheduled ? "scheduled" : "published") as "scheduled" | "published",
        reserveDate: opts?.reserveDate,
        error: undefined,
        ...(channel === "meta" && opts?.platforms ? { platforms: opts.platforms } : {}),
      };
      const existing = next.find((d) => d.channel === channel);
      if (existing) Object.assign(existing, value);
      else next.push(value);
    }
    return { ...clip, status: "published" as const, distributions: next };
  });
}

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
    const failed = clip.distributions.filter((d) => d.status === "failed");
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
    const anyLive = clip.distributions.some(
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
      (n, c) => n + c.distributions.filter((d) => d.status === "failed").length,
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
  const [state, setState] = useState<AppState>(() => initial ?? seedInitialData());
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [serverConnected, setServerConnected] = useState(false);
  const connectedRef = useRef(false);

  const applyServerState = useCallback((s: Awaited<ReturnType<typeof fetchState>>) => {
    setState({
      programs: s.programs as Program[],
      episodes: s.episodes as Episode[],
      recommendations: s.recommendations as Recommendation[],
      clips: s.clips as Clip[],
      jobs: s.jobs as JobEvent[],
      connections: s.connections,
    });
    setMedia(s.media as MediaAsset[]);
    connectedRef.current = true;
    setServerConnected(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyServerState(await fetchState());
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
        /* server down — stay on the mock seed */
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyServerState]);

  const adoptRecommendation = useCallback(async (id: string): Promise<string> => {
    // SERVER: the backend trim-encodes a real clip and returns it (with videoUrl).
    if (connectedRef.current) {
      const { clipId, clip } = await adoptRec(id);
      setState((prev) => ({
        ...prev,
        recommendations: prev.recommendations.map((r) =>
          r.id === id ? { ...r, status: "adopted", adoptedClipId: clipId } : r,
        ),
        clips: [clip as Clip, ...prev.clips.filter((c) => c.id !== clipId)],
      }));
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
  }, []);

  const rejectRecommendation = useCallback((id: string, reason: string) => {
    setState((prev) => ({
      ...prev,
      recommendations: prev.recommendations.map((r) =>
        r.id === id ? { ...r, status: "rejected", rejectReason: reason } : r,
      ),
    }));
    if (connectedRef.current) void rejectRec(id, reason).catch(() => {});
  }, []);

  const selectThumbnail = useCallback((recId: string, thumbId: string) => {
    setState((prev) => ({
      ...prev,
      recommendations: prev.recommendations.map((r) =>
        r.id === recId ? { ...r, selectedThumbnailId: thumbId } : r,
      ),
    }));
  }, []);

  const fireServerPublish = useCallback(
    (clipIds: string[], channels: DistributionChannel[], opts?: PublishOpts) => {
      if (!connectedRef.current) return;
      for (const channel of channels) {
        void publishClips(clipIds, channel, {
          reserveDate: opts?.reserveDate,
          scheduled: opts?.scheduled,
          platforms: opts?.platforms,
        }).catch(() => {});
      }
    },
    [],
  );

  const publishClip = useCallback(
    (clipId: string, channels: DistributionChannel[], opts?: PublishOpts) => {
      setState((prev) => ({ ...prev, clips: applyPublish(prev.clips, new Set([clipId]), channels, opts) }));
      fireServerPublish([clipId], channels, opts);
    },
    [fireServerPublish],
  );

  const bulkPublish = useCallback(
    (clipIds: string[], channels: DistributionChannel[], opts?: PublishOpts) => {
      setState((prev) => ({ ...prev, clips: applyPublish(prev.clips, new Set(clipIds), channels, opts) }));
      fireServerPublish(clipIds, channels, opts);
    },
    [fireServerPublish],
  );

  const publishToChannel = useCallback(
    (clipIds: string[], channel: DistributionChannel, opts?: PublishOpts) => {
      setState((prev) => ({ ...prev, clips: applyPublish(prev.clips, new Set(clipIds), [channel], opts) }));
      fireServerPublish(clipIds, [channel], opts);
    },
    [fireServerPublish],
  );

  const retryDistribution = useCallback((clipId: string, channel: DistributionChannel) => {
    setState((prev) => ({
      ...prev,
      clips: prev.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              distributions: clip.distributions.map((d) =>
                d.channel === channel ? { ...d, status: "published", error: undefined } : d,
              ),
            }
          : clip,
      ),
      jobs: prev.jobs.map((j) =>
        j.episodeId && j.status === "failed" ? { ...j, status: "done", needsAction: false } : j,
      ),
    }));
    if (connectedRef.current) void retryDist(clipId, channel).catch(() => {});
  }, []);

  const uploadVideo = useCallback(
    async (file: File, programId: string, title?: string, onProgress?: (pct: number) => void): Promise<string> => {
      if (!connectedRef.current) throw new Error("영상 업로드는 백엔드 서버가 필요합니다 (pnpm dev:server).");
      const res = await apiUploadVideo(file, programId, title, onProgress);
      await refresh();
      return res.episode.id;
    },
    [refresh],
  );

  const value = useMemo<AppData>(() => {
    const inbox = deriveInbox(state);
    return {
      ...state,
      media,
      apiBase: API_BASE,
      serverConnected,
      inbox,
      badgeCounts: deriveBadges(state, inbox),
      getEpisode: (id) => state.episodes.find((e) => e.id === id),
      getProgram: (id) => state.programs.find((p) => p.id === id),
      getClip: (id) => state.clips.find((c) => c.id === id),
      recsForEpisode: (episodeId) => state.recommendations.filter((r) => r.episodeId === episodeId),
      clipsForEpisode: (episodeId) => state.clips.filter((c) => c.episodeId === episodeId),
      mediaForEpisode: (episodeId, role = "master") =>
        media.find((m) => m.episodeId === episodeId && m.role === role),
      adoptRecommendation,
      rejectRecommendation,
      selectThumbnail,
      publishClip,
      bulkPublish,
      publishToChannel,
      retryDistribution,
      uploadVideo,
      refresh,
    };
  }, [
    state,
    media,
    serverConnected,
    adoptRecommendation,
    rejectRecommendation,
    selectThumbnail,
    publishClip,
    bulkPublish,
    publishToChannel,
    retryDistribution,
    uploadVideo,
    refresh,
  ]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within <AppDataProvider>");
  return ctx;
}

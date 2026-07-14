/**
 * STEP-D — data repository (the backend integration seam).
 *
 * The whole app talks to a single `StepDRepository`. Today `mockRepository` serves the
 * in-memory seed; at milestone M6 we swap `activeRepository` to `apiRepository`, which
 * maps each call to the existing STEPD SPFN RPC endpoints (see docs/integration-map.md).
 * Screens and the store never change — only this module.
 */

import type { Clip, Connections, Episode, JobEvent, Program, Recommendation } from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";
import type { PublishOpts } from "@/lib/data/store";
import * as seed from "./mock";

export interface InitialData {
  programs: Program[];
  episodes: Episode[];
  recommendations: Recommendation[];
  clips: Clip[];
  jobs: JobEvent[];
  connections: Connections;
}

/** Deep-ish clone of the seed so the store owns mutable copies. */
export function seedInitialData(): InitialData {
  return {
    programs: seed.programs.map((p) => ({ ...p, smr: p.smr ? { ...p.smr } : undefined })),
    episodes: seed.episodes.map((e) => ({ ...e, pipeline: { ...e.pipeline } })),
    recommendations: seed.recommendations.map((r) => ({ ...r })),
    clips: seed.clips.map((c) => ({ ...c, distributions: c.distributions.map((d) => ({ ...d })) })),
    jobs: seed.jobs.map((j) => ({ ...j })),
    connections: { ...seed.connections },
  };
}

export interface StepDRepository {
  /** Load the initial dataset. Real impl fans out across several RPC list calls. */
  loadInitial(): Promise<InitialData>;
  /** Adopt a recommendation → export+register chain. Returns the created clip id. */
  adopt(recId: string): Promise<{ clipId: string }>;
  reject(recId: string, reason: string): Promise<void>;
  publish(
    clipIds: string[],
    channels: DistributionChannel[],
    opts?: PublishOpts,
  ): Promise<void>;
  retry(clipId: string, channel: DistributionChannel): Promise<void>;
  /** Subscribe to live job progress (SSE). Returns an unsubscribe fn. */
  subscribeJobs(onEvent: (job: JobEvent) => void): () => void;
}

/** In-memory implementation (current). Mutations are handled optimistically in the store,
 *  so the mock's mutation methods are trivial resolves — they exist to satisfy the contract. */
export const mockRepository: StepDRepository = {
  loadInitial: async () => seedInitialData(),
  adopt: async () => ({ clipId: "mock" }),
  reject: async () => {},
  publish: async () => {},
  retry: async () => {},
  subscribeJobs: () => () => {},
};

/**
 * Real backend implementation — STUB. Wire at M6. Each method maps to a documented
 * STEPD SPFN RPC endpoint (docs/integration-map.md). Kept as a throwing stub so the
 * integration surface is explicit and typed.
 */
export const apiRepository: StepDRepository = {
  // GET /source-sets, /programs, /contents, /recommendations, /clips, /distributions …
  loadInitial: notWired("loadInitial"),
  // POST /source-sets/:id/recommend/:recId/adopt → editor.exportClips + register-clip.job
  adopt: notWired("adopt"),
  reject: notWired("reject"),
  // smr-admin.publishClip / youtube.youtubePublish / meta.metaPublish
  publish: notWired("publish"),
  retry: notWired("retry"),
  // SSE over the SPFN event stream (sourceSetChanged / job progress)
  subscribeJobs: () => {
    throw new Error("apiRepository.subscribeJobs: M6에서 SPFN 이벤트 스트림에 연결");
  },
};

/** A stub whose call throws — assignable to any repository method signature. */
function notWired(name: string): () => never {
  return () => {
    throw new Error(`apiRepository.${name}: M6에서 SPFN RPC에 연결 (docs/integration-map.md 참조)`);
  };
}

/** The repository the app uses. Swap to `apiRepository` at M6. */
export const activeRepository: StepDRepository = mockRepository;

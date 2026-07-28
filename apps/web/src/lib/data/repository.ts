/**
 * STEP-D — mock fallback seam.
 *
 * 실서버 연동은 lib/data/api.ts(REST) + store.tsx의 fetchState() 폴백 구조로 이루어진다.
 * 여기 mockRepository는 서버 미연결 시 store가 쓰는 목 시드 소스로만 살아 있다.
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

/** The repository the store uses as the mock fallback (실서버 연동은 api.ts 경유). */
export const activeRepository: StepDRepository = mockRepository;

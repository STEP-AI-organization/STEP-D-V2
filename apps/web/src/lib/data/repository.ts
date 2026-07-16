/**
 * STEP-D — data repository (mock fallback seam).
 *
 * ⚠️ 폐기된 통합 표면: 원래 "M6에서 activeRepository를 apiRepository(STEPD SPFN RPC)로
 * 스왑"하는 계획이었으나 그 경로는 폐기됐다. 실제 서버 연동은 lib/data/api.ts(REST,
 * @stepd/server)와 store.tsx의 fetchState() 폴백 구조로 이미 가동 중이다.
 * mockRepository는 서버 미연결 시 store가 쓰는 목 시드 소스로만 살아 있다.
 * (정리 방향: docs/plans/step-d-master-build-plan.md 죽은 코드 목록 참고)
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
 * Dead stub — 계획했던 SPFN RPC 통합이 폐기되어 어디서도 호출되지 않는다.
 * 실 서버 연동은 lib/data/api.ts(fetchState/adoptRec/publishClips …)를 볼 것.
 */
export const apiRepository: StepDRepository = {
  loadInitial: notWired("loadInitial"),
  adopt: notWired("adopt"),
  reject: notWired("reject"),
  publish: notWired("publish"),
  retry: notWired("retry"),
  subscribeJobs: () => {
    throw new Error("apiRepository.subscribeJobs: 폐기된 스텁 — 실 연동은 lib/data/api.ts");
  },
};

/** A stub whose call throws — assignable to any repository method signature. */
function notWired(name: string): () => never {
  return () => {
    throw new Error(`apiRepository.${name}: 폐기된 SPFN 통합 스텁 — 실 연동은 lib/data/api.ts`);
  };
}

/** The repository the store uses as the mock fallback (실서버 연동은 api.ts 경유). */
export const activeRepository: StepDRepository = mockRepository;

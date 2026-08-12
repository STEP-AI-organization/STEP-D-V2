/**
 * STEP-D — 로컬 더미 시드.
 *
 * 실서버 연동은 lib/data/api.ts(REST) + store.tsx 의 fetchState() 가 전부 담당한다.
 * 여기 남은 건 `app/layout.tsx` 의 LOCAL_DUMMY 분기가 쓰는 시드 하나뿐이다 —
 * 폐기된 SPFN 통합 스텁(StepDRepository/mockRepository/activeRepository)은 제거했다.
 */

import type { Clip, Connections, Episode, JobEvent, Program, Recommendation } from "@/lib/types";
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
    programs: seed.programs.map((p) => ({ ...p })),
    episodes: seed.episodes.map((e) => ({ ...e, pipeline: { ...e.pipeline } })),
    recommendations: seed.recommendations.map((r) => ({ ...r })),
    clips: seed.clips.map((c) => ({ ...c, distributions: c.distributions.map((d) => ({ ...d })) })),
    jobs: seed.jobs.map((j) => ({ ...j })),
    connections: { ...seed.connections },
  };
}

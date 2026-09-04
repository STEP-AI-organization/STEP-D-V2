import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS, type PipelineStage } from "@/lib/constants";
import type { EpisodePipeline } from "@/lib/types";

/**
 * Left→right pipeline stage strip for an episode (plan §7.2), styled after the
 * Review OS prototype: a numbered circle per stage — completed stages show a
 * check, the current stage fills with the brand indigo, later stages stay muted
 * — joined by connector lines that light up once a stage is done. Answers
 * "이 회차 지금 어디까지?" at a glance.
 *
 * **서버가 실제로 기록하는 단계만 그린다.** PIPELINE_STAGES 8개 중 서버 writer 가 쓰는
 * 값은 analyze·recommend 뿐이고(store 폴백이 source), merge·split·edit·encode·publish 는
 * 아무도 쓰지 않는다 — 다 그리면 병합·분할이 저절로 체크되고 배포까지 끝난 회차도
 * 편집·인코딩·배포가 영원히 미완으로 남아 상태를 거짓말한다.
 */
const STRIP_STAGES: PipelineStage[] = PIPELINE_STAGES.filter(
  (s) => s === "source" || s === "analyze" || s === "recommend",
);

/**
 * 스트립에 없는 stage(merge·split·edit·encode·publish)를 가장 가까운 스트립 단계로 접는다.
 * 폴백이 없으면 indexOf 가 -1 이라 모든 단계가 todo(빈 동그라미)로 그려져 진행도 0인 것처럼
 * 거짓말한다 — 서버는 지금 analyze·recommend 만 쓰지만 로컬 더미 시드는 edit/encode/publish 를 쓴다.
 */
function stripIndexOf(stage: PipelineStage): number {
  const idx = STRIP_STAGES.indexOf(stage);
  if (idx >= 0) return idx;
  // 추천 이후 단계는 스트립을 다 지난 것으로, 소스 주변 단계는 소스로 접는다.
  if (stage === "edit" || stage === "encode" || stage === "publish") return STRIP_STAGES.length - 1;
  return 0;
}

export function PipelineStrip({ pipeline }: { pipeline: EpisodePipeline }) {
  const currentIdx = stripIndexOf(pipeline.stage);

  return (
    // Step Progress Bar Container — 원본 캡슐(episodes/e_1293d2f1/page.tsx D:458–474).
    // 원본은 `STEP 3 추천` 이 파랗게 **고정**이라 어느 회차를 열어도 같은 그림이다.
    <div className="h-[38px] bg-slate-200 dark:bg-[var(--color-bg-capsule)] p-1 rounded-full shadow-none border-none inline-flex items-center gap-1 text-xs select-none">
      {STRIP_STAGES.map((stage: PipelineStage, idx) => (
        <div
          key={stage}
          title={idx < currentIdx ? "완료" : idx === currentIdx ? "진행 중" : "대기"}
          className={
            idx === currentIdx
              ? "px-3.5 py-1.5 rounded-full bg-[var(--color-bg-active)] text-white font-bold text-[12px] border-none shadow-none"
              : "px-3.5 py-1.5 rounded-full text-slate-600 dark:text-slate-400 font-medium text-[12px] border-none shadow-none"
          }
        >
          STEP {idx + 1} {PIPELINE_STAGE_LABELS[stage]}
        </div>
      ))}
    </div>
  );
}

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
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

  function stateOf(idx: number): "done" | "current" | "todo" {
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return "current";
    return "todo";
  }

  return (
    <div className="flex items-center overflow-x-auto">
      {STRIP_STAGES.map((stage: PipelineStage, idx) => {
        const state = stateOf(idx);
        return (
          <div key={stage} className="flex flex-none items-center">
            <div className="flex min-w-13 flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex size-6.5 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
                  state === "done" && "border border-status-done/40 bg-status-done/15 text-status-done",
                  state === "current" && "bg-primary text-primary-foreground",
                  state === "todo" && "border border-input bg-card text-muted-foreground/50",
                )}
              >
                {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : idx + 1}
              </div>
              <span
                className={cn(
                  "whitespace-nowrap text-[11px] font-semibold",
                  state === "current"
                    ? "text-brand"
                    : state === "todo"
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground",
                )}
              >
                {PIPELINE_STAGE_LABELS[stage]}
              </span>
            </div>
            {idx < STRIP_STAGES.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "mb-5 h-0.5 w-6 flex-none rounded-full",
                  idx < currentIdx ? "bg-status-done/50" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

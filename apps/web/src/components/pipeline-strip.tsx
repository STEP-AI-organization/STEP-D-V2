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
 */
export function PipelineStrip({ pipeline }: { pipeline: EpisodePipeline }) {
  const currentIdx = PIPELINE_STAGES.indexOf(pipeline.stage);

  function stateOf(idx: number): "done" | "current" | "todo" {
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return "current";
    return "todo";
  }

  return (
    <div className="flex items-center overflow-x-auto">
      {PIPELINE_STAGES.map((stage: PipelineStage, idx) => {
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
            {idx < PIPELINE_STAGES.length - 1 && (
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

"use client";

import { useState } from "react";
import { Bell, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";

/**
 * Global job / alert center (plan §6). Surfaces running / failed / needs-action jobs
 * in one place — directly addresses pain points C1 (pipeline invisibility) & C3 (dead-ends).
 */
export function JobCenter() {
  const [open, setOpen] = useState(false);
  const { jobs, clips, retryDistribution } = useAppData();
  const { toast } = useToast();
  const actionable = jobs.filter((j) => j.status === "failed" || j.needsAction).length;
  const running = jobs.filter((j) => j.status === "running").length;

  function retry(episodeId?: string) {
    if (!episodeId) return;
    let n = 0;
    for (const clip of clips) {
      if (clip.episodeId !== episodeId) continue;
      for (const d of clip.distributions) {
        if (d.status === "failed") {
          retryDistribution(clip.id, d.channel);
          n += 1;
        }
      }
    }
    if (n > 0) toast({ title: "재시도 요청됨", description: `${n}개 채널 재배포를 시작했습니다.`, tone: "progress" });
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="잡 · 알림 센터"
        title="잡 · 알림 센터"
      >
        <Bell />
        {(actionable > 0 || running > 0) && (
          <span
            className={cn(
              "absolute right-1.5 top-1.5 size-2 rounded-full",
              actionable > 0 ? "bg-status-error" : "bg-status-progress",
            )}
          />
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 rounded-lg border border-border bg-popover p-2 shadow-lg">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              진행 중 {running} · 조치 필요 {actionable}
            </div>
            {jobs.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                진행 중이거나 조치가 필요한 작업이 없습니다.
              </div>
            )}
            <ul className="space-y-0.5">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent"
                >
                  <span className="mt-0.5">
                    {job.status === "running" && (
                      <Loader2 className="size-4 animate-spin text-status-progress" />
                    )}
                    {job.status === "done" && (
                      <CheckCircle2 className="size-4 text-status-done" />
                    )}
                    {job.status === "failed" && (
                      <TriangleAlert className="size-4 text-status-error" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{job.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {PIPELINE_STAGE_LABELS[job.stage]}
                      {typeof job.progress === "number" && job.status === "running"
                        ? ` · ${job.progress}%`
                        : ""}
                    </div>
                  </div>
                  {(job.status === "failed" || job.needsAction) && (
                    <Button variant="outline" size="xs" onClick={() => retry(job.episodeId)}>
                      재시도
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

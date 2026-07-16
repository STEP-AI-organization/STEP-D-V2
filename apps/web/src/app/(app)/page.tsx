"use client";

import Link from "next/link";
import { ArrowRight, Sparkles, Send, TriangleAlert, Pencil, Inbox, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { SectionHeading } from "@/components/ui/section-heading";
import { EmptyState } from "@/components/ui/empty-state";
import { PipelineStrip } from "@/components/pipeline-strip";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { PIPELINE_STAGE_LABELS, type StatusTone } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { InboxItem, InboxKind } from "@/lib/types";

const KIND_META: Record<InboxKind, { icon: typeof Sparkles; cta: string; tab: string; tone: StatusTone }> = {
  "recommend-review": { icon: Sparkles, cta: "추천 검토", tab: "recommend", tone: "progress" },
  "edit-pending": { icon: Pencil, cta: "편집 열기", tab: "clips", tone: "progress" },
  "register-pending": { icon: ArrowRight, cta: "등록", tab: "clips", tone: "idle" },
  "publish-pending": { icon: Send, cta: "배포", tab: "distribute", tone: "warn" },
  "distribution-failed": { icon: TriangleAlert, cta: "재시도", tab: "distribute", tone: "error" },
};

const ICON_TONE: Record<StatusTone, string> = {
  idle: "bg-status-idle/10 text-status-idle",
  progress: "bg-status-progress/10 text-status-progress",
  done: "bg-status-done/10 text-status-done",
  warn: "bg-status-warn/10 text-status-warn",
  error: "bg-status-error/10 text-status-error",
};

export default function HomePage() {
  const { inbox, episodes, clips, retryDistribution, loading } = useAppData();
  const { toast } = useToast();
  const inProgress = episodes.filter((e) => e.pipeline.stageStatus === "progress");

  function retryFailed(item: InboxItem) {
    if (!item.episodeId) return;
    let n = 0;
    for (const clip of clips) {
      if (clip.episodeId !== item.episodeId) continue;
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
    <>
      <PageHeader
        title="대시보드"
        description="지금 당신의 액션을 기다리는 작업입니다. 각 항목에서 바로 다음 단계로 진행하세요."
      />

      <section className="mb-8">
        <SectionHeading count={loading ? undefined : inbox.length}>내 액션 필요</SectionHeading>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</div>
        ) : inbox.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="지금 처리할 항목이 없습니다"
            description="새 추천·배포 작업이 도착하면 여기에서 바로 다음 단계로 이어집니다."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {inbox.map((item) => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              const href = item.episodeId ? `/episodes/${item.episodeId}?tab=${meta.tab}` : "#";
              return (
                <Card key={item.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-md",
                          ICON_TONE[meta.tone],
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{item.title}</div>
                        <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                      </div>
                    </div>
                    {typeof item.count === "number" && (
                      <StatusBadge tone={item.tone} pulse={item.tone === "error"}>
                        {item.count}
                      </StatusBadge>
                    )}
                  </div>
                  <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3">
                    <Link
                      href={href}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      {item.kind === "distribution-failed" ? "자세히" : meta.cta}
                      <ArrowRight className="size-3.5" />
                    </Link>
                    {item.kind === "distribution-failed" && (
                      <Button size="xs" variant="outline" className="ml-auto" onClick={() => retryFailed(item)}>
                        재시도
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionHeading count={loading ? undefined : inProgress.length}>진행 중</SectionHeading>
        <div className="space-y-2">
          {inProgress.map((ep) => (
            <Link key={ep.id} href={`/episodes/${ep.id}`} className="block">
              <Card interactive className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    {ep.programTitle} · {ep.episodeNumber}화
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {PIPELINE_STAGE_LABELS[ep.pipeline.stage]}
                    {typeof ep.pipeline.progress === "number" ? ` · ${ep.pipeline.progress}%` : ""}
                    {ep.pipeline.note ? ` · ${ep.pipeline.note}` : ""}
                  </div>
                </div>
                <PipelineStrip pipeline={ep.pipeline} />
              </Card>
            </Link>
          ))}
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
          ) : inProgress.length === 0 ? (
            <EmptyState
              icon={Inbox}
              compact
              title="진행 중인 자동 파이프라인이 없습니다"
            />
          ) : null}
        </div>
      </section>
    </>
  );
}

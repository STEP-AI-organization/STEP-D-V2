"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, FileVideo, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PipelineStrip } from "@/components/pipeline-strip";
import { SourcePanel } from "@/components/source-panel";
import { DerivativesPanel } from "@/components/derivatives-panel";
import { useAppData } from "@/lib/data/store";
import { PIPELINE_STAGE_LABELS, targetAgeLabel } from "@/lib/constants";

/**
 * Episode detail page — Opus Clip-style source-centric layout.
 * 
 * Left (60%): SourcePanel — video player + AI timeline markers + quick stats
 * Right (40%): DerivativesPanel — tabbed view (추천·클립·분석·배포)
 * 
 * This replaces the old flat tab system where source video and its derivatives
 * were on separate tabs. Now the source video stays visible while you scroll
 * through recommendations and clips, just like Opus Clip.
 */
export function EpisodeDetail({
  episodeId,
  initialTab,
}: {
  episodeId: string;
  initialTab?: string;
}) {
  const { getEpisode, loading } = useAppData();
  const episode = getEpisode(episodeId);

  // While the first /api/state load is still settling, a deep-linked or refreshed URL has
  // no episode yet — showing "찾을 수 없음" here would falsely tell the operator the link is
  // dead. Wait for the load to finish before deciding it's truly missing.
  if (!episode && loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> 회차를 불러오는 중…
      </div>
    );
  }

  if (!episode) {
    return (
      <EmptyState
        icon={FileVideo}
        title="회차를 찾을 수 없습니다"
        description="삭제되었거나 잘못된 링크일 수 있습니다."
        action={
          <Link
            href="/programs"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            콘텐츠로 돌아가기
          </Link>
        }
      />
    );
  }

  return (
    <>
      <Link
        href="/programs"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> 콘텐츠
      </Link>

      <PageHeader
        title={
          episode.episodeNumber != null
            ? `${episode.programTitle} · ${episode.episodeNumber}화`
            : episode.programTitle
        }
        description={`방송 ${episode.broadDate} · ${targetAgeLabel(episode.targetAge)}`}
        actions={
          <StatusBadge tone={episode.pipeline.stageStatus}>
            {episode.pipeline.blockedReason ?? PIPELINE_STAGE_LABELS[episode.pipeline.stage]}
          </StatusBadge>
        }
      />

      {/* pipeline hub strip */}
      <Card className="mb-5 p-4">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">파이프라인 진행</div>
        <PipelineStrip pipeline={episode.pipeline} />
        {episode.pipeline.note && (
          <div className="mt-2 text-xs text-muted-foreground">{episode.pipeline.note}</div>
        )}
        {episode.pipeline.blockedReason && (
          <div className="mt-2 text-xs text-status-error">⚠ {episode.pipeline.blockedReason}</div>
        )}
      </Card>

      {/* Opus Clip-style split: source always visible + derivatives */}
      <div className="grid gap-5 lg:grid-cols-5">
        {/* LEFT: Source video player + timeline markers */}
        <div className="lg:col-span-3">
          <SourcePanel episodeId={episodeId} />
        </div>

        {/* RIGHT: Tabbed derivatives panel */}
        <div className="lg:col-span-2">
          <Card className="p-4">
            <div className="mb-3 text-xs font-semibold text-muted-foreground">
              📦 이 원본의 파생 콘텐츠
            </div>
            <DerivativesPanel episodeId={episodeId} initialTab={initialTab} />
          </Card>
        </div>
      </div>
    </>
  );
}
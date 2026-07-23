"use client";

import Link from "next/link";
import { ChevronLeft, FileVideo, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PipelineStrip } from "@/components/pipeline-strip";
import { SourcePanel } from "@/components/source-panel";
import { DerivativesPanel } from "@/components/derivatives-panel";
import { SeekProvider } from "@/components/episode/seek-context";
import { useAppData } from "@/lib/data/store";
import { targetAgeLabel } from "@/lib/constants";

/**
 * Episode detail — 상하 스택 레이아웃.
 * 헤더 우측에 파이프라인 스트립을 붙여 상태배지·별도 파이프라인 카드의 중복을 걷어냈고,
 * 소스 영상은 상단 전폭, 파생 콘텐츠는 하단 탭바로 (파생 카드 껍질 제거).
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

  const title =
    episode.episodeNumber != null
      ? `${episode.programTitle} · ${episode.episodeNumber}화`
      : episode.programTitle;
  const meta = `방송 ${episode.broadDate} · ${targetAgeLabel(episode.targetAge)}`;

  return (
    <>
      <Link
        href="/programs"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> 콘텐츠
      </Link>

      {/* 헤더 + 파이프라인 스트립 한 줄. 폭이 좁아지면 자연스럽게 아래로 wrap. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-page-title">{title}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {meta}
            {episode.pipeline.note && (
              <span className="text-muted-foreground/70"> · {episode.pipeline.note}</span>
            )}
          </p>
        </div>
        <div className="shrink-0">
          <PipelineStrip pipeline={episode.pipeline} />
        </div>
      </div>

      {episode.pipeline.blockedReason && (
        <div className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          ⚠ {episode.pipeline.blockedReason}
        </div>
      )}

      {/* SeekProvider — 상단 원본 플레이어와 하단 파생 카드(쇼츠·씬·자막·narrative)를 잇는 배선.
          카드 썸네일/시간칩 클릭 → 상단 <video>가 그 순간 seek+재생. 검증 흐름의 척추. */}
      <SeekProvider>
        <div className="space-y-6">
          <SourcePanel episodeId={episodeId} />
          <DerivativesPanel episodeId={episodeId} initialTab={initialTab} />
        </div>
      </SeekProvider>
    </>
  );
}
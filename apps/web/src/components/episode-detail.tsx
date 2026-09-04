"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, FileVideo, Loader2, Trash2 } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { PipelineStrip } from "@/components/pipeline-strip";
import { SourcePanel } from "@/components/source-panel";
import { DerivativesPanel } from "@/components/derivatives-panel";
import { SeekProvider } from "@/components/episode/seek-context";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import { targetAgeLabel } from "@/lib/constants";

/**
 * 회차 상세 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/episodes/e_1293d2f1/page.tsx` 1,805줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 * 원본은 한 파일에 다 그리지만 우리는 조각이 나뉘어 있다 — 이 파일은 머리말(뒤로가기 ·
 * 제목/부제 · STEP 캡슐 · 회차 삭제)까지고, 아래 둘이 이어 받는다:
 *   `SourcePanel`      원본 플레이어 · 메타 바 · AI 타임라인 · 3분할 개수
 *   `DerivativesPanel` 탭바(추천·클립·분석·배포)와 그 내용
 *
 * ## 원본이 목이라 되살린 것
 *  - **`회차 삭제` 에 onClick 이 없다.** 그대로 배선하면 회차·미디어·추천·클립·GCS 파일이
 *    한 번에 지워진다 — confirm 을 그대로 지킨다.
 *  - STEP 진행이 `STEP 3 추천` 고정이다 → 실제 `episode.pipeline.stage` 로 그린다.
 *  - 제목 `리센느 · 4화`·`방송 2026-08-21`·`쇼츠 추천 N건` 이 전부 리터럴이다.
 *  - 뒤로가기가 `/analyze` 로 간다 — 이 화면은 프로그램에서 들어오는 자리라 `/programs` 로.
 *  - `blockedReason`(왜 안 도는지) 배너가 원본에 없다.
 *
 * SeekProvider 는 상단 원본 플레이어와 하단 파생 카드(쇼츠·씬·자막·narrative)를 잇는 배선이다.
 * 카드 썸네일/시간칩을 누르면 상단 `<video>` 가 그 순간으로 seek+재생한다 — 검증 흐름의 척추.
 */
export function EpisodeDetail({
  episodeId,
  initialTab,
}: {
  episodeId: string;
  initialTab?: string;
}) {
  const { getEpisode, deleteEpisode, recommendations, loading } = useAppData();
  const { toast } = useToast();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const episode = getEpisode(episodeId);

  async function runDelete() {
    if (!episode) return;
    const label = episode.episodeNumber != null ? `${episode.programTitle} · ${episode.episodeNumber}화` : episode.programTitle;
    if (!confirm(`"${label}"과 관련 미디어·추천·클립·GCS 파일을 완전히 삭제합니다. 되돌릴 수 없습니다.`)) return;
    setDeleting(true);
    try {
      await deleteEpisode(episodeId);
      toast({ title: "회차 삭제됨", description: label, tone: "done" });
      router.push("/programs");
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setDeleting(false);
    }
  }

  // While the first /api/state load is still settling, a deep-linked or refreshed URL has
  // no episode yet — showing "찾을 수 없음" here would falsely tell the operator the link is
  // dead. Wait for the load to finish before deciding it's truly missing.
  if (!episode) {
    return (
      <>
        <Header title="회차" subtitle="원본 · 추천 구간 · 파이프라인 진행" />
        <main className="flex-1 p-5 overflow-y-auto flex flex-col justify-between">
          <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-2xl p-8 text-center max-w-[560px]">
            {loading ? (
              <p className="inline-flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" /> 회차를 불러오는 중…
              </p>
            ) : (
              <>
                <FileVideo className="w-10 h-10 mx-auto text-[var(--color-text-muted)]" />
                <h2 className="mt-3 font-bold text-base text-[var(--color-text-primary)]">회차를 찾을 수 없습니다</h2>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  삭제되었거나 잘못된 링크일 수 있습니다.{" "}
                  <Link href="/programs" className="underline text-[var(--color-bg-active)]">
                    콘텐츠로 돌아가기
                  </Link>
                </p>
              </>
            )}
          </div>
          <Footer />
        </main>
      </>
    );
  }

  const title =
    episode.episodeNumber != null
      ? `${episode.programTitle} · ${episode.episodeNumber}화`
      : episode.programTitle;
  const recCount = recommendations.filter((r) => r.episodeId === episodeId).length;

  return (
    <>
      <Header title="회차" subtitle="원본 · 추천 구간 · 파이프라인 진행" />

      {/* Scrollable Episode Content Body */}
      <main className="flex-1 p-5 overflow-y-auto space-y-6">
        {/* Top Navigation & Episode Header (STEP D Tone & Manner) */}
        <div className="space-y-3">
          {/* Back Link — 원본은 /analyze 로 간다. 이 화면은 프로그램에서 들어오는 자리다. */}
          <Link
            href="/programs"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors font-medium"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>콘텐츠</span>
          </Link>

          {/* Main Header Row: Title & Sub-info (Left) | STEP Progress & Delete Button (Right) */}
          <div className="flex items-center justify-between gap-6 flex-wrap">
            <div className="space-y-1 min-w-0">
              <h1 className="text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">
                {title}
              </h1>
              <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-2 font-medium flex-wrap">
                <span>방송 {episode.broadDate || "미등록"}</span>
                <span>·</span>
                <span>{targetAgeLabel(episode.targetAge)}</span>
                {recCount > 0 && (
                  <>
                    <span>·</span>
                    <span className="text-[var(--color-bg-active)] font-bold">쇼츠 추천 {recCount}건</span>
                  </>
                )}
                {/* 왜 지금 이 단계인지 — 서버가 적어 준 메모. 원본엔 자리가 없다. */}
                {episode.pipeline.note && (
                  <>
                    <span>·</span>
                    <span>{episode.pipeline.note}</span>
                  </>
                )}
              </div>
            </div>

            {/* Pipeline Step Progress Bar & Action (Pill Capsule Shape, Matching Height h-[38px]) */}
            <div className="flex items-center gap-3 shrink-0">
              <PipelineStrip pipeline={episode.pipeline} />

              {/* 회차 삭제 Button (Pill Capsule Shape, Matching Height h-[38px]) */}
              <button
                type="button"
                onClick={runDelete}
                disabled={deleting}
                title="이 회차 완전 삭제 (미디어·추천·클립·GCS 파일 포함)"
                className="h-[38px] px-4 rounded-full border border-rose-200 dark:border-rose-900/40 text-rose-600 dark:text-rose-400 bg-white dark:bg-[var(--color-bg-card)] hover:bg-rose-50 dark:hover:bg-rose-950/30 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-xs shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5 text-rose-500 stroke-[2.2]" />
                )}
                <span>{deleting ? "삭제 중…" : "회차 삭제"}</span>
              </button>
            </div>
          </div>
        </div>

        {/* 왜 안 도는지 — 원본에 없는 자리다. 조용히 멈춰 있으면 고장으로 읽힌다. */}
        {episode.pipeline.blockedReason && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-medium text-rose-600 dark:text-rose-400">
            ⚠ {episode.pipeline.blockedReason}
          </div>
        )}

        <SeekProvider>
          <SourcePanel episodeId={episodeId} />
          <DerivativesPanel episodeId={episodeId} initialTab={initialTab} />
        </SeekProvider>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

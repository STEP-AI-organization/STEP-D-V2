"use client";

import Link from "next/link";
import { ChevronRight, Film, LayoutGrid, Trash2, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PipelineStrip } from "@/components/pipeline-strip";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import { PIPELINE_STAGE_LABELS, targetAgeLabel } from "@/lib/constants";
import { programSmrChecks } from "@/lib/publish/requirements";
import { UploadVideoButton } from "@/components/upload-video-dialog";
import { NewProgramButton } from "@/components/new-program-dialog";
import { EditProgramButton, EditProgramDialogMount } from "@/components/edit-program-dialog";
import { useState } from "react";
import type { Program, Episode, Recommendation, Clip } from "@/lib/types";
import { Sparkles, Clapperboard } from "lucide-react";

/** Poster face — a genre emoji, falling back to the title's first character. */
const SECTION_EMOJI: Record<string, string> = {
  예능: "🎬",
  "드라마/영화": "🎭",
  뮤직: "🎵",
  시사: "📰",
  교양: "📚",
  라이프: "🌿",
  스포츠: "⚽",
  게임: "🎮",
  어린이: "🧸",
  뉴스: "📡",
  애니: "✨",
};

export default function ProgramsPage() {
  const { programs, episodes, recommendations, clips, loading } = useAppData();

  return (
    <>
      <PageHeader
        eyebrow="프로그램 → 회차"
        title="콘텐츠"
        description="프로그램 → 회차. 각 회차의 파이프라인 진행 상태를 한눈에 보고, 클릭해 진행 허브로 이동합니다."
        actions={
          <>
            <UploadVideoButton />
            <NewProgramButton />
          </>
        }
      />

      {loading && programs.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : programs.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="아직 프로그램이 없습니다"
          description="프로그램을 먼저 만든 뒤 영상을 업로드하면 회차와 추천이 생성됩니다."
          action={<NewProgramButton />}
        />
      ) : (
        <div className="space-y-5">
          {programs.map((program) => (
            <ProgramCard
              key={program.id}
              program={program}
              eps={episodes.filter((e) => e.programId === program.id)}
              recs={recommendations}
              clips={clips}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProgramCard({ program, eps, recs, clips }: { program: Program; eps: Episode[]; recs: Recommendation[]; clips: Clip[] }) {
  const face = SECTION_EMOJI[program.section] ?? program.title.trim().charAt(0) ?? "🎞️";

  return (
    <Card className="overflow-hidden">
      {/* ── header ── */}
      <div className="flex items-start gap-4 p-4">
        <div className="flex aspect-3/4 w-14 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-primary/20 to-primary/5 text-2xl ring-1 ring-inset ring-border">
          {face}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{program.title}</h2>
            <Badge variant="muted">{program.section}</Badge>
            <Badge variant="muted">{targetAgeLabel(program.targetAge)}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>회차 {eps.length}</span>
            {program.cast && program.cast.length > 0 && (
              <span>
                출연 {program.cast.slice(0, 3).join(", ")}
                {program.cast.length > 3 ? " 외" : ""}
              </span>
            )}
          </div>
          <div className="mt-2">
            <SmrFeedReadiness program={program} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            href={`/programs/${program.id}/highlights`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-semibold text-secondary-foreground hover:border-foreground/25 hover:text-foreground"
          >
            <Sparkles className="size-3.5" /> 하이라이트
          </Link>
          <EditProgramButton program={program} />
          <UploadVideoButton programId={program.id} />
          <DeleteProgramButton program={program} episodeCount={eps.length} />
        </div>
      </div>

      {/* ── episodes / empty ── */}
      <div className="border-t border-border bg-muted/20 p-3">
        {eps.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Film className="size-5" />
            </span>
            <div className="text-sm font-medium">아직 회차가 없어요</div>
            <p className="max-w-xs text-xs text-muted-foreground">
              영상을 업로드하면 첫 회차와 추천 구간이 자동으로 생성됩니다.
            </p>
            <div className="mt-1">
              <UploadVideoButton programId={program.id} variant="default" />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {eps.map((ep) => {
              // Pending only — matches the sidebar badge (store badgeCounts), the inbox
              // "채택 대기 추천" count, and the episode detail 추천 tab. A processed
              // recommendation is no longer something to act on.
              const epPendingRecs = recs.filter(
                (r) => r.episodeId === ep.id && r.status === "pending",
              );
              const epClips = clips.filter((c) => c.episodeId === ep.id);
              return (
              <div key={ep.id} className="relative">
                <Link href={`/episodes/${ep.id}`} className="block">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 pr-11 transition-colors hover:bg-accent/40">
                  <div className="min-w-40">
                    <div className="text-sm font-semibold">{ep.episodeNumber}화</div>
                    <div className="text-xs text-muted-foreground">방송 {ep.broadDate}</div>
                  </div>
                  <PipelineStrip pipeline={ep.pipeline} />
                  <div className="flex items-center gap-2">
                    {epPendingRecs.length > 0 && (
                      <div
                        title="채택 대기 추천"
                        className="flex items-center gap-0.5 rounded-full bg-status-warn/10 px-2 py-0.5 text-[11px] font-medium text-status-warn"
                      >
                        <Sparkles className="size-3" /> {epPendingRecs.length}
                      </div>
                    )}
                    {epClips.length > 0 && (
                      <div
                        title="클립"
                        className="flex items-center gap-0.5 rounded-full bg-status-done/10 px-2 py-0.5 text-[11px] font-medium text-status-done"
                      >
                        <Clapperboard className="size-3" /> {epClips.length}
                      </div>
                    )}
                    <StatusBadge tone={ep.pipeline.stageStatus}>
                      {ep.pipeline.blockedReason ?? PIPELINE_STAGE_LABELS[ep.pipeline.stage]}
                    </StatusBadge>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </div>
              </Link>
                <DeleteEpisodeButton episode={ep} />
              </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Program card delete button — 삭제 성공 시 store가 알아서 목록에서 빼준다. */
function DeleteProgramButton({ program, episodeCount }: { program: Program; episodeCount: number }) {
  const { deleteProgram } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    const msg =
      episodeCount > 0
        ? `프로그램 "${program.title}"과 회차 ${episodeCount}개(미디어·추천·클립·GCS 파일 전부)를 완전히 삭제합니다. 되돌릴 수 없습니다.`
        : `프로그램 "${program.title}"을 완전히 삭제합니다. 되돌릴 수 없습니다.`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await deleteProgram(program.id);
      toast({ title: "프로그램 삭제됨", description: program.title, tone: "done" });
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={run}
      disabled={busy}
      title="이 프로그램과 회차 전부 완전 삭제"
      className="text-status-error hover:bg-status-error/10"
    >
      {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
    </Button>
  );
}

/** Episode row delete — Link 위에 절대 위치. e.stopPropagation 대신 button을 Link 밖으로 뺐다. */
function DeleteEpisodeButton({ episode }: { episode: Episode }) {
  const { deleteEpisode } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    const label = episode.episodeNumber != null ? `${episode.episodeNumber}화` : "이 회차";
    if (!confirm(`${label}과 관련 미디어·추천·클립·GCS 파일을 완전히 삭제합니다. 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    try {
      await deleteEpisode(episode.id);
      toast({ title: "회차 삭제됨", description: label, tone: "done" });
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title="이 회차 완전 삭제"
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-status-error opacity-70 hover:bg-status-error/10 hover:opacity-100 disabled:opacity-40"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
    </button>
  );
}

/** Program-level SMR feed readiness — the "프로그램 준비" step split out of per-clip publish.
 *  미충족일 땐 pill 자체가 편집 다이얼로그 진입점(SMR 섹션으로 스크롤). */
function SmrFeedReadiness({ program }: { program: Program }) {
  const checks = programSmrChecks(program);
  const missing = checks.filter((c) => !c.met);
  if (missing.length === 0) {
    return <StatusBadge tone="done">SMR 피드 준비 완료</StatusBadge>;
  }
  return (
    <SmrUnmetLink program={program} missingLabels={missing.map((m) => m.label)} count={missing.length} />
  );
}

function SmrUnmetLink({
  program,
  missingLabels,
  count,
}: {
  program: Program;
  missingLabels: string[];
  count: number;
}) {
  // SmrFeedReadiness는 서버-사이드 렌더 대비 훅 사용을 피해야 해서 별도 클라이언트 컴포넌트로 분리.
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`미충족: ${missingLabels.join(", ")} · 클릭해 편집`}
        className="inline-flex items-center gap-1 rounded-full border border-status-warn/25 bg-status-warn/10 px-2 py-0.5 text-xs font-medium text-status-warn transition hover:border-status-warn/50 hover:bg-status-warn/15"
      >
        <span className="relative flex size-1.5 items-center justify-center" aria-hidden>
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
        <span>SMR 피드 {count}개 미충족 · 편집</span>
      </button>
      {open && <EditProgramDialogMount program={program} scrollTo="smr" onClose={() => setOpen(false)} />}
    </>
  );
}

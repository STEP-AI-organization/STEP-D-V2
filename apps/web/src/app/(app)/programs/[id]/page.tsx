"use client";

/**
 * U3 · 프로그램 홈 (README §3 · FLOWS F10).
 *
 * 상태마다 다른 화면이다 — 방영 중은 진행 중인 회차로 들어가는 곳,
 * 종영은 아카이브를 뒤지는 곳, 편성 예정은 아직 아무것도 없다고 말해 주는 곳.
 * 셋을 한 화면에 뭉뚱그리면 "왜 할 일이 없지"에서 막힌다.
 *
 * 프로그램 정보 편집(포스터·출연자 사진·썸네일 스타일)은 /programs/:id/settings 로
 * 옮겼다. 홈은 읽는 화면이다.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowRight, CheckCircle2, ChevronRight, FileVideo, ListVideo, Settings, Share2, Trash2, Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";

import { UploadVideoButton } from "@/components/upload-video-dialog";
import { useToast } from "@/components/ui/toast";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";
import { clipThumbSrc, mediaThumbSrc, programImageUrl } from "@/lib/media-url";
import { useAppData } from "@/lib/data/store";
import {
  PROGRAM_STATUS_LABEL,
  normalizeProgramStatus,
  rightsWindowOf,
} from "@/lib/programs";
import type { Clip, Episode, Program, ProgramStatus } from "@/lib/types";

const TRACK_LABEL: Record<string, string> = { variety: "예능 트랙", drama: "드라마 트랙" };

export default function ProgramHomePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { programs, episodes, clips, media, loading, deleteProgram } = useAppData();
  const router = useRouter();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const program = programs.find((p) => p.id === id);

  const eps = useMemo(
    () =>
      episodes
        .filter((e) => e.programId === id)
        .slice()
        .sort((a, b) => b.episodeNumber - a.episodeNumber),
    [episodes, id],
  );
  const epIds = useMemo(() => new Set(eps.map((e) => e.id)), [eps]);
  const programClips = useMemo(
    () => clips.filter((c) => epIds.has(c.episodeId)),
    [clips, epIds],
  );

  if (!program) {
    return (
      <>
        <Header title="프로그램" subtitle="편성·상태별 프로그램 목록" />
        <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-3">
          <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 space-y-2 max-w-[640px]">
            <h2 className="font-bold text-base text-[var(--color-text-primary)]">
              {loading ? "프로그램을 불러오는 중입니다…" : "프로그램을 찾을 수 없습니다"}
            </h2>
            {!loading && (
              <p className="text-xs text-[var(--color-text-muted)]">
                삭제됐거나 주소가 잘못됐습니다.{" "}
                <Link href="/programs" className="underline text-[var(--color-bg-active)]">
                  프로그램 목록으로
                </Link>
              </p>
            )}
          </div>
          <Footer />
        </main>
      </>
    );
  }

  const status = normalizeProgramStatus(program.status);
  const today = new Date();
  const rights = rightsWindowOf(program, today);
  const published = programClips.filter((c) =>
    (c.distributions ?? []).some((d) => d.status === "published"),
  ).length;

  // 되돌릴 수 없는 작업이라 confirm 한 번으로 끝내지 않는다 — 회차가 있으면 무엇이 함께
  // 지워지는지(미디어·추천·클립·GCS 파일) 먼저 알리고, 프로그램명을 그대로 입력해야 실행된다.
  async function runDelete() {
    if (!program) return;
    const epCount = Math.max(program.episodeCount, eps.length);
    const scope =
      epCount > 0
        ? `회차 ${epCount}개와 그에 딸린 미디어·추천·클립·GCS 파일이 전부 함께 삭제됩니다.`
        : "이 프로그램에는 등록된 회차가 없습니다.";
    if (!confirm(`프로그램 "${program.title}"을 삭제합니다.\n\n${scope}\n\n되돌릴 수 없습니다. 계속할까요?`)) return;
    const typed = prompt(`확인을 위해 프로그램 이름을 그대로 입력하세요:\n\n${program.title}`);
    if (typed === null) return;
    if (typed.trim() !== program.title.trim()) {
      toast({ title: "삭제 취소됨", description: "입력한 이름이 프로그램 이름과 다릅니다", tone: "warn" });
      return;
    }
    setDeleting(true);
    try {
      await deleteProgram(program.id);
      toast({ title: "프로그램 삭제됨", description: program.title, tone: "done" });
      router.push("/programs");
    } catch (err) {
      toast({
        title: "삭제 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setDeleting(false);
    }
  }

  return (
    <>
      <Header title="프로그램" subtitle="편성·상태별 프로그램 목록" />

      {/* Program Detail View Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-3">
        <div className="space-y-3 flex-1">
          {/* Back to programs list breadcrumb */}
          <Link
            href="/programs"
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors inline-block"
          >
            &larr; 프로그램 목록으로 돌아가기
          </Link>

          {/* Program Detail Header Banner */}
          <div className="bg-transparent border-none shadow-none flex items-start justify-between p-0 py-3 mb-3">
            <div className="flex items-center gap-4">
              {/* Round Program Logo Avatar — 원본은 늘 "프로그램/로고" 글자다. 포스터가 있으면 그걸 쓴다. */}
              <div className="w-[86px] h-[86px] rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center text-center p-2 text-xs text-slate-400 font-semibold shrink-0 overflow-hidden">
                {program.hasPosterImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={programImageUrl(program.id, "poster")} alt="" className="w-full h-full object-cover" />
                ) : (
                  <>프로그램<br />로고</>
                )}
              </div>

              {/* Title and Metadata badges */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-[24px] font-bold text-[var(--color-text-primary)] leading-tight">
                    {program.title}
                  </h2>
                </div>

                <div className="text-xs text-[var(--color-text-muted)]">
                  {scheduleLine(program, status) || "편성 정보가 등록되지 않았습니다."}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap text-xs">
                  {/* 원본은 초록 `방영 중` + 체크 고정이다 — 체크는 방영 중일 때만 붙인다. */}
                  {status === "airing" ? (
                    <span className={`${PILL} gap-1.5 bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400 font-bold`}>
                      <CheckCircle2 className="w-3 h-3 shrink-0" />
                      <span>{PROGRAM_STATUS_LABEL[status]}</span>
                    </span>
                  ) : (
                    <span className={`${PILL} ${PILL_GRAY}`}>{PROGRAM_STATUS_LABEL[status]}</span>
                  )}
                  <span className={`${PILL} ${PILL_GRAY}`}>{program.section}</span>
                  <span className={`${PILL} ${PILL_GRAY}`}>
                    {program.pipelineGenre ? TRACK_LABEL[program.pipelineGenre] : "분석 트랙 미지정"}
                  </span>
                  <span className={`${PILL} ${PILL_GRAY}`}>출연자 {program.cast?.length ?? 0}명 등록</span>
                  <span className={`${PILL} ${PILL_GRAY}`}>담당 {program.owner?.trim() || "미지정"}</span>
                  {/* 권리 만료 경고(F3) — 원본 태그 줄엔 자리가 없다. flex-wrap 이라 줄바꿈은 안전하고,
                      임박은 원본이 삭제 버튼에서 쓰는 rose 톤을 쓴다(새 색 아님). */}
                  {rights && (
                    <span className={`${PILL} ${rights.expiring ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold" : PILL_GRAY}`}>
                      {rights.text}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Header Right Action Buttons */}
            <div className="flex items-start gap-2 shrink-0">
              <Link
                href={`/programs/${program.id}/settings`}
                className="h-10 pl-3 pr-4 rounded-xl bg-white dark:bg-[#1E2028] border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
              >
                <Settings className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300 stroke-[2.2]" />
                <span>프로그램 설정</span>
              </Link>
              {/* ⚠️ 원본 삭제 버튼엔 onClick 이 없다. 그대로 배선하면 클릭 한 번에 회차·미디어·
                  추천·클립·GCS 파일이 cascade 로 지워진다 — 2단 확인을 그대로 지킨다. */}
              <button
                type="button"
                onClick={runDelete}
                disabled={deleting}
                title="이 프로그램과 하위 회차·클립을 완전히 삭제 (되돌릴 수 없음)"
                className="h-10 pl-3 pr-4 rounded-xl bg-white dark:bg-[#1E2028] border border-rose-200 dark:border-rose-900/40 text-rose-600 dark:text-rose-400 font-semibold text-xs hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors shadow-xs cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-500 stroke-[2.2]" />
                <span>{deleting ? "삭제 중…" : "프로그램 삭제"}</span>
              </button>
            </div>
          </div>

          {/* 3 Summary Cards Grid — 편성 예정은 숫자가 없다. 0 세 개는 "고장"으로 읽힌다. */}
          {status !== "upcoming" && (
            <div className="grid grid-cols-3 gap-4">
              <SummaryCard icon={ListVideo} label="회차" value={Math.max(program.episodeCount, eps.length)} />
              <SummaryCard icon={FileVideo} label="미디어" value={programClips.length} />
              <SummaryCard icon={Share2} label="배포됨" value={published} />
            </div>
          )}

          {/* Status Banner Section — 원본은 초록 `진행 중` 하나뿐이다. 상태 셋이 하는 말이 다르다. */}
          {status === "airing" && <AiringBar episodes={eps} />}
          {status === "ended" && <EndedBar program={program} rightsText={rights?.text} expiring={rights?.expiring} />}
          {status === "upcoming" && <UpcomingEmpty programId={program.id} />}

          {/* Section 1: 회차 Section Card */}
          {status !== "upcoming" && (
            <div className={SECTION}>
              <div className="h-10 flex items-center justify-between">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">회차</h3>
                <div className="flex items-center gap-2">
                  {/* 원본은 `/analyze` 로만 간다 — 프로그램이 안 걸린 채 열린다. */}
                  <Link href={`/analyze?program=${program.id}`} className={SECTION_BTN}>
                    <span>전체 보기</span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  </Link>
                  {/* 원본 모달엔 `<input type="file">` 이 없다 — 버튼 픽셀만 원본, 모달은 우리 것. */}
                  <UploadVideoButton
                    programId={program.id}
                    className="h-10 pl-4 pr-5 rounded-full bg-[var(--color-bg-active)] text-white text-xs font-bold hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    label={
                      <>
                        <Upload className="w-3.5 h-3.5" />
                        <span>회차 영상 업로드</span>
                      </>
                    }
                  />
                </div>
              </div>

              {eps.length > 0 ? (
                /* Responsive Grid: Max 5 per row for Episodes */
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {/* 원본은 slice 없이 전부 그린다(목 4개라서) — 실데이터는 수십 개다. 5열×2행. */}
                  {eps.slice(0, 10).map((e) => (
                    <EpisodeCard
                      key={e.id}
                      episode={e}
                      thumbMediaId={media.find((m) => m.episodeId === e.id && m.role === "master")?.id}
                    />
                  ))}
                </div>
              ) : (
                <EmptyRow>아직 회차 원본이 없습니다 — &lsquo;회차 영상 업로드&rsquo;로 시작하세요</EmptyRow>
              )}
            </div>
          )}

          {/* Section 2: 미디어 Section Card */}
          {status !== "upcoming" && (
            <div className={SECTION}>
              <div className="h-10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h3 className="font-bold text-base text-[var(--color-text-primary)]">미디어</h3>
                  <span className="text-xs text-[var(--color-text-muted)]">추천 구간에서 채택한 것만 여기 올라옵니다</span>
                </div>
                <Link href="/media" className={SECTION_BTN}>
                  <span>미디어에서 보기</span>
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                </Link>
              </div>

              {programClips.length > 0 ? (
                /* Responsive Grid: Max 6 per row, Max 2 rows (12 items total) */
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {programClips.slice(0, 12).map((c) => (
                    <MediaCard key={c.id} clip={c} />
                  ))}
                </div>
              ) : (
                <EmptyRow>
                  {eps.length === 0
                    ? "회차 원본이 올라가면 분석 후 추천 구간이 생깁니다"
                    : "채택한 구간이 아직 없습니다 — 영상 분석에서 구간을 채택하면 여기 나타납니다"}
                </EmptyRow>
              )}
            </div>
          )}

          {/* Section 3: 출연자 Section Card */}
          <div className={SECTION}>
            <div className="h-10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">출연자</h3>
                <span className="text-xs text-[var(--color-text-muted)]">사람이 등록한 명단이 기준입니다 — 자동 인식은 참고용 표시만 합니다</span>
              </div>
              <Link
                href={`/programs/${program.id}/settings`}
                className="h-10 px-4 rounded-xl bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs font-bold text-[var(--color-text-primary)] transition-colors border-none cursor-pointer flex items-center justify-center gap-1"
              >
                <span>출연자 관리</span>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              </Link>
            </div>

            {/* Cast State inside Section Card */}
            {(program.cast?.length ?? 0) > 0 ? (
              <div className="flex items-center gap-6 pt-2 pb-1 flex-wrap">
                {program.cast!.map((name) => (
                  <div key={name} className="flex flex-col items-center gap-2 group">
                    <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-slate-200 dark:border-slate-700 shadow-sm group-hover:scale-105 transition-transform duration-200 bg-slate-800 flex items-center justify-center">
                      {program.castPhotos?.[name] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={program.castPhotos[name]} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-slate-400">사진 없음</span>
                      )}
                    </div>
                    <span className="text-xs font-bold text-[var(--color-text-primary)] group-hover:text-[#1C60FF] transition-colors">
                      {name}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="w-full h-20 flex items-center justify-center text-xs text-[var(--color-text-muted)] text-center bg-transparent border-none shadow-none">
                등록된 출연자가 없습니다. 프로그램 설정에서 등록하세요.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

// ── 조각들 ───────────────────────────────────────────────────────────────────────

/** 원본 태그 알약 (D:105·110·…). 초록은 방영 중 전용이라 회색을 기본으로 뺀다. */
const PILL = "h-6 px-3 rounded-full text-[11px] font-semibold inline-flex items-center justify-center border-none";
const PILL_GRAY = "bg-slate-100 text-slate-700 dark:bg-[#282B35] dark:text-slate-200";
/** 원본 섹션 카드 (D:232). */
const SECTION = "bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 space-y-4";
/** 원본 섹션 버튼 (D:239). */
const SECTION_BTN = "h-10 px-4 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs font-bold text-[var(--color-text-primary)] transition-colors border-none cursor-pointer flex items-center justify-center gap-1";
/** 원본 카드 (D:229·288). */
const TILE = "bg-[var(--color-bg-card)] border-2 border-transparent hover:border-[#1C60FF] rounded-2xl overflow-hidden flex flex-col group cursor-pointer hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200";
/** 원본 상태 배너 (D:193). */
const BANNER = "bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-3.5 flex items-center justify-between gap-3 flex-wrap text-xs mb-6";

/** 원본 지표 카드 3장 (D:139–187). */
function SummaryCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-3 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between">
      <div className="w-8 h-8 rounded-lg flex items-center justify-start">
        <Icon className="w-6 h-6 text-[#222222] dark:text-slate-200 stroke-[1.75]" />
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-tight">{label}</h4>
          <span className="text-3xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{value}</span>
        </div>
      </div>
    </div>
  );
}

/** 섹션 안 빈 상태 — 원본 출연자 빈 줄(D:356)과 같은 그릇. */
function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full h-20 flex items-center justify-center text-xs text-[var(--color-text-muted)] text-center bg-transparent border-none shadow-none">
      {children}
    </div>
  );
}

/**
 * 방영 중 — 지금 분석이 도는 회차로 바로 들어가는 줄.
 * ⚠️ 진행률은 서버가 준 값 그대로다. 클라이언트 타이머로 채우지 않는다(F2 ⊘).
 * 원본 배너(D:193–202)는 진행률도 링크도 없이 "진행 중" 만 말한다.
 */
function AiringBar({ episodes }: { episodes: Episode[] }) {
  const running = episodes.find((e) => e.pipeline?.stageStatus === "progress");
  const target = running ?? episodes[0];

  if (!target) {
    return (
      <div className={BANNER}>
        <div className="flex items-center gap-2">
          <span className={`${PILL} gap-1.5 bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400 font-bold`}>
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            <span>진행 중</span>
          </span>
          <span className="font-bold text-[var(--color-text-primary)]">아직 올라온 회차가 없습니다.</span>
        </div>
      </div>
    );
  }

  const pct = running ? Math.min(97, Math.round(running.pipeline?.progress ?? 0)) : null;

  return (
    <div className={BANNER}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`${PILL} gap-1.5 bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400 font-bold`}>
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          <span>진행 중</span>
        </span>
        <span className="font-bold text-[var(--color-text-primary)]">
          회차 {target.episodeNumber}
          {running
            ? ` - ${PIPELINE_STAGE_LABELS[running.pipeline.stage]} 중`
            : " - 대기 중인 작업 없음"}
        </span>
        {running?.pipeline.note && (
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{running.pipeline.note}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {pct !== null && (
          <>
            <span className="h-1.5 w-[130px] rounded-full bg-[var(--color-bg-input)] overflow-hidden">
              <span className="block h-full rounded-full bg-[var(--color-bg-active)]" style={{ width: `${Math.max(2, pct)}%` }} />
            </span>
            <span className="font-mono text-[11px] text-[var(--color-text-muted)] w-[34px] text-right">{pct}%</span>
          </>
        )}
        <Link href={`/episodes/${target.id}`} className={SECTION_BTN}>
          회차 열기
        </Link>
      </div>
    </div>
  );
}

/**
 * 종영 — 새 회차가 안 들어온다. 아카이브 재활용이 유일한 경로다.
 * 검색으로 찾은 구간에서 클립을 만드는 건 막지 않는다(2026-08-10 확정).
 */
function EndedBar({
  program,
  rightsText,
  expiring,
}: {
  program: Program;
  rightsText?: string;
  expiring?: boolean;
}) {
  return (
    <div className={BANNER}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`${PILL} ${PILL_GRAY}`}>종영</span>
        <span className="font-bold text-[var(--color-text-primary)]">
          {program.endedDate ? `${program.endedDate} 종영 — ` : ""}
          새 회차가 들어오지 않습니다. 기존 회차 재활용과 권리 만료일만 관리합니다.
        </span>
        {rightsText && (
          <span className={`${PILL} ${expiring ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold" : PILL_GRAY}`}>
            {rightsText}
          </span>
        )}
      </div>
      {/* 검색 화면은 쿼리스트링을 읽지 않는다 — ?program= 을 붙이면 걸린 것처럼 보이지만
          실제로는 '전 프로그램'으로 뜬다. 파라미터를 읽게 되면 그때 다시 붙인다. */}
      <Link href="/search" className={`${SECTION_BTN} shrink-0`} title="검색 화면에서 프로그램을 직접 선택하세요">
        아카이브에서 장면 찾기
      </Link>
    </div>
  );
}

/** 편성 예정 — 첫 방송 전. 회차도 지표도 없는 게 정상이라고 말해 준다. */
function UpcomingEmpty({ programId }: { programId: string }) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-10 flex flex-col items-center gap-2.5 mb-6">
      <div className="w-11 h-11 rounded-full bg-[var(--color-bg-input)]" />
      <div className="font-bold text-sm text-[var(--color-text-primary)]">첫 방송 전 · 분석할 회차가 없습니다</div>
      <p className="max-w-[440px] text-center text-xs leading-relaxed text-[var(--color-text-muted)]">
        파일럿이나 선공개 영상이 있다면 지금 올려 두면 됩니다. 업로드는 분석 대기열에 들어갑니다.
      </p>
      <div className="flex gap-2 pt-1">
        <Link href="/programs" className={SECTION_BTN}>
          프로그램 목록으로
        </Link>
        <UploadVideoButton
          programId={programId}
          className="h-10 pl-4 pr-5 rounded-full bg-[var(--color-bg-active)] text-white text-xs font-bold hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          label={
            <>
              <Upload className="w-3.5 h-3.5" />
              <span>파일럿 영상 업로드</span>
            </>
          }
        />
      </div>
    </div>
  );
}

/** 원본 회차 카드 (D:229–264). 원본은 배지가 전부 `추천` 고정이라 실패를 구분 못 한다. */
function EpisodeCard({ episode, thumbMediaId }: { episode: Episode; thumbMediaId?: string }) {
  const thumb = mediaThumbSrc(thumbMediaId);
  const p = episode.pipeline;
  const tone =
    p?.stageStatus === "error"
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
      : p?.stageStatus === "progress"
        ? "bg-[#1C60FF]/10 text-[#1C60FF] dark:text-[#60A5FA]"
        : "bg-slate-100 text-slate-700 dark:bg-[#282B35] dark:text-slate-200";

  return (
    <Link href={`/episodes/${episode.id}`} className={TILE}>
      {/* 16:9 Video Thumbnail - Top Filled */}
      <div className="w-full aspect-video bg-slate-900 relative overflow-hidden shrink-0">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        )}
      </div>

      {/* Content Section */}
      <div className="p-3 flex flex-col justify-between flex-1 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-1.5">
            <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">회차 {episode.episodeNumber}</h4>
            <span className={`h-5 px-2 rounded-full text-[10.5px] font-semibold inline-flex items-center justify-center border-none shrink-0 ${tone}`}>
              {stageLabel(episode)}
            </span>
          </div>
          <div className="text-xs text-[var(--color-text-muted)] font-medium">
            {episode.broadDate || "방영일 미등록"}
          </div>
        </div>

        {/* Bottom Right Arrow */}
        <div className="flex justify-end pt-1">
          <div className="w-6 h-6 rounded-full bg-[var(--color-bg-input)] flex items-center justify-center text-[var(--color-text-muted)] group-hover:text-[#1C60FF] group-hover:bg-[#1C60FF]/10 transition-colors shrink-0">
            <ArrowRight className="w-3.5 h-3.5" />
          </div>
        </div>
      </div>
    </Link>
  );
}

function stageLabel(e: Episode): string {
  const p = e.pipeline;
  if (!p) return "분석 대기";
  const label = PIPELINE_STAGE_LABELS[p.stage] ?? p.stage;
  if (p.stageStatus === "progress") return `${label} 중`;
  if (p.stageStatus === "error") return `${label} 실패`;
  if (p.stageStatus === "idle") return "분석 대기";
  return label;
}

/** 원본 미디어 카드 (D:286–318). 원본은 `<div>` 라 어디로도 못 간다 — 에디터로 보낸다. */
function MediaCard({ clip }: { clip: Clip }) {
  const shortForm = clip.aspectRatio?.startsWith("9:16");
  const thumb = clipThumbSrc(clip);
  return (
    <Link href={`/editor/${clip.id}`} className={TILE}>
      {/* 16:9 Video Thumbnail - Top Filled */}
      <div className="w-full aspect-video bg-slate-900 relative overflow-hidden shrink-0">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        )}
      </div>

      {/* Content Section */}
      <div className="p-3 space-y-2 text-xs flex-1 flex flex-col justify-between">
        <h4 className="font-bold text-xs text-[var(--color-text-primary)] line-clamp-2 leading-tight min-h-[2rem]">
          {clip.title}
        </h4>
        {/* Individual Tags */}
        <div className="flex items-center gap-1 flex-wrap pt-0.5">
          {[shortForm ? "숏폼" : "클립", `${Math.round(clip.durationSec)}초`].map((tag) => (
            <span
              key={tag}
              className="h-5 px-2 rounded-full text-[10.5px] font-semibold inline-flex items-center justify-center border-none bg-slate-100 text-slate-700 dark:bg-[#282B35] dark:text-slate-200"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

/** 헤더 아래 편성 한 줄 — 상태에 따라 쓸모 있는 정보가 다르다. */
function scheduleLine(program: Program, status: ProgramStatus): string {
  const parts: string[] = [];
  if (status === "ended" && program.endedDate) parts.push(`${program.endedDate} 종영`);
  else if (status === "upcoming" && program.firstAiredDate) {
    parts.push(`${program.firstAiredDate} 첫 방송 예정`);
  } else if (program.schedule) parts.push(program.schedule);

  if (program.broadcaster) parts.push(program.broadcaster);
  if (status === "airing" && program.currentInfo) parts.push(program.currentInfo);
  return parts.join(" · ");
}

"use client";

/**
 * 영상 분석 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/analyze/page.tsx` 734줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * 회차 원본 → 추천 구간 → (사람이 채택) → 미디어. 지키는 규칙:
 *  - 회차 상태는 `분석 대기` → `분석 중` → `분석 완료`. 업로드했다고 분석된 게 아니다.
 *  - 진행률은 **클라이언트에서 97%를 넘기지 않는다.** 100%는 서버 완료 신호로만(F2-2 ⊘).
 *  - 종영 프로그램은 채택 단계가 없다(F2-5). 아카이브 검색으로 간다.
 *  - 채택한 것만 미디어가 된다. 안 누른 구간은 여기 남아 있는다.
 *
 * ## 좌측 회차 클릭이 제자리 선택으로 돌아왔다
 * 예전 이 화면은 회차를 누르면 `/episodes/:id` 로 **이탈**했다("회차별 중간 화면은 없앤다").
 * 디자이너 화면은 좌측에서 고르고 오른쪽에서 보는 구조라, 이탈시키면 선택 하이라이트도
 * 우측 패널도 의미가 없어진다. 제자리 선택으로 되돌리고, 회차 상세로 가는 길은
 * **원본에도 있는 `회차 상세` 버튼**이 맡는다. `?program=&episode=` URL 상태는 유지 —
 * 링크 공유·뒤로가기가 원본 `useState` 로는 안 된다.
 *
 * ## 원본이 목이라 사라질 뻔한 것들 (전부 되살렸다)
 *  - **`보류`·`채택` 버튼에 핸들러가 없다**(373·376). 낙관적 갱신·롤백·토스트를 붙였다.
 *  - **시각 범위가 버튼이 아니다**(324). 누르면 위 플레이어가 그 지점부터 재생한다 —
 *    운영자가 구간을 확인하는 유일한 수단이다.
 *  - **빈 상태를 프로그램 이름으로 판정**한다(`selectedProgram === '리모와 멜로'`, 204·236).
 *  - **배지가 초록 `분석 완료` 고정**(269). 실제로는 5상태고, 특히 `warn`(크레딧 부족으로
 *    잡을 아예 안 넣은 상태)이 완료로 보이면 안 된다.
 *  - **메트릭 23/22/1 · 부제 `미결정 22 · 채택 1` 이 리터럴**이다.
 *  - **`회차 상세` href 가 하드코딩**(275)이다.
 *  - `업로드 시작` 은 모달만 닫는다(721) → 우리 `UploadDialog` 를 그대로 띄운다(버튼 픽셀은
 *    원본 클래스·아이콘 그대로). 모달 마크업 이식은 진입점 3곳 동시 전환 별건이다.
 *
 * ## 자막 오버레이(257–259)
 * 원본은 문자열 리터럴이다. 진짜 자막은 분석 JSON 안에 있는데 **회차 전체**(58.6분 기준
 * 자막 925개)라 프로덕션에선 `/api/proxy` 를 타고 Vercel FOT 로 과금된다. 그래서
 * **재생을 시작한 뒤에만** 공유 폴러를 붙이고, 현재 시각에 걸리는 자막이 있을 때만 그린다.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { UploadVideoButton } from "@/components/upload-video-dialog";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import { ApiError, getStreamUrl, reanalyzeMedia } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { useMediaAnalysisPoll } from "@/lib/data/use-media-analysis";
import { normalizeProgramStatus } from "@/lib/programs";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";
import type { Episode, Recommendation } from "@/lib/types";
import { fmtTime } from "@/lib/utils";

/** 원본 회차 리스트·빈 상태 카드 (203). */
const LIST_CARD = "bg-white dark:bg-[#1C1E24] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-3 space-y-1";
/** 원본 우측 빈 상태 카드 (237). */
const EMPTY_CARD = "p-4 rounded-xl border-none bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none text-xs text-[var(--color-text-muted)]";
/** 원본 회색 pill (329). */
const PILL = "px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-stone-800 text-slate-600 dark:text-slate-300 font-semibold text-[11px] border-none";
/** 원본 보조 버튼 (276·367·373). */
const BTN = "h-8 px-4 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-xs font-medium transition-colors inline-flex items-center justify-center cursor-pointer";

export default function AnalyzePage() {
  return (
    <Suspense
      fallback={
        <>
          <Header title="영상 분석" subtitle="회차 원본 → 추천 구간 → 미디어 생성" />
          <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-4">
            <div className={EMPTY_CARD}>불러오는 중…</div>
            <Footer />
          </main>
        </>
      }
    >
      <AnalyzeInner />
    </Suspense>
  );
}

function AnalyzeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { programs, episodes, recommendations, clips, loading } = useAppData();

  const programId = params.get("program") ?? programs[0]?.id ?? "";
  const program = programs.find((p) => p.id === programId);

  const eps = useMemo(
    () =>
      episodes
        .filter((e) => e.programId === programId)
        .slice()
        .sort((a, b) => b.episodeNumber - a.episodeNumber),
    [episodes, programId],
  );

  const episodeId = params.get("episode") ?? eps[0]?.id ?? "";
  const episode = eps.find((e) => e.id === episodeId);

  const recs = useMemo(
    () =>
      recommendations
        .filter((r) => r.episodeId === episodeId)
        .slice()
        .sort((a, b) => a.startTime - b.startTime),
    [recommendations, episodeId],
  );

  const go = (next: { program?: string; episode?: string }) => {
    const p = next.program ?? programId;
    const e = next.program ? "" : (next.episode ?? episodeId);
    router.replace(`/analyze?program=${p}${e ? `&episode=${e}` : ""}`);
  };

  const ended = program ? normalizeProgramStatus(program.status) === "ended" : false;

  // 원본 셀렉트는 옵션이 이름 문자열이라 동명 프로그램을 구분 못 한다 — value 는 id 로 간다.
  const programOptions = useMemo(
    () =>
      programs.length === 0
        ? [{ value: "", label: loading ? "불러오는 중…" : "프로그램 없음" }]
        : programs.map((p) => ({ value: p.id, label: p.title })),
    [programs, loading],
  );

  return (
    <>
      <Header title="영상 분석" subtitle="회차 원본 → 추천 구간 → 미디어 생성" />

      {/* Video Analysis Layout (2 Column Split) */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-4">
        <div className="space-y-4 flex-1">
          {/* Top Workspace Split */}
          <div className="grid grid-cols-12 gap-4">
            {/* Left Column: Program Select -> Upload Button -> Episode List Section Card */}
            <div className="col-span-3 space-y-3">
              {/* 1. Program Select Dropdown with CustomSelect (Equal Height h-10, Floating Shadow) */}
              <CustomSelect
                options={programOptions}
                value={programId}
                onChange={(v) => go({ program: v })}
                ariaLabel="프로그램 선택"
                triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] font-bold border-none rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
              />

              {/* 2. 회차 영상 업로드 Button with Upload Icon (Equal Height h-10, No Border, Soft Shadow) */}
              <UploadVideoButton
                programId={programId}
                className="w-full h-10 rounded-full bg-[var(--color-bg-active)] text-white font-semibold text-xs hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                label={
                  <>
                    <Upload className="w-4 h-4" />
                    <span>회차 영상 업로드</span>
                  </>
                }
              />

              {/* 3. Single White Section Card for Episode List */}
              <div className={LIST_CARD}>
                {eps.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--color-text-muted)] py-6">
                    {loading ? "불러오는 중…" : "회차가 없습니다"}
                  </div>
                ) : (
                  eps.map((ep) => {
                    const isSelected = ep.id === episodeId;
                    return (
                      <div
                        key={ep.id}
                        onClick={() => go({ episode: ep.id })}
                        className={`p-2.5 rounded-lg transition-all cursor-pointer text-xs ${
                          isSelected
                            ? "bg-[#1C60FF]/10 text-[#1C60FF] font-bold"
                            : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-input)] hover:text-[var(--color-text-primary)] font-medium"
                        }`}
                      >
                        <h4 className={`text-xs mb-0.5 ${isSelected ? "font-bold text-[#1C60FF]" : "font-bold text-[var(--color-text-primary)]"}`}>
                          회차 {ep.episodeNumber}
                        </h4>
                        <div className="text-[10px] opacity-80">
                          {stageLabel(ep)} · {ep.broadDate || "방영일 미등록"}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Column: Video Player Container & Controls OR Empty State Box */}
            <div className="col-span-9 space-y-4">
              {!episode ? (
                <div className={EMPTY_CARD}>
                  {loading
                    ? "불러오는 중…"
                    : "왼쪽에서 회차를 고르세요. 회차가 없으면 원본을 먼저 올려야 합니다."}
                </div>
              ) : (
                <EpisodeAnalysis
                  key={episode.id}
                  episode={episode}
                  recs={recs}
                  clipCount={clips.filter((c) => c.episodeId === episode.id).length}
                  ended={ended}
                />
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

function stageLabel(e: Episode): string {
  const p = e.pipeline;
  if (!p) return "분석 대기";
  const label = PIPELINE_STAGE_LABELS[p.stage] ?? p.stage;
  if (p.stageStatus === "progress") return `${label} 중`;
  if (p.stageStatus === "error") return `${label} 실패`;
  if (p.stageStatus === "idle") return "분석 대기";
  // warn = 서버가 잡을 아예 큐잉하지 않은 상태(크레딧 부족 등). "완료"로 떨어지면 안 된다.
  if (p.stageStatus === "warn") return "분석 보류";
  return "분석 완료";
}

/** 원본 배지는 초록 하나뿐이다(269–272). 구조는 그대로 두고 색만 상태별로 나눈다. */
const BADGE_TONE = {
  done: { pill: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400", dot: "bg-emerald-600 dark:bg-emerald-400" },
  run: { pill: "bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400", dot: "bg-blue-600 dark:bg-blue-400" },
  warn: { pill: "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400", dot: "bg-amber-600 dark:bg-amber-400" },
  error: { pill: "bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400", dot: "bg-rose-600 dark:bg-rose-400" },
  idle: { pill: "bg-slate-200/80 text-slate-700 dark:bg-[#282B35] dark:text-slate-300", dot: "bg-slate-500 dark:bg-slate-400" },
} as const;

function EpisodeAnalysis({
  episode,
  recs,
  clipCount,
  ended,
}: {
  episode: Episode;
  recs: Recommendation[];
  clipCount: number;
  ended: boolean;
}) {
  const { mediaForEpisode, refresh } = useAppData();
  const { toast } = useToast();
  const master = mediaForEpisode(episode.id, "master");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string>();
  const [videoError, setVideoError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // 재생 URL 은 서버가 준다 — 프로덕션은 짧은 수명의 GCS 서명 URL 이라
  // <video> 가 스토리지에서 바로 받는다(바이트가 서버를 안 거친다).
  useEffect(() => {
    setVideoSrc(undefined);
    setVideoError(null);
    if (!master) return;
    let alive = true;
    getStreamUrl(master.id)
      .then((u) => { if (alive) setVideoSrc(u); })
      // 못 불러오면 조용히 빈 화면을 두지 않는다 — 왜 안 나오는지 적는다.
      .catch((err) => { if (alive) setVideoError(`원본을 불러오지 못했습니다 (${err instanceof Error ? err.message : String(err)})`); });
    return () => { alive = false; };
  }, [master?.id, master]);

  // 자막은 **재생을 시작한 뒤에만** 받는다 — 분석 JSON 전체라 무겁다(위 주석 참조).
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(0);
  const { analysis } = useMediaAnalysisPoll(started ? master?.id : undefined);
  const caption = useMemo(() => {
    const segs = analysis?.data?.transcript;
    if (!segs?.length) return null;
    const hit = segs.find((s) => now >= s.start && now < (s.end ?? s.start + 4));
    return hit?.text?.trim() || null;
  }, [analysis, now]);

  /** 구간 클릭 → 그 지점으로 이동하고 재생. 검증 흐름의 척추다. */
  const seekTo = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, sec);
    void v.play().catch(() => {});
    v.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const analyzing = episode.pipeline?.stageStatus === "progress";
  const waiting = episode.pipeline?.stageStatus === "idle";
  // 서버가 분석 잡을 넣지 않은 상태(크레딧 부족 등) — 진행 중도 완료도 아니다.
  const blocked = episode.pipeline?.stageStatus === "warn";
  const failed = episode.pipeline?.stageStatus === "error";
  const tone = failed ? "error" : blocked ? "warn" : analyzing ? "run" : waiting ? "idle" : "done";

  /**
   * 다시 시도 — 보류(크레딧 부족 등)·실패에서 빠져나오는 유일한 출구.
   *
   * note 는 **거절당한 시점의 스냅샷**이라 충전해도 저절로 안 바뀐다. 문구는 "충전 후 다시
   * 시도하세요" 라고 하는데 정작 시도할 버튼이 없었다(2026-08-19 사용자 지적) — 사용자가 할
   * 일을 알려주고도 그 일을 할 수단을 안 준 상태였다. 서버는 잡을 큐잉만 하면 되므로
   * 재분석 요청이 곧 재시도다. ⚠️ 재분석은 크레딧을 쓴다(체크포인트 재개라 대개 저렴하다).
   */
  const retry = useCallback(async () => {
    if (!master || retrying) return;
    setRetrying(true);
    try {
      const r = await reanalyzeMedia(master.id);
      toast({
        title: r.queued ? "분석을 다시 걸었습니다" : "이미 대기 중입니다",
        description: r.queued ? "잠시 후 진행률이 올라갑니다." : "앞선 요청이 아직 큐에 있어 그대로 둡니다.",
        tone: "done",
      });
      await refresh();
    } catch (err) {
      // 402(크레딧 부족)면 서버가 부족분을 문장으로 준다 — 그대로 보여준다(다시 추리하게 두지 않는다).
      toast({
        title: err instanceof ApiError && err.status === 402 ? "아직 크레딧이 모자랍니다" : "다시 시도하지 못했습니다",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setRetrying(false);
    }
  }, [master, retrying, toast, refresh]);

  // F2-2 ⊘ — 클라이언트는 97%를 넘기지 않는다. 100%는 서버가 완료를 알릴 때만.
  const pct = Math.min(97, Math.round(episode.pipeline?.progress ?? 0));

  const undecided = recs.filter((r) => r.status === "pending").length;
  const adopted = recs.filter((r) => r.status === "adopted").length;

  return (
    <>
      {/* 1. HTML5 Video Player Container */}
      {/* 상자를 원본 비율에 맞추고 높이만 묶는다 — 고정 높이 + w-full 이면 넓은 화면에서
          양옆에 검은 기둥이 남는다(회차 상세와 같은 처리). */}
      <div
        className="mx-auto w-full bg-black rounded-xl overflow-hidden relative shadow-md shadow-slate-900/5 dark:shadow-none"
        style={{
          maxWidth: master?.width && master?.height
            ? `calc(62vh * ${master.width} / ${master.height})`
            : "calc(62vh * 16 / 9)",
        }}
      >
        <div
          className="relative bg-black flex items-center justify-center"
          style={{ aspectRatio: master?.width && master?.height ? `${master.width} / ${master.height}` : "16 / 9" }}
        >
          {videoSrc ? (
            <video
              ref={videoRef}
              key={videoSrc}
              src={videoSrc}
              controls
              playsInline
              preload="metadata"
              onPlay={() => setStarted(true)}
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              className="w-full h-full object-contain"
            >
              <track kind="captions" />
              브라우저가 비디오 태그를 지원하지 않습니다.
            </video>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-center text-xs text-slate-400 px-6">
              {master ? (videoError ?? "원본을 불러오는 중…") : "이 회차의 원본 파일이 없습니다"}
            </div>
          )}

          {/* Subtitle Overlay (Over video) */}
          {caption && (
            <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-black/80 px-4 py-1.5 rounded-md text-white text-xs font-semibold tracking-wide border border-white/10 pointer-events-none z-10">
              {caption}
            </div>
          )}
        </div>
      </div>

      {/* 2. Separate Episode Info & Action Section Card */}
      <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-3.5 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2.5">
          <span className="font-bold text-sm text-[var(--color-text-primary)]">
            회차 {episode.episodeNumber}
          </span>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold border-none ${BADGE_TONE[tone].pill}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${BADGE_TONE[tone].dot}`} />
            <span>{stageLabel(episode)}</span>
          </span>
          {(analyzing || waiting) && (
            <>
              <div className="h-1.5 w-[120px] rounded-full bg-[var(--color-bg-input)] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--color-bg-active)]" style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                {waiting ? "대기" : `${pct}%`}
              </span>
            </>
          )}
          {/* note 는 보류 상태에서도 보여야 한다 — 왜 안 도는지가 거기 적혀 있다. */}
          {(analyzing || waiting || blocked) && episode.pipeline?.note && (
            <span className="text-[11px] text-[var(--color-text-muted)]">{episode.pipeline.note}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 보류·실패에서 빠져나오는 출구. 이게 없으면 note 의 "충전 후 다시 시도하세요" 가
              시킬 수 없는 지시가 된다. 원본이 없으면 재분석할 대상이 없어 숨긴다. */}
          {(blocked || failed) && master && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              title="분석을 다시 큐에 넣습니다 (크레딧이 듭니다)"
              className={`${BTN} font-semibold shadow-xs disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {retrying ? "다시 시도 중…" : "다시 시도"}
            </button>
          )}
          <Link href={`/episodes/${episode.id}`} className={`${BTN} font-semibold shadow-xs`}>
            회차 상세
          </Link>
        </div>
      </div>

      {/* 차단 사유 — 원본 모달의 amber 고지 박스(676–683)와 같은 언어. */}
      {episode.pipeline?.blockedReason && (
        <div className="p-4 rounded-2xl bg-[#FFFBEB] dark:bg-[#282218] border-none flex items-start gap-3 shadow-none">
          <span className="w-4 h-4 rounded-full border border-amber-500 text-amber-500 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 select-none">
            i
          </span>
          <div className="text-xs text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
            {episode.pipeline.blockedReason}
          </div>
        </div>
      )}

      {/* Single Background Container with Vertical Divider Lines (divide-x) */}
      <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-4 grid grid-cols-3 divide-x divide-[var(--color-border-subtle)]">
        <Metric label="추천 구간" value={recs.length} />
        <Metric label="미결정" value={undecided} />
        <Metric label="미디어 생성" value={clipCount} />
      </div>

      {/* Recommendation Section Header (Title 16px, 2x Top Spacing pt-6) */}
      <div className="space-y-3 pt-6">
        {ended ? (
          <div className={EMPTY_CARD}>
            종영 프로그램입니다 — 새 회차 분석에서 클립을 만들지 않습니다.{" "}
            {/* 검색 화면은 아직 쿼리스트링 필터를 읽지 않는다 — ?program= 을 붙이면
                프로그램이 걸린 것처럼 보여서 뺐다. 검색창에서 직접 골라야 한다. */}
            <Link href="/search" className="underline text-[var(--color-bg-active)]">
              아카이브에서 장면 찾기
            </Link>{" "}
            (검색 화면에서 프로그램을 다시 골라야 합니다)
          </div>
        ) : recs.length === 0 ? (
          <div className={EMPTY_CARD}>
            {blocked
              ? (episode.pipeline?.note ?? "분석이 보류됐습니다 — 위 사유를 해결하면 시작됩니다")
              : analyzing || waiting
                ? "분석이 끝나면 추천 구간이 여기 나타납니다"
                : "추천 구간이 없습니다 — 분석 결과가 비어 있습니다"}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs">
              <h3 className="font-bold text-[16px] text-[var(--color-text-primary)] flex items-center gap-2">
                <span>추천 구간</span>
                <span className="text-[11px] text-[var(--color-text-muted)] font-normal">
                  채택(+)한 구간만 미디어가 됩니다 · 미결정 {undecided} · 채택 {adopted}
                </span>
              </h3>
            </div>

            {/* Recommendation Detail Item Cards List */}
            <div className="space-y-3">
              {recs.map((r) => (
                <RecommendationRow key={r.id} rec={r} onSeek={seekTo} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-6 py-1">
      <span className="font-bold text-sm text-slate-700 dark:text-slate-300">{label}</span>
      <span className="text-xl font-bold text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
}

function RecommendationRow({ rec, onSeek }: { rec: Recommendation; onSeek: (sec: number) => void }) {
  const { adoptRecommendation, rejectRecommendation } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const decided = rec.status !== "pending";

  async function adopt() {
    setBusy(true);
    try {
      await adoptRecommendation(rec.id);
      toast({
        title: "미디어를 만들었습니다",
        description: "미디어 화면에서 확인할 수 있습니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 보류. store 의 rejectRecommendation 은 낙관적 갱신 · 폴링 경합 가드(mutationEpoch) ·
   * 실패 시 롤백까지 다 하고, 실패는 다시 던진다. 예전 호출부가 그 rejection 을 잡지 않아
   * 실패해도 아무 말이 없었을 뿐이다 — 여기서 await + catch 로 사유를 토스트로 올린다.
   */
  async function reject() {
    setBusy(true);
    try {
      await rejectRecommendation(rec.id, "보류");
      toast({
        title: "보류했습니다",
        description: "이 구간은 미디어가 되지 않습니다 — 목록에는 남습니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "보류 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 rounded-xl bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          {/* Time range: Background removed — 누르면 위 플레이어가 그 지점부터 재생한다 */}
          <button
            type="button"
            onClick={() => onSeek(rec.startTime)}
            title="이 지점부터 재생"
            className="font-bold text-[#1C60FF] dark:text-[#60A5FA] font-mono text-xs pr-1 cursor-pointer underline-offset-2 hover:underline"
          >
            {fmtTime(rec.startTime)} - {fmtTime(rec.endTime)}
          </button>

          {/* n초 gray pill tag */}
          <span className={PILL}>{Math.round(rec.endTime - rec.startTime)}초</span>

          {/* 점수 n gray pill tag — score100 이 없는 옛 회차는 pill 자체를 생략한다("점수 -"는 0점으로 읽힌다) */}
          {typeof rec.score100 === "number" && <span className={PILL}>점수 {rec.score100}</span>}

          {/* 클립/숏폼 gray pill tag */}
          <span className={PILL}>{rec.kind === "short" ? "숏폼" : "클립"}</span>

          {/* 채택됨 pill tag */}
          {rec.status === "adopted" && (
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 font-bold text-[11px] border-none">
              채택됨
            </span>
          )}
          {/* 보류함 — 원본엔 없다. 안 보이면 무엇을 보류했는지 알 수 없다(되돌리는 UI도 없다). */}
          {rec.status === "rejected" && (
            <span className="px-2.5 py-0.5 rounded-full bg-slate-200/80 text-slate-700 dark:bg-[#282B35] dark:text-slate-300 font-bold text-[11px] border-none">
              보류함
            </span>
          )}
        </div>
      </div>

      {/* Title */}
      <h4 className="font-bold text-sm text-[var(--color-text-primary)]">{rec.title}</h4>

      {/* Reason Text (12px) */}
      {rec.editNote && (
        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed">근거 · {rec.editNote}</p>
      )}

      {/* Bottom Action Buttons (Standardized height h-8) */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border-subtle)]/50">
        {decided ? (
          rec.adoptedClipId ? (
            <Link href={`/editor/${rec.adoptedClipId}`} className={BTN}>
              미디어 열기
            </Link>
          ) : (
            <span className="text-[11px] text-[var(--color-text-muted)]">판단 완료</span>
          )
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={reject}
              className={`${BTN} disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              보류
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={adopt}
              className="h-8 px-4 rounded-full bg-[var(--color-bg-active)] hover:bg-[#0D1EB8] text-white border border-transparent text-xs font-medium cursor-pointer transition-colors shadow-sm inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              채택
            </button>
          </>
        )}
      </div>
    </div>
  );
}

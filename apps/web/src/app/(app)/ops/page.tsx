"use client";

/**
 * 운영 진단 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/ops/page.tsx` 409줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `MOCK_JOB_QUEUE` 32건 | `fetchOpsJobs(150)` |
 * | `MOCK_VIDEO_ANALYSIS` | `fetchOpsMediaAnalysis()` |
 * | 요약 `19 · 1 · 42866 · 189` | `jobs.stats.{pending,running,done,failed}` — 큐 **전수** 카운트 |
 * | 이미 포맷된 `'1/5'` `'지금'` `'1분 전'` `'1083.6s'` | `attempts/maxAttempts` · `inFuture` · `ago` · `secs` |
 * | `autoRefresh` state (효과 없음) | **실제 5초 폴링** |
 * | `onClick={() => {}}` 새로고침 | 실제 재조회 + 스피너 |
 *
 * ## 원본에 없어서 **반드시 되살린 것** — 이 화면의 존재 이유
 * 원본은 정적 목업이라 **행 펼침이 없다.** 그런데 그 안에 이 화면을 여는 이유가 들어 있다:
 * `blockedReason`(왜 파이프라인이 멈췄나) · `stagesDone`(체크포인트가 어디까지 갔나) ·
 * `hasData`(분석은 끝났다는데 저장된 게 없나) · 그리고 **회차 상세로 내려가는 유일한 출구**.
 * 빼면 필드 6개가 화면에서 통째로 사라진다. 원본 표 구조 안에 `colSpan` 확장 행으로 넣어
 * 마크업을 안 건드렸다.
 *
 * 자동새로고침 버튼은 **라벨을 `자동 5s` 로 고정**하고 아이콘만 Pause↔Play 로 바꾼다 —
 * 카피는 원본 그대로 두면서 켜짐/꺼짐이 보이게. 버튼에 "자동 5s" 라고 써 있는데 안 돌면
 * 화면이 거짓말을 한다.
 *
 * 폴백 문자는 원본 시각 언어를 따라 `-`(ASCII) 로 통일했다 — 우리 포맷터는 `—` 였다.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCw } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import {
  fetchOpsJobs,
  fetchOpsMediaAnalysis,
  type OpsJob,
  type OpsJobsResponse,
  type OpsMediaRow,
} from "@/lib/data/api";

const POLL_MS = 5000;
const ITEMS_PER_PAGE = 25;

/** ms → "12초 전" / "3분 전". 폴백은 원본 표기에 맞춰 ASCII 하이픈. */
function ago(ms?: number | null): string {
  if (!ms) return "-";
  const d = Date.now() - ms;
  if (d < 0) return "곧";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
function inFuture(ms?: number | null): string {
  if (!ms) return "-";
  const d = ms - Date.now();
  if (d <= 0) return "지금";
  const s = Math.ceil(d / 1000);
  if (s < 60) return `${s}초 후`;
  return `${Math.ceil(s / 60)}분 후`;
}
function secs(ms?: number): string {
  if (!ms || ms < 0) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 잡의 "대상" — payload 에서 사람이 알아볼 id 하나를 고른다. */
function targetOf(j: OpsJob): string {
  const p = (j.payload ?? {}) as Record<string, unknown>;
  return (
    (p.mediaId as string) ??
    (p.channelId as string) ??
    (p.videoId as string) ??
    (p.clipId as string) ??
    "-"
  );
}

/** 원본 그대로 — 상태 pill 5종. */
const renderStatusTag = (status: "pending" | "running" | "done" | "failed" | "미분석") => {
  switch (status) {
    case "running":
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[10.5px] bg-[#1C60FF]/15 text-[#1C60FF] font-medium border-none inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#1C60FF] shrink-0" />
          <span>running</span>
        </span>
      );
    case "done":
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[10.5px] bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 font-medium border-none inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 shrink-0" />
          <span>done</span>
        </span>
      );
    case "pending":
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[10.5px] bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 font-medium border-none inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 shrink-0" />
          <span>pending</span>
        </span>
      );
    case "미분석":
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[10.5px] bg-slate-200/80 dark:bg-stone-800 text-slate-600 dark:text-slate-400 font-medium border-none inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-stone-500 shrink-0" />
          <span>미분석</span>
        </span>
      );
    case "failed":
    default:
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[10.5px] bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400 font-medium border-none inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
          <span>failed</span>
        </span>
      );
  }
};

export default function OpDiagPage() {
  const [jobs, setJobs] = useState<OpsJobsResponse | null>(null);
  const [media, setMedia] = useState<OpsMediaRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [jobQueuePage, setJobQueuePage] = useState(1);
  const [videoAnalysisPage, setVideoAnalysisPage] = useState(1);
  const [openMedia, setOpenMedia] = useState<string | null>(null);
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [j, m] = await Promise.all([fetchOpsJobs(150), fetchOpsMediaAnalysis()]);
      setJobs(j);
      setMedia(m.media ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // 실제 5초 폴링 — 원본은 state 만 있고 아무 효과가 없었다.
  useEffect(() => {
    let alive = true;
    void load();
    const t = setInterval(() => {
      if (!alive || !autoRef.current) return;
      void load();
    }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  const jobRows = jobs?.jobs ?? [];
  const totalJobQueuePages = Math.max(1, Math.ceil(jobRows.length / ITEMS_PER_PAGE));
  const totalVideoPages = Math.max(1, Math.ceil(media.length / ITEMS_PER_PAGE));
  const paginatedJobQueue = jobRows.slice((jobQueuePage - 1) * ITEMS_PER_PAGE, jobQueuePage * ITEMS_PER_PAGE);
  const paginatedVideoAnalysis = media.slice((videoAnalysisPage - 1) * ITEMS_PER_PAGE, videoAnalysisPage * ITEMS_PER_PAGE);
  const stat = (n?: number) => (jobs ? String(n ?? 0) : "-");

  return (
    <>
      {/* Header */}
      <Header
        title="운영 진단"
        subtitle="큐가 어떻게 도는지 · 업로드 영상에서 뭐가 나오고 뭐가 깨지는지"
      />

      {/* Op Diag Main Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-6 min-h-0">
        <div className="space-y-5">
          {/* Top Right Action Control Bar */}
          <div className="flex items-center justify-between shrink-0">
            <p className="text-xs text-[var(--color-text-muted)] opacity-85 leading-relaxed font-sans">
              읽기 전용 진단입니다 ㅡ 큐 비우기·VM 기동 같은 조치 UI 는 아직 없습니다. 서버 API (POST /api/admin/queue/purge · /api/admin/gebd-vm/wake)로만 가능합니다.
            </p>

            <div className="flex items-center gap-2 text-xs select-none">
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                title={autoRefresh ? "자동 새로고침 켜짐 — 누르면 멈춥니다" : "자동 새로고침 꺼짐 — 누르면 5초마다 갱신합니다"}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] hover:text-[#1C60FF] text-xs text-[var(--color-text-primary)] transition-all cursor-pointer font-bold shadow-md shadow-slate-900/5 dark:shadow-none"
              >
                {autoRefresh
                  ? <Pause className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  : <Play className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                <span>자동 5s</span>
              </button>
              <button
                onClick={() => { void load(); }}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] hover:text-[#1C60FF] text-xs text-[var(--color-text-primary)] transition-all cursor-pointer font-bold shadow-md shadow-slate-900/5 dark:shadow-none disabled:cursor-not-allowed disabled:opacity-70"
              >
                <RotateCw className={`w-3.5 h-3.5 text-[var(--color-text-muted)] ${refreshing ? "animate-spin" : ""}`} />
                <span>새로고침</span>
              </button>
            </div>
          </div>

          {/* 원본엔 없는 상태 — 조회 실패를 조용히 두면 "큐가 비었다" 로 읽힌다. */}
          {err && (
            <div className="bg-[var(--color-bg-card)] rounded-2xl p-4 text-xs text-[var(--color-text-muted)] shadow-md shadow-slate-900/5 dark:shadow-none">
              진단 정보를 불러오지 못했습니다 ({err})
            </div>
          )}

          {/* 4 Summary Diagnostic Metric Cards (Icons Removed) */}
          <div className="grid grid-cols-4 gap-4">
            {/* Pending Card */}
            <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-2 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="text-xs text-[var(--color-text-muted)] font-semibold">
                <span>대기 (pending)</span>
              </div>
              <div className="text-3xl font-extrabold text-amber-400 tracking-tight">
                {stat(jobs?.stats?.pending)}
              </div>
            </div>

            {/* Running Card */}
            <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-2 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="text-xs text-[var(--color-text-muted)] font-semibold">
                <span>실행 중 (running)</span>
              </div>
              <div className="text-3xl font-extrabold text-[#1C60FF] tracking-tight">
                {stat(jobs?.stats?.running)}
              </div>
            </div>

            {/* Done Card */}
            <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-2 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="text-xs text-[var(--color-text-muted)] font-semibold">
                <span>완료 (done)</span>
              </div>
              <div className="text-3xl font-extrabold text-emerald-400 tracking-tight">
                {stat(jobs?.stats?.done)}
              </div>
            </div>

            {/* Failed Card */}
            <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-2 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="text-xs text-[var(--color-text-muted)] font-semibold">
                <span>실패 (failed)</span>
              </div>
              <div className="text-3xl font-extrabold text-rose-500 tracking-tight">
                {stat(jobs?.stats?.failed)}
              </div>
            </div>
          </div>

          {/* Job Queue Table Section (잡 큐 (최근 활동순)) */}
          <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-5 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                잡 큐 (최근 활동순)
              </h3>

              {/* Top Pagination Arrows */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  {Math.min((jobQueuePage - 1) * ITEMS_PER_PAGE + 1, jobRows.length)}-{Math.min(jobQueuePage * ITEMS_PER_PAGE, jobRows.length)} / 전체 {jobRows.length}개
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={jobQueuePage === 1}
                    onClick={() => setJobQueuePage((prev) => Math.max(prev - 1, 1))}
                    className="p-1 rounded-md border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-card-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    title="이전 페이지"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="font-semibold text-xs text-[var(--color-text-primary)] px-1.5">
                    {jobQueuePage} / {totalJobQueuePages}
                  </span>
                  <button
                    disabled={jobQueuePage === totalJobQueuePages}
                    onClick={() => setJobQueuePage((prev) => Math.min(prev + 1, totalJobQueuePages))}
                    className="p-1 rounded-md border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-card-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    title="다음 페이지"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="w-full overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border-subtle)] text-[10.5px] text-[var(--color-text-muted)]">
                    <th className="py-2.5 font-bold">타입</th>
                    <th className="py-2.5 font-bold">대상</th>
                    <th className="py-2.5 text-center font-bold">상태</th>
                    <th className="py-2.5 text-center font-bold">시도</th>
                    <th className="py-2.5 text-center font-bold">다음 실행</th>
                    <th className="py-2.5 text-center font-bold">갱신</th>
                    <th className="py-2.5 text-right font-bold">에러</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]/50">
                  {paginatedJobQueue.length === 0 ? (
                    <tr><td colSpan={7} className="py-6 text-center text-[var(--color-text-muted)]">
                      {jobs ? "큐가 비어 있습니다." : "불러오는 중…"}
                    </td></tr>
                  ) : paginatedJobQueue.map((item) => (
                    <tr key={item.id} className="hover:bg-[var(--color-bg-input)]/40 transition-colors">
                      <td className="py-2.5 font-bold text-[var(--color-text-primary)] font-mono text-xs">
                        {item.type}
                      </td>
                      <td className="py-2.5 text-[var(--color-text-secondary)] font-mono text-xs" title={targetOf(item)}>
                        {targetOf(item)}
                      </td>
                      <td className="py-2.5 text-center">
                        {renderStatusTag(item.status)}
                      </td>
                      <td className="py-2.5 text-center font-bold text-[var(--color-text-primary)] font-mono">
                        {item.attempts}/{item.maxAttempts}
                      </td>
                      <td className="py-2.5 text-center text-[var(--color-text-muted)]">
                        {item.status === "pending" ? inFuture(item.runAfter) : "-"}
                      </td>
                      <td className="py-2.5 text-center text-[var(--color-text-muted)]" title={item.updatedAt ? new Date(item.updatedAt).toLocaleString("ko-KR") : undefined}>
                        {ago(item.updatedAt)}
                      </td>
                      {/* 실제 에러는 수십~수백 자다. 폭은 원본대로 두고 title 로 전문을 준다. */}
                      <td className="py-2.5 text-right text-[var(--color-text-muted)] font-mono max-w-[220px] truncate" title={item.error ?? undefined}>
                        {item.error ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Uploaded Video Analysis Results Table (업로드 영상·분석 결과) */}
          <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-5 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                업로드 영상·분석 결과
              </h3>

              {/* Top Pagination Arrows */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  {Math.min((videoAnalysisPage - 1) * ITEMS_PER_PAGE + 1, media.length)}-{Math.min(videoAnalysisPage * ITEMS_PER_PAGE, media.length)} / 전체 {media.length}개
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={videoAnalysisPage === 1}
                    onClick={() => setVideoAnalysisPage((prev) => Math.max(prev - 1, 1))}
                    className="p-1 rounded-md border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-card-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    title="이전 페이지"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="font-semibold text-xs text-[var(--color-text-primary)] px-1.5">
                    {videoAnalysisPage} / {totalVideoPages}
                  </span>
                  <button
                    disabled={videoAnalysisPage === totalVideoPages}
                    onClick={() => setVideoAnalysisPage((prev) => Math.min(prev + 1, totalVideoPages))}
                    className="p-1 rounded-md border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-card-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    title="다음 페이지"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="w-full overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs table-fixed">
                <thead>
                  <tr className="border-b border-[var(--color-border-subtle)] text-[10.5px] text-[var(--color-text-muted)]">
                    <th className="py-2.5 font-bold min-w-[160px]">영상</th>
                    <th className="py-2.5 text-center font-bold w-[110px]">분석 상태</th>
                    <th className="py-2.5 font-bold w-[150px]">파이프라인 단계</th>
                    <th className="py-2.5 text-center font-bold w-[65px]">장면</th>
                    <th className="py-2.5 text-center font-bold w-[65px]">숏폼</th>
                    <th className="py-2.5 text-center font-bold w-[65px]">출연자</th>
                    <th className="py-2.5 text-center font-bold w-[110px]">장르</th>
                    <th className="py-2.5 text-right font-bold w-[90px]">소요</th>
                    <th className="py-2.5 text-right font-bold w-[60px]">에러</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]/50">
                  {paginatedVideoAnalysis.length === 0 ? (
                    <tr><td colSpan={9} className="py-6 text-center text-[var(--color-text-muted)]">
                      {jobs ? "업로드된 영상이 없습니다." : "불러오는 중…"}
                    </td></tr>
                  ) : paginatedVideoAnalysis.map((m) => {
                    const isOpen = openMedia === m.mediaId;
                    const stage = m.pipeline?.stage
                      ? `${m.pipeline.stage}${typeof m.pipeline.progress === "number" ? ` · ${m.pipeline.progress}%` : ""}`
                      : "-";
                    return (
                      <React.Fragment key={m.mediaId}>
                        <tr
                          onClick={() => setOpenMedia(isOpen ? null : m.mediaId)}
                          className="hover:bg-[var(--color-bg-input)]/40 transition-colors cursor-pointer"
                        >
                          <td className="py-3 font-bold text-[var(--color-text-primary)] font-mono text-xs truncate pr-2" title={m.title || undefined}>
                            {m.title || "(제목 없음)"}
                            <span className="block font-normal text-[10.5px] text-[var(--color-text-muted)] mt-0.5 truncate">
                              {m.mediaId}
                            </span>
                          </td>
                          <td className="py-3 text-center">
                            {renderStatusTag(m.analysis ? m.analysis.status : "미분석")}
                          </td>
                          <td className="py-3 text-[var(--color-text-secondary)] font-mono text-xs truncate" title={stage}>
                            {stage}
                          </td>
                          <td className="py-3 text-center font-bold text-[var(--color-text-primary)] font-mono">
                            {m.analysis?.scenes ?? "-"}
                          </td>
                          <td className="py-3 text-center font-bold text-[var(--color-text-primary)] font-mono">
                            {m.analysis?.shorts ?? "-"}
                          </td>
                          <td className="py-3 text-center font-bold text-[var(--color-text-primary)] font-mono">
                            {m.analysis?.cast ?? "-"}
                          </td>
                          <td className="py-3 text-center text-[var(--color-text-secondary)] font-mono text-xs">
                            {m.analysis?.genre ?? "-"}
                          </td>
                          <td className="py-3 text-right text-[var(--color-text-primary)] font-mono text-xs">
                            {secs(m.analysis?.tookMs)}
                          </td>
                          <td className="py-3 text-right text-[var(--color-text-muted)] font-mono text-xs truncate" title={m.analysis?.error ?? undefined}>
                            {m.analysis?.error ?? "-"}
                          </td>
                        </tr>
                        {/* 원본에 없는 펼침 행 — 이 화면을 여는 이유가 여기 있다(§상단 주석).
                            표 구조 안의 colSpan 확장이라 원본 마크업은 그대로다. */}
                        {isOpen && (
                          <tr>
                            <td colSpan={9} className="bg-[var(--color-bg-input)]/40 px-2 py-3 text-xs">
                              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[var(--color-text-muted)]">
                                <span>길이 <b className="text-[var(--color-text-primary)]">{secs(m.durationSec * 1000)}</b></span>
                                <span>오디오 <b className="text-[var(--color-text-primary)]">{m.hasAudio ? "있음" : "없음"}</b></span>
                                <span>업로드 <b className="text-[var(--color-text-primary)]">{ago(m.createdAt)}</b></span>
                                {m.analysis?.stagesDone && (
                                  <span>완료 단계 <b className="text-[var(--color-text-primary)]">{m.analysis.stagesDone.join(" → ") || "-"}</b></span>
                                )}
                                {m.analysis && !m.analysis.hasData && <span className="text-amber-500">저장된 분석 데이터 없음</span>}
                                {m.pipeline?.blockedReason && <span className="text-rose-500">⚠ {m.pipeline.blockedReason}</span>}
                              </div>
                              {m.episodeId && (
                                <Link
                                  href={`/episodes/${m.episodeId}`}
                                  className="mt-2 inline-block font-medium text-[var(--color-text-accent)] underline-offset-2 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  회차 상세 · 분석 결과 열기 →
                                </Link>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

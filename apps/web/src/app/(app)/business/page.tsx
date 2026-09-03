"use client";

/**
 * 사업 운영 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/business/page.tsx` 607줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 * 원본에는 **상수 배열이 하나도 없다** — 값이 전부 JSX 리터럴이라, 계산은 우리 현행 것을 그대로 옮겼다.
 *
 * ## ⚠️ 엑셀 내보내기 — 이 화면이 앱 전체의 **유일한** 진입점이다
 * 원본 버튼(40–45)에 `onClick` 이 없다. `ExportExcelButton` 을 쓰는 화면은 리포 전체에서
 * `/business` **하나뿐**이라, 여기서 빠지면 **엑셀 내보내기가 제품에서 통째로 사라진다.**
 * 컴포넌트를 그대로 쓰면 내부가 `ui/button` 이라 디자인이 달라지므로, **로직만 인라인**하고
 * 원본 버튼의 className·아이콘·문구는 한 글자도 안 바꿨다(busy 스피너만 얹음).
 *
 * ## 원본이 정적이라 사라질 뻔한 것들
 *  - 표·카드·큐가 **전부 클릭 불가**(정적 `<div>`/`<tr>`)였다. 프로그램·회차로 내려가는
 *    경로를 되살렸다 — 이 화면은 "어디를 봐야 하나" 를 알려 주는 자리라 링크가 목적물이다.
 *  - **확인 큐는 빈 상태 마크업만** 있었다(항목 행이 아예 없다). 리스크가 실제로 있을 때
 *    보여줄 행을 원본 큐 카드와 같은 언어로 추가했다.
 *  - 상태 배지가 원본엔 emerald/파랑/slate 3종 리터럴뿐이라 5분기를 그 안에 매핑했다.
 *
 * ## 숫자는 전부 계산이다
 * `채택률` 분모는 **결정된 건만**(pending 제외) — pending 을 넣으면 검토가 밀릴수록 채택률이
 * 떨어져 보인다. `점수` 는 `score100 ?? appeal*20`.
 */
import React, { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  Download,
  FileCheck,
  Loader2,
  Megaphone,
  Share2,
  ShieldCheck,
  Video,
} from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useToast } from "@/components/ui/toast";
import { channelLabel } from "@/lib/constants";
import { useAppData } from "@/lib/data/store";
import { exportDistributionExcel } from "@/lib/export/distribution-excel";
import type { Clip, Program, Recommendation } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

const formatCount = (n: number) => n.toLocaleString("ko-KR");
const recScore = (rec: Recommendation): number => rec.score100 ?? rec.appeal * 20;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

interface ProgramBusinessRow {
  program: Program;
  episodeCount: number;
  recommendations: Recommendation[];
  pendingRecommendations: number;
  adoptedRecommendations: number;
  rejectedRecommendations: number;
  clips: Clip[];
  readyClips: number;
  renderedClips: number;
  publishedDestinations: number;
  failedDestinations: number;
  avgScore: number;
  riskCount: number;
  shareable: boolean;
}

export default function BizOpPage() {
  const { programs, episodes, recommendations, clips } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const episodeById = new Map(episodes.map((e) => [e.id, e]));

  const rows: ProgramBusinessRow[] = programs
    .map((program) => {
      const programEpisodes = episodes.filter((e) => e.programId === program.id);
      const episodeIds = new Set(programEpisodes.map((e) => e.id));
      const programRecommendations = recommendations.filter((r) => episodeIds.has(r.episodeId));
      const programClips = clips.filter((c) => episodeIds.has(c.episodeId));
      const publishedDestinations = programClips.reduce(
        (s, c) => s + c.distributions.filter((d) => d.status === "published").length, 0);
      const failedDestinations = programClips.reduce(
        (s, c) => s + c.distributions.filter((d) => d.status === "failed").length, 0);
      const pendingRecommendations = programRecommendations.filter((r) => r.status === "pending").length;
      const adoptedRecommendations = programRecommendations.filter((r) => r.status === "adopted").length;
      const rejectedRecommendations = programRecommendations.filter((r) => r.status === "rejected").length;
      const readyClips = programClips.filter((c) => c.status === "ready" || c.status === "published").length;
      const renderedClips = programClips.filter((c) => c.rendered).length;
      const avgScore = programRecommendations.length > 0
        ? Math.round(programRecommendations.reduce((s, r) => s + recScore(r), 0) / programRecommendations.length)
        : 0;
      // 브랜드 노출 확인은 뺐다 — 서버가 추천에 brands 를 안 채워 항상 0 이었다.
      const ageReviewCount = programClips.filter((c) => c.targetAge === 19).length;
      return {
        program,
        episodeCount: programEpisodes.length,
        recommendations: programRecommendations,
        pendingRecommendations, adoptedRecommendations, rejectedRecommendations,
        clips: programClips, readyClips, renderedClips,
        publishedDestinations, failedDestinations, avgScore,
        riskCount: failedDestinations + ageReviewCount,
        shareable: readyClips > 0 || publishedDestinations > 0,
      };
    })
    .sort((a, b) =>
      Number(b.shareable) - Number(a.shareable) ||
      b.publishedDestinations - a.publishedDestinations ||
      b.readyClips - a.readyClips ||
      b.adoptedRecommendations - a.adoptedRecommendations ||
      b.pendingRecommendations - a.pendingRecommendations ||
      b.avgScore - a.avgScore);

  const shareablePrograms = rows.filter((r) => r.shareable).length;
  const salesReadyClips = clips.filter((c) => c.status === "ready" || c.status === "published").length;
  const publishedDestinations = clips.reduce(
    (s, c) => s + c.distributions.filter((d) => d.status === "published").length, 0);
  const pendingRecommendations = recommendations.filter((r) => r.status === "pending").length;
  const adoptedRecommendations = recommendations.filter((r) => r.status === "adopted").length;
  // 분모는 **결정된 건만** — pending 을 넣으면 검토가 밀릴수록 채택률이 떨어져 보인다.
  const decidedRecommendations = recommendations.filter((r) => r.status === "adopted" || r.status === "rejected").length;
  const adoptionRate = pct(adoptedRecommendations, decidedRecommendations);

  const salesCandidates = clips
    .filter((c) => c.status === "ready" || c.status === "published")
    .sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || b.durationSec - a.durationSec)
    .slice(0, 6);
  const pendingRecCandidates = recommendations
    .filter((r) => r.status === "pending")
    .sort((a, b) => recScore(b) - recScore(a))
    .slice(0, Math.max(0, 6 - salesCandidates.length));

  const riskItems = [
    ...clips.flatMap((clip) =>
      clip.distributions.filter((d) => d.status === "failed").map((d) => ({
        id: `${clip.id}-${d.channel}-failed`,
        tone: "error" as const,
        title: clip.title,
        detail: `${channelLabel(d.channel)} 배포 실패${d.error ? ` · ${d.error}` : ""}`,
        href: `/episodes/${clip.episodeId}?tab=distribute`,
      }))),
    ...clips.filter((c) => c.targetAge === 19).map((clip) => ({
      id: `${clip.id}-age`,
      tone: "warn" as const,
      title: clip.title,
      detail: "19세 등급 클립 · 광고/플랫폼 적합성 확인",
      href: `/episodes/${clip.episodeId}?tab=clips`,
    })),
  ].slice(0, 8);

  const shareableRows = rows
    .filter((r) => r.shareable || r.pendingRecommendations > 0 || r.adoptedRecommendations > 0)
    .slice(0, 3);
  const topSignals = rows
    .filter((r) => r.recommendations.length > 0)
    .sort((a, b) => b.avgScore - a.avgScore || b.adoptedRecommendations - a.adoptedRecommendations)
    .slice(0, 5);

  /** 원본 버튼엔 onClick 이 없다 — 로직만 인라인한다(컴포넌트를 쓰면 디자인이 달라진다). */
  async function onExport() {
    if (busy) return;
    setBusy(true);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const res = await exportDistributionExcel({ programs, episodes, clips }, stamp);
      toast({
        title: "엑셀 내보내기 완료",
        description: `${res.filename} · 배포 ${res.recordRows}건 · YouTube 메타 ${res.youtubeRows}건`,
        tone: "done",
      });
    } catch (err) {
      toast({ title: "내보내기 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="사업 운영" subtitle="프로그램별 IP 운영 현황 · 부서 공유 후보" />

      {/* Biz Op Main Content Area */}
      <main className="flex-1 p-5 flex flex-col justify-between overflow-y-auto space-y-5 min-h-0">
        <div className="space-y-5">
          {/* Top Right Excel Download */}
          <div className="flex justify-end shrink-0">
            <button
              onClick={() => { void onExport(); }}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] hover:text-[#1C60FF] text-xs text-[var(--color-text-primary)] transition-all cursor-pointer font-semibold shadow-none disabled:cursor-not-allowed disabled:opacity-70"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              <span>엑셀 내보내기</span>
            </button>
          </div>

          {/* 4 Summary Cards (KPI Bar) */}
          <div className="grid grid-cols-4 gap-4">
            <Kpi icon={Share2} label="공유 가능 IP" value={formatCount(shareablePrograms)} note={`전체 프로그램 ${formatCount(rows.length)}`} />
            <Kpi icon={Video} label="영업 준비 클립" value={formatCount(salesReadyClips)} note={`게시 채널 ${formatCount(publishedDestinations)}`} accent />
            <Kpi icon={FileCheck} label="대기 추천" value={formatCount(pendingRecommendations)} note={`채택률 ${adoptionRate}%`} />
            <Kpi
              icon={AlertCircle}
              label="확인 필요"
              value={formatCount(riskItems.length)}
              note={riskItems.length === 0 ? "표시된 리스크 없음" : "아래 확인 큐에서 처리"}
            />
          </div>

          <div className="grid grid-cols-12 gap-4">
            {/* Program IP Operation Board */}
            <div className="col-span-7 bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
              <div>
                <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                  프로그램/IP 운영 보드 ({rows.length})
                </h3>
              </div>

              <div className="w-full overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)] text-[10.5px] text-[var(--color-text-muted)]">
                      <th className="py-2.5 font-bold">프로그램/IP</th>
                      <th className="py-2.5 text-center font-bold">회차</th>
                      <th className="py-2.5 text-center font-bold">추천</th>
                      <th className="py-2.5 text-center font-bold">채택</th>
                      <th className="py-2.5 text-center font-bold">준비 클립</th>
                      <th className="py-2.5 text-center font-bold">게시</th>
                      <th className="py-2.5 text-center font-bold">확인</th>
                      <th className="py-2.5 text-right font-bold">상태</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border-subtle)]/60">
                    {rows.length === 0 ? (
                      <tr><td colSpan={8} className="py-8 text-center text-[var(--color-text-muted)]">
                        프로그램이 없습니다.
                      </td></tr>
                    ) : rows.map((row) => (
                      <tr key={row.program.id}>
                        <td className="py-3 font-bold text-[var(--color-text-primary)]">
                          {/* 원본은 정적 <td> 였다 — 이 화면은 "어디를 봐야 하나" 를 알려 주는 자리라 링크가 목적물이다. */}
                          <Link href={`/programs/${row.program.id}`} className="hover:text-[#1C60FF] transition-colors">
                            {row.program.title}
                          </Link>
                          <span className="block font-normal text-[10.5px] text-[var(--color-text-muted)] mt-0.5">
                            {row.program.section} · 점수 {row.avgScore || "-"}
                          </span>
                        </td>
                        <td className="py-3 text-center font-bold text-[var(--color-text-primary)]">{row.episodeCount}</td>
                        <td className="py-3 text-center font-semibold">
                          {row.recommendations.length}
                          <span className="block text-[10.5px] text-[var(--color-text-muted)] font-normal">
                            대기 {row.pendingRecommendations}
                          </span>
                        </td>
                        <td className="py-3 text-center font-bold text-[var(--color-text-primary)]">
                          {row.adoptedRecommendations}
                          {row.rejectedRecommendations > 0 && (
                            <span className="block text-[10.5px] text-[var(--color-text-muted)] font-normal">
                              반려 {row.rejectedRecommendations}
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-center font-semibold">
                          {row.readyClips}
                          <span className="block text-[10.5px] text-[var(--color-text-muted)] font-normal">
                            렌더 {row.renderedClips}
                          </span>
                        </td>
                        <td className="py-3 text-center font-bold text-[var(--color-text-primary)]">{row.publishedDestinations}</td>
                        <td className="py-3 text-center font-bold text-[var(--color-text-primary)]">{row.riskCount}</td>
                        <td className="py-3 text-right"><RowStatus row={row} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 부서 공유 후보 */}
            <div className="col-span-5 bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
              <div>
                <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">부서 공유 후보</h3>
              </div>

              <div className="space-y-2.5">
                {shareableRows.length === 0 ? (
                  <p className="text-[var(--color-text-muted)] py-4">공유할 만한 프로그램이 아직 없습니다.</p>
                ) : shareableRows.map((row) => (
                  <Link
                    key={row.program.id}
                    href={`/programs/${row.program.id}`}
                    className="block p-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] space-y-2 hover:bg-[var(--color-bg-card-hover)] transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[10.5px] text-[var(--color-text-muted)] font-semibold">프로그램/IP</div>
                        <h4 className="font-bold text-[var(--color-text-primary)] text-xs mt-0.5">{row.program.title}</h4>
                      </div>
                      <Pill tone={row.shareable ? "ok" : "idle"} label={row.shareable ? "공유 가능" : "검토 필요"} />
                    </div>
                    <div className="grid grid-cols-3 text-left text-[11px] pt-1">
                      <Metric label="준비 클립" value={row.readyClips} />
                      <Metric label="대기 추천" value={row.pendingRecommendations} />
                      <Metric label="게시 채널" value={row.publishedDestinations} />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {/* Sales Material Queue */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
              <div>
                <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                  영업 소재 큐 ({salesCandidates.length + pendingRecCandidates.length})
                </h3>
              </div>

              <div className="space-y-2">
                {salesCandidates.length + pendingRecCandidates.length === 0 ? (
                  <p className="text-[var(--color-text-muted)] py-4">쓸 만한 소재가 아직 없습니다.</p>
                ) : (
                  <>
                    {salesCandidates.map((clip) => (
                      <QueueRow
                        key={clip.id}
                        href={`/episodes/${clip.episodeId}?tab=clips`}
                        title={clip.title}
                        meta={`${clip.programTitle} · ${formatDuration(clip.durationSec)}`}
                        tone={clip.status === "published" ? "ok" : "progress"}
                        label={clip.status === "published" ? "게시됨" : "준비됨"}
                      />
                    ))}
                    {pendingRecCandidates.map((rec) => (
                      <QueueRow
                        key={rec.id}
                        href={`/episodes/${rec.episodeId}?tab=analyze`}
                        title={rec.title}
                        meta={`${episodeById.get(rec.episodeId)?.programTitle ?? "프로그램 미확인"} · 점수 ${recScore(rec)}`}
                        tone="idle"
                        label="추천"
                      />
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* 편성 신호 */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
              <div>
                <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                  편성 신호 ({topSignals.length})
                </h3>
              </div>

              <div className="space-y-2.5">
                {topSignals.length === 0 ? (
                  <p className="text-[var(--color-text-muted)] py-4">추천이 쌓이면 신호가 보입니다.</p>
                ) : topSignals.map((row) => {
                  const rate = pct(row.adoptedRecommendations, row.adoptedRecommendations + row.rejectedRecommendations);
                  return (
                    <Link
                      key={row.program.id}
                      href={`/programs/${row.program.id}`}
                      className="p-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)]/60 flex items-center justify-between hover:bg-[var(--color-bg-card-hover)] transition-colors"
                    >
                      <div>
                        <h4 className="font-bold text-xs text-[var(--color-text-primary)]">{row.program.title}</h4>
                        <p className="text-[10.5px] text-[var(--color-text-muted)] mt-0.5">
                          평균 점수 {row.avgScore} · 채택 {row.adoptedRecommendations}/{row.recommendations.length}
                        </p>
                      </div>
                      <Pill tone={rate > 0 ? "ok" : "idle"} label={`${rate}%`} />
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Confirm Queue */}
            <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 text-xs flex flex-col shadow-md shadow-slate-900/5 dark:shadow-none">
              <div>
                <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">확인 큐</h3>
              </div>

              {/* 원본엔 **빈 상태 마크업만** 있었다 — 항목 행이 아예 없어서, 리스크가 생겨도 보여줄 데가 없다. */}
              {riskItems.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)] text-xs border border-dashed border-[var(--color-border-subtle)]/60 rounded-xl p-6 text-center space-y-2 my-auto min-h-[220px]">
                  <ShieldCheck className="w-8 h-8 text-[var(--color-text-muted)] opacity-40" />
                  <p className="font-bold text-[var(--color-text-primary)]">현재 확인할 항목이 없습니다</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {riskItems.map((item) => (
                    <QueueRow
                      key={item.id}
                      href={item.href}
                      title={item.title}
                      meta={item.detail}
                      tone={item.tone === "error" ? "danger" : "warn"}
                      label={item.tone === "error" ? "실패" : "확인"}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Bottom 2 Action Banner Cards */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <Link
              href="/distribution"
              className="p-4 rounded-xl bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-card-hover)] border-none flex items-center gap-3.5 shadow-md shadow-slate-900/5 dark:shadow-none transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-xl bg-[var(--color-bg-input)] flex items-center justify-center shrink-0">
                <Megaphone className="w-5 h-5 text-[#222222] dark:text-slate-200" />
              </div>
              <div>
                <h4 className="font-bold text-[var(--color-text-primary)] text-sm group-hover:text-[#1C60FF] transition-colors">홍보팀</h4>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  즉시 쓸 수 있는 소재 {formatCount(salesReadyClips)}개
                </p>
              </div>
            </Link>

            <Link
              href="/performance"
              className="p-4 rounded-xl bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-card-hover)] border-none flex items-center gap-3.5 shadow-md shadow-slate-900/5 dark:shadow-none transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-xl bg-[var(--color-bg-input)] flex items-center justify-center shrink-0">
                <Building2 className="w-5 h-5 text-[#222222] dark:text-slate-200" />
              </div>
              <div>
                <h4 className="font-bold text-[var(--color-text-primary)] text-sm group-hover:text-[#1C60FF] transition-colors">광고영업</h4>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  공유 가능 IP {formatCount(shareablePrograms)}개
                </p>
              </div>
            </Link>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

/** KPI 카드 — 원본에 4번 복붙돼 있던 것(클래스 동일). 다른 건 아이콘·라벨·값·주석뿐. */
function Kpi({
  icon: Icon, label, value, note, accent,
}: { icon: React.ElementType; label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none p-5 rounded-2xl space-y-3 shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col justify-between">
      <div className="w-8 h-8 rounded-lg flex items-center justify-start">
        <Icon className="w-6 h-6 text-[#222222] dark:text-slate-200 stroke-[1.75]" />
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-tight">{label}</h4>
          <span
            className="text-3xl font-extrabold tracking-tight"
            style={accent ? { color: "#1C60FF" } : { color: "var(--color-text-primary)" }}
          >
            {value}
          </span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] font-medium">{note}</p>
      </div>
    </div>
  );
}

type Tone = "ok" | "progress" | "idle" | "warn" | "danger";

/** 상태 pill — 원본엔 emerald·파랑·slate 3종 리터럴뿐이라 5분기를 그 안에 매핑한다. */
function Pill({ tone, label }: { tone: Tone; label: string }) {
  const map: Record<Tone, [string, string]> = {
    ok: ["bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400", "bg-emerald-600 dark:bg-emerald-400"],
    progress: ["bg-[#1C60FF]/15 text-[#1C60FF] dark:text-blue-400", "bg-[#1C60FF]"],
    idle: ["bg-slate-200/80 dark:bg-stone-800 text-slate-600 dark:text-slate-400", "bg-slate-400 dark:bg-stone-500"],
    warn: ["bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400", "bg-amber-500 dark:bg-amber-400"],
    danger: ["bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400", "bg-rose-500"],
  };
  const [chip, dot] = map[tone];
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-[10.5px] font-medium border-none inline-flex items-center gap-1.5 shrink-0 ${chip}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <span>{label}</span>
    </span>
  );
}

function RowStatus({ row }: { row: ProgramBusinessRow }) {
  if (row.riskCount > 0) return <Pill tone="danger" label={`확인 ${row.riskCount}`} />;
  if (row.shareable) return <Pill tone="ok" label="공유 가능" />;
  if (row.readyClips > 0 || row.renderedClips > 0) return <Pill tone="progress" label="작업 중" />;
  if (row.pendingRecommendations > 0) return <Pill tone="warn" label="검토 대기" />;
  return <Pill tone="idle" label="준비 전" />;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="text-[10.5px] text-[var(--color-text-muted)] block">{label}</span>
      <span className="font-extrabold text-sm text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
}

/** 큐 행 — 원본은 정적 div 였다. 링크로 만들어 실제로 내려갈 수 있게 한다. */
function QueueRow({
  href, title, meta, tone, label,
}: { href: string; title: string; meta: string; tone: Tone; label: string }) {
  return (
    <Link
      href={href}
      className="p-2.5 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)]/60 flex items-center justify-between gap-2 hover:bg-[var(--color-bg-card-hover)] transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-[var(--color-text-primary)] font-medium">{title}</p>
        <span className="text-[10.5px] text-[var(--color-text-muted)]">{meta}</span>
      </div>
      <Pill tone={tone} label={label} />
    </Link>
  );
}

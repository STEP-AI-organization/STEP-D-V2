"use client";

/**
 * 대시보드 — 디자이너 산출물 이식
 * (원본 `STEPD_SaaS_UI_V1/src/app/dashboard/page.tsx` + `components/dashboard/*` 3종).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 * 원본은 컴포넌트 3개로 갈라져 있었지만, 데이터가 전부 이 화면에서만 나오므로 한 파일에 둔다
 * (컴포넌트 경계만 바뀌고 마크업은 그대로다).
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `dailyRevenueData` 28일 하드코딩 | `fetchChannelAnalytics()` 채널별 합산 |
 * | `MOCK_REVENUE_CHANNELS` + 분모 `23150000` 고정 | 실제 채널 · 분모는 **합계로 계산** |
 * | `MOCK_DEPLOYMENTS` · 프로그램 `'리센느'` 고정 | 실제 배포 기록 · 실제 프로그램 |
 * | `\|\| '₩0'` · `\|\| '08-26 12:00'` | **지어내지 않는다** — 모르면 `—` |
 * | 푸터 `3곳 / 없음 / 1곳` 고정 | 실제 집계 가능·권한·업로드 전용 수 |
 *
 * ## ⚠️ 원본에 **역할 개념이 없다** — 이게 이 화면의 최대 위험
 *  1. **권한 없으면 요청 자체를 안 한다.** 서버는 역할을 안 보므로, 요청하면 실수익이
 *     브라우저까지 내려온다. 마스킹은 표시 제어일 뿐이라 **네트워크에서 막아야 진짜 마스킹**이다.
 *  2. `revenueDisplay()` 로 `비공개` 표기. 마스킹되면 **퍼센트도 숨긴다** — 원본엔 막대가 없고
 *     퍼센트가 그 자리를 대신하므로, 퍼센트를 두면 마스킹이 뚫린다.
 *  3. **수익 범위에 동의한 채널만** 조회한다(`hasMonetaryScope`). 업로드 전용은 요청도 안 한다 —
 *     "구조적으로 데이터 없음" 과 "실패" 는 다르다.
 *  4. `status === "active"` 채널만. 연동 끊긴 채널은 실패만 쌓는다.
 *
 * ## 그 밖에 원본에 없어서 지킨 것
 *  - **권리 만료 임박 경고(F3)** — 원본 어디에도 없다. 빼면 만료 임박을 알려 주는 화면이
 *    시스템에 하나도 안 남는다.
 *  - **28일 창 명시 + 전 행 합산** — 서버 기본은 90일이고 rows 는 하루 1행이라,
 *    창을 안 주거나 `rows[0]` 만 읽으면 라벨(28일)과 숫자가 어긋난다.
 *  - **부분 실패 표기** — 채널 3곳 중 1곳만 실패해도 합계는 조용히 작아진다.
 *  - **조회 전/중에는 `₩0` 이 아니라 `—`** · `status === "none"` 제외 · 예약일 두 형식 파서.
 *  - **부제 명시** — 원본 `<Header />` 는 props 가 없어 부제가 사라진다.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useSession } from "@/lib/auth";
import { channelLabel } from "@/lib/constants";
import {
  fetchChannelAnalytics,
  fetchYouTubeChannels,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { normalizeProgramStatus, rightsWindowOf } from "@/lib/programs";
import { revenueDisplay, roleOf } from "@/lib/roles";
import type { Clip } from "@/lib/types";

const WON = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;

/** 수익 집계 창. 카드 라벨과 **같은 숫자**여야 한다 — 라벨만 28일이고 조회는 90일이면 거짓말이다. */
const REVENUE_WINDOW_DAYS = 28;

/** 로컬 날짜 기준 YYYY-MM-DD. toISOString 은 UTC 라 KST 새벽에 하루가 밀린다. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function windowOf(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

export default function DashboardPage() {
  const { clips, programs, episodes } = useAppData();
  const session = useSession();
  const role = session.user.role;
  const caps = roleOf(role);

  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [channelsReady, setChannelsReady] = useState(false);
  const [revenue, setRevenue] = useState<Record<string, number>>({});
  const [daily, setDaily] = useState<{ dayLabel: string; date: string; amount: number }[]>([]);
  const [revenueReady, setRevenueReady] = useState(false);
  const [revenueError, setRevenueError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      // 연동 끊긴 채널은 수익 조회가 실패만 쌓는다 — 대시보드 합계에는 활성만 넣는다.
      .then((cs) => { if (alive) { setChannels(cs.filter((c) => c.status === "active")); setChannelsReady(true); } })
      .catch(() => { if (alive) { setChannels([]); setChannelsReady(true); } });
    return () => { alive = false; };
  }, []);

  // 수익은 **수익 범위에 동의한 채널만** 조회한다. 나머지는 요청도 하지 않는다 —
  // 데이터가 구조적으로 없는 것을 "실패"로 보여주면 안 된다.
  const monetary = useMemo(() => channels.filter((c) => c.hasMonetaryScope), [channels]);
  const uploadOnly = channels.length - monetary.length;

  const loadRevenue = useCallback(async () => {
    // ⚠️ 권한이 없으면 **요청 자체를 안 한다.** 서버는 역할을 보지 않으므로,
    // 요청하면 실수익이 브라우저까지 내려온다 — UI 마스킹만으로는 안 막힌다.
    if (!caps.revenue || monetary.length === 0) return;
    const out: Record<string, number> = {};
    const byDay = new Map<string, number>();
    let failed = 0;
    const win = windowOf(REVENUE_WINDOW_DAYS);
    for (const ch of monetary) {
      try {
        // 서버는 start/end 를 안 주면 90일, dimensions 를 안 주면 day 로 채운다 —
        // rows 는 하루 1행이라 rows[0] 만 읽으면 "28일 합계" 가 아니라 **구간 첫날 하루치**다.
        const a = await fetchChannelAnalytics(ch.channelId, {
          start: win.start,
          end: win.end,
          metrics: "estimatedRevenue",
        });
        const key = a.columns?.find((c) => c.toLowerCase().includes("revenue")) ?? "estimatedRevenue";
        const dayKey = a.columns?.find((c) => c.toLowerCase() === "day") ?? "day";
        const rows = a.rows ?? [];
        out[ch.channelId] = rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
        for (const r of rows) {
          const d = String(r[dayKey] ?? "");
          if (d) byDay.set(d, (byDay.get(d) ?? 0) + (Number(r[key]) || 0));
        }
      } catch {
        failed += 1;
      }
    }
    setRevenue(out);
    setDaily(
      [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, amount]) => ({ date, dayLabel: `${Number(date.slice(8, 10))}일`, amount })),
    );
    setRevenueError(failed > 0 ? `채널 ${failed}곳의 수익을 불러오지 못했습니다` : null);
    setRevenueReady(true);
  }, [caps.revenue, monetary]);

  useEffect(() => { void loadRevenue(); }, [loadRevenue]);

  const today = new Date();
  const expiringPrograms = programs.filter((p) => {
    if (normalizeProgramStatus(p.status) === "upcoming") return false;
    return rightsWindowOf(p, today)?.expiring === true;
  });

  const totalRevenue = Object.values(revenue).reduce((a, b) => a + b, 0);
  const shown = revenueDisplay(role, totalRevenue, WON);
  // 조회 전/조회 중에는 ₩0 이 아니라 "—" 다. 마스킹("비공개")은 그대로 우선한다.
  const pending = caps.revenue && (!channelsReady || (monetary.length > 0 && !revenueReady));
  const totalText = shown.masked ? shown.text : pending ? "—" : shown.text;

  const ranked = useMemo(
    () => monetary
      .map((c) => ({ ch: c, amount: revenue[c.channelId] ?? 0 }))
      .sort((a, b) => b.amount - a.amount),
    [monetary, revenue],
  );

  const recent = useMemo(() => recentDistributions(clips, 10), [clips]);

  return (
    <>
      {/* 원본 <Header /> 는 props 가 없어 부제가 사라진다 — 레거시 상단바가 그리던 문구를 명시한다. */}
      <Header title="대시보드" subtitle="수익 · 채널 순위 · 최근 배포" />

      {/* Dashboard Main Content Body - Scrollable Container */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto space-y-8">
        <div className="space-y-8">
          {/* 권리 만료 임박 — 원본에 없다. 빼면 만료를 알려 주는 화면이 시스템에 안 남는다. */}
          {expiringPrograms.length > 0 && (
            <div className="rounded-xl px-4 py-3 text-xs leading-relaxed bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20">
              권리 만료 임박:{" "}
              {expiringPrograms.slice(0, 5).map((p) => p.title).join(" · ")}
              {expiringPrograms.length > 5 ? ` 외 ${expiringPrograms.length - 5}개` : ""}
              {" — "}만료돼도 배포가 자동으로 막히지는 않습니다. 만료일은 프로그램 설정에서 관리합니다.
            </div>
          )}

          {/* Top Section: Revenue Card & Channel Rank Card (Fixed Height 260px) */}
          <div className="grid grid-cols-2 gap-5 h-[260px] shrink-0">
            {/* ── 수익 카드 (원본 revenue-card.tsx) ── */}
            <div className="bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 flex flex-col justify-between h-full select-none">
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-base font-bold text-[var(--color-text-primary)]">수익</span>
                  <span className="text-xs text-[var(--color-text-muted)] font-normal">(최근 28일)</span>
                </div>

                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">
                    {totalText}
                  </span>
                </div>
              </div>

              {/* STEP D Brand Blue (#1C60FF) Curved Line + Gradient Area Chart */}
              <div className="w-full h-24 my-1">
                <ResponsiveContainer width="100%" height="100%">
                  {/* 마스킹된 역할에는 추이도 그리지 않는다 — 모양만으로도 규모가 읽힌다. */}
                  <AreaChart data={shown.masked ? [] : daily} margin={{ top: 10, right: 6, left: 6, bottom: 0 }}>
                    <defs>
                      <linearGradient id="blueGradientRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1C60FF" stopOpacity={0.45} />
                        <stop offset="60%" stopColor="#1C60FF" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#1C60FF" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="dayLabel" hide />
                    <YAxis hide domain={["dataMin - 50000", "dataMax + 50000"]} />
                    <Tooltip content={<RevenueTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="amount"
                      stroke="#1C60FF"
                      strokeWidth={2.5}
                      fillOpacity={1}
                      fill="url(#blueGradientRevenue)"
                      activeDot={{ r: 5, fill: "#FFFFFF", stroke: "#1C60FF", strokeWidth: 2.5 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Card Details / Footer Status */}
              <div className="space-y-1 text-xs pt-2.5 border-t border-[var(--color-border-subtle)]">
                <div className="flex items-center justify-between text-[var(--color-text-muted)]">
                  <span>수익 집계 가능 채널</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">{monetary.length}곳</span>
                </div>
                <div className="flex items-center justify-between text-[var(--color-text-muted)]">
                  <span>권한</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {caps.revenue ? "있음" : "없음"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--color-text-muted)]">
                  <span>업로드 전용</span>
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {uploadOnly > 0 ? `${uploadOnly}곳 - 구조적으로 데이터 없음` : "없음"}
                  </span>
                </div>
                {/* 부분 실패 — 채널 3곳 중 1곳만 실패해도 합계는 조용히 작아진다. */}
                {revenueError && (
                  <div className="text-[11px] text-[var(--color-text-muted)] pt-0.5">{revenueError}</div>
                )}
              </div>
            </div>

            {/* ── 채널별 수익 (원본 channel-rank-card.tsx) ── */}
            <div className="bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 flex flex-col justify-start h-full select-none">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold text-[var(--color-text-primary)]">채널별 수익</span>
                  <span className="text-xs text-[var(--color-text-muted)] font-normal">(최근 28일)</span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto max-h-[175px] pr-1 divide-y divide-[var(--color-border-subtle)]/40">
                {ranked.length === 0 ? (
                  <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
                    {channelsReady ? "수익을 집계할 채널이 없습니다" : "불러오는 중…"}
                  </div>
                ) : ranked.slice(0, 10).map(({ ch, amount }, i) => {
                  const money = revenueDisplay(role, amount, WON);
                  // 분모는 **합계로 계산한다** — 원본은 23150000 이 박혀 있어 목 실제 합과도 안 맞았다.
                  const pct = !money.masked && totalRevenue > 0 ? ((amount / totalRevenue) * 100).toFixed(1) : null;
                  return (
                    <div
                      key={ch.channelId}
                      className="flex items-center justify-between py-2.5 px-2 rounded-lg hover:bg-[var(--color-bg-card-hover)] transition-colors cursor-pointer group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-200 dark:bg-stone-700 shrink-0 flex items-center justify-center border border-slate-200/60 dark:border-stone-700/60 shadow-2xs group-hover:scale-105 transition-transform">
                          {ch.thumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element -- 유튜브 채널 아바타
                            <img src={ch.thumbnail} alt={ch.channelName} className="w-full h-full object-cover rounded-full" />
                          ) : (
                            <div className="w-full h-full rounded-full flex items-center justify-center text-white text-xs font-bold bg-[#1C60FF]">
                              {ch.channelName.slice(0, 1)}
                            </div>
                          )}
                        </div>
                        <span className="font-bold text-xs text-[var(--color-text-primary)] truncate max-w-[170px]">
                          {ch.channelName}
                        </span>
                      </div>

                      <div className="shrink-0 ml-2">
                        <span
                          className={`inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                            i === 0
                              ? "bg-[#1C60FF]/15 text-[#1C60FF] dark:text-blue-400 border border-[#1C60FF]/30"
                              : "bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700/80"
                          }`}
                        >
                          {/* 원본은 `|| '₩0'` 이라 **미조회를 0원으로 단정**했다 — 모르면 `—` 다. */}
                          <span>{money.masked ? money.text : pending ? "—" : WON(amount)}</span>
                          {/* 마스킹되면 퍼센트도 숨긴다 — 안 그러면 마스킹이 퍼센트로 뚫린다. */}
                          {pct != null && (
                            <span className="text-[10px] font-semibold opacity-75">({pct}%)</span>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bottom Section: Deployment History List */}
          <div className="w-full shrink-0 pt-2">
            <div className="bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 select-none overflow-hidden flex flex-col justify-between">
              <div className="flex items-center justify-between mb-4 shrink-0 px-1">
                <h2 className="flex items-center gap-2">
                  <span className="text-base font-bold text-[var(--color-text-primary)]">배포 기록</span>
                </h2>
                <Link
                  href="/distribution"
                  className="text-xs text-[var(--color-text-accent)] font-semibold hover:underline cursor-pointer"
                >
                  전체보기
                </Link>
              </div>

              <div className="w-full overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border-subtle)] text-[var(--color-text-muted)] text-[11px] font-medium">
                      <th className="pb-3 pt-1 pl-3 pr-4 font-semibold min-w-[240px]">제목</th>
                      <th className="pb-3 pt-1 px-3 font-semibold min-w-[90px]">프로그램</th>
                      <th className="pb-3 pt-1 px-3 font-semibold min-w-[70px]">회차</th>
                      <th className="pb-3 pt-1 px-3 font-semibold min-w-[90px]">배포 채널</th>
                      <th className="pb-3 pt-1 px-3 font-semibold text-center min-w-[70px]">상태</th>
                      <th className="pb-3 pt-1 pl-3 pr-3 font-semibold text-right min-w-[90px]">일시</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-[var(--color-border-subtle)]/30">
                    {recent.length === 0 ? (
                      <tr><td colSpan={6} className="py-6 text-center text-[var(--color-text-muted)]">
                        아직 배포 기록이 없습니다.
                      </td></tr>
                    ) : recent.map((row, i) => {
                      const ep = episodes.find((e) => e.id === row.clip.episodeId);
                      const prog = programs.find((p) => p.id === ep?.programId)?.title
                        ?? programs.find((p) => p.id === row.clip.programId)?.title
                        ?? row.clip.programTitle ?? "—";
                      return (
                        <tr
                          key={`${row.clip.id}-${row.channel}-${i}`}
                          className="hover:bg-[var(--color-bg-card-hover)] transition-colors group cursor-pointer rounded-xl"
                        >
                          <td className="py-3.5 pl-3 pr-4 font-medium text-[var(--color-text-primary)] truncate max-w-[300px] rounded-l-xl" title={row.clip.title}>
                            {row.clip.title}
                          </td>
                          {/* 원본은 '리센느' 가 박혀 있었다 — 목 필드조차 안 읽었다. */}
                          <td className="py-3.5 px-3 text-[var(--color-text-secondary)] font-normal">
                            {prog}
                          </td>
                          <td className="py-3.5 px-3 text-[var(--color-text-secondary)] font-normal">
                            {ep?.episodeNumber != null ? `회차 ${ep.episodeNumber}` : "—"}
                          </td>
                          <td className="py-3.5 px-3">
                            <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800/90 text-slate-700 dark:text-slate-300 border-none uppercase font-bold tracking-wider shadow-xs">
                              {channelLabel(row.channel)}
                            </span>
                          </td>
                          <td className="py-3.5 px-3 text-center">
                            <StatusPill status={row.status} />
                          </td>
                          {/* 원본은 `|| '08-26 12:00'` 로 **날짜를 지어냈다**. 모르면 `—`. */}
                          <td
                            className="py-3.5 pl-3 pr-3 text-right text-[11px] font-mono text-[var(--color-text-muted)] font-medium rounded-r-xl whitespace-nowrap"
                            title={row.at ? "예약일 기준" : undefined}
                          >
                            {fmtReserve(row.at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Fixed Footer */}
        <Footer />
      </main>
    </>
  );
}

interface RevenueTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { dayLabel: string; date: string; amount: number } }>;
}

function RevenueTooltip({ active, payload }: RevenueTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-lg p-2.5 shadow-xl text-xs space-y-1 select-none font-sans">
        <div className="text-[10px] text-[var(--color-text-muted)] font-semibold">
          {data.date} ({data.dayLabel})
        </div>
        <div className="flex items-center justify-between gap-4 pt-1">
          <span className="text-[11px] text-[var(--color-text-secondary)]">일일 수익</span>
          <span className="font-bold text-[#1C60FF] text-xs">₩{data.amount.toLocaleString()}</span>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * 상태 pill — 원본은 **초록 하나뿐**이라 실패도 성공처럼 보인다. 초록/앰버/장미 3색으로
 * 나누되 클래스 언어는 원본(`/media` 배지)과 같은 것을 쓴다.
 */
function StatusPill({ status }: { status: string }) {
  const label =
    status === "published" ? "게시됨"
      : status === "failed" ? "실패"
      : status === "scheduled" ? "예약됨"
      : status === "recorded" ? "기록됨"
      : "대기";
  const tone =
    status === "published"
      ? "bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400"
      : status === "failed"
        ? "bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400"
        : "bg-[#FFFBEB] text-[#D97706] dark:bg-amber-500/20 dark:text-amber-400";
  return (
    <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[10px] border-none font-bold ${tone}`}>
      {label}
    </span>
  );
}

function recentDistributions(clips: Clip[], limit: number) {
  const rows: { clip: Clip; channel: string; status: string; at: string }[] = [];
  for (const clip of clips) {
    for (const d of clip.distributions ?? []) {
      // 배포 안 한 채널이 표에 들어오면 안 된다.
      if (d.status === "none") continue;
      rows.push({ clip, channel: d.channel, status: d.status, at: d.reserveDate ?? "" });
    }
  }
  return rows.slice(0, limit);
}

/**
 * 예약일 → "MM-DD HH:mm". 저장 형식이 한 가지가 아니다:
 *  - 실제 경로는 `<input type="datetime-local">` 값을 **그대로** 저장한다 → "2026-08-11T10:00".
 *  - 로컬 더미데이터만 14자리 "YYYYMMDDHHmmss" 다.
 * 둘 다 받고, 어느 쪽도 아니면 **추측하지 말고** "—". (원본은 여기서 날짜를 지어냈다.)
 */
function fmtReserve(at: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (iso) return `${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}`;
  if (/^\d{12,14}$/.test(at)) {
    return `${at.slice(4, 6)}-${at.slice(6, 8)} ${at.slice(8, 10)}:${at.slice(10, 12)}`;
  }
  return "—";
}

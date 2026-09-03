"use client";

/**
 * 성과 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/performance/page.tsx` 304줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼만 뺐다((app)/layout.tsx 가 그린다).
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `channelDataMap` 4채널 하드코딩 | `fetchYouTubeChannels()` + `fetchChannelAnalytics()` |
 * | `tabs` 배열 + `tag: '업로드 전용'` | 채널의 실제 `analyticsScope` |
 * | 일별 시계열 목 | 애널리틱스 `rows`(day 차원)에서 생성 |
 * | 툴팁 `08/${day}` | 실제 날짜(ISO)에서 MM/DD |
 *
 * ## 원본에 없어서 **반드시 지켜야** 하는 것 (빼면 사고다)
 *  1. **수익 마스킹** — 권한 없는 역할에는 `estimatedRevenue` 를 **요청 자체를 안 한다.**
 *     서버는 역할을 안 보므로, 요청하면 실수치가 브라우저까지 내려온다.
 *  2. **없음(⊘)과 0 을 구분** — rows 가 비면 `0` 이 아니라 `—` 다. 0 을 찍으면 실측치처럼 보인다.
 *  3. **집계 창과 라벨 일치** — 카드가 "최근 28일" 이라고 적으므로 조회도 28일이어야 한다.
 *  4. 채널 0개·조회 실패 상태 — 목업엔 없다(항상 4채널).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Layers } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useSession } from "@/lib/auth";
import {
  fetchChannelAnalytics,
  fetchYouTubeChannels,
  type ChannelAnalytics,
  type YouTubeChannelInfo,
} from "@/lib/data/api";
import { blockedCopy, revenueDisplay, roleOf } from "@/lib/roles";

const WON = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;
const NUM = (n: number) => Math.round(n).toLocaleString("ko-KR");

/** 지표 집계 창. 카드 라벨과 **같은 숫자**여야 한다 — 라벨만 28일이고 조회는 90일이면 거짓말이다. */
const WINDOW_DAYS = 28;

/** 로컬 날짜 기준 YYYY-MM-DD. toISOString 은 UTC 라 KST 새벽에 하루가 밀린다. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function windowOf(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { day: string; val: number } }>;
}

/** 원본 그대로. 다만 날짜는 목업의 `08/${숫자}` 가 아니라 실제 ISO 날짜에서 MM/DD 로 만든다. */
function MetricTooltip({ active, payload }: CustomTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const formattedDate = data.day.length >= 10 ? data.day.slice(5).replace("-", "/") : data.day;
    return (
      <div className="bg-[var(--color-bg-card)] border border-[var(--color-border-card)] rounded-lg px-3 py-2 shadow-xl text-xs space-y-1 select-none font-sans z-50 min-w-[76px] text-center">
        {/* Top: Month/Day date */}
        <div className="text-[11px] text-[var(--color-text-muted)] font-medium">
          {formattedDate}
        </div>
        {/* Bottom: Number only */}
        <div className="font-extrabold text-[var(--color-text-primary)] text-sm font-mono">
          {data.val.toLocaleString()}
        </div>
      </div>
    );
  }
  return null;
}

export default function PerformancePage() {
  const session = useSession();
  const role = session.user.role;
  const caps = roleOf(role);

  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [data, setData] = useState<ChannelAnalytics | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchYouTubeChannels()
      .then((cs) => {
        if (!alive) return;
        const active = cs.filter((c) => c.status === "active");
        setChannels(active);
        setPicked((p) => p ?? active[0]?.channelId ?? null);
      })
      .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const channel = channels.find((c) => c.channelId === picked) ?? null;

  /** 업로드 전용 연결이면 지표가 **구조적으로 없다** — 0 이 아니라 없음이다. */
  const blocked: "upload_only" | null = useMemo(
    () => (channel ? (channel.hasMonetaryScope ? null : "upload_only") : null),
    [channel],
  );

  const load = useCallback(async () => {
    if (!channel || blocked) { setData(null); return; }
    try {
      const win = windowOf(WINDOW_DAYS);
      // 수익 열람 권한이 없으면 estimatedRevenue 를 **요청하지 않는다** — 서버는 역할을
      // 보지 않으므로, 요청하면 응답에 실수치가 담겨 브라우저까지 내려온다.
      const metrics = caps.revenue
        ? "views,estimatedMinutesWatched,estimatedRevenue"
        : "views,estimatedMinutesWatched";
      setData(await fetchChannelAnalytics(channel.channelId, { start: win.start, end: win.end, metrics }));
      setLoadErr(null);
    } catch (err) {
      setData(null);
      setLoadErr(err instanceof Error ? err.message : String(err));
    }
  }, [channel, blocked, caps.revenue]);

  useEffect(() => { void load(); }, [load]);

  /** 지표 열 이름 찾기 — 서버가 주는 columns 는 API 이름 그대로다. */
  const colOf = (needle: string) => data?.columns?.find((c) => c.toLowerCase().includes(needle)) ?? null;

  /**
   * 구간 합계. **데이터가 없으면 0 이 아니라 null(= 알 수 없음)** 이다.
   * columnHeaders 는 결과가 없어도 그대로 오고 rows 만 `[]` 다 — 그때 reduce(…,0) 를
   * 태우면 "0" 이 실측치처럼 찍힌다.
   */
  const total = (needle: string): number | null => {
    const key = colOf(needle);
    const rows = data?.rows ?? [];
    if (!key || rows.length === 0) return null;
    return rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  };

  /** 스파크라인 시계열 — 원본의 `viewsData` 자리. 일 차원 행을 그대로 쓴다. */
  const series = (needle: string): { day: string; val: number }[] => {
    const key = colOf(needle);
    const dayKey = data?.columns?.find((c) => c.toLowerCase() === "day") ?? "day";
    const rows = data?.rows ?? [];
    if (!key) return [];
    return rows.map((r) => ({ day: String(r[dayKey] ?? ""), val: Number(r[key]) || 0 }));
  };

  const viewsAmount = total("views");
  const watchAmount = total("minuteswatched");
  const revenueAmount = total("revenue");
  // 마스킹이 "모름" 보다 우선한다 — 권한 없는 사람에게는 데이터 유무조차 알릴 필요가 없다.
  const revenue = revenueDisplay(role, revenueAmount ?? 0, WON);
  const revenueText = revenue.masked ? revenue.text : revenueAmount === null ? "—" : revenue.text;

  return (
    <>
      {/* Header */}
      <Header title="성과" subtitle="채널별 지표 · 권한 없는 채널은 사유 표시" />

      {/* Performance Main Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-hidden">
        <div className="space-y-4 flex-1 flex flex-col">
          {/* Channel Tabs (Equal Height h-10, No Border, Soft Shadow) */}
          {channels.length === 0 ? (
            // 원본엔 없던 상태 — 목업은 항상 4채널이었다.
            <p className="text-xs text-[var(--color-text-muted)]">
              {loadErr ? `채널을 불러오지 못했습니다 (${loadErr})` : "연결된 채널이 없습니다"} —{" "}
              <Link href="/publish-channels" className="text-[var(--color-text-accent)] hover:underline">
                배포 채널 연동
              </Link>
            </p>
          ) : (
            <div className="h-10 bg-white dark:bg-[#1C1E24] p-1 rounded-full shadow-none flex items-center gap-1 text-xs border-none w-fit">
              {channels.map((tab) => (
                <button
                  key={tab.channelId}
                  onClick={() => setPicked(tab.channelId)}
                  className={`h-8 px-3.5 rounded-full font-medium transition-colors cursor-pointer select-none flex items-center gap-1.5 ${
                    picked === tab.channelId
                      ? "bg-[var(--color-bg-active)] text-white shadow-md shadow-[#1C60FF]/25 font-bold"
                      : "text-slate-600 dark:text-slate-400 hover:text-black dark:hover:text-white"
                  }`}
                >
                  <span>{tab.channelName}</span>
                  {!tab.hasMonetaryScope && (
                    <span className="text-[11px] font-normal opacity-85">
                      업로드 전용
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Display Content: Upload-Only Empty State OR 3 Metric Cards (No Border, Soft Shadow) */}
          {blocked ? (
            <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-12 flex flex-col items-center justify-center text-center space-y-4 min-h-[280px]">
              {/* Watermark Icon */}
              <div className="w-12 h-12 rounded-full bg-[var(--color-bg-input)] flex items-center justify-center text-[var(--color-text-muted)] opacity-50 mb-1">
                <Layers className="w-6 h-6 text-[var(--color-text-muted)]" />
              </div>

              <div className="space-y-1.5 max-w-md">
                <h3 className="text-base font-bold text-[var(--color-text-primary)]">
                  {blockedCopy(blocked).title}
                </h3>
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                  {blockedCopy(blocked).body}
                </p>
              </div>

              <Link
                href="/publish-channels"
                className="mt-2 inline-flex items-center px-4 py-2 rounded-lg bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium transition-colors cursor-pointer"
              >
                채널 연결 다시 보기
              </Link>
            </div>
          ) : channel ? (
            <div className="grid grid-cols-3 gap-4">
              <MetricCard
                label="조회수 (최근 28일)"
                value={viewsAmount === null ? "—" : NUM(viewsAmount)}
                gradId="viewsGrad"
                data={series("views")}
              />
              <MetricCard
                label="시청 시간(분) (최근 28일)"
                value={watchAmount === null ? "—" : NUM(watchAmount)}
                gradId="watchGrad"
                data={series("minuteswatched")}
              />
              <MetricCard
                label="수익 (최근 28일)"
                value={revenueText}
                gradId="revenueGrad"
                // 마스킹된 역할에는 추이도 그리지 않는다 — 모양만으로도 규모가 읽힌다.
                data={revenue.masked ? [] : series("revenue")}
              />
            </div>
          ) : null}

          {/* 원본엔 없는 상태 — 목업은 조회가 실패할 수 없었다. 실패를 조용한 빈 화면으로 두면
              "데이터가 0" 과 구분이 안 된다. 다시 시도할 손잡이까지 준다. */}
          {loadErr && channels.length > 0 && !blocked && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span>지표를 불러오지 못했습니다 ({loadErr})</span>
              <button
                onClick={() => { void load(); }}
                className="px-3 py-1 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer"
              >
                다시 조회
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

/**
 * 지표 카드 — 원본에 세 번 복붙돼 있던 것을 한 조각으로 뽑았다(클래스·구조 동일).
 * 다른 건 라벨·값·그라디언트 id 뿐이라, 원본에서도 그 셋만 달랐다.
 */
function MetricCard({
  label, value, gradId, data,
}: {
  label: string; value: string; gradId: string; data: { day: string; val: number }[];
}) {
  return (
    <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-5 flex flex-col justify-between h-44">
      <div>
        <div className="text-xs text-[var(--color-text-muted)] flex items-center justify-between mb-1">
          <span>{label}</span>
        </div>
        <div className="text-3xl font-extrabold text-[var(--color-text-primary)] tracking-tight">
          {value}
        </div>
      </div>
      <div className="w-full h-16 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 2, left: 2, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1C60FF" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#1C60FF" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" hide />
            <Tooltip content={<MetricTooltip />} />
            <Area
              type="monotone"
              dataKey="val"
              stroke="#1C60FF"
              strokeWidth={2}
              fill={`url(#${gradId})`}
              activeDot={{ r: 4, fill: "#FFFFFF", stroke: "#1C60FF", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

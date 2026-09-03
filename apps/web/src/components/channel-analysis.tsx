"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { fetchChannelDaily, type ChannelDailyRow } from "@/lib/data/api";

/**
 * Compact read-only analysis panel for one channel — shows what's been collected so far.
 * Analysis now runs automatically the moment a channel is connected (server-side), so
 * there is no manual "분석" trigger here anymore.
 */
export function ChannelAnalysis({ channelId }: { channelId: string }) {
  const [rows, setRows] = useState<ChannelDailyRow[] | null>(null);
  // 실패를 빈 배열로 뭉개면 "데이터 없음"과 구분이 안 된다 — 사유를 따로 들고 있는다.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetchChannelDaily(channelId, 90)
      .then(setRows)
      .catch((e: unknown) => {
        setRows([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [channelId]);

  const summary = rows && rows.length > 0 ? summarize(rows) : null;

  return (
    <div className="flex items-center gap-4 text-[11px] text-[var(--color-text-muted)] pt-3.5 font-mono border-t border-[var(--color-border-subtle)]/60 flex-wrap">
      {error ? (
        <span className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 font-medium">
          <BarChart3 className="w-3.5 h-3.5" />
          분석 데이터를 불러오지 못했습니다 ({error})
        </span>
      ) : summary ? (
        <>
          <Metric label="조회수(90일)" value={fmt(summary.views)} />
          <Metric label="시청시간(시간)" value={fmt(Math.round(summary.watchMinutes / 60))} />
          <Metric label="구독자 순증" value={signed(summary.netSubs)} up={summary.netSubs > 0} />
          <Metric label="수집일수" value={`${summary.days}일`} />
        </>
      ) : rows === null ? (
        <span>불러오는 중…</span>
      ) : (
        <span className="flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5" />
          아직 수집된 분석 데이터가 없습니다
        </span>
      )}
    </div>
  );
}

function summarize(rows: ChannelDailyRow[]) {
  let views = 0;
  let watchMinutes = 0;
  let netSubs = 0;
  for (const r of rows) {
    views += r.views;
    watchMinutes += r.estimatedMinutesWatched;
    netSubs += r.subscribersGained - r.subscribersLost;
  }
  return { views, watchMinutes, netSubs, days: rows.length };
}

/** 원본 4지표 줄(publish-channels D:1026) — 지표 이름 4개가 정확히 같다. */
function Metric({ label, value, up }: { label: string; value: string; up?: boolean }) {
  return (
    <span>
      {label}{" "}
      <strong className={`font-bold ${up ? "text-[#059669] dark:text-emerald-400" : "text-[var(--color-text-primary)]"}`}>
        {value}
      </strong>
    </span>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function signed(n: number): string {
  return (n > 0 ? "+" : "") + n.toLocaleString("ko-KR");
}

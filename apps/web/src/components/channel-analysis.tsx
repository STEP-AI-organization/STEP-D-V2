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

  useEffect(() => {
    fetchChannelDaily(channelId, 90).then(setRows).catch(() => setRows([]));
  }, [channelId]);

  const summary = rows && rows.length > 0 ? summarize(rows) : null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      {summary ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <Metric label="조회수(90일)" value={fmt(summary.views)} />
          <Metric label="시청시간(시간)" value={fmt(Math.round(summary.watchMinutes / 60))} />
          <Metric label="구독자 순증" value={signed(summary.netSubs)} />
          <Metric label="수집일수" value={`${summary.days}일`} />
        </div>
      ) : rows === null ? (
        <span className="text-xs text-muted-foreground">불러오는 중…</span>
      ) : (
        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{label} </span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function signed(n: number): string {
  return (n > 0 ? "+" : "") + n.toLocaleString("ko-KR");
}

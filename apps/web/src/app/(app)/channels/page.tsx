"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { RefreshCw, TrendingUp, Eye, ThumbsUp, MessageCircle, Play, AlertCircle, Clock, Percent, Share2, UserPlus, DollarSign, Coins, Search, ChevronLeft, ChevronRight, Users, Timer, Wallet } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import {
  fetchYouTubeChannels,
  fetchChannelVideos,
  fetchChannelTrends,
  fetchVideoTrend,
  fetchVideoAnalytics,
  syncChannelVideos,
  type YouTubeChannelInfo,
  type VideoAnalytics,
} from "@/lib/data/api";
import type {
  YouTubeChannelVideo,
  ChannelTrendSummary,
  DailyTrend,
  VideoTrend,
} from "@/lib/types";

function fmt(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`;
  return String(n);
}

function fmtDate(ts: string | number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

/** Seconds → m:ss (average view duration). */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** USD amount (YouTube revenue metrics are USD). */
function fmtUsd(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(2)}`;
}

/** Growth display: huge % on a tiny prior base reads like a bug, so show it as a
 *  multiplier (×N) once it's large, "신규" when there's no prior base, else a plain %. */
function growthDisplay(s: ChannelTrendSummary): { text: string; tone: "done" | "error" | "idle" | "progress" } {
  if (s.earlierPeriodViews === 0) {
    return { text: s.recentPeriodViews > 0 ? "신규" : "—", tone: "progress" };
  }
  const g = s.growthPercent;
  if (g >= 1000) return { text: `×${Math.round(g / 100 + 1)}`, tone: "done" };
  return { text: `${g > 0 ? "+" : ""}${g}%`, tone: g > 0 ? "done" : g < 0 ? "error" : "idle" };
}

/** Watch minutes → hours label. */
function fmtHours(min: number): string {
  const h = min / 60;
  if (h >= 10000) return `${(h / 10000).toFixed(1)}만시간`;
  if (h >= 1000) return `${(h / 1000).toFixed(1)}천시간`;
  return `${Math.round(h).toLocaleString("ko-KR")}시간`;
}

const VIDEO_PAGE_SIZE = 12;
type VideoSort = "recent" | "views" | "comments";
const SORT_TABS: { key: VideoSort; label: string }[] = [
  { key: "recent", label: "최신순" },
  { key: "views", label: "조회수순" },
  { key: "comments", label: "댓글순" },
];

/** YouTube Analytics traffic-source codes → Korean labels. */
const TRAFFIC_LABELS: Record<string, string> = {
  YT_SEARCH: "YouTube 검색",
  YT_RELATED: "추천 영상",
  YT_CHANNEL: "채널 페이지",
  SUBSCRIBER: "구독 피드",
  SHORTS: "Shorts 피드",
  PLAYLIST: "재생목록",
  EXT_URL: "외부 링크",
  NO_LINK_OTHER: "직접/기타",
  NO_LINK_EMBEDDED: "임베드",
  NOTIFICATION: "알림",
  ADVERTISING: "광고",
};
const trafficLabel = (s: string) => TRAFFIC_LABELS[s] ?? s;

export default function ChannelTrendsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [videos, setVideos] = useState<YouTubeChannelVideo[]>([]);
  const [trend, setTrend] = useState<DailyTrend[]>([]);
  const [summary, setSummary] = useState<ChannelTrendSummary | null>(null);
  const [videoTrend, setVideoTrend] = useState<VideoTrend | null>(null);
  const [videoAnalytics, setVideoAnalytics] = useState<VideoAnalytics | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoSearch, setVideoSearch] = useState("");
  const [videoSort, setVideoSort] = useState<VideoSort>("recent");
  const [videoPage, setVideoPage] = useState(0);

  useEffect(() => {
    fetchYouTubeChannels()
      .then(setChannels)
      .catch((e) => setError(e.message));
  }, []);

  const loadChannelData = useCallback(async (channelId: string) => {
    setLoadingVideos(true);
    setLoadingTrend(true);
    setError(null);
    try {
      const [v, t] = await Promise.all([
        fetchChannelVideos(channelId),
        fetchChannelTrends(channelId, 90),
      ]);
      setVideos(v.videos);
      setTrend(t.trend);
      setSummary(t.summary);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingVideos(false);
      setLoadingTrend(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadChannelData(selectedId);
  }, [selectedId, loadChannelData]);

  const handleSync = async () => {
    if (!selectedId) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await syncChannelVideos(selectedId);
      await loadChannelData(selectedId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleVideoClick = async (videoId: string) => {
    setVideoTrend(null);
    setVideoAnalytics(null);
    setError(null);
    // Independent so one failing (or empty) never blanks the other.
    const [vt, va] = await Promise.all([
      fetchVideoTrend(videoId, 30).catch(() => null),
      fetchVideoAnalytics(videoId).catch(() => null),
    ]);
    setVideoTrend(vt);
    setVideoAnalytics(va);
    if (!vt && !va) setError("영상 데이터를 불러오지 못했습니다.");
  };

  const selectedChannel = channels.find((c) => c.channelId === selectedId);

  // Reset paging whenever the filter/sort/channel changes.
  useEffect(() => setVideoPage(0), [videoSearch, videoSort, selectedId]);

  // Search + sort + paginate client-side so large channels (thousands of uploads) stay usable.
  const shownVideos = useMemo(() => {
    const q = videoSearch.trim().toLowerCase();
    const list = q ? videos.filter((v) => v.title.toLowerCase().includes(q)) : videos;
    if (videoSort === "recent") return list; // server already returns newest-first
    return [...list].sort((a, b) =>
      videoSort === "views" ? b.viewCount - a.viewCount : b.commentCount - a.commentCount,
    );
  }, [videos, videoSearch, videoSort]);
  const totalPages = Math.max(1, Math.ceil(shownVideos.length / VIDEO_PAGE_SIZE));
  const page = Math.min(videoPage, totalPages - 1);
  const pagedVideos = shownVideos.slice(page * VIDEO_PAGE_SIZE, (page + 1) * VIDEO_PAGE_SIZE);
  const periodDays = summary?.periodDays ?? 90;

  return (
    <>
      <PageHeader
        title="채널 트렌드"
        description="YouTube 채널별 영상 조회수 추세와 성과 분석"
      />

      {/* Channel selector + sync */}
      <div className="mb-4 flex items-center gap-3">
        <select
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          value={selectedId}
          onChange={(e) => { setSelectedId(e.target.value); setVideoTrend(null); }}
        >
          <option value="">— 채널 선택 —</option>
          {channels.map((ch) => (
            <option key={ch.channelId} value={ch.channelId}>
              {ch.channelName}
            </option>
          ))}
        </select>
        {selectedId && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "동기화 중..." : "YouTube 동기화"}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-status-error/10 p-3 text-sm text-status-error">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {selectedId && summary && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              icon={Eye}
              tone="progress"
              label={`최근 ${periodDays}일 조회수`}
              value={fmt(summary.recentPeriodViews)}
              sub="YouTube 실제 일별 합계"
            />
            <StatTile
              icon={TrendingUp}
              tone={growthDisplay(summary).tone}
              label="성장률"
              value={growthDisplay(summary).text}
              sub={`이전 ${periodDays}일 대비`}
            />
            <StatTile
              icon={Timer}
              label="시청 시간"
              value={fmtHours(summary.watchMinutes ?? 0)}
              sub={`최근 ${periodDays}일`}
            />
            <StatTile
              icon={Users}
              tone={(summary.netSubscribers ?? 0) > 0 ? "done" : (summary.netSubscribers ?? 0) < 0 ? "error" : "idle"}
              label="순 구독자"
              value={`${(summary.netSubscribers ?? 0) > 0 ? "+" : ""}${fmt(summary.netSubscribers ?? 0)}`}
              sub={`최근 ${periodDays}일`}
            />
          </div>

          {/* Revenue dashboard — monetized channels only */}
          <div className="mb-6 rounded-xl border border-status-done/30 bg-status-done/5 p-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-status-done">
              <Wallet className="size-4" /> 수익 대시보드 (예상)
            </div>
            {(summary.channelRevenue ?? 0) > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-bold text-status-done">{fmtUsd(summary.channelRevenue ?? 0)}</span>
                <span className="text-xs text-muted-foreground">최근 {periodDays}일 채널 예상 수익 · 영상 클릭 시 영상별 수익</span>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                수익 지표는 <b className="text-foreground">수익화(YPP) 채널</b>을 <b className="text-foreground">소유자 권한(monetary)으로 재연결</b>하면 표시됩니다.
                지금 연결된 채널은 수익화 전이거나 예전 권한으로 연결돼 있어 매출 데이터가 없습니다.
              </p>
            )}
          </div>
        </>
      )}

      {/* Daily views trend — real daily data from channel_analytics (not since-connect) */}
      <Card className="mb-4 p-4">
        <h3 className="mb-3 flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          <TrendingUp className="size-4 text-status-progress" />
          일별 조회수 추세 ({periodDays}일)
          <span className="text-xs font-normal text-muted-foreground">· YouTube 실제 일별 조회수</span>
          {loadingTrend && <span className="ml-auto animate-pulse text-xs text-muted-foreground">로딩 중...</span>}
        </h3>
        {trend.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {selectedId ? "수집된 일별 데이터가 없습니다. YouTube 동기화 후 표시됩니다." : "채널을 선택해주세요."}
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(d: string) => d.slice(5)}
                  stroke="var(--color-muted-foreground)"
                />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} stroke="var(--color-muted-foreground)" />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-background)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [fmt(Number(value ?? 0)), "조회수"]}
                  labelFormatter={(label) => {
                    const d = String(label);
                    return `${d.slice(0, 4)}년 ${d.slice(5, 7)}월 ${d.slice(8)}일`;
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="totalViews"
                  stroke="var(--color-status-progress)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Video list — search + sort + pagination so channels with thousands of uploads stay usable */}
      {selectedId && (
        <Card className="p-0">
          <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Play className="size-4" /> 영상
              <span className="text-xs font-normal text-muted-foreground">
                {shownVideos.length.toLocaleString("ko-KR")}개
                {videoSearch && ` / 전체 ${videos.length.toLocaleString("ko-KR")}`}
              </span>
            </h3>
            <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={videoSearch}
                  onChange={(e) => setVideoSearch(e.target.value)}
                  placeholder="제목 검색"
                  className="w-40 rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-muted-foreground"
                />
              </div>
              <div className="flex rounded-md border border-border p-0.5">
                {SORT_TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setVideoSort(t.key)}
                    className={`rounded px-2 py-1 text-xs transition ${
                      videoSort === t.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loadingVideos ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <RefreshCw className="mr-2 size-4 animate-spin" /> 불러오는 중...
            </div>
          ) : shownVideos.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {videos.length === 0 ? "동기화 후 영상이 표시됩니다." : "검색 결과가 없습니다."}
            </p>
          ) : (
            <>
              <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {pagedVideos.map((v) => (
                  <button
                    key={v.videoId}
                    onClick={() => handleVideoClick(v.videoId)}
                    className={`flex gap-2 rounded-lg border p-2 text-left text-xs transition hover:bg-muted/50 ${
                      videoTrend?.video.videoId === v.videoId || videoAnalytics?.video.videoId === v.videoId
                        ? "border-primary/50 bg-muted/30"
                        : "border-border"
                    }`}
                  >
                    {v.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt="" className="h-14 w-24 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <Play className="size-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 line-clamp-2 font-medium leading-tight">{v.title}</p>
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
                        <span className="flex items-center gap-0.5"><Eye className="size-3" /> {fmt(v.viewCount)}</span>
                        <span className="flex items-center gap-0.5"><ThumbsUp className="size-3" /> {fmt(v.likeCount)}</span>
                        <span className="flex items-center gap-0.5"><MessageCircle className="size-3" /> {fmt(v.commentCount)}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{fmtDate(v.publishedAt)}</p>
                    </div>
                  </button>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 border-t border-border p-3 text-xs">
                  <button
                    onClick={() => setVideoPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 transition hover:bg-muted disabled:opacity-40"
                  >
                    <ChevronLeft className="size-3.5" /> 이전
                  </button>
                  <span className="tabular-nums text-muted-foreground">{page + 1} / {totalPages}</span>
                  <button
                    onClick={() => setVideoPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 transition hover:bg-muted disabled:opacity-40"
                  >
                    다음 <ChevronRight className="size-3.5" />
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Per-video detail: views trend + rich analytics (avg duration/%, traffic, retention, comments) */}
      {(videoTrend || videoAnalytics) && (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                {videoTrend?.video.title ?? videoAnalytics?.video.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const v = videoTrend?.video ?? videoAnalytics?.video;
                  return v ? `조회수 ${fmt(v.viewCount)} · 좋아요 ${fmt(v.likeCount)} · 댓글 ${fmt(v.commentCount)}` : "";
                })()}
              </p>
            </div>
            <button
              onClick={() => {
                setVideoTrend(null);
                setVideoAnalytics(null);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              닫기
            </button>
          </div>

          {/* engagement summary (YouTube Analytics) */}
          {videoAnalytics &&
            (videoAnalytics.summary.averageViewDuration != null ||
              videoAnalytics.summary.averageViewPercentage != null ||
              videoAnalytics.summary.shares != null ||
              videoAnalytics.summary.subscribersGained != null) && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile
                  icon={Clock}
                  label="평균 시청 시간"
                  value={
                    videoAnalytics.summary.averageViewDuration != null
                      ? fmtDur(videoAnalytics.summary.averageViewDuration)
                      : "—"
                  }
                />
                <StatTile
                  icon={Percent}
                  tone={(videoAnalytics.summary.averageViewPercentage ?? 0) >= 50 ? "done" : "progress"}
                  label="평균 시청률"
                  value={
                    videoAnalytics.summary.averageViewPercentage != null
                      ? `${videoAnalytics.summary.averageViewPercentage.toFixed(0)}%`
                      : "—"
                  }
                />
                <StatTile icon={Share2} label="공유" value={fmt(videoAnalytics.summary.shares ?? 0)} />
                <StatTile
                  icon={UserPlus}
                  tone={(videoAnalytics.summary.subscribersGained ?? 0) > 0 ? "done" : "idle"}
                  label="구독 전환"
                  value={`+${fmt(videoAnalytics.summary.subscribersGained ?? 0)}`}
                />
              </div>
            )}

          {/* revenue — only present on monetized channels with the monetary scope */}
          {videoAnalytics && videoAnalytics.summary.estimatedRevenue != null && (
            <div className="mb-4 rounded-lg border border-status-done/30 bg-status-done/5 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-status-done">
                <DollarSign className="size-3.5" /> 수익 (예상)
              </h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile icon={DollarSign} tone="done" label="예상 수익" value={fmtUsd(videoAnalytics.summary.estimatedRevenue ?? 0)} />
                <StatTile
                  icon={Coins}
                  label="CPM"
                  value={fmtUsd(videoAnalytics.summary.playbackBasedCpm ?? videoAnalytics.summary.cpm ?? 0)}
                />
                <StatTile icon={Eye} label="광고 노출" value={fmt(videoAnalytics.summary.adImpressions ?? 0)} />
                <StatTile icon={Play} label="수익 재생" value={fmt(videoAnalytics.summary.monetizedPlaybacks ?? 0)} />
              </div>
            </div>
          )}

          {/* daily views trend */}
          {videoTrend && videoTrend.trend.length > 0 ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={videoTrend.trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(d: string) => d.slice(5)}
                    stroke="var(--color-muted-foreground)"
                  />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} stroke="var(--color-muted-foreground)" />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-background)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => {
                      const labels: Record<string, string> = { views: "조회수", likes: "좋아요", comments: "댓글" };
                      const key = String(name);
                      return [fmt(Number(value ?? 0)), labels[key] ?? key];
                    }}
                  />
                  <Line type="monotone" dataKey="views" stroke="var(--color-status-progress)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="likes" stroke="var(--color-status-done)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="comments" stroke="var(--color-status-idle)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : videoTrend ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              일별 추세는 다음 동기화부터 쌓입니다.
            </p>
          ) : null}

          {/* traffic sources */}
          {videoAnalytics && videoAnalytics.trafficSources.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold text-muted-foreground">유입 경로</h4>
              <div className="space-y-1.5">
                {(() => {
                  const max = Math.max(...videoAnalytics.trafficSources.map((t) => t.views), 1);
                  return [...videoAnalytics.trafficSources]
                    .sort((a, b) => b.views - a.views)
                    .map((t) => (
                      <div key={t.source} className="flex items-center gap-2 text-xs">
                        <span className="w-20 shrink-0 text-muted-foreground">{trafficLabel(t.source)}</span>
                        <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                          <div className="h-full rounded bg-status-progress" style={{ width: `${(t.views / max) * 100}%` }} />
                        </div>
                        <span className="w-8 shrink-0 text-right tabular-nums">{fmt(t.views)}</span>
                      </div>
                    ));
                })()}
              </div>
            </div>
          )}

          {/* audience demographics */}
          {videoAnalytics && videoAnalytics.demographics.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold text-muted-foreground">시청자 층</h4>
              <div className="flex flex-wrap gap-1.5">
                {videoAnalytics.demographics.slice(0, 8).map((d, i) => (
                  <span key={i} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    {d.gender === "male" ? "남" : d.gender === "female" ? "여" : d.gender ?? ""}{" "}
                    {d.ageGroup?.replace("age", "") ?? ""} · {(d.percentage ?? 0).toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* retention curve */}
          {videoAnalytics && videoAnalytics.retention.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold text-muted-foreground">시청 지속률</h4>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={videoAnalytics.retention}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      dataKey="ratio"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                      stroke="var(--color-muted-foreground)"
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                      stroke="var(--color-muted-foreground)"
                    />
                    <Line type="monotone" dataKey="watchRatio" stroke="var(--color-status-progress)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* top comments */}
          {videoAnalytics && videoAnalytics.comments.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold text-muted-foreground">인기 댓글</h4>
              <div className="space-y-2">
                {videoAnalytics.comments.slice(0, 5).map((cm, i) => (
                  <div key={i} className="rounded-md border border-border p-2 text-xs">
                    <div className="mb-0.5 flex items-center gap-2 text-muted-foreground">
                      <span className="font-medium text-foreground">{cm.author}</span>
                      <span className="flex items-center gap-0.5">
                        <ThumbsUp className="size-3" /> {fmt(cm.likeCount)}
                      </span>
                    </div>
                    <p className="line-clamp-2">{cm.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {videoAnalytics?.fetchedAt && (
            <p className="mt-3 text-[10px] text-muted-foreground">
              애널리틱스 수집 {fmtDate(Number(videoAnalytics.fetchedAt))}
              {videoAnalytics.summary.estimatedRevenue == null && " · 수익 지표 미포함 (채널 수익화 + monetary 권한 재연결 필요)"}
            </p>
          )}
        </Card>
      )}
    </>
  );
}
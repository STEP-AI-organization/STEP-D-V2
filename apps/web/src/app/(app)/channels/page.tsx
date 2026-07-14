"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, TrendingUp, Eye, ThumbsUp, MessageCircle, Play, AlertCircle } from "lucide-react";
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
  syncChannelVideos,
  type YouTubeChannelInfo,
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

export default function ChannelTrendsPage() {
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [videos, setVideos] = useState<YouTubeChannelVideo[]>([]);
  const [trend, setTrend] = useState<DailyTrend[]>([]);
  const [summary, setSummary] = useState<ChannelTrendSummary | null>(null);
  const [videoTrend, setVideoTrend] = useState<VideoTrend | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        fetchChannelTrends(channelId, 30),
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
    try {
      const vt = await fetchVideoTrend(videoId, 30);
      setVideoTrend(vt);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const selectedChannel = channels.find((c) => c.channelId === selectedId);

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
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            icon={Eye}
            label="총 조회수"
            value={fmt(summary.totalViews)}
          />
          <StatTile
            icon={Play}
            label="영상 수"
            value={String(summary.videoCount)}
          />
          <StatTile
            icon={TrendingUp}
            tone={summary.growthPercent > 0 ? "done" : summary.growthPercent < 0 ? "error" : "idle"}
            label="최근 30일 성장률"
            value={`${summary.growthPercent > 0 ? "+" : ""}${summary.growthPercent.toFixed(1)}%`}
            sub="전기 대비"
          />
          <StatTile
            icon={Eye}
            tone="progress"
            label="최근 30일 조회수"
            value={fmt(summary.recentPeriodViews)}
            sub={`이전: ${fmt(summary.earlierPeriodViews)}`}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main chart */}
        <Card className="p-4 lg:col-span-2">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <TrendingUp className="size-4 text-status-progress" />
            일별 총 조회수 추세 (30일)
            {loadingTrend && <span className="ml-auto animate-pulse text-xs text-muted-foreground">로딩 중...</span>}
          </h3>
          {trend.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              데이터가 없습니다. YouTube 동기화를 먼저 실행해주세요.
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
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={fmt}
                    stroke="var(--color-muted-foreground)"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-background)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value: number, name: string) => {
                      const labels: Record<string, string> = {
                        totalViews: "조회수",
                        totalLikes: "좋아요",
                      };
                      return [fmt(value), labels[name] ?? name];
                    }}
                    labelFormatter={(label: string) => `${label.slice(0, 4)}년 ${label.slice(5, 7)}월 ${label.slice(8)}일`}
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

        {/* Video list */}
        <Card className="flex flex-col overflow-hidden p-0">
          <div className="border-b border-border p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Play className="size-4" />
              영상 목록
              {videos.length > 0 && (
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {videos.length}개
                </span>
              )}
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingVideos ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <RefreshCw className="mr-2 size-4 animate-spin" />
                불러오는 중...
              </div>
            ) : videos.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {selectedId ? "동기화 후 영상이 표시됩니다." : "채널을 선택해주세요."}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {videos.map((v) => (
                  <button
                    key={v.videoId}
                    onClick={() => handleVideoClick(v.videoId)}
                    className={`flex w-full gap-2 p-3 text-left text-xs transition hover:bg-muted/50 ${
                      videoTrend?.video.videoId === v.videoId ? "bg-muted/30" : ""
                    }`}
                  >
                    {v.thumbnail ? (
                      <img
                        src={v.thumbnail}
                        alt=""
                        className="mt-0.5 h-12 w-16 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="mt-0.5 flex h-12 w-16 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <Play className="size-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 truncate font-medium">{v.title}</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                        <span className="flex items-center gap-0.5">
                          <Eye className="size-3" /> {fmt(v.viewCount)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <ThumbsUp className="size-3" /> {fmt(v.likeCount)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <MessageCircle className="size-3" /> {fmt(v.commentCount)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {fmtDate(v.publishedAt)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Per-video trend detail */}
      {videoTrend && (
        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{videoTrend.video.title}</h3>
              <p className="text-xs text-muted-foreground">
                조회수 {fmt(videoTrend.video.viewCount)} · 좋아요 {fmt(videoTrend.video.likeCount)} · 댓글 {fmt(videoTrend.video.commentCount)}
              </p>
            </div>
            <button
              onClick={() => setVideoTrend(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              닫기
            </button>
          </div>
          {videoTrend.trend.length > 0 ? (
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
                    formatter={(value: number, name: string) => {
                      const labels: Record<string, string> = { views: "조회수", likes: "좋아요", comments: "댓글" };
                      return [fmt(value), labels[name] ?? name];
                    }}
                  />
                  <Line type="monotone" dataKey="views" stroke="var(--color-status-progress)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="likes" stroke="var(--color-status-done)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="comments" stroke="var(--color-status-idle)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              이 영상의 추세 데이터가 없습니다. 다음 동기화 시 수집됩니다.
            </p>
          )}
        </Card>
      )}
    </>
  );
}
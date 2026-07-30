"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Flame, RefreshCw, Loader2, Eye, ThumbsUp, MessageCircle } from "lucide-react";

import { fetchTrendingVideos, fetchVideoCategories } from "@/lib/data/api";
import type { TrendingVideo, VideoCategory } from "@/lib/types";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

const REGIONS: { code: string; label: string }[] = [
  { code: "KR", label: "한국" },
  { code: "US", label: "미국" },
  { code: "JP", label: "일본" },
  { code: "GB", label: "영국" },
  { code: "TW", label: "대만" },
  { code: "VN", label: "베트남" },
];

function formatCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`;
  return String(n);
}

function formatDuration(sec: number): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatAge(iso: string, now: number): string {
  if (!iso) return "";
  const diff = now - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days < 1) {
    const hours = Math.floor(diff / 3_600_000);
    return hours <= 0 ? "방금" : `${hours}시간 전`;
  }
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

export default function TrendsPage() {
  const { toast: push } = useToast();
  const [region, setRegion] = useState<string>("KR");
  const [categoryId, setCategoryId] = useState<string>("");
  const [categories, setCategories] = useState<VideoCategory[]>([]);
  const [videos, setVideos] = useState<TrendingVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTrendingVideos(region, categoryId, 50);
      setVideos(res.videos ?? []);
      setFetchedAt(res.fetchedAt ?? Date.now());
    } catch (e: any) {
      const msg = String(e?.message || e);
      setError(msg);
      setVideos([]);
      push({ tone: "error", title: "트렌드 로드 실패", description: msg });
    } finally {
      setLoading(false);
    }
  }, [region, categoryId, push]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let mounted = true;
    setCategoryId("");
    fetchVideoCategories(region)
      .then((r) => { if (mounted) setCategories(r.categories ?? []); })
      .catch(() => { if (mounted) setCategories([]); });
    return () => { mounted = false; };
  }, [region]);

  const now = useMemo(() => Date.now(), [fetchedAt]);

  return (
    <div>
      <PageHeader
        eyebrow="유튜브 참고"
        title="지금 유튜브에서 뜨는"
        description="Data API mostPopular chart · 국가·카테고리별 인기 급상승 영상 (편집자 아이디어 참고용)"
        actions={
          <Button variant="secondary" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            새로고침
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">지역</span>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {REGIONS.map((r) => (
              <option key={r.code} value={r.code}>{r.label} ({r.code})</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">카테고리</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            disabled={!categories.length}
          >
            <option value="">전체</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>
        {fetchedAt && (
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(fetchedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준
          </span>
        )}
      </Card>

      {loading && !videos.length ? (
        <EmptyState icon={Loader2} title="불러오는 중…" />
      ) : error ? (
        <EmptyState
          icon={Flame}
          title="트렌드를 가져올 수 없습니다"
          description={error.includes("no_auth")
            ? "서버에 YOUTUBE_API_KEY env 가 없고 등록된 YouTube 채널도 없습니다. 채널을 하나 연결하거나 API key를 설정해 주세요."
            : error}
        />
      ) : !videos.length ? (
        <EmptyState icon={Flame} title="결과 없음" description="이 조합으로 뜨는 영상이 없습니다." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {videos.map((v, i) => (
            <a
              key={v.videoId}
              href={`https://www.youtube.com/watch?v=${v.videoId}`}
              target="_blank"
              rel="noreferrer"
              className="group"
            >
              <Card className="overflow-hidden p-0 transition hover:border-brand">
                <div className="relative aspect-video bg-muted">
                  {v.thumbnail ? (
                    <img
                      src={v.thumbnail}
                      alt={v.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    #{i + 1}
                  </span>
                  {v.durationSec > 0 && (
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                      {formatDuration(v.durationSec)}
                    </span>
                  )}
                </div>
                <div className="space-y-2 p-3">
                  <div className="line-clamp-2 min-h-[2.6em] text-sm font-medium leading-snug text-foreground group-hover:text-brand">
                    {v.title}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {v.channelTitle} · {formatAge(v.publishedAt, now)}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Eye className="size-3" />{formatCount(v.viewCount)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ThumbsUp className="size-3" />{formatCount(v.likeCount)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="size-3" />{formatCount(v.commentCount)}
                    </span>
                  </div>
                  {v.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {v.tags.slice(0, 3).map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px]">
                          #{t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

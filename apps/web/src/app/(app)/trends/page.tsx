"use client";

/**
 * 유튜브 트렌드 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/trends/page.tsx` 425줄).
 *
 * **마크업·클래스·문구·`<style>` 블록 전부 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `MOCK_TRENDS_50` 50장 | `fetchTrendingVideos(region, categoryId, 50)` |
 * | `countryOptions` 문자열 6개 | `REGIONS` → `{value:"KR", label:"한국 (KR)"}` — 라벨이 목과 글자까지 같다 |
 * | `categoryOptions` 문자열 15개 | `fetchVideoCategories(region)` |
 * | `filteredTrends` 클라이언트 필터 | **서버 필터**(`videoCategoryId`) — 배열을 다시 거르지 않는다 |
 * | 이미 포맷된 `'51.6만'`·`'3:07'`·`'2일 전'` | `formatCount`·`formatDuration`·`formatAge` |
 * | `'오후 12:44 기준'` | `fetchedAt` — **12시간제 그대로**(원본 표기가 그렇다) |
 *
 * ## 원본에 없어서 지켜야 하는 것
 *  1. **카드 → 유튜브 새 탭.** 원본 카드는 `cursor-pointer` 인데 아무 데도 안 간다. 트렌드를
 *     "참고" 하려면 영상을 열어야 한다. `<div>` → `<a>` 로 **태그만** 바꿨다 — className 에
 *     `flex flex-col` 이 있어 display 가 강제되므로 기하 변화가 없다(footer 와 같은 선례).
 *  2. **지역 바뀌면 카테고리 재조회 + categoryId 리셋.** 카테고리 ID 는 전역이지만 assignable
 *     여부가 지역마다 다르다 — 리셋 안 하면 US 에서 고른 ID 로 JP 를 조회해 0건이 뜬다.
 *  3. **`no_auth`(400) 전용 안내.** `json()` 이 body 를 안 읽고 상태코드만 던지므로, 400 판정이
 *     "키도 채널도 없다" 를 알려 줄 유일한 경로다. 이 화면이 안 뜨는 사고의 대부분이 이것.
 *  4. 에러 토스트 · `loading="lazy"`(카드 50장이라 없으면 썸네일 50개를 동시에 받는다)
 *
 * ⚠️ 태그는 `slice(0,3)` 로 자른다. 실제 유튜브 태그는 20~40개가 흔한데, 원본의 3중 반복
 * 마퀴에 그대로 넣으면 카드당 span 이 100개를 넘고 애니메이션 폭도 목업과 완전히 달라진다.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, MessageSquare, RotateCw, ThumbsUp } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import { fetchTrendingVideos, fetchVideoCategories } from "@/lib/data/api";
import type { TrendingVideo, VideoCategory } from "@/lib/types";

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
  // 카테고리 호출만 실패하면 셀렉트가 사유 없이 비어 남는다 — 사유를 보관해 옆에 적는다.
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTrendingVideos(region, categoryId, 50);
      setVideos(res.videos ?? []);
      setFetchedAt(res.fetchedAt ?? Date.now());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setVideos([]);
      push({ tone: "error", title: "트렌드 로드 실패", description: msg });
    } finally {
      setLoading(false);
    }
  }, [region, categoryId, push]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let mounted = true;
    setCategoryId("");
    setCategoryError(null);
    fetchVideoCategories(region)
      .then((r) => { if (mounted) setCategories(r.categories ?? []); })
      .catch((e: unknown) => {
        if (!mounted) return;
        setCategories([]);
        const msg = e instanceof Error ? e.message : String(e);
        // api.ts 의 json() 은 body 를 안 읽고 `${status} ${statusText}` 만 던진다 —
        // 서버가 주는 {"error":"no_auth"} 는 메시지에 안 들어온다. 그 라우트에서 400 은
        // no_auth 전용이므로 status 로 판정한다(apps/server/src/index.ts 의 trends 라우트).
        setCategoryError(
          msg.startsWith("400")
            ? "YOUTUBE_API_KEY 또는 연결 채널이 필요합니다"
            : `카테고리를 불러오지 못했습니다 (${msg})`,
        );
      });
    return () => { mounted = false; };
  }, [region]);

  const now = useMemo(() => Date.now(), [fetchedAt]);

  const countryOptions = useMemo(
    () => REGIONS.map((r) => ({ value: r.code, label: `${r.label} (${r.code})` })),
    [],
  );
  const categoryOptions = useMemo(
    () => [{ value: "", label: "전체" }, ...categories.map((c) => ({ value: c.id, label: c.title }))],
    [categories],
  );

  // 원본 표기가 `오후 12:44 기준` 이라 12시간제를 그대로 쓴다(ko-KR 기본이 12시간제다).
  const stampText = fetchedAt
    ? `${new Date(fetchedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준`
    : "";

  return (
    <>
      {/* Custom Styles for Infinite Hover Marquee & 2px 70% Blue Border */}
      <style>{`
        @keyframes trendMarqueeLoop {
          0% { transform: translateX(0%); }
          100% { transform: translateX(-50%); }
        }
        .trend-card-item {
          border: 2px solid transparent !important;
          transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out !important;
        }
        .trend-card-item:hover {
          border-color: rgba(28, 96, 255, 0.7) !important;
        }
        .trend-card-item:hover .trend-marquee-inner {
          animation: trendMarqueeLoop 7s linear infinite !important;
        }
        .trend-card-item:hover .trend-fade-overlay {
          opacity: 0 !important;
        }
      `}</style>

      {/* Header */}
      <Header title="유튜브 트렌드" subtitle="국가·카테고리별 인기 급상승 영상 — 기획 참고용" />

      {/* YouTube Trend Main Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-hidden">
        <div className="space-y-4 flex-1 flex flex-col min-h-0">
          {/* Top Filter Banner Bar */}
          <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-4 flex items-center justify-between shadow-md shadow-slate-900/5 dark:shadow-none shrink-0 z-20">
            <div className="flex items-center gap-5 text-xs">
              {/* Region Select */}
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-text-muted)] font-bold shrink-0">지역</span>
                <div className="w-36">
                  <CustomSelect
                    ariaLabel="지역"
                    options={countryOptions}
                    value={region}
                    onChange={(val) => setRegion(val)}
                  />
                </div>
              </div>

              {/* Category Select */}
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-text-muted)] font-bold shrink-0">카테고리</span>
                <div className="w-48">
                  <CustomSelect
                    ariaLabel="카테고리"
                    options={categoryOptions}
                    value={categoryId}
                    onChange={(val) => setCategoryId(val)}
                  />
                </div>
                {/* 원본엔 없는 상태 — 카테고리만 실패하면 셀렉트가 "전체" 하나로 남는다. 사유를 적는다. */}
                {categoryError && (
                  <span className="text-[11px] text-[var(--color-text-muted)]">{categoryError}</span>
                )}
              </div>
            </div>

            {/* Timestamp & Refresh Button */}
            <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)] select-none">
              <span>{stampText}</span>
              <button
                onClick={() => { void refresh(); }}
                disabled={loading}
                className="px-4 py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-bold transition-colors cursor-pointer flex items-center gap-1.5 shadow-md shadow-slate-900/5 dark:shadow-none disabled:cursor-not-allowed disabled:opacity-70"
              >
                <RotateCw className={`w-3.5 h-3.5 text-[var(--color-text-muted)] ${loading ? "animate-spin" : ""}`} />
                <span>새로고침</span>
              </button>
            </div>
          </div>

          {/* Video Cards Grid (16:9 Thumbnail, 14px Title, Gray Pill Tags) */}
          <div className="flex-1 overflow-y-auto pr-1 min-h-0">
            {/* 원본엔 없는 상태들 — 목업은 항상 카드 50장이었다. 카드와 같은 표면 언어로 그린다. */}
            {loading && videos.length === 0 ? (
              <div className="bg-[var(--color-bg-card)] rounded-2xl p-10 text-center text-xs text-[var(--color-text-muted)] shadow-md shadow-slate-900/5 dark:shadow-none">
                불러오는 중…
              </div>
            ) : error ? (
              <div className="bg-[var(--color-bg-card)] rounded-2xl p-10 text-center text-xs text-[var(--color-text-muted)] leading-relaxed shadow-md shadow-slate-900/5 dark:shadow-none">
                {error.startsWith("400")
                  ? "서버에 YOUTUBE_API_KEY env 가 없고 등록된 YouTube 채널도 없습니다 — 둘 중 하나가 있어야 트렌드를 부를 수 있습니다."
                  : `트렌드를 불러오지 못했습니다 (${error})`}
              </div>
            ) : videos.length === 0 ? (
              <div className="bg-[var(--color-bg-card)] rounded-2xl p-10 text-center text-xs text-[var(--color-text-muted)] shadow-md shadow-slate-900/5 dark:shadow-none">
                이 조합으로 뜨는 영상이 없습니다.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pb-4">
                {videos.map((v, i) => {
                  // 3중 반복 **앞에서** 자른다 — 뒤에서 자르면 마퀴 폭이 목업과 달라진다.
                  const tags = v.tags.slice(0, 3).map((t) => `#${t}`);
                  return (
                    <a
                      key={v.videoId}
                      href={`https://www.youtube.com/watch?v=${v.videoId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="trend-card-item bg-[var(--color-bg-card)] rounded-2xl overflow-hidden flex flex-col group cursor-pointer shadow-md shadow-slate-900/5 dark:shadow-none hover:shadow-xl"
                    >
                      {/* 16:9 Aspect Ratio Video Thumbnail */}
                      <div className="w-full aspect-video bg-slate-900 relative overflow-hidden shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element -- 외부 유튜브 CDN, next/image 불필요 */}
                        <img
                          src={v.thumbnail ?? ""}
                          alt={v.title}
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />

                        {/* Rank Badge (#1, #2...) */}
                        <span className="absolute top-2 left-2 px-2.5 py-0.5 rounded-full bg-black/80 text-white font-mono font-bold text-[11px] backdrop-blur-xs">
                          #{i + 1}
                        </span>

                        {/* Duration Overlay */}
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full text-[10.5px] bg-black/80 text-white font-mono font-bold">
                          {formatDuration(v.durationSec)}
                        </span>
                      </div>

                      {/* Content Section */}
                      <div className="p-4 flex-1 flex flex-col justify-between space-y-3 min-h-0">
                        <div className="space-y-2">
                          {/* Title (14px Font Size) */}
                          <h4 className="font-bold text-[var(--color-text-primary)] text-[14px] leading-snug line-clamp-2">
                            {v.title}
                          </h4>

                          {/* Channel & Time */}
                          <p className="text-xs text-[var(--color-text-muted)] truncate">
                            {v.channelTitle} · {formatAge(v.publishedAt, now)}
                          </p>

                          {/* Stats Row (Views, Likes, Comments) */}
                          <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)] font-mono pt-2 border-t border-[var(--color-border-subtle)]/50">
                            <span className="flex items-center gap-1">
                              <Eye className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              {formatCount(v.viewCount)}
                            </span>
                            <span className="flex items-center gap-1">
                              <ThumbsUp className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              {formatCount(v.likeCount)}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageSquare className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              {formatCount(v.commentCount)}
                            </span>
                          </div>
                        </div>

                        {/* Gray Pill Shape Tags Row (Card hover triggers infinite marquee loop) */}
                        {tags.length > 0 && (
                          <div className="relative overflow-hidden w-full pt-1 select-none shrink-0">
                            <div className="trend-marquee-inner flex items-center gap-1.5 whitespace-nowrap">
                              {[...tags, ...tags, ...tags].map((tag, idx) => (
                                <span
                                  key={idx}
                                  className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-stone-800 text-slate-600 dark:text-slate-300 text-[11px] font-medium border-none shrink-0 whitespace-nowrap"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                            {/* Right Fade Gradient Overlay */}
                            <div className="trend-fade-overlay pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-[var(--color-bg-card)] via-[var(--color-bg-card)]/80 to-transparent z-10 transition-opacity duration-300" />
                          </div>
                        )}
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

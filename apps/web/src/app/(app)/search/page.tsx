"use client";

/**
 * 영상 검색 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/search/page.tsx` 457줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `MOCK_SEARCH_ITEMS` 8건 + 클라이언트 문자열 필터 | `searchSegments()` — 서버가 필터·랭킹을 한다 |
 * | 검색 버튼 `onClick={() => {}}` **빈 함수** | 실제 질의 + Enter 키 |
 * | 프로그램 옵션 이름 5개 하드코딩 | 실제 프로그램(**이름 아니라 id 로** 필터) |
 * | 모달 `<video src="BigBuckBunny.mp4">` | `getStreamUrl()` + `#t=start,end` |
 * | `alert('구간 다운로드가 시작되었습니다.')` | 실제 다운로드(blob) + 진행/실패 표시 |
 * | `href="/episodes/e_1293d2f1"` 하드코딩 | 실제 회차 (없으면 비활성) |
 *
 * ## 원본에 없어서 **반드시 지킨 것**
 *  1. **검색 로그**(`logSearchEvent` click·export) — 랭킹·컷지점 학습의 **유일한 지도 신호**다.
 *     빠지면 "무엇을 실제로 골랐는지" 가 영영 안 쌓인다. `queryId` + 카드 `rank` 를 같이 보낸다.
 *  2. **재생 구간 제어** — 목은 영상을 처음부터 끝까지 튼다. `#t=start,end` 의 끝점 정지는
 *     브라우저가 보장하지 않아 `timeupdate` 로 직접 멈춘다. 없으면 16초 구간을 찾아 놓고
 *     58분짜리 원본이 계속 재생된다.
 *  3. **요청 경합·취소** — `AbortController`, 취소된 호출의 finally 가 새 스피너를 끄지 않게,
 *     그리고 **타자마다 재질의하지 않기**(필터 변경만 즉시 재질의). 글자마다 임베딩 호출이
 *     나가면 원가와 응답 크기에 직결된다.
 *  4. **방영일 입력 검증** — 원본은 `type="text"` 다. 검증 없이 이으면 `"2"`,`"20"`,`"202"` 가
 *     한 글자마다 서버로 나가고 Postgres date 캐스트가 터져 **500** 이 된다.
 *  5. **질의 해석·임베딩 폴백 표시** — 결과가 이상할 때 여기부터 본다. 원본 카운터 문장은
 *     **빈 질의일 때만 참**이라, 질의가 있으면 같은 슬롯에 실제 상태를 적는다.
 *  6. **인물 태그** — 이 제품의 1차 질의축인데 목 카드엔 슬롯이 없다. 제목 아래에 원본 언어로 추가.
 *
 * ## 원본의 버그 하나도 같이 고쳤다
 * `하이라이트 {highlightCount}` — 우리 값은 **개수가 아니라 0..1 실수**다. 현행 화면이
 * `하이라이트 0.6231` 을 그대로 찍고 있었다. 적합도와 같은 0–100 스케일로 맞춘다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Video } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import {
  frameUrl,
  getStreamUrl,
  logSearchEvent,
  searchSegments,
  segmentDownloadUrl,
  type SearchResponse,
  type SearchResultCard,
} from "@/lib/data/api";
import { API_BASE } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { fmtTime } from "@/lib/utils";

/** 서버 구간 다운로드 상한(초) — 넘으면 버튼 비활성. */
const MAX_DOWNLOAD_SEC = 300;

const durSec = (h: SearchResultCard) => h.duration ?? h.end - h.start;
const durationLabel = (h: SearchResultCard) => `${Math.round(durSec(h))}초`;
const timeRangeOf = (h: SearchResultCard) => `${fmtTime(h.start)} - ${fmtTime(h.end)}`;
const relevanceOf = (h: SearchResultCard) => Math.round(h.score * 100);
/** ⚠️ 이름은 count 지만 값은 0..1 실수다 — 적합도와 같은 0–100 스케일로 보인다. */
const highlightLabel = (h: SearchResultCard) =>
  h.highlightScore == null ? "—" : String(Math.round(h.highlightScore * 100));

/**
 * 방영일 텍스트 입력 → 서버에 보낼 값. 형식이 안 맞으면 빈 문자열(= 필터 미적용).
 * 원본이 `type="text"` 라 검증이 없으면 타자 도중의 `"202"` 같은 값이 서버로 나가고,
 * Postgres date 캐스트가 터져 500 이 된다.
 */
function isoDateOrEmpty(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? "" : v;
}

export default function VideoSearchPage() {
  const { programs, media } = useAppData();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProgram, setSelectedProgram] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "shortform" | "longform">("all");
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModalItem, setSelectedModalItem] = useState<SearchResultCard | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 검증된 값만 재질의 트리거로 쓴다 — 타자 도중의 부분 문자열이 서버로 나가지 않게.
  const airedFrom = isoDateOrEmpty(startDate);
  const airedTo = isoDateOrEmpty(endDate);
  const onlyShorts = typeFilter === "all" ? null : typeFilter === "shortform";

  const run = useCallback(async () => {
    // 빈 질의도 보낸다 — 서버가 하이라이트 순 기본 목록을 돌려준다.
    const query = searchQuery.trim();
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const r = await searchSegments(
        {
          q: query,
          program: selectedProgram || undefined,
          airedFrom: airedFrom || undefined,
          airedTo: airedTo || undefined,
          ...(onlyShorts != null ? { isShort: onlyShorts } : {}),
          topK: 30,
        },
        ac.signal,
      );
      setRes(r);
      setError(null);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setRes(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // 취소된(abort 된) 호출의 finally 가 뒤늦게 새 검색의 스피너를 끄면 안 된다.
      if (abortRef.current === ac) setBusy(false);
    }
  }, [searchQuery, selectedProgram, airedFrom, airedTo, onlyShorts]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 필터를 바꾸면 곧바로 재질의한다. run 을 deps 에 넣으면 **타자마다** 재질의하므로
  // 최신 run 은 ref 로 읽는다. 첫 마운트에도 실행 — 기본 목록을 띄운다.
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  useEffect(() => { void runRef.current(); }, [selectedProgram, airedFrom, airedTo, onlyShorts]);

  const results = res?.results ?? [];
  const programOptions = useMemo(
    () => [{ value: "", label: "전체 프로그램" }, ...programs.map((p) => ({ value: p.id, label: p.title }))],
    [programs],
  );

  // 원본 카운터 문장은 **빈 질의일 때만 참**이다. 질의가 있으면 같은 슬롯에 실제 상태를 적는다.
  const counterText = error
    ? `검색에 실패했습니다 (${error})`
    : !res
      ? "불러오는 중…"
      : res.parsed?.empty
        ? `${res.count}건 · 하이라이트 순 기본 목록 — 검색어를 입력하면 줄어듭니다`
        : `${res.count}건 · ${res.embedded ? "의미+키워드" : "키워드 단독"}`;

  return (
    <>
      {/* Header */}
      <Header title="영상 검색" subtitle="자연어 질의로 구간 찾기" />

      {/* Video Search Main Content */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-hidden">
        <div className="space-y-3 flex-1 flex flex-col min-h-0">
          {/* Natural Language Search Input Bar */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
              placeholder="찾고 싶은 장면을 문장으로 (예: 지난달 방송에서 출연자가 정색하며 판을 뒤집는 순간)"
              aria-label="검색어"
              className="h-10 flex-1 bg-[var(--color-bg-card)] border-none text-xs text-[var(--color-text-primary)] px-3.5 rounded-xl shadow-md shadow-slate-900/5 dark:shadow-none focus:outline-none focus:ring-1 focus:ring-[#1C60FF] placeholder:text-[var(--color-text-muted)] transition-all"
            />
            <button
              onClick={() => { void run(); }}
              disabled={busy}
              className="h-10 px-5 rounded-xl bg-[var(--color-bg-active)] text-white font-bold text-xs hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer shrink-0 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {busy ? "찾는 중…" : "검색"}
            </button>
          </div>

          {/* Filter Control Row */}
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)] shrink-0 gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Program CustomSelect Dropdown */}
              <div className="w-40">
                <CustomSelect
                  ariaLabel="프로그램"
                  options={programOptions}
                  value={selectedProgram}
                  onChange={(val) => setSelectedProgram(val)}
                  className="text-xs"
                  triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs font-bold border-none rounded-full shadow-md shadow-slate-900/5 dark:shadow-none"
                />
              </div>

              {/* Air Date Inputs */}
              <div className="h-10 flex items-center gap-1.5 bg-[var(--color-bg-card)] px-3.5 rounded-xl border-none shadow-md shadow-slate-900/5 dark:shadow-none text-xs">
                <span className="text-[var(--color-text-muted)] font-bold">방영일</span>
                <input
                  type="text"
                  placeholder="연도-월-일"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  aria-label="방영일 시작"
                  className="bg-transparent text-[var(--color-text-primary)] w-20 text-center focus:outline-none placeholder:text-[var(--color-text-muted)] font-mono text-[11px]"
                />
                <span className="text-[var(--color-text-muted)]">-</span>
                <input
                  type="text"
                  placeholder="연도-월-일"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-label="방영일 끝"
                  className="bg-transparent text-[var(--color-text-primary)] w-20 text-center focus:outline-none placeholder:text-[var(--color-text-muted)] font-mono text-[11px]"
                />
              </div>

              {/* Format Filter Tabs */}
              <div className="h-10 flex items-center gap-1 bg-[var(--color-bg-card)] p-1 rounded-xl border-none shadow-md shadow-slate-900/5 dark:shadow-none text-[11px]">
                {([["all", "전체"], ["shortform", "숏폼"], ["longform", "롱폼"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTypeFilter(k)}
                    className={`h-8 px-3 rounded-lg font-semibold transition-colors cursor-pointer select-none ${
                      typeFilter === k
                        ? "bg-[var(--color-bg-active)] text-white"
                        : "text-[var(--color-text-secondary)] hover:text-[#1C60FF]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Dynamic Result Counter Header */}
            <div className="text-[11px] text-[var(--color-text-muted)] select-none shrink-0">
              {counterText}
            </div>
          </div>

          {/* 질의 해석 — 원본에 없다. 결과가 이상할 때 여기부터 본다. */}
          {res && !res.parsed?.empty && (
            <div className="text-[11px] text-[var(--color-text-muted)] shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1">
              {res.parsed?.characters?.length ? <span>인물: {res.parsed.characters.join(", ")}</span> : null}
              {res.parsed?.sceneType ? <span>장면: {res.parsed.sceneType}</span> : null}
              {res.parsed?.airedFrom ? <span>방영일 ≥ {res.parsed.airedFrom}</span> : null}
              {!res.embedded && <span>의미 축(임베딩)이 걸리지 않아 키워드만으로 찾았습니다</span>}
            </div>
          )}

          {/* Search Results Grid (4 Columns) */}
          <div className="flex-1 overflow-y-auto pr-1 min-h-0">
            {results.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center text-xs text-[var(--color-text-muted)] space-y-2 h-64">
                <div className="w-12 h-12 rounded-full bg-[var(--color-bg-input)] flex items-center justify-center text-[var(--color-text-muted)] mb-1">
                  <Video className="w-6 h-6 text-[var(--color-text-muted)]" />
                </div>
                <p className="font-bold text-[var(--color-text-primary)] text-sm">
                  {busy ? "찾는 중…" : "조건에 맞는 영상이 없습니다"}
                </p>
                <p className="text-[11px]">
                  검색어나 상단 필터 조건을 변경해 보세요.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pb-4">
                {results.map((hit, rank) => {
                  const m = media.find((x) => x.id === hit.mediaId);
                  return (
                    <div
                      key={hit.segmentId}
                      onClick={() => {
                        // 어떤 결과를 골랐는지가 랭킹 학습의 지도 신호 — fire-and-forget.
                        logSearchEvent({
                          event: "click",
                          queryId: res?.queryId,
                          segmentId: hit.segmentId,
                          mediaId: hit.mediaId,
                          rank,
                          start: hit.start,
                          end: hit.end,
                        });
                        setSelectedModalItem(hit);
                      }}
                      className="bg-[var(--color-bg-card)] border-2 border-transparent hover:border-[var(--color-bg-active)] rounded-2xl overflow-hidden flex flex-col justify-between shadow-md shadow-slate-900/5 dark:shadow-none hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 cursor-pointer relative group"
                    >
                      {/* 16:9 Aspect Ratio Video Thumbnail */}
                      <div className="w-full aspect-video bg-slate-900 relative overflow-hidden shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element -- 서버 프레임 캡처 */}
                        <img
                          src={frameUrl(API_BASE, hit.mediaId, hit.start)}
                          alt={hit.summary ?? ""}
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />

                        {/* Bottom Left Duration Overlay */}
                        <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full text-[10.5px] bg-black/80 text-white font-mono font-bold backdrop-blur-xs">
                          {durationLabel(hit)}
                        </div>

                        {/* Bottom Right Format & Tag Badges */}
                        <div className="absolute bottom-2 right-2 flex items-center gap-1">
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-black/80 text-white font-medium backdrop-blur-xs">
                            {hit.isShort ? "숏폼" : "롱폼"}
                          </span>
                          {/* sceneType 은 nullable — 없으면 배지 자체를 안 그린다 */}
                          {hit.sceneType && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-black/80 text-white font-medium backdrop-blur-xs">
                              {hit.sceneType}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Content Section */}
                      <div className="p-4 flex-1 flex flex-col justify-between space-y-3 min-h-0">
                        <div className="space-y-1.5">
                          {/* Time Range & Source */}
                          <div className="text-[11px] text-[var(--color-text-primary)] font-mono font-bold flex items-center gap-1.5">
                            <span>{timeRangeOf(hit)}</span>
                            <span className="text-[var(--color-text-muted)] font-normal text-[11px] font-sans truncate">
                              {m?.title ?? hit.mediaId}
                            </span>
                          </div>

                          {/* Card Title */}
                          {hit.summary && (
                            <h4 className="font-semibold text-[14px] text-[var(--color-text-primary)] leading-snug line-clamp-2" title={hit.summary}>
                              {hit.summary}
                            </h4>
                          )}

                          {/* 인물 — 이 제품의 1차 질의축. 목 카드엔 슬롯이 없어 원본 언어로 추가. */}
                          {hit.characters?.length ? (
                            <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                              {hit.characters.slice(0, 4).join(" · ")}
                            </div>
                          ) : null}
                        </div>

                        {/* Footer Stats Row */}
                        <div className="pt-2.5 border-t border-[var(--color-border-subtle)]/60 text-[11px] text-[var(--color-text-muted)] flex items-center justify-between font-mono shrink-0">
                          <span>
                            적합도 {relevanceOf(hit)} · 하이라이트 {highlightLabel(hit)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Video Detail Modal Popup */}
        {selectedModalItem && (
          <SegmentModal
            hit={selectedModalItem}
            queryId={res?.queryId}
            sourceLabel={media.find((x) => x.id === selectedModalItem.mediaId)?.title ?? selectedModalItem.mediaId}
            episodeId={media.find((x) => x.id === selectedModalItem.mediaId)?.episodeId ?? null}
            onClose={() => setSelectedModalItem(null)}
          />
        )}

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

function SegmentModal({
  hit, queryId, sourceLabel, episodeId, onClose,
}: {
  hit: SearchResultCard;
  queryId?: string;
  sourceLabel: string;
  episodeId: string | null;
  onClose: () => void;
}) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const backdropMouseDownRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setStreamUrl(null);
    setStreamErr(null);
    getStreamUrl(hit.mediaId)
      .then((url) => { if (alive) setStreamUrl(url); })
      .catch((err) => { if (alive) setStreamErr(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [hit.mediaId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // #t=start,end 의 end 정지는 브라우저가 보장하지 않는다 — timeupdate 로 직접 멈춘다.
  // 정지는 경계를 넘는 순간 1회만 — 사용자가 이어보기로 재생을 누르면 다시 막지 않는다.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stopped = false;
    const onTime = () => {
      if (v.currentTime < hit.end) { stopped = false; return; }
      if (!stopped) { stopped = true; v.pause(); }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [streamUrl, hit.end]);

  const seconds = durSec(hit);
  const downloadable = seconds <= MAX_DOWNLOAD_SEC;

  // <a download> 는 서버 trimEncode 가 끝날 때까지 아무 피드백이 없다 — fetch 로 받아
  // 완료를 알 수 있게 하고, 그동안 버튼을 진행 중 상태로 잠근다.
  const downloadSegment = useCallback(async () => {
    if (downloading) return;
    // 다운로드 선택 자체가 학습 신호 — fire-and-forget, 실패해도 UI 를 막지 않는다.
    logSearchEvent({
      event: "export",
      queryId,
      segmentId: hit.segmentId,
      mediaId: hit.mediaId,
      start: hit.start,
      end: hit.end,
    });
    setDownloading(true);
    setDownloadErr(null);
    try {
      const r = await fetch(segmentDownloadUrl(hit.mediaId, hit.start, hit.end));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${hit.mediaId}_${Math.round(hit.start)}-${Math.round(hit.end)}s.mp4`;
      a.click();
      // click 직후 즉시 revoke 하면 일부 브라우저에서 저장이 끊긴다 — 한 박자 늦춘다.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setDownloadErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, [downloading, queryId, hit.segmentId, hit.mediaId, hit.start, hit.end]);

  return (
    <div
      onMouseDown={(e) => { backdropMouseDownRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDownRef.current) onClose();
        backdropMouseDownRef.current = false;
      }}
      className="fixed inset-0 bg-black/75 backdrop-blur-xs z-[9999] flex items-center justify-center p-6 animate-in fade-in duration-150 cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--color-bg-card)] border border-[var(--color-border-card)] rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col animate-in zoom-in-95 duration-150 cursor-default"
      >
        {/* Modal Header Bar */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-[var(--color-border-subtle)]">
          <div className="flex items-center gap-2 text-xs font-mono text-[var(--color-text-primary)] font-bold">
            <span>{timeRangeOf(hit)}</span>
            <span className="px-2 py-0.5 rounded bg-[var(--color-bg-input)] text-[var(--color-text-primary)] text-[11px] font-sans">
              {durationLabel(hit)}
            </span>
            <span className="px-2 py-0.5 rounded bg-[var(--color-bg-input)] text-[var(--color-text-primary)] text-[11px] font-sans">
              {hit.isShort ? "숏폼" : "롱폼"}
            </span>
            {hit.sceneType && (
              <span className="px-2 py-0.5 rounded bg-[var(--color-bg-input)] text-[var(--color-text-primary)] text-[11px] font-sans">
                {hit.sceneType}
              </span>
            )}
            <span className="text-[var(--color-text-muted)] font-sans text-xs ml-1">
              {sourceLabel}
            </span>
          </div>

          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-xs font-bold transition-colors cursor-pointer"
          >
            닫기
          </button>
        </div>

        {/* Video Player Display Container */}
        <div className="w-full bg-black relative flex items-center justify-center aspect-video overflow-hidden">
          {streamUrl ? (
            <video
              ref={videoRef}
              // 구간만 재생한다 — 끝점 정지는 위 timeupdate 가 보장한다.
              src={`${streamUrl}#t=${hit.start},${hit.end}`}
              controls
              autoPlay
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="text-xs text-slate-400 p-6 text-center">
              {streamErr ? `영상을 열지 못했습니다 (${streamErr})` : "영상을 불러오는 중…"}
            </div>
          )}
        </div>

        {/* Modal Bottom Detail Info & Action Buttons */}
        <div className="p-6 space-y-4 bg-[var(--color-bg-card)]">
          {/* Title & Subtitle Transcript */}
          <div className="space-y-2">
            {hit.summary && (
              <h3 className="text-sm font-bold text-[var(--color-text-primary)] leading-snug">
                {hit.summary}
              </h3>
            )}
            {hit.dialogue && (
              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed font-mono">
                &ldquo;{hit.dialogue}&rdquo;
              </p>
            )}
            {hit.characters?.length ? (
              <p className="text-xs text-[var(--color-text-muted)]">{hit.characters.join(" · ")}</p>
            ) : null}
          </div>

          {/* Modal Action Buttons Row */}
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { void downloadSegment(); }}
                disabled={!downloadable || downloading}
                title={downloadable ? undefined : `${MAX_DOWNLOAD_SEC}초를 넘는 구간은 내려받을 수 없습니다`}
                className="px-4 py-2 rounded-lg bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-colors cursor-pointer shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                {downloading ? "내려받는 중…" : "구간 다운로드"}
              </button>
              {downloadErr && (
                <span className="text-[11px] text-[var(--color-text-muted)]">받지 못했습니다 ({downloadErr})</span>
              )}
            </div>

            {episodeId ? (
              <a
                href={`/episodes/${episodeId}?tab=analyze`}
                className="px-4 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] text-xs font-bold transition-colors cursor-pointer inline-flex items-center gap-1"
              >
                회차에서 열기
              </a>
            ) : (
              <span
                title="이 미디어에 연결된 회차가 없습니다"
                className="px-4 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] text-[var(--color-text-muted)] text-xs font-bold inline-flex items-center gap-1 cursor-not-allowed opacity-60"
              >
                회차에서 열기
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

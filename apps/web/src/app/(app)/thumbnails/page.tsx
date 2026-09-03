"use client";

/**
 * 썸네일 생성 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/thumbnails/page.tsx` 203줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * | 원본(목업) | 이식본 |
 * |---|---|
 * | `MOCK_MEDIA_ITEMS` 1건 | `useAppData().clips` 중 **가로(16:9)만** |
 * | `alert('썸네일 생성이 시작되었습니다.')` | `generateThumbnails()` + 토스트 |
 * | 결과 패널 "결과가 없습니다" 고정 | `fetchThumbnailCandidates()` — 후보 3안 + 대표 지정 |
 * | 새로고침 버튼 핸들러 없음 | 후보 재조회 |
 *
 * ## 원본에 없어서 지킨 것
 *  - **숏폼 제외** — 세로 미디어는 대상이 아니다(원본도 그렇게 *적어* 뒀지만 목이 1건뿐이라 필터가 없었다).
 *  - **대상이 바뀌면 이전 결과를 버린다** — 안 버리면 다른 미디어의 결과를 이 미디어 것으로 착각한다.
 *  - **늦게 온 응답이 현재 화면을 덮지 않게** 요청 시점 mediaId 를 기억해 대조한다(A 조회 중 B 선택 경합).
 *  - **후보 선택(대표 지정)** — 원본 결과 패널엔 후보를 고르는 수단이 아예 없다.
 *    "3안 중 대표 지정" 이 이 화면 부제인데 목업엔 그 기능이 없었다.
 *  - `alert` 대신 토스트. 생성 요청은 "시작했다" 고 단정하지 않는다 — 서버가 같은 미디어의
 *    진행 중 잡을 dedupe 로 삼켜서, 200 이어도 새 잡이 안 뜰 수 있다.
 *
 * 프롬프트 입력과 9:16 은 **원본 그대로 비활성 안내를 유지**한다("배선 전", "현재 16:9 만").
 * 서버가 실제로 그렇다 — 화면이 사실을 말하고 있으므로 고칠 게 없다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { useToast } from "@/components/ui/toast";
import {
  fetchThumbnailCandidates,
  generateThumbnails,
  selectThumbnailCandidate,
  type ThumbnailCandidateFile,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { clipThumbSrc } from "@/lib/media-url";
import type { Clip } from "@/lib/types";
import { fmtTime } from "@/lib/utils";

export default function ThumbnailGenPage() {
  const { clips, episodes, programs, loading } = useAppData();
  const { toast } = useToast();

  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const [candidates, setCandidates] = useState<ThumbnailCandidateFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [candLoading, setCandLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 숏폼은 대상이 아니다 — 원본도 그렇게 적어 뒀지만 목이 1건뿐이라 필터가 없었다.
  const targets = useMemo(() => clips.filter((c) => !c.aspectRatio?.startsWith("9:16")), [clips]);
  const selectedMedia = targets.find((c) => c.id === selectedMediaId) ?? null;

  const mediaIdOf = (c: Clip) => c.mediaId ?? c.sourceMediaId ?? "";
  const targetMediaId = selectedMedia ? mediaIdOf(selectedMedia) : "";

  // 늦게 도착한 이전 대상의 응답이 현재 대상 화면을 덮지 않게, 요청 시점의 mediaId 를
  // 기억해 도착 시 대조한다 (대상 A 조회 중 B 로 바꾸는 경합).
  const candReqRef = useRef<string>("");
  const loadCandidates = useCallback(async (mediaId: string) => {
    candReqRef.current = mediaId;
    if (!mediaId) { setCandidates([]); setSelected(null); return; }
    setCandLoading(true);
    try {
      const r = await fetchThumbnailCandidates(mediaId);
      if (candReqRef.current !== mediaId) return;
      setCandidates(r.candidates);
      setSelected(r.selected);
      setError(null);
    } catch (err) {
      if (candReqRef.current !== mediaId) return;
      setCandidates([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (candReqRef.current === mediaId) setCandLoading(false);
    }
  }, []);

  // 대상이 바뀌면 이전 결과를 버린다 — 남겨 두면 다른 미디어의 결과를 이 미디어 것으로 착각한다.
  // 의존성은 원시값만 — clip **객체**를 넣으면 store 폴링마다 아이덴티티가 바뀌어 초기화된다.
  useEffect(() => {
    setCandidates([]);
    setSelected(null);
    setError(null);
    void loadCandidates(targetMediaId);
  }, [selectedMediaId, targetMediaId, loadCandidates]);

  async function generate() {
    if (!selectedMedia) {
      toast({ title: "왼쪽에서 미디어를 먼저 선택해주세요.", tone: "error" });
      return;
    }
    const mediaId = mediaIdOf(selectedMedia);
    const programId = episodes.find((e) => e.id === selectedMedia.episodeId)?.programId ?? "";
    if (!mediaId || !programId) {
      toast({ title: "생성할 수 없습니다", description: "이 미디어의 원본·프로그램을 찾을 수 없습니다.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      await generateThumbnails(mediaId, { programId, prompt: promptText.trim(), aspect: "16:9", candidates: 3 });
      toast({
        title: "생성을 요청했습니다",
        // 서버가 같은 미디어의 진행 중 잡을 dedupe 로 삼킨다(요청은 200 이지만 새 잡이 안 뜬다).
        // 그래서 "시작했습니다" 라고 단정하지 않는다.
        description: "이미 생성 중이면 이 요청은 무시됩니다. 완료 알림은 없습니다 — 결과는 이 미디어에 남습니다.",
        tone: "progress",
      });
    } catch (err) {
      toast({ title: "생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function choose(path: string) {
    if (!selectedMedia) return;
    try {
      await selectThumbnailCandidate(mediaIdOf(selectedMedia), path);
      setSelected(path);
      toast({ title: "대표 썸네일로 지정했습니다", description: selectedMedia.title, tone: "done" });
    } catch (err) {
      toast({ title: "지정 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  return (
    <>
      {/* Header */}
      <Header title="썸네일 생성" subtitle="대상 선택 → 프롬프트 → 3안 중 대표 지정" />

      {/* Thumbnail Gen Main Body */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-hidden">
        <div className="space-y-4 flex-1 flex flex-col min-h-0 mb-3">
          {/* Top Workspace 2-Column Split */}
          <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
            {/* Left Column: Target Select Area */}
            <div className="col-span-8 bg-[var(--color-bg-card)] border-none rounded-xl p-5 flex flex-col min-h-0 shadow-md shadow-slate-900/5 dark:shadow-none">
              <div className="space-y-3 mb-4">
                <h3 className="text-base font-bold text-[var(--color-text-primary)] flex items-center gap-2">
                  <span>대상 선택</span>
                  <span className="text-[11px] text-[var(--color-text-muted)] font-normal">
                    숏폼은 대상이 아닙니다(세로 미디어는 목록에 없습니다)
                  </span>
                </h3>
              </div>

              {/* Media Cards Grid */}
              {targets.length === 0 ? (
                // 원본엔 없는 상태 — 목은 항상 1건이었다.
                <div className="flex-1 border border-dashed border-[var(--color-border-subtle)] rounded-xl flex items-center justify-center text-center p-6 text-xs text-[var(--color-text-muted)] leading-relaxed">
                  {loading
                    ? "불러오는 중…"
                    : "가로(16:9) 미디어가 없습니다 — 영상 분석에서 클립을 채택하면 여기 나타납니다"}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4 overflow-y-auto p-1.5">
                  {targets.map((item) => {
                    const isSelected = selectedMediaId === item.id;
                    const thumb = clipThumbSrc(item);
                    const ep = episodes.find((e) => e.id === item.episodeId);
                    const prog = programs.find((p) => p.id === ep?.programId);
                    const meta = [
                      prog?.title ?? item.programTitle ?? "",
                      ep?.episodeNumber != null ? `회차 ${ep.episodeNumber}` : null,
                      fmtTime(item.durationSec),
                    ].filter(Boolean).join(" · ");
                    return (
                      <div
                        key={item.id}
                        onClick={() => setSelectedMediaId(item.id)}
                        className={`p-[2.5px] rounded-xl transition-all cursor-pointer aspect-[16/9] ${
                          isSelected
                            ? "bg-[#1C60FF] shadow-md shadow-[#1C60FF]/25"
                            : "bg-transparent shadow-md shadow-slate-900/5 dark:shadow-none"
                        }`}
                      >
                        <div className="relative w-full h-full rounded-[9px] overflow-hidden group bg-slate-900">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element -- 내부 미디어 프레임
                            <img
                              src={thumb}
                              alt={item.title}
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : null}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 flex flex-col justify-end">
                            <h4 className="text-xs font-bold text-white leading-snug line-clamp-1">
                              {item.title}
                            </h4>
                            <p className="text-[10.5px] text-slate-300">{meta}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Column: Prompt & Action Controls */}
            <div className="col-span-4 space-y-4 flex flex-col min-h-0 overflow-y-auto">
              {/* Prompt Card Panel */}
              <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-4 text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
                <div>
                  <h4 className="font-bold text-[var(--color-text-muted)] text-[11px] mb-1">
                    선택된 미디어
                  </h4>
                  <p className="text-base text-[var(--color-text-primary)] font-bold">
                    {selectedMedia ? selectedMedia.title : "왼쪽에서 하나 고르세요."}
                  </p>
                </div>

                {/* Prompt Textarea Section */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-[var(--color-text-primary)] text-xs">
                      프롬프트
                    </h4>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      배선 전 — 입력해도 반영되지 않습니다
                    </span>
                  </div>
                  <div className="relative">
                    <textarea
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      placeholder="아직 서버가 프롬프트를 받지 않습니다 — 프로그램 스타일 프로파일과 투입 출연자 사진으로만 생성됩니다."
                      rows={3}
                      className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] p-3 rounded-xl text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[#1C60FF] resize-none leading-relaxed transition-colors"
                    />
                  </div>
                </div>

                {/* Ratio Selector Tabs (16:9 & 9:16) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-[var(--color-text-primary)] text-xs">
                      비율
                    </h4>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      현재 16:9 만 생성됩니다
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 bg-slate-200/70 dark:bg-stone-800/80 p-1 rounded-full border-none shadow-none">
                    <button
                      type="button"
                      className="flex-1 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer select-none bg-[#1C60FF] text-white shadow-sm"
                    >
                      16:9
                    </button>
                    <button
                      type="button"
                      disabled
                      className="flex-1 py-1.5 rounded-full text-xs font-bold transition-all cursor-not-allowed select-none opacity-40 text-slate-500 dark:text-slate-400 font-medium"
                      title="현재 16:9만 가능합니다"
                    >
                      9:16
                    </button>
                  </div>
                </div>

                {/* Notice Alert Box */}
                <div className="p-3.5 rounded-xl bg-[var(--color-bg-input)]/60 border border-[var(--color-border-subtle)] text-[11px] text-[var(--color-text-muted)] leading-relaxed space-y-1">
                  <p>
                    생성에는 몇 분이 걸립니다. <strong className="text-[var(--color-text-primary)]">완료 알림도, 실패 알림도 없습니다</strong> — 다른 화면으로 가도 결과는 이 미디어에 남아 있고, 이 화면에서 다시 볼 수 있습니다. 출연자 사진이 등록돼 있지 않으면 생성에 실패하는데, 그 경우 몇 분 뒤에도 결과가 비어 있습니다.
                  </p>
                </div>

                {/* Thumbnail Gen Primary Action Button */}
                <button
                  type="button"
                  onClick={() => { void generate(); }}
                  disabled={busy}
                  className="w-full py-2.5 rounded-full bg-[#1C60FF] text-white font-bold text-xs hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer flex items-center justify-center gap-1.5 mt-2 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <span>{busy ? "요청 중…" : "썸네일 생성"}</span>
                </button>
              </div>

              {/* Result Area Panel */}
              <div className="bg-[var(--color-bg-card)] border-none rounded-xl p-4 space-y-3 flex-1 flex flex-col min-h-[160px] shadow-md shadow-slate-900/5 dark:shadow-none">
                <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-2">
                  <h4 className="font-bold text-[var(--color-text-primary)] text-xs">
                    결과
                  </h4>
                  <button
                    onClick={() => { void loadCandidates(targetMediaId); }}
                    disabled={!targetMediaId || candLoading}
                    className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${candLoading ? "animate-spin" : ""}`} />
                    <span>새로고침</span>
                  </button>
                </div>

                {candidates.length > 0 ? (
                  // 원본엔 후보를 고르는 수단이 아예 없었다 — 부제가 "3안 중 대표 지정" 인데도.
                  <div className="flex-1 grid grid-cols-3 gap-2 content-start">
                    {candidates.map((c) => {
                      const isPicked = selected === c.name;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => { void choose(c.name); }}
                          title={isPicked ? "대표 썸네일" : "대표로 지정"}
                          className={`p-[2.5px] rounded-lg transition-all cursor-pointer aspect-[16/9] ${
                            isPicked ? "bg-[#1C60FF] shadow-md shadow-[#1C60FF]/25" : "bg-transparent"
                          }`}
                        >
                          <div className="w-full h-full rounded-[7px] overflow-hidden bg-slate-900">
                            {/* eslint-disable-next-line @next/next/no-img-element -- 생성 결과 이미지 */}
                            <img src={c.url} alt={c.name} className="w-full h-full object-cover" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex-1 border border-dashed border-[var(--color-border-subtle)] rounded-xl flex items-center justify-center text-center p-4 text-xs text-[var(--color-text-muted)]">
                    {error
                      ? `결과를 불러오지 못했습니다 (${error})`
                      : candLoading
                        ? "불러오는 중…"
                        : selectedMedia
                          ? "기존 썸네일 생성 결과가 없습니다."
                          : "대상을 고르면 기존 결과가 여기 보입니다"}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

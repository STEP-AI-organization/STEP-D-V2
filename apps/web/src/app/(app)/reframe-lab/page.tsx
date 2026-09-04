"use client";

/**
 * 리프레임 랩 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/reframe-lab/page.tsx` 376줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * ## ⚠️ 원본은 화면이 약속한 걸 하나도 안 한다
 * 이 화면의 존재 이유는 **리프레임 정답 수집**이다(`reframe_labels`). 그런데 원본은:
 *  1. `이 레이아웃으로` 버튼 4개에 **`onClick` 이 없다.** 카드 클릭은 로컬 state 만 바꿔
 *     새로고침하면 사라진다 → 그대로 옮기면 **라벨이 한 행도 안 쌓인다.**
 *     `createReframeCompare`·`fetchReframeCompare`·`fetchReframeLabels`·`saveReframeLabel`·
 *     `reframeCompareFileUrl` **다섯 함수의 소비처는 리포 전체에서 이 파일 하나뿐**이다 —
 *     서버 라우트와 잡은 그대로 남고 부르는 데만 0 이 되는, 이 리포 최빈 실패 형태다.
 *  2. `3초 동시 재생` 버튼에 **핸들러가 없다.** 정지 프레임만 보고 고르게 된다.
 *  3. 하단 스크러버가 **이미지만 바꾼다.** 우리는 4개 `<video>` 를 전부 그 시각으로 옮긴다 —
 *     원본 문구 "아래 프레임 줄을 눌러 다른 장면 확인" 이 그대로 거짓말이 된다.
 *  4. 저장 후 **다음 미라벨 클립 자동 이동**이 없다(노가다를 줄이는 유일한 장치).
 *  5. 메모가 로컬 state 로 끝난다.
 *
 * ## 그래서 카드 안이 `<img>` 가 아니라 `<video>` 다
 * 원본은 정지 이미지 4장이지만, 우리는 프록시 영상 하나를 **레이아웃 4종의 기하로 각각 잘라**
 * 동시에 튼다. 크롭 산식(`y/h/fraction`)은 편집기 프리셋·서버 렌더와 **같은 값**이라,
 * 여기서 고른 게 실제 렌더 결과와 같은 구도다. 바깥 카드·배지·버튼 마크업은 원본 그대로다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Play } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import {
  createReframeCompare,
  fetchReframeCompare,
  fetchReframeLabels,
  reframeCompareFileUrl,
  saveReframeLabel,
  type ReframeCompareResult,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";

/**
 * 세로 레이아웃 4종 — 편집기 aspect-presets 의 세로 프리셋과 같은 id·라벨·기하.
 * rect y/h 는 1080×1920 캔버스 px · fraction 은 "원본 폭의 몇 %가 살아남나"(16:9 기준).
 * 비교 산출물(candidates.json)의 cropWidthFraction 과 같은 산식이라 서버 렌더와 일치한다.
 */
const LAYOUTS: { id: string; label: string; hint: string; y: number; h: number; fraction: number }[] = [
  { id: "9:16-letterbox", label: "전체 담기", hint: "원본 전체 + 위아래 여백", y: 0, h: 1920, fraction: 1 },
  { id: "9:16-crop-sub", label: "위아래 띠", hint: "위·아래 띠 + 가운데 영상", y: 440, h: 980, fraction: 0.62 },
  { id: "9:16-crop-main", label: "위 자막띠", hint: "위 띠 1개 + 아래 큰 영상", y: 440, h: 1480, fraction: 0.4105 },
  { id: "9:16-crop-full", label: "꽉 채우기", hint: "중앙 크롭 · 여백 없음", y: 0, h: 1920, fraction: 0.3164 },
];
const layoutMeta = (id: string) => LAYOUTS.find((l) => l.id === id);

/** 배치마다 라벨 색이 다르다 — 원본이 네 카드를 색으로 구분한다(파랑·초록·앰버·로즈). */
const LAYOUT_ACCENT: Record<string, string> = {
  "9:16-letterbox": "text-[#1C60FF]",
  "9:16-crop-sub": "text-emerald-400",
  "9:16-crop-main": "text-amber-400",
  "9:16-crop-full": "text-rose-400",
};

/** 세로 클립인가 — 평가 대상은 9:16 계열만(가로 제외). */
const isVertical = (aspect: unknown) => typeof aspect === "string" && aspect.startsWith("9:16");

export default function ReframeLabPage() {
  const { toast } = useToast();
  const { clips } = useAppData();
  const verticalClips = useMemo(() => clips.filter((c) => isVertical(c.aspectRatio)), [clips]);

  const [clipId, setClipId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [result, setResult] = useState<ReframeCompareResult | null>(null);
  const [starting, setStarting] = useState(false);
  // 프리뷰 마스터 시각(소스 절대초) — 4창 동기화 축.
  const [previewT, setPreviewT] = useState(0);
  const [safeZoneEnabled, setSafeZoneEnabled] = useState(true);
  const [savedChoice, setSavedChoice] = useState<string | null>(null);
  const [memoText, setMemoText] = useState("");
  const [labeling, setLabeling] = useState(false);
  // 이 세션에서 라벨한 클립 — 자동 이동이 건너뛸 대상(서버 재조회 없이).
  const labeledSet = useRef<Set<string>>(new Set());
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  const load = useCallback(async (cid: string, cmp: string) => {
    const r = await fetchReframeCompare(cid, cmp);
    setResult(r);
    if (r.status === "ready" || r.status === "failed") stopPoll();
    if (r.status === "ready" && r.manifest) {
      setPreviewT(r.manifest.clipStart);
      const labels = await fetchReframeLabels(cid, cmp).catch(() => []);
      const mine = labels.find((l) => !l.beat_id); // 클립 단위 라벨(구간 라벨과 구분)
      setSavedChoice(mine?.chosen ?? null);
      if (mine) labeledSet.current.add(cid);
    }
  }, [stopPoll]);

  const start = useCallback(async (cid: string) => {
    if (!cid || starting) return;
    setStarting(true);
    setResult(null);
    setSavedChoice(null);
    try {
      const created = await createReframeCompare(cid);
      setCompareId(created.compareId);
      await load(cid, created.compareId);
      stopPoll();
      // 원본 문구가 "3초마다 자동 확인" 이라고 적혀 있다 — 실제로 그렇게 돈다.
      pollRef.current = setInterval(() => { void load(cid, created.compareId); }, 3000);
    } catch (err) {
      toast({ title: "비교 생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setStarting(false);
    }
  }, [starting, load, stopPoll, toast]);

  const ready = result?.status === "ready" && result.candidates && result.manifest;
  const status: "idle" | "analyzing" | "completed" =
    !clipId ? "idle" : ready ? "completed" : "analyzing";
  const clipStart = result?.manifest?.clipStart ?? 0;
  const clipEnd = result?.manifest?.clipEnd ?? 0;
  const proxyUrl = ready ? reframeCompareFileUrl(clipId, compareId, "proxy.mp4") : "";

  /** AI 추천 — 구간별 확정 중 제일 오랜 시간 고른 레이아웃(타임라인 지속시간 합산). */
  const aiPick = useMemo(() => {
    if (!ready) return null;
    const dur: Record<string, number> = {};
    for (const s of result!.candidates!.segments) {
      dur[s.final] = (dur[s.final] ?? 0) + Math.max(0, s.end - s.start);
    }
    let best: string | null = null;
    for (const [k, v] of Object.entries(dur)) if (best == null || v > (dur[best] ?? 0)) best = k;
    return best;
  }, [ready, result]);

  /** 4창 동시 재생 — 현재 시각부터 3.5초. 원본 버튼엔 핸들러가 없었다. */
  function playPreview() {
    const rel = Math.max(0, previewT - clipStart);
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];
    for (const v of videos) { v.currentTime = rel; void v.play(); }
    setTimeout(() => videos.forEach((v) => v.pause()), 3500);
  }

  /** 원본 스크러버는 이미지만 바꿨다 — 우리는 4창을 전부 그 시각으로 옮긴다. */
  function seekTo(t: number) {
    setPreviewT(t);
    const rel = Math.max(0, t - clipStart);
    for (const v of videoRefs.current) if (v) v.currentTime = rel;
  }

  /** 클립당 1클릭 라벨 — 저장 후 다음 미라벨 클립으로 자동 이동(노가다 최소화의 핵심). */
  async function label(chosen: string) {
    if (!ready || labeling) return;
    setLabeling(true);
    try {
      await saveReframeLabel(clipId, {
        compareId,
        segStart: clipStart,
        segEnd: clipEnd,
        atSec: previewT,
        chosen,
        machine: aiPick ?? undefined,
        context: { unit: "clip", aiPick, switchesPerMinute: result?.candidates?.switchesPerMinute },
        note: memoText.trim() || undefined,
      });
      setSavedChoice(chosen);
      setMemoText("");
      labeledSet.current.add(clipId);
      const next = verticalClips.find((c) => !labeledSet.current.has(c.id));
      if (next) {
        toast({ title: "저장 — 다음 클립", description: `${layoutMeta(chosen)?.label} · ${next.title || next.id}` });
        setClipId(next.id);
        void start(next.id);
      } else {
        toast({ title: "저장 완료", description: "모든 클립 라벨 끝 — 수고하셨습니다!" });
      }
    } catch (err) {
      toast({ title: "라벨 저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setLabeling(false);
    }
  }

  const clipOptions = [
    { value: "", label: "세로 클립 선택 (9:16 계열만)" },
    ...verticalClips.map((c) => ({ value: c.id, label: c.title || c.id })),
  ];

  return (
    <>
      <Header title="리프레임 랩" subtitle="세로 레이아웃 4종 비교 — 정답 수집" />

      {/* Reframe Lab Main Body Container */}
      <main className="flex-1 p-5 pb-16 flex flex-col justify-between overflow-y-auto space-y-5 min-h-0">
        <div className="space-y-5">
          {/* Top Controls Bar */}
          <div className="flex items-center justify-between gap-3 text-xs bg-[var(--color-bg-card)] p-4 rounded-2xl border-none shrink-0 shadow-md shadow-slate-900/5 dark:shadow-none">
            <div className="flex items-center gap-3">
              <div className="w-[420px]">
                <CustomSelect
                  ariaLabel="세로 클립"
                  options={clipOptions}
                  value={clipId}
                  placeholder="세로 클립 선택 (9:16 계열만)"
                  onChange={(val) => {
                    if (!val) { setClipId(""); setResult(null); stopPoll(); return; }
                    setClipId(val);
                    void start(val);
                  }}
                />
              </div>

              {status === "analyzing" && (
                <div className="flex items-center gap-2 text-cyan-400 font-semibold animate-pulse text-xs">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>분석 중... 3초마다 자동 확인</span>
                </div>
              )}

              <span className="text-xs text-[var(--color-text-muted)] font-mono">
                이번 세션 라벨 {labeledSet.current.size}/{verticalClips.length}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-[var(--color-text-primary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={safeZoneEnabled}
                  onChange={(e) => setSafeZoneEnabled(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 accent-[#1C60FF]"
                />
                <span className="font-bold">Safe Zone</span>
              </label>
            </div>
          </div>

          {/* STATE 1: IDLE */}
          {status === "idle" && (
            <div className="bg-[var(--color-bg-card)] border-none rounded-2xl flex flex-col items-center justify-center text-center p-12 min-h-[420px] shadow-md shadow-slate-900/5 dark:shadow-none">
              <p className="text-xs text-[var(--color-text-muted)]">
                {verticalClips.length === 0
                  // 원본엔 없는 상태 — 목은 항상 클립이 있었다.
                  ? "세로(9:16) 클립이 없습니다 — 미디어에서 세로 클립을 만들면 여기 나타납니다."
                  : "상단 드롭다운에서 클립을 선택하면 분석 후 4가지 리프레임 레이아웃 선택지가 표시됩니다."}
              </p>
            </div>
          )}

          {/* STATE 2: ANALYZING */}
          {status === "analyzing" && (
            <div className="bg-[var(--color-bg-card)] border-none rounded-2xl flex flex-col items-center justify-center text-center p-12 min-h-[420px] space-y-3 shadow-md shadow-slate-900/5 dark:shadow-none">
              <Loader2 className="w-8 h-8 text-[var(--color-bg-active)] animate-spin" />
              <div className="space-y-1">
                <p className="text-xs font-bold text-[var(--color-text-primary)]">
                  {result?.status === "failed"
                    ? "비교 생성에 실패했습니다"
                    : "비디오 분석 및 리프레임 프레임 생성 중..."}
                </p>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {result?.status === "failed" ? "다른 클립을 골라 보세요." : "분석 중... 3초마다 자동 확인"}
                </p>
              </div>
            </div>
          )}

          {/* STATE 3: COMPLETED */}
          {status === "completed" && (
            <>
              {/* Sub Action Bar */}
              <div className="flex items-center justify-between text-xs bg-[var(--color-bg-card)] p-4 rounded-2xl border-none shrink-0 shadow-md shadow-slate-900/5 dark:shadow-none">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-[var(--color-text-primary)]">
                    이 클립을 어떤 레이아웃으로 내보낼까요? — 아래 4개 중 하나를 클릭
                  </span>

                  <button
                    onClick={playPreview}
                    className="flex items-center gap-1.5 px-4 h-9 rounded-full bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-all cursor-pointer border-none shadow-md shadow-slate-900/5 dark:shadow-none"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>3초 동시 재생</span>
                  </button>

                  <span className="text-xs text-[var(--color-text-muted)]">
                    {(previewT - clipStart).toFixed(1)}초 지점 · 아래 프레임 줄을 눌러 다른 장면 확인
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="메모(선택) — 라벨 클릭에 붙습니다"
                    value={memoText}
                    onChange={(e) => setMemoText(e.target.value)}
                    className="bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] px-4 h-9 rounded-full text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] w-72 focus:outline-none focus:border-[#1C60FF]"
                  />
                </div>
              </div>

              {/* 4 Reframe Cards Grid Container */}
              <div className="grid grid-cols-4 gap-4 bg-[var(--color-bg-card)] p-4 rounded-2xl border-none shadow-md shadow-slate-900/5 dark:shadow-none">
                {LAYOUTS.map((layout, i) => (
                  <LayoutCard
                    key={layout.id}
                    layout={layout}
                    proxyUrl={proxyUrl}
                    isAiPick={aiPick === layout.id}
                    isSaved={savedChoice === layout.id}
                    safeZone={safeZoneEnabled}
                    disabled={labeling}
                    videoRef={(el) => { videoRefs.current[i] = el; }}
                    onTime={i === 0 ? (t) => setPreviewT(clipStart + t) : undefined}
                    onPick={() => void label(layout.id)}
                  />
                ))}
              </div>

              {/* Bottom Scene Scrubber Section */}
              <div className="bg-[var(--color-bg-card)] p-4 rounded-2xl border-none space-y-3 text-xs shrink-0 shadow-md shadow-slate-900/5 dark:shadow-none">
                <div>
                  <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">
                    장면 넘겨보기 <span className="font-normal text-xs text-[var(--color-text-muted)] ml-2">— 한 장면만 보고 고르지 말고 두세 장면 확인 후 고르세요</span>
                  </h3>
                </div>

                <div className="flex items-center gap-3 overflow-x-auto pb-1">
                  {(result!.manifest!.frames ?? []).map((name) => {
                    const t = Number(name.replace(/frame-(\d+)\.jpg/, "$1")) / 1000;
                    const active = Math.abs(t - previewT) < 0.3;
                    return (
                      <button
                        key={name}
                        // 원본은 이미지만 바꿨다 — 4창을 전부 그 시각으로 옮긴다.
                        onClick={() => seekTo(t)}
                        title={`${(t - clipStart).toFixed(1)}초`}
                        className={`w-36 aspect-[16/9] rounded-xl transition-all cursor-pointer relative overflow-hidden border-none shrink-0 ${
                          active ? "ring-2 ring-[#1C60FF] shadow-md" : "opacity-75 hover:opacity-100"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- 비교 산출물 프레임 */}
                        <img
                          src={reframeCompareFileUrl(clipId, compareId, name)}
                          alt={`${(t - clipStart).toFixed(1)}초`}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <Footer />
      </main>
    </>
  );
}

/**
 * 레이아웃 한 칸 — 바깥 카드·배지·버튼은 원본 그대로. 안쪽만 `<img>` 가 아니라 `<video>` 다.
 * 크롭 산식은 편집기 프리셋·서버 렌더와 같은 값이라, 여기서 고른 게 실제 결과와 같은 구도다.
 */
function LayoutCard({
  layout, proxyUrl, isAiPick, isSaved, safeZone, disabled, videoRef, onTime, onPick,
}: {
  layout: (typeof LAYOUTS)[number];
  proxyUrl: string;
  isAiPick: boolean;
  isSaved: boolean;
  safeZone: boolean;
  disabled: boolean;
  videoRef: (el: HTMLVideoElement | null) => void;
  onTime?: (relSec: number) => void;
  onPick: () => void;
}) {
  const areaTopPct = (layout.y / 1920) * 100;
  const areaHeightPct = (layout.h / 1920) * 100;
  const isLetterbox = layout.id === "9:16-letterbox";
  // 중앙 크롭: 영상 폭 = 영역폭/fraction · 중앙 정렬 = 좌우 균등 오버플로 — 서버 렌더와 같은 산식.
  const mediaWidthPct = (1 / layout.fraction) * 100;
  const mediaLeftPct = -((0.5 - layout.fraction / 2) / layout.fraction) * 100;

  return (
    <div className={`rounded-2xl p-2 flex flex-col justify-between space-y-3 transition-all cursor-pointer bg-transparent border-none ${isSaved ? "ring-2 ring-[#1C60FF]" : ""}`}>
      {/* 9:16 Video Box */}
      <div className="aspect-[9/16] bg-black rounded-xl relative overflow-hidden flex flex-col justify-center items-center border-none">
        {safeZone && (
          <>
            <div className="absolute top-0 left-0 right-0 h-[18%] bg-red-600/25 border-b border-red-500/40 border-dashed pointer-events-none z-20" />
            <div className="absolute bottom-0 left-0 right-0 h-[18%] bg-red-600/25 border-t border-red-500/40 border-dashed pointer-events-none z-20" />
          </>
        )}

        <div className="absolute inset-x-0 overflow-hidden" style={{ top: `${areaTopPct}%`, height: `${areaHeightPct}%` }}>
          {isLetterbox ? (
            <video
              ref={videoRef} src={proxyUrl} muted playsInline preload="metadata"
              className="absolute left-0 top-1/2 w-full -translate-y-1/2"
              onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
            />
          ) : (
            <video
              ref={videoRef} src={proxyUrl} muted playsInline preload="metadata"
              // max-w-none 필수 — Tailwind preflight `video{max-width:100%}` 가 확대 폭을
              // 클램프해 크롭이 어긋난다(2026-08-25 실측). 자르기는 부모 overflow-hidden 담당.
              className="absolute top-0 max-w-none"
              style={{ width: `${mediaWidthPct}%`, left: `${mediaLeftPct}%` }}
              onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
            />
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="text-xs space-y-1 px-1">
        <div className="flex items-center gap-2">
          <span className={`font-bold ${LAYOUT_ACCENT[layout.id] ?? "text-[#1C60FF]"}`}>{layout.label}</span>
          {isAiPick && (
            <span className="px-2 py-0.5 rounded-full bg-[#1C60FF]/20 text-[#1C60FF] text-[10px] font-bold border-none">
              AI 추천
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">{layout.hint}</p>
      </div>

      {/* 원본은 이 버튼에 onClick 이 없었다 — 이 화면의 목적물이 여기 걸려 있다. */}
      <button
        onClick={onPick}
        disabled={disabled}
        className="w-full py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-slate-300 dark:border-slate-700 font-bold transition-all cursor-pointer flex items-center justify-center gap-1 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {isSaved && <Check className="w-3.5 h-3.5 text-[#1C60FF]" />}
        <span>{isSaved ? "이 레이아웃 (정답)" : "이 레이아웃으로"}</span>
      </button>
    </div>
  );
}

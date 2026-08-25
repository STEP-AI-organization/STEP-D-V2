"use client";

/**
 * 리프레임 랩 — "이 클립엔 어떤 세로 레이아웃?" 클립당 1클릭 정답 수집.
 *
 * 2026-08-25 방향 전환(사용자): beat 구간별 얼굴추적 크롭 평가는 **접었다** — "어차피 저런
 * 크롭 안 쓸 건데 뭘 평가하나. 편집기의 레이아웃 중 어떤 걸 쓸지만 고르는 것." 렌더는
 * 편집기 프리셋(aspect-presets · 고정 기하)으로만 나가므로, 평가도 그 단위로 한다:
 * 클립 하나 = 세로 4종(전체 담기·꽉 채우기·위 자막띠·위아래 띠) 중 하나를 고르는 것.
 *
 * 미리보기는 편집기/렌더와 같은 정적 기하(중앙 크롭 · rect 배치)를 CSS 로 그린다 — 프록시
 * 1개를 4개 창이 나눠 본다. 비교 잡(reframe.compare) 산출물의 프록시·contact sheet 를
 * 재사용하고, AI 의 구간별 판단은 "AI 추천" 배지 하나로 접어서 보여준다(제일 오래 고른
 * 레이아웃). 라벨은 append 전용 reframe_labels — 저장하면 다음 미라벨 클립으로 자동 이동.
 * 통계 분석은 md 문서(docs/research/reframe-corpus-*.md)로 축적한다(계획 §9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import {
  createReframeCompare,
  fetchReframeCompare,
  fetchReframeLabels,
  reframeCompareFileUrl,
  saveReframeLabel,
  type ReframeCompareResult,
} from "@/lib/data/api";

/**
 * 세로 레이아웃 4종 — 편집기 aspect-presets 의 세로 프리셋과 같은 id·라벨·기하.
 * rect y/h 는 1080×1920 캔버스 px(aspect-presets 와 동일). fraction 은 "원본 폭의 몇 %가
 * 살아남나"(16:9 원본 기준 고정값) — 비교 산출물(candidates.json)의 cropWidthFraction 과
 * 같은 산식이라 서버 렌더 기하와 일치한다.
 */
const LAYOUTS: { id: string; label: string; hint: string; y: number; h: number; fraction: number; color: string }[] = [
  { id: "9:16-letterbox", label: "전체 담기", hint: "원본 전체 + 위아래 여백", y: 0, h: 1920, fraction: 1, color: "#5B8DEF" },
  { id: "9:16-crop-sub", label: "위아래 띠", hint: "위·아래 띠 + 가운데 영상", y: 440, h: 980, fraction: 0.62, color: "#40B87A" },
  { id: "9:16-crop-main", label: "위 자막띠", hint: "위 띠 1개 + 아래 큰 영상", y: 440, h: 1480, fraction: 0.4105, color: "#E0A63E" },
  { id: "9:16-crop-full", label: "꽉 채우기", hint: "중앙 크롭 · 여백 없음", y: 0, h: 1920, fraction: 0.3164, color: "#E06060" },
];
const layoutMeta = (id: string) => LAYOUTS.find((l) => l.id === id);

/** 세로 클립인가 — 평가 대상은 9:16 계열만(가로 제외). */
const isVertical = (aspect: unknown) => typeof aspect === "string" && aspect.startsWith("9:16");

export default function ReframeLabPage() {
  const { toast } = useToast();
  const { clips } = useAppData();
  const verticalClips = useMemo(
    () => clips.filter((c) => isVertical(c.aspectRatio)),
    [clips],
  );

  const [clipId, setClipId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [result, setResult] = useState<ReframeCompareResult | null>(null);
  const [starting, setStarting] = useState(false);
  // 프리뷰 마스터 시각(소스 절대초) — 4창 동기화 축.
  const [previewT, setPreviewT] = useState(0);
  const [safeZone, setSafeZone] = useState(true);
  // 이 클립의 저장된 정답(레이아웃 id) — null 이면 아직 미라벨.
  const [savedChoice, setSavedChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [labeling, setLabeling] = useState(false);
  // 이 세션에서 라벨한 클립 — 자동 이동이 건너뛸 대상 (서버 재조회 없이).
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
      pollRef.current = setInterval(() => { void load(cid, created.compareId); }, 3000);
    } catch (err) {
      toast({ title: "비교 생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setStarting(false);
    }
  }, [starting, load, stopPoll, toast]);

  const ready = result?.status === "ready" && result.candidates && result.manifest;
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

  /** 4창 동시 재생 — 현재 시각부터 3.5초. 첫 창의 timeupdate 가 마스터 시각을 민다. */
  function playPreview() {
    const rel = Math.max(0, previewT - clipStart);
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];
    for (const v of videos) { v.currentTime = rel; void v.play(); }
    setTimeout(() => videos.forEach((v) => v.pause()), 3500);
  }

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
        context: {
          unit: "clip",
          aiPick,
          switchesPerMinute: result?.candidates?.switchesPerMinute,
        },
        note: note.trim() || undefined,
      });
      setSavedChoice(chosen);
      setNote("");
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

  return (
    <div className="flex flex-col gap-3">
      {/* ── 클립 선택 ─────────────────────────────────────────────────── */}
      <div className="sd-card flex flex-wrap items-center gap-2 p-3">
        <select
          value={clipId}
          onChange={(e) => { setClipId(e.target.value); if (e.target.value) void start(e.target.value); }}
          className="sd-input min-w-[280px]"
        >
          <option value="">세로 클립 선택 (9:16 계열만)</option>
          {verticalClips.map((c) => (
            <option key={c.id} value={c.id}>
              {labeledSet.current.has(c.id) ? "✓ " : ""}{c.title || c.id}
            </option>
          ))}
        </select>
        {result && !ready && (
          <span className="text-[11.5px]" style={{ color: result.status === "failed" ? "var(--sd-danger-strong)" : "var(--sd-mut)" }}>
            {result.status === "failed"
              ? `실패 — ${result.error ?? "원인 미상"} (클립을 다시 선택해 재시도)`
              : result.status === "not_found"
                ? "산출물이 없습니다 — 다시 선택하면 분석을 시작합니다"
                : "분석 중… 3초마다 자동 확인"}
          </span>
        )}
        <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
          이번 세션 라벨 {labeledSet.current.size}/{verticalClips.length}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sd-fg)" }}>
          <input type="checkbox" checked={safeZone} onChange={(e) => setSafeZone(e.target.checked)} /> Safe Zone
        </label>
      </div>

      {ready && (
        <>
          {/* ── 안내 + 재생 컨트롤 ─────────────────────────────────────── */}
          <div className="sd-card flex flex-wrap items-center gap-2 p-3">
            <span className="text-[12px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              이 클립을 어떤 레이아웃으로 내보낼까요? — 아래 4개 중 하나를 클릭
            </span>
            <button type="button" className="sd-btn" onClick={playPreview}>▶ 3초 동시 재생</button>
            <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              {(previewT - clipStart).toFixed(1)}초 지점 · 아래 프레임 줄을 눌러 다른 장면 확인
            </span>
            {savedChoice && (
              <span className="text-[11px] font-semibold" style={{ color: layoutMeta(savedChoice)?.color }}>
                ✓ 저장된 정답: {layoutMeta(savedChoice)?.label} (다시 누르면 교체)
              </span>
            )}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="메모(선택) — 라벨 클릭에 붙습니다"
              className="ml-auto sd-input w-[220px] text-[11px]"
            />
          </div>

          {/* ── 4개 레이아웃 나란히 (편집기 기하 그대로 · 정적) ───────────── */}
          <div className="sd-card p-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {LAYOUTS.map((layout, i) => (
                <LayoutPanel
                  key={layout.id}
                  layout={layout}
                  proxyUrl={proxyUrl}
                  isAiPick={aiPick === layout.id}
                  isSaved={savedChoice === layout.id}
                  safeZone={safeZone}
                  disabled={labeling}
                  videoRef={(el) => { videoRefs.current[i] = el; }}
                  onTime={i === 0 ? (t) => setPreviewT(clipStart + t) : undefined}
                  onPick={() => void label(layout.id)}
                />
              ))}
            </div>
          </div>

          {/* ── Contact sheet — 클릭하면 그 장면으로 4창 이동 ─────────────── */}
          <div className="sd-card p-3">
            <div className="mb-1.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              장면 넘겨보기 — 한 장면만 보고 고르지 말고 두세 장면 확인 후 고르세요
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {(result!.manifest!.frames ?? []).map((name) => {
                const t = Number(name.replace(/frame-(\d+)\.jpg/, "$1")) / 1000;
                return (
                  <button key={name} type="button" onClick={() => seekTo(t)} title={`${(t - clipStart).toFixed(1)}초`} className="shrink-0">
                    <img
                      src={reframeCompareFileUrl(clipId, compareId, name)}
                      alt={`${(t - clipStart).toFixed(1)}초`}
                      className="h-[64px] rounded-[3px]"
                      style={{ border: Math.abs(t - previewT) < 0.3 ? "2px solid var(--sd-accent)" : "1px solid var(--sd-border)" }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 레이아웃 한 칸 — 편집기/렌더와 같은 정적 기하. 추적·패닝 없음(중앙 크롭):
 * 렌더가 이 프리셋으로 굽는 결과와 같은 구도다.
 */
function LayoutPanel({ layout, proxyUrl, isAiPick, isSaved, safeZone, disabled, videoRef, onTime, onPick }: {
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
    <div className="flex flex-col gap-1.5">
      <div
        className="relative w-full overflow-hidden rounded-[6px]"
        style={{
          aspectRatio: "9/16", background: "#000",
          border: isSaved ? `2px solid ${layout.color}` : "1px solid var(--sd-border)",
        }}
      >
        <div
          className="absolute inset-x-0 overflow-hidden"
          style={{ top: `${areaTopPct}%`, height: `${areaHeightPct}%` }}
        >
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
        {/* Safe Zone — 플랫폼 UI 가 가리는 영역(상단 ~10% · 하단 ~25% · 우측 액션 레일). */}
        {safeZone && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10" style={{ height: "10%", background: "rgba(224,96,96,.18)", borderBottom: "1px dashed rgba(224,96,96,.6)" }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10" style={{ height: "25%", background: "rgba(224,96,96,.18)", borderTop: "1px dashed rgba(224,96,96,.6)" }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10" style={{ width: "12%", background: "rgba(224,96,96,.10)" }} />
          </>
        )}
      </div>

      <div className="text-[10.5px] leading-snug">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold" style={{ color: layout.color }}>{layout.label}</span>
          {isAiPick && <span className="sd-tag" style={{ borderColor: layout.color, color: layout.color }}>AI 추천</span>}
        </div>
        <div style={{ color: "var(--sd-mut)" }}>{layout.hint}</div>
      </div>
      <button
        type="button"
        className="sd-btn w-full text-[10.5px]"
        disabled={disabled}
        onClick={onPick}
        style={isSaved ? { borderColor: layout.color, color: layout.color, fontWeight: 600 } : undefined}
      >
        {isSaved ? "✓ 이 레이아웃 (정답)" : "이 레이아웃으로"}
      </button>
    </div>
  );
}

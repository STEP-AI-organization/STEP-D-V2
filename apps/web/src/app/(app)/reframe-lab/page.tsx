"use client";

/**
 * 리프레임 랩 — 세로 4택 비교 뷰어 (reframe-compare-viewer-plan §3 · 내부 평가용).
 *
 * 클립 하나의 주요 장면을 4개 세로 레이아웃(전체 담기·위아래 띠·위 자막띠·꽉 채우기)으로
 * 나란히 보고, 후보별 점수·탈락 사유·샷별 타임라인을 확인한다. 구간마다 **"이 장면은 이
 * 레이아웃" 1클릭 라벨**을 남긴다(계획 §5 · append 전용 · 저장 시 그 순간의 후보 점수·게이트
 * 스냅샷이 자동으로 조인된다). 통계 분석·가중치 조정 근거는 여전히 md 문서
 * (docs/research/reframe-corpus-*.md)로 축적한다는 절충(계획 §9) — 이 화면은 수집까지만.
 *
 * 프리뷰 기하 = 서버 산출물(candidates.json)의 cropWidthFraction·tracking 좌표를 CSS 로
 * 그대로 적용한다 — 후보별 영상을 따로 렌더하지 않고 프록시 1개를 4개 창이 나눠 본다
 * (aspect-presets 의 1080×1920 rect 와 같은 % 체계라 실렌더와 기하가 일치한다).
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
  type ReframeCandidate,
  type ReframeCompareResult,
  type ReframeCompareSegment,
  type ReframeLabelRow,
} from "@/lib/data/api";

/** 레이아웃 표시 메타 — rect 는 aspect-presets(1080×1920)와 같은 값. */
const LAYOUT_META: Record<string, { label: string; y: number; h: number; color: string }> = {
  "9:16-letterbox": { label: "전체 담기", y: 0, h: 1920, color: "#5B8DEF" },
  "9:16-crop-sub": { label: "위아래 띠", y: 440, h: 980, color: "#40B87A" },
  "9:16-crop-main": { label: "위 자막띠", y: 440, h: 1480, color: "#E0A63E" },
  "9:16-crop-full": { label: "꽉 채우기", y: 0, h: 1920, color: "#E06060" },
};

/** 탈락·선정 사유 코드 → 사람 말 (모르는 코드는 원문 그대로 보여준다 — 숨기지 않는다). */
const REASON_KO: Record<string, string> = {
  FULL_SOURCE_PRESERVED: "원본 전체 보존",
  SAFETY_GATES_PASSED: "안전성 통과",
  LOW_DETECTION_COVERAGE: "얼굴 감지율 부족",
  MULTI_PERSON_DOMINANCE: "주인공 우세 부족(공격적 크롭)",
  UNSAFE_VERTICAL_CROP: "크롭 안전률 부족",
  LONG_DETECTION_GAP: "추적 누락 0.5초+",
  MULTI_PERSON_AMBIGUOUS: "다인 모호 0.5초+",
  EMPTY_TRACKING_PATH: "추적 경로 없음",
  BEAT_GAP_FALLBACK: "beat 공백 구간",
  BEST_SCORE: "최고 점수",
  SINGLE_SUBJECT_STABLE_PREFERS_FULL: "단독 인물 안정 — 꽉 채우기 우선",
  HOLD_NOT_AT_SHOT_BOUNDARY: "샷 경계 아님 — 유지",
  HOLD_MIN_DURATION: "2초 미유지 — 유지",
  HOLD_SCORE_HYSTERESIS: "점수 차 10 미만 — 유지",
  SAFETY_DEMOTION: "안전 악화 — 즉시 강등",
};

const reasonKo = (code: string) => REASON_KO[code] ?? code;

/** 세로 클립인가 — 비교 대상은 9:16 계열만(계획 §1 · 가로 제외). */
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
  const [selSeg, setSelSeg] = useState(0);
  // 프리뷰 마스터 시각(소스 절대초) — 추적 중심 계산·4창 동기화의 축.
  const [previewT, setPreviewT] = useState(0);
  const [safeZone, setSafeZone] = useState(true);
  const [showTrack, setShowTrack] = useState(true);
  // 라벨(사람 정답) — 구간별 최신 라벨만 표시에 쓴다. note 는 다음 라벨 클릭에 붙는 선택 메모.
  const [labels, setLabels] = useState<ReframeLabelRow[]>([]);
  const [note, setNote] = useState("");
  const [labeling, setLabeling] = useState(false);
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
      // 기존 라벨 불러오기 — 이어서 라벨할 때 어디까지 했는지 보여야 한다.
      setLabels(await fetchReframeLabels(cid, cmp).catch(() => []));
    }
  }, [stopPoll]);

  async function start() {
    if (!clipId || starting) return;
    setStarting(true);
    setResult(null);
    setSelSeg(0);
    try {
      const created = await createReframeCompare(clipId);
      setCompareId(created.compareId);
      await load(clipId, created.compareId);
      stopPoll();
      pollRef.current = setInterval(() => { void load(clipId, created.compareId); }, 3000);
    } catch (err) {
      toast({ title: "비교 생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setStarting(false);
    }
  }

  const ready = result?.status === "ready" && result.candidates && result.manifest;
  const segments = useMemo(
    () => (ready ? result!.candidates!.segments.filter((s) => !s.synthetic) : []),
    [ready, result],
  );
  const segment: ReframeCompareSegment | undefined = segments[selSeg];
  const clipStart = result?.manifest?.clipStart ?? 0;
  const clipEnd = result?.manifest?.clipEnd ?? 0;
  const proxyUrl = ready ? reframeCompareFileUrl(clipId, compareId, "proxy.mp4") : "";

  /** 4창 동시 재생 — 선택 구간 시작에서 3.5초. 첫 창의 timeupdate 가 마스터 시각을 민다. */
  function playPreview() {
    if (!segment) return;
    const rel = Math.max(0, segment.start - clipStart);
    const videos = videoRefs.current.filter(Boolean) as HTMLVideoElement[];
    for (const v of videos) { v.currentTime = rel; void v.play(); }
    setTimeout(() => videos.forEach((v) => v.pause()), 3500);
  }

  function seekTo(t: number) {
    setPreviewT(t);
    const rel = Math.max(0, t - clipStart);
    for (const v of videoRefs.current) if (v) v.currentTime = rel;
  }

  /** 구간의 최신 라벨 — labels 는 최신순 정렬이라 첫 매치가 최신이다(append 전용 · 재라벨 허용). */
  const labelOf = useCallback(
    (beatId: unknown) => labels.find((l) => l.beat_id === String(beatId)),
    [labels],
  );
  const labeledCount = useMemo(
    () => segments.filter((s) => labelOf(s.beatId)).length,
    [segments, labelOf],
  );

  /** 1클릭 라벨 저장 — 그 순간의 후보 점수·게이트를 통째로 조인해 남기고, 다음 미라벨 구간으로 이동. */
  async function label(chosen: string) {
    if (!segment || labeling) return;
    setLabeling(true);
    try {
      await saveReframeLabel(clipId, {
        compareId,
        beatId: String(segment.beatId),
        segStart: segment.start,
        segEnd: segment.end,
        atSec: previewT,
        chosen,
        machine: segment.final,
        context: {
          candidates: segment.candidates.map((x) => ({
            layout: x.layout, score: x.score, eligible: x.eligible,
            reasonCodes: x.reasonCodes, metrics: x.metrics,
          })),
          hysteresis: segment.hysteresis,
          switchesPerMinute: result?.candidates?.switchesPerMinute,
        },
        note: note.trim() || undefined,
      });
      setNote("");
      const fresh = await fetchReframeLabels(clipId, compareId).catch(() => labels);
      setLabels(fresh);
      // 다음 미라벨 구간으로 자동 이동 — 라벨 노가다의 클릭 수를 반으로 줄인다.
      const isLabeled = (s: ReframeCompareSegment) => fresh.some((l) => l.beat_id === String(s.beatId));
      const next = segments.findIndex((s, i) => i > selSeg && !isLabeled(s));
      if (next >= 0) { setSelSeg(next); seekTo(segments[next].start); }
    } catch (err) {
      toast({ title: "라벨 저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setLabeling(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── 클립 선택 + 실행 ─────────────────────────────────────────────── */}
      <div className="sd-card flex flex-wrap items-center gap-2 p-3">
        <select value={clipId} onChange={(e) => setClipId(e.target.value)} className="sd-input min-w-[280px]">
          <option value="">세로 클립 선택 (9:16 계열만 — 가로는 비교 제외)</option>
          {verticalClips.map((c) => (
            <option key={c.id} value={c.id}>{c.title || c.id} · {c.aspectRatio}</option>
          ))}
        </select>
        <button type="button" className="sd-btn sd-btn-primary" disabled={!clipId || starting} onClick={() => void start()}>
          {starting ? "요청 중…" : "4택 비교 생성/불러오기"}
        </button>
        {result && !ready && (
          <span className="text-[11.5px]" style={{ color: result.status === "failed" ? "var(--sd-danger-strong)" : "var(--sd-mut)" }}>
            {result.status === "failed"
              ? `실패 — ${result.error ?? "원인 미상"} (다시 눌러 재시도)`
              : result.status === "not_found"
                ? "산출물이 없습니다 — 생성 버튼으로 시작하세요"
                : `${result.status === "running" ? "분석 중" : "대기 중"}… 3초마다 자동 확인`}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sd-fg)" }}>
          <input type="checkbox" checked={safeZone} onChange={(e) => setSafeZone(e.target.checked)} /> Safe Zone
        </label>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--sd-fg)" }}>
          <input type="checkbox" checked={showTrack} onChange={(e) => setShowTrack(e.target.checked)} /> 추적 중심
        </label>
      </div>

      {ready && segment && (
        <>
          {/* ── 4개 후보 나란히 ─────────────────────────────────────────── */}
          <div className="sd-card p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold" style={{ color: "var(--sd-fg)" }}>
                구간 {selSeg + 1}/{segments.length} · beat {String(segment.beatId)} ·{" "}
                {segment.start.toFixed(1)}–{segment.end.toFixed(1)}초
              </span>
              <button type="button" className="sd-btn" onClick={playPreview}>▶ 3초 동시 프리뷰</button>
              <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                확정: <b style={{ color: LAYOUT_META[segment.final]?.color }}>{LAYOUT_META[segment.final]?.label}</b>
                {segment.hysteresis.length > 0 && ` (${segment.hysteresis.map(reasonKo).join(" · ")})`}
                {" · 전환 "}{result!.candidates!.switchesPerMinute}회/분
              </span>
              <span className="ml-auto text-[10.5px] font-semibold" style={{ color: labeledCount === segments.length ? "var(--sd-ok)" : "var(--sd-fg)" }}>
                라벨 {labeledCount}/{segments.length}
                {(() => {
                  const l = labelOf(segment.beatId);
                  return l ? ` · 이 구간: ${LAYOUT_META[l.chosen]?.label}${l.agree ? " (기계 일치)" : " (기계와 다름)"}` : "";
                })()}
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="메모(선택) — 다음 라벨 클릭에 붙습니다"
                className="sd-input w-[240px] text-[11px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {segment.candidates.map((candidate, i) => (
                <CandidatePanel
                  key={candidate.layout}
                  candidate={candidate}
                  proxyUrl={proxyUrl}
                  clipStart={clipStart}
                  previewT={previewT}
                  isFinal={segment.final === candidate.layout}
                  safeZone={safeZone}
                  showTrack={showTrack}
                  videoRef={(el) => { videoRefs.current[i] = el; }}
                  onTime={i === 0 ? (t) => setPreviewT(clipStart + t) : undefined}
                  labeled={labelOf(segment.beatId)?.chosen === candidate.layout}
                  onLabel={labeling ? undefined : () => void label(candidate.layout)}
                />
              ))}
            </div>
          </div>

          {/* ── 샷별 레이아웃 타임라인 ─────────────────────────────────── */}
          <div className="sd-card p-3">
            <div className="mb-1.5 flex items-center gap-3 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              <span>확정 레이아웃 타임라인 — 구간을 눌러 이동</span>
              {Object.entries(LAYOUT_META).map(([id, meta]) => (
                <span key={id} className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: meta.color }} />{meta.label}
                </span>
              ))}
            </div>
            <div className="flex h-7 w-full overflow-hidden rounded-[4px]" style={{ border: "1px solid var(--sd-border)" }}>
              {segments.map((s, i) => (
                <button
                  key={`${s.beatId}-${i}`}
                  type="button"
                  title={`${s.start.toFixed(1)}–${s.end.toFixed(1)}s · ${LAYOUT_META[s.final]?.label}`}
                  onClick={() => { setSelSeg(i); seekTo(s.start); }}
                  style={{
                    width: `${((s.end - s.start) / Math.max(0.001, clipEnd - clipStart)) * 100}%`,
                    background: LAYOUT_META[s.final]?.color ?? "#666",
                    opacity: i === selSeg ? 1 : 0.45,
                    borderRight: "1px solid rgba(0,0,0,.35)",
                    // 라벨된 구간은 흰 윗줄 — 어디까지 라벨했는지 한눈에.
                    boxShadow: labelOf(s.beatId) ? "inset 0 3px 0 rgba(255,255,255,.9)" : undefined,
                  }}
                />
              ))}
            </div>
          </div>

          {/* ── Contact sheet — 클릭하면 그 시각으로 4창 이동 ─────────────── */}
          <div className="sd-card p-3">
            <div className="mb-1.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              대표 프레임 (시작·끝·분위수·샷 경계·전환 지점) · 현재 {previewT.toFixed(1)}초
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {(result!.manifest!.frames ?? []).map((name) => {
                const t = Number(name.replace(/frame-(\d+)\.jpg/, "$1")) / 1000;
                return (
                  <button key={name} type="button" onClick={() => seekTo(t)} title={`${t.toFixed(1)}초`} className="shrink-0">
                    <img
                      src={reframeCompareFileUrl(clipId, compareId, name)}
                      alt={`${t.toFixed(1)}초`}
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

/** 후보 한 칸 — 프록시 1개를 레이아웃 기하(rect + cropWidthFraction + tracking)로 잘라 보인다. */
function CandidatePanel({ candidate, proxyUrl, clipStart, previewT, isFinal, safeZone, showTrack, videoRef, onTime, labeled, onLabel }: {
  candidate: ReframeCandidate;
  proxyUrl: string;
  clipStart: number;
  previewT: number;
  isFinal: boolean;
  safeZone: boolean;
  showTrack: boolean;
  videoRef: (el: HTMLVideoElement | null) => void;
  onTime?: (relSec: number) => void;
  /** 이 구간의 사람 정답이 이 레이아웃인가. */
  labeled?: boolean;
  /** 1클릭 라벨 — 저장 중엔 부모가 undefined 로 눌러 중복 클릭을 막는다. */
  onLabel?: () => void;
}) {
  const meta = LAYOUT_META[candidate.layout];
  const fraction = candidate.cropWidthFraction || 1;
  // 현재 시각의 추적 중심 — 마지막으로 지난 키프레임(정렬 보장됨).
  const cx = useMemo(() => {
    const points = candidate.tracking ?? [];
    if (!points.length) return 0.5;
    let last = points[0];
    for (const p of points) { if (p.t <= previewT + 0.001) last = p; else break; }
    return Math.min(1 - fraction / 2, Math.max(fraction / 2, last.cx));
  }, [candidate.tracking, previewT, fraction]);
  const cy = useMemo(() => {
    const points = candidate.tracking ?? [];
    if (!points.length) return 0.5;
    let last = points[0];
    for (const p of points) { if (p.t <= previewT + 0.001) last = p; else break; }
    return last.cy;
  }, [candidate.tracking, previewT]);

  const areaTopPct = (meta.y / 1920) * 100;
  const areaHeightPct = (meta.h / 1920) * 100;
  const isLetterbox = candidate.layout === "9:16-letterbox";
  // 크롭 창: 영상 폭 = 영역폭/fraction · 왼쪽 이동 = (cx - f/2)/f — 서버 렌더와 같은 산식.
  const mediaWidthPct = (1 / fraction) * 100;
  const mediaLeftPct = -((cx - fraction / 2) / fraction) * 100;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative w-full overflow-hidden rounded-[6px]"
        style={{
          aspectRatio: "9/16", background: "#000",
          border: isFinal ? `2px solid ${meta.color}` : "1px solid var(--sd-border)",
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
              // max-w-none 필수 — Tailwind preflight 의 `video{max-width:100%}` 가 확대 폭
              // (100/fraction% = 161~316%)을 100% 로 클램프해 크롭이 전부 어긋났다(2026-08-25
              // 실측: f=0.32 창은 통째로 검정). 잘라 보이는 건 부모 overflow-hidden 이 한다.
              className="absolute top-0 max-w-none"
              style={{ width: `${mediaWidthPct}%`, left: `${mediaLeftPct}%` }}
              onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
            />
          )}
          {showTrack && !isLetterbox && candidate.tracking && (
            <span
              className="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: "50%", top: `${cy * 100}%`, background: meta.color, boxShadow: "0 0 0 2px rgba(0,0,0,.5)" }}
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

      {/* 점수·자격·사유 */}
      <div className="text-[10.5px] leading-snug">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold" style={{ color: meta.color }}>{meta.label}</span>
          <span className="sd-mono" style={{ color: "var(--sd-fg)" }}>{candidate.score}점</span>
          <span style={{ color: candidate.eligible ? "var(--sd-ok)" : "var(--sd-danger-strong)" }}>
            {candidate.eligible ? "적격" : "탈락"}
          </span>
          {isFinal && <span className="sd-tag" style={{ borderColor: meta.color, color: meta.color }}>확정</span>}
        </div>
        <div style={{ color: "var(--sd-mut)" }}>
          {candidate.reasonCodes.map(reasonKo).join(" · ")}
        </div>
        {candidate.metrics && (
          <div className="sd-mono" style={{ color: "var(--sd-fg-dim)" }}>
            감지 {(candidate.metrics.detectionCoverage * 100).toFixed(0)}% ·
            우세 {(candidate.metrics.dominantFrameRate * 100).toFixed(0)}% ·
            크롭안전 {(candidate.metrics.cropSafetyRate * 100).toFixed(0)}% ·
            추적 {(candidate.metrics.trackingStability * 100).toFixed(0)}%
          </div>
        )}
        <button
          type="button"
          className="sd-btn mt-1 w-full text-[10.5px]"
          disabled={!onLabel}
          onClick={onLabel}
          style={labeled ? { borderColor: meta.color, color: meta.color, fontWeight: 600 } : undefined}
        >
          {labeled ? "✓ 사람 정답" : "이 구간 정답으로"}
        </button>
      </div>
    </div>
  );
}

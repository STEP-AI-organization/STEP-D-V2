"use client";

import { useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import { ASPECTS, defaultElementSize, filterCss, fontFamilyCss, outScale, outputHeight, outputWidth, overlayVisibleAt, sampleKeyframes, type CaptionStyle, type EditorState } from "@/lib/editor/presets";
import { getAspectPreset } from "@/lib/editor/aspect-presets";
import { Movable, SnapGuides, InlineText, type Guides } from "@/components/editor/editor-overlay";
import { frameUrl, frameOverlaySrc, overlayPngSrc, type FrameTemplate } from "@/lib/data/api";
import { useOverlayPng } from "@/components/editor/use-overlay-png";
import { sampleReframeFrame } from "@/lib/editor/reframe";
import type { ClipReframe } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * WYSIWYG preview canvas. Overlays are positioned by percentage over a fixed-aspect
 * stage, so what you see maps 1:1 to the eventual bake (plan §3 / §7.4). The video band
 * streams real footage (/api/media/:id/stream), driven by the timeline transport. Title,
 * elements, and the channel badge are directly editable here — drag to move, double-click
 * to edit text, center-snap guides. All edits are metadata (EditorState); the render is
 * deferred to final export (§2.4), so this stays a CSS approximation of the final bake.
 */
/**
 * Caption look per editorState.captionStyle — the CSS mirror of captionAssStyle() on the
 * server (index.ts), so the previewed caption matches the burned-in render:
 *   korean_pop — 예능 팝: heavy weight, thick dark stroke + shadow (default)
 *   clean      — 미니멀: medium weight, subtle shadow, no stroke
 *   news       — 뉴스 바: white on a semi-opaque lower-third box
 */
function captionStyleClasses(style: CaptionStyle): { cls: string; style: CSSProperties } {
  // fontSize in cqh = % of stage height, matching the render's capFs (H*0.042) with the same
  // per-style multipliers as captionAssStyle() on the server. 새 스타일은 서버 미러 미완 —
  // 프리뷰 전용(현행 렌더는 korean_pop/clean/news로 폴백). 서버 확장은 별건.
  switch (style) {
    case "news":
      return { cls: "rounded bg-black/70 px-2 py-0.5 font-bold", style: { color: "#fff", fontSize: "4.2cqh" } };
    case "clean":
      return { cls: "px-1 font-semibold", style: { color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.55)", fontSize: "3.9cqh" } };
    case "yellow_pop":
      return { cls: "px-1 font-extrabold", style: { color: "#FFD400", textShadow: "0 2px 6px rgba(0,0,0,.75)", WebkitTextStroke: "1.4px rgba(0,0,0,.9)", fontSize: "4.4cqh" } };
    case "cyan_neon":
      return { cls: "px-1 font-extrabold", style: { color: "#00E5FF", textShadow: "0 0 8px #00E5FF, 0 0 16px #00B8D4", fontSize: "4.3cqh" } };
    case "pink_bubble":
      return { cls: "rounded-full bg-pink-500/85 px-3 py-0.5 font-bold", style: { color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,.4)", fontSize: "3.9cqh" } };
    case "outline_bold":
      return { cls: "px-1 font-black", style: { color: "transparent", WebkitTextStroke: "2px #fff", fontSize: "4.6cqh" } };
    case "shadow_soft":
      return { cls: "px-1 font-medium", style: { color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.5)", fontSize: "3.9cqh" } };
    case "highlight_bar":
      return { cls: "px-1.5 font-bold", style: { color: "#111", background: "linear-gradient(180deg, transparent 55%, #FFE066 55%)", fontSize: "4.1cqh" } };
    case "typewriter":
      return { cls: "bg-black px-2 py-0.5 font-bold tracking-wide", style: { color: "#fff", fontFamily: "ui-monospace, monospace", fontSize: "3.8cqh" } };
    case "korean_pop":
    default:
      return {
        cls: "px-1 font-extrabold",
        style: { color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.7)", WebkitTextStroke: "1.4px rgba(0,0,0,.85)", fontSize: "4.4cqh" },
      };
  }
}

export function EditorPreview({
  state,
  update,
  videoUrl,
  videoRef,
  onDuration,
  onTogglePlay,
  caption,
  hasTranscript,
  currentTime,
  posterMediaId,
  posterApiBase,
  posterTime,
  frame,
  reframe,
  masterTime,
  clipId,
}: {
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
  videoUrl?: string;
  videoRef?: Ref<HTMLVideoElement>;
  onDuration?: (seconds: number, el?: HTMLVideoElement) => void;
  onTogglePlay?: () => void;
  /** Real STT caption under the playhead (from the master transcript). */
  caption?: string;
  /** Whether a transcript is loaded — false ⇒ show the sample placeholder instead. */
  hasTranscript?: boolean;
  /** Segment-relative playhead seconds — drives keyframe interpolation. */
  currentTime?: number;
  /** poster 프레임 소스 — 스트림 로드 전 첫 프레임을 미리 보여준다(로딩 시 검은 화면 방지). */
  posterMediaId?: string;
  posterApiBase?: string;
  posterTime?: number;
  /** 선택된 프레임 템플릿 기하(%). 없으면 프레임 없이 기존 동작. */
  frame?: FrameTemplate | null;
  /** Ready AI plan. Beat/tracking timestamps use source-master absolute seconds. */
  reframe?: ClipReframe;
  masterTime?: number;
  /** 클립 id. 주면 정적 오버레이(제목·채널명)를 **서버 렌더 PNG** 로 표시(구조적 WYSIWYG).
   *  없으면 종전대로 CSS 근사만(무회귀). */
  clipId?: string;
}) {
  const poster =
    posterMediaId && posterApiBase != null ? frameUrl(posterApiBase, posterMediaId, posterTime ?? 0) : undefined;
  const ratio = ASPECTS[state.aspect].ratio;
  // 종횡비 enum 프리셋(aspect-presets.ts) — **서버 렌더와 같은 숫자**를 읽어 WYSIWYG 파리티를 만든다.
  //  · fill:"rect"(9:16-crop-main/sub) → 비디오를 캔버스 내 사각형(%)에 앉히고 나머지는 검정 pad
  //  · fill:"cover"(꽉 채우기) → 전체 object-cover · fill:"contain"(레터박스) → object-contain + 여백
  const aspectPreset = getAspectPreset(state.aspect);
  // ── 단일 출력 해상도 좌표계 ────────────────────────────────────────────────
  // 스테이지는 **출력 해상도(canvasW×canvasH) 고정 div** 를 단일 scale(fit) transform 으로
  // 축소해 보여준다 → 편집 화면 = 결과물(AENA/CapCut 표준). 오버레이 크기(line.size 등)는
  // 이미 출력 px(normalizeEditorCoords 정규화)라 그대로 px 로 쓴다. 설계 상수(그림자 offset·
  // 패딩·gap)만 opx() 로 출력 px 로 올린다(서버 렌더 scale=H/stageH 와 동일한 outScale).
  const canvasW = outputWidth(state.aspect);
  const canvasH = outputHeight(state.aspect);
  const scale = outScale(state.aspect); // 설계 스테이지 px → 출력 px (서버 렌더 scale 미러)
  const opx = (px: number) => px * scale; // 설계 상수(px) → 출력 px
  const rectPct = aspectPreset?.fill === "rect" && aspectPreset.rect
    ? {
        left: (aspectPreset.rect.x / aspectPreset.canvasW) * 100,
        top: (aspectPreset.rect.y / aspectPreset.canvasH) * 100,
        width: (aspectPreset.rect.w / aspectPreset.canvasW) * 100,
        height: (aspectPreset.rect.h / aspectPreset.canvasH) * 100,
      }
    : null;
  // Keyframe times are relative to the clip start (trim-in).
  const localT = (currentTime ?? state.trimIn) - state.trimIn;
  // Overlay show-windows (startSec/endSec) are segment-relative, like trimIn/trimOut.
  const segT = currentTime ?? state.trimIn;
  const videoFilter = filterCss(state.tracks?.[0]?.filters);
  const reframeFrame = sampleReframeFrame(reframe, masterTime ?? currentTime ?? state.trimIn);
  const aiMode = reframe?.mode === "ai_multi";
  const aiReady = aiMode && reframe.status === "ready";
  const aiFill = aiReady && reframeFrame.layout === "fill";
  const aiFit = aiMode && !aiFill;
  // 밴드 크롭 모드 — 프레임 템플릿·AI 가 없을 때만 aspect enum 사각형을 적용한다(둘 다 자체 기하 소유).
  const rectMode = !aiMode && !frame && !!rectPct;

  // ── AENA 고정 컨테이너 모델 ────────────────────────────────────────────────
  // 비디오 <video> 는 항상 "크롭 래퍼" 를 꽉 채운다(absolute inset-0 size-full). 종횡비·크롭은
  // 오직 **래퍼 div 의 위치·크기**(그리고 object-fit)로만 준다 — <video> 엘리먼트 자체는 aspect 가
  // 바뀌어도 re-key 되지 않고 left/top/width/height 로 재배치되지도 않는다. 그래서 aspect 전환
  // 중에도 재생이 끊기지 않는다(예전엔 프레임별로 <video> 를 직접 재배치·리스타일해 프리즈에 기여).
  //  · rect(%) 와 fit 은 **서버 렌더와 같은 aspect-presets 숫자**라 편집기↔렌더 파리티가 유지된다.
  //  · videoRect=null → 스테이지 전체(inset-0), 남는 여백은 스테이지 배경(검정 pad)이 담당.
  const videoRect: { left: number; top: number; width: number; height: number } | null =
    aiFill ? null
    : (aiFit && frame) ? { left: frame.video.x, top: frame.video.y, width: frame.video.w, height: frame.video.h }
    : aiFit ? null
    : frame ? { left: frame.video.x, top: frame.video.y, width: frame.video.w, height: frame.video.h }
    : rectMode && rectPct ? rectPct
    : null;
  const videoObjectFit: "cover" | "contain" =
    aiFill ? "cover"
    : aiFit && frame ? "contain"
    : aiFit ? "contain"
    : frame ? (frame.video.fit === "contain" ? "contain" : "cover")
    : rectMode ? "cover"
    : aspectPreset?.fill === "cover" ? "cover"
    : aspectPreset?.fill === "contain" ? "contain"
    : state.fit === "cover" ? "cover" : "contain";
  const videoObjectPosition = aiFill ? `${reframeFrame.cx * 100}% ${reframeFrame.cy * 100}%` : undefined;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guides>({});

  // ── 출력 해상도 스테이지 → 화면 맞춤 배율(fit) ─────────────────────────────
  // viewport(보이는 상자)의 실제 폭을 재서 fit = viewportW / canvasW 로 스테이지를 축소한다
  // (AENA preview-frame.tsx 방식). 스테이지 내부는 전부 출력 px 라, fit 하나가 편집 화면을
  // 결과물의 축소본으로 만든다. 뷰포트·패널 폭이 바뀌면 ResizeObserver 가 fit 을 다시 잡는다.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(0.3);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const recompute = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setFit(r.width / canvasW);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasW]);

  // 정적 오버레이 WYSIWYG — 서버가 canvas 로 그린 실제 PNG(제목·채널명) hash. 편집/드래그
  // 중이 아니고(idle) 제목이 전부 정적(애니메이션·시간창 없음)일 때만 그 PNG 를 `<img>` 로
  // 보여주고 그 자리의 CSS 텍스트는 투명 처리한다(더블클릭·드래그 히트박스는 유지). 편집을
  // 시작하면 다시 CSS(편집 가능). PNG 가 없으면(hash null · clipId 없음) 순수 CSS — 무회귀.
  const overlayPng = useOverlayPng(clipId, state);
  const allTitlesStatic = (state.titleLines ?? []).every(
    (l) => !(l.keyframes && l.keyframes.length) && l.startSec == null && l.endSec == null,
  );
  // 서버 PNG를 선택·편집 순간에도 숨기지 않는다. CSS 텍스트로 스왑하면
  // 브라우저와 canvas의 폰트 엔진·커닝 차이가 그대로 위치 튀김이 된다.
  // AI 리프레임은 최종 경로가 아직 ASS라 canvas PNG를 쓰지 않는다(거짓 WYSIWYG 방지).
  // 편집 중인 제목 줄이 있으면 PNG 를 숨기고 CSS(불투명)로 **즉시** 보여준다 — 타이핑이
  // PNG 재렌더(90ms 디바운스 + 서버 렌더 + 네트워크 fetch)를 기다리지 않고 바로 반영된다
  // (사용자 2026-08-19: "타이핑 반응이 굼뜸"). 편집을 끝내면 다시 PNG(결과물 픽셀)로 — half-leading
  // translateY 보정이 있어 전환이 튀지 않는다. idle·비편집 줄·채널은 그대로 PNG(WYSIWYG 유지).
  const editingTitle = editing != null && editing.startsWith("title:");
  const showTitlePng =
    !!clipId && !!overlayPng.title.hash && overlayPng.title.aspect === String(state.aspect) &&
    !aiMode && allTitlesStatic && !editingTitle;
  const showChannelPng =
    !!clipId && !!overlayPng.channel.hash && overlayPng.channel.aspect === String(state.aspect) &&
    !aiMode && state.showChannel;
  // 디바운스 중에는 직전의 **정확한 픽셀**을 현재 앵커로 즉시 이동시킨다.
  // 제목·채널을 별도 전체프레임 PNG로 받았기 때문에 다른 레이어는 끌려가지 않는다.
  const titlePngDx = ((state.titleX - overlayPng.title.x) / 100) * canvasW;
  const titlePngDy = ((state.titleY - overlayPng.title.y) / 100) * canvasH;
  const channelPngDy = ((state.channelY - overlayPng.channel.y) / 100) * canvasH;

  // Keep the blurred cover background roughly in step with the foreground transport (it's
  // decorative + heavily blurred, so a loose sync is invisible).
  const syncBg = (fg: HTMLVideoElement) => {
    const bg = bgRef.current;
    if (!bg) return;
    if (Math.abs(bg.currentTime - fg.currentTime) > 0.25) {
      try {
        bg.currentTime = fg.currentTime;
      } catch {
        /* seeking before ready */
      }
    }
    if (fg.paused) bg.pause();
    else void bg.play().catch(() => {});
  };

  const setLine = (id: string, patch: Partial<EditorState["titleLines"][number]>) =>
    update({ titleLines: state.titleLines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  // Dragging an animated element would be a dead control (keyframes override x/y), so the
  // drag retargets the keyframe nearest to the playhead instead — WYSIWYG under animation.
  const moveEl = (id: string, x: number, y: number) =>
    update({
      elements: state.elements.map((e) => {
        if (e.id !== id) return e;
        const kfs = e.keyframes ?? [];
        if (kfs.some((k) => k.x != null || k.y != null)) {
          let ni = 0;
          let best = Infinity;
          kfs.forEach((k, i) => {
            const d = Math.abs(k.time - localT);
            if (d < best) {
              best = d;
              ni = i;
            }
          });
          return { ...e, keyframes: kfs.map((k, i) => (i === ni ? { ...k, x, y } : k)) };
        }
        return { ...e, x, y };
      }),
    });
  const setElText = (id: string, text: string) =>
    update({ elements: state.elements.map((e) => (e.id === id ? { ...e, text } : e)) });

  function deselect() {
    setSelected(null);
    setEditing(null);
  }

  // 선택된 오버레이 키보드 조작 (audit #5) — 방향키 이동(1% · Shift=10%)·Delete 요소 삭제·Esc 해제.
  // 인라인 편집 중이거나 입력 필드에 포커스가 있으면 무시(네이티브 동작 보존). 모든 변경은 shell 의
  // batched update 를 거치므로 방향키 연타 한 묶음이 undo 한 번에 되돌아간다.
  useEffect(() => {
    if (!selected || editing) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      const step = e.shiftKey ? 10 : 1;
      const clamp = (v: number) => Math.max(0, Math.min(100, v));
      const arrow =
        e.key === "ArrowLeft" ? ([-step, 0] as const)
        : e.key === "ArrowRight" ? ([step, 0] as const)
        : e.key === "ArrowUp" ? ([0, -step] as const)
        : e.key === "ArrowDown" ? ([0, step] as const)
        : null;
      if (arrow) {
        e.preventDefault();
        const [dx, dy] = arrow;
        if (selected === "title") {
          update({ titleX: clamp(state.titleX + dx), titleY: clamp(state.titleY + dy) });
        } else if (selected === "channel") {
          update({ channelY: clamp(state.channelY + dy) }); // 채널 뱃지는 lockX — 세로만 이동
        } else if (selected.startsWith("el:")) {
          const id = selected.slice(3);
          const el = state.elements.find((x) => x.id === id);
          if (el) {
            const kf = sampleKeyframes(el.keyframes, localT);
            moveEl(id, clamp((kf?.x ?? el.x) + dx), clamp((kf?.y ?? el.y) + dy));
          }
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.startsWith("el:")) {
        // 요소만 삭제한다 — 제목/채널은 구조적이라 속성 패널 토글로만 끈다(오삭제 방지).
        e.preventDefault();
        const id = selected.slice(3);
        update({ elements: state.elements.filter((x) => x.id !== id) });
        setSelected(null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        deselect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editing, state, localT]);

  return (
    // w-full 없으면 자식 viewport 의 width:min(90%, 900px)의 %가 참조할 정의된 폭이 없어
    // 폭이 0으로 붕괴 → 16:9·1:1에서 영상이 사라진다. 9:16·4:5는 height 기준이라 티가 안 났음.
    <div className="flex h-full w-full items-center justify-center">
      {/* viewport — 화면에 보이는 상자(종횡비 고정). 실제 폭을 재서 fit 을 잡는다.
          overflow-hidden 이 스테이지의 축소본을 잘라낸다.

          ⚠️ **꾸미지 않는다 — 기본 플레이어로 mp4 를 튼 화면과 같아야 한다**(사용자 확정
          2026-08-19). 예전엔 rounded-lg + shadow-2xl 이 붙어 있었다. 둥근 모서리는 네 귀퉁이에
          놓인 것(로고·자막 끝·프레임 테두리)을 편집 화면에서만 깎아 보여주고, 그림자는 프레임
          경계를 실제보다 도드라지게 만든다. 결과물엔 둘 다 없다 — 자리·크기와 같은 계열의
          파리티 문제라, 여기 장식을 더하지 말 것. */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden"
        style={{
          aspectRatio: `${canvasW}/${canvasH}`,
          height: ratio < 1 ? "min(72vh, 640px)" : undefined,
          width: ratio >= 1 ? "min(90%, 900px)" : undefined,
          maxHeight: "72vh",
        }}
      >
      {/* stage — **출력 해상도(canvasW×canvasH) 고정 캔버스**. 단일 scale(fit) 로 viewport 에
          맞춘다(transform-origin 0 0). 내부는 전부 출력 px/% → 편집 화면 = 결과물.
          container-type:size → 자막 cqh(=화면 높이 %)가 서버 ASS(H*%)와 1:1. */}
      <div
        ref={stageRef}
        onPointerDown={deselect}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: canvasW,
          height: canvasH,
          transform: `scale(${fit})`,
          // 밴드 크롭은 나머지 여백을 검정 pad 로 렌더한다(renderShort pad 기본색) — 미리보기도 검정.
          background: rectMode ? "#000000" : state.bg,
          containerType: "size",
        }}
      >
        {/* 배경 채우기 (letterbox 대체) — 3가지 템플릿:
              solid: state.bg 단색으로 그대로 (기본 · 최신 UX)
              blur:  원본 확대 블러 커버 (예전 자동 동작 · 이제 opt-in)
              image: 업로드 이미지 커버 (bgImageDataUrl)
            프리뷰의 %/px 오버레이 좌표는 ASS 번인과 1:1 (PlayRes = output size). */}
        {videoUrl ? (
          <>
            {/* 블러 여백 배경 — **레터박스(전체 담기)** 일 때만. 꽉 채우기·밴드 크롭은 여백이 없다. */}
            {!aiFill && state.bgType === "blur" && (aspectPreset ? aspectPreset.fill === "contain" : true) && (
              <video
                aria-hidden
                ref={bgRef}
                src={videoUrl}
                playsInline
                muted
                preload="auto"
                className="pointer-events-none absolute inset-0 size-full object-cover"
                style={{
                  filter: `blur(16px) brightness(0.65)${videoFilter ? ` ${videoFilter}` : ""}`,
                  transform: "scale(1.15)",
                }}
              />
            )}
            {!aiFill && state.bgType === "image" && state.bgImageDataUrl && (
              // 크롭이 있으면 원본 이미지를 스케일업+오프셋해 크롭 영역만 프레임에 채운다.
              // 크롭이 없으면 기존 object-fit:cover(중앙 크롭) 동작.
              state.bgImageCrop ? (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <img
                    aria-hidden
                    src={state.bgImageDataUrl}
                    alt=""
                    draggable={false}
                    className="block"
                    style={{
                      // position:absolute이므로 top/left %가 각각 컨테이너 height/width를
                      // 정확히 참조 → 9:16 세로 프레임에서도 y축이 안 어긋난다.
                      // 원래 marginTop %가 컨테이너 너비 기준이라 y가 어긋났던 버그 수정.
                      position: "absolute",
                      // wPct%가 프레임 100%가 되도록 스케일업. hPct도 동일 원리.
                      width: `${100 / (state.bgImageCrop.wPct / 100)}%`,
                      height: `${100 / (state.bgImageCrop.hPct / 100)}%`,
                      // image_width = container_w * 100/wPct → shift left by xPct% of image_width
                      //             = xPct/wPct * container_w → left = -xPct/wPct * 100 (% of container_w) ✓
                      left: `${-state.bgImageCrop.xPct / state.bgImageCrop.wPct * 100}%`,
                      // image_height = container_h * 100/hPct → shift up by yPct% of image_height
                      //              = yPct/hPct * container_h → top = -yPct/hPct * 100 (% of container_h) ✓
                      top: `${-state.bgImageCrop.yPct / state.bgImageCrop.hPct * 100}%`,
                      maxWidth: "none",  // 부모의 max-width 규칙이 스케일업을 막지 않도록
                    }}
                  />
                </div>
              ) : (
                <img
                  aria-hidden
                  src={state.bgImageDataUrl}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute inset-0 size-full object-cover"
                />
              )
            )}
            {/* 크롭 래퍼 — 고정 스테이지 안에서 aspect 별 위치·크기만 바뀐다. 비디오는 이 래퍼를
                항상 꽉 채우므로(아래) aspect 전환에도 <video> 는 그대로 재생된다.
                rect 는 서버 crop,scale,pad 와 같은 프리셋 숫자(% of stage) — 편집기↔렌더 파리티. */}
            <div
              className="absolute overflow-hidden"
              style={
                videoRect
                  ? {
                      left: `${videoRect.left}%`,
                      top: `${videoRect.top}%`,
                      width: `${videoRect.width}%`,
                      height: `${videoRect.height}%`,
                    }
                  : { inset: 0 }
              }
            >
              <video
                key={videoUrl}
                ref={videoRef}
                src={videoUrl}
                playsInline
                // 'metadata'는 프레임을 안 디코딩해서 사용자가 재생 누르기 전까지 검은 화면.
                // 'auto'로 편집 진입 즉시 프레임을 뽑아 poster 이후에도 실영상이 이어져 보인다.
                preload="auto"
                poster={poster}
                onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration, e.currentTarget)}
                onPlay={(e) => syncBg(e.currentTarget)}
                onPause={(e) => syncBg(e.currentTarget)}
                onSeeked={(e) => syncBg(e.currentTarget)}
                onTimeUpdate={(e) => syncBg(e.currentTarget)}
                onError={(e) => {
                  const el = e.currentTarget;
                  const err = el.error;
                  // 코드 매핑(MediaError): 1=ABORTED · 2=NETWORK · 3=DECODE · 4=SRC_NOT_SUPPORTED
                  // eslint-disable-next-line no-console
                  console.error("[editor-preview] video load failed", {
                    src: el.currentSrc || el.src,
                    code: err?.code,
                    message: err?.message,
                    networkState: el.networkState,
                    readyState: el.readyState,
                  });
                }}
                onClick={onTogglePlay}
                // 비디오는 aspect 와 무관하게 항상 래퍼를 꽉 채운다(재배치·re-key 없음).
                // 종횡비 차이는 object-fit(cover/contain)·objectPosition 으로만 — 순수 페인트 속성이라
                // 재생을 끊지 않는다.
                className="absolute inset-0 size-full cursor-pointer"
                style={{
                  objectFit: videoObjectFit,
                  ...(videoObjectPosition ? { objectPosition: videoObjectPosition } : {}),
                  filter: videoFilter,
                }}
              />
            </div>
            {/* 프레임 레이어 — 서버 meta.json 기하 그대로. 순서는 export 와 동일하게
                bands(non-over) → overlay 조각 → over bands. 순서가 어긋나면 미리보기에서
                로고가 지워지거나 캔바 글자가 되살아난다. */}
            {frame && !aiFill && (
              <div className="pointer-events-none absolute inset-0">
                {frame.bands.filter((b) => !b.over).map((b, i) => (
                  <div key={`b${i}`} className="absolute"
                    style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, background: b.color }} />
                ))}
                {frame.overlayRegions.map((r, i) => (
                  <div key={`r${i}`} className="absolute overflow-hidden"
                    style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}>
                    {/* 전체 프레임 이미지를 스테이지 크기로 깔고 이 사각형만 보이게 자른다 */}
                    <img src={frameOverlaySrc(frame)} alt="" draggable={false}
                      style={{
                        position: "absolute",
                        width: `${(100 / r.w) * 100}%`, height: `${(100 / r.h) * 100}%`,
                        left: `${(-r.x / r.w) * 100}%`, top: `${(-r.y / r.h) * 100}%`,
                        maxWidth: "none",
                      }} />
                  </div>
                ))}
                {frame.bands.filter((b) => b.over).map((b, i) => (
                  <div key={`o${i}`} className="absolute"
                    style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, background: b.color }} />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-zinc-700 to-zinc-900 text-[11px] text-zinc-400">
            영상
          </div>
        )}

        {/* 제목·채널 정적 PNG — 최종 내보내기와 **같은 renderTextLayerPng** 출력.
            편집 중에도 이 PNG를 유지하고, 투명 CSS 레이어는 히트박스로만 쓴다. */}
        {showTitlePng && overlayPng.title.hash && clipId && (
          <img
            src={overlayPngSrc(clipId, overlayPng.title.hash)}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full"
            style={{ transform: `translate(${titlePngDx}px, ${titlePngDy}px)` }}
          />
        )}
        {showChannelPng && overlayPng.channel.hash && clipId && (
          <img
            src={overlayPngSrc(clipId, overlayPng.channel.hash)}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full"
            style={{ transform: `translateY(${channelPngDy}px)` }}
          />
        )}

        {!aiFill && <SnapGuides guides={guides} />}

        {/* title lines — draggable block, double-click a line to edit. Lines outside their
            show-window (startSec/endSec) hide with the playhead; the block stays mounted
            while selected so it remains editable. */}
        {!aiFill && (state.titleLines.some((l) => overlayVisibleAt(l, segT)) ||
          selected === "title" ||
          (editing != null && editing.startsWith("title:"))) && (
        <Movable
          xPct={state.titleX}
          yPct={state.titleY}
          anchorTop
          selected={selected === "title"}
          onSelect={() => setSelected("title")}
          onMove={(x, y) => update({ titleX: x, titleY: y })}
          onGuides={setGuides}
          stageRef={stageRef}
          resizable
          resizeBase={state.titleLines.map((l) => l.size)}
          // 크기(line.size)는 출력 px 라, 화면 드래그 Δ를 fit 으로 나눠 출력 px Δ로 환산한다.
          resizePxScale={1 / fit}
          onResize={(sizes) => update({ titleLines: state.titleLines.map((l, i) => ({ ...l, size: sizes[i] })) })}
          style={{ width: "86%", padding: `0 ${opx(4)}px`, textAlign: state.titleAlign }}
        >
          {state.titleLines.map((line) => {
            const key = `title:${line.id}`;
            // Title-line keyframe x/y are offsets from the block layout (cqw/cqh = % of stage).
            const kf = sampleKeyframes(line.keyframes, localT);
            const lineShown = overlayVisibleAt(line, segT) || editing === key;
            const font: CSSProperties = {
              color: line.color,
              // 크기 = line.size(출력 px) 그대로. 스테이지가 출력 해상도라 fit 하나가 서버 canvas-PNG
              // 와 동일 픽셀로 축소한다 → 선택/편집(CSS)↔idle(PNG) 스왑이 안 튄다. (예전엔 cqh 로
              // canonical 640 기준을 흉내냈는데, 이제 스테이지 자체가 출력 해상도라 불필요.)
              fontSize: line.size,
              fontWeight: 800,
              lineHeight: 1.15,
              // half-leading 보정 — CSS 라인박스(line-height 1.15)는 첫 줄 글자 상단을
              // (lineHeight-1em)/2 = (1.15-1)/2 = 0.075em 만큼 anchor 위로 올린다. 반면 서버
              // canvas 는 textBaseline:"top" 으로 anchor(y=titleY%·H)에 글자 상단을 그대로
              // 맞춘다(overlay-canvas.ts · index.ts buildStaticOverlayItems). 그래서 편집 CSS 가
              // 렌더보다 0.075em 위에 뜬다 → 그만큼 아래로 내려 세로 정렬을 렌더와 맞춘다.
              // (줄 advance 는 서버 round(fitPx*1.15) 와 동일하게 line-height 가 유지한다 — 이
              //  translateY 는 flow 를 건드리지 않는 순수 시각 보정이라 줄 간격은 그대로.)
              transform: `translateY(${(1.15 - 1) / 2}em)`,
              // 그림자·외곽선도 출력 px — 서버 canvas 는 offset/blur 를 scale(=opx) 배해 굽고, stroke
              // 는 출력 px 그대로다. 스테이지 fit 축소가 CSS·PNG 를 똑같이 줄인다.
              textShadow: `0 ${opx(2)}px ${opx(6)}px rgba(0,0,0,.5)`,
              // 글꼴(font)·외곽선(stroke) — 편집 중(PNG 숨김) CSS 근사. 최종 진실은 서버 canvas-PNG
              // `<img>`(overlay-canvas.ts) 라 브라우저에 글꼴이 없어도 결과물은 정확하다.
              ...(fontFamilyCss(line.font) ? { fontFamily: fontFamilyCss(line.font) } : {}),
              ...(line.stroke && line.stroke.width > 0
                ? { WebkitTextStroke: `${line.stroke.width}px ${line.stroke.color}` }
                : {}),
              // 각 제목 줄은 한 시각 줄로 고정 — 재접지 않는다(D). 추천의 시맨틱 2줄 분할이
              // 폭 줄바꿈으로 3줄이 되던 버그 차단. 서버 렌더도 nowrap+shrink 라 줄 수 일치.
              whiteSpace: "nowrap",
              // display:none (not unmount) keeps resizeBase/onResize index mapping intact.
              display: lineShown ? undefined : "none",
              // 정적 오버레이 PNG 를 보여줄 땐 CSS 텍스트를 투명 처리(히트박스는 유지 → 더블클릭
              // 편집·드래그 그대로). 편집 중에도 표시 텍스트는 실제 PNG고, input은 커서만 보인다.
              ...(showTitlePng ? { opacity: 0 } : {}),
              ...(kf
                ? {
                    opacity: kf.opacity,
                    // kf.transform overrides the base, so re-apply the half-leading translateY
                    // (leftmost = constant downward nudge, unaffected by the kf scale/rotate).
                    transform: `translateY(${(1.15 - 1) / 2}em) translate(${kf.x ?? 0}cqw, ${kf.y ?? 0}cqh) scale(${kf.scale}) rotate(${kf.rotation}deg)`,
                  }
                : {}),
            };
            return editing === key ? (
              <InlineText
                key={line.id}
                value={line.text}
                onDraftChange={(v) => setLine(line.id, { text: v })}
                onCommit={(v) => {
                  setLine(line.id, { text: v });
                  setEditing(null);
                }}
                onCancel={(original) => {
                  setLine(line.id, { text: original });
                  setEditing(null);
                }}
                style={{
                  ...font,
                  width: "100%",
                  ...(showTitlePng
                    ? { opacity: 1, color: "transparent", caretColor: line.color, WebkitTextStroke: "0 transparent", textShadow: "none" }
                    : {}),
                }}
              />
            ) : (
              <div
                key={line.id}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(key);
                }}
                style={font}
              >
                {line.text || "제목을 입력하세요"}
              </div>
            );
          })}
        </Movable>
        )}

        {/* captions — the REAL STT line under the playhead (same transcript + timeline the
            render burns in, so preview = final). Falls back to a sample only when no
            transcript is loaded, so the caption zone never looks empty/broken. */}
        {/* Caption sits at 14% from the bottom, center — the exact anchor the render uses
            (ASS \an2, MarginV = H*0.14), so the previewed line lands where it bakes. */}
        {state.captionsOn && hasTranscript && caption && (
          // 자막 위치·크기·색은 editorState 오버라이드(captionY/Size/Color)가 있으면 그걸 따른다
          // (자동배포 규칙이 세팅) — 없으면 기존 기본(하단 14% · 스타일별 cqh · 스타일색). 서버
          // 렌더(index.ts buildEditorAss)와 **같은 규칙**이라 미리보기=결과물이 유지된다.
          <div className="absolute inset-x-0 px-6 text-center" style={{ bottom: `${state.captionY ?? 14}%` }}>
            {(() => {
              const cap = captionStyleClasses(state.captionStyle);
              // 한국 방송은 word-by-word 하이라이트를 쓰지 않음(2026-07-24 사용자 지적).
              // 오히려 하이라이트가 살짝 어긋나 보이는 원인이었음 · segment 통째 표시로 통일.
              const capStyle: CSSProperties = {
                ...cap.style,
                ...(typeof state.captionSize === "number" ? { fontSize: `${state.captionSize}cqh` } : {}),
                ...(state.captionColor ? { color: state.captionColor } : {}),
              };
              return (
                <span className={cap.cls} style={capStyle}>
                  {caption}
                </span>
              );
            })()}
          </div>
        )}
        {/* 자막 표시는 켰는데 이 회차에 STT 자체가 없을 때만 안내를 띄운다.
            예전엔 확정 클립에서 transcript를 안 담아 실제 대사 대신 이 더미가 떴다 —
            이제 transcript는 항상 로드되므로 이 분기는 STT가 진짜 없는 경우에만 걸린다. */}
        {state.captionsOn && !hasTranscript && (
          <div className="absolute inset-x-0 px-6 text-center" style={{ bottom: `${state.captionY ?? 14}%` }}>
            <span className="px-1 font-bold" style={{ color: "#fff", opacity: 0.65, textShadow: "0 2px 6px rgba(0,0,0,.6)", fontSize: "3.4cqh" }}>
              이 회차는 아직 자막(STT) 데이터가 없습니다
            </span>
          </div>
        )}

        {/* channel badge — draggable (vertical), double-click to rename */}
        {!aiFill && state.showChannel && (
          <Movable
            xPct={50}
            yPct={state.channelY}
            anchorTop
            lockX
            selected={selected === "channel"}
            onSelect={() => setSelected("channel")}
            onMove={(_, y) => update({ channelY: y })}
            onGuides={setGuides}
            stageRef={stageRef}
            onDoubleClick={() => setEditing("channel")}
            style={{ width: "100%", display: "flex", justifyContent: "center" }}
          >
            {editing === "channel" ? (
              <InlineText
                value={state.channelName}
                onDraftChange={(v) => update({ channelName: v })}
                onCommit={(v) => {
                  update({ channelName: v });
                  setEditing(null);
                }}
                onCancel={(original) => {
                  update({ channelName: original });
                  setEditing(null);
                }}
                style={{
                  width: 160,
                  textAlign: "center",
                  fontWeight: 600,
                  color: showChannelPng ? "transparent" : "#fff",
                  caretColor: "#fff",
                }}
              />
            ) : (
              (() => {
                // 아이콘과 텍스트를 서로 독립적으로 스케일. 프리셋은 시작점만 세팅하고,
                // 슬라이더로 각각 override 가능. 부가 줄들이 있으면 채널명 아래에 이어 렌더.
                // 크기는 출력 px — 기본값(미설정)·클램프 범위만 opx() 로 설계 px→출력 px 환산
                // (서버 channelBadgeLayout 와 동일 basis).
                const iconPx = Math.max(opx(8), Math.min(opx(200), state.channelIconSize ?? opx(40)));
                const labelPx = Math.max(opx(8), Math.min(opx(64), state.channelLabelSize ?? opx(14)));
                const extras = (state.channelExtraLines ?? [])
                  .map((l) => ({ id: l.id, text: (l.text ?? "").trim(), size: l.size }))
                  .filter((l) => l.text.length > 0);
                const layout = state.channelLayout ?? "horizontal";
                const shape = state.channelIconShape ?? "circle";
                const shapeCls =
                  shape === "circle" ? "rounded-full" : shape === "rounded" ? "rounded-md" : "";
                // 텍스트 블록: 이름 + 부가 줄들. 가로일 땐 좌측 정렬, 세로일 땐 가운데 정렬.
                const textBlock = (
                  <span
                    className={cn(
                      "flex flex-col leading-tight",
                      layout === "vertical" ? "items-center text-center" : "items-start",
                    )}
                    // 정적 오버레이 PNG 를 보여줄 땐 채널 CSS 텍스트를 투명 처리한다.
                    // 선택·드래그 중에도 실제 PNG를 유지하며 아이콘은 별도 DOM으로 남는다.
                    style={showChannelPng ? { opacity: 0 } : undefined}
                  >
                    <span
                      className="font-semibold text-white"
                      // 채널명 크기·그림자는 출력 px — labelPx 는 출력 px, 그림자 offset 만 opx().
                      // 서버 channelBadgeLayout(labelPx)·canvas shadow(1·3 ×scale)와 동일.
                      // transform: 제목과 같은 half-leading 보정. 텍스트 블록은 leading-tight
                      // (line-height 1.25)이고 서버는 baseline:"top"(LEADING 1.25) 이라 CSS 첫 줄이
                      // (1.25-1)/2 = 0.125em 위로 뜬다 → 그만큼 내려 렌더 세로 정렬과 맞춘다.
                      style={{ textShadow: `0 ${opx(1)}px ${opx(3)}px rgba(0,0,0,.6)`, fontSize: labelPx, transform: `translateY(${(1.25 - 1) / 2}em)` }}
                    >
                      {/* ▶ 접두사는 뺐다(사용자 2026-08-12 · 지저분함). 렌더도 뺐으니 여전히 일치. */}
                      {state.channelName}
                    </span>
                    {extras.map((line) => {
                      const size = Math.max(opx(6), Math.min(opx(48), line.size ?? labelPx * 0.75));
                      return (
                        <span
                          key={line.id}
                          className="font-medium text-white/80"
                          style={{
                            textShadow: `0 ${opx(1)}px ${opx(3)}px rgba(0,0,0,.6)`,
                            fontSize: size,
                            marginTop: Math.max(opx(1), size * 0.2),
                            // 채널명과 같은 half-leading 보정(leading-tight 1.25 → 0.125em).
                            transform: `translateY(${(1.25 - 1) / 2}em)`,
                          }}
                        >
                          {line.text}
                        </span>
                      );
                    })}
                  </span>
                );
                return (
                  // 아이콘·간격은 출력 px — 스테이지 fit 축소로 서버가 baked 한 PNG 텍스트 자리와
                  // 정렬이 유지된다. gap 은 서버 flow gap(세로 4·가로 8 설계 px → opx)과 동일.
                  <span
                    className={cn("flex", layout === "vertical" ? "flex-col items-center" : "items-center")}
                    style={{ gap: opx(layout === "vertical" ? 4 : 8) }}
                  >
                    {/* 아이콘 끄기(channelIconOff)는 서버 렌더가 읽는 스위치다(index.ts
                        buildEditorAss 앞단) — 미리보기도 같이 꺼야 편집 화면과 결과물이 맞는다.
                        예전엔 미리보기가 이 값을 아예 안 봐서, 꺼도 화면엔 아이콘이 남았다. */}
                    {state.channelIconOff === true ? null : state.channelIconDataUrl ? (
                      <img
                        src={state.channelIconDataUrl}
                        alt=""
                        draggable={false}
                        className={cn("object-cover", shapeCls)}
                        style={shape === "circle"
                          ? { width: iconPx, height: iconPx }
                          : { width: "auto", height: iconPx }}
                      />
                    ) : null}
                    {textBlock}
                  </span>
                );
              })()
            )}
          </Movable>
        )}

        {/* elements — draggable, double-click to edit text. Hidden outside their
            show-window unless selected/editing (so they stay grabbable mid-edit). */}
        {!aiFill && state.elements.map((el) => {
          const key = `el:${el.id}`;
          const kf = sampleKeyframes(el.keyframes, localT);
          if (!overlayVisibleAt(el, segT) && selected !== key && editing !== key) return null;
          return (
            <Movable
              key={el.id}
              xPct={kf?.x ?? el.x}
              yPct={kf?.y ?? el.y}
              selected={selected === key}
              onSelect={() => setSelected(key)}
              onMove={(x, y) => moveEl(el.id, x, y)}
              onGuides={setGuides}
              stageRef={stageRef}
              resizable
              resizeBase={[el.size ?? defaultElementSize(el.type)]}
              resizePxScale={1 / fit}
              onResize={([s]) => update({ elements: state.elements.map((e) => (e.id === el.id ? { ...e, size: s } : e)) })}
              onDoubleClick={() => setEditing(key)}
              className="rounded-md px-2 py-1 text-sm font-bold"
              style={{
                background: el.type === "cta" ? state.accent : el.type === "sticker" ? "#FFD400" : "#ffffff",
                color: el.type === "arrow" ? state.accent : "#16120D",
                fontSize: el.size ?? defaultElementSize(el.type),
                // Overrides Movable's base transform, so the center anchor must be repeated.
                ...(kf
                  ? {
                      opacity: kf.opacity,
                      transform: `translate(-50%, -50%) scale(${kf.scale}) rotate(${kf.rotation}deg)`,
                    }
                  : {}),
              }}
            >
              {editing === key ? (
                <InlineText
                  value={el.text}
                  onCommit={(v) => {
                    setElText(el.id, v);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                  style={{ width: 110 }}
                />
              ) : (
                el.text
              )}
            </Movable>
          );
        })}

        {/* safe-area + mock Shorts UI */}
        {!aiFill && state.showSafeArea && (
          <>
            <div className="pointer-events-none absolute inset-[6%] rounded border border-dashed border-white/40" />
            <div className="absolute bottom-[12%] right-3 flex flex-col items-center gap-3 text-white/80">
              <Heart className="size-5" />
              <MessageCircle className="size-5" />
              <Send className="size-5" />
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

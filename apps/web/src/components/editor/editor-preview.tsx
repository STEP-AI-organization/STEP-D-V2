"use client";

import { useRef, useState, type CSSProperties, type Ref } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import { ASPECTS, defaultElementSize, filterCss, overlayVisibleAt, sampleKeyframes, type CaptionStyle, type EditorState } from "@/lib/editor/presets";
import { Movable, SnapGuides, InlineText, type Guides } from "@/components/editor/editor-overlay";
import { frameUrl, frameOverlaySrc, type FrameTemplate } from "@/lib/data/api";
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
}) {
  const poster =
    posterMediaId && posterApiBase != null ? frameUrl(posterApiBase, posterMediaId, posterTime ?? 0) : undefined;
  const ratio = ASPECTS[state.aspect].ratio;
  // Keyframe times are relative to the clip start (trim-in).
  const localT = (currentTime ?? state.trimIn) - state.trimIn;
  // Overlay show-windows (startSec/endSec) are segment-relative, like trimIn/trimOut.
  const segT = currentTime ?? state.trimIn;
  const videoFilter = filterCss(state.tracks?.[0]?.filters);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guides>({});

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

  return (
    // w-full 없으면 자식 stage의 width:min(90%, 900px)의 %가 참조할 정의된 폭이 없어
    // container-type:size 컨테인먼트와 겹쳐 폭이 0으로 붕괴 → 16:9·1:1에서 영상이 사라진다.
    // 9:16·4:5는 height 기준이라 티가 안 났음.
    <div className="flex h-full w-full items-center justify-center">
      <div
        ref={stageRef}
        onPointerDown={deselect}
        className="relative overflow-hidden rounded-lg shadow-2xl"
        style={{
          aspectRatio: ratio,
          height: ratio < 1 ? "min(72vh, 640px)" : undefined,
          width: ratio >= 1 ? "min(90%, 900px)" : undefined,
          maxHeight: "72vh",
          background: state.bg,
          // Size container → caption font can use cqh (% of stage height) to match the
          // render's ASS font (H*0.042), staying exact at any preview size.
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
            {state.bgType === "blur" && (
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
            {state.bgType === "image" && state.bgImageDataUrl && (
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
              className={cn(
                "absolute cursor-pointer",
                // 프레임 템플릿의 fit 을 그대로 따른다 — renderShort 의 프레임 경로가
                // meta.json 의 video.fit 으로 cover(crop) / contain(pad) 을 고르므로,
                // 여기서 한쪽으로 하드코딩하면 미리보기와 결과물이 어긋난다.
                // (broadcast-clean = contain: 방송 원본의 번인 자막을 자르지 않는다.)
                // 프레임이 없으면 blur/solid 경로와 같은 기존 contain 동작.
                frame
                  ? (frame.video.fit === "contain" ? "object-contain" : "object-cover")
                  : "inset-0 size-full object-contain",
              )}
              style={
                frame
                  ? {
                      filter: videoFilter,
                      left: `${frame.video.x}%`, top: `${frame.video.y}%`,
                      width: `${frame.video.w}%`, height: `${frame.video.h}%`,
                    }
                  : { filter: videoFilter }
              }
            />
            {/* 프레임 레이어 — 서버 meta.json 기하 그대로. 순서는 export 와 동일하게
                bands(non-over) → overlay 조각 → over bands. 순서가 어긋나면 미리보기에서
                로고가 지워지거나 캔바 글자가 되살아난다. */}
            {frame && (
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

        <SnapGuides guides={guides} />

        {/* title lines — draggable block, double-click a line to edit. Lines outside their
            show-window (startSec/endSec) hide with the playhead; the block stays mounted
            while selected so it remains editable. */}
        {(state.titleLines.some((l) => overlayVisibleAt(l, segT)) ||
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
          onResize={(sizes) => update({ titleLines: state.titleLines.map((l, i) => ({ ...l, size: sizes[i] })) })}
          style={{ width: "86%", padding: "0 4px", textAlign: state.titleAlign }}
        >
          {state.titleLines.map((line) => {
            const key = `title:${line.id}`;
            // Title-line keyframe x/y are offsets from the block layout (cqw/cqh = % of stage).
            const kf = sampleKeyframes(line.keyframes, localT);
            const lineShown = overlayVisibleAt(line, segT) || editing === key;
            const font: CSSProperties = {
              color: line.color,
              fontSize: line.size,
              fontWeight: 800,
              lineHeight: 1.15,
              textShadow: "0 2px 6px rgba(0,0,0,.5)",
              // display:none (not unmount) keeps resizeBase/onResize index mapping intact.
              display: lineShown ? undefined : "none",
              ...(kf
                ? {
                    opacity: kf.opacity,
                    transform: `translate(${kf.x ?? 0}cqw, ${kf.y ?? 0}cqh) scale(${kf.scale}) rotate(${kf.rotation}deg)`,
                  }
                : {}),
            };
            return editing === key ? (
              <InlineText
                key={line.id}
                value={line.text}
                onCommit={(v) => {
                  setLine(line.id, { text: v });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                style={{ ...font, width: "100%" }}
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
          <div className="absolute inset-x-0 px-6 text-center" style={{ bottom: "14%" }}>
            {(() => {
              const cap = captionStyleClasses(state.captionStyle);
              // 한국 방송은 word-by-word 하이라이트를 쓰지 않음(2026-07-24 사용자 지적).
              // 오히려 하이라이트가 살짝 어긋나 보이는 원인이었음 · segment 통째 표시로 통일.
              return (
                <span className={cap.cls} style={cap.style}>
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
          <div className="absolute inset-x-0 px-6 text-center" style={{ bottom: "14%" }}>
            <span className="px-1 font-bold" style={{ color: "#fff", opacity: 0.65, textShadow: "0 2px 6px rgba(0,0,0,.6)", fontSize: "3.4cqh" }}>
              이 회차는 아직 자막(STT) 데이터가 없습니다
            </span>
          </div>
        )}

        {/* channel badge — draggable (vertical), double-click to rename */}
        {state.showChannel && (
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
                onCommit={(v) => {
                  update({ channelName: v });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                style={{ width: 160, textAlign: "center", fontWeight: 600, color: "#fff" }}
              />
            ) : (
              (() => {
                // 아이콘과 텍스트를 서로 독립적으로 스케일. 프리셋은 시작점만 세팅하고,
                // 슬라이더로 각각 override 가능. 부가 줄들이 있으면 채널명 아래에 이어 렌더.
                const iconPx = Math.max(8, Math.min(200, state.channelIconSize ?? 24));
                const labelPx = Math.max(8, Math.min(64, state.channelLabelSize ?? 14));
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
                  >
                    <span
                      className="font-semibold text-white"
                      style={{ textShadow: "0 1px 3px rgba(0,0,0,.6)", fontSize: labelPx }}
                    >
                      {/* 렌더가 채널명 앞에 "▶ " 를 굽는다(index.ts) — 미리보기도 붙여야 WYSIWYG.
                          예전엔 미리보기에만 없어서 결과물에 안 보이던 삼각형이 나타났다. */}
                      ▶ {state.channelName}
                    </span>
                    {extras.map((line) => {
                      const size = Math.max(6, Math.min(48, line.size ?? Math.round(labelPx * 0.75)));
                      return (
                        <span
                          key={line.id}
                          className="font-medium text-white/80"
                          style={{
                            textShadow: "0 1px 3px rgba(0,0,0,.6)",
                            fontSize: size,
                            marginTop: Math.max(1, Math.round(size * 0.2)),
                          }}
                        >
                          {line.text}
                        </span>
                      );
                    })}
                  </span>
                );
                return (
                  <span className={cn("flex", layout === "vertical" ? "flex-col items-center gap-1" : "items-center gap-2")}>
                    {state.channelIconDataUrl ? (
                      <img
                        src={state.channelIconDataUrl}
                        alt=""
                        draggable={false}
                        className={cn("object-cover", shapeCls)}
                        style={{ width: iconPx, height: iconPx }}
                      />
                    ) : (
                      <span
                        className={cn("flex items-center justify-center bg-white/90 font-bold text-black", shapeCls)}
                        style={{ width: iconPx, height: iconPx, fontSize: Math.round(iconPx * 0.42) }}
                      >
                        CH
                      </span>
                    )}
                    {textBlock}
                  </span>
                );
              })()
            )}
          </Movable>
        )}

        {/* elements — draggable, double-click to edit text. Hidden outside their
            show-window unless selected/editing (so they stay grabbable mid-edit). */}
        {state.elements.map((el) => {
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
        {state.showSafeArea && (
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
  );
}

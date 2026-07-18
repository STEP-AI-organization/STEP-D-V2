"use client";

import { useRef, useState, type CSSProperties, type Ref } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import { ASPECTS, defaultElementSize, filterCss, overlayVisibleAt, sampleKeyframes, type CaptionStyle, type EditorState } from "@/lib/editor/presets";
import { Movable, SnapGuides, InlineText, type Guides } from "@/components/editor/editor-overlay";

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
  // per-style multipliers as captionAssStyle(): korean_pop ×1.05, clean ×0.92, news ×1.0.
  switch (style) {
    case "news":
      return { cls: "rounded bg-black/70 px-2 py-0.5 font-bold", style: { color: "#fff", fontSize: "4.2cqh" } };
    case "clean":
      return { cls: "px-1 font-semibold", style: { color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.55)", fontSize: "3.9cqh" } };
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
  captionWords,
  captionActiveIdx = -1,
  captionKeyIdx,
  hasTranscript,
  currentTime,
}: {
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
  videoUrl?: string;
  videoRef?: Ref<HTMLVideoElement>;
  onDuration?: (seconds: number) => void;
  onTogglePlay?: () => void;
  /** Real STT caption under the playhead (from the master transcript). */
  caption?: string;
  /** Per-word split of the active caption for word-by-word highlight (mirrors the render). */
  captionWords?: { word: string; start: number; end: number }[];
  /** Index of the currently-spoken word in captionWords (-1 = none). */
  captionActiveIdx?: number;
  /** Keyword (content-word) indices to emphasize with the keyword colour. */
  captionKeyIdx?: Set<number>;
  /** Whether a transcript is loaded — false ⇒ show the sample placeholder instead. */
  hasTranscript?: boolean;
  /** Segment-relative playhead seconds — drives keyframe interpolation. */
  currentTime?: number;
}) {
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
    <div className="flex h-full items-center justify-center">
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
        {/* True 9:16 reframe (mirrors renderShort): a blurred cover copy fills the frame and
            the real footage sits fit-to-frame on top. Letterbox bands show the blur, and
            overlay %/px coordinates map 1:1 to the ASS burn (PlayRes = output size). */}
        {videoUrl ? (
          <>
            <video
              aria-hidden
              ref={bgRef}
              src={videoUrl}
              playsInline
              muted
              className="pointer-events-none absolute inset-0 size-full object-cover"
              style={{
                filter: `blur(16px) brightness(0.65)${videoFilter ? ` ${videoFilter}` : ""}`,
                transform: "scale(1.15)",
              }}
            />
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              playsInline
              onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration)}
              onPlay={(e) => syncBg(e.currentTarget)}
              onPause={(e) => syncBg(e.currentTarget)}
              onSeeked={(e) => syncBg(e.currentTarget)}
              onTimeUpdate={(e) => syncBg(e.currentTarget)}
              onClick={onTogglePlay}
              className="absolute inset-0 size-full cursor-pointer object-contain"
              style={{ filter: videoFilter }}
            />
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
              const words = captionWords ?? [];
              const keyColor = state.keywordColor ?? state.highlightColor;
              return (
                <span className={cap.cls} style={cap.style}>
                  {words.length
                    ? words.map((w, i) => (
                        <span
                          key={i}
                          style={{
                            color:
                              i === captionActiveIdx
                                ? captionKeyIdx?.has(i)
                                  ? keyColor
                                  : state.highlightColor
                                : undefined,
                          }}
                        >
                          {w.word}
                          {i < words.length - 1 ? " " : ""}
                        </span>
                      ))
                    : caption}
                </span>
              );
            })()}
          </div>
        )}
        {state.captionsOn && !hasTranscript && (
          <div className="absolute inset-x-0 px-6 text-center" style={{ bottom: "14%" }}>
            <span className="px-1 font-bold" style={{ color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.6)", fontSize: "4.2cqh" }}>
              지금 이 장면이 <span style={{ color: state.highlightColor }}>가장 먼저</span> 잡혀야 해요
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
              <span className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-white/90 text-[10px] font-bold text-black">
                  CH
                </span>
                <span className="text-sm font-semibold text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,.6)" }}>
                  {state.channelName}
                </span>
              </span>
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

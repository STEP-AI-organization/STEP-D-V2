"use client";

import { useRef, useState, type Ref } from "react";
import { Heart, MessageCircle, Send } from "lucide-react";
import { ASPECTS, defaultElementSize, type EditorState } from "@/lib/editor/presets";
import { Movable, SnapGuides, InlineText, type Guides } from "@/components/editor/editor-overlay";

/**
 * WYSIWYG preview canvas. Overlays are positioned by percentage over a fixed-aspect
 * stage, so what you see maps 1:1 to the eventual bake (plan §3 / §7.4). The video band
 * streams real footage (/api/media/:id/stream), driven by the timeline transport. Title,
 * elements, and the channel badge are directly editable here — drag to move, double-click
 * to edit text, center-snap guides. All edits are metadata (EditorState); the render is
 * deferred to final export (§2.4), so this stays a CSS approximation of the final bake.
 */
export function EditorPreview({
  state,
  update,
  videoUrl,
  videoRef,
  onDuration,
  onTogglePlay,
  caption,
  hasTranscript,
}: {
  state: EditorState;
  update: (patch: Partial<EditorState>) => void;
  videoUrl?: string;
  videoRef?: Ref<HTMLVideoElement>;
  onDuration?: (seconds: number) => void;
  onTogglePlay?: () => void;
  /** Real STT caption under the playhead (from the master transcript). */
  caption?: string;
  /** Whether a transcript is loaded — false ⇒ show the sample placeholder instead. */
  hasTranscript?: boolean;
}) {
  const ratio = ASPECTS[state.aspect].ratio;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guides>({});

  const setLine = (id: string, patch: Partial<EditorState["titleLines"][number]>) =>
    update({ titleLines: state.titleLines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const moveEl = (id: string, x: number, y: number) =>
    update({ elements: state.elements.map((e) => (e.id === id ? { ...e, x, y } : e)) });
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
        }}
      >
        {/* video band — real footage when available, else a reframe stand-in */}
        <div
          className="absolute inset-x-0 flex items-center justify-center overflow-hidden bg-black"
          style={{
            top: "34%",
            height: state.aspect === "9:16" ? "34%" : state.aspect === "16:9" ? "100%" : "48%",
          }}
        >
          {videoUrl ? (
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              playsInline
              onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration)}
              onClick={onTogglePlay}
              className="size-full cursor-pointer object-contain"
            />
          ) : (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-700 to-zinc-900 text-[11px] text-zinc-400">
              영상
            </div>
          )}
        </div>

        <SnapGuides guides={guides} />

        {/* title lines — draggable block, double-click a line to edit */}
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
            const font = {
              color: line.color,
              fontSize: line.size,
              fontWeight: 800,
              lineHeight: 1.15,
              textShadow: "0 2px 6px rgba(0,0,0,.5)",
            } as const;
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

        {/* captions — the REAL STT line under the playhead (same transcript + timeline the
            render burns in, so preview = final). Falls back to a sample only when no
            transcript is loaded, so the caption zone never looks empty/broken. */}
        {state.captionsOn && hasTranscript && caption && (
          <div className="absolute inset-x-0 px-6 text-center" style={{ top: "72%" }}>
            <span className="rounded px-1 text-lg font-bold" style={{ color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.6)" }}>
              {caption}
            </span>
          </div>
        )}
        {state.captionsOn && !hasTranscript && (
          <div className="absolute inset-x-0 px-6 text-center" style={{ top: "72%" }}>
            <span className="rounded px-1 text-lg font-bold" style={{ color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.6)" }}>
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

        {/* elements — draggable, double-click to edit text */}
        {state.elements.map((el) => {
          const key = `el:${el.id}`;
          return (
            <Movable
              key={el.id}
              xPct={el.x}
              yPct={el.y}
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

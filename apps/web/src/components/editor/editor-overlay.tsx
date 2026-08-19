"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

/**
 * Direct-manipulation overlay primitives for the preview canvas (plan §7.3:
 * text-edit-overlay / transform-handles / snap-guides). Positions are percentages of
 * the stage so they survive aspect changes; edits mutate EditorState (metadata only —
 * the bake is deferred to final export, §2.4). Implemented natively for our stack.
 */

const SNAP_PCT = 2.5;

export type Guides = { v?: number; h?: number };

/** Draggable overlay anchored at (x%, y%) over `stageRef`. Click selects, drag moves,
 *  center-snaps with guide feedback. `anchorTop` anchors the top edge (titles), else the
 *  center; `lockX` keeps a fixed x (full-width rows like the channel badge). */
export function Movable({
  xPct,
  yPct,
  onMove,
  onSelect,
  onGuides,
  selected,
  anchorTop,
  lockX,
  stageRef,
  resizable,
  resizeBase,
  resizePxScale = 1,
  onResize,
  onDoubleClick,
  className,
  style,
  children,
}: {
  xPct: number;
  yPct: number;
  onMove: (x: number, y: number) => void;
  onSelect: () => void;
  onGuides: (g: Guides) => void;
  selected: boolean;
  anchorTop?: boolean;
  lockX?: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  resizable?: boolean;
  resizeBase?: number[];
  /** 화면 px → 크기 단위 배율. 스테이지가 출력 해상도로 scale(fit) 될 때 1/fit 을 주면,
   *  화면 드래그 Δ가 출력 px Δ로 환산돼 커서를 따라간다. 미지정=1(구 동작). */
  resizePxScale?: number;
  onResize?: (sizes: number[]) => void;
  onDoubleClick?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // Capture only once movement passes a threshold, so a plain click / double-click is
  // never swallowed by pointer capture (that would block inline-edit / selection).
  const drag = useRef<{ sx: number; sy: number; active: boolean } | null>(null);

  function down(e: React.PointerEvent) {
    e.stopPropagation();
    onSelect();
    drag.current = { sx: e.clientX, sy: e.clientY, active: false };
  }
  function move(e: React.PointerEvent) {
    if (!drag.current || !stageRef.current) return;
    if (!drag.current.active) {
      if (Math.hypot(e.clientX - drag.current.sx, e.clientY - drag.current.sy) < 4) return;
      drag.current.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    const r = stageRef.current.getBoundingClientRect();
    let nx = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    let ny = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
    const g: Guides = {};
    if (!lockX && Math.abs(nx - 50) < SNAP_PCT) {
      nx = 50;
      g.v = 50;
    }
    if (Math.abs(ny - 50) < SNAP_PCT) {
      ny = 50;
      g.h = 50;
    }
    onGuides(g);
    onMove(lockX ? xPct : nx, ny);
  }
  function up(e: React.PointerEvent) {
    if (drag.current?.active) {
      onGuides({});
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // pointer already released
      }
    }
    drag.current = null;
  }

  // Resize (corner handle): snapshot the base sizes on grab so dragging is drift-free.
  const resize = useRef<{ x: number; y: number; base: number[] } | null>(null);
  function rDown(e: React.PointerEvent) {
    e.stopPropagation();
    resize.current = { x: e.clientX, y: e.clientY, base: (resizeBase ?? []).slice() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function rMove(e: React.PointerEvent) {
    if (!resize.current || !onResize) return;
    // 화면 px Δ → 크기 Δ. resizePxScale(=1/fit)로 출력 px 로 환산. 크기는 출력 px 라 범위도 넓다.
    const d = ((e.clientX - resize.current.x + (e.clientY - resize.current.y)) / 2) * 0.4 * resizePxScale;
    onResize(resize.current.base.map((b) => Math.max(8, Math.min(600, Math.round(b + d)))));
  }
  function rUp(e: React.PointerEvent) {
    resize.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
  }

  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onDoubleClick={onDoubleClick}
      className={className}
      style={{
        position: "absolute",
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: anchorTop ? "translate(-50%, 0)" : "translate(-50%, -50%)",
        cursor: "move",
        touchAction: "none",
        outline: selected ? "1.5px dashed rgba(255,255,255,0.9)" : undefined,
        outlineOffset: 3,
        ...style,
      }}
    >
      {children}
      {selected && resizable && onResize && (
        <div
          onPointerDown={rDown}
          onPointerMove={rMove}
          onPointerUp={rUp}
          className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-zinc-900 bg-white"
          style={{ touchAction: "none" }}
          aria-label="크기 조절"
        />
      )}
    </div>
  );
}

/** Center alignment guides shown while dragging. */
export function SnapGuides({ guides }: { guides: Guides }) {
  return (
    <>
      {guides.v != null && (
        <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-pink-400/80" style={{ left: `${guides.v}%` }} />
      )}
      {guides.h != null && (
        <div className="pointer-events-none absolute inset-x-0 z-20 h-px bg-pink-400/80" style={{ top: `${guides.h}%` }} />
      )}
    </>
  );
}

/** In-place text editor: autofocuses, commits on blur / Enter, cancels on Escape. */
export function InlineText({
  value,
  onCommit,
  onCancel,
  className,
  style,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(text);
        else if (e.key === "Escape") onCancel();
      }}
      className={className}
      style={{
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.6)",
        borderRadius: 4,
        outline: "none",
        textAlign: "inherit",
        color: "inherit",
        font: "inherit",
        ...style,
      }}
    />
  );
}

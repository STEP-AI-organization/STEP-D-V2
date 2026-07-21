"use client";

import { useState } from "react";
import { cn, formatTimecode } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export type TimelineBlock = {
  id: string;
  start: number;
  end: number;
  title: string;
  sub?: string;
};

export type TimelineLane = {
  key: string;
  label: string;
  /** Lane accent (hex) — drives dot, block fill, and inspector chrome. */
  color: string;
  blocks: TimelineBlock[];
  /** Placeholder blocks with no real data source yet — rendered dashed + tagged. */
  sample?: boolean;
};

/**
 * Review OS multi-lane highlight timeline — VISUAL layer only.
 *
 * Blocks are selectable and seek the player, but no processing action (채택·컷·
 * 리포트) is wired: this scaffolds the prototype's timeline look ahead of the
 * segment pipeline that will feed it. Lanes fed real analysis data render solid;
 * lanes without a data source (e.g. PPL) render dashed and tagged "샘플" so a
 * placeholder never reads as a real detection.
 */
export function ReviewTimeline({
  durationSec,
  currentTime,
  onSeek,
  lanes,
}: {
  durationSec: number;
  currentTime: number;
  onSeek?: (t: number) => void;
  lanes: TimelineLane[];
}) {
  const [sel, setSel] = useState<{ lane: TimelineLane; block: TimelineBlock } | null>(null);
  if (!durationSec) return null;

  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / durationSec) * 100))}%`;
  const ticks = Array.from({ length: 6 }, (_, i) => (durationSec * i) / 5);

  return (
    <Card className="px-4 pb-4 pt-3.5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">AI 타임라인 · 하이라이트</span>
        <span className="rounded-md border border-border bg-elevated px-2 py-0.5 text-[10.5px] text-muted-foreground">
          미리보기 · 블록 선택만 (처리 액션 미연결)
        </span>
      </div>

      {/* ruler */}
      <div className="grid grid-cols-[76px_1fr] gap-2.5">
        <div />
        <div className="mono relative mb-2 h-3.5 text-[10px] text-muted-foreground/70">
          {ticks.map((t, i) => (
            <span key={i} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
              {formatTimecode(t)}
            </span>
          ))}
        </div>
      </div>

      {/* lanes */}
      <div className="flex flex-col gap-1.5">
        {lanes.map((lane) => (
          <div key={lane.key} className="grid grid-cols-[76px_1fr] items-center gap-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: lane.color }} />
              <span className="truncate text-[11px] font-semibold text-muted-foreground">
                {lane.label}
              </span>
              {lane.sample && <span className="text-[9px] text-muted-foreground/60">샘플</span>}
            </div>
            <div className="relative h-[26px] rounded-md border border-border bg-elevated">
              <div
                className="absolute -bottom-0.5 -top-0.5 z-[3] w-0.5 bg-foreground"
                style={{ left: pct(currentTime) }}
                aria-hidden
              />
              {lane.blocks.map((b) => {
                const active = sel?.block.id === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    title={b.title}
                    onClick={() => {
                      setSel({ lane, block: b });
                      onSeek?.(b.start);
                    }}
                    className={cn(
                      "absolute bottom-0.5 top-0.5 rounded-[3px] border transition-[background-color,filter] hover:brightness-125",
                      lane.sample && "border-dashed opacity-70",
                    )}
                    style={{
                      left: pct(b.start),
                      width: `max(6px, ${((b.end - b.start) / durationSec) * 100}%)`,
                      background: active ? lane.color : `${lane.color}55`,
                      borderColor: lane.color,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* inspector — visual only */}
      {sel && (
        <div className="mt-3 rounded-xl border border-border bg-elevated p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className="rounded-md px-2 py-0.5 text-[10.5px] font-bold"
              style={{
                color: sel.lane.color,
                background: `${sel.lane.color}22`,
                border: `1px solid ${sel.lane.color}55`,
              }}
            >
              {sel.lane.label}
            </span>
            <span className="mono text-[11px] text-muted-foreground">
              {formatTimecode(sel.block.start)}–{formatTimecode(sel.block.end)}
            </span>
            {sel.lane.sample && (
              <span className="text-[10px] text-muted-foreground/70">샘플 미리보기</span>
            )}
            <button
              type="button"
              onClick={() => setSel(null)}
              className="ml-auto text-muted-foreground hover:text-foreground"
              aria-label="닫기"
            >
              ✕
            </button>
          </div>
          <div className="text-sm font-semibold leading-snug">{sel.block.title}</div>
          {sel.block.sub && <div className="mt-0.5 text-xs text-muted-foreground">{sel.block.sub}</div>}
          <div className="mt-2 text-[11px] text-muted-foreground/70">
            처리 액션(채택·컷·리포트)은 아직 연결되지 않았습니다.
          </div>
        </div>
      )}
    </Card>
  );
}

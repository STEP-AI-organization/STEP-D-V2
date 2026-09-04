"use client";

import { useState } from "react";
import { formatTimecode } from "@/lib/utils";

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
};

/**
 * Review OS multi-lane highlight timeline — VISUAL layer only.
 *
 * Blocks are selectable and seek the player, but no processing action (채택·컷·
 * 리포트) is wired: this scaffolds the prototype's timeline look ahead of the
 * segment pipeline that will feed it. **Every block here is a real detection** —
 * the caller drops lanes that have no data instead of filling them with samples
 * (a placeholder that seeks the player reads as a real detection).
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
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-bold text-[var(--color-text-primary)] text-[16px]">AI 타임라인 · 하이라이트</h3>
          <span className="text-[12px] text-[var(--color-text-muted)] font-medium">
            미리보기 · 블록 선택만 (처리 액션 미연결)
          </span>
        </div>
        <div className="font-mono text-xs font-bold text-[var(--color-bg-active)] flex items-center gap-1.5">
          <span>{formatTimecode(currentTime)}</span>
          <span className="text-slate-400 font-normal">/</span>
          <span className="text-[var(--color-text-muted)] font-normal">{formatTimecode(durationSec)}</span>
        </div>
      </div>

      {/* Multi-Track Timeline Container (Pixel-Perfect Alignment for Playhead & Click Seeking) */}
      <div className="bg-white dark:bg-[var(--color-bg-dark-backdrop)] border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4 space-y-4 select-none shadow-md shadow-slate-900/5 dark:shadow-none">
        {/* Timeline Grid Header & Tracks Wrapper */}
        <div className="flex items-start gap-4">
          {/* Left Track Labels Column (Fixed w-24) */}
          <div className="w-24 shrink-0 space-y-3 pt-6 text-xs font-bold">
            {lanes.map((lane) => (
              <div key={lane.key} className="h-7 flex items-center gap-1.5" style={{ color: lane.color }}>
                <span className="w-2.5 h-2.5 rounded-xs shrink-0 shadow-xs" style={{ background: lane.color }} />
                <span className="truncate">{lane.label}</span>
              </div>
            ))}
          </div>

          {/* Right Tracks & Ruler Column (Flex-1 Relative Container for 100% Pixel-Perfect Click Seeking) */}
          <div
            className="flex-1 min-w-0 space-y-3 cursor-pointer select-none"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width > 0) {
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                onSeek?.(ratio * durationSec);
              }
            }}
          >
            {/* 1. Time Ruler Ticks */}
            <div className="h-4 flex justify-between text-[10px] text-slate-500 dark:text-slate-400 font-mono font-bold border-b border-slate-200 dark:border-slate-800/80 pb-1">
              {ticks.map((t, i) => (
                <span key={i}>{formatTimecode(t)}</span>
              ))}
            </div>

            {/* 2. Tracks Stack Container — 높이는 트랙 수에 따라 늘어난다(원본은 2트랙 고정 h-[68px]). */}
            <div className="relative flex flex-col justify-between gap-1.5" style={{ height: lanes.length * 34 }}>
              {/* Unified Moving Vertical Playhead Needle */}
              <div
                style={{ left: pct(currentTime) }}
                aria-hidden
                className="absolute top-0 bottom-0 h-full w-0.5 bg-slate-700 dark:bg-white shadow-[0_0_6px_rgba(51,65,85,0.5)] dark:shadow-[0_0_8px_rgba(255,255,255,0.9)] z-30 pointer-events-none transition-all duration-75"
              />

              {lanes.map((lane) => (
                <div
                  key={lane.key}
                  className="w-full h-7 rounded-md relative overflow-hidden flex items-center border"
                  style={{ background: `${lane.color}14`, borderColor: `${lane.color}4d` }}
                >
                  {lane.blocks.map((b) => {
                    const active = sel?.block.id === b.id || (currentTime >= b.start && currentTime <= b.end);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        title={b.title}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSel({ lane, block: b });
                          onSeek?.(b.start);
                        }}
                        style={{
                          left: pct(b.start),
                          width: `max(4px, ${((b.end - b.start) / durationSec) * 100}%)`,
                          background: active ? lane.color : `${lane.color}66`,
                          borderColor: `${lane.color}4d`,
                        }}
                        className={`absolute inset-y-0 h-full rounded-xs border transition-all cursor-pointer hover:brightness-125 ${active ? "z-10" : ""}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* inspector — visual only */}
      {sel && (
        <div className="mt-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] p-3">
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
            <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
              {formatTimecode(sel.block.start)}–{formatTimecode(sel.block.end)}
            </span>
            <button
              type="button"
              onClick={() => setSel(null)}
              className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              aria-label="닫기"
            >
              ✕
            </button>
          </div>
          <div className="text-sm font-semibold leading-snug">{sel.block.title}</div>
          {sel.block.sub && <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{sel.block.sub}</div>}
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            처리 액션(채택·컷·리포트)은 아직 연결되지 않았습니다.
          </div>
        </div>
      )}
    </>
  );
}

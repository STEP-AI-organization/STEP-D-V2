"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils";
import { RECOMMENDATION_KINDS } from "@/lib/constants";
import type { Recommendation } from "@/lib/types";
import type { AnalysisScene } from "@/lib/data/api";

type AiTab = "analysis" | "shorts" | "clips";

/** Left AI panel — analysis scenes + shorts/clip candidates. Clicking a candidate
 *  applies its title + segment to the editor (reference → clip, StepD pattern).
 *  `scenes` is the real content.analyze output (may be missing if analysis is not
 *  done yet — panel shows an empty state, not fake data). */
export function EditorAiPanel({
  recs,
  scenes,
  onApply,
}: {
  recs: Recommendation[];
  scenes?: AnalysisScene[];
  onApply: (rec: Recommendation) => void;
}) {
  const [tab, setTab] = useState<AiTab>("shorts");
  const shorts = recs.filter((r) => r.kind === "short");
  const clips = recs.filter((r) => r.kind === "clip");
  // 분석 탭은 대사/시각 신호가 있는 장면만 (조용한 빈 컷 제외 — 스크롤 노이즈)
  const analysisScenes = (scenes ?? []).filter((s) =>
    (s.text && s.text.trim()) || (s.vision_reason && s.vision_reason.trim()) || (s.vision_tags && s.vision_tags.length > 0),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-zinc-800 text-xs">
        {(["analysis", "shorts", "clips"] as AiTab[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn("flex-1 py-2.5", tab === k ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white")}
          >
            {k === "analysis" ? "분석" : k === "shorts" ? "쇼츠 후보" : "클립 후보"}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {tab === "analysis" && analysisScenes.length === 0 && (
          <div className="p-3 text-center text-xs text-zinc-500">
            {scenes === undefined ? "분석 결과 불러오는 중…" : "분석 결과 없음"}
          </div>
        )}
        {tab === "analysis" &&
          analysisScenes.map((s, i) => {
            const t = typeof s.start === "number" ? s.start : 0;
            const desc = (s.vision_reason && s.vision_reason.trim())
              || (s.text && s.text.trim())
              || (s.vision_tags && s.vision_tags.join(" · "))
              || "";
            return (
              <div key={s.index ?? i} className="rounded-md border border-zinc-800 p-2 text-xs text-zinc-300">
                <div className="flex items-center gap-2 tabular-nums text-zinc-500">
                  <span>{formatTimecode(t)}</span>
                  {typeof s.vision_score === "number" && (
                    <span className="rounded bg-zinc-800 px-1 text-[10px]">시각 {s.vision_score}</span>
                  )}
                  {s.has_dialogue === false && (
                    <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">무음</span>
                  )}
                </div>
                <div className="mt-1 line-clamp-3">{desc}</div>
                {s.on_screen_names && s.on_screen_names.length > 0 && (
                  <div className="mt-1 text-[11px] text-zinc-500">
                    출연: {s.on_screen_names.slice(0, 3).join(", ")}
                  </div>
                )}
              </div>
            );
          })}

        {(tab === "shorts" ? shorts : tab === "clips" ? clips : []).map((r) => (
          <button
            key={r.id}
            onClick={() => onApply(r)}
            className="w-full rounded-md border border-zinc-800 p-2 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-800/50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-200">{r.title}</span>
              <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {RECOMMENDATION_KINDS[r.kind]}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
              <span className="tabular-nums">
                {formatTimecode(r.startTime)}–{formatTimecode(r.endTime)}
              </span>
              <span>appeal {r.appeal}</span>
            </div>
          </button>
        ))}

        {tab === "shorts" && shorts.length === 0 && (
          <div className="p-3 text-center text-xs text-zinc-500">쇼츠 후보 없음</div>
        )}
        {tab === "clips" && clips.length === 0 && (
          <div className="p-3 text-center text-xs text-zinc-500">클립 후보 없음</div>
        )}
      </div>
    </div>
  );
}

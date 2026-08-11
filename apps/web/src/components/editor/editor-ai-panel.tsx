"use client";

import { useState } from "react";
import { Check, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils";
import type { Recommendation } from "@/lib/types";
import { regenerateTitles, type AnalysisScene } from "@/lib/data/api";

type AiTab = "analysis" | "titles";

/** Left AI panel — analysis scenes + title candidates for the current clip.
 *  '제목 후보' 탭 상단에 '새로 생성' 배선이 있다: 사용자가 추가 지시를 텍스트로 넣고 버튼을
 *  누르면 서버가 5개를 새로 뽑아 이 세션 로컬 리스트에 얹는다(서버 저장 X). 세션 내에서만
 *  살고 새로고침하면 다시 sourceRec.titleCandidates 기본값으로 돌아간다 — 사용자의 실험용. */
export function EditorAiPanel({
  clipId,
  scenes,
  scenesState = "loading",
  sourceRec,
  currentTitle,
  onApplyTitle,
}: {
  clipId: string;
  scenes?: AnalysisScene[];
  /** 분석 로딩·실패·미분석·정상을 구분한다 — 전부 undefined 로 합치면 영구 로딩처럼 보인다. */
  scenesState?: "loading" | "error" | "empty" | "ready";
  sourceRec?: Recommendation;
  currentTitle: string;
  onApplyTitle: (title: string) => void;
}) {
  const [tab, setTab] = useState<AiTab>("titles");
  // '새로 생성' 상태 — 프롬프트 입력·로딩·에러·세션 로컬 재생성 후보들.
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regenTitles, setRegenTitles] = useState<string[] | null>(null);

  // 분석 탭은 대사/시각 신호가 있는 장면만 (조용한 빈 컷 제외 — 스크롤 노이즈)
  const analysisScenes = (scenes ?? []).filter((s) =>
    (s.text && s.text.trim()) || (s.vision_reason && s.vision_reason.trim()) || (s.vision_tags && s.vision_tags.length > 0),
  );

  // 제목 후보 리스트 — 재생성 결과(있으면) 우선, 없으면 sourceRec.titleCandidates, 그것도 없으면 대표 title.
  const titles = (() => {
    if (regenTitles && regenTitles.length > 0) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of regenTitles) {
        const v = (t ?? "").trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out;
    }
    if (!sourceRec) return [] as string[];
    const raw = sourceRec.titleCandidates?.length ? sourceRec.titleCandidates : [sourceRec.title];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of raw) {
      const v = (t ?? "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  })();

  async function handleRegen() {
    if (regenLoading) return;
    setRegenLoading(true);
    setRegenError(null);
    try {
      const next = await regenerateTitles(clipId, regenPrompt.trim());
      if (next.length === 0) throw new Error("서버가 후보를 반환하지 않았습니다.");
      setRegenTitles(next);
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : "재생성 실패");
    } finally {
      setRegenLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-zinc-800 text-xs">
        {(["analysis", "titles"] as AiTab[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn("flex-1 py-2.5", tab === k ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white")}
          >
            {k === "analysis" ? "분석" : "제목 후보"}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {tab === "analysis" && analysisScenes.length === 0 && (
          <div
            className={cn(
              "p-3 text-center text-xs",
              scenesState === "error" ? "text-amber-400" : "text-zinc-500",
            )}
          >
            {scenesState === "loading"
              ? "분석 결과 불러오는 중…"
              : scenesState === "error"
                ? "분석 결과를 불러오지 못했습니다 — 서버 연결을 확인하세요."
                : scenesState === "empty"
                  ? "아직 분석되지 않았습니다 — 회차 화면에서 분석을 실행하세요."
                  : "표시할 장면이 없습니다 (대사·시각 신호 있는 장면만 표시)."}
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

        {tab === "titles" && (
          <>
            {/* '새로 생성' 배선 — 프롬프트 텍스트 + 버튼. 결과는 세션 로컬(위 titles가 자동 반영). */}
            <div className="mb-2 rounded-md border border-zinc-800 bg-zinc-900/50 p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                <Sparkles className="size-3 text-amber-400" /> 새로 생성
              </div>
              <textarea
                value={regenPrompt}
                onChange={(e) => setRegenPrompt(e.target.value)}
                placeholder="예: 더 자극적으로, 이모지 넣지 마, 인물 이름을 앞에"
                rows={2}
                className="w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-zinc-500"
              />
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  onClick={handleRegen}
                  disabled={regenLoading}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[11px] font-semibold text-black hover:bg-amber-400 disabled:opacity-60"
                >
                  {regenLoading ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  {regenLoading ? "생성 중…" : "생성"}
                </button>
                {regenTitles && (
                  <button
                    onClick={() => setRegenTitles(null)}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800"
                  >
                    원래대로
                  </button>
                )}
              </div>
              {regenError && (
                <div className="mt-1 text-[10px] text-red-400">{regenError}</div>
              )}
            </div>

            {titles.length === 0 && (
              <div className="p-3 text-center text-xs text-zinc-500">
                제목 후보 없음 — '새로 생성'을 눌러 만들어 보세요.
              </div>
            )}
            {titles.map((t, i) => {
              const applied = t === currentTitle;
              return (
                <button
                  key={`${i}-${t}`}
                  onClick={() => onApplyTitle(t)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors",
                    applied
                      ? "border-emerald-500/60 bg-emerald-500/10"
                      : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/50",
                  )}
                >
                  <span className="mt-0.5 text-[10px] tabular-nums text-zinc-500">{i + 1}.</span>
                  <span className="min-w-0 flex-1 text-xs text-zinc-200">{t}</span>
                  {applied && <Check className="mt-0.5 size-3.5 text-emerald-400" />}
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

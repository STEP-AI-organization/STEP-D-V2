"use client";

/**
 * PplView — core/ppl.py 결과 표시. 브랜드별 노출초 요약 + 검출 구간 카드 그리드.
 * 카드 썸네일 클릭 시 상단 원본 플레이어가 그 구간으로 seek + 재생 (검증).
 */
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ShoppingBag, Tag } from "lucide-react";
import { useVideoSeek } from "./episode/seek-context";
import { pplFrameUrl, type PplData } from "@/lib/data/api";
import { formatTimecode } from "@/lib/utils";
import { cn } from "@/lib/utils";

const CATEGORY_TONE: Record<string, string> = {
  음식: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  음료: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  의류: "bg-[var(--color-bg-active)]/15 text-[var(--color-bg-active)]",
  전자: "bg-[var(--color-bg-active)]/15 text-[var(--color-bg-active)]",
  화장품: "bg-purple-500/15 text-purple-300",
  자동차: "bg-cyan-500/15 text-cyan-300",
  생활용품: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  서비스: "bg-[var(--color-bg-input)] text-[var(--color-text-muted)]",
  기타: "bg-[var(--color-bg-input)] text-[var(--color-text-muted)]",
};

export function PplView({
  ppl,
  mediaId,
  apiBase,
}: {
  ppl: PplData | null | undefined;
  mediaId: string;
  apiBase: string;
}) {
  const seek = useVideoSeek();

  if (!ppl || !ppl.detections || ppl.detections.length === 0) {
    return (
      <EmptyState
        icon={ShoppingBag}
        compact
        title="검출된 PPL·브랜드 없음"
        // PPL 검출은 파이프라인에서 기본 비활성(RUN_PPL=0)이라 재분석해도 결과가 달라지지
        // 않는다 — "정밀 재분석 후 재확인" 은 되지 않는 행동을 시키는 문구라 걷어냈다.
        description={ppl?.note ?? "PPL 검출은 현재 비활성(RUN_PPL=0)입니다 — 재분석해도 결과가 달라지지 않습니다"}
      />
    );
  }

  const detections = [...ppl.detections].sort((a, b) => a.start - b.start);
  const summary = ppl.brand_summary ?? {};
  const brandRank = Object.entries(summary).sort((a, b) => b[1] - a[1]);
  const totalSec = brandRank.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="space-y-3">
      {/* 요약 — 브랜드별 총 노출초 막대 */}
      {brandRank.length > 0 && (
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
            <Tag className="size-3.5" /> 브랜드별 노출 시간 · 총 {formatTimecode(totalSec)}
          </div>
          <div className="space-y-1">
            {brandRank.map(([brand, sec]) => {
              const pct = totalSec > 0 ? (sec / totalSec) * 100 : 0;
              return (
                <div key={brand} className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-24 shrink-0 truncate font-semibold">{brand}</span>
                  <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-[var(--color-bg-input)]">
                    <div className="absolute inset-y-0 left-0 bg-[var(--color-bg-active)]" style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right tabular-nums text-[var(--color-text-muted)]">
                    {sec.toFixed(1)}s
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10.5px] text-[var(--color-text-muted)]">
            검출 구간 {detections.length}개 · 스캔 프레임 {ppl.total_frames_scanned ?? 0}장
            {ppl.sample_sec ? ` · ${ppl.sample_sec}s 간격` : ""}
          </div>
        </Card>
      )}

      {/* 검출 구간 카드 그리드 */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {detections.map((d, i) => {
          const src = d.frame_ref ? pplFrameUrl(apiBase, mediaId, d.frame_ref) : undefined;
          const catTone = CATEGORY_TONE[d.category ?? ""] ?? "bg-[var(--color-bg-input)] text-[var(--color-text-muted)]";
          return (
            <Card key={i} className="overflow-hidden p-0">
              <button
                type="button"
                onClick={() => seek?.seekTo(d.start)}
                className="group relative block aspect-video w-full bg-black/40"
                title={`▶ ${formatTimecode(d.start)}부터 재생`}
              >
                {src ? (
                  <img
                    src={src}
                    alt={d.brand}
                    loading="lazy"
                    className="absolute inset-0 size-full object-cover opacity-90 transition group-hover:opacity-100"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-[var(--color-text-muted)]">
                    <ShoppingBag className="size-8" />
                  </div>
                )}
                {/* 브랜드·카테고리는 카드 본문 타이틀로 이동. 썸네일 위 이중 표시 제거로 노출 자체 강조. */}
                <div className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                  {formatTimecode(d.start)}–{formatTimecode(d.end)} · {Math.round(d.end - d.start)}s
                </div>
                {typeof d.confidence === "number" && (
                  <span
                    className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums"
                    title="검출 신뢰도 (0~1)"
                  >
                    {Math.round(d.confidence * 100)}%
                  </span>
                )}
              </button>
              <div className="space-y-1 p-2.5">
                {/* 브랜드를 본문 타이틀로 승격 — 좌상단 칩만으론 어느 브랜드가 노출됐는지 안 들어옴. */}
                <div className="flex items-center gap-1.5">
                  <span className="line-clamp-1 text-[12.5px] font-semibold leading-snug">
                    {d.brand}
                  </span>
                  {d.category && (
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", catTone)}>
                      {d.category}
                    </span>
                  )}
                </div>
                {/* 어디에·어떻게 노출됐는지 = 위치 + notes 결합. "좌하 · 출연자 티셔츠 로고" */}
                {(d.position || d.notes) && (
                  <p className="line-clamp-2 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">
                    {[d.position, d.notes].filter(Boolean).join(" · ")}
                  </p>
                )}
                {typeof d.frames_hit === "number" && d.frames_hit > 1 && (
                  <div className="flex items-center gap-1">
                    <Badge className="text-[10px] text-[var(--color-text-muted)]">{d.frames_hit} 프레임</Badge>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

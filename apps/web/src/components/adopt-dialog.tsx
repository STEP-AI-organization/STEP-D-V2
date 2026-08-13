"use client";

/**
 * 채택 다이얼로그 — 추천 구간을 클립으로 가져올 때 **형태를 사람이 고른다.**
 *
 * ① 방향(가로 16:9 / 세로 9:16) → ② 세로형이면 AI 리프레임 O/X.
 * 가로형은 크롭이 필요 없어 리프레임 단계를 건너뛴다(오선택 방지).
 *
 * 서버 배선: onConfirm → store.adoptRecommendation(recId, { orientation, reframe }).
 * orientation 은 clip.aspectRatio 로, reframe==='ai' 는 채택 직후 POST /clips/:id/reframe
 * (ai_multi) 로 이어진다.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AdoptOrientation = "landscape" | "portrait";
export type AdoptReframe = "ai" | "none";

export function AdoptDialog({
  title,
  busy,
  onClose,
  onConfirm,
}: {
  title?: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (opts: { orientation: AdoptOrientation; reframe: AdoptReframe }) => void;
}) {
  const [orientation, setOrientation] = useState<AdoptOrientation | null>(null);
  const [reframe, setReframe] = useState<AdoptReframe | null>(null);
  const ready = orientation === "landscape" || (orientation === "portrait" && reframe !== null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">채택 — {title || "쇼츠 후보"}</h3>
        <p className="mt-1 text-xs text-muted-foreground">어떤 형태로 가져올지 고르세요.</p>

        {/* ① 방향 */}
        <div className="mt-4">
          <div className="text-[11px] font-semibold text-muted-foreground">① 방향</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Choice
              active={orientation === "portrait"}
              onClick={() => setOrientation("portrait")}
              title="세로형 9:16"
              sub="쇼츠 · 릴스 · 틱톡"
            />
            <Choice
              active={orientation === "landscape"}
              onClick={() => { setOrientation("landscape"); setReframe(null); }}
              title="가로형 16:9"
              sub="일반 영상 · 원본 비율"
            />
          </div>
        </div>

        {/* ② AI 리프레임 — 세로형일 때만 (가로는 크롭이 없어 무의미) */}
        {orientation === "portrait" && (
          <div className="mt-4">
            <div className="text-[11px] font-semibold text-muted-foreground">② AI 리프레임</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Choice
                active={reframe === "ai"}
                onClick={() => setReframe("ai")}
                title="AI 리프레임 ON"
                sub="beat별 얼굴 추적 자동 크롭"
              />
              <Choice
                active={reframe === "none"}
                onClick={() => setReframe("none")}
                title="OFF"
                sub="중앙 고정 크롭"
              />
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              ON은 채택 직후 얼굴 추적 분석을 시작합니다(잠깐 소요). 에디터에서 나중에 켤 수도 있습니다.
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>취소</Button>
          <Button
            size="sm"
            disabled={!ready || busy}
            onClick={() =>
              ready &&
              onConfirm({
                orientation: orientation!,
                reframe: orientation === "portrait" ? (reframe as AdoptReframe) : "none",
              })
            }
          >
            {busy ? "채택 중…" : "채택"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Choice({
  active,
  onClick,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition",
        active ? "border-primary bg-primary/10" : "hover:bg-muted",
      )}
    >
      <div className="text-[12.5px] font-medium">{title}</div>
      <div className="text-[10.5px] text-muted-foreground">{sub}</div>
    </button>
  );
}

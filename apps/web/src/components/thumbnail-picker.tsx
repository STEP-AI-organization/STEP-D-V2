"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThumbnailVariant } from "@/lib/types";

export function ThumbnailPicker({
  thumbnails,
  apiBase,
  chosenId,
  onChoose,
}: {
  thumbnails?: ThumbnailVariant[];
  apiBase: string;
  chosenId?: string;
  onChoose: (id: string) => void;
}) {
  if (!thumbnails || thumbnails.length === 0) {
    return (
      <div className="flex items-center justify-center p-4 text-[12px] text-muted-foreground border rounded-md border-dashed">
        등록된 썸네일 변형이 없습니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="text-[11px] font-semibold text-muted-foreground mb-1">
        썸네일 후보 (AI 디자인)
      </div>
      <div className="grid grid-cols-3 gap-2">
        {thumbnails.map((t) => {
          const isChosen = chosenId ? t.id === chosenId : t.chosen;
          const url16x9 = t.urls["16:9"];
          const url9x16 = t.urls["9:16"];
          // Keep absolute object URLs intact and join relative storage paths without
          // producing a double slash after the API base.
          const url = url16x9 ?? url9x16;
          const src = !url ? "" : /^https?:\/\//i.test(url)
            ? url
            : `${apiBase.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;

          return (
            <div
              key={t.id}
              className={cn(
                "group relative cursor-pointer overflow-hidden rounded-md border-2 transition-all",
                isChosen ? "border-status-done ring-1 ring-status-done" : "border-transparent hover:border-muted-foreground/30"
              )}
              onClick={() => onChoose(t.id)}
            >
              <div className="aspect-video w-full bg-black/40">
                {src ? (
                  <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">No image</div>
                )}
              </div>
              
              {/* 메타데이터 오버레이 (호버 시 표시). 편집 버튼은 핸들러를 넘기는 곳이 없어 제거함.
                  layout_preset·caption_tone 배지도 뺐다 — 생산자가 전 variant 에 같은 상수를
                  박아 넣어(variety·기본) 선택 근거로 오해된다. */}
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
                <div className="text-[10px] text-white font-bold px-1 text-center truncate w-full">
                  {t.caption_text}
                </div>
              </div>

              {isChosen && (
                <div className="absolute top-1 right-1 rounded-full bg-status-done p-0.5 text-white shadow-md">
                  <Check className="size-3" strokeWidth={3} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
"use client";

import { useState } from "react";
import { Check, Edit2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ThumbnailVariant } from "@/lib/types";

export function ThumbnailPicker({
  thumbnails,
  apiBase,
  chosenId,
  onChoose,
  onEdit,
}: {
  thumbnails?: ThumbnailVariant[];
  apiBase: string;
  chosenId?: string;
  onChoose: (id: string) => void;
  onEdit?: (id: string) => void;
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
              
              {/* 메타데이터 오버레이 (호버 시 표시) */}
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
                <div className="text-[10px] text-white font-bold mb-1 px-1 text-center truncate w-full">
                  {t.caption_text}
                </div>
                <div className="flex gap-1">
                  {onEdit && (
                    <Button 
                      size="xs" 
                      variant="outline" 
                      className="h-6 px-2 text-[10px] bg-black/40 border-white/20 text-white hover:bg-black/80"
                      onClick={(e) => { e.stopPropagation(); onEdit(t.id); }}
                    >
                      <Edit2 className="size-3 mr-1" /> 편집
                    </Button>
                  )}
                </div>
              </div>

              {isChosen && (
                <div className="absolute top-1 right-1 rounded-full bg-status-done p-0.5 text-white shadow-md">
                  <Check className="size-3" strokeWidth={3} />
                </div>
              )}
              
              <div className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[8px] font-bold text-white uppercase">
                {t.layout_preset} · {t.caption_tone}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
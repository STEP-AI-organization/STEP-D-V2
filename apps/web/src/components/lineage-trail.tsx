"use client";

import { ArrowRight } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppData } from "@/lib/data/store";
import { channelLabel } from "@/lib/constants";
import type { Clip, Recommendation } from "@/lib/types";

/** Recommendation → Clip → Distribution lineage trail (plan §7.6 / pain B3).
 *  Resolves the adopted clip + its channel states from the store. */
export function LineageTrail({ rec }: { rec: Recommendation }) {
  const { clips } = useAppData();
  const clip = rec.adoptedClipId ? clips.find((c) => c.id === rec.adoptedClipId) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded bg-secondary px-2 py-1 font-medium">추천 · {rec.title}</span>
      <ArrowRight className="size-3.5 text-muted-foreground" />
      {clip ? <ClipNode clip={clip} /> : <span className="text-muted-foreground/60">클립 없음</span>}
      <ArrowRight className="size-3.5 text-muted-foreground" />
      {clip && clip.distributions.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {clip.distributions.map((d) => (
            <StatusBadge
              key={d.channel}
              tone={d.status === "failed" ? "error" : d.status === "published" ? "done" : "warn"}
            >
              {channelLabel(d.channel)}
            </StatusBadge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground/60">미배포</span>
      )}
    </div>
  );
}

function ClipNode({ clip }: { clip: Clip }) {
  const tone = clip.status === "encoding" ? "progress" : "done";
  const label =
    clip.status === "encoding" ? "인코딩 중" : clip.status === "ready" ? "준비 완료" : "배포됨";
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-secondary px-2 py-1 font-medium">
      클립 <StatusBadge tone={tone}>{label}</StatusBadge>
    </span>
  );
}

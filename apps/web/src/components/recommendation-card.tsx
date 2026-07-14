"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, X, CircleCheck, Pencil, ImageIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { RECOMMENDATION_KINDS } from "@/lib/constants";
import { formatTimecode } from "@/lib/utils";
import type { Recommendation } from "@/lib/types";

const REJECT_REASONS = ["품질 낮음", "중복 구간", "부적합", "길이 문제", "기타"];

/** Recommendation review card: thumbnail-candidate picker, one-click adopt
 *  (→ export+register chain), adopt-and-edit, reject-with-reason, and lineage. (plan §7.3) */
export function RecommendationCard({ rec }: { rec: Recommendation }) {
  const router = useRouter();
  const { adoptRecommendation, rejectRecommendation, selectThumbnail, serverConnected } = useAppData();
  const { toast } = useToast();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const candidates = rec.thumbnailCandidates ?? [];
  const selectedId = rec.selectedThumbnailId ?? candidates[0]?.id;
  const selected = candidates.find((c) => c.id === selectedId);

  async function adopt() {
    setBusy(true);
    try {
      await adoptRecommendation(rec.id);
      toast({
        title: "채택됨",
        description: serverConnected ? `${rec.title} · 클립을 생성했습니다.` : `${rec.title} · 인코딩→등록을 시작했습니다.`,
        tone: serverConnected ? "done" : "progress",
      });
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function adoptAndEdit() {
    setBusy(true);
    try {
      const clipId = await adoptRecommendation(rec.id);
      if (clipId) router.push(`/editor/${clipId}`);
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  function reject(reason: string) {
    rejectRecommendation(rec.id, reason);
    setRejectOpen(false);
    toast({ title: "반려 처리됨", description: `사유: ${reason}`, tone: "warn" });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="relative flex aspect-video items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
        {selected ? (
          <span className="inline-flex items-center gap-1">
            <ImageIcon className="size-3.5" /> {selected.label} · {formatTimecode(selected.atTime)}
          </span>
        ) : (
          <>{formatTimecode(rec.startTime)}–{formatTimecode(rec.endTime)}</>
        )}
        {rec.appeal >= 4 && (
          <span className="absolute right-2 top-2 rounded-full bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-status-warn">
            정예
          </span>
        )}
      </div>

      {/* thumbnail candidate picker (STEPD pain C5) */}
      {rec.status === "pending" && candidates.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={() => selectThumbnail(rec.id, c.id)}
              className={cn(
                "rounded border px-1.5 py-1 text-[11px] transition-colors",
                c.id === selectedId
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
              title={`${formatTimecode(c.atTime)} 프레임`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="text-sm font-semibold leading-snug">{rec.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge>{RECOMMENDATION_KINDS[rec.kind]}</Badge>
          <Badge className="tabular-nums">appeal {rec.appeal}</Badge>
          {rec.people?.map((p) => (
            <Badge key={p} className="text-muted-foreground">
              {p}
            </Badge>
          ))}
        </div>
      </div>

      {rec.editNote && <p className="text-xs text-muted-foreground">💡 {rec.editNote}</p>}

      {rec.status === "pending" && (
        <div className="relative flex items-center gap-2">
          <Button size="sm" className="flex-1" onClick={adopt} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} 채택
          </Button>
          <Button size="sm" variant="secondary" onClick={adoptAndEdit} disabled={busy} title="채택 후 편집기 열기">
            <Pencil /> 편집
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRejectOpen((v) => !v)} disabled={busy}>
            <X />
          </Button>
          {rejectOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setRejectOpen(false)} aria-hidden />
              <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-40 rounded-md border border-border bg-popover p-1 shadow-lg">
                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">반려 사유</div>
                {REJECT_REASONS.map((reason) => (
                  <button
                    key={reason}
                    className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => reject(reason)}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {rec.status === "adopted" && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-status-done/10 px-3 py-2 text-xs text-status-done">
          <span className="inline-flex items-center gap-1.5">
            <CircleCheck className="size-4" /> 채택됨 · 인코딩→등록
          </span>
          <Link
            href={rec.adoptedClipId ? `/editor/${rec.adoptedClipId}` : "/clips"}
            className="font-medium underline underline-offset-2 hover:opacity-80"
          >
            클립 편집
          </Link>
        </div>
      )}

      {rec.status === "rejected" && (
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          반려됨 · {rec.rejectReason}
        </div>
      )}
    </Card>
  );
}

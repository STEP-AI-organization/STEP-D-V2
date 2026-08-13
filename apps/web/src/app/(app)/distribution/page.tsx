"use client";

/**
 * U8 · 배포 (README §7 · FLOWS F4).
 *
 * 무엇이 **어느 채널에** 나갔는지의 기록 — **영상×채널 매트릭스**로 본다(2026-08-13).
 * 예전엔 (클립×채널) 한 줄씩이라 한 영상을 여러 채널에 올리면 줄이 흩어져 안 보였다.
 *
 * 지키는 것:
 *  - **`기록됨`을 `게시됨`처럼 보여주지 않는다** (F4 Invariant). Meta·TikTok 은 파일이
 *    안 올라간다 — 색을 분리한다.
 *  - **실패는 자동 재시도하지 않는다** (F4-4 ⊘). 사람이 셀을 눌러야 다시 간다.
 */
import { useMemo, useState } from "react";

import { PublishDialog } from "@/components/publish/publish-dialog";
import { DistributionMatrix, type MatrixRow } from "@/components/distribution/distribution-matrix";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import type { Clip } from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";
import { cn } from "@/lib/utils";

export default function DistributionPage() {
  const { clips, episodes, programs, retryDistribution, loading, serverConnected } = useAppData();
  const { toast } = useToast();
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);

  const rows: MatrixRow[] = useMemo(() => {
    return clips
      .filter((c) => (c.distributions ?? []).some((d) => d.status !== "none"))
      .filter((c) => !failedOnly || (c.distributions ?? []).some((d) => d.status === "failed"))
      .map((c) => {
        const ep = episodes.find((e) => e.id === c.episodeId);
        const programTitle =
          programs.find((p) => p.id === ep?.programId)?.title ??
          programs.find((p) => p.id === c.programId)?.title ??
          c.programTitle ??
          "";
        // directUpload 클립은 episodeId 가 없다 — edits 화면과 같은 규칙으로 클립 필드 우선.
        return { clip: c, programTitle, episodeNumber: c.episodeNumber ?? ep?.episodeNumber };
      });
  }, [clips, episodes, programs, failedOnly]);

  // 채널 무관 전체 집계 — 매트릭스 위에 한 줄 요약.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clips) for (const d of c.distributions ?? []) {
      if (d.status !== "none") m.set(d.status, (m.get(d.status) ?? 0) + 1);
    }
    return m;
  }, [clips]);

  async function retry(clipId: string, channel: DistributionChannel) {
    if (!serverConnected) {
      toast({ title: "서버 미연결 — 재시도를 보내지 못했습니다", description: "연결 회복 후 다시 눌러 주세요.", tone: "error" });
      return;
    }
    try {
      await retryDistribution(clipId, channel);
      toast({ title: "재시도를 요청했습니다", description: "자동 재시도는 없습니다 — 실패하면 셀이 갱신됩니다.", tone: "progress" });
    } catch (e) {
      toast({ title: "재시도 요청 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
    }
  }

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      <div className="flex flex-wrap items-center gap-[9px]">
        <button
          type="button"
          className={cn("sd-btn", failedOnly && "sd-btn--on")}
          onClick={() => setFailedOnly((v) => !v)}
        >
          실패만 보기
          <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>{counts.get("failed") ?? 0}</span>
        </button>
        <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
          게시됨 {counts.get("published") ?? 0} · 기록됨 {counts.get("recorded") ?? 0} ·{" "}
          예약 {counts.get("scheduled") ?? 0} · 진행 중 {counts.get("pending") ?? 0} · 실패 {counts.get("failed") ?? 0}
        </span>
      </div>

      {(counts.get("recorded") ?? 0) > 0 && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px] leading-relaxed"
          style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
        >
          <b style={{ color: "var(--sd-fg)" }}>기록됨</b>은 게시가 아닙니다. Instagram·Facebook·TikTok 은
          파일이 올라가지 않고 우리 쪽 기록만 남습니다 — 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다.
        </div>
      )}

      {rows.length === 0 ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {loading ? "불러오는 중…" : "배포 기록이 없습니다 — 미디어·편집본 화면에서 배포하면 여기 쌓입니다"}
        </div>
      ) : (
        <DistributionMatrix
          rows={rows}
          onPublish={(clip: Clip) => setPublishTarget([clip.id])}
          onRetry={retry}
        />
      )}

      {publishTarget && (
        <PublishDialog clipIds={publishTarget} onClose={() => setPublishTarget(null)} onDone={async () => {}} />
      )}
    </div>
  );
}

"use client";

/**
 * 편집본 — 외부에서 편집한 완성 영상을 올려 **여러 채널에 배포**하는 곳.
 *
 * 미디어(분석 파생: 추천 채택 → 트림·인코딩)와 **분리**한다. 편집본은 우리 파이프라인이
 * 만든 게 아니라 편집자가 통째로 올린 것이고, 목적은 오직 하나 — **다중 채널 배포**다.
 * 그래서 화면도 영상×채널 매트릭스가 중심이다(어느 영상이 어디 나갔나 한눈에).
 */
import { useMemo, useState } from "react";

import { UploadClipButton } from "@/components/upload-clip-dialog";
import { DistributionMatrix, type MatrixRow } from "@/components/distribution/distribution-matrix";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { roleOf } from "@/lib/roles";
import { useAppData } from "@/lib/data/store";
import type { Clip } from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";

export default function EditsPage() {
  const { clips, programs, episodes, retryDistribution, loading, serverConnected } = useAppData();
  const { toast } = useToast();
  const session = useSession();
  const role = roleOf(session.user.role);
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);

  const rows: MatrixRow[] = useMemo(
    () =>
      clips
        .filter((c) => c.directUpload)
        .map((c) => ({
          clip: c,
          programTitle:
            programs.find((p) => p.id === c.programId)?.title ?? c.programTitle ?? "",
          // 업로드 때 적은 번호가 우선 — 회차 엔티티 없이도 남는 사실이다.
          episodeNumber:
            c.episodeNumber ?? episodes.find((e) => e.id === c.episodeId)?.episodeNumber ?? undefined,
        })),
    [clips, programs, episodes],
  );

  async function retry(clipId: string, channel: DistributionChannel) {
    if (!serverConnected) {
      toast({ title: "서버 미연결 — 재시도를 보내지 못했습니다", tone: "error" });
      return;
    }
    try {
      await retryDistribution(clipId, channel);
      toast({ title: "재시도를 요청했습니다", tone: "progress" });
    } catch (e) {
      toast({ title: "재시도 요청 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
    }
  }

  function openPublish(clip: Clip) {
    if (!role.publish) {
      toast({ title: "배포 권한이 없습니다", description: "CP·PD 만 배포할 수 있습니다.", tone: "error" });
      return;
    }
    setPublishTarget([clip.id]);
  }

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px] pb-16">
      <div className="flex flex-wrap items-center gap-[9px]">
        <p className="text-[12px]" style={{ color: "var(--sd-mut)" }}>
          외부에서 편집한 완성 영상을 올려 <b style={{ color: "var(--sd-fg)" }}>여러 채널에 한 번에</b> 배포합니다.
          미디어(분석 파생)와는 별개입니다.
        </p>
        <UploadClipButton className="sd-btn sd-btn-primary ml-auto" label="완성 영상 업로드" />
      </div>

      {rows.length === 0 ? (
        <div
          className="sd-ph grid min-h-[180px] place-items-center rounded-[6px] px-6 text-center text-[12.5px]"
          style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}
        >
          {loading
            ? "불러오는 중…"
            : "편집본이 없습니다 — 오른쪽 위 “완성 영상 업로드”로 올리면 여기서 다중 채널로 배포합니다."}
        </div>
      ) : (
        <DistributionMatrix rows={rows} onPublish={openPublish} onRetry={retry} />
      )}

      {publishTarget && (
        <PublishDialog clipIds={publishTarget} onClose={() => setPublishTarget(null)} onDone={async () => {}} />
      )}
    </div>
  );
}

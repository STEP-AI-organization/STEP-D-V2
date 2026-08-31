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
import { useEffect, useMemo, useState } from "react";

import { PublishDialog } from "@/components/publish/publish-dialog";
import { DistributionMatrix, type MatrixRow } from "@/components/distribution/distribution-matrix";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import type { Clip } from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";
import { cn } from "@/lib/utils";

export default function DistributionPage() {
  const { clips, episodes, programs, retryDistribution, loading, serverConnected, refresh } = useAppData();
  const { toast } = useToast();
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [progFilter, setProgFilter] = useState<string>(""); // "" = 전체 프로그램

  const rows: MatrixRow[] = useMemo(() => {
    return clips
      // recorded 만 있는 클립은 매트릭스에 안 띄운다 — 셀이 전부 ＋(빈 칸)라 정보가 없다.
      .filter((c) => (c.distributions ?? []).some((d) => d.status !== "none" && d.status !== "recorded"))
      .filter((c) => !failedOnly || (c.distributions ?? []).some((d) => d.status === "failed"))
      .filter((c) => !progFilter || (episodes.find((e) => e.id === c.episodeId)?.programId ?? c.programId) === progFilter)
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
      // recorded(게이트 OFF 시절 기록)는 파일이 안 올라간 것 — 상태 어휘에서 뺐다(2026-08-26).
      if (d.status === "none" || d.status === "recorded") continue;
      // 예약 시각이 지난 건은 "예약"으로 세지 않는다 — 유튜브는 이미 처리했고 우리만 모른다.
      // 그대로 세면 상단 요약이 "예약 2" 라고 하는데 채널엔 예약이 없다(2026-08-21 사용자 지적).
      // 실제 공개 여부는 우리가 다시 읽지 않으므로 '게시됨'으로도 못 옮긴다 → 별도 칸으로 뺀다.
      const at = d.status === "scheduled" && d.reserveDate ? Date.parse(d.reserveDate) : NaN;
      const key = Number.isFinite(at) && at <= Date.now() ? "scheduled_past" : d.status;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [clips]);

  // 배포 직후 pending → 진행 중 → 게시됨 이 수동 새로고침 없이 반영되도록,
  // 비종료 상태(pending·scheduled)가 하나라도 있으면 전역 state refresh 를 폴링한다.
  // 전부 종료(published·recorded·failed)되면 멈춘다. 이 화면에서만 돈다(언마운트 시 정리).
  // ⚠️ 지난 예약은 **폴링해도 안 바뀐다.** 우리는 예약을 건 뒤 유튜브 상태를 다시 읽지 않으니
  //    그 행은 영원히 'scheduled' 다 — 그대로 두면 이 화면이 무한히 서버를 두드린다.
  //    아직 안 온 예약만 진행 중으로 본다(그건 시각이 되면 우리 쪽 기록도 의미가 생긴다).
  const anyInFlight = useMemo(
    () =>
      clips.some((c) =>
        (c.distributions ?? []).some((d) => {
          if (d.status === "pending") return true;
          if (d.status !== "scheduled") return false;
          const at = d.reserveDate ? Date.parse(d.reserveDate) : NaN;
          return Number.isFinite(at) ? at > Date.now() : false;
        }),
      ),
    [clips],
  );

  useEffect(() => {
    if (!anyInFlight || !serverConnected) return;
    let cancelled = false;
    let running = false; // 겹침 방지 — 이전 fetch 가 끝나기 전엔 새로 안 쏜다
    const id = window.setInterval(() => {
      // 숨은 탭에서는 건너뛴다 — refresh() 는 /api/state 를 통째로 다시 받는다.
      if (cancelled || running || document.hidden) return;
      running = true;
      void refresh().finally(() => {
        running = false;
      });
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [anyInFlight, serverConnected, refresh]);

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
        <select
          value={progFilter}
          onChange={(e) => setProgFilter(e.target.value)}
          className="sd-input text-[12px]"
          aria-label="프로그램 필터"
        >
          <option value="">전체 프로그램</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
          {/* 상태 어휘 단순화(2026-08-26): 게시됨·예약·실패 + 업로드 도는 몇 분만 '게시 중'.
              지난 예약("scheduled_past")은 예약 수에 넣지 않는다 — youtube.reconcile 이
              공개를 확정하면 게시됨으로 넘어간다. */}
          게시됨 {counts.get("published") ?? 0} · 예약 {counts.get("scheduled") ?? 0} · 실패 {counts.get("failed") ?? 0}
          {(counts.get("pending") ?? 0) > 0 && <> · 게시 중 {counts.get("pending")}</>}
        </span>
      </div>

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

"use client";

/**
 * 배포 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/distribution/page.tsx` 539줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐고
 * `<main>` 에 `overflow-y-auto` 를 더했다(원본은 스크롤이 그 바깥 래퍼에 있었다).
 * 표 자체는 `DistributionMatrix` 가 그린다 — 편집본 화면과 같은 표라 한 벌로 둔다.
 *
 * 무엇이 **어느 채널에** 나갔는지의 기록 — **영상×채널 매트릭스**. 지키는 것:
 *  - **`기록됨`을 `게시됨`처럼 보여주지 않는다** (F4 Invariant). 파일이 안 올라간 행은
 *    빈 칸(＋)으로 그린다.
 *  - **실패는 자동 재시도하지 않는다** (F4-4 ⊘). 사람이 셀을 눌러야 다시 간다.
 *
 * ## 원본이 목이라 되살린 것
 *  - 행 25개가 `Array.from({length:25})` 로 **지어낸 것**이다(프로그램명도 3개 순환).
 *  - 요약 숫자 `게시됨 75 · 예약 0 · 실패 0` 과 `실패만 보기 0` 이 리터럴이다.
 *  - 페이지가 **3쪽 고정**이다 → 실제 행 수로 나눈다.
 *  - `배포` 버튼 6개가 전부 모달 직결이다 → 채널 칸은 그 플랫폼을 미리 고른다.
 *  - 폴링이 없다 → 배포 직후 칸이 "게시 중" 에 멈춰 사람이 F5 를 눌러야 한다.
 */
import { useEffect, useMemo, useState } from "react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { DistributionMatrix, type MatrixRow } from "@/components/distribution/distribution-matrix";
import { ClipDetail } from "@/components/media/clip-detail";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import type { ChannelMeta } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import type { Clip } from "@/lib/types";
import type { DistributionChannel } from "@/lib/constants";

/** 원본 페이지네이션이 25개 단위다(distribution/page.tsx:212·338). */
const PAGE_SIZE = 25;

export default function DistributionPage() {
  const { clips, episodes, programs, retryDistribution, loading, serverConnected, refresh } = useAppData();
  const { toast } = useToast();
  const [publishTarget, setPublishTarget] = useState<{ clipIds: string[]; platform?: string } | null>(null);
  /** 발행된 영상의 제목/설명을 고칠 클립 — 미디어 상세(ClipDetail)를 그대로 연다. */
  const [metaTarget, setMetaTarget] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [progFilter, setProgFilter] = useState<string>(""); // "" = 전체 프로그램
  const [page, setPage] = useState(1);

  const programOptions = useMemo(
    () => [{ value: "", label: "전체 프로그램" }, ...programs.map((p) => ({ value: p.id, label: p.title }))],
    [programs],
  );

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
  }, [clips, episodes, programs, failedOnly, progFilter]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // 필터를 좁혀 쪽수가 줄면 빈 쪽에 남지 않게 한다.
  const current = Math.min(page, pageCount);
  const shown = useMemo(
    () => rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    [rows, current],
  );

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
    <>
      <Header title="배포" subtitle="채널별 배포 로그 · 실패는 사람이 재시도" />

      {/* Deploy Main Content Area */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
        <div className="space-y-4 flex-1 flex flex-col">
          {/* Action Bar: Filter Controls & Counter Summary */}
          <div className="flex items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex items-center gap-2">
              {/* Show Only Failed Button (Equal Height h-10, No Border, Soft Shadow) */}
              <button
                type="button"
                onClick={() => { setFailedOnly((prev) => !prev); setPage(1); }}
                aria-pressed={failedOnly}
                className={`h-10 px-4 rounded-full border-none text-xs font-semibold transition-colors cursor-pointer shrink-0 shadow-md shadow-slate-900/5 dark:shadow-none flex items-center justify-center gap-1 ${
                  failedOnly
                    ? "bg-rose-500/15 text-rose-500 dark:text-rose-400 font-bold"
                    : "bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)]"
                }`}
              >
                <span>실패만 보기</span>
                <span className="font-mono text-[11px] opacity-80">{counts.get("failed") ?? 0}</span>
              </button>

              {/* Light Gray Vertical Divider */}
              <div className="h-4 w-[1px] bg-slate-300 dark:bg-slate-700/80 shrink-0 self-center" />

              {/* Program Selector (Equal Height h-10, No Border, Soft Shadow) */}
              <div className="w-44">
                <CustomSelect
                  options={programOptions}
                  value={progFilter}
                  onChange={(val) => { setProgFilter(val); setPage(1); }}
                  ariaLabel="프로그램 필터"
                  className="text-xs"
                  triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs font-bold border-none rounded-full shadow-md shadow-slate-900/5 dark:shadow-none"
                />
              </div>
            </div>

            {/* Stats Summary Counter */}
            {/* 상태 어휘 단순화(2026-08-26): 게시됨·예약·실패 + 업로드 도는 몇 분만 '게시 중'.
                지난 예약("scheduled_past")은 예약 수에 넣지 않는다 — youtube.reconcile 이
                공개를 확정하면 게시됨으로 넘어간다. */}
            <div className="text-xs text-[var(--color-text-muted)] font-medium flex items-center gap-1.5">
              <span>게시됨 <span className="font-mono text-[var(--color-text-primary)] font-bold">{counts.get("published") ?? 0}</span></span>
              <span>·</span>
              <span>예약 <span className="font-mono text-[var(--color-text-primary)] font-bold">{counts.get("scheduled") ?? 0}</span></span>
              <span>·</span>
              <span>실패 <span className="font-mono text-[var(--color-text-primary)] font-bold">{counts.get("failed") ?? 0}</span></span>
              {(counts.get("pending") ?? 0) > 0 && (
                <>
                  <span>·</span>
                  <span>게시 중 <span className="font-mono text-[var(--color-text-primary)] font-bold">{counts.get("pending")}</span></span>
                </>
              )}
            </div>
          </div>

          {/* Content Container (Full Height Unlocked List, 25 items per page) */}
          {rows.length > 0 ? (
            <DistributionMatrix
              rows={shown}
              onPublish={(clip: Clip, channel?: DistributionChannel) =>
                setPublishTarget({ clipIds: [clip.id], platform: channel })}
              onRetry={retry}
              onEditMeta={(clip: Clip) => setMetaTarget(clip.id)}
              footer={
                /* Pagination Footer (25 items per page) */
                <div className="p-4 border-t border-[var(--color-border-subtle)] flex items-center justify-between text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-card)] select-none">
                  <span>
                    전체 <strong className="text-[var(--color-text-primary)]">{rows.length}개</strong> 중{" "}
                    <strong className="text-[var(--color-text-primary)]">
                      {(current - 1) * PAGE_SIZE + 1}-{Math.min(rows.length, current * PAGE_SIZE)}
                    </strong>개 표시
                  </span>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPage(Math.max(1, current - 1))}
                      disabled={current === 1}
                      className="px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors cursor-pointer"
                    >
                      이전
                    </button>

                    {/* 원본은 [1,2,3] 고정이다 — 실제 쪽수를 현재 쪽 주변으로 3칸 창을 내어 그린다. */}
                    {pageWindow(current, pageCount).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPage(p)}
                        className={`w-7 h-7 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center justify-center ${
                          current === p
                            ? "bg-[#1C60FF] text-white shadow-xs"
                            : "bg-[var(--color-bg-input)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)]"
                        }`}
                      >
                        {p}
                      </button>
                    ))}

                    <button
                      type="button"
                      onClick={() => setPage(Math.min(pageCount, current + 1))}
                      disabled={current === pageCount}
                      className="px-3.5 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors cursor-pointer"
                    >
                      다음
                    </button>
                  </div>
                </div>
              }
            />
          ) : (
            /* Striped Empty State Banner */
            <div className="w-full flex-1 rounded-xl bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none flex items-center justify-center p-8 text-center bg-[radial-gradient(#ffffff0a_1px,transparent_1px)] [background-size:16px_16px] min-h-[300px]">
              <p className="text-xs text-[var(--color-text-muted)] font-medium">
                {loading
                  ? "불러오는 중…"
                  : failedOnly
                    ? "실패한 배포가 없습니다"
                    : "배포 기록이 없습니다 ㅡ 미디어·편집본 화면에서 배포하면 여기 쌓입니다"}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <Footer />
      </main>

      {publishTarget && (
        <PublishDialog
          clipIds={publishTarget.clipIds}
          presetPlatform={publishTarget.platform}
          onClose={() => setPublishTarget(null)}
          onDone={async () => {}}
        />
      )}

      {/* 발행 뒤 제목/설명 고치기 — 미디어 상세와 **같은 화면**을 연다(편집 자리를 둘로 만들지 않는다).
          거기서 '저장하고 유튜브에 반영' 을 누르면 videos.update 로 기존 영상만 고쳐진다. */}
      {metaTarget && (() => {
        const row = rows.find((r) => r.clip.id === metaTarget);
        if (!row) return null;
        return (
          <ClipDetail
            clip={row.clip as Clip & { channelMeta?: Record<string, ChannelMeta> }}
            programTitle={row.programTitle}
            onClose={() => setMetaTarget(null)}
          />
        );
      })()}
    </>
  );
}

/** 현재 쪽을 가운데 두는 3칸 창(원본은 1·2·3 고정). 쪽이 3개 이하면 전부 그린다. */
function pageWindow(current: number, total: number): number[] {
  if (total <= 3) return Array.from({ length: total }, (_, i) => i + 1);
  const start = Math.min(Math.max(1, current - 1), total - 2);
  return [start, start + 1, start + 2];
}

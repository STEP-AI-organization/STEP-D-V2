"use client";

/**
 * 편집본 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/edits/page.tsx` 760줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐고,
 * `<main>` 에 `overflow-y-auto` 를 더했다(원본은 스크롤이 우리가 제거하는 바깥 래퍼에 있었다).
 *
 * 외부에서 편집한 완성 영상을 올려 **여러 채널에 배포**하는 곳. 미디어(분석 파생: 추천 채택 →
 * 트림·인코딩)와 **분리**한다 — 편집본은 우리 파이프라인이 만든 게 아니라 편집자가 통째로
 * 올린 것이고 목적은 오직 다중 채널 배포다. 그래서 화면도 영상×채널 매트릭스가 중심이다.
 *
 * ## 이 화면은 목업에서 **목적물 두 개가 통째로 비어 있었다**
 *  - 배포 모달의 `배포` 버튼이 `setIsDeployModalOpen(false)` 다 — 모달만 닫힌다.
 *  - 업로드는 300ms 마다 +20 하는 **가짜 진행률**이다. 파일은 어디로도 안 간다.
 * 둘 다 우리 `PublishDialog`·`UploadClipDialog` 가 맡는다(각각 4곳·2곳이 공유하는
 * 컴포넌트라, 모달 마크업 이식은 진입점 동시 전환 별건이다. 여기선 **버튼 픽셀만** 원본).
 *
 * ## 되살린 것
 *  - **표 행이 map 이 아니라 리터럴 1개**다. `directUpload` 클립으로 돌린다 —
 *    이 필터가 이 화면의 정체성이다(빠지면 분석 파생 클립까지 섞여 /media 와 중복된다).
 *  - **채널 5칸이 전부 같은 ＋ 버튼**이라 상태 분기가 0이다 → 매트릭스가 상태를 그린다.
 *  - **배포를 여는 버튼이 6개인데 전부 모달 직결**이다. 하나만 직결로 남겨도 권한 게이트가
 *    무력해진다 → 6개 모두 `openPublish` 를 거친다(`role.publish`).
 *  - **프로그램 필터가 이름 비교**다 → `programId` 조인(동명·개명에 안 깨진다).
 *  - 실패 칸이 목업에 없어 **재시도 경로가 통째로 증발**한다. 자동 재시도는 없다(F4-4).
 */
import { useMemo, useState } from "react";
import { Upload } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { UploadClipButton } from "@/components/upload-clip-dialog";
import { DistributionMatrix, type MatrixRow } from "@/components/distribution/distribution-matrix";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { CustomSelect } from "@/components/ui/custom-select";
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
  const [publishTarget, setPublishTarget] = useState<{ clipIds: string[]; platform?: string } | null>(null);
  const [progFilter, setProgFilter] = useState<string>(""); // "" = 전체 프로그램

  const programOptions = useMemo(
    () => [{ value: "", label: "전체 프로그램" }, ...programs.map((p) => ({ value: p.id, label: p.title }))],
    [programs],
  );

  const rows: MatrixRow[] = useMemo(
    () =>
      clips
        .filter((c) => c.directUpload)
        .filter((c) => !progFilter || (c.programId ?? episodes.find((e) => e.id === c.episodeId)?.programId) === progFilter)
        .map((c) => ({
          clip: c,
          programTitle:
            programs.find((p) => p.id === c.programId)?.title ?? c.programTitle ?? "",
          // 업로드 때 적은 번호가 우선 — 회차 엔티티 없이도 남는 사실이다.
          episodeNumber:
            c.episodeNumber ?? episodes.find((e) => e.id === c.episodeId)?.episodeNumber ?? undefined,
        })),
    [clips, programs, episodes, progFilter],
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

  function openPublish(clip: Clip, channel?: DistributionChannel) {
    if (!role.publish) {
      toast({ title: "배포 권한이 없습니다", description: "CP·PD 만 배포할 수 있습니다.", tone: "error" });
      return;
    }
    setPublishTarget({ clipIds: [clip.id], platform: channel });
  }

  return (
    <>
      <Header title="편집본" subtitle="외부 편집 완성 영상 업로드 → 다중 채널 배포" />

      {/* Edits Main Content Area */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
        <div className="space-y-4 flex-1 flex flex-col">
          {/* Action Bar & Program Selector */}
          <div className="flex items-center justify-between gap-3 text-xs shrink-0">
            <p className="text-xs text-[var(--color-text-muted)]">
              외부에서 편집한 완성 영상을 올려 <span className="font-bold text-[var(--color-text-primary)]">여러 채널에 한 번에</span> 배포합니다. 미디어(분석 파생)와는 별개입니다.
            </p>

            <div className="flex items-center gap-3">
              {/* Program Selector (Equal Height h-10, No Border, Soft Shadow) */}
              <div className="w-44">
                <CustomSelect
                  options={programOptions}
                  value={progFilter}
                  onChange={(val) => setProgFilter(val)}
                  ariaLabel="프로그램 필터"
                  triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs font-bold border-none rounded-full shadow-md shadow-slate-900/5 dark:shadow-none"
                />
              </div>

              {/* Light Gray Vertical Divider */}
              <div className="h-4 w-[1px] bg-slate-300 dark:bg-slate-700/80 shrink-0 self-center" />

              {/* Upload Button (Equal Height h-10, No Border, Soft Shadow) */}
              <UploadClipButton
                className="flex items-center justify-center gap-1.5 h-10 px-4 rounded-full bg-[var(--color-bg-active)] text-white font-semibold text-xs hover:bg-[#0D1EB8] transition-colors border-none shadow-md shadow-slate-900/5 dark:shadow-none cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                label={
                  <>
                    <Upload className="w-3.5 h-3.5" />
                    <span>완성 영상 업로드</span>
                  </>
                }
              />
            </div>
          </div>

          {/* Content Display Container */}
          {rows.length > 0 ? (
            <DistributionMatrix rows={rows} onPublish={openPublish} onRetry={retry} />
          ) : (
            /* Striped Empty State Banner (No Border, Soft Shadow) */
            <div className="w-full flex-1 rounded-xl bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none flex flex-col items-center justify-center p-8 text-center min-h-[300px] leading-relaxed">
              <p className="text-xs text-[var(--color-text-muted)] font-medium">
                {loading ? (
                  "불러오는 중…"
                ) : (
                  <>
                    편집본이 없습니다.
                    <br />
                    오른쪽 위 <span className="font-bold text-[var(--color-text-primary)]">&quot;완성 영상 업로드&quot;</span>로 올리면 여기서 다중 채널로 배포합니다.
                  </>
                )}
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
    </>
  );
}

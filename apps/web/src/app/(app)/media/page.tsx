"use client";

/**
 * 미디어 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/media/page.tsx` 402줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * ## ⚠️ 이 화면은 목업에 **목적물이 통째로 빠져 있다**
 * 원본의 `편집`·`프리미어`·`삭제`·`배포` 버튼에는 **onClick 이 아예 없다.** 목업이라 그렇다.
 * 그대로 옮기면 미디어 화면이 아무 일도 못 하는 목록이 된다. 전부 다시 붙였다:
 *
 * | 원본 | 이식본 |
 * |---|---|
 * | `배포 (N건)` 핸들러 없음 | `PublishDialog` — 채널·예약 선택 (여기서 바로 안 보낸다) |
 * | 행 클릭 불가 | 썸네일·제목 → `ClipDetail`(렌더 영상 + 채널별 메타 편집) |
 * | 삭제 핸들러 없음 | `window.confirm` → `deleteClip` → 토스트 → 목록 갱신 |
 * | `프리미어` 핸들러 없음 | `openInPremiere({clipId, episodeId, programId, label})` |
 * | `href="/editor/c_71f78147"` 하드코딩 | `` `/editor/${clip.id}` `` |
 * | 목 프로그램 5개 고정 | 실제 프로그램 목록 |
 *
 * ⚠️ **`premiere-session.test.ts` 가 이 파일 원문을 스캔한다** — `openInPremiere({` 뒤
 * 400자 안에 `programId,` 가 있어야 한다. 없으면 패널이 마지막에 보던 **남의 프로그램**
 * 추천을 띄운다(편집자에겐 "프리미어는 떴는데 아무것도 없다" 로 보인다).
 *
 * ## 원본에 없어서 지킨 것
 *  - **`role.publish` 권한 게이트** — CP·PD 만 배포. 없으면 토스트.
 *  - **편집본(`directUpload`) 제외** — 외부 완성본은 미디어가 아니다(/edits 담당).
 *  - **프로그램 필터를 id 조인으로** — 원본은 이름 문자열 비교다.
 *  - **`programId` 를 프로그램 표시와 같은 조인으로 산출** — 다르면 프리미어가 남의 추천을 연다.
 *  - **썸네일 폴백**(생성 썸네일 없으면 원본 프레임) — 원본은 이미지가 늘 있다고 가정한다.
 *
 * ## 상태 배지는 **한 개만** 그린다
 * 우리는 최대 4종(렌더 중·배포됨·업로드 중·배포 실패·기록됨)을 다는데 원본 슬롯은
 * `w-24` 한 칸이다. 폭을 넓히는 건 className 수정이라 보존 원칙 위반이라,
 * **우선순위로 하나만 그리고 나머지는 `title` 로 hover 노출**한다(속성 추가는 규칙 밖).
 * ⚠️ 원본 배지 타입은 초록·파랑·앰버 3종뿐이라 **배포 실패도 앰버**로 나간다 —
 * 빨강을 새로 만들면 클래스 추가가 된다. 심각도 구분이 필요하면 그때 결정할 것.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, FolderOpen, Loader2, Trash2 } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { ClipDetail } from "@/components/media/clip-detail";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { deleteClip, openInPremiere } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { clipThumbSrc } from "@/lib/media-url";
import { roleOf } from "@/lib/roles";
import type { Clip } from "@/lib/types";
import { fmtTime } from "@/lib/utils";

const ITEMS_PER_PAGE = 25;

export default function MediaPage() {
  const { clips, episodes, programs, loading, refresh } = useAppData();
  const { toast } = useToast();
  const session = useSession();
  const role = roleOf(session.user.role);

  const [selectedTab, setSelectedTab] = useState<"all" | "short" | "clip">("all");
  const [progFilter, setProgFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);

  const filteredList = useMemo(() => {
    return clips.filter((c) => {
      // 편집본(외부 업로드 완성본)은 미디어가 아니다 — 전용 탭(/edits)에서 다룬다.
      if (c.directUpload) return false;
      const isShort = c.aspectRatio?.startsWith("9:16");
      if (selectedTab === "short" && !isShort) return false;
      if (selectedTab === "clip" && isShort) return false;
      if (progFilter) {
        // 이름이 아니라 **id 조인**이다. 같은 이름의 프로그램이 둘이면 이름 비교는 섞인다.
        const pid = episodes.find((e) => e.id === c.episodeId)?.programId ?? c.programId;
        if (pid !== progFilter) return false;
      }
      return true;
    });
  }, [clips, selectedTab, progFilter, episodes]);

  const totalPages = Math.max(1, Math.ceil(filteredList.length / ITEMS_PER_PAGE));
  const page = Math.min(currentPage, totalPages);
  const paginatedList = filteredList.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const isAllSelected = paginatedList.length > 0 && paginatedList.every((c) => selectedIds.includes(c.id));

  const toggleSelectItem = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleSelectAll = () =>
    setSelectedIds((prev) =>
      isAllSelected ? prev.filter((id) => !paginatedList.some((c) => c.id === id))
        : [...new Set([...prev, ...paginatedList.map((c) => c.id)])]);

  /**
   * 배포 모달을 연다. 여기서 바로 보내지 않는 이유: 채널마다 규칙이 다르고,
   * 어느 채널로 보낼지와 예약 여부를 고르는 게 배포의 절반이다.
   */
  function openPublish() {
    if (!role.publish) {
      toast({ title: "배포 권한이 없습니다", description: "CP·PD 만 배포할 수 있습니다.", tone: "error" });
      return;
    }
    if (selectedIds.length === 0) return;
    setPublishTarget(selectedIds);
  }

  /** 미디어 삭제 — 파괴적이라 확인을 받는다. 원본은 확인 없이 버튼만 있었다. */
  async function handleDelete(clip: Clip) {
    if (!window.confirm(`"${clip.title || "이 미디어"}" 를 삭제할까요?\n이미 채널에 올라간 영상은 내려가지 않습니다.`)) return;
    try {
      const r = await deleteClip(clip.id);
      toast({ title: "삭제했습니다", description: r.notice, tone: "done" });
      setSelectedIds((prev) => prev.filter((x) => x !== clip.id));
      await refresh();
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  const programOptions = [
    { value: "", label: "전체 프로그램" },
    ...programs.map((p) => ({ value: p.id, label: p.title })),
  ];

  return (
    <>
      {/* Header */}
      <Header title="미디어" subtitle="숏폼·클립" />

      {/* Media Main Content - Standard scroll container so Footer never collides */}
      <main className="flex-1 p-6 overflow-y-auto space-y-6 pb-24">
        <div className="space-y-4">
          {/* Top Filter Bar */}
          <div className="flex items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex items-center gap-2">
              {/* Category Filter Pills */}
              <div className="h-10 bg-white dark:bg-[var(--color-bg-card)] p-1 rounded-full shadow-none flex items-center gap-1 text-[11px] border-none select-none">
                {([["all", "전체"], ["short", "숏폼"], ["clip", "클립"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => { setSelectedTab(k); setCurrentPage(1); }}
                    className={`h-8 px-3.5 rounded-full transition-colors cursor-pointer flex items-center justify-center ${
                      selectedTab === k
                        ? "bg-[var(--color-bg-active)] text-white font-bold shadow-md shadow-[var(--color-bg-active)]/25 dark:shadow-none"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Program Selector with CustomSelect */}
              <div className="w-44">
                <CustomSelect
                  ariaLabel="프로그램"
                  options={programOptions}
                  value={progFilter}
                  onChange={(v) => { setProgFilter(v); setCurrentPage(1); }}
                  className="text-xs"
                  triggerClassName="h-10 bg-[var(--color-bg-card)] text-[var(--color-text-primary)] text-xs font-bold border-none rounded-full shadow-md shadow-slate-900/5 dark:shadow-none"
                />
              </div>
            </div>

            {/* Total Count & Page Info */}
            <div className="text-[12px] font-bold text-[var(--color-text-muted)] flex items-center gap-2">
              <span>총 {filteredList.length}건</span>
              {totalPages > 1 && (
                <span className="text-[11px] font-normal text-[var(--color-text-muted)]">
                  ({page}/{totalPages} 페이지)
                </span>
              )}
            </div>
          </div>

          {/* Media Items Table Container */}
          <div className="bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none rounded-2xl overflow-hidden flex flex-col">
            {/* Item Top Header Row */}
            <div className="flex items-center justify-between px-4 py-3 bg-[var(--color-bg-input)]/70 border-b border-[var(--color-border-subtle)] text-[11px] font-semibold text-[var(--color-text-muted)] select-none shrink-0">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleSelectAll}
                  disabled={filteredList.length === 0}
                  aria-label="모두 선택"
                  className="w-4 h-4 rounded border-slate-200 dark:border-slate-800 bg-[var(--color-bg-input)] cursor-pointer accent-[var(--color-bg-active)]"
                />
                <span>미디어 정보</span>
              </div>
              <div className="flex items-center gap-4 shrink-0 pr-2">
                <span className="w-24 text-center">상태</span>
                <span className="w-56 text-center">작업</span>
              </div>
            </div>

            {/* Media List Rows OR Empty State */}
            {filteredList.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center text-xs text-[var(--color-text-muted)] space-y-2">
                <div className="w-12 h-12 rounded-full bg-[var(--color-bg-input)] flex items-center justify-center text-xl text-[var(--color-text-muted)] mb-1">
                  <FolderOpen className="w-6 h-6 text-[var(--color-text-muted)]" />
                </div>
                <p className="font-bold text-[var(--color-text-primary)] text-sm">
                  {loading ? "불러오는 중…" : "조건에 맞는 미디어가 없습니다"}
                </p>
                <p className="text-[11px]">
                  상단의 탭이나 프로그램 선택 드롭다운 필터를 변경해 보세요.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border-subtle)]/40">
                {paginatedList.map((item) => (
                  <MediaRow
                    key={item.id}
                    clip={item}
                    isSelected={selectedIds.includes(item.id)}
                    onToggle={() => toggleSelectItem(item.id)}
                    onOpen={() => setDetailId(item.id)}
                    onDelete={() => { void handleDelete(item); }}
                    programTitle={
                      programs.find((p) => p.id === episodes.find((e) => e.id === item.episodeId)?.programId)?.title
                      // 직접 업로드 클립은 회차가 없어 조인이 비므로 클립에 박아둔 값으로 폴백.
                      ?? programs.find((p) => p.id === item.programId)?.title
                      ?? item.programTitle
                      ?? ""
                    }
                    episodeNumber={episodes.find((e) => e.id === item.episodeId)?.episodeNumber}
                    // programTitle 과 **같은 조인**으로 낸다 — 프리미어 패널이 이 값으로 추천을
                    // 불러오므로, 화면에 보이는 프로그램과 다른 값이 가면 목록이 빈 채로 열린다.
                    programId={episodes.find((e) => e.id === item.episodeId)?.programId ?? item.programId}
                  />
                ))}
              </div>
            )}

            {/* Pagination Controls Bar (25 Items Per Page) */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3.5 bg-[var(--color-bg-card)] border-t border-[var(--color-border-subtle)]/60 text-xs select-none">
                <div className="text-[11px] text-[var(--color-text-muted)] font-medium">
                  {(page - 1) * ITEMS_PER_PAGE + 1} - {Math.min(page * ITEMS_PER_PAGE, filteredList.length)} / 총 {filteredList.length}건
                </div>
                <div className="flex items-center gap-1.5">
                  {/* Previous Page Button */}
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                    disabled={page === 1}
                    className="h-8 px-3 rounded-full border-none shadow-none bg-transparent hover:bg-[var(--color-bg-card-hover)] text-slate-700 dark:text-slate-300 text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>이전</span>
                  </button>

                  {/* Page Numbers */}
                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        className={`h-8 w-8 rounded-full text-xs transition-all cursor-pointer flex items-center justify-center border-none shadow-none ${
                          page === pageNum
                            ? "bg-[var(--color-bg-active)] text-white font-bold"
                            : "bg-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
                        }`}
                      >
                        {pageNum}
                      </button>
                    ))}
                  </div>

                  {/* Next Page Button */}
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                    disabled={page === totalPages}
                    className="h-8 px-3 rounded-full border-none shadow-none bg-transparent hover:bg-[var(--color-bg-card-hover)] text-slate-700 dark:text-slate-300 text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1"
                  >
                    <span>다음</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer - Positioned naturally at bottom of scrollable container */}
        <Footer />
      </main>

      {/* Bottom Floating Selection Action Bar */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-0 left-64 right-0 h-14 bg-[var(--color-bg-card)] border-t border-[var(--color-border-card)] px-6 flex items-center justify-between z-30 shadow-2xl animate-in slide-in-from-bottom-2 duration-150">
          <div className="text-xs font-bold text-[var(--color-text-primary)]">
            {selectedIds.length}건 선택됨
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIds([])}
              className="px-4 py-1.5 rounded-full bg-[var(--color-bg-input)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)] text-xs font-medium border border-[var(--color-border-subtle)] transition-colors cursor-pointer"
            >
              선택 해제
            </button>

            <button
              onClick={openPublish}
              className="px-4 py-1.5 rounded-full bg-[var(--color-bg-active)] text-white hover:bg-[var(--color-blue-700)] text-xs font-bold transition-colors shadow-sm cursor-pointer"
            >
              배포 ({selectedIds.length}건)
            </button>
          </div>
        </div>
      )}

      {detailId && (() => {
        const c = clips.find((x) => x.id === detailId);
        if (!c) return null;
        return (
          <ClipDetail
            clip={c as never}
            programTitle={
              programs.find((p) => p.id === episodes.find((e) => e.id === c.episodeId)?.programId)?.title
            }
            onClose={() => setDetailId(null)}
            onPublish={role.publish ? () => { setDetailId(null); setPublishTarget([c.id]); } : undefined}
          />
        );
      })()}

      {publishTarget && (
        <PublishDialog
          clipIds={publishTarget}
          onClose={() => setPublishTarget(null)}
          onDone={async () => { setSelectedIds([]); }}
        />
      )}
    </>
  );
}

/**
 * 상태 배지 — 원본 슬롯은 `w-24` **한 칸**이고 타입도 초록·파랑·앰버 3종뿐이다.
 * 우리는 최대 4종을 다는데, 폭을 넓히는 건 className 수정이라 **우선순위로 하나만** 그리고
 * 나머지는 `title` 로 hover 에 남긴다.
 *
 * 순서는 **사람이 손봐야 하는 것부터**다: 실패 → 렌더 중 → 업로드 중 → 배포됨 → 렌더 전 → 기록됨.
 */
function statusOf(clip: Clip): { label: string; type: "deployed" | "uploading" | "other"; all: string } | null {
  const dists = clip.distributions ?? [];
  const published = dists.filter((d) => d.status === "published").length;
  const recorded = dists.filter((d) => d.status === "recorded").length;
  const uploading = dists.filter((d) => d.status === "pending" || d.status === "scheduled").length;
  const failed = dists.filter((d) => d.status === "failed").length;
  const rendering = clip.status === "encoding";

  const parts: string[] = [];
  if (failed) parts.push(`배포 실패 ${failed}`);
  if (rendering) parts.push("렌더 중");
  if (uploading) parts.push(`업로드 중 ${uploading}`);
  if (published) parts.push(`배포됨 ${published}`);
  if (!rendering && !clip.rendered) parts.push("렌더 전");
  // `기록됨` 은 게시가 아니다 — 배포됨과 같은 톤으로 그리면 안 된다(중립 앰버로).
  if (recorded) parts.push(`기록됨 ${recorded}`);
  if (parts.length === 0) return null;

  const all = parts.join(" · ");
  if (failed) return { label: `배포 실패 ${failed}`, type: "other", all };
  if (rendering) return { label: "렌더 중", type: "other", all };
  if (uploading) return { label: `업로드 중 ${uploading}`, type: "uploading", all };
  if (published) return { label: `배포됨 ${published}`, type: "deployed", all };
  if (!clip.rendered) return { label: "렌더 전", type: "other", all };
  return { label: `기록됨 ${recorded}`, type: "other", all };
}

function MediaRow({
  clip, isSelected, onToggle, onOpen, onDelete, programTitle, programId, episodeNumber,
}: {
  clip: Clip;
  isSelected: boolean;
  onToggle: () => void;
  /** 행을 열어 상세(렌더 영상 + 메타데이터)를 본다. */
  onOpen: () => void;
  /** 미디어 삭제 (확인은 상위에서 받는다). */
  onDelete: () => void;
  programTitle: string;
  /** 프리미어 핸드오프에 실어 보낼 프로그램 id — 회차→프로그램 해석은 상위가 한다. */
  programId?: string;
  episodeNumber?: number;
}) {
  // 프리미어 보내기 결과를 이 행에서 바로 알린다 — 상위로 콜백을 뚫는 대신 훅을 쓴다.
  const { toast } = useToast();
  const thumb = clipThumbSrc(clip);
  const isShort = clip.aspectRatio?.startsWith("9:16");
  const st = statusOf(clip);

  return (
    <div
      className={`flex items-center justify-between px-4 py-3 transition-colors text-xs group ${
        isSelected
          ? "bg-[var(--color-bg-accent-subtle)]/40"
          : "hover:bg-[var(--color-bg-card-hover)]"
      }`}
    >
      {/* Left: Checkbox + Thumbnail + Title & Metadata */}
      <div className="flex items-center gap-3.5 min-w-0 flex-1 text-left">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          aria-label="선택"
          className="w-4 h-4 rounded border-slate-200 dark:border-slate-800 bg-[var(--color-bg-input)] cursor-pointer shrink-0 accent-[var(--color-bg-active)]"
        />

        {/* Thumbnail — 누르면 상세가 열린다(원본은 클릭 불가라 상세 진입점이 없었다) */}
        <button
          type="button"
          onClick={onOpen}
          aria-label="상세 보기"
          className="w-16 h-10 rounded-lg bg-slate-900 shrink-0 overflow-hidden relative border border-[var(--color-border-subtle)]"
        >
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- 내부 미디어 프레임, next/image 불필요
            <img src={thumb} alt={clip.title} loading="lazy" className="w-full h-full object-cover" />
          ) : null}
        </button>

        {/* Title & Metadata */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <button
            type="button"
            onClick={onOpen}
            className="block w-full text-left font-bold text-[var(--color-text-primary)] text-xs truncate group-hover:text-[var(--color-text-accent)] transition-colors"
          >
            {clip.title}
          </button>
          <div className="text-[10.5px] text-[var(--color-text-muted)] flex items-center gap-1.5 font-normal">
            <span className="font-medium text-[var(--color-text-secondary)]">{programTitle}</span>
            <span>·</span>
            <span>{episodeNumber != null ? `회차 ${episodeNumber}` : "-"}</span>
            <span>·</span>
            <span>{fmtTime(clip.durationSec)}</span>
            <span>·</span>
            <span>{isShort ? "9:16" : "16:9"}</span>
          </div>
        </div>
      </div>

      {/* Right: Status Badge & Action Buttons */}
      <div className="flex items-center gap-4 shrink-0 ml-4">
        <div className="w-24 flex justify-center text-center">
          {st ? (
            <span
              title={st.all}
              className={`h-6 px-3 rounded-full text-[11px] font-bold inline-flex items-center justify-center gap-1.5 border-none ${
                st.type === "deployed"
                  ? "bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400"
                  : st.type === "uploading"
                  ? "bg-[#EFF6FF] text-[#2563EB] dark:bg-blue-500/20 dark:text-blue-400"
                  : "bg-[#FFFBEB] text-[#D97706] dark:bg-amber-500/20 dark:text-amber-400"
              }`}
            >
              {st.type === "deployed" ? (
                <CheckCircle2 className="w-3 h-3 shrink-0" />
              ) : st.type === "uploading" ? (
                <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
              ) : (
                <CircleDashed className="w-3 h-3 shrink-0" />
              )}
              <span>{st.label}</span>
            </span>
          ) : null}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-center gap-1.5 w-56">
          <Link
            href={`/editor/${clip.id}`}
            className="h-7 px-3.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-[11px] font-bold transition-colors cursor-pointer inline-flex items-center justify-center"
          >
            편집
          </Link>
          {/* 프리미어로 넘기기 — 맥락을 서버에 남기고 stepd:// 로 앱을 띄운다.
              패널이 5초 폴링으로 집어가므로, 프리미어가 이미 떠 있으면 스킴 등록 없이도 된다. */}
          <button
            title="프리미어를 열고 이 회차의 추천 구간을 패널에 띄웁니다"
            className="h-7 px-3.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] text-[11px] font-bold transition-colors cursor-pointer inline-flex items-center justify-center"
            onClick={() => {
              void (async () => {
                try {
                  const r = await openInPremiere({
                    clipId: clip.id,
                    episodeId: clip.episodeId,
                    // ⚠️ programId 를 **반드시** 같이 보낸다. 패널은 추천을 프로그램 기준으로
                    // 불러오는데(loadRecs), 이게 없으면 패널이 마지막에 보던 프로그램을 그대로
                    // 쓴다 — 그게 다른 프로그램이면 이 회차의 추천이 목록에 아예 없고,
                    // 편집자에겐 "프리미어는 떴는데 아무것도 없다" 로 보인다.
                    programId,
                    label: clip.title,
                  });
                  // 프리미어가 안 뜬 것으로 보이면 **무엇을 해야 하는지**까지 말한다.
                  // 맥락은 이미 서버에 남았으므로 직접 켜도 패널이 따라간다 — 그걸 알려 준다.
                  if (r.launched) {
                    toast({ title: "프리미어로 보냈습니다", description: "패널이 이 회차의 추천 구간을 띄웁니다.", tone: "done" });
                  } else {
                    toast({
                      title: "프리미어가 열리지 않았습니다",
                      description: "Premiere Pro 25.6 이상이 설치돼 있는지 확인하세요. 설치돼 있는데도 안 열리면 이 PC 에 STEP-D 연결 등록이 필요합니다 — 프리미어를 직접 켜도 패널이 이 회차로 따라갑니다.",
                      tone: "error",
                    });
                  }
                } catch (err) {
                  toast({ title: "프리미어로 보내지 못했습니다", description: err instanceof Error ? err.message : String(err), tone: "error" });
                }
              })();
            }}
          >
            프리미어
          </button>
          <button
            title="삭제"
            onClick={onDelete}
            className="h-7 w-7 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 transition-colors cursor-pointer border border-rose-500/20 inline-flex items-center justify-center shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

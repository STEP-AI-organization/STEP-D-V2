"use client";

/**
 * U6 · 미디어 (README §5).
 *
 * 채택(＋)한 것만 여기 올라온다 — 추천 구간은 미디어가 아니다.
 * 배포 버튼은 선택한 건을 전부 배포 모달로 넘긴다 (권리 판정 UI 는 2026-08-12 제거 —
 * 데이터로 판정할 방법이 없어 화면에서 걷어냈다. 서버 계약은 api.ts 에 남아 있다).
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { PublishDialog } from "@/components/publish/publish-dialog";
import { UploadClipButton } from "@/components/upload-clip-dialog";
import { ClipDetail } from "@/components/media/clip-detail";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { roleOf } from "@/lib/roles";
import { useAppData } from "@/lib/data/store";
import { clipThumbSrc } from "@/lib/media-url";
import type { Clip } from "@/lib/types";
import { cn, fmtTime } from "@/lib/utils";

type KindFilter = "all" | "short" | "clip";

export default function MediaPage() {
  return <MediaView />;
}

function MediaView() {
  const { clips, episodes, programs, loading } = useAppData();
  const { toast } = useToast();
  const session = useSession();
  const role = roleOf(session.user.role);

  const [kind, setKind] = useState<KindFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 클릭한 행 — AENA 처럼 목록은 한 줄, 상세는 큰 영상 + 메타데이터.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);

  const rows = useMemo(() => {
    return clips.filter((c) => {
      const isShort = c.aspectRatio?.startsWith("9:16");
      if (kind === "short" && !isShort) return false;
      if (kind === "clip" && isShort) return false;
      return true;
    });
  }, [clips, kind]);

  const selectedRows = rows.filter((c) => selected.has(c.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * 배포 모달을 연다. 여기서 바로 보내지 않는 이유: 채널마다 규칙이 다르고(F4-2),
   * 어느 채널로 보낼지와 예약 여부를 고르는 게 배포의 절반이다.
   */
  function openPublish() {
    if (!role.publish) {
      toast({ title: "배포 권한이 없습니다", description: "CP·PD 만 배포할 수 있습니다.", tone: "error" });
      return;
    }
    if (selectedRows.length === 0) return;
    setPublishTarget(selectedRows.map((c) => c.id));
  }

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px] pb-24">
      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-[9px]">
        <div className="flex gap-[3px]">
          {([["all", "전체"], ["short", "숏폼"], ["clip", "클립"]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={cn("sd-btn", kind === k && "sd-btn--on")}
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
          {rows.length}건
        </span>
        {/* 우리 파이프라인 밖에서 만든 완성 영상을 직접 올려 배포한다 — 분석 없이 바로 클립. */}
        <UploadClipButton className="sd-btn sd-btn-primary" label="완성 영상 업로드" />
      </div>

      {/* 목록 */}
      {rows.length === 0 ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {loading
            ? "불러오는 중…"
            : clips.length === 0
              ? "미디어가 없습니다 — 영상 분석에서 추천 구간을 채택(＋)하면 여기 올라옵니다"
              : "조건에 맞는 미디어가 없습니다"}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((c) => (
            <MediaRow
              key={c.id}
              clip={c}
              checked={selected.has(c.id)}
              onToggle={() => toggle(c.id)}
              onOpen={() => setDetailId(c.id)}
              programTitle={
                programs.find((p) => p.id === episodes.find((e) => e.id === c.episodeId)?.programId)?.title
                // 직접 업로드 클립은 회차가 없어 회차→프로그램 조인이 비므로 클립에 박아둔 값으로 폴백.
                ?? programs.find((p) => p.id === c.programId)?.title
                ?? c.programTitle
                ?? ""
              }
              episodeNumber={episodes.find((e) => e.id === c.episodeId)?.episodeNumber}
            />
          ))}
        </div>
      )}

      {/* 하단 액션 바 — 선택이 있을 때만 */}
      {selectedRows.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-3 px-5 py-3"
          style={{ background: "#fff", borderTop: "1px solid var(--sd-border)", paddingLeft: 226 }}
        >
          <span className="text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
            {selectedRows.length}건 선택
          </span>
          <button type="button" className="sd-btn ml-auto" onClick={() => setSelected(new Set())}>
            선택 해제
          </button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={selectedRows.length === 0}
            onClick={openPublish}
          >
            배포 ({selectedRows.length}건)
          </button>
        </div>
      )}

      {detailId && (() => {
        const c = clips.find((x) => x.id === detailId);
        if (!c) return null;
        return (
          <ClipDetail
            clip={c as any}
            programTitle={
              programs.find((p) => p.id === episodes.find((e) => e.id === c.episodeId)?.programId)?.title
            }
            onClose={() => setDetailId(null)}
          />
        );
      })()}

      {publishTarget && (
        <PublishDialog
          clipIds={publishTarget}
          onClose={() => setPublishTarget(null)}
          onDone={async () => { setSelected(new Set()); }}
        />
      )}
    </div>
  );
}

function MediaRow({
  clip,
  checked,
  onToggle,
  onOpen,
  programTitle,
  episodeNumber,
}: {
  clip: Clip;
  checked: boolean;
  onToggle: () => void;
  /** 행을 열어 상세(렌더 영상 + 메타데이터)를 본다. */
  onOpen: () => void;
  programTitle: string;
  episodeNumber?: number;
}) {
  const thumb = clipThumbSrc(clip);
  const isShort = clip.aspectRatio?.startsWith("9:16");

  return (
    <div className="sd-card flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label="선택" />

        {/* 썸네일·제목을 누르면 상세가 열린다. 체크박스·우측 버튼은 각자 동작을 유지한다. */}
        <button
          type="button"
          onClick={onOpen}
          className="sd-ph h-[44px] w-[78px] shrink-0 overflow-hidden rounded-[3px] text-left"
          aria-label="상세 보기"
        >
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <span className="text-[9px]">썸네일</span>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            className="block w-full truncate text-left text-[12.5px] font-medium hover:underline"
            style={{ color: "var(--sd-fg)" }}
          >
            {clip.title}
          </button>
          <div className="sd-mono truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
            {programTitle}
            {episodeNumber != null ? ` · 회차 ${episodeNumber}` : ""} · {fmtTime(clip.durationSec)} ·{" "}
            {isShort ? "9:16" : "16:9"}
            {clip.rendered ? "" : " · 렌더 전"}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          {/* 직접 업로드 완성본은 트림·리프레임 대상이 아니다 — 편집기를 열어 봐야 할 게 없다. */}
          {clip.directUpload ? (
            <span
              className="sd-mono self-center rounded-[3px] px-1.5 py-0.5 text-[9.5px]"
              style={{ background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
            >
              직접 업로드
            </span>
          ) : (
            <Link href={`/editor/${clip.id}`} className="sd-btn">편집</Link>
          )}
        </div>
      </div>
    </div>
  );
}

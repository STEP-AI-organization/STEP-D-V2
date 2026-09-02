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
import { ClipDetail } from "@/components/media/clip-detail";
import { deleteClip, openInPremiere } from "@/lib/data/api";
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
  const { clips, episodes, programs, loading, refresh } = useAppData();
  const { toast } = useToast();
  const session = useSession();
  const role = roleOf(session.user.role);

  const [kind, setKind] = useState<KindFilter>("all");
  const [progFilter, setProgFilter] = useState<string>(""); // "" = 전체 프로그램
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 클릭한 행 — AENA 처럼 목록은 한 줄, 상세는 큰 영상 + 메타데이터.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);

  const rows = useMemo(() => {
    return clips.filter((c) => {
      // 편집본(외부 업로드 완성본)은 미디어가 아니다 — 전용 탭(/edits)에서 다룬다.
      if (c.directUpload) return false;
      const isShort = c.aspectRatio?.startsWith("9:16");
      if (kind === "short" && !isShort) return false;
      if (kind === "clip" && isShort) return false;
      if (progFilter) {
        const pid = episodes.find((e) => e.id === c.episodeId)?.programId ?? c.programId;
        if (pid !== progFilter) return false;
      }
      return true;
    });
  }, [clips, kind, progFilter, episodes]);

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

  /** 미디어 삭제 — 확인 후 서버 삭제 + 목록 갱신. 파괴적이라 확인을 받는다. */
  async function handleDelete(clip: Clip) {
    if (!window.confirm(`"${clip.title || "이 미디어"}" 를 삭제할까요?\n이미 채널에 올라간 영상은 내려가지 않습니다.`)) return;
    try {
      const r = await deleteClip(clip.id);
      toast({ title: "삭제했습니다", description: r.notice, tone: "done" });
      setSelected((prev) => { const n = new Set(prev); n.delete(clip.id); return n; });
      await refresh();
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
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
          {rows.length}건
        </span>
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
              onDelete={() => handleDelete(c)}
              programTitle={
                programs.find((p) => p.id === episodes.find((e) => e.id === c.episodeId)?.programId)?.title
                // 직접 업로드 클립은 회차가 없어 회차→프로그램 조인이 비므로 클립에 박아둔 값으로 폴백.
                ?? programs.find((p) => p.id === c.programId)?.title
                ?? c.programTitle
                ?? ""
              }
              episodeNumber={episodes.find((e) => e.id === c.episodeId)?.episodeNumber}
              // programTitle 과 **같은 조인**으로 낸다 — 프리미어 패널이 이 값으로 추천을
              // 불러오므로, 화면에 보이는 프로그램과 다른 값이 가면 목록이 빈 채로 열린다.
              programId={episodes.find((e) => e.id === c.episodeId)?.programId ?? c.programId}
            />
          ))}
        </div>
      )}

      {/* 하단 액션 바 — 선택이 있을 때만 */}
      {selectedRows.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-3 px-5 py-3"
          style={{ background: "var(--sd-card)", borderTop: "1px solid var(--sd-border)", paddingLeft: 226 }}
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
            onPublish={role.publish ? () => { setDetailId(null); setPublishTarget([c.id]); } : undefined}
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
  onDelete,
  programTitle,
  programId,
  episodeNumber,
}: {
  clip: Clip;
  checked: boolean;
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
  // 상태 가시성 (사용자 2026-08-19: "렌더 중인지·배포됐는지 미디어에서 알 수가 없다").
  // status="encoding" = 렌더 중 · distributions 로 배포/업로드중/실패/기록을 센다.
  const rendering = clip.status === "encoding";
  const dists = clip.distributions ?? [];
  const publishedN = dists.filter((d) => d.status === "published").length;
  const recordedN = dists.filter((d) => d.status === "recorded").length;
  const uploadingN = dists.filter((d) => d.status === "pending" || d.status === "scheduled").length;
  const failedN = dists.filter((d) => d.status === "failed").length;

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
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {/* 상태 배지 — 렌더 중·렌더 전·배포됨·업로드중·실패·기록됨. "상태가 UI에 닿게". */}
          {rendering ? (
            <span className="sd-tag sd-tag--upcoming">● 렌더 중…</span>
          ) : !clip.rendered ? (
            <span className="sd-tag">렌더 전</span>
          ) : null}
          {publishedN > 0 && <span className="sd-tag sd-tag--airing">배포됨 {publishedN}</span>}
          {uploadingN > 0 && <span className="sd-tag sd-tag--upcoming">업로드 중 {uploadingN}</span>}
          {failedN > 0 && <span className="sd-tag sd-tag--danger">배포 실패 {failedN}</span>}
          {recordedN > 0 && <span className="sd-tag">기록됨 {recordedN}</span>}
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
          {/* 프리미어로 넘기기 — 맥락을 서버에 남기고 stepd:// 로 앱을 띄운다.
              패널이 5초 폴링으로 집어가므로, 프리미어가 이미 떠 있으면 스킴 등록 없이도 된다. */}
          <button
            type="button"
            className="sd-btn"
            title="프리미어를 열고 이 회차의 추천 구간을 패널에 띄웁니다"
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
            type="button"
            className="sd-btn"
            style={{ color: "var(--sd-danger, #dc2626)" }}
            onClick={onDelete}
            title="미디어 삭제"
          >
            삭제
          </button>
        </div>
      </div>
    </div>
  );
}

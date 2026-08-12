"use client";

/**
 * U6 · 미디어 (README §5 · FLOWS F3 강제 지점 ①).
 *
 * 채택(＋)한 것만 여기 올라온다 — 추천 구간은 미디어가 아니다.
 * 이 화면의 배포 버튼이 게이트의 첫 번째 강제 지점이다.
 *
 * 지키는 것:
 *  - 게이트 미통과가 선택에 섞이면 **통과 건만 진행하고 제외 건수를 알린다.**
 *    ⊘ 조용히 제외 금지 · ⊘ 전체 실패 처리 금지 (FLOWS.md:70)
 *  - 판정은 서버가 한다. 화면은 서버가 준 상태를 그리고, 못 읽으면 통과로 그리지 않는다.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { IssuePanel } from "@/components/gate/issue-panel";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { ClipDetail } from "@/components/media/clip-detail";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { roleOf } from "@/lib/roles";
import { fetchGateBatch, type GateResult, type GateState, type RightsIssue } from "@/lib/data/api";
import { useGateSummary } from "@/lib/gate-summary";
import { useAppData } from "@/lib/data/store";
import { GATE_LABEL, GATE_TAG, ISSUE_KIND_LABEL, fmtTime } from "@/lib/gate-ui";
import { clipThumbSrc } from "@/lib/media-url";
import type { Clip } from "@/lib/types";
import { cn } from "@/lib/utils";

type KindFilter = "all" | "short" | "clip";
type GateFilter = "all" | GateState;

const GATE_FILTERS: GateFilter[] = ["all", "pass", "review_pending", "rights_hold", "conditional", "blocked"];

function isGateFilter(v: string | null): v is GateFilter {
  return v != null && (GATE_FILTERS as string[]).includes(v);
}

// useSearchParams 를 쓰므로 Suspense 가 필요하다 (없으면 프리렌더가 깨진다).
export default function MediaPage() {
  return (
    <Suspense
      fallback={
        <div className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center">
          불러오는 중…
        </div>
      }
    >
      <MediaView />
    </Suspense>
  );
}

function MediaView() {
  const { clips, episodes, programs, loading } = useAppData();
  const { toast } = useToast();
  const session = useSession();
  const role = roleOf(session.user.role);

  // 다른 화면이 `/media?gate=rights_hold` 로 보낸다 — 쿼리를 무시하면 링크가 거짓말이 된다.
  const searchParams = useSearchParams();
  const gateParam = searchParams.get("gate");

  const [kind, setKind] = useState<KindFilter>("all");
  const [gateFilter, setGateFilter] = useState<GateFilter>(isGateFilter(gateParam) ? gateParam : "all");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openIssues, setOpenIssues] = useState<string | null>(null);
  // 클릭한 행 — AENA 처럼 목록은 한 줄, 상세는 큰 영상 + 메타데이터.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<string[] | null>(null);

  // 화면이 떠 있는 상태에서 다른 링크로 들어와도 필터가 따라오게 한다.
  useEffect(() => {
    if (isGateFilter(gateParam)) setGateFilter(gateParam);
  }, [gateParam]);

  // 사이드바 배지·대시보드와 **같은 값**을 쓴다. 화면마다 따로 조회하면 같은 요청이
  // 여러 번 나가고, 무엇보다 숫자가 갈린다 — 어느 쪽을 믿어야 할지 모르게 된다.
  const gateSummary = useGateSummary();
  const gates = gateSummary.gates;
  const issues = gateSummary.issues;
  const gateError = gateSummary.error;
  const loadGates = gateSummary.refresh;

  // 게이트 칩의 건수는 **종류 필터를 적용한 뒤** 세야 한다 — 같은 줄 오른쪽 총계와
  // 모집단이 다르면 어느 숫자를 믿어야 할지 모르게 된다.
  const kindRows = useMemo(() => {
    return clips.filter((c) => {
      const isShort = c.aspectRatio?.startsWith("9:16");
      if (kind === "short" && !isShort) return false;
      if (kind === "clip" && isShort) return false;
      return true;
    });
  }, [clips, kind]);

  const rows = useMemo(() => {
    if (gateFilter === "all") return kindRows;
    return kindRows.filter((c) => (gates[c.id]?.state ?? "review_pending") === gateFilter);
  }, [kindRows, gateFilter, gates]);

  const selectedRows = rows.filter((c) => selected.has(c.id));
  const passing = selectedRows.filter((c) => gates[c.id]?.allowed).length;
  const held = selectedRows.length - passing;

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
    // 게이트에 막힌 건은 애초에 모달로 넘기지 않는다 — 서버가 또 거를 거지만,
    // 고를 수 없는 것을 목록에 넣으면 사용자는 뭘 고른 건지 헷갈린다.
    const passing = selectedRows.filter((c) => gates[c.id]?.allowed).map((c) => c.id);
    if (passing.length === 0) return;
    setPublishTarget(passing);
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
        <span className="h-[18px] w-px" style={{ background: "var(--sd-border)" }} aria-hidden />
        <div className="flex flex-wrap gap-[3px]">
          {GATE_FILTERS.map((g) => (
            <button
              key={g}
              type="button"
              className={cn("sd-btn", gateFilter === g && "sd-btn--on")}
              onClick={() => setGateFilter(g)}
            >
              {g === "all" ? "게이트 전체" : GATE_LABEL[g]}
              <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>
                {g === "all"
                  ? kindRows.length
                  : kindRows.filter((c) => (gates[c.id]?.state ?? "review_pending") === g).length}
              </span>
            </button>
          ))}
        </div>
        <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
          {rows.length}건
        </span>
      </div>

      {gateError && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          게이트를 불러오지 못했습니다 ({gateError}) — 통과 여부를 알 수 없어 전부 미통과로 다룹니다.
        </div>
      )}

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
              gate={gates[c.id]}
              issues={issues[c.id] ?? []}
              checked={selected.has(c.id)}
              onToggle={() => toggle(c.id)}
              onOpenIssues={() => setOpenIssues(openIssues === c.id ? null : c.id)}
              issuesOpen={openIssues === c.id}
              onGateChanged={loadGates}
              onOpen={() => setDetailId(c.id)}
              programTitle={
                programs.find((p) => p.id === episodes.find((e) => e.id === c.episodeId)?.programId)?.title ?? ""
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
            {selectedRows.length}건 선택 · <b>게이트 통과 {passing}건</b>
            {held > 0 && (
              <span style={{ color: "var(--sd-danger-strong)" }}> · 미통과 {held}건은 제외됩니다</span>
            )}
          </span>
          <button type="button" className="sd-btn ml-auto" onClick={() => setSelected(new Set())}>
            선택 해제
          </button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={passing === 0}
            title={passing === 0 ? "게이트를 통과한 건이 없습니다" : undefined}
            onClick={openPublish}
          >
            배포 ({passing}건)
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
          onDone={async () => { setSelected(new Set()); await loadGates(); }}
        />
      )}
    </div>
  );
}

function MediaRow({
  clip,
  gate,
  issues,
  checked,
  onToggle,
  onOpenIssues,
  issuesOpen,
  onGateChanged,
  onOpen,
  programTitle,
  episodeNumber,
}: {
  clip: Clip;
  gate?: GateResult;
  issues: RightsIssue[];
  checked: boolean;
  onToggle: () => void;
  onOpenIssues: () => void;
  issuesOpen: boolean;
  onGateChanged: () => void | Promise<void>;
  /** 행을 열어 상세(렌더 영상 + 메타데이터)를 본다. */
  onOpen: () => void;
  programTitle: string;
  episodeNumber?: number;
}) {
  const state: GateState = gate?.state ?? "review_pending";
  const thumb = clipThumbSrc(clip);
  const live = issues.filter((i) => i.resolution !== "resolved");
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

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={GATE_TAG[state]}>{gate ? gate.label : "확인 불가"}</span>
          {live.length > 0 && (
            <span className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)", maxWidth: 220 }}>
              {[...new Set(live.map((i) => ISSUE_KIND_LABEL[i.kind as keyof typeof ISSUE_KIND_LABEL] ?? i.kind))]
                .slice(0, 3)
                .join(", ")}
              {live.length > 3 ? ` 외 ${live.length - 3}` : ""}
            </span>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <button type="button" className="sd-btn" onClick={onOpenIssues}>
            검수 {issuesOpen ? "닫기" : `(${live.length})`}
          </button>
          <Link href={`/editor/${clip.id}`} className="sd-btn">편집</Link>
        </div>
      </div>

      {issuesOpen && (
        <div className="px-3 pb-3">
          <IssuePanel
            subjectType="clip"
            subjectId={clip.id}
            title="이 미디어의 권리·심의"
            hint="채택 시 승계된 이슈가 여기 보입니다. 해제하면 게이트가 열립니다."
            bandDefault={
              clip.startTime != null && clip.endTime != null
                ? { start: clip.startTime, end: clip.endTime }
                : undefined
            }
            onGateChange={() => void onGateChanged()}
          />
        </div>
      )}
    </div>
  );
}

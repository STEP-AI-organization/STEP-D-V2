"use client";

/**
 * 주간 리포트 모달 (README §15).
 *
 * **자동 발송이 없다.** 사람이 열어서 만든다. 그래서 "예약 발송" 같은 걸 두지 않는다 —
 * 없는 기능을 있는 것처럼 보이면 아무도 안 보낸 리포트를 보냈다고 믿게 된다.
 *
 * 수익 섹션은 **역할에 따라 빠진다.** 체크박스를 그냥 비활성으로 두지 않고 왜 못 넣는지
 * 적는다(F9 — 권한 없음과 데이터 없음을 구분).
 */
import { useMemo, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { channelLabel } from "@/lib/constants";
import { useAppData } from "@/lib/data/store";
import { normalizeProgramStatus } from "@/lib/programs";
import { roleOf } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * "채널별" 범위는 없앴다. 집계 코드가 없어 '전사'와 결과가 완전히 같았고, 전사 권한이 없는
 * 역할에게도 열려 있어 범위 제한을 그대로 우회했다.
 */
type Scope = "all" | "mine";

/**
 * 이 화면이 실제로 셀 수 있는 섹션만 남긴다. '권리'는 store 에 집계할 데이터 자체가 없어서
 * 뺐다 — 체크만 되고 요약에 아무것도 안 나오는 칸이었다.
 */
const SECTIONS = [
  { key: "performance", label: "성과", needsRevenue: true },
  { key: "production", label: "생산", needsRevenue: false },
  { key: "channels", label: "채널", needsRevenue: false },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function WeeklyReportDialog({ onClose }: { onClose: () => void }) {
  const { programs, episodes, clips } = useAppData();
  const session = useSession();
  const caps = roleOf(session.user.role);
  const { toast } = useToast();

  const [scope, setScope] = useState<Scope>(caps.scope === "all" ? "all" : "mine");
  const [picked, setPicked] = useState<Set<SectionKey>>(
    new Set(SECTIONS.filter((s) => !s.needsRevenue || caps.revenue).map((s) => s.key)),
  );

  const inScope = useMemo(() => {
    if (scope === "mine") return programs.filter((p) => p.owner === session.user.name);
    return programs;
  }, [programs, scope, session.user.name]);

  const scopeIds = useMemo(() => new Set(inScope.map((p) => p.id)), [inScope]);
  const scopedEpisodes = episodes.filter((e) => scopeIds.has(e.programId));
  const epIds = new Set(scopedEpisodes.map((e) => e.id));
  const scopedClips = clips.filter((c) => epIds.has(c.episodeId));
  const publishedCount = scopedClips.filter((c) =>
    (c.distributions ?? []).some((d) => d.status === "published"),
  ).length;

  // 채널 섹션의 근거. "recorded" 는 게시가 아니므로 세지 않는다(F4 Invariant).
  const channelCounts = new Map<string, number>();
  for (const c of scopedClips) {
    for (const d of c.distributions ?? []) {
      if (d.status === "published") channelCounts.set(d.channel, (channelCounts.get(d.channel) ?? 0) + 1);
    }
  }
  const channelLine = [...channelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ch, n]) => `${channelLabel(ch)} ${n}`)
    .join(" · ");

  function toggle(k: SectionKey) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /** 고른 섹션만 문장으로 만든다 — 체크박스가 결과를 바꾸지 않으면 고르는 의미가 없다. */
  function sectionLines(): string[] {
    const lines: string[] = [];
    if (picked.has("performance") && caps.revenue) {
      lines.push(`성과 — 미디어 ${scopedClips.length}건 중 게시 ${publishedCount}건`);
    }
    if (picked.has("production")) {
      lines.push(`생산 — 회차 ${scopedEpisodes.length} · 미디어 ${scopedClips.length}`);
    }
    if (picked.has("channels")) {
      lines.push(`채널 — ${channelLine || "게시된 채널 없음"}`);
    }
    return lines;
  }

  const lines = sectionLines();

  function generate() {
    // 리포트 산출은 아직 서버에 없다. 있는 척하지 않고, 지금 화면이 아는 숫자만
    // 요약해서 보여준다 — 없는 파일을 "생성했습니다"라고 말하는 게 최악이다.
    if (lines.length === 0) return;
    toast({
      title: `${inScope.length}개 프로그램 요약`,
      description: lines.join(" / "),
      tone: "done",
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden />
      <div
        className="sd-modal relative flex max-h-[88vh] w-full max-w-[480px] flex-col bg-white"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          <h2 className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>주간 리포트</h2>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <div className="mb-1 text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>범위</div>
            <div className="flex flex-wrap gap-[3px]">
              {([["all", "전사"], ["mine", "내 담당"]] as const).map(([k, label]) => {
                // vendor·pd 는 전사 범위를 못 본다(F9 scope).
                const blocked = k === "all" && caps.scope !== "all";
                return (
                  <button
                    key={k}
                    type="button"
                    className={cn("sd-btn", scope === k && "sd-btn--on")}
                    disabled={blocked}
                    title={blocked ? "전사 범위를 볼 권한이 없습니다" : undefined}
                    onClick={() => setScope(k)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>섹션</div>
            <div className="flex flex-col gap-1.5">
              {SECTIONS.map((s) => {
                const blocked = s.needsRevenue && !caps.revenue;
                return (
                  <label
                    key={s.key}
                    className="flex items-start gap-2 text-[11.5px]"
                    style={{ color: blocked ? "var(--sd-mut)" : "var(--sd-fg)" }}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={picked.has(s.key) && !blocked}
                      disabled={blocked}
                      onChange={() => toggle(s.key)}
                    />
                    <span>
                      {s.label}
                      {blocked && (
                        <span style={{ color: "var(--sd-mut)" }}>
                          {" "}— 수익 지표 권한이 없어 이 섹션은 빠집니다
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div
            className="flex flex-col gap-1 rounded-[5px] p-3 text-[11.5px]"
            style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
          >
            <div className="sd-eb" style={{ color: "var(--sd-label)" }}>이번 범위의 숫자</div>
            <span style={{ color: "var(--sd-fg)" }}>
              프로그램 {inScope.length} (방영 중 {inScope.filter((p) => normalizeProgramStatus(p.status) === "airing").length})
              {" · "}회차 {scopedEpisodes.length}
              {" · "}미디어 {scopedClips.length}
              {" · "}게시 {publishedCount}
            </span>
          </div>

          <p className="text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
            <b style={{ color: "var(--sd-fg)" }}>자동 발송은 없습니다.</b> 누를 때만 만들어집니다.
            리포트 <b style={{ color: "var(--sd-fg)" }}>파일 생성·전송은 아직 서버에 없어서</b>, 고른 섹션을
            토스트 요약으로만 보여줍니다.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--sd-border)" }}>
          <button type="button" className="sd-btn" onClick={onClose}>닫기</button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={lines.length === 0}
            title={lines.length === 0 ? "섹션을 하나 이상 고르세요" : undefined}
            onClick={generate}
          >
            요약 만들기
          </button>
        </div>
      </div>
    </div>
  );
}

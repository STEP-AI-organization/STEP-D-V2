"use client";

/**
 * U8 · 배포 (README §7 · FLOWS F4).
 *
 * 무엇이 어디로 언제 나갔는지의 기록. 두 가지를 특히 지킨다:
 *
 *  - **`기록됨`을 `게시됨`처럼 보여주지 않는다** (F4 Invariant). Meta·TikTok 은
 *    파일이 올라가지 않는다 — 색도 문구도 분리한다.
 *  - **실패는 자동 재시도하지 않는다** (F4-4 ⊘). 사람이 이 화면의 버튼을 눌러야 다시 간다.
 *    중복 게시 위험 때문이다.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import { fmtTime } from "@/lib/utils";
import type { Clip, DistributionState } from "@/lib/types";
import type { StatusTone } from "@/lib/constants";
import { cn } from "@/lib/utils";

const DIST_TONE: Record<DistributionState["status"], StatusTone> = {
  none: "idle",
  pending: "progress",
  scheduled: "warn",
  published: "done",
  // 기록됨은 게시가 아니다 — 초록(done)을 주지 않는다.
  recorded: "idle",
  failed: "error",
};

const DIST_LABEL: Record<DistributionState["status"], string> = {
  none: "—",
  pending: "업로드 중",
  scheduled: "예약됨",
  published: "게시됨",
  recorded: "기록됨",
  failed: "실패",
};

type Row = {
  clip: Clip;
  dist: DistributionState;
  programTitle: string;
  episodeNumber?: number;
};

export default function DistributionPage() {
  const { clips, episodes, programs, retryDistribution, loading, serverConnected } = useAppData();
  const { toast } = useToast();
  const [channel, setChannel] = useState<string>("all");

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const clip of clips) {
      const ep = episodes.find((e) => e.id === clip.episodeId);
      const programTitle = programs.find((p) => p.id === ep?.programId)?.title ?? "";
      for (const dist of clip.distributions ?? []) {
        if (dist.status === "none") continue;
        out.push({ clip, dist, programTitle, episodeNumber: ep?.episodeNumber });
      }
    }
    return out;
  }, [clips, episodes, programs]);

  const channels = useMemo(() => [...new Set(rows.map((r) => r.dist.channel))], [rows]);
  const shown = channel === "all" ? rows : rows.filter((r) => r.dist.channel === channel);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.dist.status, (m.get(r.dist.status) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      <div className="flex flex-wrap items-center gap-[9px]">
        <div className="flex flex-wrap gap-[3px]">
          <button
            type="button"
            className={cn("sd-btn", channel === "all" && "sd-btn--on")}
            onClick={() => setChannel("all")}
          >
            전체
            <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>{rows.length}</span>
          </button>
          {channels.map((ch) => (
            <button
              key={ch}
              type="button"
              className={cn("sd-btn", channel === ch && "sd-btn--on")}
              onClick={() => setChannel(ch)}
            >
              {ch}
              <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>
                {rows.filter((r) => r.dist.channel === ch).length}
              </span>
            </button>
          ))}
        </div>

        <span className="sd-mono ml-auto text-[11px]" style={{ color: "var(--sd-mut)" }}>
          게시됨 {counts.get("published") ?? 0} · 기록됨 {counts.get("recorded") ?? 0} ·{" "}
          예약 {counts.get("scheduled") ?? 0} · 실패 {counts.get("failed") ?? 0}
        </span>
      </div>

      {/* 기록됨의 의미를 화면에 한 번 못박는다 — 태그만으로는 오해가 남는다. */}
      {(counts.get("recorded") ?? 0) > 0 && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px] leading-relaxed"
          style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
        >
          <b style={{ color: "var(--sd-fg)" }}>기록됨</b>은 게시가 아닙니다. Instagram·Facebook·TikTok 은
          파일이 올라가지 않고 우리 쪽 기록만 남습니다 — 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다.
        </div>
      )}

      {shown.length === 0 ? (
        <div
          className="sd-ph grid min-h-[160px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {loading ? "불러오는 중…" : "배포 기록이 없습니다 — 미디어 화면에서 배포하면 여기 쌓입니다"}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((r, i) => (
            <div key={`${r.clip.id}-${r.dist.channel}-${i}`} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-[240px] flex-1">
                <div className="truncate text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                  {r.clip.title}
                </div>
                <div className="sd-mono truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {r.programTitle}
                  {r.episodeNumber != null ? ` · 회차 ${r.episodeNumber}` : ""} · {fmtTime(r.clip.durationSec)}
                </div>
              </div>

              <span className="sd-tag">{r.dist.channel}</span>
              {r.dist.reserveDate && (
                <span className="sd-tag sd-mono">{r.dist.reserveDate}</span>
              )}
              <StatusBadge tone={DIST_TONE[r.dist.status]}>{DIST_LABEL[r.dist.status]}</StatusBadge>

              {r.dist.status === "failed" && (
                <div className="flex items-center gap-2">
                  <span className="max-w-[280px] truncate text-[11px]" style={{ color: "var(--sd-danger-strong)" }}>
                    {r.dist.error ?? "사유 없음"}
                  </span>
                  {/* 자동 재시도 없음 — 사람이 누른다 (F4-4 ⊘). */}
                  <button
                    type="button"
                    className="sd-btn"
                    onClick={async () => {
                      // 미연결이면 store 가 요청 자체를 보내지 않는다 — 성공 토스트를 띄우면 거짓말이 된다.
                      if (!serverConnected) {
                        toast({
                          title: "서버 미연결 — 재시도를 보내지 못했습니다",
                          description: "서버 연결이 회복된 뒤 다시 눌러 주세요.",
                          tone: "error",
                        });
                        return;
                      }
                      // store 는 실패 시 롤백 후 다시 던진다 — 여기서 안 받으면 unhandled rejection.
                      try {
                        await retryDistribution(r.clip.id, r.dist.channel);
                      } catch (error) {
                        toast({
                          title: "재시도 요청 실패",
                          description: error instanceof Error ? error.message : "다시 시도해 주세요.",
                          tone: "error",
                        });
                        return;
                      }
                      toast({
                        title: "재시도를 요청했습니다",
                        description: "자동 재시도는 없습니다 — 실패하면 이 줄의 사유가 갱신됩니다.",
                        tone: "progress",
                      });
                    }}
                  >
                    재시도
                  </button>
                </div>
              )}

              {r.dist.externalId && r.dist.channel === "youtube" && (
                <a
                  href={`https://www.youtube.com/watch?v=${r.dist.externalId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="sd-btn"
                >
                  영상 열기
                </a>
              )}
              <Link href={`/editor/${r.clip.id}`} className="sd-btn">편집</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

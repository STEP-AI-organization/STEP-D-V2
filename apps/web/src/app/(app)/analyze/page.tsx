"use client";

/**
 * U5 · 영상 분석 (README §4 · FLOWS F2).
 *
 * 회차 원본 → 추천 구간 → (사람이 채택) → 미디어.
 *
 * 지키는 규칙:
 *  - 회차 상태는 `분석 대기` → `분석 중` → `분석 완료`. 업로드했다고 분석된 게 아니다.
 *  - 진행률은 **클라이언트에서 97%를 넘기지 않는다.** 100%는 서버 완료 신호로만(F2-2 ⊘).
 *    타이머로 100%를 채우면 아직 도는 작업이 끝난 것처럼 보인다.
 *  - 추천 구간에 **권리·심의 레인**을 겹쳐 그린다. 채택하면 그 이슈가 미디어로 승계된다.
 *  - 종영 프로그램은 채택 단계가 없다(F2-5). 아카이브 검색으로 간다.
 *  - `+`(채택)를 누른 것만 미디어가 된다. 안 누른 구간은 여기 남아 있는다.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { UploadVideoButton } from "@/components/upload-video-dialog";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  fetchGate,
  type GateResult,
  type RightsIssue,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { GATE_TAG, ISSUE_COLOR, ISSUE_KIND_LABEL, fmtTime } from "@/lib/gate-ui";
import { normalizeProgramStatus } from "@/lib/programs";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";
import type { Episode, Recommendation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IssuePanel } from "@/components/gate/issue-panel";

export default function AnalyzePage() {
  return (
    <Suspense fallback={<div className="text-[12px]" style={{ color: "var(--sd-mut)" }}>불러오는 중…</div>}>
      <AnalyzeInner />
    </Suspense>
  );
}

function AnalyzeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { programs, episodes, recommendations, clips, loading } = useAppData();

  const programId = params.get("program") ?? programs[0]?.id ?? "";
  const program = programs.find((p) => p.id === programId);

  const eps = useMemo(
    () =>
      episodes
        .filter((e) => e.programId === programId)
        .slice()
        .sort((a, b) => b.episodeNumber - a.episodeNumber),
    [episodes, programId],
  );

  const episodeId = params.get("episode") ?? eps[0]?.id ?? "";
  const episode = eps.find((e) => e.id === episodeId);

  const recs = useMemo(
    () =>
      recommendations
        .filter((r) => r.episodeId === episodeId)
        .slice()
        .sort((a, b) => a.startTime - b.startTime),
    [recommendations, episodeId],
  );

  const go = (next: { program?: string; episode?: string }) => {
    const p = next.program ?? programId;
    const e = next.program ? "" : (next.episode ?? episodeId);
    router.replace(`/analyze?program=${p}${e ? `&episode=${e}` : ""}`);
  };

  const ended = program ? normalizeProgramStatus(program.status) === "ended" : false;

  return (
    <div className="flex gap-4">
      {/* ── 좌측 레일 214px ─────────────────────────────────────────────── */}
      <aside className="flex w-[214px] shrink-0 flex-col gap-2.5">
        <select
          value={programId}
          onChange={(e) => go({ program: e.target.value })}
          className="sd-input w-full"
          aria-label="프로그램 선택"
        >
          {programs.length === 0 && <option value="">프로그램 없음</option>}
          {programs.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>

        <div className="sd-card flex-1 overflow-y-auto p-1.5">
          {eps.length === 0 ? (
            <div className="p-3 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              {loading ? "불러오는 중…" : "회차가 없습니다"}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {eps.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => go({ episode: e.id })}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-[4px] px-2 py-1.5 text-left",
                      e.id === episodeId && "bg-[var(--sd-accent-bg)]",
                    )}
                  >
                    <span className="text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
                      회차 {e.episodeNumber}
                    </span>
                    <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                      {stageLabel(e)} · {e.broadDate || "방영일 미등록"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <UploadVideoButton
          programId={programId}
          className="sd-btn sd-btn-primary w-full"
          label="＋ 회차 영상 업로드"
        />
      </aside>

      {/* ── 중앙 ─────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {!episode ? (
          <div className="sd-card p-6 text-[12.5px]" style={{ color: "var(--sd-mut)" }}>
            {loading ? "불러오는 중…" : "왼쪽에서 회차를 고르세요. 회차가 없으면 원본을 먼저 올려야 합니다."}
          </div>
        ) : (
          <EpisodeAnalysis
            episode={episode}
            recs={recs}
            clipCount={clips.filter((c) => c.episodeId === episode.id).length}
            ended={ended}
            programId={programId}
          />
        )}
      </div>
    </div>
  );
}

function stageLabel(e: Episode): string {
  const p = e.pipeline;
  if (!p) return "분석 대기";
  const label = PIPELINE_STAGE_LABELS[p.stage] ?? p.stage;
  if (p.stageStatus === "progress") return `${label} 중`;
  if (p.stageStatus === "error") return `${label} 실패`;
  if (p.stageStatus === "idle") return "분석 대기";
  return "분석 완료";
}

function EpisodeAnalysis({
  episode,
  recs,
  clipCount,
  ended,
  programId,
}: {
  episode: Episode;
  recs: Recommendation[];
  clipCount: number;
  ended: boolean;
  programId: string;
}) {
  const analyzing = episode.pipeline?.stageStatus === "progress";
  const waiting = episode.pipeline?.stageStatus === "idle";

  // F2-2 ⊘ — 클라이언트는 97%를 넘기지 않는다. 100%는 서버가 완료를 알릴 때만.
  const pct = Math.min(97, Math.round(episode.pipeline?.progress ?? 0));

  const undecided = recs.filter((r) => r.status === "pending").length;
  const adopted = recs.filter((r) => r.status === "adopted").length;

  return (
    <>
      {/* 원본 자리 + 회차 상태 */}
      <div className="sd-card overflow-hidden">
        <div className="sd-ph h-[266px]" style={{ borderBottom: "1px solid var(--sd-border)" }}>
          원본 플레이어
        </div>
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <span className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            회차 {episode.episodeNumber}
          </span>
          <span className={cn("sd-tag", analyzing && "sd-tag--upcoming", waiting && "sd-tag")}>
            {stageLabel(episode)}
          </span>
          {(analyzing || waiting) && (
            <>
              <div className="sd-progress w-[160px]">
                <span style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              <span className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>
                {waiting ? "대기" : `${pct}%`}
              </span>
              <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
                {episode.pipeline?.note ?? ""}
              </span>
            </>
          )}
          <Link href={`/episodes/${episode.id}`} className="sd-btn ml-auto">
            회차 상세
          </Link>
        </div>
      </div>

      {/* 분석 결과 요약 */}
      <div className="sd-card flex">
        <Metric label="추천 구간" value={recs.length} divider />
        <Metric label="미결정" value={undecided} divider />
        <Metric label="미디어 생성" value={clipCount} />
      </div>

      {/* 회차 전체 권리 판정 — 여기서 등록한 이슈가 채택 시 구간으로 승계된다. */}
      <IssuePanel
        subjectType="episode"
        subjectId={episode.id}
        title="회차 권리·심의"
        hint="여기 등록한 이슈는 채택할 때 겹치는 구간의 미디어로 승계됩니다."
      />

      {/* 추천 구간 */}
      {ended ? (
        <div className="sd-card px-3 py-2.5 text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
          종영 프로그램입니다 — 새 회차 분석에서 클립을 만들지 않습니다.{" "}
          <Link href={`/search?program=${programId}`} className="underline" style={{ color: "var(--sd-accent)" }}>
            아카이브에서 장면 찾기
          </Link>
        </div>
      ) : recs.length === 0 ? (
        <div
          className="sd-ph grid min-h-[140px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {analyzing || waiting
            ? "분석이 끝나면 추천 구간이 여기 나타납니다"
            : "추천 구간이 없습니다 — 분석 결과가 비어 있습니다"}
        </div>
      ) : (
        <section className="flex flex-col gap-2.5">
          <div className="flex items-baseline gap-2">
            <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
              추천 구간
            </h3>
            <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
              채택(＋)한 구간만 미디어가 됩니다 · 미결정 {undecided} · 채택 {adopted}
            </span>
          </div>
          {recs.map((r) => (
            <RecommendationRow key={r.id} rec={r} episodeId={episode.id} />
          ))}
        </section>
      )}
    </>
  );
}

function Metric({ label, value, divider }: { label: string; value: number; divider?: boolean }) {
  return (
    <div
      className="flex-1 px-3 py-[11px]"
      style={divider ? { borderRight: "1px solid var(--sd-divider)" } : undefined}
    >
      <div className="sd-eb" style={{ color: "var(--sd-label)" }}>{label}</div>
      <div className="sd-mono text-[20px]" style={{ color: "var(--sd-fg)" }}>{value}</div>
    </div>
  );
}

function RecommendationRow({ rec, episodeId }: { rec: Recommendation; episodeId: string }) {
  const { adoptRecommendation, rejectRecommendation } = useAppData();
  const { toast } = useToast();
  const actor = useSession().user.name;

  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ gate: GateResult; issues: RightsIssue[] } | null>(null);
  const [open, setOpen] = useState(false);

  // 이 구간에 걸린 이슈 — 회차 전체 이슈 중 겹치는 것 + 구간에 직접 등록된 것.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [ep, own] = await Promise.all([
          fetchGate("episode", episodeId),
          fetchGate("recommendation", rec.id),
        ]);
        if (!alive) return;
        const overlapping = ep.issues.filter(
          (i) =>
            i.resolution !== "resolved" &&
            (i.bandStart == null ||
              i.bandEnd == null ||
              Math.min(rec.endTime, i.bandEnd) - Math.max(rec.startTime, i.bandStart) > 0),
        );
        setGate({ gate: own.gate, issues: [...overlapping, ...own.issues] });
      } catch {
        // 게이트를 못 읽으면 조용히 통과시키지 않는다 — 아무것도 안 그린다.
        if (alive) setGate(null);
      }
    })();
    return () => { alive = false; };
  }, [rec.id, rec.startTime, rec.endTime, episodeId]);

  const decided = rec.status !== "pending";

  async function adopt() {
    setBusy(true);
    try {
      await adoptRecommendation(rec.id);
      toast({
        title: "미디어를 만들었습니다",
        description:
          gate && gate.issues.length > 0
            ? `권리·심의 이슈 ${gate.issues.length}건이 함께 승계됐습니다 — 미디어 화면에서 처리하세요.`
            : "미디어 화면에서 확인할 수 있습니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-card flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="sd-mono text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
          {fmtTime(rec.startTime)} – {fmtTime(rec.endTime)}
        </span>
        <span className="sd-tag sd-mono">{Math.round(rec.endTime - rec.startTime)}초</span>
        {typeof rec.score100 === "number" && (
          <span className="sd-tag sd-mono">점수 {rec.score100}</span>
        )}
        <span className="sd-tag">{rec.kind === "short" ? "숏폼" : "클립"}</span>
        {rec.status === "adopted" && <span className="sd-tag sd-tag--airing">채택됨</span>}
        {rec.status === "rejected" && <span className="sd-tag sd-tag--ended">보류함</span>}
      </div>

      <div className="text-[12.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>
        {rec.title}
      </div>
      {rec.editNote && (
        <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          근거 · {rec.editNote}
        </div>
      )}

      {/* 권리·심의 레인 — 구간 길이 위에 이슈를 겹쳐 그린다 */}
      <RightsLane rec={rec} issues={gate?.issues ?? []} />

      <div className="flex flex-wrap items-center gap-2">
        {gate && <span className={GATE_TAG[gate.gate.state]}>{gate.gate.label}</span>}
        {gate === null && (
          <span className="sd-tag">게이트 확인 불가</span>
        )}
        <button type="button" className="sd-btn" onClick={() => setOpen((v) => !v)}>
          권리·심의 {open ? "닫기" : `(${gate?.issues.length ?? 0})`}
        </button>

        <div className="ml-auto flex gap-2">
          {decided ? (
            rec.adoptedClipId ? (
              <Link href={`/editor/${rec.adoptedClipId}`} className="sd-btn">
                미디어 열기
              </Link>
            ) : (
              <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>판단 완료</span>
            )
          ) : (
            <>
              <button
                type="button"
                className="sd-btn"
                disabled={busy}
                onClick={() => rejectRecommendation(rec.id, "보류")}
              >
                보류
              </button>
              <button type="button" className="sd-btn sd-btn-primary" disabled={busy} onClick={adopt}>
                ＋ 채택
              </button>
            </>
          )}
        </div>
      </div>

      {open && (
        <IssuePanel
          subjectType="recommendation"
          subjectId={rec.id}
          title="이 구간의 권리·심의"
          hint={`구간 ${fmtTime(rec.startTime)}–${fmtTime(rec.endTime)} 기준. 회차 전체 이슈는 위 레인에 함께 표시됩니다.`}
          bandDefault={{ start: rec.startTime, end: rec.endTime }}
          actor={actor}
        />
      )}
    </div>
  );
}

/**
 * 권리·심의 레인. 구간 길이를 100%로 놓고 이슈가 걸린 부분만 색을 얹는다.
 * 밴드 없는 이슈(회차 전체)는 전 구간을 덮는다.
 */
function RightsLane({ rec, issues }: { rec: Recommendation; issues: RightsIssue[] }) {
  const span = Math.max(0.001, rec.endTime - rec.startTime);
  const live = issues.filter((i) => i.resolution !== "resolved");

  return (
    <div>
      <div
        className="relative h-[10px] overflow-hidden rounded-[3px]"
        style={{ background: "#eae7e1" }}
        title={live.length ? `${live.length}건` : "이 구간에 등록된 이슈 없음"}
      >
        {live.map((i) => {
          const s = i.bandStart == null ? rec.startTime : Math.max(rec.startTime, i.bandStart);
          const e = i.bandEnd == null ? rec.endTime : Math.min(rec.endTime, i.bandEnd);
          const left = ((s - rec.startTime) / span) * 100;
          const width = Math.max(1.5, ((e - s) / span) * 100);
          return (
            <span
              key={i.id}
              className="absolute inset-y-0"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: ISSUE_COLOR[i.kind as keyof typeof ISSUE_COLOR] ?? "#8b877f",
                opacity: 0.75,
              }}
              title={`${ISSUE_KIND_LABEL[i.kind as keyof typeof ISSUE_KIND_LABEL] ?? i.kind} · ${i.note}`}
            />
          );
        })}
      </div>
      {live.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          {[...new Set(live.map((i) => i.kind))].map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span
                className="inline-block size-[7px] rounded-[2px]"
                style={{ background: ISSUE_COLOR[k as keyof typeof ISSUE_COLOR] ?? "#8b877f" }}
              />
              {ISSUE_KIND_LABEL[k as keyof typeof ISSUE_KIND_LABEL] ?? k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

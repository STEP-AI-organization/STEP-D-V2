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
 *  - 종영 프로그램은 채택 단계가 없다(F2-5). 아카이브 검색으로 간다.
 *  - `+`(채택)를 누른 것만 미디어가 된다. 안 누른 구간은 여기 남아 있는다.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { UploadVideoButton } from "@/components/upload-video-dialog";
import { useToast } from "@/components/ui/toast";
import { getStreamUrl } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { normalizeProgramStatus } from "@/lib/programs";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";
import type { Episode, Recommendation } from "@/lib/types";
import { cn, fmtTime } from "@/lib/utils";

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

  // 회차별 "분석(추천구간)" 중간 화면은 없앤다 — 회차를 지정해 들어오면 곧바로 회차 상세로 보낸다.
  // (좌측 레일에서 회차를 고르면 아래에서 바로 /episodes/:id 로 push 한다.)
  const episodeParam = params.get("episode");
  useEffect(() => {
    if (episodeParam) router.replace(`/episodes/${episodeParam}`);
  }, [episodeParam, router]);

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
                    onClick={() => router.push(`/episodes/${e.id}`)}
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
  // warn = 서버가 잡을 아예 큐잉하지 않은 상태(크레딧 부족 등). "완료"로 떨어지면 안 된다.
  if (p.stageStatus === "warn") return "분석 보류";
  return "분석 완료";
}

function EpisodeAnalysis({
  episode,
  recs,
  clipCount,
  ended,
}: {
  episode: Episode;
  recs: Recommendation[];
  clipCount: number;
  ended: boolean;
}) {
  const { mediaForEpisode } = useAppData();
  const master = mediaForEpisode(episode.id, "master");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string>();
  const [videoError, setVideoError] = useState<string | null>(null);

  // 재생 URL 은 서버가 준다 — 프로덕션은 짧은 수명의 GCS 서명 URL 이라
  // <video> 가 스토리지에서 바로 받는다(바이트가 서버를 안 거친다).
  useEffect(() => {
    setVideoSrc(undefined);
    setVideoError(null);
    if (!master) return;
    let alive = true;
    getStreamUrl(master.id)
      .then((u) => { if (alive) setVideoSrc(u); })
      // 못 불러오면 조용히 빈 화면을 두지 않는다 — 왜 안 나오는지 적는다.
      .catch((err) => { if (alive) setVideoError(`원본을 불러오지 못했습니다 (${err instanceof Error ? err.message : String(err)})`); });
    return () => { alive = false; };
  }, [master?.id, master]);

  /** 구간 클릭 → 그 지점으로 이동하고 재생. 검증 흐름의 척추다. */
  const seekTo = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, sec);
    void v.play().catch(() => {});
    v.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const analyzing = episode.pipeline?.stageStatus === "progress";
  const waiting = episode.pipeline?.stageStatus === "idle";
  // 서버가 분석 잡을 넣지 않은 상태(크레딧 부족 등) — 진행 중도 완료도 아니다.
  const blocked = episode.pipeline?.stageStatus === "warn";

  // F2-2 ⊘ — 클라이언트는 97%를 넘기지 않는다. 100%는 서버가 완료를 알릴 때만.
  const pct = Math.min(97, Math.round(episode.pipeline?.progress ?? 0));

  const undecided = recs.filter((r) => r.status === "pending").length;
  const adopted = recs.filter((r) => r.status === "adopted").length;

  return (
    <>
      {/* 원본 플레이어 + 회차 상태 */}
      <div className="sd-card overflow-hidden">
        {/* 16:9 프레임을 폭에 맞춰 잡는다. 프로토타입의 266px 는 목업 자리 높이였지
            실제 영상의 제약이 아니다 — 고정 높이로 두면 넓은 화면에서 위아래 검은 띠만 커진다. */}
        <div
          className="relative w-full"
          style={{ aspectRatio: "16 / 9", maxHeight: "58vh", background: "#000", borderBottom: "1px solid var(--sd-border)" }}
        >
          {videoSrc ? (
            <video
              ref={videoRef}
              key={videoSrc}
              src={videoSrc}
              controls
              playsInline
              preload="metadata"
              className="absolute inset-0 size-full object-contain"
            />
          ) : (
            <div className="sd-ph absolute inset-0 grid place-items-center text-center">
              {master ? (videoError ?? "원본을 불러오는 중…") : "이 회차의 원본 파일이 없습니다"}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <span className="sd-serif text-[15px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            회차 {episode.episodeNumber}
          </span>
          <span
            className={cn(
              "sd-tag",
              analyzing && "sd-tag--upcoming",
              blocked && "sd-tag--warn",
            )}
          >
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
            </>
          )}
          {/* note 는 보류 상태에서도 보여야 한다 — 왜 안 도는지가 거기 적혀 있다. */}
          {(analyzing || waiting || blocked) && episode.pipeline?.note && (
            <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
              {episode.pipeline.note}
            </span>
          )}
          <Link href={`/episodes/${episode.id}`} className="sd-btn ml-auto">
            회차 상세
          </Link>
        </div>
      </div>

      {episode.pipeline?.blockedReason && (
        <div
          className="rounded-[6px] px-3 py-2.5 text-[12.5px]"
          style={{
            color: "var(--sd-warn)",
            background: "var(--sd-warn-bg)",
            border: "1px solid var(--sd-warn-border)",
          }}
        >
          ⚠ {episode.pipeline.blockedReason}
        </div>
      )}

      {/* 분석 결과 요약 */}
      <div className="sd-card flex">
        <Metric label="추천 구간" value={recs.length} divider />
        <Metric label="미결정" value={undecided} divider />
        <Metric label="미디어 생성" value={clipCount} />
      </div>

      {/* 추천 구간 */}
      {ended ? (
        <div className="sd-card px-3 py-2.5 text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
          종영 프로그램입니다 — 새 회차 분석에서 클립을 만들지 않습니다.{" "}
          {/* 검색 화면은 아직 쿼리스트링 필터를 읽지 않는다 — ?program= 을 붙이면
              프로그램이 걸린 것처럼 보여서 뺐다. 검색창에서 직접 골라야 한다. */}
          <Link href="/search" className="underline" style={{ color: "var(--sd-accent)" }}>
            아카이브에서 장면 찾기
          </Link>{" "}
          <span style={{ color: "var(--sd-mut)" }}>(검색 화면에서 프로그램을 다시 골라야 합니다)</span>
        </div>
      ) : recs.length === 0 ? (
        <div
          className="sd-ph grid min-h-[140px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {blocked
            ? (episode.pipeline?.note ?? "분석이 보류됐습니다 — 위 사유를 해결하면 시작됩니다")
            : analyzing || waiting
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
            <RecommendationRow key={r.id} rec={r} episodeId={episode.id} onSeek={seekTo} />
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

function RecommendationRow({
  rec,
  episodeId,
  onSeek,
}: {
  rec: Recommendation;
  episodeId: string;
  onSeek: (sec: number) => void;
}) {
  const { adoptRecommendation, rejectRecommendation } = useAppData();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const decided = rec.status !== "pending";

  async function adopt() {
    setBusy(true);
    try {
      await adoptRecommendation(rec.id);
      toast({
        title: "미디어를 만들었습니다",
        description: "미디어 화면에서 확인할 수 있습니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 보류. store 의 rejectRecommendation 은 낙관적 갱신 · 폴링 경합 가드(mutationEpoch) ·
   * 실패 시 롤백까지 다 하고, 실패는 다시 던진다. 예전 호출부가 그 rejection 을 잡지 않아
   * 실패해도 아무 말이 없었을 뿐이다 — 여기서 await + catch 로 사유를 토스트로 올린다.
   */
  async function reject() {
    setBusy(true);
    try {
      await rejectRecommendation(rec.id, "보류");
      toast({
        title: "보류했습니다",
        description: "이 구간은 미디어가 되지 않습니다 — 목록에는 남습니다.",
        tone: "done",
      });
    } catch (err) {
      toast({ title: "보류 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-card flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* 시각을 누르면 위 플레이어가 그 지점으로 간다 */}
        <button
          type="button"
          onClick={() => onSeek(rec.startTime)}
          className="sd-mono text-[11.5px] underline-offset-2 hover:underline"
          style={{ color: "var(--sd-accent)" }}
          title="이 지점부터 재생"
        >
          {fmtTime(rec.startTime)} – {fmtTime(rec.endTime)}
        </button>
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

      <div className="flex flex-wrap items-center gap-2">
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
                onClick={reject}
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
    </div>
  );
}

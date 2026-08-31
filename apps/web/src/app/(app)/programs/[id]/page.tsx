"use client";

/**
 * U3 · 프로그램 홈 (README §3 · FLOWS F10).
 *
 * 상태마다 다른 화면이다 — 방영 중은 진행 중인 회차로 들어가는 곳,
 * 종영은 아카이브를 뒤지는 곳, 편성 예정은 아직 아무것도 없다고 말해 주는 곳.
 * 셋을 한 화면에 뭉뚱그리면 "왜 할 일이 없지"에서 막힌다.
 *
 * 프로그램 정보 편집(포스터·출연자 사진·썸네일 스타일)은 /programs/:id/settings 로
 * 옮겼다. 홈은 읽는 화면이다.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { UploadVideoButton } from "@/components/upload-video-dialog";
import { useToast } from "@/components/ui/toast";
import { PIPELINE_STAGE_LABELS } from "@/lib/constants";
import { clipThumbSrc, mediaThumbSrc, programImageUrl } from "@/lib/media-url";
import { useAppData } from "@/lib/data/store";
import {
  PROGRAM_STATUS_LABEL,
  normalizeProgramStatus,
  rightsWindowOf,
} from "@/lib/programs";
import type { Clip, Episode, Program, ProgramStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TAG: Record<ProgramStatus, string> = {
  airing: "sd-tag sd-tag--airing",
  ended: "sd-tag sd-tag--ended",
  upcoming: "sd-tag sd-tag--upcoming",
};

const TRACK_LABEL: Record<string, string> = { variety: "예능 트랙", drama: "드라마 트랙" };

export default function ProgramHomePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { programs, episodes, clips, media, loading, deleteProgram } = useAppData();
  const router = useRouter();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const program = programs.find((p) => p.id === id);

  const eps = useMemo(
    () =>
      episodes
        .filter((e) => e.programId === id)
        .slice()
        .sort((a, b) => b.episodeNumber - a.episodeNumber),
    [episodes, id],
  );
  const epIds = useMemo(() => new Set(eps.map((e) => e.id)), [eps]);
  const programClips = useMemo(
    () => clips.filter((c) => epIds.has(c.episodeId)),
    [clips, epIds],
  );

  if (!program) {
    return (
      <div className="sd-card mx-auto max-w-[640px] p-6">
        <h2 className="sd-serif mb-2 text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {loading ? "프로그램을 불러오는 중입니다…" : "프로그램을 찾을 수 없습니다"}
        </h2>
        {!loading && (
          <p className="text-[12px]" style={{ color: "var(--sd-mut)" }}>
            삭제됐거나 주소가 잘못됐습니다.{" "}
            <Link href="/programs" className="underline" style={{ color: "var(--sd-accent)" }}>
              프로그램 목록으로
            </Link>
          </p>
        )}
      </div>
    );
  }

  const status = normalizeProgramStatus(program.status);
  const today = new Date();
  const rights = rightsWindowOf(program, today);
  const published = programClips.filter((c) =>
    (c.distributions ?? []).some((d) => d.status === "published"),
  ).length;

  // 되돌릴 수 없는 작업이라 confirm 한 번으로 끝내지 않는다 — 회차가 있으면 무엇이 함께
  // 지워지는지(미디어·추천·클립·GCS 파일) 먼저 알리고, 프로그램명을 그대로 입력해야 실행된다.
  async function runDelete() {
    if (!program) return;
    const epCount = Math.max(program.episodeCount, eps.length);
    const scope =
      epCount > 0
        ? `회차 ${epCount}개와 그에 딸린 미디어·추천·클립·GCS 파일이 전부 함께 삭제됩니다.`
        : "이 프로그램에는 등록된 회차가 없습니다.";
    if (!confirm(`프로그램 "${program.title}"을 삭제합니다.\n\n${scope}\n\n되돌릴 수 없습니다. 계속할까요?`)) return;
    const typed = prompt(`확인을 위해 프로그램 이름을 그대로 입력하세요:\n\n${program.title}`);
    if (typed === null) return;
    if (typed.trim() !== program.title.trim()) {
      toast({ title: "삭제 취소됨", description: "입력한 이름이 프로그램 이름과 다릅니다", tone: "warn" });
      return;
    }
    setDeleting(true);
    try {
      await deleteProgram(program.id);
      toast({ title: "프로그램 삭제됨", description: program.title, tone: "done" });
      router.push("/programs");
    } catch (err) {
      toast({
        title: "삭제 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[22px]">
      {/* ── 헤더 ─────────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="sd-ph size-[88px] shrink-0 overflow-hidden rounded-full">
          {program.hasPosterImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={programImageUrl(program.id, "poster")} alt="" className="size-full object-cover" />
          ) : (
            <span className="text-center leading-tight">
              프로그램
              <br />
              로고
            </span>
          )}
        </div>

        <div className="flex min-w-[280px] flex-1 flex-col gap-[7px]">
          <div className="flex flex-wrap items-center gap-[9px]">
            <h2
              className="sd-serif text-[24px] font-semibold"
              style={{ color: "var(--sd-fg)", letterSpacing: "-.02em" }}
            >
              {program.title}
            </h2>
            <span className={STATUS_TAG[status]}>{PROGRAM_STATUS_LABEL[status]}</span>
          </div>

          <div className="text-[12.5px]" style={{ color: "var(--sd-mut)" }}>
            {scheduleLine(program, status) || "편성 정보가 등록되지 않았습니다"}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <span className="sd-tag">
              {program.pipelineGenre ? TRACK_LABEL[program.pipelineGenre] : "분석 트랙 미지정"}
            </span>
            <span className="sd-tag">{program.section}</span>
            <span className="sd-tag">출연자 {program.cast?.length ?? 0}명 등록</span>
            <span className="sd-tag">담당 {program.owner?.trim() || "미배정"}</span>
            {rights && (
              <span className={cn("sd-tag", rights.expiring && "sd-tag--danger")}>{rights.text}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/programs/${program.id}/settings`} className="sd-btn">
            프로그램 설정
          </Link>
          <button
            type="button"
            onClick={runDelete}
            disabled={deleting}
            className="sd-btn"
            style={{ color: "var(--sd-danger-strong)", borderColor: "var(--sd-danger-border)" }}
            title="이 프로그램과 하위 회차·클립을 완전히 삭제 (되돌릴 수 없음)"
          >
            {deleting ? "삭제 중…" : "프로그램 삭제"}
          </button>
        </div>

        {/* 편성 예정은 셀 숫자가 없다 — 0 세 개를 보여주면 "고장"으로 읽힌다. */}
        {status !== "upcoming" && (
          <div className="sd-card flex w-[300px] shrink-0">
            <Metric label="회차" value={Math.max(program.episodeCount, eps.length)} divider />
            <Metric label="미디어" value={programClips.length} divider />
            <Metric label="배포됨" value={published} />
          </div>
        )}
      </div>

      {/* ── 상태별 분기 ──────────────────────────────────────────────────────── */}
      {status === "airing" && <AiringBar programId={program.id} episodes={eps} />}
      {status === "ended" && <EndedBar program={program} rightsText={rights?.text} expiring={rights?.expiring} />}
      {status === "upcoming" && <UpcomingEmpty programId={program.id} />}

      {/* ── 회차 ─────────────────────────────────────────────────────────────── */}
      {status !== "upcoming" && (
        <section className="flex flex-col gap-2.5">
          <SectionHead
            title="회차"
            right={
              <>
                <Link href={`/analyze?program=${program.id}`} className="sd-btn">
                  전체 보기
                </Link>
                <UploadVideoButton
                  programId={program.id}
                  className="sd-btn sd-btn-primary"
                  label="회차 영상 업로드"
                />
              </>
            }
          />
          {eps.length > 0 ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {eps.slice(0, 8).map((e) => (
                <EpisodeCard
                  key={e.id}
                  episode={e}
                  thumbMediaId={media.find((m) => m.episodeId === e.id && m.role === "master")?.id}
                />
              ))}
            </div>
          ) : (
            <Placeholder>
              아직 회차 원본이 없습니다 — ‘회차 영상 업로드’로 시작하세요
            </Placeholder>
          )}
        </section>
      )}

      {/* ── 미디어 ───────────────────────────────────────────────────────────── */}
      {status !== "upcoming" && (
        <section className="flex flex-col gap-2.5">
          <SectionHead
            title="미디어"
            hint="추천 구간에서 채택한 것만 여기 올라옵니다"
            right={
              <Link href="/media" className="sd-btn">
                미디어에서 보기
              </Link>
            }
          />
          {programClips.length > 0 ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
              {programClips.slice(0, 10).map((c) => (
                <MediaCard key={c.id} clip={c} />
              ))}
            </div>
          ) : (
            <Placeholder>
              {eps.length === 0
                ? "회차 원본이 올라가면 분석 후 추천 구간이 생깁니다"
                : "채택한 구간이 아직 없습니다 — 영상 분석에서 구간을 채택하면 여기 나타납니다"}
            </Placeholder>
          )}
        </section>
      )}

      {/* ── 출연자 ───────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="출연자"
          hint="사람이 등록한 명단이 기준입니다 — 자동 인식은 참고용 표시만 합니다"
          right={
            <Link href={`/programs/${program.id}/settings`} className="sd-btn">
              출연자 관리
            </Link>
          }
        />
        {(program.cast?.length ?? 0) > 0 ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(96px,1fr))]">
            {program.cast!.map((name) => (
              <div key={name} className="flex flex-col items-center gap-1.5">
                <div className="sd-ph size-[64px] overflow-hidden rounded-full">
                  {program.castPhotos?.[name] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={program.castPhotos[name]} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="text-[10px]">사진 없음</span>
                  )}
                </div>
                <span className="truncate text-[11px]" style={{ color: "var(--sd-fg)" }}>
                  {name}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Placeholder>등록된 출연자가 없습니다 — 프로그램 설정에서 등록하세요</Placeholder>
        )}
      </section>
    </div>
  );
}

// ── 조각들 ───────────────────────────────────────────────────────────────────────

function Metric({ label, value, divider }: { label: string; value: number; divider?: boolean }) {
  return (
    <div
      className="flex-1 px-3 py-[11px]"
      style={divider ? { borderRight: "1px solid var(--sd-divider)" } : undefined}
    >
      <div className="sd-eb" style={{ color: "var(--sd-label)" }}>
        {label}
      </div>
      <div className="sd-mono text-[20px]" style={{ color: "var(--sd-fg)" }}>
        {value}
      </div>
    </div>
  );
}

function SectionHead({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0">
        <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {title}
        </h3>
        {hint && (
          <p className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {hint}
          </p>
        )}
      </div>
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="sd-ph grid min-h-[120px] place-items-center rounded-[6px] px-6 text-center"
      style={{ border: "1px dashed var(--sd-border)" }}
    >
      {children}
    </div>
  );
}

/**
 * 방영 중 — 지금 분석이 도는 회차로 바로 들어가는 줄.
 * ⚠️ 진행률은 서버가 준 값 그대로다. 클라이언트 타이머로 채우지 않는다(F2 ⊘).
 */
function AiringBar({ programId, episodes }: { programId: string; episodes: Episode[] }) {
  const running = episodes.find((e) => e.pipeline?.stageStatus === "progress");
  const target = running ?? episodes[0];

  if (!target) {
    return (
      <div className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span className="sd-tag sd-tag--airing">진행 중</span>
        <span className="flex-1 text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
          아직 올라온 회차가 없습니다.
        </span>
      </div>
    );
  }

  const pct = running ? Math.min(97, Math.round(running.pipeline?.progress ?? 0)) : null;

  return (
    <div className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="sd-tag sd-tag--airing">진행 중</span>
      <span className="min-w-[200px] flex-1 text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
        회차 {target.episodeNumber}{" "}
        {running ? (
          <>
            {PIPELINE_STAGE_LABELS[running.pipeline.stage]} 중 ·{" "}
            <span className="sd-mono" style={{ color: "var(--sd-mut)" }}>
              {running.pipeline.note ?? "진행 중"}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--sd-mut)" }}>· 대기 중인 작업 없음</span>
        )}
      </span>
      {pct !== null && (
        <>
          <div className="sd-progress w-[130px]">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span
            className="sd-mono w-[34px] text-right text-[11px]"
            style={{ color: "var(--sd-mut)" }}
          >
            {pct}%
          </span>
        </>
      )}
      <Link href={`/episodes/${target.id}`} className="sd-btn">
        회차 열기
      </Link>
    </div>
  );
}

/**
 * 종영 — 새 회차가 안 들어온다. 아카이브 재활용이 유일한 경로다.
 * 검색으로 찾은 구간에서 클립을 만드는 건 막지 않는다(2026-08-10 확정).
 */
function EndedBar({
  program,
  rightsText,
  expiring,
}: {
  program: Program;
  rightsText?: string;
  expiring?: boolean;
}) {
  return (
    <div className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="sd-tag sd-tag--ended">종영</span>
      <span className="min-w-[240px] flex-1 text-[12.5px]" style={{ color: "var(--sd-fg)" }}>
        {program.endedDate ? `${program.endedDate} 종영 — ` : ""}
        새 회차가 들어오지 않습니다. 기존 회차 재활용과 권리 만료일만 관리합니다.
      </span>
      {rightsText && (
        <span className={cn("sd-tag", expiring && "sd-tag--danger")}>{rightsText}</span>
      )}
      {/* 검색 화면은 쿼리스트링을 읽지 않는다 — ?program= 을 붙이면 걸린 것처럼 보이지만
          실제로는 '전 프로그램'으로 뜬다. 파라미터를 읽게 되면 그때 다시 붙인다. */}
      <Link href="/search" className="sd-btn" title="검색 화면에서 프로그램을 직접 선택하세요">
        아카이브에서 장면 찾기
      </Link>
    </div>
  );
}

/** 편성 예정 — 첫 방송 전. 회차도 지표도 없는 게 정상이라고 말해 준다. */
function UpcomingEmpty({ programId }: { programId: string }) {
  return (
    <div className="sd-card flex flex-col items-center gap-2.5 p-10">
      <div className="sd-ph size-[44px] rounded-full" />
      <div className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
        첫 방송 전 · 분석할 회차가 없습니다
      </div>
      <p
        className="max-w-[440px] text-center text-[12px] leading-relaxed"
        style={{ color: "var(--sd-mut)" }}
      >
        파일럿이나 선공개 영상이 있다면 지금 올려 두면 됩니다. 업로드는 분석 대기열에
        들어갑니다.
      </p>
      <div className="flex gap-2">
        <Link href="/programs" className="sd-btn">
          프로그램 목록으로
        </Link>
        <UploadVideoButton
          programId={programId}
          className="sd-btn sd-btn-primary"
          label="파일럿 영상 업로드"
        />
      </div>
    </div>
  );
}

function EpisodeCard({ episode, thumbMediaId }: { episode: Episode; thumbMediaId?: string }) {
  const thumb = mediaThumbSrc(thumbMediaId);
  const p = episode.pipeline;
  const tone =
    p?.stageStatus === "error" ? "sd-tag sd-tag--danger" : p?.stageStatus === "progress"
      ? "sd-tag sd-tag--upcoming"
      : "sd-tag";

  return (
    <Link href={`/episodes/${episode.id}`} className="sd-card flex flex-col overflow-hidden">
      <div className="sd-ph h-[92px]" style={{ borderBottom: "1px solid var(--sd-border)" }}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          "회차 썸네일"
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-2.5 py-2.5">
        <div className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          회차 {episode.episodeNumber}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={tone}>{stageLabel(episode)}</span>
        </div>
        <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          {episode.broadDate || "방영일 미등록"}
        </div>
      </div>
    </Link>
  );
}

function stageLabel(e: Episode): string {
  const p = e.pipeline;
  if (!p) return "분석 대기";
  const label = PIPELINE_STAGE_LABELS[p.stage] ?? p.stage;
  if (p.stageStatus === "progress") return `${label} 중`;
  if (p.stageStatus === "error") return `${label} 실패`;
  if (p.stageStatus === "idle") return "분석 대기";
  return label;
}

function MediaCard({ clip }: { clip: Clip }) {
  const shortForm = clip.aspectRatio?.startsWith("9:16");
  const thumb = clipThumbSrc(clip);
  return (
    <Link href={`/editor/${clip.id}`} className="sd-card flex flex-col overflow-hidden">
      <div className="sd-ph h-[100px]" style={{ borderBottom: "1px solid var(--sd-border)" }}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          "미디어 썸네일"
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-2.5 py-2.5">
        <div className="line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>
          {clip.title}
        </div>
        <div className="flex flex-wrap gap-1">
          <span className="sd-tag">{shortForm ? "숏폼" : "클립"}</span>
          <span className="sd-tag sd-mono">{Math.round(clip.durationSec)}초</span>
        </div>
      </div>
    </Link>
  );
}

/** 헤더 아래 편성 한 줄 — 상태에 따라 쓸모 있는 정보가 다르다. */
function scheduleLine(program: Program, status: ProgramStatus): string {
  const parts: string[] = [];
  if (status === "ended" && program.endedDate) parts.push(`${program.endedDate} 종영`);
  else if (status === "upcoming" && program.firstAiredDate) {
    parts.push(`${program.firstAiredDate} 첫 방송 예정`);
  } else if (program.schedule) parts.push(program.schedule);

  if (program.broadcaster) parts.push(program.broadcaster);
  if (status === "airing" && program.currentInfo) parts.push(program.currentInfo);
  return parts.join(" · ");
}

"use client";

/**
 * U2 · 프로그램 목록 (README §2 · FLOWS F10).
 *
 * 30개 이상 프로그램을 굴리는 화면이라 필터가 카드보다 먼저 온다.
 * 필터 라벨의 개수는 **다른 필터를 적용한 뒤 남는 개수**다 — 규칙은 lib/programs.ts 에 있고
 * 여기서는 그리기만 한다.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import { NewProgramButton } from "@/components/new-program-dialog";
import { useSession } from "@/lib/auth";
import { useAppData } from "@/lib/data/store";
import {
  ALL,
  EMPTY_PROGRAM_FILTERS,
  PROGRAM_STATUSES,
  PROGRAM_STATUS_LABEL,
  filterPrograms,
  normalizeProgramStatus,
  residualCounts,
  rightsWindowOf,
  sectionsOf,
  statusNoteFor,
  type ProgramFilters,
} from "@/lib/programs";
import type { Episode, Program, ProgramStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TAG: Record<ProgramStatus, string> = {
  airing: "sd-tag sd-tag--airing",
  ended: "sd-tag sd-tag--ended",
  upcoming: "sd-tag sd-tag--upcoming",
};

const TRACK_LABEL: Record<string, string> = { variety: "예능 트랙", drama: "드라마 트랙" };

export default function ProgramsPage() {
  const { programs, episodes, loading } = useAppData();
  const me = useSession().user.name;
  const [f, setF] = useState<ProgramFilters>(EMPTY_PROGRAM_FILTERS);

  // 오늘 날짜는 카드가 그려질 때만 쓰인다. 스토어가 빈 상태로 시작하므로(프리렌더 시 카드 0개)
  // 서버·클라이언트 렌더가 갈라질 일이 없다.
  const today = useMemo(() => new Date(), []);

  const sections = useMemo(() => sectionsOf(programs), [programs]);
  const counts = useMemo(() => residualCounts(programs, f, me), [programs, f, me]);
  const visible = useMemo(() => filterPrograms(programs, f, me), [programs, f, me]);

  const epsByProgram = useMemo(() => {
    const m = new Map<string, Episode[]>();
    for (const e of episodes) {
      const list = m.get(e.programId);
      if (list) list.push(e);
      else m.set(e.programId, [e]);
    }
    return m;
  }, [episodes]);

  const note = statusNoteFor(f.status);
  const set = (patch: Partial<ProgramFilters>) => setF((prev) => ({ ...prev, ...patch }));

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* ── 필터 줄 ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-[9px]">
        <input
          className="sd-input w-[250px]"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="프로그램명 · 담당 PD로 찾기"
          aria-label="프로그램 검색"
        />

        <div className="flex flex-wrap gap-[3px]">
          <FilterChip
            label="전체"
            count={counts.status[ALL]}
            on={f.status === ALL}
            onClick={() => set({ status: ALL })}
          />
          {PROGRAM_STATUSES.map((s) => (
            <FilterChip
              key={s}
              label={PROGRAM_STATUS_LABEL[s]}
              count={counts.status[s]}
              on={f.status === s}
              onClick={() => set({ status: s })}
            />
          ))}
        </div>

        <span className="h-[18px] w-px" style={{ background: "var(--sd-border)" }} aria-hidden />

        <div className="flex flex-wrap gap-[3px]">
          <FilterChip
            label="전 섹션"
            count={counts.section[ALL]}
            on={f.section === ALL}
            onClick={() => set({ section: ALL })}
          />
          {sections.map((s) => (
            <FilterChip
              key={s}
              label={s}
              count={counts.section[s] ?? 0}
              on={f.section === s}
              onClick={() => set({ section: s })}
            />
          ))}
        </div>

        <FilterChip
          label="내 담당만"
          count={counts.mine}
          on={f.mineOnly}
          onClick={() => set({ mineOnly: !f.mineOnly })}
        />

        <div className="ml-auto flex items-center gap-2">
          <span className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>
            {summaryOf(visible)}
          </span>
          <NewProgramButton className="sd-btn" />
        </div>
      </div>

      {/* 좁힌 상태가 왜 비어 있는지 — 안 적으면 고장으로 읽힌다. */}
      {note && (
        <div
          className="sd-card px-[13px] py-[10px] text-[11.5px]"
          style={{ background: "var(--sd-card-sub)", color: "var(--sd-fg)" }}
        >
          {note}
        </div>
      )}

      {/* ── 카드 그리드 ─────────────────────────────────────────────────────── */}
      {visible.length > 0 ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(266px,1fr))]">
          {visible.map((p) => (
            <ProgramCard key={p.id} program={p} episodes={epsByProgram.get(p.id) ?? []} today={today} />
          ))}
        </div>
      ) : (
        <div
          className="sd-ph grid h-[180px] place-items-center rounded-[6px] px-6 text-center"
          style={{ border: "1px dashed var(--sd-border)" }}
        >
          {emptyCopy({ loading, total: programs.length })}
        </div>
      )}
    </div>
  );
}

/** 필터 칩 — 라벨 + 남는 개수. 0건은 흐리게 두되 누를 수는 있게 둔다(왜 0인지 보여야 하므로). */
function FilterChip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn("sd-btn", on && "sd-btn--on")}
      style={!on && count === 0 ? { opacity: 0.5 } : undefined}
    >
      {label}
      <span className="sd-mono ml-1.5 text-[10.5px]" style={{ opacity: 0.7 }}>
        {count}
      </span>
    </button>
  );
}

function ProgramCard({
  program,
  episodes,
  today,
}: {
  program: Program;
  episodes: Episode[];
  today: Date;
}) {
  const status = normalizeProgramStatus(program.status);
  const rights = rightsWindowOf(program, today);
  const track = program.pipelineGenre ? TRACK_LABEL[program.pipelineGenre] : "분석 트랙 미지정";

  return (
    <Link
      href={`/programs/${program.id}`}
      className="sd-card flex flex-col overflow-hidden transition-shadow"
    >
      <div
        className="sd-ph h-[180px]"
        style={{ borderBottom: "1px solid var(--sd-border)" }}
      >
        {program.posterImageDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={program.posterImageDataUrl}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          "포스터 이미지"
        )}
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-[11px]">
        <div className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {program.title}
        </div>

        <div className="flex flex-wrap gap-[5px]">
          <span className={STATUS_TAG[status]}>{PROGRAM_STATUS_LABEL[status]}</span>
          <span className="sd-tag">{program.section}</span>
          <span className="sd-tag">{track}</span>
        </div>

        <div className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          담당 {program.owner?.trim() || "미배정"}
        </div>

        {rights && (
          <span className={cn("sd-tag w-fit", rights.expiring && "sd-tag--danger")}>{rights.text}</span>
        )}

        <div className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          {cardMeta(program, episodes, status)}
        </div>
      </div>
    </Link>
  );
}

/**
 * 상태마다 다른 메타 한 줄 (F10).
 * 편성 예정은 **첫 방송 전이라 회차를 숨긴다** — 파일럿만 따로 센다.
 */
function cardMeta(program: Program, episodes: Episode[], status: ProgramStatus): string {
  if (status === "upcoming") {
    return episodes.length > 0 ? `파일럿 ${episodes.length}회 보유 · 분석 대기` : "첫 방송 전 · 회차 없음";
  }

  const count = Math.max(program.episodeCount, episodes.length);
  const latest = latestBroadDate(episodes);

  if (status === "ended") {
    const end = program.endedDate?.slice(5) ?? latest;
    return `회차 ${count}${end ? ` · 종영 ${end}` : ""}`;
  }

  const running = episodes.filter((e) => e.pipeline?.stageStatus === "progress").length;
  if (running > 0) return `회차 ${count} · 분석 중 ${running}건`;
  return `회차 ${count}${latest ? ` · 최근 회차 ${latest}` : ""}`;
}

/** 가장 최근 방영일을 MM-DD 로. 방영일이 없으면 빈 문자열. */
function latestBroadDate(episodes: Episode[]): string {
  let max = "";
  for (const e of episodes) if (e.broadDate && e.broadDate > max) max = e.broadDate;
  return max ? max.slice(5) : "";
}

function summaryOf(visible: Program[]): string {
  const by = (s: ProgramStatus) =>
    visible.filter((p) => normalizeProgramStatus(p.status) === s).length;
  return `${visible.length}개 · 방영 중 ${by("airing")} · 종영 ${by("ended")} · 편성 예정 ${by("upcoming")}`;
}

/**
 * 빈 화면의 이유를 나눠 적는다 — "필터가 좁아서"와 "아직 아무것도 없어서"는 다른 문제다.
 * 서버 미연결은 사이드바 하단 표시가 담당한다.
 */
function emptyCopy({ loading, total }: { loading: boolean; total: number }): string {
  if (loading && total === 0) return "프로그램을 불러오는 중입니다…";
  if (total === 0) return "등록된 프로그램이 없습니다 — 오른쪽 위 ‘＋ 새 프로그램’으로 시작하세요";
  return "조건에 맞는 프로그램이 없습니다";
}

"use client";

/**
 * 프로그램 목록 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/app/programs/page.tsx` 678줄).
 *
 * **마크업·클래스·문구는 원본 그대로.** 바깥 두 겹 래퍼와 `<Sidebar/>` 만 뺐다.
 *
 * ## 이식하지 않은 것 — 원본 132–323줄
 * `selectedProgram` 분기(목록 안 인라인 상세)는 **도달 불가**다. 세터가 `setSelectedProgram(null)`
 * 하나뿐이고 카드는 `<Link>` 라 영원히 안 열린다. 진짜 상세는 `program-detail-view.tsx` 이고
 * 우리 쪽은 `[id]/page.tsx` 가 그 자리다.
 *
 * ## 원본이 목이라 사라질 뻔한 것들 (전부 되살렸다)
 *  - **검색 input 에 `value`/`onChange` 가 없다**(332). 붙이지 않으면 검색이 통째로 죽는다.
 *  - **칩 개수가 리터럴 삼항**이다(`statusFilter === '방영 중' ? 4 : 0`). 우리 규칙은
 *    "자기 축을 뺀 나머지 필터 적용 후 남는 개수"(`residualCounts`) — 그래야 "종영 3" 을
 *    누르면 정말 3개가 남는다.
 *  - **섹션 칩 3개가 고정**이다(드라마/영화·어린이). 실데이터는 뮤직·교양·라이프·스포츠도
 *    쓴다 → `sectionsOf()` 로 데이터에서 뽑는다. 3개를 넘으면 알약 그룹에 `flex-wrap` 을
 *    더한다(3개 이하면 원본 마크업과 완전히 동일).
 *  - **`만들기` 버튼이 모달만 닫는다**(665–671). `createProgram()` 을 붙였다.
 *  - **권리 만료 태그**(F3)가 원본 태그 줄에 자리가 없다. 태그 줄은 `flex-wrap` 이라
 *    4번째 칸으로 넣었고, 만료 임박은 원본이 이미 쓰는 rose 톤을 쓴다.
 *
 * ## 분기 재조립
 * 원본은 `상태=종영` 이면 **무조건** 배너+빈 상자다(목에 종영이 없어서). 실데이터엔 있으므로
 * `{note && 배너}` 를 그리드 위로 빼고 아래는 `있으면 그리드 / 없으면 빈 상자` 로 바꿨다.
 * 배너 문구는 `statusNoteFor()` 가 원본과 **글자 단위로 같다**.
 */
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { CustomSelect } from "@/components/ui/custom-select";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import { TARGET_AGES, targetAgeLabel, type TargetAge } from "@/lib/constants";
import { useAppData } from "@/lib/data/store";
import { programImageUrl } from "@/lib/media-url";
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

const GENRE_OPTIONS = [
  "드라마/영화",
  "예능",
  "뮤직",
  "시사",
  "교양",
  "라이프",
  "스포츠",
  "게임",
  "어린이",
  "뉴스",
  "애니",
];

const RATING_OPTIONS = ["전체", "7세", "12세", "15세", "19세"];

const TRACK_LABEL: Record<string, string> = { variety: "예능 트랙", drama: "드라마 트랙" };

/** 원본 칩 클래스 — 선택/비선택 두 갈래를 그대로 옮겼다. */
const CHIP = (on: boolean) =>
  `h-8 px-3 rounded-full transition-colors cursor-pointer flex items-center justify-center ${
    on
      ? "bg-[var(--color-bg-active)] text-white font-bold shadow-md shadow-[#1C60FF]/25 dark:shadow-none"
      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
  }`;

const DIVIDER = "h-4 w-[1px] bg-slate-300 dark:bg-slate-700/80 mx-1 shrink-0 self-center";
const PILL_GROUP = "h-10 bg-white dark:bg-[#1C1E24] p-1 rounded-full shadow-none flex items-center gap-1 text-xs border-none";
const EMPTY_BOX = "w-full h-80 flex items-center justify-center text-xs text-[var(--color-text-muted)] p-8 text-center bg-transparent border-none shadow-none";

export default function ProgramsPage() {
  const { programs, episodes, loading, createProgram } = useAppData();
  const me = useSession().user.name;
  const { toast } = useToast();

  const [f, setF] = useState<ProgramFilters>(EMPTY_PROGRAM_FILTERS);

  // New Program Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [programTitle, setProgramTitle] = useState("");
  const [selectedGenre, setSelectedGenre] = useState("드라마/영화");
  const [selectedRating, setSelectedRating] = useState("전체");
  const [castInput, setCastInput] = useState("");
  const [busy, setBusy] = useState(false);
  const backdropMouseDownRef = useRef(false);

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

  function closeModal() {
    if (busy) return;
    setIsModalOpen(false);
  }

  async function submit() {
    const title = programTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await createProgram({
        title,
        section: selectedGenre,
        targetAge: targetAgeFromLabel(selectedRating),
        cast: castInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast({ title: "프로그램 생성됨", description: title, tone: "done" });
      setProgramTitle("");
      setCastInput("");
      setIsModalOpen(false);
    } catch (err) {
      toast({
        title: "생성 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Header */}
      <Header title="프로그램" subtitle="편성·상태별 프로그램 목록" />

      {/* Programs Main Content View */}
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
        {/* Program Main List Grid View */}
        <div className="space-y-5 flex-1">
          {/* Image 2 Style Equal Height Control Bar */}
          <div className="flex items-center justify-between gap-3 text-xs flex-wrap mb-6">
            {/* Left Search input & Status Filter Buttons & Category Buttons & My Assigned Tab */}
            <div className="flex items-center gap-2.5 flex-wrap">
              {/* 1. Search input (h-10) */}
              <input
                type="text"
                placeholder="프로그램명 · 담당 PD로 찾기"
                value={f.q}
                onChange={(e) => set({ q: e.target.value })}
                aria-label="프로그램 검색"
                className="h-10 w-60 bg-[var(--color-bg-card)] text-xs placeholder:text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] px-4 rounded-full shadow-md shadow-slate-900/5 dark:shadow-none focus:outline-none focus:ring-1 focus:ring-[var(--color-bg-active)]"
              />

              {/* Light Gray Vertical Divider */}
              <div className={DIVIDER} />

              {/* 2. Status Badges Group (h-10) */}
              <div className={PILL_GROUP}>
                <button
                  onClick={() => set({ status: ALL })}
                  aria-pressed={f.status === ALL}
                  className={CHIP(f.status === ALL)}
                >
                  전체 {counts.status[ALL] ?? 0}
                </button>
                {PROGRAM_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => set({ status: s })}
                    aria-pressed={f.status === s}
                    className={CHIP(f.status === s)}
                  >
                    {PROGRAM_STATUS_LABEL[s]} {counts.status[s] ?? 0}
                  </button>
                ))}
              </div>

              {/* Light Gray Vertical Divider */}
              <div className={DIVIDER} />

              {/* 3. Category Badges Group (h-10) — 원본은 3개 고정, 여기선 데이터에서 뽑는다.
                  3개를 넘길 때만 wrap 을 켠다(그 이하면 원본 마크업과 동일). */}
              <div className={sections.length > 3 ? `${PILL_GROUP} h-auto flex-wrap` : PILL_GROUP}>
                <button
                  onClick={() => set({ section: ALL })}
                  aria-pressed={f.section === ALL}
                  className={CHIP(f.section === ALL)}
                >
                  전 섹션 {counts.section[ALL] ?? 0}
                </button>
                {sections.map((s) => (
                  <button
                    key={s}
                    onClick={() => set({ section: s })}
                    aria-pressed={f.section === s}
                    className={CHIP(f.section === s)}
                  >
                    {s} {counts.section[s] ?? 0}
                  </button>
                ))}
              </div>

              {/* Light Gray Vertical Divider */}
              <div className={DIVIDER} />

              {/* 4. Separate Group: 내 담당만 ON/OFF Toggle (h-10) */}
              <div className={PILL_GROUP}>
                <button
                  type="button"
                  onClick={() => set({ mineOnly: !f.mineOnly })}
                  aria-pressed={f.mineOnly}
                  className={`h-8 px-3.5 rounded-full transition-colors cursor-pointer flex items-center justify-center ${
                    f.mineOnly
                      ? "bg-[var(--color-bg-active)] text-white font-bold shadow-md shadow-[#1C60FF]/25 dark:shadow-none"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
                  }`}
                >
                  내 담당만 {counts.mine}
                </button>
              </div>
            </div>

            {/* Right Counter & 5. New Program Button (h-10) */}
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-[var(--color-text-muted)]">{summaryOf(visible)}</span>

              {/* Light Gray Vertical Divider */}
              <div className="h-4 w-[1px] bg-slate-300 dark:bg-slate-700/80 mx-0.5 shrink-0 self-center" />

              <button
                onClick={() => setIsModalOpen(true)}
                className="h-10 pl-4 pr-5 rounded-full bg-[var(--color-bg-active)] text-white font-bold text-xs hover:bg-[#0D1EB8] transition-colors shadow-md shadow-[#1C60FF]/20 cursor-pointer flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.8]" />
                <span>새 프로그램</span>
              </button>
            </div>
          </div>

          {/* Dynamic View based on Status Filter */}
          <div className="space-y-4">
            {note && (
              <div className="bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl p-3 text-xs text-[var(--color-text-primary)] border-none">
                {note}
              </div>
            )}

            {visible.length === 0 ? (
              <div className={EMPTY_BOX}>{emptyCopy({ loading, total: programs.length })}</div>
            ) : (
              /* 방영 중 & 전체: Image 1 Style Program Cards Grid (4 Columns) */
              <div className="grid grid-cols-4 gap-4">
                {visible.map((program) => (
                  <ProgramCardView
                    key={program.id}
                    program={program}
                    episodes={epsByProgram.get(program.id) ?? []}
                    today={today}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <Footer />
      </main>

      {/* New Program Modal Dialog (Identical Styling to Upload & Deploy Modals) */}
      {isModalOpen && (
        <div
          onMouseDown={(e) => {
            backdropMouseDownRef.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && backdropMouseDownRef.current) {
              closeModal();
            }
            backdropMouseDownRef.current = false;
          }}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150 cursor-pointer"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--color-bg-card)] border border-[var(--color-border-card)] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden text-xs p-6 space-y-4 select-none cursor-default"
          >
            {/* Modal Header Title & Close Button */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-[var(--color-text-primary)]">새 프로그램</h3>
              </div>
              <button
                onClick={closeModal}
                aria-label="닫기"
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] p-1 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 pt-1">
              {/* 1. Program Title Input */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[var(--color-text-primary)]">
                  프로그램 제목 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="예: 전지적 참견 시점"
                  value={programTitle}
                  onChange={(e) => setProgramTitle(e.target.value)}
                  className="w-full h-10 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[#1C60FF] focus:ring-1 focus:ring-[#1C60FF]"
                />
              </div>

              {/* 2. Genre & Rating Select Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-[var(--color-text-primary)]">
                    장르 <span className="text-rose-500">*</span>
                  </label>
                  <CustomSelect
                    options={GENRE_OPTIONS}
                    value={selectedGenre}
                    onChange={setSelectedGenre}
                    ariaLabel="장르"
                    triggerClassName="h-10 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[#1C60FF] focus:ring-1 focus:ring-[#1C60FF] cursor-pointer shadow-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-[var(--color-text-primary)]">
                    시청 등급 <span className="text-rose-500">*</span>
                  </label>
                  <CustomSelect
                    options={RATING_OPTIONS}
                    value={selectedRating}
                    onChange={setSelectedRating}
                    ariaLabel="시청 등급"
                    triggerClassName="h-10 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[#1C60FF] focus:ring-1 focus:ring-[#1C60FF] cursor-pointer shadow-none"
                  />
                </div>
              </div>

              {/* 3. Cast Input */}
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-[var(--color-text-primary)]">
                  출연자 <span className="font-normal text-[var(--color-text-muted)]">(쉼표로 구분 · 선택)</span>
                </label>
                <input
                  type="text"
                  value={castInput}
                  onChange={(e) => setCastInput(e.target.value)}
                  placeholder="예: 이영자, 홍현희"
                  className="w-full h-10 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[#1C60FF] focus:ring-1 focus:ring-[#1C60FF]"
                />
              </div>

              {/* Notice Footer Text */}
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
                포스터·프로그램 썸네일 이미지는 프로그램 생성 후 등록합니다.
              </p>
            </div>

            {/* Action Buttons Footer Bar */}
            <div className="flex items-center justify-end pt-3 border-t border-[var(--color-border-subtle)]/60 gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={busy}
                className="px-4 py-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-input)] text-xs text-[var(--color-text-primary)] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                취소
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!programTitle.trim() || busy}
                className="px-5 py-2 rounded-full bg-[#1C60FF] hover:bg-[#0D1EB8] text-white text-xs font-bold transition-all cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                만들기
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface CardTag {
  label: string;
  /** 원본 태그 삼항의 두 갈래 + 권리 만료용 rose. */
  tone: "airing" | "default" | "danger";
}

const TAG_CLASS: Record<CardTag["tone"], string> = {
  airing: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400",
  default: "bg-slate-200/80 text-slate-700 dark:bg-[#282B35] dark:text-slate-200",
  danger: "bg-rose-500/15 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400",
};

/** 원본 489–551 카드. 목 필드 자리에 실데이터를 넣었다. */
function ProgramCardView({
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

  const tags: CardTag[] = [
    { label: PROGRAM_STATUS_LABEL[status], tone: status === "airing" ? "airing" : "default" },
    { label: program.section, tone: "default" },
    { label: track, tone: "default" },
  ];
  if (rights) tags.push({ label: rights.text, tone: rights.expiring ? "danger" : "default" });

  return (
    <Link
      href={`/programs/${program.id}`}
      className="bg-[var(--color-bg-card)] shadow-md shadow-slate-900/5 dark:shadow-none rounded-xl overflow-hidden hover:shadow-lg transition-all flex flex-col group cursor-pointer"
    >
      {/* Poster Header */}
      <div className="h-40 bg-[var(--color-bg-input)] relative overflow-hidden flex items-center justify-center">
        {!program.hasPosterImage ? (
          <div className="w-full h-full bg-slate-300/80 dark:bg-[#16181D] flex items-center justify-center text-xs text-slate-700 dark:text-slate-400 font-bold">
            포스터 이미지
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={programImageUrl(program.id, "poster")}
            alt={program.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        )}
      </div>

      {/* Card Info Section */}
      <div className="p-4 space-y-3 flex-1 flex flex-col justify-between text-xs">
        <div>
          <h3 className="font-bold text-sm text-[var(--color-text-primary)] mb-2">{program.title}</h3>

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {tags.map((tag, idx) => (
              <span
                key={idx}
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold ${TAG_CLASS[tag.tone]}`}
              >
                {tag.label}
              </span>
            ))}
          </div>
        </div>

        {/* Metadata Details */}
        <div className="pt-2 border-t border-[var(--color-border-subtle)] space-y-1 text-[11px] text-[var(--color-text-muted)]">
          <div>담당 {program.owner?.trim() || "미배정"}</div>
          <div className="flex items-center gap-2">
            <span>{cardMeta(program, episodes, status)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

/** 등급 라벨 → TargetAge. 못 찾으면 0(전체). */
function targetAgeFromLabel(label: string): TargetAge {
  return TARGET_AGES.find((a) => targetAgeLabel(a) === label) ?? 0;
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
  for (const e of episodes) {
    const d = e.broadDate?.trim();
    if (d && d > max) max = d;
  }
  return max ? max.slice(5) : "";
}

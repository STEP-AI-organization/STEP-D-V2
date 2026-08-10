"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Info, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { TARGET_AGES, targetAgeLabel, type TargetAge } from "@/lib/constants";
import {
  PROGRAM_STATUSES,
  PROGRAM_STATUS_LABEL,
  normalizeProgramStatus,
} from "@/lib/programs";
import type { ProgramStatus } from "@/lib/types";
import { WEEKDAYS } from "@/lib/reserve-date";
import type { Program } from "@/lib/types";

// 신규 다이얼로그와 동일 소스. 서로 다른 값이 되지 않도록 이 상수는 유지·동기화.
const SECTIONS = ["드라마/영화", "예능", "뮤직", "시사", "교양", "라이프", "스포츠", "게임", "어린이", "뉴스", "애니"];
const SMR_CATEGORIES = ["01", "02", "03"];
const CODE_RE = /^[a-z0-9]+$/;

/** ProgramCard의 '프로그램 정보' 트리거. 이제 모달이 아니라 `/programs/:id` 상세 페이지로 이동
 *  (포스터·인물 사진 업로드 등 넓은 편집 화면). 모달 다이얼로그(EditProgramDialogMount)는
 *  SMR pill의 빠른 진입점 용도로만 유지. */
export function EditProgramButton({
  program,
  variant = "outline",
}: {
  program: Program;
  variant?: "outline" | "ghost";
}) {
  return (
    <Link
      href={`/programs/${program.id}`}
      title="프로그램 정보 (제목·소개·방영·출연자·SMR)"
      className={buttonVariants({ size: "sm", variant })}
    >
      <Info /> 프로그램 정보
    </Link>
  );
}

/** SMR pill 등에서 직접 mount 할 때 사용. Button 없이 다이얼로그만. */
export function EditProgramDialogMount({
  program,
  scrollTo,
  onClose,
}: {
  program: Program;
  scrollTo?: "smr";
  onClose: () => void;
}) {
  return <EditProgramDialog program={program} scrollTo={scrollTo} onClose={onClose} />;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SectionHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="border-t border-border pt-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const textareaCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function EditProgramDialog({
  program,
  scrollTo,
  onClose,
}: {
  program: Program;
  scrollTo?: "smr";
  onClose: () => void;
}) {
  const { updateProgram } = useAppData();
  const { toast } = useToast();

  // ── 기본 ──
  const [title, setTitle] = useState(program.title);
  const [section, setSection] = useState(program.section || SECTIONS[0]);
  const [targetAge, setTargetAge] = useState<TargetAge>(program.targetAge);
  // ── 파이프라인 분기 (코어 파이프라인 트랙 · 씬 청크 크기·shot 임계·recommend 팩 결정) ──
  const [pipelineGenre, setPipelineGenre] = useState<"" | "variety" | "drama">(
    program.pipelineGenre ?? "",
  );
  // ── 편성 상태 · 담당 · 권리 윈도우 (FLOWS F10) ──
  const [status, setStatus] = useState<ProgramStatus>(normalizeProgramStatus(program.status));
  const [owner, setOwner] = useState(program.owner ?? "");
  const [rightsUntil, setRightsUntil] = useState(program.rightsUntil ?? "");
  const [rightsNote, setRightsNote] = useState(program.rightsNote ?? "");
  const [endedDate, setEndedDate] = useState(program.endedDate ?? "");
  // ── 소개·방영·크레딧 ──
  const [synopsis, setSynopsis] = useState(program.synopsis ?? "");
  const [broadcaster, setBroadcaster] = useState(program.broadcaster ?? "");
  const [schedule, setSchedule] = useState(program.schedule ?? "");
  const [firstAiredDate, setFirstAiredDate] = useState(program.firstAiredDate ?? "");
  const [currentInfo, setCurrentInfo] = useState(program.currentInfo ?? "");
  const [director, setDirector] = useState(program.director ?? "");
  const [spinoff, setSpinoff] = useState(program.spinoff ?? "");
  const [awards, setAwards] = useState(program.awards ?? "");
  // ── 분위기 태그 ──
  const [moods, setMoods] = useState<string[]>(program.moods ?? []);
  const [newMood, setNewMood] = useState("");
  // ── 출연자 (EditCastDialog에서 이관 · 로컬 편집 → 저장 시 일괄 반영) ──
  const [cast, setCast] = useState<string[]>(program.cast ?? []);
  const [newName, setNewName] = useState("");
  // ── SMR ──
  const [programCode, setProgramCode] = useState(program.smr?.programCode ?? "");
  const [category, setCategory] = useState(program.smr?.category ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(program.smr?.weekdays ?? []);
  const [busy, setBusy] = useState(false);

  const codeError = programCode.length > 0 && !CODE_RE.test(programCode);
  const titleError = !title.trim();
  const canSave = !titleError && !codeError && !busy;

  function toggleDay(i: number) {
    setWeekdays((prev) => (prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i].sort((a, b) => a - b)));
  }
  function addMood() {
    const v = newMood.trim();
    if (!v || moods.includes(v)) return;
    setMoods([...moods, v]);
    setNewMood("");
  }
  function removeMood(v: string) {
    setMoods(moods.filter((m) => m !== v));
  }
  function addCast() {
    const v = newName.trim();
    if (!v) return;
    if (cast.includes(v)) {
      toast({ title: "이미 등록됨", description: `${v} 은(는) 이미 명단에 있음`, tone: "warn" });
      return;
    }
    setCast([...cast, v]);
    setNewName("");
    // 연속 등록 편의: 다음 입력 위해 focus 유지
    setTimeout(() => document.getElementById("new-cast-input")?.focus(), 0);
  }
  function removeCast(v: string) {
    setCast(cast.filter((c) => c !== v));
  }

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    try {
      // PATCH — 값을 비운 필드는 서버에서 제거(빈 문자열 = 삭제 시맨틱).
      await updateProgram(program.id, {
        title: title.trim(),
        section,
        targetAge,
        pipelineGenre: pipelineGenre || undefined,
        status,
        owner: owner.trim(),
        rightsUntil: rightsUntil.trim(),
        rightsNote: rightsNote.trim(),
        // 종영일은 종영 상태에서만 의미가 있다 — 상태를 되돌리면 같이 지운다.
        endedDate: status === "ended" ? endedDate.trim() : "",
        cast,
        synopsis: synopsis.trim(),
        broadcaster: broadcaster.trim(),
        schedule: schedule.trim(),
        firstAiredDate: firstAiredDate.trim(),
        currentInfo: currentInfo.trim(),
        director: director.trim(),
        spinoff: spinoff.trim(),
        awards: awards.trim(),
        moods,
        programCode: programCode.trim(),
        category,
        weekdays,
      });
      toast({ title: "저장됨", description: title.trim(), tone: "done" });
      onClose();
    } catch (err) {
      toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} aria-hidden />
      <div className="relative flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-input bg-popover shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">프로그램 정보</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{program.title}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-4">
          {/* ── 기본 정보 ── */}
          <div className="space-y-3">
            <Field label="프로그램 제목">
              <input
                autoFocus={scrollTo !== "smr"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 나는 SOLO"
                className={cn(inputCls, titleError && "border-status-error focus-visible:ring-status-error")}
              />
              {titleError && <div className="mt-1 text-[11px] text-status-error">제목은 비울 수 없습니다.</div>}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="장르">
                <select value={section} onChange={(e) => setSection(e.target.value)} className={inputCls}>
                  {SECTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="시청 등급">
                <select
                  value={targetAge}
                  onChange={(e) => setTargetAge(Number(e.target.value) as TargetAge)}
                  className={inputCls}
                >
                  {TARGET_AGES.map((a) => (
                    <option key={a} value={a}>{targetAgeLabel(a)}</option>
                  ))}
                </select>
              </Field>
            </div>

            {/* 파이프라인 트랙 — 표시용 장르(section)와 별개로 코어 파이프라인 분기 결정. */}
            <Field
              label="파이프라인 트랙"
              hint="씬 청크 크기·shot 임계·recommend 프롬프트 팩 결정 (예능: 코너 단위 3분·잔컷 무시 · 드라마: 서사 5분·씬 컷 민감)"
            >
              <select
                value={pipelineGenre}
                onChange={(e) => setPipelineGenre(e.target.value as "" | "variety" | "drama")}
                className={inputCls}
              >
                <option value="">자동 판정 (AI가 결정)</option>
                <option value="variety">예능 (variety)</option>
                <option value="drama">드라마 (drama)</option>
              </select>
            </Field>
          </div>

          {/* ── 소개 ── */}
          <div className="space-y-3">
            <SectionHeader label="소개" hint="한두 문단 정도의 프로그램 시놉시스." />
            <Field label="시놉시스">
              <textarea
                value={synopsis}
                onChange={(e) => setSynopsis(e.target.value)}
                placeholder="예: 결혼을 간절히 원하는 솔로 남녀들이 모여 사랑을 찾기 위해 고군분투하는 극사실주의 데이팅 프로그램."
                rows={4}
                className={textareaCls}
              />
            </Field>
          </div>

          {/* ── 방영 정보 ── */}
          <div className="space-y-3">
            <SectionHeader label="방영 정보" hint="채널·편성 시간·첫 방송 등." />
            <div className="grid grid-cols-2 gap-3">
              <Field label="방송 채널">
                <input
                  value={broadcaster}
                  onChange={(e) => setBroadcaster(e.target.value)}
                  placeholder="예: ENA · SBS플러스"
                  className={inputCls}
                />
              </Field>
              <Field label="편성">
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="예: 수 밤 10:30"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="첫 방송">
                <input
                  value={firstAiredDate}
                  onChange={(e) => setFirstAiredDate(e.target.value)}
                  placeholder="예: 2021.07.14"
                  className={inputCls}
                />
              </Field>
              <Field label="현재 진행">
                <input
                  value={currentInfo}
                  onChange={(e) => setCurrentInfo(e.target.value)}
                  placeholder="예: 25기 · 191회~"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          {/* ── 편성 상태 · 담당 · 권리 (FLOWS F10) ── */}
          <div className="space-y-3">
            <SectionHeader
              label="편성 · 담당 · 권리"
              hint="상태는 사람이 지정합니다 — 결방·시즌 종료는 날짜로 판정되지 않습니다."
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="편성 상태">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ProgramStatus)}
                  className={inputCls}
                >
                  {PROGRAM_STATUSES.map((s) => (
                    <option key={s} value={s}>{PROGRAM_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </Field>
              <Field label="담당 PD" hint="프로그램 목록의 ‘내 담당만’ 기준">
                <input
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="예: 김선우 PD"
                  className={inputCls}
                />
              </Field>
            </div>
            {status === "ended" && (
              <Field label="종영일">
                <input
                  type="date"
                  value={endedDate}
                  onChange={(e) => setEndedDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="디지털 권리 만료일" hint="임박하면 카드가 경고 톤">
                <input
                  type="date"
                  value={rightsUntil}
                  onChange={(e) => setRightsUntil(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="권리 메모">
                <input
                  value={rightsNote}
                  onChange={(e) => setRightsNote(e.target.value)}
                  placeholder="예: 해외 배포 불가 · 국내만"
                  className={inputCls}
                />
              </Field>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              만료일이 지나도 배포가 자동으로 막히지는 않습니다. 게이트는 사람이 등록한
              권리·심의 이슈로만 걸립니다 — 여기 값은 경고 표시까지입니다.
            </p>
          </div>

          {/* ── 크레딧 ── */}
          <div className="space-y-3">
            <SectionHeader label="크레딧" />
            <Field label="연출">
              <input
                value={director}
                onChange={(e) => setDirector(e.target.value)}
                placeholder="예: 남규홍"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="스핀오프">
                <input
                  value={spinoff}
                  onChange={(e) => setSpinoff(e.target.value)}
                  placeholder="예: 나는 SOLO, 그 후 사랑은 계속된다"
                  className={inputCls}
                />
              </Field>
              <Field label="수상">
                <input
                  value={awards}
                  onChange={(e) => setAwards(e.target.value)}
                  placeholder="예: 2024 퍼스트브랜드 대상"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          {/* ── 분위기 태그 ── */}
          <div className="space-y-3">
            <SectionHeader label="분위기 태그" hint="프로그램을 대표하는 키워드. Enter로 추가." />
            <div className="flex gap-2">
              <input
                value={newMood}
                onChange={(e) => setNewMood(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMood();
                  }
                }}
                placeholder="예: 극사실주의"
                className={inputCls}
              />
              <Button size="sm" variant="outline" onClick={addMood} disabled={!newMood.trim()}>
                <Plus /> 추가
              </Button>
            </div>
            {moods.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {moods.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
                  >
                    #{m}
                    <button
                      onClick={() => removeMood(m)}
                      className="text-muted-foreground hover:text-status-warn"
                      title="삭제"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── 출연자 ── */}
          <div className="space-y-3">
            <SectionHeader
              label="출연자"
              hint="refine speaker 라벨링·recommend 프롬프트의 primary source. 다음 재분석부터 반영."
            />
            <div>
              <div className="mb-1.5 text-[11.5px] font-semibold text-muted-foreground">이름 추가</div>
              <div className="flex gap-2">
                <input
                  id="new-cast-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCast();
                    }
                  }}
                  placeholder="예: 은규"
                  className={inputCls}
                />
                <Button size="sm" onClick={addCast} disabled={!newName.trim()}>
                  <Plus /> 추가
                </Button>
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[11.5px] font-semibold text-muted-foreground">등록된 명단</span>
                <span className="text-[11px] tabular-nums text-muted-foreground/70">{cast.length}명</span>
              </div>
              {cast.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                  아직 등록된 출연자가 없어요. 위에 이름을 입력하고 Enter.
                </div>
              ) : (
                <ul className="space-y-1">
                  {cast.map((name) => (
                    <li
                      key={name}
                      className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-1.5"
                    >
                      <span className="text-[13px] font-semibold">{name}</span>
                      <button
                        onClick={() => removeCast(name)}
                        title="삭제"
                        className="text-lg leading-none text-muted-foreground hover:text-status-warn"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── SMR 피드 정보 ── */}
          <div
            ref={(el) => {
              if (el && scrollTo === "smr") el.scrollIntoView({ block: "start", behavior: "smooth" });
            }}
            className="space-y-3"
          >
            <SectionHeader
              label="SMR 피드 정보"
              hint="네이버 SMR 배포에 필요한 프로그램 레벨 메타. 이 값이 모여야 클립이 SMR 피드에 포함됩니다."
            />

            <div className="grid grid-cols-2 gap-3">
              <Field label="프로그램 코드" hint="영문 소문자·숫자">
                <input
                  autoFocus={scrollTo === "smr"}
                  value={programCode}
                  onChange={(e) => setProgramCode(e.target.value)}
                  placeholder="jamsi"
                  className={cn(inputCls, codeError && "border-status-error focus-visible:ring-status-error")}
                />
                {codeError && (
                  <div className="mt-1 text-[11px] text-status-error">영문 소문자·숫자만 사용할 수 있습니다.</div>
                )}
              </Field>
              <Field label="카테고리" hint="SMR 코드">
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                  <option value="">선택 안 함</option>
                  {SMR_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="편성 요일" hint="방송 요일 선택">
              <div className="flex gap-1.5">
                {WEEKDAYS.map((w, i) => {
                  const on = weekdays.includes(i);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={cn(
                        "size-9 rounded-md border text-sm font-medium transition-colors",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:bg-accent/40",
                      )}
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
            </Field>

            <p className="text-[11px] text-muted-foreground/70">
              포스터·프로그램 썸네일 이미지 등록은 아직 준비 중입니다.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {busy ? <Loader2 className="animate-spin" /> : <Info />}
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

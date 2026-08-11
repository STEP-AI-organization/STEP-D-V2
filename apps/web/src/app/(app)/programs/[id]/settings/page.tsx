"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  autofillProgram, syncProgramFromAnalysis, type AutofillProgramResult,
  fetchThumbnailStyle, trainThumbnailStyle, fetchCastPhotos, uploadCastPhoto,
  deleteCastPhotos, type ThumbnailStyleProfile, type CastPhotoEntry,
} from "@/lib/data/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/lib/data/store";
import { TARGET_AGES, targetAgeLabel, type TargetAge } from "@/lib/constants";
import { WEEKDAYS } from "@/lib/reserve-date";
import { programSmrChecks } from "@/lib/publish/requirements";
import {
  PROGRAM_STATUSES,
  PROGRAM_STATUS_LABEL,
  normalizeProgramStatus,
} from "@/lib/programs";
import type { Program, ProgramStatus } from "@/lib/types";

const SECTIONS = ["드라마/영화", "예능", "뮤직", "시사", "교양", "라이프", "스포츠", "게임", "어린이", "뉴스", "애니"];
const SMR_CATEGORIES = ["01", "02", "03"];
const CODE_RE = /^[a-z0-9]+$/;

/** 이미지 파일을 data URL로. 사이즈 상한 초과 시 alert 후 reject. */
async function fileToDataUrl(file: File, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) {
    alert(`파일이 너무 큽니다 (${Math.round(file.size / 1024)} KB > ${Math.round(maxBytes / 1024)} KB).`);
    return null;
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const textareaCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function ProgramDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { programs, episodes, updateProgram, deleteProgram, loading } = useAppData();
  const { toast } = useToast();
  const program = programs.find((p) => p.id === params.id);
  const programEpisodes = useMemo(
    () => (program ? episodes.filter((e) => e.programId === program.id) : []),
    [program, episodes],
  );

  if (loading && !program) {
    return <div className="p-8 text-sm text-muted-foreground">불러오는 중…</div>;
  }
  if (!program) {
    return (
      <div className="p-8">
        <div className="text-sm text-muted-foreground">프로그램을 찾을 수 없어요.</div>
        <Link href="/programs" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="size-4" /> 프로그램 목록
        </Link>
      </div>
    );
  }
  return (
    <ProgramDetailInner
      program={program}
      episodeCount={programEpisodes.length}
      onSave={updateProgram}
      onDelete={deleteProgram}
      onDone={() => router.push("/programs")}
      onOpenToast={toast}
    />
  );
}

type ToastFn = ReturnType<typeof useToast>["toast"];

function ProgramDetailInner({
  program,
  episodeCount,
  onSave,
  onDelete,
  onDone,
  onOpenToast,
}: {
  program: Program;
  episodeCount: number;
  onSave: ReturnType<typeof useAppData>["updateProgram"];
  onDelete: ReturnType<typeof useAppData>["deleteProgram"];
  onDone: () => void;
  onOpenToast: ToastFn;
}) {
  // ── 편집 상태 (로컬) — 저장 버튼 눌러야 서버 반영. 새로고침 시 서버 값으로 리셋. ──
  const [title, setTitle] = useState(program.title);
  const [section, setSection] = useState(program.section || SECTIONS[0]);
  const [targetAge, setTargetAge] = useState<TargetAge>(program.targetAge);
  // 편성 상태·담당·권리·파이프라인 트랙 — 목록 필터(종영·편성 예정·내 담당만)와
  // 홈 배지(분석 트랙·권리 만료)가 전부 이 값들을 읽는다. 여기가 유일한 입력 경로다.
  const [status, setStatus] = useState<ProgramStatus>(normalizeProgramStatus(program.status));
  const [owner, setOwner] = useState(program.owner ?? "");
  const [pipelineGenre, setPipelineGenre] = useState<"" | "variety" | "drama">(
    program.pipelineGenre ?? "",
  );
  const [rightsUntil, setRightsUntil] = useState(program.rightsUntil ?? "");
  const [rightsNote, setRightsNote] = useState(program.rightsNote ?? "");
  const [endedDate, setEndedDate] = useState(program.endedDate ?? "");
  const [synopsis, setSynopsis] = useState(program.synopsis ?? "");
  const [broadcaster, setBroadcaster] = useState(program.broadcaster ?? "");
  const [schedule, setSchedule] = useState(program.schedule ?? "");
  const [firstAiredDate, setFirstAiredDate] = useState(program.firstAiredDate ?? "");
  const [currentInfo, setCurrentInfo] = useState(program.currentInfo ?? "");
  const [director, setDirector] = useState(program.director ?? "");
  const [spinoff, setSpinoff] = useState(program.spinoff ?? "");
  const [awards, setAwards] = useState(program.awards ?? "");
  const [moods, setMoods] = useState<string[]>(program.moods ?? []);
  const [newMood, setNewMood] = useState("");
  const [cast, setCast] = useState<string[]>(program.cast ?? []);
  const [newName, setNewName] = useState("");
  const [castPhotos, setCastPhotos] = useState<Record<string, string>>(program.castPhotos ?? {});
  const [posterImageDataUrl, setPosterImageDataUrl] = useState(program.posterImageDataUrl ?? "");
  const [programCode, setProgramCode] = useState(program.smr?.programCode ?? "");
  const [category, setCategory] = useState(program.smr?.category ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(program.smr?.weekdays ?? []);
  const [busy, setBusy] = useState(false);
  // AI 자동 채움 결과 (마지막 실행 · 근거 URL 노출용 · 페이지 새로고침 시 사라짐)
  const [autofilling, setAutofilling] = useState(false);
  const [lastAutofill, setLastAutofill] = useState<AutofillProgramResult | null>(null);
  const [autofillApplied, setAutofillApplied] = useState<string[]>([]);
  // 질문 다이얼로그를 닫는 기준. applied 개수로 판단하면 "적용 0개"일 때 영영 안 닫힌다.
  const [autofillResolved, setAutofillResolved] = useState(false);
  // 얼굴 분석 → program 수동 sync
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function runDelete() {
    const msg =
      episodeCount > 0
        ? `프로그램 "${program.title}"과 회차 ${episodeCount}개(그리고 미디어·추천·클립·GCS 파일 전부)를 완전히 삭제합니다. 되돌릴 수 없습니다.`
        : `프로그램 "${program.title}"을 완전히 삭제합니다. 되돌릴 수 없습니다.`;
    if (!confirm(msg)) return;
    setDeleting(true);
    try {
      await onDelete(program.id);
      onOpenToast({ title: "삭제됨", description: program.title, tone: "done" });
      onDone();
    } catch (err) {
      onOpenToast({
        title: "삭제 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setDeleting(false);
    }
  }

  // 다른 세션·서버가 program을 업데이트하면 그대로 반영 (사용자가 편집 중이면 조심 — 초기값만 세팅).
  const hydratedRef = useHydratedRef(program.id);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    setTitle(program.title);
    setSection(program.section || SECTIONS[0]);
    setTargetAge(program.targetAge);
    setStatus(normalizeProgramStatus(program.status));
    setOwner(program.owner ?? "");
    setPipelineGenre(program.pipelineGenre ?? "");
    setRightsUntil(program.rightsUntil ?? "");
    setRightsNote(program.rightsNote ?? "");
    setEndedDate(program.endedDate ?? "");
    setSynopsis(program.synopsis ?? "");
    setBroadcaster(program.broadcaster ?? "");
    setSchedule(program.schedule ?? "");
    setFirstAiredDate(program.firstAiredDate ?? "");
    setCurrentInfo(program.currentInfo ?? "");
    setDirector(program.director ?? "");
    setSpinoff(program.spinoff ?? "");
    setAwards(program.awards ?? "");
    setMoods(program.moods ?? []);
    setCast(program.cast ?? []);
    setCastPhotos(program.castPhotos ?? {});
    setPosterImageDataUrl(program.posterImageDataUrl ?? "");
    setProgramCode(program.smr?.programCode ?? "");
    setCategory(program.smr?.category ?? "");
    setWeekdays(program.smr?.weekdays ?? []);
  }, [
    program.id, program.title, program.section, program.targetAge,
    program.status, program.owner, program.pipelineGenre,
    program.rightsUntil, program.rightsNote, program.endedDate,
    program.synopsis, program.broadcaster, program.schedule, program.firstAiredDate,
    program.currentInfo, program.director, program.spinoff, program.awards,
    program.moods, program.cast, program.castPhotos, program.posterImageDataUrl,
    program.smr?.programCode, program.smr?.category, program.smr?.weekdays,
    hydratedRef,
  ]);

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
  function addCast() {
    const v = newName.trim();
    if (!v) return;
    if (cast.includes(v)) {
      onOpenToast({ title: "이미 등록됨", description: `${v} 은(는) 이미 명단에 있음`, tone: "warn" });
      return;
    }
    setCast([...cast, v]);
    setNewName("");
    setTimeout(() => document.getElementById("new-cast-input")?.focus(), 0);
  }
  function removeCast(name: string) {
    setCast(cast.filter((c) => c !== name));
    // 해당 인물의 사진 매핑도 함께 제거
    if (castPhotos[name]) {
      const { [name]: _drop, ...rest } = castPhotos;
      setCastPhotos(rest);
    }
  }
  async function setCastPhoto(name: string, file: File) {
    const dataUrl = await fileToDataUrl(file, 256 * 1024);
    if (!dataUrl) return;
    setCastPhotos({ ...castPhotos, [name]: dataUrl });
  }
  function removeCastPhoto(name: string) {
    const { [name]: _drop, ...rest } = castPhotos;
    setCastPhotos(rest);
  }
  async function setPoster(file: File) {
    const dataUrl = await fileToDataUrl(file, 1024 * 1024);
    if (!dataUrl) return;
    setPosterImageDataUrl(dataUrl);
  }

  async function runSyncFromAnalysis() {
    setSyncing(true);
    try {
      const r = await syncProgramFromAnalysis(program.id);
      if (!r.workDirExists) {
        onOpenToast({ title: "분석 데이터 없음",
          description: "이 프로그램의 최근 분석 작업 폴더가 삭제됐거나 아직 없음. 회차 분석부터 실행하세요.",
          tone: "warn" });
        return;
      }
      const added = r.addedNames.length + r.addedPhotos.length;
      onOpenToast({
        title: added ? `동기화 완료 · ${added}건 반영` : "동기화 완료 · 새로 반영할 것 없음",
        description: [
          r.addedNames.length ? `이름 +${r.addedNames.length}: ${r.addedNames.join(",")}` : "",
          r.addedPhotos.length ? `사진 +${r.addedPhotos.length}: ${r.addedPhotos.join(",")}` : "",
        ].filter(Boolean).join(" · ") || "이미 최신 상태",
        tone: added ? "done" : "warn",
      });
      // 페이지 재로드로 최신 program 반영 (또는 useAppData refresh)
      if (added) setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      onOpenToast({ title: "동기화 실패",
        description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setSyncing(false);
    }
  }

  async function runAutofill() {
    if (!title.trim()) {
      onOpenToast({ title: "제목이 필요합니다", description: "먼저 프로그램 제목을 입력하세요", tone: "warn" });
      return;
    }
    setAutofilling(true);
    setLastAutofill(null);
    setAutofillApplied([]);
    setAutofillResolved(false);
    try {
      const result = await autofillProgram(program.id);
      setLastAutofill(result);
      // 질문 있으면 Dialog 열어 사용자 답 받고, 없으면 바로 draft 병합.
      if (result.questions && result.questions.length > 0) {
        // Dialog는 별도 컴포넌트에서 처리 (state로만 열림)
      } else {
        applyAutofill(result.draft, {});
      }
    } catch (err) {
      onOpenToast({
        title: "자동 채움 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setAutofilling(false);
    }
  }

  /** draft(팩트체크 통과) + answers(사용자가 dropped 필드에 준 답) 병합해서 state에 적용.
   *  빈 필드만 채움 — 사용자가 이미 편집한 값은 그대로. */
  function applyAutofill(
    draft: AutofillProgramResult["draft"],
    answers: Record<string, string>,
  ) {
    const applied: string[] = [];
    const val = (field: string): string => {
      const a = (answers[field] || "").trim();
      if (a) return a;
      const d = draft[field as keyof typeof draft];
      return typeof d === "string" ? d.trim() : "";
    };
    // 장르는 사람 몫이다 — 비어 있을 때만 채운다(다른 필드와 같은 규칙).
    // 서버는 프로그램 생성 시 section 을 "예능"으로 채우므로, 그 기본값은 자동 채움이 덮지 않는다.
    const s = val("section");
    if (s && SECTIONS.includes(s) && !program.section) {
      setSection(s); applied.push("장르");
    }
    if (val("synopsis") && !synopsis.trim()) { setSynopsis(val("synopsis")); applied.push("시놉시스"); }
    if (val("broadcaster") && !broadcaster.trim()) { setBroadcaster(val("broadcaster")); applied.push("방송채널"); }
    if (val("schedule") && !schedule.trim()) { setSchedule(val("schedule")); applied.push("편성"); }
    if (val("firstAiredDate") && !firstAiredDate.trim()) { setFirstAiredDate(val("firstAiredDate")); applied.push("첫 방송"); }
    if (val("currentInfo") && !currentInfo.trim()) { setCurrentInfo(val("currentInfo")); applied.push("현재 진행"); }
    if (val("director") && !director.trim()) { setDirector(val("director")); applied.push("연출"); }
    if (val("spinoff") && !spinoff.trim()) { setSpinoff(val("spinoff")); applied.push("스핀오프"); }
    if (val("awards") && !awards.trim()) { setAwards(val("awards")); applied.push("수상"); }
    // moods는 배열 · answers[moods]는 쉼표 구분 문자열로 받음
    const moodsAns = (answers.moods || "").split(",").map((s) => s.trim()).filter(Boolean);
    const moodsFromDraft = Array.isArray(draft.moods) ? draft.moods : [];
    const moodsFinal = moodsAns.length > 0 ? moodsAns : moodsFromDraft;
    if (moodsFinal.length > 0 && moods.length === 0) { setMoods(moodsFinal); applied.push("분위기 태그"); }

    setAutofillApplied(applied);
    setAutofillResolved(true);
    onOpenToast({
      title: applied.length ? `${applied.length}개 필드 채움` : "채울 필드 없음",
      description: applied.length ? applied.join(" · ") + " · 확인 후 저장" : "이미 다 채워져 있거나 근거 없음",
      tone: applied.length ? "done" : "warn",
    });
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave(program.id, {
        title: title.trim(),
        section,
        targetAge,
        status,
        owner: owner.trim(),
        // ""(자동 판정)도 그대로 보낸다 — 서버 PATCH 가 variety/drama 이외의 문자열을 받으면
        // pipelineGenre 필드를 삭제한다(= 자동 판정 복귀). 다른 문자열 필드와 같은 시맨틱.
        pipelineGenre,
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
        posterImageDataUrl,
        castPhotos,
        programCode: programCode.trim(),
        category,
        weekdays,
      });
      onOpenToast({ title: "저장됨", description: title.trim(), tone: "done" });
    } catch (err) {
      onOpenToast({
        title: "저장 실패",
        description: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const smrChecks = programSmrChecks(program);
  const smrMissing = smrChecks.filter((c) => !c.met).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-24">
      {/* 상단 액션 바 */}
      <div className="sticky top-0 z-20 -mx-6 flex items-center gap-3 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
        <Link
          href={`/programs/${program.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> 프로그램 홈
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title || "(제목 없음)"}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={runAutofill}
          disabled={autofilling || busy || !title.trim()}
          title="Gemini 웹 검색 + 팩트체크로 빈 필드 채움 (출연자·SMR 제외)"
        >
          {autofilling ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {autofilling ? "검색·팩트체크…" : "AI 자동 채움"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runDelete}
          disabled={deleting || busy}
          className="text-status-error hover:bg-status-error/10"
          title={episodeCount > 0 ? `이 프로그램과 회차 ${episodeCount}개(추천·클립·GCS 파일 포함) 완전 삭제` : "이 프로그램을 완전 삭제"}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {deleting ? "삭제 중…" : "삭제"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone} disabled={busy || deleting}>
          닫기
        </Button>
        <Button size="sm" onClick={save} disabled={!canSave || deleting}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          저장
        </Button>
      </div>

      {/* 자동 채움 질문 Dialog — questions 있을 때 */}
      {lastAutofill && lastAutofill.questions.length > 0 && !autofillResolved && (
        <AutofillQuestionsDialog
          title={title}
          result={lastAutofill}
          onCancel={() => { setLastAutofill(null); setAutofillResolved(false); }}
          onSubmit={(answers) => applyAutofill(lastAutofill.draft, answers)}
        />
      )}

      {/* 마지막 자동 채움 결과 · 근거 URL 노출 */}
      {lastAutofill && autofillResolved && (
        <section className="rounded-lg border border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-muted-foreground">
              AI 자동 채움 결과 · 적용 {autofillApplied.length}개
              {autofillApplied.length === 0 && " (이미 채워진 필드는 덮어쓰지 않습니다)"}
              {lastAutofill.dropped.length > 0 && ` · 근거 없어 제외 ${lastAutofill.dropped.length}개`}
            </div>
            <button
              onClick={() => { setLastAutofill(null); setAutofillApplied([]); setAutofillResolved(false); }}
              className="text-muted-foreground hover:text-foreground"
              title="닫기"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {autofillApplied.length > 0 && (
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              적용: {autofillApplied.join(" · ")}
            </div>
          )}
          {lastAutofill.dropped.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground/80">
              제외: {lastAutofill.dropped.join(" · ")}
            </div>
          )}
          {lastAutofill.sources.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">근거</div>
              <ul className="mt-1 space-y-0.5">
                {lastAutofill.sources.map((s, i) => (
                  <li key={i} className="text-[11px]">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-primary hover:underline"
                      title={s.url}
                    >
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* 히어로 — 포스터 + 타이틀 */}
      <section className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <PosterUpload
          value={posterImageDataUrl}
          onChange={setPoster}
          onClear={() => setPosterImageDataUrl("")}
        />
        <div className="min-w-0 space-y-3">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">제목</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 나는 SOLO"
              className={cn(inputCls, "h-12 text-xl font-semibold", titleError && "border-status-error focus-visible:ring-status-error")}
            />
            {titleError && <div className="mt-1 text-[11px] text-status-error">제목은 비울 수 없습니다.</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="muted">{section}</Badge>
            <Badge variant="muted">{targetAgeLabel(targetAge)}</Badge>
            <Badge variant="muted">회차 {episodeCount}</Badge>
            {smrMissing === 0 ? (
              <StatusBadge tone="done">SMR 피드 준비 완료</StatusBadge>
            ) : (
              <StatusBadge tone="warn">SMR {smrMissing}개 미충족</StatusBadge>
            )}
          </div>
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
          {moods.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {moods.map((m) => (
                <span key={m} className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                  #{m}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 소개 */}
      <Card title="소개" hint="한두 문단 프로그램 시놉시스">
        <textarea
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
          rows={5}
          placeholder="예: 결혼을 간절히 원하는 솔로 남녀들이 모여 사랑을 찾기 위해 고군분투하는 극사실주의 데이팅 프로그램."
          className={textareaCls}
        />
      </Card>

      {/* 방영 정보 */}
      <Card title="방영 정보" hint="채널·편성·첫 방송·현재 진행">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="방송 채널">
            <input value={broadcaster} onChange={(e) => setBroadcaster(e.target.value)} placeholder="예: ENA · SBS플러스" className={inputCls} />
          </Field>
          <Field label="편성">
            <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="예: 수 밤 10:30" className={inputCls} />
          </Field>
          <Field label="첫 방송">
            <input value={firstAiredDate} onChange={(e) => setFirstAiredDate(e.target.value)} placeholder="예: 2021.07.14" className={inputCls} />
          </Field>
          <Field label="현재 진행">
            <input value={currentInfo} onChange={(e) => setCurrentInfo(e.target.value)} placeholder="예: 25기 · 191회~" className={inputCls} />
          </Field>
        </div>
      </Card>

      {/* 편성 · 담당 · 권리 — 목록 필터와 홈 배지가 읽는 값들. 사람이 지정한다(자동 판정 없음). */}
      <Card
        title="편성 · 담당 · 권리"
        hint="프로그램 목록의 상태·‘내 담당만’ 필터와 홈의 트랙·권리 배지가 이 값을 그대로 읽습니다."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="편성 상태" hint="결방·시즌 종료는 날짜로 판정되지 않습니다">
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
          <Field label="담당 PD" hint="목록의 ‘내 담당만’ 비교 대상">
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="예: 김선우 PD"
              className={inputCls}
            />
          </Field>
        </div>

        {status === "ended" && (
          <div className="mt-3">
            <Field label="종영일">
              <input
                type="date"
                value={endedDate}
                onChange={(e) => setEndedDate(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        )}

        <div className="mt-3">
          <Field
            label="파이프라인 트랙"
            hint="씬 청크 크기·shot 임계·recommend 프롬프트 팩 결정 (예능: 코너 단위 · 드라마: 서사 단위)"
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

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="디지털 권리 만료일" hint="만료 30일 전부터 카드가 경고 톤">
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
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
          만료일이 지나도 배포가 자동으로 막히지는 않습니다 — 여기 값은 경고 표시까지입니다.
        </p>
      </Card>

      {/* 크레딧 */}
      <Card title="크레딧">
        <div className="space-y-3">
          <Field label="연출">
            <input value={director} onChange={(e) => setDirector(e.target.value)} placeholder="예: 남규홍" className={inputCls} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="스핀오프">
              <input value={spinoff} onChange={(e) => setSpinoff(e.target.value)} placeholder="예: 나는 SOLO, 그 후 사랑은 계속된다" className={inputCls} />
            </Field>
            <Field label="수상">
              <input value={awards} onChange={(e) => setAwards(e.target.value)} placeholder="예: 2024 퍼스트브랜드 대상" className={inputCls} />
            </Field>
          </div>
        </div>
      </Card>

      {/* 분위기 태그 */}
      <Card title="분위기 태그" hint="프로그램을 대표하는 키워드. Enter로 추가.">
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
          <div className="mt-2 flex flex-wrap gap-1.5">
            {moods.map((m) => (
              <span
                key={m}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs"
              >
                #{m}
                <button
                  onClick={() => setMoods(moods.filter((x) => x !== m))}
                  className="text-muted-foreground hover:text-status-warn"
                  title="삭제"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* 출연진 */}
      <Card
        title="출연진"
        hint="인물별 사진 · 이름. refine speaker 라벨링·recommend 프롬프트의 primary source. 다음 재분석부터 반영."
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-1 gap-2">
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
          <Button
            size="sm"
            variant="outline"
            onClick={runSyncFromAnalysis}
            disabled={syncing}
            title="최근 분석의 얼굴 클러스터 → 이름·사진 반영 (사진 비어있는 인물만 자동 채움)"
          >
            {syncing ? <Loader2 className="animate-spin" /> : <UserRound />}
            {syncing ? "동기화…" : "얼굴 분석 → 사진 반영"}
          </Button>
        </div>

        {cast.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            아직 등록된 출연자가 없어요. 위에 이름을 입력하고 Enter.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {cast.map((name) => (
              <CastCard
                key={name}
                name={name}
                photoDataUrl={castPhotos[name]}
                onPickPhoto={(file) => setCastPhoto(name, file)}
                onClearPhoto={() => removeCastPhoto(name)}
                onRemove={() => removeCast(name)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* 썸네일 엔진 — 프로그램마다 한 번 준비하면 이후 회차에 자동 적용된다 */}
      <ThumbnailEngineCard programId={program.id} programCast={cast} />

      {/* SMR 피드 */}
      <Card title="SMR 피드 정보" hint="네이버 SMR 배포에 필요한 프로그램 레벨 메타.">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="프로그램 코드" hint="영문 소문자·숫자">
            <input
              value={programCode}
              onChange={(e) => setProgramCode(e.target.value)}
              placeholder="jamsi"
              className={cn(inputCls, codeError && "border-status-error focus-visible:ring-status-error")}
            />
            {codeError && <div className="mt-1 text-[11px] text-status-error">영문 소문자·숫자만 사용할 수 있습니다.</div>}
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
      </Card>

      {/* 하단 저장 바 (스크롤 편의) */}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button variant="outline" size="sm" onClick={onDone} disabled={busy}>
          닫기
        </Button>
        <Button size="sm" onClick={save} disabled={!canSave}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          저장
        </Button>
      </div>
    </div>
  );
}

/** program.id가 바뀔 때 hydration을 다시 트리거하기 위한 ref helper. */
function useHydratedRef(programId: string) {
  const [ref] = useState<{ current: boolean }>({ current: false });
  useEffect(() => {
    ref.current = false;
  }, [programId, ref]);
  return ref;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

function PosterUpload({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <label
        className={cn(
          "group relative flex aspect-[2/3] w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-border bg-linear-to-br from-primary/20 to-primary/5 transition-colors hover:border-primary/50",
          !value && "bg-muted",
        )}
      >
        {value ? (
          <>
            <img src={value} alt="포스터" className="size-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-black/60 px-3 py-1.5 text-xs font-medium text-white">
                <Camera className="size-4" /> 다시 선택
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <Camera className="size-8 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">포스터 업로드</div>
              <div className="mt-0.5 text-[10px]">2:3 비율 · 최대 1MB</div>
            </div>
          </div>
        )}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) onChange(f);
          }}
        />
      </label>
      {value && (
        <button
          type="button"
          onClick={onClear}
          className="w-full text-[11px] text-muted-foreground hover:text-status-warn"
        >
          포스터 제거
        </button>
      )}
    </div>
  );
}

function CastCard({
  name,
  photoDataUrl,
  onPickPhoto,
  onClearPhoto,
  onRemove,
}: {
  name: string;
  photoDataUrl?: string;
  onPickPhoto: (file: File) => void;
  onClearPhoto: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/20 p-3">
      <label className="group relative flex aspect-[3/4] w-24 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border bg-muted transition-colors hover:border-primary/50">
        {photoDataUrl ? (
          <img src={photoDataUrl} alt={name} className="size-full object-cover" />
        ) : (
          <UserRound className="size-10 text-muted-foreground" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          <Camera className="size-5 text-white" />
        </div>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) onPickPhoto(f);
          }}
        />
      </label>
      <div className="text-center">
        <div className="text-sm font-semibold">{name}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">최대 256KB</div>
      </div>
      <div className="flex items-center gap-1.5">
        {photoDataUrl && (
          <button
            onClick={onClearPhoto}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="사진 제거"
          >
            <X className="size-3.5" />
          </button>
        )}
        <button
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-status-warn"
          title="출연자 삭제"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 자동 채움 결과 · 확인 필요한 필드 질문 Dialog.
 *  각 질문에 대해 suggestion 라디오 or "기타(직접 입력)" · 답 제출 → onSubmit(answers). */
function AutofillQuestionsDialog({
  title,
  result,
  onCancel,
  onSubmit,
}: {
  title: string;
  result: AutofillProgramResult;
  onCancel: () => void;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  // 각 field별로 { picked: string | '__other__' | '__skip__', otherText: string }
  const [state, setState] = useState<Record<string, { picked: string; otherText: string }>>(() => {
    const init: Record<string, { picked: string; otherText: string }> = {};
    for (const q of result.questions) init[q.field] = { picked: "__skip__", otherText: "" };
    return init;
  });

  function submit() {
    const answers: Record<string, string> = {};
    for (const q of result.questions) {
      const s = state[q.field];
      if (!s || s.picked === "__skip__") continue;
      if (s.picked === "__other__") {
        const t = s.otherText.trim();
        if (t) answers[q.field] = t;
      } else {
        answers[q.field] = s.picked;
      }
    }
    onSubmit(answers);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col rounded-2xl border border-input bg-popover shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">AI 자동 채움 · 확인 필요</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {title} · 확인된 필드 {Object.keys(result.draft).length}개 · 확인 필요 {result.questions.length}개
            </p>
          </div>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          {result.questions.map((q) => {
            const s = state[q.field] || { picked: "__skip__", otherText: "" };
            return (
              <div key={q.field} className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                <div className="text-sm font-semibold">{q.question}</div>
                <div className="space-y-1.5">
                  {q.suggestions.map((sg) => (
                    <label key={sg} className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name={`ans-${q.field}`}
                        checked={s.picked === sg}
                        onChange={() => setState((p) => ({ ...p, [q.field]: { picked: sg, otherText: "" } }))}
                      />
                      <span>{sg}</span>
                    </label>
                  ))}
                  {q.allowOther && (
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="radio"
                        name={`ans-${q.field}`}
                        checked={s.picked === "__other__"}
                        onChange={() => setState((p) => ({ ...p, [q.field]: { picked: "__other__", otherText: p[q.field]?.otherText || "" } }))}
                      />
                      <div className="flex-1">
                        <span>기타 (직접 입력)</span>
                        {s.picked === "__other__" && (
                          <input
                            autoFocus
                            value={s.otherText}
                            onChange={(e) => setState((p) => ({ ...p, [q.field]: { picked: "__other__", otherText: e.target.value } }))}
                            placeholder="답변 입력"
                            className={cn(inputCls, "mt-1")}
                          />
                        )}
                      </div>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name={`ans-${q.field}`}
                      checked={s.picked === "__skip__"}
                      onChange={() => setState((p) => ({ ...p, [q.field]: { picked: "__skip__", otherText: "" } }))}
                    />
                    <span>모름 / 건너뛰기</span>
                  </label>
                </div>
              </div>
            );
          })}
          {result.sources.length > 0 && (
            <div className="rounded-md border border-border bg-muted/10 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                검색 근거 · {result.sources.length}개
              </div>
              <ul className="space-y-0.5">
                {result.sources.map((s, i) => (
                  <li key={i} className="text-[11px]">
                    <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline" title={s.url}>
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onCancel}>취소</Button>
          <Button size="sm" onClick={submit}>답변 반영</Button>
        </div>
      </div>
    </div>
  );
}


/**
 * 썸네일 엔진 준비 — 스타일 학습 + 출연자 등록.
 *
 * 둘 다 프로그램당 1회성이고, 이후 회차 썸네일 생성이 이걸 자동으로 물어간다.
 * 출연자는 사람이 등록한다 — 얼굴 자동 판정을 넣으면 틀렸을 때 조용히 지나간다.
 *
 * ⚠️ 위 '출연진' 카드와 저장소가 다르다. 출연진 = program 엔티티의 castPhotos(분석 프롬프트용),
 * 여기 = GCS cast 폴더(썸네일 합성용 원본). 서버에 둘을 잇는 코드가 없어서 한쪽에 올려도
 * 다른 쪽은 비어 있다 — 화면에서 그렇게 말해 준다(programCast 로 명단만 참고 표시).
 */
function ThumbnailEngineCard({
  programId,
  programCast,
}: {
  programId: string;
  programCast: string[];
}) {
  const { toast } = useToast();
  const [style, setStyle] = useState<ThumbnailStyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceUrl, setSourceUrl] = useState("");
  const [training, setTraining] = useState(false);
  const [cast, setCast] = useState<CastPhotoEntry[]>([]);
  const [castName, setCastName] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, c] = await Promise.all([
        fetchThumbnailStyle(programId).catch(() => null),
        fetchCastPhotos(programId).catch(() => []),
      ]);
      if (!alive) return;
      setStyle(s);
      setCast(c);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [programId]);

  async function onTrain() {
    const url = sourceUrl.trim();
    if (!url) { toast({ title: "재생목록 URL을 넣어주세요", tone: "error" }); return; }
    setTraining(true);
    try {
      await trainThumbnailStyle(programId, url);
      toast({ title: "스타일 학습을 시작했습니다", description: "수집·분석에 몇 분 걸립니다." });
    } catch (e) {
      toast({ title: "학습 요청 실패", description: String(e), tone: "error" });
    } finally {
      setTraining(false);
    }
  }

  async function onUpload(name: string, file: File) {
    try {
      await uploadCastPhoto(programId, name, file);
      setCast(await fetchCastPhotos(programId));
      toast({ title: `${name} 사진을 등록했습니다` });
    } catch (e) {
      toast({ title: "업로드 실패", description: String(e), tone: "error" });
    }
  }

  // ⚠️ api.ts deleteCastPhotos 는 !res.ok 를 던지지 않는다(현재 다른 패키지 소유).
  // 그래서 목록 재조회 결과로 실제 삭제 여부를 확인한 뒤에만 "삭제됨"이라고 말한다.
  async function onDeleteCast(name: string) {
    try {
      await deleteCastPhotos(programId, name);
      const next = await fetchCastPhotos(programId);
      setCast(next);
      if (next.some((c) => c.name === name)) {
        toast({ title: "삭제되지 않았습니다", description: `${name} 폴더가 그대로 남아 있습니다`, tone: "error" });
        return;
      }
      toast({ title: `${name} 사진을 삭제했습니다`, tone: "done" });
    } catch (e) {
      toast({ title: "삭제 실패", description: String(e), tone: "error" });
    }
  }

  const agg = (style?.aggregate ?? {}) as Record<string, any>;
  const first = (k: string) => (Array.isArray(agg[k]) && agg[k][0] ? String(agg[k][0][0]) : "");

  return (
    <Card
      title="썸네일 엔진"
      hint="프로그램마다 한 번 준비하면 이후 회차 썸네일에 자동 적용됩니다."
    >
      <div className="grid gap-5">
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">채널 스타일</div>
          {loading ? (
            <div className="text-sm text-muted-foreground">불러오는 중…</div>
          ) : style ? (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <div className="mb-1 flex items-center gap-2">
                <Badge>학습됨</Badge>
                <span className="text-xs text-muted-foreground">
                  {String(agg.sampleSize ?? "?")}장 분석
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                자막 {first("captionPosition")} {first("captionLines")}줄 ·{" "}
                {first("borderDesc") || "테두리 없음"} · 로고 {first("logoPosition")} ·{" "}
                {first("tone")}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{style.prompt}</p>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">아직 학습하지 않았습니다.</div>
          )}

          <div className="mt-3 flex gap-2">
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://www.youtube.com/playlist?list=..."
              className={cn(inputCls, "flex-1")}
            />
            <Button onClick={onTrain} disabled={training}>
              {training ? "요청 중…" : style ? "다시 학습" : "스타일 학습"}
            </Button>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            재생목록 URL을 권합니다. 채널 전체는 다른 프로그램이 섞여 톤이 뭉개집니다.
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            출연자 사진 · 썸네일에 들어갈 인물
          </div>
          <div className="mb-2 text-[11px] leading-relaxed text-muted-foreground/80">
            위 ‘출연진’ 카드와는 <b>별개의 저장소</b>입니다 — 저기는 분석용 이름·사진,
            여기는 썸네일 합성용 원본 사진입니다. 한쪽에 올려도 다른 쪽에는 반영되지 않습니다.
            {programCast.length > 0 && ` (출연진 명단 ${programCast.length}명: ${programCast.join(", ")})`}
          </div>
          {cast.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              썸네일용으로 등록된 사진이 없습니다. 등록하지 않으면 썸네일 생성이 중단됩니다.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {cast.map((c) => (
                <span key={c.name}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs">
                  {c.name}
                  <span className="text-muted-foreground">{c.photos}장</span>
                  <button
                    onClick={() => void onDeleteCast(c.name)}
                    className="text-muted-foreground hover:text-status-error"
                    aria-label={`${c.name} 삭제`}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <input
              value={castName}
              onChange={(e) => setCastName(e.target.value)}
              placeholder="출연자 이름 (기획에 쓰이는 이름과 같게)"
              className={cn(inputCls, "flex-1")}
            />
            <label className={cn(
              "inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-2 text-sm",
              !castName.trim() && "pointer-events-none opacity-50",
            )}>
              사진 추가
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && castName.trim()) void onUpload(castName.trim(), f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            1인당 1~3장 · 얼굴이 크게 나온 사진. 이름은 폴더명이자 매칭 키입니다.
          </div>
        </div>
      </div>
    </Card>
  );
}

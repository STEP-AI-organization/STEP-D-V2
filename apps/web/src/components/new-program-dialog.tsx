"use client";

import { useState, type ReactNode } from "react";
import { Plus, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { TARGET_AGES, targetAgeLabel } from "@/lib/constants";
import { WEEKDAYS } from "@/lib/reserve-date";

// 장르(section) — SMR clipCategory 01–11 (docs/reference/glossary.md).
const SECTIONS = ["드라마/영화", "예능", "뮤직", "시사", "교양", "라이프", "스포츠", "게임", "어린이", "뉴스", "애니"];
// SMR 프로그램 카테고리 코드(01/02/03). 라벨 미확정 — 코드로 노출.
const SMR_CATEGORIES = ["01", "02", "03"];

const CODE_RE = /^[a-z0-9]+$/;

/** Header action on /programs: create the content root a program needs before any upload. */
export function NewProgramButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        ＋ 새 프로그램
      </Button>
      {open && <NewProgramDialog onClose={() => setOpen(false)} />}
    </>
  );
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

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function NewProgramDialog({ onClose }: { onClose: () => void }) {
  const { createProgram } = useAppData();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [section, setSection] = useState(SECTIONS[0]);
  const [targetAge, setTargetAge] = useState<number>(0);
  const [cast, setCast] = useState("");
  const [programCode, setProgramCode] = useState("");
  const [category, setCategory] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const codeError = programCode.length > 0 && !CODE_RE.test(programCode);
  const canSave = Boolean(title.trim()) && !codeError && !busy;

  function toggleDay(i: number) {
    setWeekdays((prev) => (prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i].sort((a, b) => a - b)));
  }

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    try {
      await createProgram({
        title: title.trim(),
        section,
        targetAge,
        cast: cast
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        programCode: programCode.trim() || undefined,
        category: category || undefined,
        weekdays: weekdays.length ? weekdays : undefined,
      });
      toast({ title: "프로그램 생성됨", description: title.trim(), tone: "done" });
      onClose();
    } catch (err) {
      toast({ title: "생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} aria-hidden />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-input bg-popover shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">새 프로그램</h2>
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
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 전지적 참견 시점"
                className={inputCls}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="장르">
                <select value={section} onChange={(e) => setSection(e.target.value)} className={inputCls}>
                  {SECTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="시청 등급">
                <select
                  value={targetAge}
                  onChange={(e) => setTargetAge(Number(e.target.value))}
                  className={inputCls}
                >
                  {TARGET_AGES.map((a) => (
                    <option key={a} value={a}>
                      {targetAgeLabel(a)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="출연자" hint="쉼표로 구분 · 선택">
              <input
                value={cast}
                onChange={(e) => setCast(e.target.value)}
                placeholder="이영자, 홍현희"
                className={inputCls}
              />
            </Field>
          </div>

          {/* ── SMR 피드 정보 ── */}
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SMR 피드 정보</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                네이버 SMR 배포에 필요 · 지금 비워도 프로그램은 생성됩니다(배포 전 채우면 됨).
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="프로그램 코드" hint="영문 소문자·숫자">
                <input
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
                    <option key={c} value={c}>
                      {c}
                    </option>
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
              포스터·프로그램 썸네일 이미지는 프로그램 생성 후 등록합니다.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            만들기
          </Button>
        </div>
      </div>
    </div>
  );
}

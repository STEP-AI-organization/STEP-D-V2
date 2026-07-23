"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import type { Program } from "@/lib/types";

/** Header/inline button that opens a cast editor for one program.
 *  cast는 refine speaker 라벨링·recommend 프롬프트에 primary source로 들어감 — 다음 재분석부터 반영. */
export function EditCastButton({ program }: { program: Program }) {
  const [open, setOpen] = useState(false);
  const cast = program.cast ?? [];
  const empty = cast.length === 0;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        title="이 프로그램의 출연자 명단 편집 — refine이 이 이름으로 speaker 라벨링"
        style={empty ? { color: "var(--color-status-warn)", borderColor: "var(--color-status-warn)" } : undefined}
      >
        출연자 <span className="mono ml-0.5 tabular-nums">{cast.length}</span>
      </Button>
      {open && <EditCastDialog program={program} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditCastDialog({ program, onClose }: { program: Program; onClose: () => void }) {
  const { updateProgram } = useAppData();
  const { toast } = useToast();
  // 한 명씩 개별 관리 (2026-07-23 · 사용자 방향: 쉼표 구분 헷갈림 → 한 명씩 등록·삭제).
  const [cast, setCast] = useState<string[]>(program.cast ?? []);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function persist(next: string[]) {
    setBusy(true);
    try {
      await updateProgram(program.id, { cast: next });
      setCast(next);
    } catch (e) {
      toast({ title: "저장 실패", description: e instanceof Error ? e.message : "다시 시도해 주세요.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function addName() {
    const name = newName.trim();
    if (!name) return;
    if (cast.includes(name)) {
      toast({ title: "이미 등록됨", description: `${name} 은(는) 이미 명단에 있음`, tone: "warn" });
      return;
    }
    const next = [...cast, name];
    await persist(next);
    setNewName("");
    // 연속 등록 편의: 저장 후 입력 필드 다시 포커스
    setTimeout(() => document.getElementById("new-cast-input")?.focus(), 0);
  }

  async function removeName(name: string) {
    const next = cast.filter((n) => n !== name);
    await persist(next);
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-70 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[520px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <div>
            <div className="text-[15px] font-bold">출연자 편집</div>
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">{program.title}</div>
          </div>
          <span className="flex-1" />
          <button onClick={onClose} className="text-lg leading-none text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5">
          <div className="rounded-md border border-brand/25 bg-brand/5 px-3 py-2.5">
            <div className="mb-1 text-[11.5px] font-bold text-brand">refine speaker 라벨링의 primary source</div>
            <div className="text-[11.5px] leading-relaxed text-muted-foreground">
              한 명씩 이름 입력 · Enter로 추가 · 각 항목 옆 ✕로 삭제. 저장은 자동 (변경 즉시 서버 반영).
              STT 오인식(예: 옥순→옥수)은 이 명단 기준으로 자동 정규화 시도. 명단에 없는 인물은
              M1/F1... fallback으로 남음.
            </div>
          </div>

          {/* 이름 입력 */}
          <div>
            <div className="mb-1 text-[11.5px] font-semibold text-muted-foreground">이름 추가</div>
            <div className="flex gap-2">
              <input
                id="new-cast-input"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addName();
                  }
                }}
                placeholder="예: 은규"
                disabled={busy}
                className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button size="sm" onClick={addName} disabled={busy || !newName.trim()}>
                추가
              </Button>
            </div>
          </div>

          {/* 등록된 명단 */}
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
                      onClick={() => removeName(name)}
                      disabled={busy}
                      title="삭제"
                      className="text-lg leading-none text-muted-foreground hover:text-status-warn disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}

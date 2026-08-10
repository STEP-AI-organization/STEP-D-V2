"use client";

/**
 * 권리·심의 이슈 패널 — 사람이 이슈를 등록하고 해제하는 유일한 자리 (FLOWS F3).
 *
 * 회차·추천 구간·미디어 어디서나 같은 패널을 쓴다. 화면마다 다른 UI 를 만들면
 * "여기서는 되는데 저기서는 안 되는" 상태가 생기고, 결국 어느 쪽이 진짜인지 모르게 된다.
 *
 * 여기서 지키는 것:
 *  - **자동 판정 없음.** 등록 버튼을 사람이 눌러야 이슈가 생긴다.
 *  - **미판정 ≠ 이슈 없음.** 이슈가 0건이어도 "이슈 없음" 판정을 따로 눌러야 통과한다.
 *  - **조건부 해제에는 근거가 필요하다.** 근거 없이 해제 버튼을 못 누르게 막고,
 *    서버도 같은 규칙으로 한 번 더 막는다.
 */
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  createRightsIssue,
  deleteRightsIssue,
  fetchGate,
  judgeNoIssues,
  updateRightsIssue,
  type GateResult,
  type GateSubjectType,
  type IssueKind,
  type RightsIssue,
} from "@/lib/data/api";
import {
  GATE_TAG,
  ISSUE_COLOR,
  ISSUE_KINDS,
  ISSUE_KIND_LABEL,
  REGISTERABLE_RESOLUTIONS,
  RESOLUTION_LABEL,
  fmtTime,
} from "@/lib/gate-ui";

export function IssuePanel({
  subjectType,
  subjectId,
  title,
  hint,
  bandDefault,
  actor: actorProp,
  onGateChange,
}: {
  subjectType: GateSubjectType;
  subjectId: string;
  title: string;
  hint?: string;
  /** 구간 이슈의 기본 범위 (추천 구간·미디어에서). */
  bandDefault?: { start: number; end: number };
  actor?: string;
  onGateChange?: (gate: GateResult) => void;
}) {
  const sessionName = useSession().user.name;
  const actor = actorProp ?? sessionName;
  const { toast } = useToast();

  const [gate, setGate] = useState<GateResult | null>(null);
  const [issues, setIssues] = useState<RightsIssue[]>([]);
  const [judged, setJudged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchGate(subjectType, subjectId);
      setGate(r.gate);
      setIssues(r.issues);
      setJudged(r.judged);
      setError(null);
      onGateChange?.(r.gate);
    } catch (err) {
      // 못 읽으면 "이슈 없음"으로 그리지 않는다 — 사유를 띄운다.
      setError(err instanceof Error ? err.message : String(err));
      setGate(null);
    }
  }, [subjectType, subjectId, onGateChange]);

  useEffect(() => { void load(); }, [load]);

  async function judge() {
    setBusy(true);
    try {
      await judgeNoIssues(subjectType, subjectId, actor, "검수 결과 이슈 없음");
      toast({ title: "이슈 없음으로 판정했습니다", description: `${actor} · 게이트가 열립니다.`, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "판정 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-card flex flex-col gap-2.5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="sd-serif text-[14px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {title}
        </span>
        {gate && <span className={GATE_TAG[gate.state]}>{gate.label}</span>}
        {error && <span className="sd-tag sd-tag--danger">게이트 확인 불가</span>}
        <button
          type="button"
          className="sd-btn ml-auto"
          onClick={() => setAdding((v) => !v)}
          disabled={busy}
        >
          {adding ? "취소" : "＋ 이슈 등록"}
        </button>
      </div>

      {hint && (
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
          {hint}
        </p>
      )}

      {error && (
        <p className="text-[11.5px]" style={{ color: "var(--sd-danger-strong)" }}>
          {error} — 통과 여부를 알 수 없으므로 배포는 막힙니다.
        </p>
      )}

      {gate && !gate.allowed && gate.reason && (
        <p className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
          {gate.reason}
        </p>
      )}

      {adding && (
        <IssueForm
          subjectType={subjectType}
          subjectId={subjectId}
          actor={actor}
          bandDefault={bandDefault}
          onDone={async () => { setAdding(false); await load(); }}
        />
      )}

      {issues.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          {judged ? (
            <>등록된 이슈 없음 · 사람이 판정함</>
          ) : (
            <>
              아직 검수 전입니다 — 이슈가 없다는 것도 판정이어야 합니다.
              <button type="button" className="sd-btn" onClick={judge} disabled={busy}>
                이슈 없음으로 판정
              </button>
            </>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {issues.map((i) => (
            <IssueRow key={i.id} issue={i} actor={actor} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueForm({
  subjectType,
  subjectId,
  actor,
  bandDefault,
  onDone,
}: {
  subjectType: GateSubjectType;
  subjectId: string;
  actor: string;
  bandDefault?: { start: number; end: number };
  onDone: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<IssueKind>("music");
  const [resolution, setResolution] = useState<"open" | "conditional" | "blocked">("open");
  const [note, setNote] = useState("");
  const [useBand, setUseBand] = useState(Boolean(bandDefault));
  const [start, setStart] = useState(String(bandDefault?.start ?? 0));
  const [end, setEnd] = useState(String(bandDefault?.end ?? 0));
  const [busy, setBusy] = useState(false);

  const s = Number(start);
  const e = Number(end);
  const bandValid = !useBand || (Number.isFinite(s) && Number.isFinite(e) && e > s);
  const canSave = note.trim().length > 0 && bandValid && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      await createRightsIssue({
        subjectType, subjectId, kind, resolution,
        ...(useBand ? { bandStart: s, bandEnd: e } : {}),
        note: note.trim(),
        actor,
      });
      await onDone();
    } catch (err) {
      toast({ title: "등록 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[5px] p-2.5"
      style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
    >
      <div className="flex flex-wrap gap-2">
        <select value={kind} onChange={(ev) => setKind(ev.target.value as IssueKind)} className="sd-input">
          {ISSUE_KINDS.map((k) => (
            <option key={k} value={k}>{ISSUE_KIND_LABEL[k]}</option>
          ))}
        </select>
        <select
          value={resolution}
          onChange={(ev) => setResolution(ev.target.value as "open" | "conditional" | "blocked")}
          className="sd-input"
        >
          {REGISTERABLE_RESOLUTIONS.map((r) => (
            <option key={r} value={r}>{RESOLUTION_LABEL[r]}</option>
          ))}
        </select>
      </div>

      <input
        value={note}
        onChange={(ev) => setNote(ev.target.value)}
        placeholder="무엇이 걸리는지 (예: 배경음악 미클리어 · 뒤쪽 일반인 얼굴)"
        className="sd-input w-full"
      />

      <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
        <input type="checkbox" checked={useBand} onChange={(ev) => setUseBand(ev.target.checked)} />
        구간 지정 (끄면 대상 전체에 걸립니다)
      </label>
      {useBand && (
        <div className="flex items-center gap-2">
          <input value={start} onChange={(ev) => setStart(ev.target.value)} className="sd-input w-[92px]" inputMode="decimal" />
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>초 →</span>
          <input value={end} onChange={(ev) => setEnd(ev.target.value)} className="sd-input w-[92px]" inputMode="decimal" />
          <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
            {Number.isFinite(s) && Number.isFinite(e) && e > s ? `${fmtTime(s)}–${fmtTime(e)}` : "구간이 올바르지 않습니다"}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          등록자 {actor} · 자동 판정이 아니라 사람의 기록으로 남습니다
        </span>
        <button type="button" className="sd-btn sd-btn-primary ml-auto" onClick={save} disabled={!canSave}>
          등록
        </button>
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  actor,
  onChanged,
}: {
  issue: RightsIssue;
  actor: string;
  onChanged: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [resolving, setResolving] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const resolved = issue.resolution === "resolved";
  const color = ISSUE_COLOR[issue.kind as keyof typeof ISSUE_COLOR] ?? "#8b877f";

  async function apply(resolution: "resolved" | "open") {
    setBusy(true);
    try {
      await updateRightsIssue(issue.id, { resolution, resolutionNote: reason.trim(), actor });
      setResolving(false);
      setReason("");
      await onChanged();
    } catch (err) {
      toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteRightsIssue(issue.id, actor);
      await onChanged();
    } catch (err) {
      toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-1.5 rounded-[4px] px-2.5 py-2"
      style={{ border: "1px solid var(--sd-border)", opacity: resolved ? 0.6 : 1 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block size-[8px] rounded-[2px]" style={{ background: color }} aria-hidden />
        <span className="text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
          {ISSUE_KIND_LABEL[issue.kind as keyof typeof ISSUE_KIND_LABEL] ?? issue.kind}
        </span>
        <span className="sd-tag">{RESOLUTION_LABEL[issue.resolution as keyof typeof RESOLUTION_LABEL] ?? issue.resolution}</span>
        {issue.bandStart != null && issue.bandEnd != null && (
          <span className="sd-tag sd-mono">{fmtTime(issue.bandStart)}–{fmtTime(issue.bandEnd)}</span>
        )}
        {issue.inheritedFrom && <span className="sd-tag">승계됨</span>}
      </div>

      {issue.note && (
        <div className="text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{issue.note}</div>
      )}
      <div className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
        등록 {issue.actor || "—"}
        {resolved && issue.resolvedBy && ` · 해제 ${issue.resolvedBy}`}
        {resolved && issue.resolutionNote && ` · 근거: ${issue.resolutionNote}`}
      </div>

      {resolving ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="해제 근거 (예: 블러 처리 완료 · 음원 교체 완료)"
            className="sd-input min-w-[240px] flex-1"
          />
          {/* 근거 두 글자 미만이면 서버가 400 을 준다. 여기서 미리 막아 왕복을 아낀다. */}
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={busy || reason.trim().length < 2}
            onClick={() => apply("resolved")}
          >
            해제
          </button>
          <button type="button" className="sd-btn" onClick={() => setResolving(false)} disabled={busy}>
            취소
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {resolved ? (
            <button type="button" className="sd-btn" disabled={busy} onClick={() => apply("open")}>
              다시 열기
            </button>
          ) : (
            <button type="button" className="sd-btn" disabled={busy} onClick={() => setResolving(true)}>
              해제 (근거 필요)
            </button>
          )}
          <button type="button" className="sd-btn" disabled={busy} onClick={remove}>
            삭제
          </button>
        </div>
      )}
    </li>
  );
}

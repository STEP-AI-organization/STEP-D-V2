"use client";

import { useEffect, useState } from "react";

/**
 * Precise, typeable timecode field (m:ss.d). Commits on blur / Enter, reverts on
 * Escape or unparseable input, and reflects external changes (slider drag, rec apply)
 * while not focused. Pattern per docs/plans/opencut-integration-plan.md (editable-timecode),
 * implemented natively against our EditorState — no vendored code.
 */
export function formatTc(sec: number): string {
  const s = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const ss = String(Math.floor(rest)).padStart(2, "0");
  const d = Math.floor((rest % 1) * 10);
  return `${m}:${ss}.${d}`;
}

/** Accepts "m:ss(.d)", "ss(.d)", or a bare seconds number. Returns null if unparseable. */
export function parseTc(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  let sec: number;
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    sec = m * 60 + s;
  } else if (parts.length === 1) {
    const n = Number(parts[0]);
    if (!Number.isFinite(n)) return null;
    sec = n;
  } else {
    return null;
  }
  return sec < 0 ? 0 : sec;
}

export function TimecodeInput({
  value,
  onCommit,
  min = 0,
  max,
  className,
}: {
  value: number;
  onCommit: (seconds: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [text, setText] = useState(() => formatTc(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(formatTc(value));
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const parsed = parseTc(text);
    if (parsed == null) {
      setText(formatTc(value)); // revert
      return;
    }
    let v = parsed;
    if (max != null) v = Math.min(v, max);
    v = Math.max(min, v);
    onCommit(v);
    setText(formatTc(v));
  }

  return (
    <input
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setText(formatTc(value));
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      inputMode="decimal"
      spellCheck={false}
      className={className}
    />
  );
}

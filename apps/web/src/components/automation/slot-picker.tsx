"use client";

/**
 * 발행 시간 피커 — **자동배포 화면과 완전자동화 화면이 같은 것을 쓴다.**
 *
 * 원래 `(app)/automation/page.tsx` 안에 있던 것을 그대로 옮겼다(2026-09-04). 두 벌이 되면
 * 한쪽에서만 고쳐지는 날이 오고, 그때 같은 "발행 시간" 이 화면마다 다르게 저장된다.
 * 저장 값의 정규화는 서버와 같은 순수 함수(`ruleSlots`)가 한다 — 여기는 편집만 한다.
 *
 * 시각마다 **개수**를 따로 둔다(2026-08-25 · 7시 2개·9시 3개). 하루 발행 수 = 개수 합이고,
 * 그 합은 화면이 직접 곱하지 않고 서버와 같은 함수(perDayCount·monthlyPublishEstimate)가 낸다.
 */
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { slotLabel, type RuleSlot } from "@server-pure/pipeline/automation";

export function SlotPicker({ slots, onChange }: { slots: RuleSlot[]; onChange: (v: RuleSlot[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [period, setPeriod] = useState<"오전" | "오후">("오후");
  const [hour, setHour] = useState("06");
  const [minute, setMinute] = useState("00");
  const boxRef = useRef<HTMLDivElement>(null);

  // 원본은 바깥 클릭으로 피커를 닫는다(D:150–160).
  useEffect(() => {
    if (!adding) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setAdding(false);
        setClockOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [adding]);

  const setCount = (time: string, count: number) =>
    onChange(slots.map((x) => (x.time === time ? { ...x, count: Math.max(1, Math.min(20, count)) } : x)));

  /** 원본 피커는 12시간 표기, 서버 계약은 24시간 "HH:MM" 이다 — 저장 직전에 변환한다. */
  function add() {
    const h12 = Number(hour);
    if (!Number.isFinite(h12) || h12 < 0 || h12 > 12) return;
    const h24 = period === "오전" ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
    const time = `${String(h24).padStart(2, "0")}:${minute.padStart(2, "0")}`;
    if (!slots.some((x) => x.time === time)) {
      onChange([...slots, { time, count: 1 }].sort((a, b) => a.time.localeCompare(b.time)));
    }
    setAdding(false);
    setClockOpen(false);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap" ref={boxRef}>
      {/* Added configured times pills — 원본 pill 안에 **시각당 개수**를 넣었다.
          원본은 시각만 담는데, 하루 발행 수 = 개수 합이라 개수를 정할 자리가 필요하다(perDayCount). */}
      {slots.map((x) => (
        <span
          key={x.time}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] text-xs font-bold text-[var(--color-text-primary)] shadow-none"
        >
          {slotLabel(x)}
          <button
            type="button" aria-label={`${x.time} 개수 줄이기`} disabled={x.count <= 1}
            onClick={() => setCount(x.time, x.count - 1)}
            className="text-[var(--color-text-muted)] hover:text-[#1C60FF] text-xs cursor-pointer border-none bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            −
          </button>
          <span className="font-mono">{x.count}개</span>
          <button
            type="button" aria-label={`${x.time} 개수 늘리기`}
            onClick={() => setCount(x.time, x.count + 1)}
            className="text-[var(--color-text-muted)] hover:text-[#1C60FF] text-xs cursor-pointer border-none bg-transparent"
          >
            ＋
          </button>
          <button
            type="button" aria-label={`${x.time} 삭제`}
            onClick={() => onChange(slots.filter((y) => y.time !== x.time))}
            className="text-[var(--color-text-muted)] hover:text-rose-500 text-xs cursor-pointer border-none bg-transparent"
          >
            ✕
          </button>
        </span>
      ))}

      {/* Inline Time Input Trigger Box (LEFT of + 시간 추가 button) */}
      {adding && (
        <div className="relative flex items-center gap-2">
          <div className="flex items-center gap-1 px-3.5 py-1.5 rounded-full bg-[var(--color-bg-card)] border border-[#1C60FF] text-xs font-bold text-[var(--color-text-primary)] shadow-none">
            {/* Toggleable AM/PM */}
            <button
              type="button"
              onClick={() => setPeriod((v) => (v === "오후" ? "오전" : "오후"))}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setPeriod((v) => (v === "오후" ? "오전" : "오후"));
                }
              }}
              className="hover:text-[#1C60FF] cursor-pointer font-bold border-none bg-transparent p-0 select-none mr-1"
              title="클릭 또는 화살표 키로 오전/오후 변경"
            >
              {period}
            </button>

            <input
              type="text" maxLength={2} value={hour} aria-label="시"
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                if (v === "" || (Number(v) >= 0 && Number(v) <= 12)) setHour(v);
              }}
              onBlur={() => setHour((v) => (v === "" ? "06" : v.padStart(2, "0")))}
              className="w-5 text-center bg-transparent border-none p-0 font-bold focus:outline-none focus:text-[#1C60FF]"
            />
            <span>:</span>
            <input
              type="text" maxLength={2} value={minute} aria-label="분"
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                if (v === "" || (Number(v) >= 0 && Number(v) <= 59)) setMinute(v);
              }}
              onBlur={() => setMinute((v) => (v === "" ? "00" : v.padStart(2, "0")))}
              className="w-5 text-center bg-transparent border-none p-0 font-bold focus:outline-none focus:text-[#1C60FF]"
            />

            {/* Clock Dropdown Icon */}
            <button
              type="button"
              onClick={() => setClockOpen((v) => !v)}
              className="ml-1.5 text-[#1C60FF] hover:opacity-80 cursor-pointer border-none bg-transparent p-0 flex items-center justify-center"
              title="시간 선택 드롭다운 열기"
            >
              <Clock className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={add}
            className="px-3.5 py-1.5 rounded-full bg-[#1C60FF] hover:bg-blue-600 text-white text-xs font-bold transition-colors cursor-pointer border-none shadow-none"
          >
            추가
          </button>

          {/* STEP D Time Picker Dropdown Overlay (With outside click auto-close) */}
          {clockOpen && (
            <div className="absolute top-full left-0 mt-2 bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-2xl p-2 shadow-2xl z-50 flex gap-1 animate-in fade-in duration-150 ring-1 ring-slate-200 dark:ring-stone-700">
              {/* Column 1: 오전 / 오후 */}
              <div className="w-16 flex flex-col gap-1 max-h-48 overflow-y-auto p-1">
                {(["오후", "오전"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setPeriod(v)} className={PICK_CELL(period === v)}>
                    {v}
                  </button>
                ))}
              </div>
              {/* Column 2: Hours (00 ~ 12) */}
              <div className="w-14 flex flex-col gap-1 max-h-48 overflow-y-auto p-1 border-l border-r border-[var(--color-border-subtle)]/40">
                {Array.from({ length: 13 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                  <button key={h} type="button" onClick={() => setHour(h)} className={PICK_CELL(hour === h)}>
                    {h}
                  </button>
                ))}
              </div>
              {/* Column 3: Minutes */}
              <div className="w-14 flex flex-col gap-1 max-h-48 overflow-y-auto p-1">
                {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map((m) => (
                  <button key={m} type="button" onClick={() => setMinute(m)} className={PICK_CELL(minute === m)}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setAdding((v) => !v)}
        className="px-3.5 py-1.5 rounded-full bg-[var(--color-bg-card)] hover:bg-[var(--color-bg-card-hover)] text-xs font-semibold text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] cursor-pointer shadow-none [box-shadow:none]"
      >
        + 시간 추가
      </button>
    </div>
  );
}

/** 시간 피커 셀 (원본 D:836·854·872). */
const PICK_CELL = (on: boolean) =>
  `w-full py-1.5 rounded-lg text-xs font-bold transition-colors border-none cursor-pointer ${
    on ? "bg-[#1C60FF] text-white shadow-xs" : "bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-bg-input)]"
  }`;

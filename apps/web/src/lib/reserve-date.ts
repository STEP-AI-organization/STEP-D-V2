/**
 * SMR reserve-date helpers.
 *
 * STEPD pain C2: SMR "즉시발행"(예약일 빈값) actually means 미게시 — the honest rule is
 * that a public datetime is REQUIRED. v2 never leaves it empty: immediate publish stamps
 * the current time, and the UI shows the resolved datetime so copy matches behavior.
 */

/** Format a Date as SMR reserve string "YYYYMMDDHHmmss". */
export function formatReserve(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Current time as a reserve string (used for honest "즉시 발행"). */
export function nowReserve(): string {
  return formatReserve(new Date());
}

/** Convert an <input type="datetime-local"> value (YYYY-MM-DDTHH:mm) to a reserve string. */
export function fromDatetimeLocal(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return nowReserve();
  return formatReserve(d);
}

/** Reserve string for the next occurrence of a weekday+time (weekday 0=일 … 6=토). */
export function nextWeekdayReserve(weekday: number, hh: number, mm: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
  let add = (weekday - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now.getTime()) add = 7;
  d.setDate(d.getDate() + add);
  return formatReserve(d);
}

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** Human-readable rendering of a reserve string "YYYYMMDDHHmmss". */
export function humanReserve(reserve?: string): string {
  if (!reserve || reserve.length < 12) return "—";
  const y = reserve.slice(0, 4);
  const mo = reserve.slice(4, 6);
  const d = reserve.slice(6, 8);
  const h = reserve.slice(8, 10);
  const mi = reserve.slice(10, 12);
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

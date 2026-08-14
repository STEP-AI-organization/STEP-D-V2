/**
 * 예약 발행 일시 helpers — **단일 계약**.
 *
 * 서버(publish-dispatch·worker)는 예약 시각을 전부 `Date.parse(reserveDate)` 로 읽는다
 * (naverPublishAt·scheduleDelay·futurePublishAt). 따라서 정본 와이어 포맷은
 * `<input type="datetime-local">` 이 주는 그대로의 "YYYY-MM-DDTHH:mm"(로컬) 문자열이고,
 * 발행 모달이 이 문자열을 **가공 없이** 그대로 보낸다.
 *
 * ⚠️ 구 14자리 "YYYYMMDDHHmmss" 포맷은 제거됐다 — `Date.parse` 가 못 읽어(NaN) 예약이
 * 조용히 '즉시 발행' 으로 떨어지는 함정이었고, 실제로 쓰는 곳도 없었다(WEEKDAYS 만 참조됨).
 * 새 코드는 여기 helper 로 한 포맷만 쓴다.
 */

/** 현재 시각을 datetime-local 입력값("YYYY-MM-DDTHH:mm")으로. 입력의 min·기본값에 쓴다. */
export function nowDatetimeLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 서버와 **같은 규칙** — 미래로 파싱될 때만 예약이 걸린다.
 * 과거·빈값·해석불가는 false(= 즉시 발행). publish-dispatch 의 `t > Date.now()` 와 일치시킨다.
 */
export function isFutureReserve(value: string | undefined | null): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && t > Date.now();
}

/** 사람이 읽는 표기 "YYYY-MM-DD HH:mm". 빈값·해석불가는 "—". */
export function humanReserve(value: string | undefined | null): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

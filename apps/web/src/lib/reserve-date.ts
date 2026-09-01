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

/**
 * 오전/오후를 **말로** 붙인 표기 — "8월 21일(금) 오전 12:00 (자정)".
 *
 * ⚠️ 이게 필요한 이유: `<input type="datetime-local">` 은 한국어 로캘에서 오전/오후 선택으로
 * 뜨는데 **오전 12시 = 자정(00:00)** 이다. "12시" 를 정오로 생각하고 오전인 채 두면 12시간
 * 어긋난 예약이 조용히 잡힌다(2026-08-21 실측: 정오로 걸었다는 예약이 00:00·00:05 로 저장돼
 * 자정에 지나갔다). 24시간제 숫자만 보여주면 훑고 지나치기 쉬워서, 자정·정오는 말로 못 박는다.
 */
export function humanReserveVerbose(value: string | undefined | null): string {
  if (!value) return "—";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  const p = (n: number) => String(n).padStart(2, "0");
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const noonish = h === 0 ? " (자정)" : h === 12 ? " (정오)" : "";
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAYS[d.getDay()]}) ${ampm} ${h12}:${p(m)}${noonish}`;
}

/**
 * 좁은 자리(배포 매트릭스 칸 등)용 짧은 표기 — "8.21 15:00". 빈값·해석불가는 "—".
 *
 * ⚠️ **24시간제로 못 박는다.** `toLocaleString("ko-KR", { hour: "2-digit" })` 는 12시간제가
 * 기본이라 15:00 예약이 "오후 03:00" 으로 찍힌다 — 예약을 15:00 으로 걸어 둔 사람이 목록에서
 * 03:00 을 보고 "왜 다른 시각이지" 하게 된다(2026-09-01 자매 서비스에서 실제로 이 혼동이
 * 보고됐다). 이 파일이 예약 표기의 단일 계약인 이유가 그거다 — 화면마다 따로 포맷하면
 * 같은 함정을 각자 다시 밟는다.
 *
 * 자정·정오를 말로 못 박는 `humanReserveVerbose` 와 목적이 다르다: 저건 **입력을 확인**하는
 * 자리(발행 모달)용이고, 이건 **이미 잡힌 예약을 훑는** 자리용이다.
 */
export function shortReserve(value: string | number | undefined | null): string {
  if (value == null || value === "") return "—";
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}.${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 지금부터 얼마나 남았는지 — "약 12시간 뒤". 12시간 착오는 이 문구에서 바로 드러난다. */
export function untilReserve(value: string | undefined | null): string {
  if (!value) return "";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "이미 지난 시각";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `약 ${min}분 뒤`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `약 ${hr}시간 ${min % 60 ? `${min % 60}분 ` : ""}뒤`;
  return `약 ${Math.floor(hr / 24)}일 ${hr % 24 ? `${hr % 24}시간 ` : ""}뒤`;
}

/** 새벽(00:00~05:59)인가 — 오전/오후를 잘못 고른 전형적 결과라 화면이 한 번 되묻는다. */
export function isLateNightReserve(value: string | undefined | null): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return new Date(t).getHours() < 6;
}

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

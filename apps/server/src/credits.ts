/**
 * 선불 크레딧 규칙 (2026-08-11 확정). **크레딧 1개 = 분석 1분.** 순수 모듈.
 *
 * 결제는 **일반결제(선불 충전)** 다. 구독·빌링키가 아니다 — 그래서 빌링키의 "정기적 구독"
 * 제약(계획 §4-3)이 여기엔 적용되지 않는다.
 *
 * 지키는 것 넷:
 *  1. **브라우저를 믿지 않는다.** 결제창이 성공을 알려도 크레딧을 올리지 않는다.
 *     포트원에 조회해 금액·상태가 우리가 만든 주문과 일치할 때만 올린다.
 *  2. **멱등.** 웹훅은 재전송되고 워커는 재시도한다. 같은 결제로 두 번 충전되면 안 되고,
 *     같은 분석으로 두 번 차감돼도 안 된다.
 *  3. **모자라면 시작하지 않는다.** 분석을 돌리고 나서 "잔액이 없었네"는 원가를 이미 쓴 뒤다.
 *  4. **잔액은 원장 합계다.** 캐시하지 않는다 — 어긋난 잔액은 조용히 틀린 채로 굴러간다.
 */

export const CREDIT_UNIT_LABEL = "크레딧 1개 = 분석 1분";

// ── 잔액 ─────────────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  delta: number;
  reason: string;
}


export type CreditVerdict =
  | { allow: true; reason: ""; remainingAfter: number }
  | { allow: false; reason: string; code: "insufficient" | "invalid" };

/**
 * 이 분석을 시작해도 되는가.
 *
 * **미리 본다.** 58분짜리를 다 돌리고 나서 잔액이 없다고 하면 원가(₩285)는 이미 나갔다.
 * 러닝타임을 모를 때(durationSec 0)는 막지 않는다 — 프로브 실패로 분석을 못 하게 만드는
 * 것보다 낫고, 차감은 끝난 뒤 실제 길이로 한다.
 */
export function checkCredits(input: { balance: number; needMinutes: number }): CreditVerdict {
  const need = Math.trunc(input.needMinutes);
  if (!Number.isFinite(need) || need < 0) {
    return { allow: false, code: "invalid", reason: "필요 크레딧을 계산할 수 없습니다." };
  }
  if (need === 0) return { allow: true, reason: "", remainingAfter: input.balance };

  if (input.balance < need) {
    const short = need - input.balance;
    return {
      allow: false,
      code: "insufficient",
      reason: `크레딧이 ${short}개 모자랍니다 (필요 ${need} · 보유 ${input.balance}). 충전 후 다시 시도하세요.`,
    };
  }
  return { allow: true, reason: "", remainingAfter: input.balance - need };
}

// ── 멱등 키 ──────────────────────────────────────────────────────────────────────

/** 충전 — 결제 하나당 한 번. 웹훅이 여러 번 와도 여기서 막힌다. */
export function topupDedupeKey(paymentId: string): string {
  return `topup:${paymentId}`;
}

/**
 * 사용 — 미디어 하나당 한 번. 사람이 재분석시키면 원가가 다시 드니 별개로 센다.
 * 여기서 말하는 attempt 는 **사람이 시킨 재분석 횟수**지 워커 재시도가 아니다.
 */
export function usageDedupeKey(mediaId: string, attempt = 0): string {
  return attempt > 0 ? `usage:${mediaId}:${attempt}` : `usage:${mediaId}`;
}

/** 결제 식별자 — **우리가 만든다**. 이게 중복 결제를 막는 마지막 방어선이다. */
export function topupPaymentId(tenantId: string, nonce: string): string {
  const safeTenant = tenantId.replace(/[^A-Za-z0-9_-]/g, "");
  const safeNonce = nonce.replace(/[^A-Za-z0-9_-]/g, "");
  return `cr_${safeTenant}_${safeNonce}`;
}

// ── 충전 주문 ────────────────────────────────────────────────────────────────────

/** 크레딧당 판매가(원). **아직 미정이라 env 로 받는다** — 코드에 숫자를 박지 않는다. */
export function creditPriceKrw(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.CREDIT_PRICE_KRW ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export type TopupCheck =
  | { ok: true; credits: number; amountKrw: number; reason: "" }
  | { ok: false; reason: string };

/** 한 번에 살 수 있는 상한 — 오타로 0 이 하나 더 붙는 사고를 막는다. */
// ── 운영자 수동 조정 ──────────────────────────────────────────────────────────

/**
 * 운영자가 손으로 넣을 수 있는 사유. **`topup` 과 `usage` 는 여기 없다** —
 * `topup` 은 실결제가 붙은 행이라 손으로 쓰면 매출이 부풀고, `usage` 는 파이프라인이
 * 실제로 원가를 쓴 기록이라 손으로 쓰면 원가 집계가 어긋난다.
 */
export const MANUAL_REASONS = ["grant", "adjust", "refund"] as const;
export type ManualReason = (typeof MANUAL_REASONS)[number];

/** 한 번에 움직일 수 있는 한도. 0 을 하나 더 붙이는 실수를 여기서 막는다. */
export const MAX_MANUAL_DELTA = 100_000;

export type ManualCheck =
  | { ok: true; delta: number; reason: ManualReason; note: string }
  | { ok: false; message: string };

/**
 * 수동 크레딧 조정 판정.
 *
 * **원장은 append-only 라 되돌릴 수 없다**(0024 트리거가 UPDATE/DELETE 를 막는다).
 * 정정도 반대 부호 행을 하나 더 쌓는 것이지 지우는 게 아니다. 그래서 잘못 넣으면
 * 기록이 영구히 남는다 — 넣기 전에 여기서 최대한 거른다.
 *
 * 잔액이 음수로 내려가는 것은 **막지 않는다.** 이미 쓴 분석을 없던 일로 만들 수는 없고,
 * 음수 잔액은 "받을 돈이 있다"는 사실 그대로다. 0 으로 눌러 버리면 그 사실이 사라진다.
 */
export function planManualCredit(input: {
  delta: unknown;
  reason: unknown;
  note: unknown;
}): ManualCheck {
  const n = typeof input.delta === "number" ? input.delta : Number(String(input.delta ?? "").trim());
  if (!Number.isFinite(n) || Math.trunc(n) === 0) {
    return { ok: false, message: "변경할 크레딧 수를 입력하세요 (음수는 차감)." };
  }
  const delta = Math.trunc(n);
  if (Math.abs(delta) > MAX_MANUAL_DELTA) {
    return { ok: false, message: `한 번에 ${MAX_MANUAL_DELTA.toLocaleString("ko-KR")}개까지만 조정할 수 있습니다.` };
  }
  const reason = String(input.reason ?? "").trim() as ManualReason;
  if (!(MANUAL_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, message: `사유 종류는 ${MANUAL_REASONS.join(" · ")} 중 하나여야 합니다.` };
  }
  const note = String(input.note ?? "").trim();
  if (note.length < 4) {
    // 6개월 뒤에 이 행을 보고 "왜 넣었지" 가 되면 원장이 있으나 마나다.
    return { ok: false, message: "메모를 4자 이상 적어 주세요 — 원장은 지울 수 없어서 설명이 같이 남아야 합니다." };
  }
  return { ok: true, delta, reason, note: note.slice(0, 300) };
}

/** 수동 조정 행의 dedupe 키. 같은 nonce 로 두 번 눌러도 한 번만 쌓인다. */
export function manualDedupeKey(tenantId: string, nonce: string): string {
  return `manual:${tenantId}:${nonce}`;
}

export const MAX_TOPUP_CREDITS = 100_000;

/**
 * 충전 주문 검증. **금액은 서버가 계산한다** — 브라우저가 보낸 금액을 쓰면
 * 1원에 10만 크레딧을 살 수 있다.
 */
export function buildTopup(credits: unknown, env: NodeJS.ProcessEnv = process.env): TopupCheck {
  const n = typeof credits === "number" ? credits : Number(credits);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, reason: "충전할 크레딧 수를 정수로 지정하세요." };
  }
  if (n > MAX_TOPUP_CREDITS) {
    return { ok: false, reason: `한 번에 ${MAX_TOPUP_CREDITS.toLocaleString("ko-KR")}개까지 충전할 수 있습니다.` };
  }
  const price = creditPriceKrw(env);
  if (price == null) {
    // 단가를 모르면 결제창을 띄우지 않는다. 0원 결제나 임의 단가보다 낫다.
    return { ok: false, reason: "크레딧 단가가 설정되지 않았습니다 (CREDIT_PRICE_KRW)." };
  }
  return { ok: true, credits: n, amountKrw: n * price, reason: "" };
}

// ── 결제 대조 ────────────────────────────────────────────────────────────────────

export type SettleVerdict =
  | { credit: true; credits: number; reason: "" }
  | { credit: false; reason: string };

/**
 * 포트원 조회 결과와 우리 주문을 대조한다. **여기가 브라우저를 안 믿는 지점이다.**
 *
 * 금액이 다르면 올리지 않는다 — 결제창 파라미터가 조작됐거나 우리 계산이 틀렸다는 뜻이고,
 * 둘 다 크레딧을 주면 안 되는 상황이다.
 */
export function settleTopup(input: {
  order: { credits: number; amountKrw: number; status: string } | null;
  payment: { status?: string; amountTotal?: number } | null;
}): SettleVerdict {
  if (!input.order) return { credit: false, reason: "우리 쪽에 해당 충전 주문이 없습니다." };
  if (input.order.status === "paid") return { credit: false, reason: "이미 처리된 충전입니다." };
  if (!input.payment) return { credit: false, reason: "포트원에서 결제를 조회하지 못했습니다." };

  const status = String(input.payment.status ?? "").toUpperCase();
  if (status !== "PAID") return { credit: false, reason: `결제 상태가 PAID 가 아닙니다 (${status || "알 수 없음"}).` };

  const paid = Number(input.payment.amountTotal);
  if (!Number.isFinite(paid) || paid !== input.order.amountKrw) {
    return {
      credit: false,
      reason: `결제 금액이 주문과 다릅니다 (주문 ${input.order.amountKrw} · 결제 ${input.payment.amountTotal}).`,
    };
  }
  return { credit: true, credits: input.order.credits, reason: "" };
}

// ── 자동 충전 (아직 미배선) ──────────────────────────────────────────────────────

/**
 * 잔액이 임계 이하일 때 자동 충전 — **빌링키가 있어야 가능하다.** 일반결제만으로는
 * 저장된 결제수단이 없어 자동으로 긁을 수 없다.
 *
 * 켜기 전에 반드시 있어야 하는 것: 일 최대 횟수 · 월 최대 금액 · 쿨다운.
 * 파이프라인 버그로 크레딧이 빨리 닳으면 **자동으로 계속 긁힌다.** 상한이 없으면 못 켠다.
 */
export interface AutoTopupPolicy {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
  maxPerDay: number;
  maxKrwPerMonth: number;
}

export type AutoTopupVerdict =
  | { charge: true; reason: "" }
  | { charge: false; reason: string };

/** 지금 자동 충전을 해도 되는가. **상한 중 하나라도 걸리면 멈추고 알린다.** */
export function shouldAutoTopup(input: {
  policy: AutoTopupPolicy;
  balance: number;
  todayCount: number;
  monthKrw: number;
  amountKrw: number;
}): AutoTopupVerdict {
  const p = input.policy;
  if (!p.enabled) return { charge: false, reason: "자동 충전이 꺼져 있습니다." };
  if (input.balance > p.thresholdCredits) return { charge: false, reason: "잔액이 임계보다 많습니다." };
  if (input.todayCount >= p.maxPerDay) {
    return { charge: false, reason: `오늘 자동 충전 한도(${p.maxPerDay}회)에 도달했습니다 — 조용히 계속 긁지 않습니다.` };
  }
  if (input.monthKrw + input.amountKrw > p.maxKrwPerMonth) {
    return { charge: false, reason: `이번 달 자동 충전 한도(${p.maxKrwPerMonth.toLocaleString("ko-KR")}원)를 넘습니다.` };
  }
  return { charge: true, reason: "" };
}

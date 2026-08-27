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
/**
 * 배포 1건(영상×채널) 크레딧 — env PUBLISH_CREDITS, 기본 3 (2026-08-26 사용자 · "1은 너무 적다").
 * 0 이면 배포 무과금(스위치). 음수·비수치는 기본값.
 */
export function publishCredits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.PUBLISH_CREDITS ?? "").trim();
  if (raw === "") return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export function creditPriceKrw(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.CREDIT_PRICE_KRW ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export type TopupCheck =
  | {
      ok: true; credits: number;
      /** **실제로 카드에 긁히는 금액** — 공급가액 + 부가세. settleTopup 이 이 값으로 대조한다. */
      amountKrw: number;
      /** 크레딧 × 단가 (부가세 별도 · 2026-08-27). 화면·인보이스가 내역으로 보여준다. */
      supplyKrw: number;
      vatKrw: number;
      reason: "";
    }
  | { ok: false; reason: string };

/**
 * 부가세율 — **단가(CREDIT_PRICE_KRW)는 공급가액이다**(사용자 확정 2026-08-27 "부가세 별도").
 * 그 전에는 총액을 부가세 포함으로 보고 역산했는데, 그러면 60원/개가 실수령 54.5원이 되어
 * 단가표와 정산이 어긋난다. 이제 청구액 = 공급가액 + 세액이고, 세액은 원 단위 반올림이다
 * (총액 = supply × 1.1 이라 invoice.ts 의 역산 splitVat 이 같은 값으로 정확히 되돌아온다).
 */
export const CREDIT_VAT_RATE = 0.1;

/** 공급가액 → 청구 3종. 화면·인보이스·결제 호출이 전부 이 함수 하나를 쓴다. */
export function creditAmounts(supplyKrw: number): { supplyKrw: number; vatKrw: number; amountKrw: number }
{
  const vat = Math.round(supplyKrw * CREDIT_VAT_RATE);
  return { supplyKrw, vatKrw: vat, amountKrw: supplyKrw + vat };
}

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
 *
 * ⚠️ **단가는 부가세 별도다**(2026-08-27 사용자 확정). `크레딧 × 단가` 는 **공급가액**이고,
 * 청구액은 거기에 10% 를 더한 값이다 — 5,000개면 공급가 300,000 + 세액 30,000 = 330,000원.
 * 예전엔 단가가 부가세 포함이라 `크레딧 × 단가` 가 곧 청구액이었다. amountKrw 의 뜻이
 * 바뀐 게 아니라(**늘 청구액이다**) 그 값을 만드는 식이 바뀐 것이다 — settleTopup 의
 * 승인액 대조도 그대로 성립한다.
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
  // 단가는 **공급가액**이다 — 청구액에 부가세를 더한다(2026-08-27 확정).
  // 5,000개 × 60원 = 공급가 300,000 + 세액 30,000 = **330,000원 청구**.
  const { supplyKrw, vatKrw, amountKrw } = creditAmounts(n * price);
  return { ok: true, credits: n, amountKrw, supplyKrw, vatKrw, reason: "" };
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
 * 상한 필드(maxPerDay·maxKrwPerMonth)는 **0 이면 그 축을 안 본다.** 지금 프로덕션 정책은
 * 둘 다 0 이다(FIXED_AUTO_TOPUP · 2026-08-27 "리미트 두지마") — 상한으로 막으면 달·날
 * 중간에 자동 결제가 멈추고 그 순간 분석·자동배포가 통째로 정지하기 때문이다.
 * 폭주는 상한이 아니라 **임계 조건**이 막는다: 충전이 성공하면 잔액이 임계 위로 올라가
 * 다음 판정이 above_threshold 로 스스로 멈춘다. 필드는 남긴다 — 값이 있는 정책(테스트·
 * 과거 저장분)은 종전대로 절대 상한으로 조여 판정한다.
 */
export interface AutoTopupPolicy {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
  maxPerDay: number;
  maxKrwPerMonth: number;
}

/**
 * 자동 충전 결과의 **기계 판독 사유**. 문구(reason)는 사람용이라 언제든 바뀌는데,
 * "이건 알려야 하는 실패인가" 판정이 그 문구에 기생하면 문구를 고치는 순간 판정이 깨진다
 * (실제로 호출부가 `/꺼져|임계보다 많|카드가 없/` 정규식으로 걸러, "미정산 정산했습니다"
 * 같은 정상 결과까지 매번 경고로 나갔다). 판정은 code 로만 한다.
 */
export const AUTO_TOPUP_CODES = [
  "charged",          // 실제로 긁혔다
  "disabled",         // 정책 꺼짐
  "above_threshold",  // 잔액이 임계보다 많다
  "reconciled",       // 미정산 주문을 정산했다(이번 순번은 새 결제 없음)
  "no_card",          // 등록된 카드 없음
  "card_revoked",     // 저장 카드가 해지됨
  "no_buyer_info",    // 카드에 구매자 3종(이니시스 필수)이 없음
  "bad_amount",       // 충전량이 잘못됨(정수 아님·상한 초과) — **사용자가 고칠 수 있다**
  "price_unset",      // 판매 단가가 서버에 설정되지 않음 — **사용자가 못 고친다**
  "bad_policy",       // 충전량 ≤ 임계 — 충전해도 임계를 못 넘는 설정
  "daily_cap",        // 오늘 자동 충전 횟수 상한 도달
  "monthly_cap",      // 이번 달 자동 충전 금액 상한 도달
  "charge_declined",  // 카드사 승인 거절(한도초과·정지 등)
  "unverified",       // 결제 확인 보류 — 웹훅/다음 정산이 진실을 반영한다
] as const;
export type AutoTopupCode = (typeof AUTO_TOPUP_CODES)[number];

/**
 * 사유별 심각도. **Record 로 둔 것이 핵심이다** — code 를 새로 추가하면 분류 누락이
 * 런타임이 아니라 컴파일에서 걸린다. 미분류가 조용히 생기면 이번 구멍(사용자가 조치해야
 * 하는 실패가 어디에도 안 보임)이 그대로 재발한다.
 *
 * `info` = 사실이지만 사용자가 할 일이 없다 → 알리지 않는다. 정상 사유를 매번 띄우면
 * 경고가 배경음이 되어 진짜 경고를 가린다.
 *  - no_card: 카드 등록 화면이 비어 있는 것과 같은 말이고, 자동 충전을 **켜는 순간**
 *    라우트가 409 로 막는다(index.ts PUT /api/credits/auto-topup) — 새로 알릴 정보가 없다.
 *    반대로 card_revoked 는 켜 둔 뒤에 벌어진 변화라, 말해주지 않으면 자동 충전이 조용히
 *    멈춘 사실을 사용자가 알 길이 없다.
 *  - unverified: 돈이 나갔을 수 있는 '확인 보류' 상태다. 웹훅·다음 트리거의 미정산 정산이
 *    스스로 마무리하므로 사용자가 지금 할 일은 없다.
 */
export const AUTO_TOPUP_SEVERITY: Record<AutoTopupCode, "ok" | "info" | "action_required"> = {
  charged: "ok",
  disabled: "info",
  above_threshold: "info",
  reconciled: "info",
  no_card: "info",
  unverified: "info",
  card_revoked: "action_required",
  no_buyer_info: "action_required",
  bad_amount: "action_required",
  price_unset: "action_required",
  bad_policy: "action_required",
  daily_cap: "action_required",
  monthly_cap: "action_required",
  charge_declined: "action_required",
};

/** 사용자가 뭔가 해야 끝나는 실패인가. 로그·화면·알림이 **같은 이 함수**를 본다. */
export function autoTopupNeedsAttention(code: AutoTopupCode): boolean {
  return AUTO_TOPUP_SEVERITY[code] === "action_required";
}

/**
 * "그래서 뭘 하면 되는가". 사유만 있고 할 일이 없는 문구는 이번 구멍을 반만 메운다 —
 * 사용자는 카드사에 뭘 물어야 하는지, 어느 설정을 고쳐야 하는지까지 알아야 한다.
 * 알릴 필요 없는 사유는 빈 문자열(화면이 힌트 줄을 숨기는 근거).
 */
export function autoTopupActionHint(code: AutoTopupCode): string {
  switch (code) {
    case "charge_declined":
      return "카드사에서 결제가 거절됐습니다 — 한도·정지 여부를 확인하거나 다른 카드를 등록하세요.";
    case "card_revoked":
      return "저장된 카드가 해지됐습니다 — 카드를 다시 등록하면 자동 충전이 이어집니다.";
    case "no_buyer_info":
      return "카드에 구매자 정보(이름·이메일·휴대폰)가 없습니다 — 직접 충전 1회 또는 카드 재등록으로 채워집니다.";
    case "bad_amount":
      return "자동 결제 금액을 만들 수 없습니다 — 담당자에게 문의해 주세요.";
    // 단가는 **서비스 쪽 설정**이다. 예전엔 이 경우도 bad_amount 로 접혀 "충전량을 다시
    // 지정하세요" 라고 안내했는데, 사용자가 충전량을 몇 번을 고쳐도 절대 안 풀린다.
    case "price_unset":
      return "결제 단가가 설정되지 않아 자동 충전을 할 수 없습니다 — 담당자에게 문의해 주세요."
        + " 결제 화면에서는 풀 수 없는 문제입니다.";
    case "bad_policy":
      return "자동 결제 설정값이 올바르지 않습니다 — 담당자에게 문의해 주세요.";
    case "daily_cap":
      return "오늘 자동 결제 횟수 상한에 도달했습니다 — 필요하면 결제 화면에서 직접 충전해 주세요 (상한은 고정이라 바꿀 수 없습니다).";
    case "monthly_cap":
      return "이번 달 자동 결제 금액 상한에 도달했습니다 — 결제 화면에서 직접 충전해 주세요 (상한은 고정이라 바꿀 수 없습니다).";
    default:
      return "";
  }
}

/**
 * 화면에 남기는 자동 충전 실패 알림. **테넌트당 한 건**이다.
 *
 * 실패는 분석이 끝날 때마다 반복된다 — 로그처럼 쌓으면 같은 줄이 화면을 덮어 아무도 안 읽는다
 * (rule_run 의 hasRunNote 가 같은 이유로 "같은 사유는 한 번만" 이다). 대신 한 행을 갱신하며
 * `firstAt` 을 보존해 **언제부터 실패 중인지**를 남긴다 — 사용자가 카드사에 물을 때 필요한 값이다.
 */
export interface AutoTopupAlert {
  code: AutoTopupCode;
  /** 실패 사유(사람 말). 카드사 거절이면 PG 가 준 문구가 여기 온다. */
  message: string;
  /** 무엇을 하면 되는가. */
  hint: string;
  /** 이 사유로 **처음** 실패한 시각(ISO). 반복돼도 유지된다. */
  firstAt: string;
  /** 가장 최근 실패 시각(ISO). */
  lastAt: string;
  /** 이 사유가 연속으로 몇 번 났는가. */
  count: number;
  /** 실패 시점 잔액 — 급한지(0 이면 분석이 멈춘다) 판단하는 재료. */
  balance: number | null;
  /**
   * 이 알림이 마지막으로 갱신된 **KST 날짜**("YYYY-MM-DD").
   *
   * 상한 알림("오늘 …"·"이번 달 …")의 유효기간 판정에 쓴다 — 문구가 "오늘" 이라고 쓰려면
   * 정말 오늘이어야 한다. lastAt 에서 계산할 수도 있지만, **판정 기준을 값으로 남겨야**
   * 서버 타임존·저장 포맷이 바뀌어도 판정이 흔들리지 않는다.
   * (이 필드 이전에 저장된 알림엔 없다 — 읽는 쪽이 lastAt 으로 폴백한다.)
   */
  kstDay: string;
}

/**
 * KST 기준 날짜 키("YYYY-MM-DD"). 서버 타임존이 어디든 같은 값이 나와야 "오늘"이 안 흔들린다.
 * 못 읽는 값이면 빈 문자열 — 호출부는 그걸 "모른다" 로 다룬다(모르면 오늘이라고 우기지 않는다).
 */
export function kstDayKey(at: string | Date = new Date()): string {
  const ms = (typeof at === "string" ? new Date(at) : at).getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 유효기간이 지난 상한 알림인가.
 *
 * daily_cap·monthly_cap 은 **그 날·그 달에만 참인 사실**이다. 그런데 알림을 지우는 유일한
 * 경로가 "다음 maybeAutoTopup 이 정상 판정" 인데 그 호출부는 분석 완료뿐이라, 잔액 0 으로
 * 분석이 멈추면 영영 다시 안 불린다 — 사흘 전 기록이 오늘도 "오늘 자동 충전 횟수 상한에
 * 도달했습니다" 로 남아 사용자가 오늘 걸린 줄 안다. 그래서 **읽는 쪽에서** 기간이 지난 것은
 * 만료로 본다. 나머지 사유(카드 해지·거절·잘못된 설정)는 사람이 조치해야 끝나므로 안 늙는다.
 */
export function autoTopupAlertExpired(alert: AutoTopupAlert, now: string | Date = new Date()): boolean {
  if (alert.code !== "daily_cap" && alert.code !== "monthly_cap") return false;
  const today = kstDayKey(now);
  // 이 필드 이전에 저장된 알림은 kstDay 가 없다 — lastAt 으로 폴백한다(둘 다 KST 로 환산).
  const then = alert.kstDay || kstDayKey(alert.lastAt);
  if (!today || !then) return true; // 언제 생긴 건지 모르면 "오늘"이라고 주장할 근거가 없다
  return alert.code === "daily_cap" ? then !== today : then.slice(0, 7) !== today.slice(0, 7);
}

/**
 * 지금도 유효한 알림만 통과시킨다(만료면 null). **읽는 자리는 전부 이걸 거친다** —
 * db-pg 의 getAutoTopupAlert 한 곳에서 걸러, 소비처(라우트·다음 판정)가 각자 기억할 일이 없다.
 */
export function liveAutoTopupAlert(
  alert: AutoTopupAlert | null, now: string | Date = new Date(),
): AutoTopupAlert | null {
  return alert && !autoTopupAlertExpired(alert, now) ? alert : null;
}

/**
 * 다음 알림 상태를 만든다. **null 이면 알림을 지운다** — 해결된 경고가 남아 있으면
 * 다음부터 아무도 안 본다(경고가 배경음이 되는 순간 진짜 경고도 안 읽힌다).
 *
 * 순수 함수다. 저장은 db-pg, 배선은 auto-topup 이 한다 — 여기에 DB 를 들이면
 * credits.test.ts 가 DB 없이 못 돈다.
 */
export function nextAutoTopupAlert(
  prev: AutoTopupAlert | null,
  result: { code: AutoTopupCode; reason: string; balance?: number | null },
  nowIso: string,
): AutoTopupAlert | null {
  if (!autoTopupNeedsAttention(result.code)) return null;
  const same = prev?.code === result.code;
  return {
    code: result.code,
    // 사유 문구가 비면(방어) 힌트라도 보여준다 — 빈 알림은 알림이 없는 것보다 나쁘다.
    message: (result.reason || autoTopupActionHint(result.code)).slice(0, 300),
    hint: autoTopupActionHint(result.code),
    firstAt: same ? prev!.firstAt : nowIso,
    lastAt: nowIso,
    count: same ? prev!.count + 1 : 1,
    balance: result.balance ?? null,
    // 상한 알림의 유효기간 기준(위 autoTopupAlertExpired). 갱신될 때마다 오늘로 민다 —
    // 오늘도 상한에 걸렸으면 오늘 알림이 맞다.
    kstDay: kstDayKey(nowIso),
  };
}

export type AutoTopupVerdict =
  | { charge: true; reason: "" }
  | { charge: false; reason: string; code: AutoTopupCode };

/**
 * 정책값의 **절대 상한** — 사용자가 정하는 상한(월 한도·일 횟수) 자체가 미친 값이면
 * 상한이 상한 노릇을 못 한다. 라우트 검증과 shouldAutoTopup 양쪽이 같은 값을 본다:
 * 검증이 생기기 **이전에 저장된 행**도 판정 시점에 여기 걸려야 하기 때문이다.
 */
export const AUTO_TOPUP_HARD_MAX_KRW_PER_MONTH = 5_000_000;
export const AUTO_TOPUP_HARD_MAX_PER_DAY = 10;

/**
 * **고정 자동 결제 정책** (2026-08-26 사용자 확정) — 워크스페이스별 설정 화면이 없다.
 *
 * "잔액이 소진되면 5,000크레딧(₩300,000)을 자동 결제한다." 그게 전부다. 임계·충전량·
 * 상한을 고객이 고르게 하면 고를 것이 늘 뿐 결과는 같고(어차피 소진되면 충전한다),
 * 잘못 고른 값(충전량 < 임계 등)이 조용한 연속 과금으로 이어질 여지만 남긴다.
 *
 * **동의 시점은 카드 등록이다.** 이 정책이 계약서가 아니라 결제 화면에만 있으면 안 되므로,
 * 카드 등록 UI 가 등록 버튼 옆에서 이 문구를 그대로 보여준다(apps/web billing 화면).
 * 정책이 여기 한 곳에만 살아야 화면·서버·메일이 다른 금액을 말하지 않는다.
 *
 * **상한(일 횟수·월 금액)은 두지 않는다**(2026-08-27 사용자 확정). 상한으로 막으면 달·날
 * 중간에 자동 결제가 멈추고 그 순간 분석·자동배포가 통째로 정지한다 — "소진되면 무조건
 * 충전한다"는 이 정책의 존재 이유와 정면으로 어긋난다. 실제로 부가세 별도 전환 때 건당이
 * 300,000 → 330,000 이 되며 월 상한이 5회를 4회로 조용히 깎은 적이 있다 — 금액으로 잠그면
 * 단가가 바뀔 때마다 같은 사고가 되풀이된다.
 *
 * 폭주를 막는 것은 상한이 아니라 **임계 조건**이다: 충전은 잔액 0 이하에서만 발동하고,
 * 충전이 성공하면 잔액이 임계 위로 올라가 다음 판정이 `above_threshold` 로 멈춘다.
 * 카드 거절처럼 잔액이 안 오르는 경우만 시도가 반복되는데, 그건 상한이 아니라
 * 알림(autoTopupAlert · 담당자 메일)이 사람을 부르는 자리다.
 */
export const FIXED_AUTO_TOPUP = {
  /** 완전 소진(잔액 0 이하)에만 발동한다 — "소진되면" 이라는 약속 그대로. */
  thresholdCredits: 0,
  /** 5,000크레딧 = 공급가 ₩300,000 + 부가세 ₩30,000 = **₩330,000 청구**(크레딧당 ₩60, 부가세 별도). */
  topupCredits: 5_000,
  /**
   * **상한 없음**(둘 다 0 · 사용자 확정 2026-08-27 "리미트 두지마").
   *
   * 폭주를 실제로 막는 것은 상한이 아니라 **임계 조건**이다: 충전은 잔액이 0 이하일
   * 때만 발동하고(thresholdCredits: 0), 한 번 충전하면 5,000크레딧이 들어와 잔액이
   * 임계 위로 올라가므로 다음 판정은 `above_threshold` 에서 그냥 멈춘다.
   *
   * ⚠️ 예외는 **카드가 거절될 때**다 — 잔액이 안 오르니 트리거마다 승인 시도가 다시
   * 나간다. 그 경우는 상한이 아니라 알림(autoTopupAlert · 담당자 메일)이 사람을 부른다.
   */
  maxPerDay: 0,
  maxKrwPerMonth: 0,
} as const;

/**
 * 지금 적용되는 자동 결제 정책. **저장된 행을 읽지 않는다** — 정책은 고정이고,
 * 켜짐 여부는 오직 "쓸 수 있는 카드가 있는가" 다(등록이 곧 동의).
 */
export function fixedAutoTopupPolicy(hasUsableCard: boolean): AutoTopupPolicy {
  return { enabled: hasUsableCard, ...FIXED_AUTO_TOPUP };
}

/** 지금 자동 충전을 해도 되는가. **상한 중 하나라도 걸리면 멈추고 알린다.** */
export function shouldAutoTopup(input: {
  policy: AutoTopupPolicy;
  balance: number;
  todayCount: number;
  monthKrw: number;
  amountKrw: number;
}): AutoTopupVerdict {
  const p = input.policy;
  if (!p.enabled) return { charge: false, code: "disabled", reason: "자동 충전이 꺼져 있습니다." };
  // 충전량이 임계 이하면 충전해도 잔액이 임계를 못 넘어 **다음 판정에 또 걸린다** —
  // 하루 한도까지 연속 과금되는 모양이다. 라우트가 400 으로 막지만, 검증 이전에
  // 저장된 행 대비 판정에서도 한 번 더 막는다.
  if (p.topupCredits <= p.thresholdCredits) {
    return { charge: false, code: "bad_policy", reason: "충전량이 임계 이하라 자동 충전을 멈춥니다 — 충전량을 임계보다 크게 설정하세요." };
  }
  if (input.balance > p.thresholdCredits) {
    return { charge: false, code: "above_threshold", reason: "잔액이 임계보다 많습니다." };
  }
  // **상한 값이 0 이하면 그 축은 없는 것으로 본다**(사용자 확정 2026-08-27 "리미트 두지마").
  // 상한이 살아 있으면 달·날 중간에 자동 결제가 막히고, 그 순간 분석·자동배포가 통째로
  // 멈춘다 — "소진되면 무조건 충전한다"는 이 정책의 존재 이유와 정면으로 어긋난다.
  // 값이 남아 있는 정책(테스트·과거 저장분)은 종전대로 절대 상한으로 조여 판정한다.
  const dailyCapped = p.maxPerDay > 0;
  const monthlyCapped = p.maxKrwPerMonth > 0;
  const maxPerDay = dailyCapped ? Math.min(p.maxPerDay, AUTO_TOPUP_HARD_MAX_PER_DAY) : 0;
  const maxKrwPerMonth = monthlyCapped
    ? Math.min(p.maxKrwPerMonth, AUTO_TOPUP_HARD_MAX_KRW_PER_MONTH) : 0;
  if (dailyCapped && input.todayCount >= maxPerDay) {
    // ⚠️ 이 문구는 이제 사용자 화면(상시 배너)에 그대로 뜬다. "조용히 계속 긁지 않습니다" 는
    // **우리끼리의 설계 설명**이지 사용자 말이 아니다 — 사실 + 다음 행동만 남긴다.
    return {
      charge: false, code: "daily_cap",
      reason: `오늘 자동 충전 한도(${maxPerDay}회)를 모두 썼습니다 — 오늘은 더 자동 충전하지 않습니다.`,
    };
  }
  if (monthlyCapped && input.monthKrw + input.amountKrw > maxKrwPerMonth) {
    return { charge: false, code: "monthly_cap", reason: `이번 달 자동 충전 한도(${maxKrwPerMonth.toLocaleString("ko-KR")}원)를 넘습니다.` };
  }
  return { charge: true, reason: "" };
}

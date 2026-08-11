/**
 * 과금 규칙 (docs/plans/active/billing-portone-plan.md). 순수 모듈.
 *
 * PG: 포트원 중계 + **KG이니시스** (2026-08-11 계약 완료).
 *
 * 여기서 지키는 것 셋:
 *
 * 1. **멱등.** 워커는 재시도·중복 큐잉이 있는 구조다(job_queue 가 지수 백오프로 최대 5회).
 *    같은 분석이 두 번 기록되면 **한 번 분석하고 두 번 청구**한다. dedupe 키를 만드는
 *    책임을 여기 한 곳에 둔다.
 *
 * 2. **실결제는 기본 OFF.** `BILLING_ENABLED` 가 명시적으로 켜져야 카드가 긁힌다.
 *    잘못된 env 의 실패 모드가 "결제 안 됨"이지 "실수로 카드가 긁힘"이 아니어야 한다
 *    (upload-gate.ts 와 같은 방향).
 *
 * 3. **모르면 청구하지 않는다.** 요금제가 없거나 단가가 비어 있으면 0 으로 때우지 않고
 *    "판정 불가"를 돌려준다. 0 으로 때우면 공짜로 쓰다가 나중에 소급 청구하게 된다.
 */

// ── 실결제 게이트 ────────────────────────────────────────────────────────────────

/**
 * 실제 결제를 집행해도 되는가. **미설정·오타·빈값·"false" 는 전부 OFF.**
 * `YOUTUBE_UPLOAD_ENABLED` 와 같은 판정을 쓴다 — 두 게이트가 다른 규칙을 쓰면
 * 하나를 고칠 때 다른 하나를 잊는다.
 */
export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.BILLING_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export const BILLING_DISABLED_MESSAGE =
  "실결제가 비활성화되어 있습니다 (BILLING_ENABLED 미설정) — 청구서는 만들어지지만 결제는 실행되지 않습니다.";

/** 포트원 연동에 필요한 env 가 다 있는가. 하나라도 비면 결제 경로를 열지 않는다. */
export function portoneConfigured(env: NodeJS.ProcessEnv = process.env): { ok: boolean; missing: string[] } {
  const need = ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_CHANNEL_KEY", "PORTONE_WEBHOOK_SECRET"];
  const missing = need.filter((k) => !String(env[k] ?? "").trim());
  return { ok: missing.length === 0, missing };
}

// ── 사용량 ───────────────────────────────────────────────────────────────────────

export const USAGE_KINDS = ["analyze_minutes", "clip_render", "publish"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * 중복 과금 방지 키.
 *
 * 재분석은 **다시 원가가 드는 일**이라 별개 사용량이다. 그래서 attempt 를 키에 넣는다 —
 * 안 넣으면 재분석이 공짜가 되고, 매번 넣으면 워커 재시도가 중복 청구가 된다.
 * 여기서 말하는 attempt 는 "사람이 재분석을 시킨 횟수"지 워커의 재시도 횟수가 아니다.
 */
export function usageDedupeKey(kind: UsageKind, subjectId: string, attempt = 0): string {
  return attempt > 0 ? `${kind}:${subjectId}:${attempt}` : `${kind}:${subjectId}`;
}

/** 초 → 청구 분. **올림**이다 — 30초짜리도 파이프라인은 한 번 다 돈다. */
export function billableMinutes(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 60);
}

/**
 * 실측 원가 (2026-08-08 기준 58.6분 회차 ≈ ₩285 → 분당 약 ₩4.9).
 * **청구액이 아니라 마진 감시용**이다. 판매가는 plans 에 사람이 넣는다.
 */
export const COST_KRW_PER_MINUTE = 4.9;

export function estimatedCostKrw(minutes: number): number {
  return Math.round(minutes * COST_KRW_PER_MINUTE * 100) / 100;
}

// ── 쿼터 ─────────────────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  displayName: string;
  monthlyKrw: number;
  includedMin: number;
  /** null = 초과 시 **차단**(청구가 아니라 거부). */
  overageKrwPerMin: number | null;
}

export type QuotaVerdict =
  | { allow: true; reason: ""; overageMin: number }
  | { allow: false; reason: string; code: "no_plan" | "over_quota" | "suspended" };

/**
 * 이 분석을 시작해도 되는가 (계획 3단계 — 쿼터 게이트 402).
 *
 * **요금제가 없으면 거부한다.** 0 으로 때우면 공짜로 쓰다가 나중에 소급 청구하게 되고,
 * 그건 고객과 싸우는 길이다. 사내 테넌트도 단가 0 짜리 요금제를 **명시적으로** 갖는다.
 */
export function checkQuota(input: {
  plan: Plan | null;
  usedMin: number;
  requestMin: number;
  tenantStatus?: string;
}): QuotaVerdict {
  if (input.tenantStatus && input.tenantStatus !== "active") {
    return { allow: false, code: "suspended", reason: `워크스페이스가 ${input.tenantStatus} 상태입니다.` };
  }
  if (!input.plan) {
    return {
      allow: false,
      code: "no_plan",
      reason: "요금제가 지정되지 않았습니다 — 관리자에게 문의하세요.",
    };
  }

  const after = input.usedMin + input.requestMin;
  const overageMin = Math.max(0, after - input.plan.includedMin);
  if (overageMin === 0) return { allow: true, reason: "", overageMin: 0 };

  // 초과 단가가 없으면 "초과분을 청구한다"가 아니라 "여기서 막는다"는 뜻이다.
  if (input.plan.overageKrwPerMin == null) {
    return {
      allow: false,
      code: "over_quota",
      reason: `이번 달 분석 한도(${input.plan.includedMin}분)를 ${overageMin}분 초과합니다 — 요금제를 올려야 진행됩니다.`,
    };
  }
  return { allow: true, reason: "", overageMin };
}

// ── 인보이스 ─────────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  desc: string;
  qty: number;
  unitKrw: number;
  amountKrw: number;
}

export const VAT_RATE = 0.1;

/**
 * 청구서 계산. **부가세는 소계에서 한 번만** 뗀다 — 줄마다 반올림하면 합계가 어긋난다.
 */
export function buildInvoice(lines: InvoiceLine[]): {
  subtotalKrw: number;
  vatKrw: number;
  totalKrw: number;
} {
  const subtotal = lines.reduce((sum, l) => sum + l.amountKrw, 0);
  const subtotalKrw = Math.round(subtotal);
  const vatKrw = Math.round(subtotalKrw * VAT_RATE);
  return { subtotalKrw, vatKrw, totalKrw: subtotalKrw + vatKrw };
}

export function usageLine(plan: Plan, overageMin: number): InvoiceLine | null {
  if (overageMin <= 0 || plan.overageKrwPerMin == null) return null;
  return {
    desc: `분석 초과 사용 ${overageMin}분`,
    qty: overageMin,
    unitKrw: plan.overageKrwPerMin,
    amountKrw: overageMin * plan.overageKrwPerMin,
  };
}

export function planLine(plan: Plan): InvoiceLine | null {
  if (plan.monthlyKrw <= 0) return null;
  return { desc: `${plan.displayName} 월 이용료`, qty: 1, unitKrw: plan.monthlyKrw, amountKrw: plan.monthlyKrw };
}

// ── API 키 ───────────────────────────────────────────────────────────────────────

/**
 * 키 표시용 접두. **평문 전체는 발급 순간에만 보여주고 저장하지 않는다** —
 * 저장하면 DB 유출이 곧 남의 채널에 영상을 올릴 수 있는 권한이 된다.
 */
export function apiKeyPrefix(raw: string): string {
  // `stepd_live_` (11자) + 4자 = 15자. 계획 §2 의 예시(`stepd_live_ab12`)와 같은 길이다.
  return raw.slice(0, 15);
}

/** 라이브 키인가 — 테스트 키로 실제 청구가 일어나면 안 된다. */
export function isLiveApiKey(raw: string): boolean {
  return raw.startsWith("stepd_live_");
}

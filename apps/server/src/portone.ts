/**
 * 포트원 V2 연동 (docs/plans/active/billing-portone-plan.md §4).
 * PG: KG이니시스 **일반결제 채널**.
 *
 * **인증은 API Secret 헤더 직결이다** (§4-0 방식 A). 토큰 발급·리프레시를 쓰지 않으므로
 * Cloud Run 다중 인스턴스에서 액세스토큰을 공유·갱신하는 문제 자체가 없다.
 *
 * ⚠️ 콘솔 채널 설정에 넣는 **KG이니시스 시크릿은 API 인증에 못 쓴다**(401).
 * 인증용은 관리자콘솔 "결제연동" 탭의 V2 API Secret 하나뿐이다. 연동 초기 최빈 실패다.
 *
 * ⚠️ SDK(`@portone/server-sdk`)를 쓰지 않는다. 계획은 SDK 를 권했지만 지금 이 체크아웃은
 * node_modules 가 병렬 세션 작업으로 불안정해서 의존성을 추가하는 게 더 위험하다.
 * 대신 웹훅 검증을 Standard Webhooks 규격대로 직접 구현하고 **테스트로 고정**했다
 * (portone.test.ts). 나중에 SDK 로 갈아탈 거면 verifyWebhook 만 바꾸면 된다.
 */
import crypto from "node:crypto";

const API_BASE = "https://api.portone.io";

export class PortOneError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = "PortOneError";
  }
}

function apiSecret(): string {
  const s = String(process.env.PORTONE_API_SECRET ?? "").trim();
  if (!s) throw new Error("PORTONE_API_SECRET 미설정 — 결제 경로를 열 수 없습니다.");
  return s;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      // 형식이 `Bearer` 가 아니라 `PortOne` 이다 — 여기서 틀리면 전부 401 이다.
      Authorization: `PortOne ${apiSecret()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new PortOneError(res.status, parsed, `포트원 ${method} ${path} 실패 (${res.status})`);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── 빌링키 결제 (§4-2) ───────────────────────────────────────────────────────────

export interface BillingKeyChargeInput {
  /** **우리가 만드는 값**이자 멱등키. cardTopupPaymentId(billing-card.ts)로 만든다. */
  paymentId: string;
  billingKey: string;
  orderName: string;
  /** 원 단위 정수. 소수점을 보내면 거절된다. */
  amountKrw: number;
  customer?: { id?: string; email?: string; name?: string };
}

/**
 * 빌링키로 결제한다.
 *
 * `paymentId` 가 멱등키다 — 같은 값으로 두 번 부르면 포트원이 중복 결제를 막는다.
 * 그래서 워커가 같은 달에 두 번 돌아도 두 번 긁히지 않는다. **이 값을 매번 새로 만들면
 * 그 보호가 통째로 사라진다.**
 */
export async function chargeWithBillingKey(input: BillingKeyChargeInput): Promise<unknown> {
  if (!Number.isInteger(input.amountKrw) || input.amountKrw <= 0) {
    throw new Error(`결제 금액이 잘못됐습니다: ${input.amountKrw}`);
  }
  // ⚠️ **빌링키는 발급한 채널에서만 긁힌다.** 빌링키는 발급 채널(MID)에 묶여 있어서,
  // 일반결제 채널키(PORTONE_CHANNEL_KEY)로 긁으면 그 MID엔 이 빌링키가 없어 결제가 실패한다.
  // 카드 등록은 PORTONE_BILLING_CHANNEL_KEY 로 발급하므로, 결제도 반드시 같은 채널로 한다.
  const channelKey = String(process.env.PORTONE_BILLING_CHANNEL_KEY ?? "").trim();
  if (!channelKey) {
    throw new Error("PORTONE_BILLING_CHANNEL_KEY 미설정 — 저장 카드 결제는 빌링 채널이 필요합니다.");
  }
  return call("POST", `/payments/${encodeURIComponent(input.paymentId)}/billing-key`, {
    storeId: String(process.env.PORTONE_STORE_ID ?? "").trim(),
    channelKey,
    billingKey: input.billingKey,
    orderName: input.orderName,
    amount: { total: input.amountKrw },
    currency: "KRW",
    ...(input.customer ? { customer: input.customer } : {}),
  });
}

/**
 * 결제 단건 조회.
 *
 * **storeId 를 반드시 붙인다.** 안 붙이면 상점이 여럿인 계정에서 404 가 난다
 * (문서상 404 원인 중 하나가 "storeId 가 접근 권한 없는 상점"). 실제로 이것 때문에
 * 웹훅이 도착해도 조회가 404 로 떨어져 충전이 보류됐다.
 */
export async function getPayment(paymentId: string): Promise<unknown> {
  const storeId = String(process.env.PORTONE_STORE_ID ?? "").trim();
  const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
  return call("GET", `/payments/${encodeURIComponent(paymentId)}${qs}`);
}

/**
 * 빌링키 단건 조회 — 저장된 카드의 표시용 정보(브랜드·마스킹된 번호)를 얻는다.
 *
 * 카드 번호는 브라우저 SDK 응답에 오지 않고(빌링키만 온다), 우리 서버도 원본은 못 본다.
 * 대신 이 조회가 **마스킹된 번호와 발급사**를 준다 — 화면에 카드 모양으로 보여줄 재료다.
 * getPayment 과 같은 이유로 storeId 를 붙인다(상점 여럿인 계정에서 404 방지).
 */
export async function getBillingKeyInfo(billingKey: string): Promise<unknown> {
  const storeId = String(process.env.PORTONE_STORE_ID ?? "").trim();
  const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
  return call("GET", `/billing-keys/${encodeURIComponent(billingKey)}${qs}`);
}

// (구 paymentIdFor — 월 단위 구독 결제용 식별자 — 는 2026-08-14 삭제. 선불 크레딧 전환 후
//  사용처가 없었다. 지금 쓰는 식별자는 topupPaymentId(credits.ts)·cardTopupPaymentId(billing-card.ts).)

// ── 웹훅 검증 (§4-5 · Standard Webhooks 규격) ────────────────────────────────────

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type WebhookVerdict =
  | { ok: true; reason: "" }
  | { ok: false; reason: string };

/** 허용 시각 오차. 규격 권장값 5분 — 재전송 공격 창을 좁힌다. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;

/**
 * 웹훅 서명 검증.
 *
 * 서명 대상은 `{id}.{timestamp}.{payload}` **원문 바이트**다. JSON 을 파싱했다가 다시
 * 문자열로 만들면 키 순서·공백이 달라져 서명이 안 맞는다 — 라우트에서 raw body 를 그대로 넘길 것.
 *
 * 실패는 전부 "검증 실패" 하나로 돌려주되 사유는 로그용으로 남긴다.
 * **검증에 실패한 웹훅으로는 아무것도 바꾸지 않는다** — 위조 웹훅 하나로 인보이스가
 * 결제됨이 되면 그 뒤는 되돌릴 수 없다.
 */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): WebhookVerdict {
  if (!secret) return { ok: false, reason: "웹훅 시크릿이 설정되지 않았습니다" };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "웹훅 헤더가 없습니다 (id·timestamp·signature)" };
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp 가 숫자가 아닙니다" };
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) {
    return { ok: false, reason: `timestamp 가 허용 오차(${WEBHOOK_TOLERANCE_SEC}초)를 벗어났습니다` };
  }

  // `whsec_` 접두는 벗기고 base64 로 해석한다(Standard Webhooks).
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(rawSecret, "base64");
  } catch {
    return { ok: false, reason: "웹훅 시크릿이 base64 가 아닙니다" };
  }
  if (key.length === 0) return { ok: false, reason: "웹훅 시크릿이 비어 있습니다" };

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest("base64");

  // 헤더에는 `v1,<sig>` 가 공백으로 여러 개 올 수 있다(시크릿 로테이션).
  const given = headers.signature.split(" ").map((p) => p.trim()).filter(Boolean);
  for (const part of given) {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    if (timingSafeEqualStr(sig, expected)) return { ok: true, reason: "" };
  }
  return { ok: false, reason: "서명이 일치하지 않습니다" };
}

/** 길이가 달라도 예외를 던지지 않는 상수시간 비교. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

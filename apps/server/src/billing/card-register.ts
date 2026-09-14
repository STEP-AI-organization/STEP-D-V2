/**
 * 카드 등록(빌링키 발급) — **제품과 어드민이 같이 쓰는 한 벌.**
 *
 * ## 왜 함수로 뺐나
 *
 * 같은 일을 두 곳에서 한다: 제품의 결제수단 화면(`POST /api/billing/card/issue`)과
 * 운영자 콘솔(`POST /api/superadmin/tenants/:id/card`). 오케스트레이션을 복제하면
 * **"어드민에선 등록되는데 제품에선 안 된다"** 같은 상태가 생기고, 그걸 재현하려면
 * 두 코드를 나란히 놓고 읽어야 한다. 결제는 그런 걸 감당할 자리가 아니다.
 *
 * ## 이 함수는 **던지지 않는다**
 *
 * 카드 원문과 빌링키가 예외 메시지·스택에 실릴 수 있어서, 전역 onError 로 흘러가면
 * 로그에 남는다. 그래서 모든 실패를 값으로 돌려준다(`{ status, body }`). 부르는 쪽은
 * 그대로 `c.json(r.body, r.status)` 하면 된다 — 판단을 다시 하지 않는다.
 *
 * ⚠️ **오류 본문에 입력값을 넣지 않는다.** 되비추면 그 자체가 유출 경로다.
 */
import {
  billingConfig, checkCustomer, extractCardDisplay,
} from "./billing-card.ts";
import { checkCardCredential } from "./card-credential.ts";
import { CardIssueError, getBillingKeyInfo, issueBillingKey } from "./portone.ts";
import { clearAutoTopupAlert } from "./auto-topup.ts";
import { getBillingCard, saveBillingCard } from "../db-pg.ts";

export interface CardRegisterOutcome {
  status: 200 | 400 | 502 | 503;
  body: Record<string, unknown>;
}

export interface CardRegisterInput {
  /** 요청 본문 그대로. 파싱 실패면 null 을 넘긴다. */
  body: Record<string, unknown> | null;
  /** 감사에 남길 사람 — 제품은 매니저 이메일, 어드민은 운영자 이메일. */
  actor: string;
  /**
   * 포트원 `customerId`. **테넌트 id 다** — 빌링키가 어느 회사 것인지의 기준이라
   * 부르는 쪽이 명시한다(어드민은 세션 테넌트가 아니라 대상 회사를 넣는다).
   */
  customerId: string;
  /**
   * 자동결제 동의를 요구할지. 제품은 **필수**(사람이 체크박스를 누른다).
   * 어드민의 결제 시험은 운영자가 우리 카드로 확인하는 자리라 동의 대상이 아니다 —
   * 대신 부르는 쪽이 감사 로그를 남긴다.
   */
  requireConsent: boolean;
}

/**
 * 카드 원문 → 빌링키 발급 → 저장. 성공하면 `{ ok: true, brand, last4 }`.
 *
 * 표시정보(카드사·끝 4자리) 조회가 실패해도 **발급 성공을 뒤집지 않는다** — 키는 이미
 * 발급됐고, 그걸 실패로 닫으면 사람이 카드를 다시 등록해 빌링키가 하나 더 생긴다.
 */
export async function registerCard(input: CardRegisterInput): Promise<CardRegisterOutcome> {
  const cfg = billingConfig();
  if (!cfg.ok || !String(process.env.PORTONE_API_SECRET ?? "").trim()) {
    return { status: 503, body: { error: "billing_unconfigured", message: "카드 등록 설정을 확인해 주세요." } };
  }
  try {
    const body = input.body;
    if (!body) {
      return { status: 400, body: { error: "invalid_card", message: "카드 등록 요청 형식이 올바르지 않습니다." } };
    }
    if (input.requireConsent && body.autoChargeConsent !== true) {
      return { status: 400, body: { error: "consent_required", message: "자동결제 안내에 동의해 주세요." } };
    }
    const checked = checkCardCredential(body.credential);
    if (!checked.ok) return { status: 400, body: { error: "invalid_card", message: checked.message } };

    // 구매자 3종은 KG이니시스 빌링키 결제의 필수값이다 — 등록 때 받아 둬야 나중에 긁을 수 있다.
    const saved = await getBillingCard();
    const buyer = (body.buyer ?? {}) as Record<string, unknown>;
    const who = checkCustomer({
      fullName: String(buyer.fullName ?? "").trim() || saved?.buyerName || "",
      email: String(buyer.email ?? "").trim() || saved?.buyerEmail || "",
      phoneNumber: String(buyer.phoneNumber ?? "").trim() || saved?.buyerPhone || "",
    });
    if (!who.ok) return { status: 400, body: { error: "customer_required", message: who.message } };

    const billingKey = await issueBillingKey({
      ...cfg.config, customerId: input.customerId, customer: who.customer, credential: checked.credential,
    });

    let display: { brand: string | null; last4: string | null } = {
      brand: null, last4: checked.credential.number.slice(-4),
    };
    try {
      const found = extractCardDisplay(await getBillingKeyInfo(billingKey));
      display = { brand: found.brand, last4: found.last4 ?? display.last4 };
    } catch { /* 표시정보 조회 실패는 발급 성공을 뒤집지 않는다. 원문 로그 금지. */ }

    await saveBillingCard({
      billingKey, cardBrand: display.brand, cardLast4: display.last4,
      issuedBy: input.actor, buyer: who.customer,
    });
    try { await clearAutoTopupAlert("card-register"); } catch { /* 저장 성공 후 재등록을 유도하지 않는다. */ }

    // ⚠️ **응답에 카드 정보를 싣지 않는다.** 원래 계약이 `{ ok: true }` 뿐이었고 그게
    // 의도된 방어다 — 부르는 쪽은 결제수단을 다시 조회해서 확인한다(제품·어드민 둘 다).
    return { status: 200, body: { ok: true } };
  } catch (err) {
    if (err instanceof CardIssueError) {
      return { status: 502, body: { error: "card_issue_failed", message: err.message } };
    }
    return {
      status: 503,
      body: {
        error: "card_registration_failed",
        message: "카드 등록 결과를 확인하지 못했습니다. 결제수단을 다시 조회해 등록 상태를 확인해 주세요.",
      },
    };
  }
}

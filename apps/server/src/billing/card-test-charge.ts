/**
 * 운영자 시험 결제 — **비인증(빌링키) 결제가 실제로 되는지** 어드민에서 확인하는 자리.
 *
 * ## 왜 따로 있나 (그리고 어디까지만 다른가)
 *
 * 제품의 저장카드 충전(`POST /api/credits/topup/card`)은 사람이 브라우저에서 누르는
 * 경로라 **더블클릭·네트워크 재시도** 방어가 두껍다(브라우저 멱등키, 실패한 paymentId
 * 슬롯 밀기, 테넌트 잠금). 운영자가 콘솔에서 한 번 누르는 시험에는 그 층이 필요 없다.
 *
 * **다른 건 그 층뿐이고, 돈이 오가는 순서는 똑같다:**
 *   주문 생성 → 빌링키 결제 → 단건 조회로 확인 → **원장 먼저** → 상태 표시
 * 이 순서를 시험용으로 바꾸면 시험이 운영을 검증하지 못한다. 특히 원장을 나중에 쓰면
 * 그 사이 예외에서 크레딧이 영구히 사라지는데, 시험에서만 안 나타나는 종류의 사고다.
 *
 * ## 금액
 *
 * 크레딧 개수로 받는다 — 제품과 **같은 단가 계산**(`buildTopup`)을 타야 "제품에서 긁힐
 * 금액" 을 그대로 시험한 것이 된다. 1개면 공급가 ₩60 + 부가세 ₩6 = **₩66**.
 * 상한은 여기서 못박는다(아래 `MAX_TEST_CREDITS`) — 운영자 콘솔에서 오타 하나로 고객
 * 카드에 큰 금액이 긁히는 일을 코드가 막는다.
 */
import {
  addCreditEntry, createTopup, creditBalance, getBillingCard, getTopup, markTopupPaid,
} from "../db-pg.ts";
import { cardBlockReason, cardTopupPaymentId, declineMessage, verifyCharge } from "./billing-card.ts";
import { buildTopup, topupDedupeKey } from "./credits.ts";
import { chargeWithBillingKey, getPayment } from "./portone.ts";
import { sendInvoiceEmail } from "./invoice-email.ts";

/**
 * 시험 결제로 한 번에 긁을 수 있는 최대 크레딧. **10개 = ₩660.**
 *
 * 시험의 목적은 "레일이 도는가" 이고, 그건 ₩66 이면 증명된다. 상한을 두는 이유는 금액을
 * 아끼려는 게 아니라 **오타 방어**다 — 운영자 콘솔은 회사를 골라서 그 회사 카드를 긁는
 * 자리라, 1000 을 잘못 치면 ₩66,000 이 고객 카드에서 빠진다.
 */
export const MAX_TEST_CREDITS = 10;

export interface TestChargeOutcome {
  status: 200 | 400 | 402 | 409 | 503;
  body: Record<string, unknown>;
}

/**
 * 지정한(이미 `runWithTenant` 로 들어와 있는) 회사의 저장 카드로 소액을 긁는다.
 *
 * 던지지 않는다 — 실패도 값으로 준다. 결제 예외에는 PG 응답 원문이 붙어 있어 그대로
 * 흘리면 빌링키가 로그·응답에 남을 수 있다.
 */
export async function runTestCharge(input: {
  tenantId: string;
  actor: string;
  credits: unknown;
  /** 같은 버튼을 두 번 눌러도 두 번 안 긁히게 하는 값. 호출부가 만든다. */
  nonce: string;
}): Promise<TestChargeOutcome> {
  const check = buildTopup(input.credits);
  if (!check.ok) return { status: 400, body: { error: "bad_request", message: check.reason } };
  if (check.credits > MAX_TEST_CREDITS) {
    return {
      status: 400,
      body: {
        error: "too_large",
        message: `시험 결제는 ${MAX_TEST_CREDITS}크레딧까지입니다 — 레일 확인이 목적이라 소액으로 못박아 뒀습니다.`,
      },
    };
  }

  const card = await getBillingCard();
  const blocked = cardBlockReason(card);
  if (blocked) return { status: 409, body: { error: "no_card", message: blocked } };

  // 이니시스 필수 3종. 등록 때 저장된 값이 정본이고, 없으면 긁을 수 없다(폴백 입력이 없는 자리다).
  if (!card?.buyerName || !card?.buyerEmail || !card?.buyerPhone) {
    return {
      status: 409,
      body: {
        error: "customer_required",
        message: "이 카드에 구매자 정보(이름·이메일·휴대폰)가 없어 결제할 수 없습니다 — 카드를 다시 등록해 주세요.",
      },
    };
  }
  const customer = { fullName: card.buyerName, email: card.buyerEmail, phoneNumber: card.buyerPhone };

  const paymentId = cardTopupPaymentId(input.tenantId, input.nonce);
  const existing = await getTopup(paymentId);
  if (existing?.status === "paid") {
    // 같은 nonce 로 이미 성공했다 — 다시 긁지 않고 그 결과를 보여준다.
    return {
      status: 200,
      body: {
        ok: true, duplicate: true, paymentId,
        credits: existing.credits, amountKrw: existing.amountKrw, balance: await creditBalance(),
      },
    };
  }
  if (!existing) {
    // 주문 먼저 — 승인 응답을 놓쳐도 "긁혔을 수 있는 것" 이 기록으로 남는다.
    // requestedBy 로 시험 결제임을 남긴다(자동충전 상한 집계는 'auto-topup' 만 센다).
    await createTopup({
      paymentId, credits: check.credits, amountKrw: check.amountKrw,
      status: "pending", requestedBy: `superadmin-test:${input.actor}`,
    });
  }

  try {
    await chargeWithBillingKey({
      paymentId,
      billingKey: card.billingKey!,
      orderName: `STEP-D 결제 시험 ${check.credits}개`,
      amountKrw: check.amountKrw,
      customer,
    });
  } catch (e) {
    const alreadyPaid = /ALREADY[_ ]?PAID/i.test(
      JSON.stringify((e as { body?: unknown })?.body ?? "") + String(e instanceof Error ? e.message : e));
    if (!alreadyPaid) {
      // 원문은 로그에만 — 응답에는 declineMessage 가 만든 사람 말만 나간다(제품과 같은 함수).
      console.warn(`[billing] 시험 결제 거절 ${paymentId}:`, e instanceof Error ? e.message : e);
      await markTopupPaid(paymentId, "failed").catch(() => {});
      return { status: 402, body: { error: "charge_failed", message: declineMessage(e) } };
    }
  }

  // 동기 빌링키 응답엔 status·amount 가 없다 — 단건 조회로 확인한다(제품과 같은 이유).
  let verdict: { ok: true } | { ok: false; message: string };
  try {
    verdict = verifyCharge({ response: await getPayment(paymentId), expectedKrw: check.amountKrw });
  } catch {
    verdict = { ok: false, message: "결제 상태 조회가 일시적으로 실패했습니다." };
  }
  if (!verdict.ok) {
    // failed 로 닫지 않는다 — **돈은 나갔을 수 있다.** pending 으로 두면 웹훅이 정산한다.
    console.warn(`[billing] 시험 결제 확인 보류 ${paymentId}: ${verdict.message}`);
    return {
      status: 409,
      body: {
        error: "charge_unverified",
        paymentId,
        message: "결제는 보냈는데 확인이 안 됐습니다 — 다시 긁지 마세요. 웹훅이 정산하면 결제 로그에 반영됩니다.",
      },
    };
  }

  // ⚠️ **원장이 먼저다.** 상태를 먼저 paid 로 찍고 그 사이에서 던지면 재시도가 'paid' 가드에
  // 막혀 크레딧이 영구히 사라진다. 제품 경로와 같은 순서를 일부러 지킨다.
  const credited = await addCreditEntry({
    delta: check.credits,
    reason: "topup",
    paymentId,
    amountKrw: check.amountKrw,
    note: "운영자 결제 시험",
    actor: input.actor,
    dedupeKey: topupDedupeKey(paymentId),
  });
  await markTopupPaid(paymentId, "paid");
  /**
   * 영수증 메일 — **운영 경로와 같은 자리에서, 같은 조건으로.**
   *
   * 처음엔 이걸 빠뜨렸다. 그러면 시험이 "결제는 되는데 영수증은 안 나가는" 절반만
   * 증명하고, 정작 **인보이스 메일이 실제로 나가는지는 영원히 확인 못 한다** — 이 시험의
   * 목적이 운영 경로를 그대로 밟는 것인데 마지막 고리에서 갈라지는 셈이다.
   *
   * `credited` 일 때만 보내는 것도 같다(웹훅이 먼저 정산했으면 거기서 이미 보냈다).
   * fire-and-forget — 메일 실패가 결제·적립 결과를 뒤집으면 안 된다.
   */
  if (credited) void sendInvoiceEmail(paymentId, input.tenantId);

  return {
    status: 200,
    body: {
      ok: true, paymentId,
      credits: check.credits, amountKrw: check.amountKrw,
      supplyKrw: check.supplyKrw, vatKrw: check.vatKrw,
      balance: await creditBalance(),
      card: { brand: card.cardBrand ?? null, last4: card.cardLast4 ?? null },
    },
  };
}

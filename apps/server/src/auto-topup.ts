/**
 * 자동 충전 — 잔액이 임계 이하로 떨어지면 저장 카드로 자동 결제한다.
 *
 * ## 왜 별도 모듈인가
 * 판정(shouldAutoTopup·상한)은 credits.ts 순수 함수, 정책 저장은 db-pg, 결제는 portone.
 * 이 파일은 그 셋을 **현재 테넌트 컨텍스트 안에서** 잇는 배선이다. 크레딧 차감 뒤(분석 잡),
 * 설정 저장 뒤, 수동 실행 — **어디서 불러도 안전**하게 설계했다:
 *   - 꺼짐/카드 없음/상한 초과/잔액 충분이면 조용히 아무것도 안 한다.
 *   - 실제 결제·적립은 수동 저장카드 충전(/api/credits/topup/card)과 **완전히 같은 경로**를 쓴다
 *     (멱등키 dedupe_key · **원장 먼저** · 금액 서버 계산 · 승인 응답 대조).
 *
 * ## 폭주 방어
 * shouldAutoTopup 이 하루 최대 횟수·월 최대 금액을 본다. 충전은 잔액을 임계 위로 올리므로
 * 다음 호출은 자연히 조건에 안 걸린다(잔액이 다시 떨어질 때까지). 상한은 그 위의 안전벨트다.
 */
import {
  addCreditEntry,
  autoTopupMonthKrw,
  autoTopupTodayAttempts,
  autoTopupTodayCount,
  createTopup,
  creditBalance,
  getAutoTopupPolicy,
  getBillingCard,
  listUnsettledAutoTopups,
  markTopupPaid,
  withTenantLock,
} from "./db-pg.ts";
import { cardBlockReason, cardTopupPaymentId, verifyCharge } from "./billing-card.ts";
import { chargeWithBillingKey, getPayment } from "./portone.ts";
import { buildTopup, shouldAutoTopup, topupDedupeKey } from "./credits.ts";
import { currentTenantId } from "./tenant.ts";

export interface AutoTopupResult {
  charged: boolean;
  /** 왜 충전했/안 했는지 — 로그·화면용. 충전했으면 빈 문자열. */
  reason: string;
  credits?: number;
  amountKrw?: number;
  balance?: number;
}

// ── 결정적 paymentId ─────────────────────────────────────────────────────────────
// paymentId 가 포트원의 멱등키다(portone.ts). 시도마다 랜덤으로 만들면 그 보호가 죽는다 —
// 동시 트리거 둘이 각자 다른 id 로 결제해 카드가 두 번 긁힌다. (테넌트, KST 날짜, 당일
// 시도 슬롯)에서 항상 같은 값이 나오게 해, 잠금이 못 잡는 경계(트랜잭션 롤백 뒤 재시도 등)
// 에서도 중복이 포트원 단에서 충돌하게 만든다.

/** KST 날짜 스탬프(YYYYMMDD) — 서버 타임존이 어디든 같은 날짜가 나와야 슬롯이 결정적이다. */
export function kstDateStamp(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 같은 (날짜, 슬롯)이면 항상 같은 nonce. 슬롯은 당일 시도 수 + 1 (실패분 포함). */
export function autoTopupNonce(kstDate: string, slot: number): string {
  return `auto${kstDate}s${slot}`;
}

/**
 * 필요하면 자동 충전한다. **현재 테넌트 컨텍스트 안에서** 호출할 것.
 * 절대 예외를 밖으로 던지지 않는다 — 자동 충전 실패가 분석 잡을 깨면 안 된다(호출부가 삼킨다).
 */
export async function maybeAutoTopup(): Promise<AutoTopupResult> {
  const policy = await getAutoTopupPolicy();
  if (!policy || !policy.enabled) return { charged: false, reason: "자동 충전이 꺼져 있습니다." };

  // 카드가 없으면(미등록·해지) 자동 충전은 성립하지 않는다.
  const card = await getBillingCard();
  const blocked = cardBlockReason(card);
  if (blocked) return { charged: false, reason: blocked };

  const balance = await creditBalance();

  // 충전 금액은 **서버가** 정책의 topupCredits 로 계산한다(단가·최소/최대 검증 포함).
  const check = buildTopup(policy.topupCredits);
  if (!check.ok) return { charged: false, reason: `자동 충전 금액이 올바르지 않습니다: ${check.reason}` };

  const [todayCount, monthKrw] = await Promise.all([autoTopupTodayCount(), autoTopupMonthKrw()]);
  const verdict = shouldAutoTopup({
    policy: {
      enabled: policy.enabled,
      thresholdCredits: policy.thresholdCredits,
      topupCredits: policy.topupCredits,
      maxPerDay: policy.maxPerDay,
      maxKrwPerMonth: policy.maxKrwPerMonth,
    },
    balance,
    todayCount,
    monthKrw,
    amountKrw: check.amountKrw,
  });
  if (!verdict.charge) return { charged: false, reason: verdict.reason, balance };

  // ── 판정~과금은 테넌트 잠금 안에서 직렬화한다 ────────────────────────────────────
  // 동시 트리거(분석 잡 여러 개가 나란히 차감) 둘이 위 판정을 같이 통과하면 카드가 두 번
  // 긁힌다. 잠금을 기다린 쪽은 앞선 충전이 커밋된 뒤의 잔액·상한으로 **재판정**해서
  // 조건이 이미 해소됐으면 긁지 않는다.
  const tenantId = currentTenantId();
  return await withTenantLock(`auto-topup:${tenantId}`, async () => {
    const [balance2, todayCount2, monthKrw2, attempts] = await Promise.all([
      creditBalance(), autoTopupTodayCount(), autoTopupMonthKrw(), autoTopupTodayAttempts(),
    ]);
    const verdict2 = shouldAutoTopup({
      policy: {
        enabled: policy.enabled,
        thresholdCredits: policy.thresholdCredits,
        topupCredits: policy.topupCredits,
        maxPerDay: policy.maxPerDay,
        maxKrwPerMonth: policy.maxKrwPerMonth,
      },
      balance: balance2,
      todayCount: todayCount2,
      monthKrw: monthKrw2,
      amountKrw: check.amountKrw,
    });
    if (!verdict2.charge) return { charged: false, reason: verdict2.reason, balance: balance2 };

    // ── 미정산 주문 정산 — 새 결제 **전에** ─────────────────────────────────────────
    // 결제 호출이 승인 뒤 타임아웃으로 끊기면 주문은 pending/failed 인데 카드는 긁혀 있다.
    // 그 위에 새 결제를 이어가면 이중 청구다. 포트원에 실제 상태를 물어 PAID 로 승인돼
    // 있으면 크레딧만 정산하고 이번 순번은 새 결제 없이 끝낸다 — 정산된 잔액이면
    // 애초에 충전이 필요 없어졌을 수 있고, 다음 트리거가 다시 판정한다.
    for (const order of await listUnsettledAutoTopups()) {
      let payment: unknown;
      try {
        payment = await getPayment(order.paymentId);
      } catch {
        // 404 = 포트원에 도달한 적 없는 주문(결제 요청 전에 죽음) — 정산할 것이 없다.
        // 일시 오류도 건너뛴다: 정산은 매 트리거마다 다시 시도되므로 놓치지 않는다.
        continue;
      }
      // 수동·자동 충전과 같은 대조(unwrapPayment 포함) — PAID + 금액 일치일 때만 정산한다.
      const settled = verifyCharge({ response: payment, expectedKrw: order.amountKrw });
      if (!settled.ok) continue; // 미승인(FAILED 등)·금액 불일치는 정산 대상이 아니다
      // 웹훅과 같은 순서: **원장 먼저**(dedupe_key 멱등) → 상태는 그 사실의 표시.
      await addCreditEntry({
        delta: order.credits,
        reason: "topup",
        paymentId: order.paymentId,
        amountKrw: order.amountKrw,
        note: "자동 충전 미정산 정산 (승인 후 응답 유실분)",
        actor: "auto-topup",
        dedupeKey: topupDedupeKey(order.paymentId),
      });
      await markTopupPaid(order.paymentId, "paid");
      return {
        charged: false,
        reason: "미정산 자동 충전을 정산했습니다 — 이번 순번은 새 결제 없이 끝냅니다.",
        credits: order.credits,
        amountKrw: order.amountKrw,
        balance: balance2 + order.credits,
      };
    }

    // ── 여기부터 수동 저장카드 충전과 동일한 결제·적립 경로 ────────────────────────
    const paymentId = cardTopupPaymentId(tenantId, autoTopupNonce(kstDateStamp(), attempts + 1));
    // 주문 먼저 — 승인 응답을 못 받아도 "긁혔을 수 있는 것"이 기록으로 남는다. requested_by 로
    // 자동/수동을 구분해 상한 집계(autoTopupTodayCount/MonthKrw)가 자동분만 센다.
    await createTopup({
      paymentId, credits: check.credits, amountKrw: check.amountKrw,
      status: "pending", requestedBy: "auto-topup",
    });

    try {
      await chargeWithBillingKey({
        paymentId,
        billingKey: card!.billingKey!,
        orderName: `STEP-D 자동 충전 ${check.credits}개`,
        amountKrw: check.amountKrw,
      });
    } catch (e) {
      // "이미 결제됨"은 우리가 응답을 놓친 성공이다 — failed 로 닫지 말고 아래 재조회로 정산.
      const alreadyPaid = /ALREADY[_ ]?PAID/i.test(
        JSON.stringify((e as { body?: unknown })?.body ?? "") + String(e instanceof Error ? e.message : e));
      if (!alreadyPaid) {
        // 진짜 거절(한도·정지 카드 등) — 여기만 failed 가 맞다.
        await markTopupPaid(paymentId, "failed").catch(() => {});
        return { charged: false, reason: `자동 충전 결제 실패: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // 동기 빌링키 응답엔 status·amount 가 없다(수동 경로와 같은 이유) — 단건 조회로 재확인.
    let ver: { ok: true } | { ok: false; message: string };
    try {
      ver = verifyCharge({ response: await getPayment(paymentId), expectedKrw: check.amountKrw });
    } catch {
      ver = { ok: false, message: "결제 상태 조회가 일시적으로 실패했습니다." };
    }
    if (!ver.ok) {
      // failed 로 찍지 않는다 — **돈이 나갔을 수 있다.** pending 으로 남기면 웹훅 또는
      // 다음 트리거의 미정산 정산(위 reconcile)이 진실을 반영한다. 결제 호출이 거절된 것
      // (위 catch)과 확인이 안 된 것은 다른 사건이다 — 같은 failed 로 뭉뚱그리면 기록이
      // 거짓말한다.
      return { charged: false, reason: `자동 충전 확인 보류: ${ver.message} — 웹훅/재조회가 정산합니다.` };
    }

    // ⚠️ **원장 먼저**(멱등 dedupe_key), 상태는 그 사실의 표시로 뒤에. 수동 경로와 같은 순서 —
    // 상태를 먼저 찍고 그 사이에서 던지면 크레딧이 영구 손실될 수 있다.
    await addCreditEntry({
      delta: check.credits,
      reason: "topup",
      paymentId,
      amountKrw: check.amountKrw,
      note: "자동 충전 (잔액 임계 이하)",
      actor: "auto-topup",
      dedupeKey: topupDedupeKey(paymentId),
    });
    await markTopupPaid(paymentId, "paid");

    return {
      charged: true,
      reason: "",
      credits: check.credits,
      amountKrw: check.amountKrw,
      balance: balance2 + check.credits,
    };
  });
}

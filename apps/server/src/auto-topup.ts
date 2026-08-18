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
  getAutoTopupAlert,
  getAutoTopupPolicy,
  getBillingCard,
  listUnsettledAutoTopups,
  markTopupPaid,
  setAutoTopupAlert,
  withTenantLock,
} from "./db-pg.ts";
import { cardBlock, cardTopupPaymentId, declineMessage, verifyCharge } from "./billing-card.ts";
import { sendInvoiceEmail } from "./invoice-email.ts";
import { chargeWithBillingKey, getPayment } from "./portone.ts";
import {
  buildTopup, creditPriceKrw, nextAutoTopupAlert, shouldAutoTopup, topupDedupeKey,
  type AutoTopupCode,
} from "./credits.ts";
import { currentTenantId } from "./tenant.ts";

export interface AutoTopupResult {
  charged: boolean;
  /** 왜 충전했/안 했는지 — 로그·화면용. 충전했으면 빈 문자열. */
  reason: string;
  /**
   * 기계 판독 사유. **필수다** — optional 로 두면 미분류 return 이 조용히 생겨
   * "조치가 필요한 실패인데 아무 데도 안 보임"(이 기능이 메우려는 구멍)이 재발한다.
   * 필수라서 return 하나를 빠뜨리면 tsc 가 잡는다.
   */
  code: AutoTopupCode;
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
 *
 * 알림 저장은 이걸 감싼 `maybeAutoTopup` 이 한다 — 이 함수는 판정·결제만 한다.
 */
async function runAutoTopup(): Promise<AutoTopupResult> {
  const policy = await getAutoTopupPolicy();
  if (!policy || !policy.enabled) return { charged: false, code: "disabled", reason: "자동 충전이 꺼져 있습니다." };

  // 카드가 없으면(미등록·해지) 자동 충전은 성립하지 않는다.
  const card = await getBillingCard();
  const blocked = cardBlock(card);
  if (blocked) return { charged: false, code: blocked.code, reason: blocked.reason };

  // 빌링키 결제의 customer 필수 3종(이니시스). 자동 경로엔 화면 입력 폴백이 없다 —
  // 0037 이전 카드(저장분 없음)는 수동 충전 1회 성공(백필) 또는 카드 재등록이 선행돼야 한다.
  if (!card?.buyerName || !card?.buyerEmail || !card?.buyerPhone) {
    return {
      charged: false,
      code: "no_buyer_info",
      // 같은 조치를 여기선 "수동 충전", 힌트에선 "직접 충전" 이라 불러 화면에 두 이름이 같이
      // 떴다 — 사용자는 서로 다른 두 가지 방법이 있는 줄 안다. 화면 어휘("직접 충전")로 통일.
      reason: "카드에 구매자 정보가 없어 자동 결제를 보낼 수 없습니다 — 직접 충전 1회 또는 카드 재등록으로 채워집니다.",
    };
  }
  const customer = { fullName: card.buyerName, email: card.buyerEmail, phoneNumber: card.buyerPhone };

  const balance = await creditBalance();

  // 충전 금액은 **서버가** 정책의 topupCredits 로 계산한다(단가·최소/최대 검증 포함).
  const check = buildTopup(policy.topupCredits);
  if (!check.ok) {
    // ⚠️ **사용자가 고칠 수 있는 실패와 아닌 실패를 가른다.** 예전엔 둘 다 bad_amount 라
    // 단가 미설정(서비스 쪽 설정)에도 "자동 충전 설정에서 충전량을 다시 지정하세요" 라는
    // 힌트가 붙었다 — 사용자가 충전량을 몇 번을 고쳐도 절대 안 풀린다. 게다가 buildTopup 의
    // 원문에는 설정 이름이 들어 있어 그대로 붙이면 그것도 화면에 샌다.
    if (creditPriceKrw() == null) {
      console.error("[auto-topup] 크레딧 단가 미설정 — 자동 충전 불가(서버 설정 필요)");
      return { charged: false, code: "price_unset", reason: "결제 단가가 설정되지 않아 자동 충전을 보낼 수 없습니다." };
    }
    return { charged: false, code: "bad_amount", reason: `자동 충전 금액이 올바르지 않습니다: ${check.reason}` };
  }

  // ⚠️ 하루 상한은 **시도** 기준으로 센다(성공분만 세면 안 된다).
  // 카드가 한도초과·정지면 승인은 0건이라 maxPerDay 도 절대상한(10회)도 영원히 안 걸리고,
  // 분석이 끝날 때마다 카드 승인 시도가 계속 나간다 — 사용자는 거절 알림을 반복 수신하고
  // 이상거래로 카드가 막힐 수 있다. "조용히 계속 긁지 않습니다" 라는 안전벨트가 정확히
  // 실패 경로에서만 무력했다.
  const [todayCount, monthKrw] = await Promise.all([autoTopupTodayAttempts(), autoTopupMonthKrw()]);
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
  if (!verdict.charge) return { charged: false, code: verdict.code, reason: verdict.reason, balance };

  // ── 판정~과금은 테넌트 잠금 안에서 직렬화한다 ────────────────────────────────────
  // 동시 트리거(분석 잡 여러 개가 나란히 차감) 둘이 위 판정을 같이 통과하면 카드가 두 번
  // 긁힌다. 잠금을 기다린 쪽은 앞선 충전이 커밋된 뒤의 잔액·상한으로 **재판정**해서
  // 조건이 이미 해소됐으면 긁지 않는다.
  const tenantId = currentTenantId();
  return await withTenantLock(`auto-topup:${tenantId}`, async () => {
    // 재판정도 같은 기준(시도 수)으로 — 두 판정이 다른 숫자를 보면 상한이 새는 쪽으로 샌다.
    const [balance2, monthKrw2, attempts] = await Promise.all([
      creditBalance(), autoTopupMonthKrw(), autoTopupTodayAttempts(),
    ]);
    const todayCount2 = attempts;
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
    if (!verdict2.charge) return { charged: false, code: verdict2.code, reason: verdict2.reason, balance: balance2 };

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
      const reconCredited = await addCreditEntry({
        delta: order.credits,
        reason: "topup",
        paymentId: order.paymentId,
        amountKrw: order.amountKrw,
        note: "자동 충전 미정산 정산 (승인 후 응답 유실분)",
        actor: "auto-topup",
        dedupeKey: topupDedupeKey(order.paymentId),
      });
      await markTopupPaid(order.paymentId, "paid");
      // 인보이스 메일 — 이 정산이 실제로 적립했을 때만(웹훅이 먼저 했으면 거기서 보냈다).
      if (reconCredited) void sendInvoiceEmail(order.paymentId, tenantId);
      return {
        charged: false,
        code: "reconciled",
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
        customer,
      });
    } catch (e) {
      // "이미 결제됨"은 우리가 응답을 놓친 성공이다 — failed 로 닫지 말고 아래 재조회로 정산.
      const alreadyPaid = /ALREADY[_ ]?PAID/i.test(
        JSON.stringify((e as { body?: unknown })?.body ?? "") + String(e instanceof Error ? e.message : e));
      if (!alreadyPaid) {
        // 진짜 거절(한도·정지 카드 등) — 여기만 failed 가 맞다.
        // 문구는 declineMessage 로 만든다: 우리가 만든 "포트원 POST … 실패 (400)" 을 그대로
        // 남기면 사용자가 카드사에 물을 것이 하나도 없다(진짜 사유는 응답 body 의 pgMessage).
        await markTopupPaid(paymentId, "failed").catch(() => {});
        // 원문은 **로그에만** 남긴다 — 사용자 알림에는 declineMessage 가 만든 사람 말만 간다.
        console.warn(`[auto-topup] 결제 거절 ${paymentId}:`, e instanceof Error ? e.message : e);
        return { charged: false, code: "charge_declined", reason: `자동 충전 결제 실패: ${declineMessage(e)}` };
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
      //
      // 문구에 ver.message 를 붙이면 "결제가 완료되지 않았습니다 (상태 READY)" 처럼 결제사
      // 상태값이 그대로 뜨고, "웹훅/재조회가 정산합니다" 는 우리끼리 쓰는 말이다.
      // 원문은 로그로, 사용자에게는 지금 상태와 할 일(=없음)만.
      console.warn(`[auto-topup] 결제 확인 보류 ${paymentId}: ${ver.message}`);
      return {
        charged: false, code: "unverified",
        reason: "결제 확인 중입니다 — 확인되면 크레딧이 자동으로 올라갑니다. 확인될 때까지 다시 결제하지 않습니다.",
      };
    }

    // ⚠️ **원장 먼저**(멱등 dedupe_key), 상태는 그 사실의 표시로 뒤에. 수동 경로와 같은 순서 —
    // 상태를 먼저 찍고 그 사이에서 던지면 크레딧이 영구 손실될 수 있다.
    const credited = await addCreditEntry({
      delta: check.credits,
      reason: "topup",
      paymentId,
      amountKrw: check.amountKrw,
      note: "자동 충전 (잔액 임계 이하)",
      actor: "auto-topup",
      dedupeKey: topupDedupeKey(paymentId),
    });
    await markTopupPaid(paymentId, "paid");
    // 인보이스 메일 — 실제 적립분만. 실패해도 충전 결과에 영향 없다(fire-and-forget).
    if (credited) void sendInvoiceEmail(paymentId, tenantId);

    return {
      charged: true,
      code: "charged",
      reason: "",
      credits: check.credits,
      amountKrw: check.amountKrw,
      balance: balance2 + check.credits,
    };
  });
}

/**
 * 자동 충전 + **결과를 제품 안에 남기기**.
 *
 * 예전엔 실패 사유가 호출부의 `console.warn` 하나로 끝나, 카드 한도초과·정지·상한 도달처럼
 * **사용자가 조치해야 끝나는 실패**가 화면 어디에도 없었다. 잔액이 0 이 되면 순방은
 * "크레딧 부족" 만 말하고 왜 자동 충전이 그걸 못 메웠는지는 아무도 몰랐다.
 *
 * 그래서 저장을 **호출부가 아니라 여기** 한 곳에 둔다 — 분석 완료 경로든 수동 실행
 * 라우트든 어디로 들어와도 같은 알림이 남는다(호출부마다 배선하면 반드시 한쪽이 빠진다).
 * 알림 쓰기 실패가 충전 결과를 뒤집으면 안 되므로 삼키되, 조용히 넘기지는 않는다.
 */
export async function maybeAutoTopup(): Promise<AutoTopupResult> {
  const result = await runAutoTopup();
  try {
    const prev = await getAutoTopupAlert();
    const next = nextAutoTopupAlert(prev, result, new Date().toISOString());
    // 해제(next=null)도 저장한다 — 해결된 경고가 남아 있으면 다음부터 아무도 안 본다.
    // 애초에 알림이 없고 지금도 없으면 쓰지 않는다(분석마다 도는 경로라 무의미한 왕복 제거).
    if (next || prev) await setAutoTopupAlert(next);
  } catch (e) {
    console.error("[auto-topup] 실패 알림 저장 실패(충전 결과는 유효):", e instanceof Error ? e.message : e);
  }
  return result;
}

/**
 * 자동 충전 경고를 **해제**한다 — 사용자가 그 문제를 해결한 자리에서 부른다
 * (카드 재등록 · 자동 충전 설정 저장 · **직접 충전 성공**).
 *
 * 해제 지점을 라우트마다 각자 배선하면 반드시 한 곳이 빠진다 — 실제로 직접 충전
 * (POST /api/credits/topup/card) 이 빠져서, no_buyer_info 힌트가 "직접 충전 1회로 채워집니다"
 * 라고 안내해 놓고 사용자가 그대로 했는데 경고가 그대로 남았다. 안내한 조치를 했는데 화면이
 * 안 바뀌면 사용자는 그 다음부터 경고를 안 믿는다.
 *
 * 남은 사유가 아직 유효하면 다음 시도가 같은 알림을 다시 만든다 — 지우는 쪽이 안전한 방향이다
 * (거짓 경고는 진짜 경고를 가리지만, 지워진 경고는 다음 트리거에 되살아난다).
 * 실패는 삼킨다: 알림은 사후 표시라, 이것 때문에 결제·설정 저장을 되돌리면 손해가 더 크다.
 */
export async function clearAutoTopupAlert(where: string): Promise<void> {
  try {
    await setAutoTopupAlert(null);
  } catch (e) {
    console.warn(`[auto-topup] 알림 해제 실패(${where} · 무시):`, e instanceof Error ? e.message : e);
  }
}

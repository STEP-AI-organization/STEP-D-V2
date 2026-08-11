/**
 * 크레딧 불변식 고정. **크레딧 1개 = 분석 1분.**
 *
 * 돈이 걸린 코드라 실패 방향이 중요하다:
 *  - 브라우저가 뭐라 하든 **금액이 안 맞으면 크레딧을 안 올린다**
 *  - 웹훅 재전송·워커 재시도에도 **한 번만** 반영된다
 *  - 잔액을 모르거나 모자라면 **시작하지 않는다** (원가를 쓴 뒤에 알면 늦다)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_TOPUP_CREDITS,
  balanceOf,
  buildTopup,
  checkCredits,
  creditPriceKrw,
  settleTopup,
  shouldAutoTopup,
  topupDedupeKey,
  topupPaymentId,
  usageDedupeKey,
  type AutoTopupPolicy,
} from "./credits.ts";

describe("잔액은 원장 합계다", () => {
  it("충전 + · 사용 −", () => {
    assert.equal(balanceOf([{ delta: 600, reason: "topup" }, { delta: -59, reason: "usage" }]), 541);
  });

  it("정정은 반대 부호 행으로 들어온다", () => {
    assert.equal(
      balanceOf([{ delta: 100, reason: "topup" }, { delta: -100, reason: "adjust" }]),
      0,
    );
  });

  it("빈 원장은 0", () => {
    assert.equal(balanceOf([]), 0);
  });

  it("이상한 값이 잔액을 오염시키지 않는다", () => {
    assert.equal(
      balanceOf([{ delta: 10, reason: "t" }, { delta: NaN, reason: "x" }, { delta: 1.9, reason: "y" }]),
      11,
    );
  });
});

describe("모자라면 시작하지 않는다", () => {
  it("잔액이 부족하면 거부하고 몇 개 모자란지 말한다", () => {
    const r = checkCredits({ balance: 10, needMinutes: 59 });
    assert.equal(r.allow, false);
    assert.match(r.allow === false ? r.reason : "", /49개/);
    assert.match(r.allow === false ? r.reason : "", /충전/);
  });

  it("딱 맞으면 통과하고 잔액 0 이 된다", () => {
    const r = checkCredits({ balance: 59, needMinutes: 59 });
    assert.equal(r.allow, true);
    assert.equal(r.allow === true && r.remainingAfter, 0);
  });

  it("러닝타임을 모르면(0) 막지 않는다", () => {
    // 프로브 실패로 분석 자체를 못 하게 만드는 것보다 낫다. 차감은 끝난 뒤 실제 길이로.
    assert.equal(checkCredits({ balance: 0, needMinutes: 0 }).allow, true);
  });

  it("음수·NaN 은 통과가 아니라 거부다", () => {
    for (const need of [-1, NaN, Infinity]) {
      const r = checkCredits({ balance: 9999, needMinutes: need });
      assert.equal(r.allow, false, String(need));
    }
  });
});

describe("멱등 — 두 번 충전·두 번 차감 금지", () => {
  it("같은 결제는 같은 키 (웹훅 재전송 방어)", () => {
    assert.equal(topupDedupeKey("cr_t1_abc"), topupDedupeKey("cr_t1_abc"));
    assert.notEqual(topupDedupeKey("cr_t1_abc"), topupDedupeKey("cr_t1_abd"));
  });

  it("같은 미디어는 같은 키 (워커 재시도 방어)", () => {
    assert.equal(usageDedupeKey("m1"), usageDedupeKey("m1"));
  });

  it("사람이 시킨 재분석은 별개다 (원가가 다시 든다)", () => {
    assert.notEqual(usageDedupeKey("m1"), usageDedupeKey("m1", 1));
  });

  it("결제 식별자는 우리가 만들고 이상 문자를 지운다", () => {
    assert.equal(topupPaymentId("t_default", "a1b2"), "cr_t_default_a1b2");
    assert.equal(topupPaymentId("t/../x", "a b"), "cr_tx_ab");
  });
});

describe("충전 주문 — 금액은 서버가 계산한다", () => {
  const env = { CREDIT_PRICE_KRW: "50" } as NodeJS.ProcessEnv;

  it("크레딧 × 단가", () => {
    const r = buildTopup(600, env);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.amountKrw, 30000);
  });

  it("단가가 없으면 결제창을 띄우지 않는다", () => {
    // 0원 결제나 임의 단가보다 "안 됨"이 낫다.
    const r = buildTopup(600, {} as NodeJS.ProcessEnv);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /CREDIT_PRICE_KRW/);
  });

  it("정수 아닌 값·0·음수를 거부한다", () => {
    for (const bad of [0, -1, 1.5, "abc", null, undefined, {}]) {
      assert.equal(buildTopup(bad, env).ok, false, JSON.stringify(bad));
    }
  });

  it("한 번에 살 수 있는 상한이 있다 (0 하나 더 붙는 사고 방지)", () => {
    assert.equal(buildTopup(MAX_TOPUP_CREDITS, env).ok, true);
    assert.equal(buildTopup(MAX_TOPUP_CREDITS + 1, env).ok, false);
  });

  it("단가는 양수만", () => {
    for (const bad of ["", "0", "-5", "abc"]) {
      assert.equal(creditPriceKrw({ CREDIT_PRICE_KRW: bad } as NodeJS.ProcessEnv), null, bad);
    }
  });
});

describe("결제 대조 — 브라우저를 믿지 않는다", () => {
  const order = { credits: 600, amountKrw: 30000, status: "pending" };

  it("금액이 맞고 PAID 여야 올린다", () => {
    const r = settleTopup({ order, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, true);
    assert.equal(r.credit === true && r.credits, 600);
  });

  it("금액이 다르면 올리지 않는다", () => {
    // 결제창 파라미터가 조작됐거나 우리 계산이 틀렸다 — 둘 다 크레딧을 주면 안 된다.
    const r = settleTopup({ order, payment: { status: "PAID", amountTotal: 1 } });
    assert.equal(r.credit, false);
    assert.match(r.credit === false ? r.reason : "", /금액/);
  });

  it("PAID 가 아니면 올리지 않는다", () => {
    for (const st of ["READY", "FAILED", "CANCELLED", "", undefined]) {
      const r = settleTopup({ order, payment: { status: st, amountTotal: 30000 } });
      assert.equal(r.credit, false, String(st));
    }
  });

  it("이미 처리된 충전은 다시 올리지 않는다", () => {
    const r = settleTopup({ order: { ...order, status: "paid" }, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, false);
  });

  it("우리 주문이 없으면 올리지 않는다 (남이 만든 paymentId 방어)", () => {
    const r = settleTopup({ order: null, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, false);
  });

  it("조회 실패를 성공으로 치지 않는다", () => {
    assert.equal(settleTopup({ order, payment: null }).credit, false);
  });
});

describe("자동 충전 — 상한이 없으면 못 켠다", () => {
  const policy: AutoTopupPolicy = {
    enabled: true, thresholdCredits: 60, topupCredits: 600,
    maxPerDay: 2, maxKrwPerMonth: 200_000,
  };
  const base = { policy, balance: 10, todayCount: 0, monthKrw: 0, amountKrw: 30_000 };

  it("기본은 꺼져 있다", () => {
    assert.equal(shouldAutoTopup({ ...base, policy: { ...policy, enabled: false } }).charge, false);
  });

  it("임계 위면 충전하지 않는다", () => {
    assert.equal(shouldAutoTopup({ ...base, balance: 100 }).charge, false);
  });

  it("일 한도에 걸리면 멈춘다 — 조용히 계속 긁지 않는다", () => {
    const r = shouldAutoTopup({ ...base, todayCount: 2 });
    assert.equal(r.charge, false);
    assert.match(r.charge === false ? r.reason : "", /한도/);
  });

  it("월 한도를 넘기면 멈춘다", () => {
    const r = shouldAutoTopup({ ...base, monthKrw: 190_000 });
    assert.equal(r.charge, false);
  });

  it("전부 통과해야 긁는다", () => {
    assert.equal(shouldAutoTopup(base).charge, true);
  });
});

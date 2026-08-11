/**
 * 과금 불변식 고정.
 *
 * 돈이 걸린 코드라 실패 방향이 중요하다:
 *  - env 가 틀리면 **결제가 안 되는** 쪽으로 (실수로 카드가 긁히는 쪽이 아니라)
 *  - 요금제를 모르면 **거부하는** 쪽으로 (0 으로 때우고 나중에 소급 청구하지 않는다)
 *  - 재시도는 **한 번만** 기록되는 쪽으로 (한 번 분석하고 세 번 청구하지 않는다)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BILLING_DISABLED_MESSAGE,
  apiKeyPrefix,
  billableMinutes,
  billingEnabled,
  buildInvoice,
  checkQuota,
  estimatedCostKrw,
  isLiveApiKey,
  planLine,
  portoneConfigured,
  usageDedupeKey,
  usageLine,
  type Plan,
} from "./billing.ts";

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "starter",
  displayName: "스타터",
  monthlyKrw: 99000,
  includedMin: 600,
  overageKrwPerMin: 30,
  ...over,
});

describe("실결제 게이트 — 실패 방향이 '결제 안 됨'이어야 한다", () => {
  it("명시적으로 켜야만 켜진다", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes"]) {
      assert.equal(billingEnabled({ BILLING_ENABLED: v } as NodeJS.ProcessEnv), true, v);
    }
  });

  it("미설정·빈값·오타는 전부 OFF", () => {
    for (const v of [undefined, "", "  ", "0", "false", "off", "no", "enabled", "ture", "Y"]) {
      assert.equal(
        billingEnabled({ BILLING_ENABLED: v } as NodeJS.ProcessEnv),
        false,
        JSON.stringify(v),
      );
    }
  });

  it("꺼졌을 때 사람이 읽을 사유가 있다", () => {
    assert.match(BILLING_DISABLED_MESSAGE, /BILLING_ENABLED/);
  });

  it("포트원 env 가 하나라도 비면 결제 경로를 열지 않는다", () => {
    const full = {
      PORTONE_API_SECRET: "s", PORTONE_STORE_ID: "store-1",
      PORTONE_CHANNEL_KEY: "ch", PORTONE_WEBHOOK_SECRET: "w",
    };
    assert.equal(portoneConfigured(full as NodeJS.ProcessEnv).ok, true);
    for (const k of Object.keys(full)) {
      const partial = { ...full, [k]: "" };
      const r = portoneConfigured(partial as NodeJS.ProcessEnv);
      assert.equal(r.ok, false, k);
      assert.deepEqual(r.missing, [k]);
    }
  });
});

describe("멱등 — 한 번 분석하고 두 번 청구하지 않는다", () => {
  it("같은 미디어는 같은 키", () => {
    assert.equal(usageDedupeKey("analyze_minutes", "m1"), usageDedupeKey("analyze_minutes", "m1"));
  });

  it("사람이 재분석시키면 별개 사용량이다 (원가가 다시 든다)", () => {
    assert.notEqual(usageDedupeKey("analyze_minutes", "m1"), usageDedupeKey("analyze_minutes", "m1", 1));
  });

  it("종류가 다르면 별개다", () => {
    assert.notEqual(usageDedupeKey("analyze_minutes", "m1"), usageDedupeKey("clip_render", "m1"));
  });
});

describe("청구 분 — 올림", () => {
  it("30초짜리도 1분으로 센다 (파이프라인은 한 번 다 돈다)", () => {
    assert.equal(billableMinutes(30), 1);
    assert.equal(billableMinutes(1), 1);
    assert.equal(billableMinutes(60), 1);
    assert.equal(billableMinutes(61), 2);
    assert.equal(billableMinutes(3516), 59); // 58.6분 실측 회차
  });

  it("0·음수·NaN 은 0 (없는 사용량을 만들지 않는다)", () => {
    for (const v of [0, -1, NaN, Infinity]) assert.equal(billableMinutes(v), 0, String(v));
  });

  it("원가는 실측 기준으로 계산된다", () => {
    // 2026-08-08 실측: 58.6분 ≈ ₩285 → 분당 약 ₩4.9
    assert.ok(Math.abs(estimatedCostKrw(59) - 289.1) < 0.5);
  });
});

describe("쿼터 — 모르면 청구하지 않고 거부한다", () => {
  it("요금제가 없으면 통과시키지 않는다", () => {
    // 0 으로 때우면 공짜로 쓰다가 나중에 소급 청구하게 된다.
    const r = checkQuota({ plan: null, usedMin: 0, requestMin: 10 });
    assert.equal(r.allow, false);
    assert.equal(r.allow === false && r.code, "no_plan");
  });

  it("정지된 워크스페이스는 요금제와 무관하게 막는다", () => {
    const r = checkQuota({ plan: plan(), usedMin: 0, requestMin: 1, tenantStatus: "suspended" });
    assert.equal(r.allow, false);
    assert.equal(r.allow === false && r.code, "suspended");
  });

  it("한도 안이면 통과 · 초과분 0", () => {
    const r = checkQuota({ plan: plan(), usedMin: 100, requestMin: 60 });
    assert.equal(r.allow, true);
    assert.equal(r.allow === true && r.overageMin, 0);
  });

  it("초과 단가가 없으면 초과 시 **막는다** (청구가 아니라 거부)", () => {
    const r = checkQuota({ plan: plan({ overageKrwPerMin: null }), usedMin: 590, requestMin: 30 });
    assert.equal(r.allow, false);
    assert.equal(r.allow === false && r.code, "over_quota");
    assert.match(r.allow === false ? r.reason : "", /600분/);
    assert.match(r.allow === false ? r.reason : "", /20분/);
  });

  it("초과 단가가 있으면 통과시키고 초과분을 돌려준다", () => {
    const r = checkQuota({ plan: plan(), usedMin: 590, requestMin: 30 });
    assert.equal(r.allow, true);
    assert.equal(r.allow === true && r.overageMin, 20);
  });

  it("거부에는 반드시 사유가 있다", () => {
    const cases = [
      checkQuota({ plan: null, usedMin: 0, requestMin: 1 }),
      checkQuota({ plan: plan({ overageKrwPerMin: null }), usedMin: 999, requestMin: 1 }),
      checkQuota({ plan: plan(), usedMin: 0, requestMin: 1, tenantStatus: "closed" }),
    ];
    for (const r of cases) {
      assert.equal(r.allow, false);
      assert.notEqual(r.allow === false ? r.reason.trim() : "x", "");
    }
  });
});

describe("인보이스", () => {
  it("부가세는 소계에서 한 번만 뗀다", () => {
    // 줄마다 반올림하면 합계가 어긋난다.
    const r = buildInvoice([
      { desc: "a", qty: 1, unitKrw: 99000, amountKrw: 99000 },
      { desc: "b", qty: 20, unitKrw: 30, amountKrw: 600 },
    ]);
    assert.equal(r.subtotalKrw, 99600);
    assert.equal(r.vatKrw, 9960);
    assert.equal(r.totalKrw, 109560);
  });

  it("빈 청구서는 0", () => {
    assert.deepEqual(buildInvoice([]), { subtotalKrw: 0, vatKrw: 0, totalKrw: 0 });
  });

  it("초과가 없으면 사용량 줄을 만들지 않는다", () => {
    assert.equal(usageLine(plan(), 0), null);
  });

  it("초과 단가가 없으면 사용량 줄이 없다 (막힌 것이지 청구할 게 아니다)", () => {
    assert.equal(usageLine(plan({ overageKrwPerMin: null }), 50), null);
  });

  it("무료 요금제는 월 이용료 줄이 없다", () => {
    assert.equal(planLine(plan({ monthlyKrw: 0 })), null);
  });
});

describe("API 키", () => {
  it("접두만 저장·표시한다", () => {
    assert.equal(apiKeyPrefix("stepd_live_ab12cd34ef56"), "stepd_live_ab12");
  });

  it("테스트 키를 라이브로 오인하지 않는다", () => {
    assert.equal(isLiveApiKey("stepd_live_abc"), true);
    assert.equal(isLiveApiKey("stepd_test_abc"), false);
    assert.equal(isLiveApiKey("ak_abc"), false);
  });
});

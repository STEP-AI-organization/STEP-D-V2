/**
 * 과금 불변식 고정.
 *
 * 돈이 걸린 코드라 실패 방향이 중요하다:
 *  - 결제 설정이 빠지면 **결제창을 아예 안 여는** 쪽으로 (빈 storeId 를 브라우저로 흘리지 않는다)
 *  - 재시도는 **한 번만** 기록되는 쪽으로 (한 번 분석하고 세 번 차감하지 않는다)
 *
 * 요금제(plans) 기반 쿼터·인보이스 테스트는 2026-08-11 크레딧 단일 결정으로 대상 코드와
 * 함께 지웠다. 크레딧 판정은 credits.test.ts 가 본다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  apiKeyPrefix,
  billableMinutes,
  estimatedCostKrw,
  isLiveApiKey,
  portoneConfigured,
  usageDedupeKey,
} from "./billing.ts";

describe("결제 설정 — 빠진 게 있으면 결제 경로를 열지 않는다", () => {
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
    // 2026-08-11 재산정: 58.6분 ≈ ₩994(분당 ₩17.0) — Gemini 728 + Soniox 138 + Run 125 + 임베딩 3.
    // 예전 ₩285(분당 4.9)는 retry.py 단가표가 2.0 Flash 가격을 2.5 라벨에 붙여 4.7배
    // 과소계상한 값이었다(cost-and-dependencies.md §4). 상수는 여유를 둔 19.
    assert.ok(Math.abs(estimatedCostKrw(59) - 1121) < 1);
  });

  it("원가가 판매가(크레딧 ₩28/분)보다 낮다 — 역마진 감지", () => {
    // 이 관계가 깨지면 팔수록 손해다. 상수를 잘못 올렸을 때 바로 걸리라고 둔다.
    const CREDIT_PRICE = 28;
    assert.ok(estimatedCostKrw(60) < CREDIT_PRICE * 60,
      `원가 ${estimatedCostKrw(60)} 가 매출 ${CREDIT_PRICE * 60} 이상이다 — 역마진`);
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

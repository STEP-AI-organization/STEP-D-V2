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
  COST_KRW_PER_MINUTE,
  COST_KRW_PER_MINUTE_NO_CHYRON,
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
    // 2026-08-17 실측 확정: 60분 ≈ ₩2,385(분당 ₩39.8) → 상수 40.
    // 32.4분 실회차 전 구간(158콜 ₩450) + chyron 별도 실행(780콜 ₩658)을 합쳐 환산했다.
    // chyron 을 따로 돌린 이유는 로컬 .env 가 RUN_CHYRON_PER_SEG=0 이라 회차 로그에
    // 안 담기기 때문이다 — 프로덕션은 기본 ON 이다(how-it-works.md §7-4).
    assert.ok(Math.abs(estimatedCostKrw(59) - 2360) < 1);
  });

  it("자막읽기를 끈 구성은 흑자다 — 흑자로 가는 길이 실재함을 고정", () => {
    const CREDIT_PRICE = 28;
    assert.ok(COST_KRW_PER_MINUTE_NO_CHYRON < CREDIT_PRICE,
      `자막읽기 OFF 원가 ${COST_KRW_PER_MINUTE_NO_CHYRON} 가 판매가 ${CREDIT_PRICE} 이상이다`);
  });

  it("지금 프로덕션 기본 구성은 적자라는 사실을 고정한다", () => {
    // ⚠️ 보통의 가드와 방향이 반대인 테스트다. 실측 결과 **현재 기본값(자막읽기 ON)은
    // 편당 적자**이고(₩28 받고 ₩40 씀), 이건 코드 버그가 아니라 아직 안 내려진 제품
    // 결정이다. 그냥 두면 다음 사람이 상수를 슬쩍 낮춰 흑자로 보이게 만든다 —
    // 이 파일에서 이미 두 번 일어난 일이다(4.9 · 26).
    //
    // **이 테스트가 실패하면** 결정이 내려졌다는 뜻이다: 그때 상수·이 테스트·
    // how-it-works.md §4 를 같이 갱신할 것. 숫자만 고치고 지나가지 말 것.
    const CREDIT_PRICE = 28;
    assert.ok(COST_KRW_PER_MINUTE > CREDIT_PRICE,
      `원가 ${COST_KRW_PER_MINUTE} 가 판매가 ${CREDIT_PRICE} 이하로 내려왔다 — ` +
      "구성이 바뀌었으면 how-it-works.md §4 와 함께 갱신하라");
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

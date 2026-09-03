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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import {
  COST_KRW_PER_MINUTE,
  COST_KRW_PER_MINUTE_WITH_CHYRON,
  apiKeyPrefix,
  billableMinutes,
  estimatedCostKrw,
  isLiveApiKey,
  portoneConfigured,
  usageDedupeKey,
} from "../billing/billing.ts";

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

  it("폴백 상수가 정본 원가와 같다 — 프로덕션 구성(flash-lite · 자막읽기 OFF)", () => {
    // 정본: how-it-works.md §4 — 60분 ≈₩800(AI 510 + 받아쓰기 141 + 서버연산 99 +
    // 렌더 33 + 음성합성·검색 17) → 분당 ₩13.3.
    // ⚠️ 2026-09-03 까지 여기가 19(= flash-lite 전환 **전** 값)여서 원장이 원가를 43%
    // 부풀리고 있었다. 구성을 바꾸면 상수·정본 문서·이 테스트를 **함께** 고칠 것.
    assert.equal(COST_KRW_PER_MINUTE, 13.3);
    assert.ok(Math.abs(estimatedCostKrw(60) - 798) < 1, `60분 ${estimatedCostKrw(60)}`);
  });

  it("폴백은 폴백일 뿐 — 원장의 정상 경로는 실측(usage.json)이다", () => {
    // 상수 곱이 원장에 그대로 들어가면 구성이 바뀌어도 아무도 모른다(위 사고).
    // content-pipeline 은 core 가 남긴 usage.json 을 먼저 읽고, 못 읽을 때만 이 상수를 쓴다.
    const src = fs.readFileSync(path.join(SRC, "pipeline/content-pipeline.ts"), "utf-8");
    assert.match(src, /costKrw: measured\?\.costKrw \?\? estimatedCostKrw\(minutes\)/,
      "실측 우선 · 상수 폴백 구조가 사라졌다");
    assert.match(src, /costSource: measured \? "measured" : "estimated"/,
      "실측/추정 표시가 없으면 둘이 섞여 단가를 못 믿는다");
  });

  it("자막읽기를 켠 값을 나란히 둔다 — 켜면 얼마인지 매번 다시 계산하지 않게", () => {
    // 정본 ₩1,283/60분 = 분당 ₩21.4 (flash-lite). 이 값이 상수 자리에 잘못 들어가면
    // 대시보드가 실제보다 비싸게 보고한다(2026-08-17 에 실제로 한 번 그렇게 넣었다).
    assert.equal(COST_KRW_PER_MINUTE_WITH_CHYRON, 21.4);
    assert.ok(COST_KRW_PER_MINUTE_WITH_CHYRON > COST_KRW_PER_MINUTE,
      "켜는 쪽이 더 싸게 잡히면 판단이 뒤집힌다");
    // 켜도 판매가(₩60/분) 밑이다 — "비싸서 못 켠다" 는 결론이 다시 나오면 안 된다.
    assert.ok(COST_KRW_PER_MINUTE_WITH_CHYRON < 60);
  });

  it("원가가 판매가(크레딧 ₩60/분)보다 낮다 — 역마진 감지", () => {
    // 이 관계가 깨지면 팔수록 손해다. 상수를 잘못 올렸을 때 바로 걸리라고 둔다.
    // ⚠️ 자막읽기를 켜기로 결정하면 원가가 분당 ₩21.4 로 오른다 — ₩60 판매가에선
    // 여전히 흑자다(마진 ~64%). 그때도 숫자만 고치지 말고 how-it-works.md §4 를 같이 갱신할 것.
    const CREDIT_PRICE = 60;   // 2026-08-25 인하 (28→150→60)
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

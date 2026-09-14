/**
 * 운영자 결제 시험 — **진짜 돈이 나가는 자리**라 두 가지를 고정한다.
 *
 *   ① 금액 상한이 코드에 있는가 (오타로 고객 카드가 크게 긁히지 않게)
 *   ② 돈이 오가는 **순서가 운영 경로와 같은가** — 다르면 시험이 운영을 검증하지 못한다
 *
 * ②가 이 파일의 핵심이다. 시험용으로 순서를 단순화하고 싶어지는데, 특히 원장(addCreditEntry)
 * 을 상태(markTopupPaid) 뒤로 미루면 그 사이 예외에서 **크레딧이 영구히 사라진다** —
 * 그리고 그 사고는 시험에서는 절대 안 나타난다(예외가 안 나니까).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { MAX_TEST_CREDITS } from "../billing/card-test-charge.ts";

const SRC = path.join(import.meta.dirname, "..");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(SRC, ...p), "utf-8").replace(/\r\n/g, "\n");

const CHARGE = read("billing", "card-test-charge.ts");
const INDEX = read("index.ts");

describe("금액 상한", () => {
  it("소액이다 — 10크레딧(₩660)을 넘지 않는다", () => {
    assert.ok(MAX_TEST_CREDITS > 0 && MAX_TEST_CREDITS <= 10,
      `시험 결제 상한이 ${MAX_TEST_CREDITS}크레딧이다 — 레일 확인에 그만큼이 필요하지 않다`);
  });

  it("상한을 **서버가** 강제한다 — 화면 input 의 max 는 방어가 아니다", () => {
    assert.match(CHARGE, /check\.credits > MAX_TEST_CREDITS/,
      "서버에서 상한 검사를 안 한다 — 어드민 화면을 우회하면 그대로 통과한다");
  });

  it("크레딧 단가 계산을 제품과 같이 쓴다 — 자기 계산을 만들지 않는다", () => {
    assert.match(CHARGE, /buildTopup\(/,
      "시험이 금액을 따로 계산하면 '제품에서 긁힐 금액' 을 시험한 게 아니다");
  });
});

describe("돈이 오가는 순서가 운영과 같은가", () => {
  const at = (needle: string) => {
    const i = CHARGE.indexOf(needle);
    assert.ok(i > 0, `시험 결제에서 ${needle} 를 못 찾았다`);
    return i;
  };

  it("주문을 **먼저** 만든다 — 승인 응답을 놓쳐도 긁혔을 수 있는 게 기록에 남는다", () => {
    assert.ok(at("createTopup(") < at("chargeWithBillingKey("),
      "결제를 먼저 하고 주문을 나중에 만든다 — 응답을 놓치면 아무 기록도 안 남는다");
  });

  it("긁은 뒤 **단건 조회로 확인**한다 — 동기 응답엔 status·amount 가 없다", () => {
    assert.ok(at("chargeWithBillingKey(") < at("verifyCharge("),
      "확인 없이 성공으로 친다");
    assert.match(CHARGE, /getPayment\(paymentId\)/);
  });

  it("**원장이 상태보다 먼저다** — 뒤집으면 예외 한 번에 크레딧이 영구히 사라진다", () => {
    assert.ok(at("addCreditEntry(") < at('markTopupPaid(paymentId, "paid")'),
      "markTopupPaid 를 먼저 찍는다 — 재시도가 'paid' 가드에 막혀 크레딧이 사라진다");
  });

  it("확인이 안 되면 **failed 로 닫지 않는다** — 돈은 나갔을 수 있다", () => {
    assert.match(CHARGE, /charge_unverified/);
    const unver = CHARGE.slice(at("charge_unverified") - 600, at("charge_unverified"));
    assert.ok(!/markTopupPaid\([^)]*"failed"/.test(unver),
      "미확인을 failed 로 닫는다 — 로그가 '안 긁힘' 이라고 거짓말하고 재결제로 이중 청구가 된다");
  });

  it("거절 사유는 제품과 **같은 함수**로 만든다 — 두 경로가 다른 말을 하면 안 된다", () => {
    assert.match(CHARGE, /declineMessage\(e\)/);
  });
});

describe("등록은 제품과 한 벌을 쓴다", () => {
  /**
   * 어드민과 제품이 각자 발급 절차를 가지면 **"어드민에선 등록되는데 제품에선 안 된다"**
   * 가 생기고, 재현하려면 두 코드를 나란히 놓고 읽어야 한다. 결제는 그럴 자리가 아니다.
   */
  it("두 라우트가 같은 registerCard 를 부른다", () => {
    const calls = [...INDEX.matchAll(/registerCard\(\{/g)];
    assert.equal(calls.length, 2, `registerCard 호출이 ${calls.length}곳이다 — 제품·어드민 둘이어야 한다`);
    assert.ok(INDEX.includes('app.post("/api/billing/card/issue"'), "제품 라우트가 없다");
    assert.ok(INDEX.includes('app.post("/api/superadmin/tenants/:id/card"'), "어드민 라우트가 없다");
  });

  it("어드민 경로는 대상 회사 스코프로 들어간다 — 안 그러면 남의 회사 카드에 쓴다", () => {
    const route = INDEX.slice(INDEX.indexOf('app.post("/api/superadmin/tenants/:id/card"'));
    const body = route.slice(0, route.indexOf("\n});"));
    assert.match(body, /runWithTenant\(\{ scope: tenantId/,
      "runWithTenant 없이 등록한다 — 세션 테넌트(운영자 소속)에 저장된다");
    assert.match(body, /customerId: tenantId/, "포트원 customerId 가 대상 회사가 아니다");
  });

  it("카드 원문 경로는 캐시를 막고 전역 onError 를 안 탄다", () => {
    for (const r of ['app.post("/api/billing/card/issue"', 'app.post("/api/superadmin/tenants/:id/card"']) {
      const body = INDEX.slice(INDEX.indexOf(r), INDEX.indexOf(r) + 1200);
      assert.match(body, /Cache-Control", "no-store"/, `${r} 에 no-store 가 없다`);
    }
    // registerCard 는 던지지 않는다 — 그래서 카드 원문이 전역 오류 핸들러·로그로 새지 않는다.
    const reg = read("billing", "card-register.ts");
    assert.match(reg, /catch \(err\) \{/, "registerCard 가 예외를 잡지 않는다");
    assert.ok(!/throw /.test(reg.replace(/\* .*$/gm, "")), "registerCard 가 던진다 — 카드 원문이 새는 경로다");
  });
});

describe("감사 — 누가 남의 회사 카드를 긁었는지 남는가", () => {
  it("세 라우트 모두 audit 을 남긴다", () => {
    for (const r of [
      'app.post("/api/superadmin/tenants/:id/card"',
      'app.get("/api/superadmin/tenants/:id/card"',
      'app.post("/api/superadmin/tenants/:id/test-charge"',
    ]) {
      const body = INDEX.slice(INDEX.indexOf(r), INDEX.indexOf(r) + 1400);
      assert.match(body, /await audit\(actor,/, `${r} 에 감사 로그가 없다`);
    }
  });

  it("시험 결제는 requestedBy 로 구분된다 — 자동충전 상한 집계에 섞이면 안 된다", () => {
    assert.match(CHARGE, /requestedBy: `superadmin-test:/);
  });
});

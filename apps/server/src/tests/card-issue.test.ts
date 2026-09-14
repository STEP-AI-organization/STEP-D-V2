import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCardCredential } from "../billing/card-credential.ts";
import { CardIssueError, issueBillingKey } from "../billing/portone.ts";

const credential = { number: "4242424242424242", expiryMonth: "09", expiryYear: "30" };
const now = new Date("2030-09-01T00:00:00Z");

describe("자체 입력창 카드 검증", () => {
  it("필수 정보만으로 발급할 수 있고 임의 필드는 전달하지 않는다", () => {
    assert.deepEqual(checkCardCredential({ ...credential, number: "4242-4242 4242-4242", cvc: "123" }, now), {
      ok: true, credential,
    });
  });
  it("확인정보는 입력한 경우에만 전달하며 비밀번호 앞자리의 0을 유지한다", () => {
    const expected = { ...credential, birthOrBusinessRegistrationNumber: "1234567890", passwordTwoDigits: "01" };
    assert.deepEqual(checkCardCredential({ ...expected, birthOrBusinessRegistrationNumber: "123-45-67890" }, now), {
      ok: true, credential: expected,
    });
    assert.equal(checkCardCredential({ ...credential, birthOrBusinessRegistrationNumber: "900101" }, now).ok, true);
  });
  it("한국 기준 월말까지 유효하고 다음 달에는 만료된다", () => {
    assert.equal(checkCardCredential(credential, new Date("2030-09-30T14:59:59Z")).ok, true);
    assert.equal(checkCardCredential(credential, new Date("2030-09-30T15:00:00Z")).ok, false);
  });
  it("잘못된 원문을 반사하지 않고 거부한다", () => {
    for (const input of [null, [], "oops", { ...credential, number: "bad4242424242424242" },
      { ...credential, expiryMonth: "13" }, { ...credential, expiryYear: "2030" },
      { ...credential, passwordTwoDigits: "1234" }, { ...credential, birthOrBusinessRegistrationNumber: "9001011234567" }]) {
      const result = checkCardCredential(input, now);
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /4242424242424242|9001011234567|1234/);
    }
  });
});

describe("포트원 서버 발급", () => {
  const input = {
    storeId: "store-test", channelKey: "billing-channel-test", customerId: "workspace-test",
    customer: { fullName: "테스트", email: "test@example.com", phoneNumber: "01012345678" }, credential,
  };

  it("빌링 채널과 구매자를 보내고 공식 응답의 billingKeyInfo에서 키를 읽는다", async (t) => {
    const previous = process.env.PORTONE_API_SECRET;
    process.env.PORTONE_API_SECRET = "fake-test-secret";
    t.after(() => { if (previous === undefined) delete process.env.PORTONE_API_SECRET; else process.env.PORTONE_API_SECRET = previous; });
    const requests: { url: unknown; init: RequestInit | undefined }[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ billingKeyInfo: { billingKey: "issued-test-key", issuedAt: "2030-09-01T00:00:00Z" } }));
    });
    assert.equal(await issueBillingKey(input), "issued-test-key");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.portone.io/billing-keys");
    const request = JSON.parse(String(requests[0].init?.body));
    assert.equal(request.storeId, input.storeId);
    assert.equal(request.channelKey, input.channelKey);
    assert.deepEqual(request.method, { card: { credential } });
    assert.deepEqual(request.customer, {
      id: input.customerId, name: { full: input.customer.fullName },
      email: input.customer.email, phoneNumber: input.customer.phoneNumber,
    });
    assert.equal(request.amount, undefined, "등록은 결제를 실행하지 않는다");
    assert.ok(requests[0].init?.signal, "발급 요청에는 타임아웃이 필요하다");
  });

  it("PG 오류·네트워크 오류·잘못된 성공 응답을 원문 없이 거부하며 자동 재시도하지 않는다", async (t) => {
    const previous = process.env.PORTONE_API_SECRET;
    process.env.PORTONE_API_SECRET = "fake-test-secret";
    t.after(() => { if (previous === undefined) delete process.env.PORTONE_API_SECRET; else process.env.PORTONE_API_SECRET = previous; });
    for (const failure of ["pg", "network", "shape"]) {
      const mocked = t.mock.method(globalThis, "fetch", async () => {
        if (failure === "network") throw new Error(`echo ${credential.number}`);
        return new Response(JSON.stringify(failure === "pg" ? { message: credential.number } : { billingKey: "wrong-shape" }), {
          status: failure === "pg" ? 400 : 200,
        });
      });
      await assert.rejects(issueBillingKey(input), (error: unknown) => {
        assert.ok(error instanceof CardIssueError);
        assert.doesNotMatch(JSON.stringify(error) + error.stack, /4242424242424242|fake-test-secret|wrong-shape/);
        assert.equal("body" in error, false);
        assert.equal("cause" in error, false);
        return true;
      });
      assert.equal(mocked.mock.callCount(), 1);
      mocked.mock.restore();
    }
  });
});

describe("카드 등록의 권한·민감정보 경계", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const route = /app\.post\("\/api\/billing\/card\/issue",[\s\S]*?\n\}\);/.exec(source)?.[0] ?? "";
  it("세션 관리자·동의·입력 검증을 발급보다 먼저 수행한다", () => {
    const issue = route.indexOf("await issueBillingKey(");
    assert.ok(issue > 0);
    for (const check of ["requireManager(c)", "body.autoChargeConsent !== true", "checkCardCredential(", "checkCustomer("]) {
      assert.ok(route.indexOf(check) >= 0 && route.indexOf(check) < issue, check);
    }
  });
  it("카드 원문은 저장하지 않고, 응답·로그·결제 API에 싣지 않는다", () => {
    assert.match(route, /await saveBillingCard\(\{\s* billingKey, cardBrand: display.brand, cardLast4: display.last4, issuedBy: actor, buyer: who.customer,\s*\}\)/);
    assert.match(route, /return c.json\(\{ ok: true \}\)/);
    assert.doesNotMatch(route, /console\.|chargeWithBillingKey\(|throw err|JSON.stringify/);
    assert.match(route, /Cache-Control", "no-store/);
  });
});

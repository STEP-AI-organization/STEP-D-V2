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

/**
 * 카드 등록의 권한·민감정보 경계.
 *
 * ⚠️ 2026-09-14: 발급 오케스트레이션이 `billing/card-register.ts` 로 빠졌다 — 어드민
 * (`POST /api/superadmin/tenants/:id/card`)이 **같은 한 벌**을 쓰게 하려고. 불변식은
 * 그대로고 사는 곳만 둘로 갈렸으니, 스캔 범위도 둘로 넓힌다:
 *   · 라우트(index.ts)  — **누가** 부를 수 있나(세션 권한) · 캐시 금지
 *   · registerCard      — **무엇을** 검증하고 어디로 보내나(동의·원문·구매자)
 * 한쪽만 보면 "라우트에 검증이 없다" 며 빨개지거나(지금 이 일), 더 나쁘게는 검증이
 * 통째로 사라져도 초록이 된다.
 */
describe("카드 등록의 권한·민감정보 경계", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const register = fs.readFileSync(
    fileURLToPath(new URL("../billing/card-register.ts", import.meta.url)), "utf8");
  const route = /app\.post\("\/api\/billing\/card\/issue",[\s\S]*?\}\);/.exec(source)?.[0] ?? "";

  it("세션 관리자 확인은 **라우트**에 있다 — 위임 함수는 권한을 모른다", () => {
    assert.ok(route.length > 0, "제품 카드 등록 라우트를 못 찾았다");
    const call = route.indexOf("registerCard(");
    assert.ok(call > 0, "라우트가 registerCard 로 위임하지 않는다");
    assert.ok(route.indexOf("requireManager(c)") >= 0 && route.indexOf("requireManager(c)") < call,
      "권한 확인이 위임보다 뒤이거나 없다");
  });

  it("동의·입력 검증을 발급보다 먼저 수행한다", () => {
    const issue = register.indexOf("await issueBillingKey(");
    assert.ok(issue > 0, "registerCard 에서 발급 호출을 못 찾았다");
    for (const check of ["autoChargeConsent !== true", "checkCardCredential(", "checkCustomer("]) {
      const at = register.indexOf(check);
      assert.ok(at >= 0 && at < issue, `${check} 가 발급보다 먼저가 아니다`);
    }
  });

  it("제품 경로는 자동결제 동의를 **면제하지 않는다**", () => {
    assert.match(route, /requireConsent: true/,
      "제품에서 동의 없이 카드가 등록된다 — 동의가 곧 자동결제 동의다");
  });

  it("카드 원문은 저장하지 않고, 응답·로그·결제 API에 싣지 않는다", () => {
    assert.match(register, /await saveBillingCard\(\{\s*billingKey, cardBrand: display\.brand, cardLast4: display\.last4,\s*issuedBy: input\.actor, buyer: who\.customer,\s*\}\)/);
    // 응답은 `{ ok: true }` 뿐이다 — 카드 정보를 되비추지 않는다(부르는 쪽이 다시 조회한다).
    assert.match(register, /body: \{ ok: true \}/);
    assert.doesNotMatch(register, /chargeWithBillingKey\(|throw err|JSON\.stringify/);
    assert.match(route, /Cache-Control", "no-store/);
  });

  /**
   * **로그를 통째로 막지는 않는다 — 무엇을 찍는지를 막는다.**
   *
   * 원래 이 파일은 `console.` 자체를 금지했다. 의도는 옳았지만 대가가 컸다:
   * 2026-09-14 에 등록이 503 으로 실패했을 때 **로그가 한 줄도 없어서** 원인을 못 찾았다
   * (실제로는 없는 회사 id 라 DB 외래키에서 터진 것이었고, 그 사이 포트원에는 빌링키가
   * 발급돼 있었다). "아무것도 안 남긴다" 는 안전이 아니라 **눈을 가리는 것**이었다.
   *
   * 그래서 규칙을 바꾼다: 로그는 허용하되 **예외의 name·message 말고는 못 싣는다.**
   * 카드 원문이 들어 있는 값(credential·body·number·billingKey)을 찍으면 실패한다.
   */
  it("로그에 카드 원문이 실릴 수 있는 값을 넣지 않는다", () => {
    const calls = [...register.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map((m) => m[1]);
    assert.ok(calls.length > 0,
      "등록 실패를 하나도 안 남긴다 — 503 이 나도 원인을 못 찾는다(그 상태로 한 번 막혔다)");
    for (const args of calls) {
      for (const bad of ["credential", "input.body", "billingKey", "checked.", "who.customer", "number"]) {
        assert.ok(!args.includes(bad), `로그에 ${bad} 가 실린다: ${args.slice(0, 80)}`);
      }
      // 길이 상한이 없으면 긴 PG 응답이 통째로 흘러갈 수 있다.
      assert.match(args, /\.slice\(0,\s*\d+\)/, `로그 길이 상한이 없다: ${args.slice(0, 80)}`);
    }
  });

  it("**어드민 경로도 같은 규칙을 받는다** — 권한만 다르고 나머지는 한 벌이다", () => {
    const admin = /app\.post\("\/api\/superadmin\/tenants\/:id\/card",[\s\S]*?\}\);/.exec(source)?.[0] ?? "";
    assert.ok(admin.length > 0, "어드민 카드 등록 라우트를 못 찾았다");
    assert.match(admin, /requireSuperadmin\(c\)/, "운영자 전용이 아니다");
    assert.match(admin, /Cache-Control", "no-store/);
    assert.match(admin, /registerCard\(/, "어드민이 자기 발급 절차를 따로 갖고 있다");
  });
});

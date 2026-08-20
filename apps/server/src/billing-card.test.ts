/**
 * 저장 카드(빌링키) 고정.
 *
 * 실패 방향은 전부 **"안 긁힘"** 이다. 설정이 틀렸을 때 "엉뚱하게 긁힘"이 되면 남의 돈이
 * 나가고, 그건 되돌리는 데 사람이 붙어야 한다.
 *
 * 조사 근거(2026-08-11 · developers.portone.io KG이니시스 V2):
 *  - 빌링은 일반결제와 **다른 채널**이다 → 채널키를 따로 읽는다
 *  - PC 빌링키 발급에 `fullName` · `phoneNumber` · `email` 이 **전부 필수**
 *    (일반결제에서 이 셋을 하나씩 빠뜨려 세 번 연속 실패한 적이 있다)
 *  - 문서에 정기/비정기 구분은 없다 — 단건은 `POST /payments/{id}/billing-key`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  billingConfig,
  cardBlock,
  cardBlockReason,
  DECLINE_FALLBACK_MESSAGE,
  declineMessage,
  cardLabel,
  cardTopupPaymentId,
  checkCustomer,
  extractCardDisplay,
  issueIdFor,
  normalizePhone,
  unwrapPayment,
  verifyCharge,
} from "./billing-card.ts";
import { PortOneError } from "./portone.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");
const FULL = {
  PORTONE_STORE_ID: "store-1",
  PORTONE_BILLING_CHANNEL_KEY: "channel-key-billing",
} as unknown as NodeJS.ProcessEnv;

describe("빌링 설정", () => {
  it("일반결제 채널키로는 열리지 않는다", () => {
    // 빌링은 별도 채널이다. 일반결제 키만 있는 상태를 통과시키면 발급이 알 수 없는
    // 오류로 실패하고, 운영자는 무엇이 없는지 모른다.
    const only = { PORTONE_STORE_ID: "s", PORTONE_CHANNEL_KEY: "general" } as unknown as NodeJS.ProcessEnv;
    const r = billingConfig(only);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.missing, ["PORTONE_BILLING_CHANNEL_KEY"]);
    assert.match(r.message, /다른 채널/, "왜 따로 필요한지 말해줘야 한다");
  });

  it("둘 다 있으면 통과", () => {
    const r = billingConfig(FULL);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.channelKey, "channel-key-billing");
  });

  it("빈 문자열·공백은 없는 것으로 본다", () => {
    for (const v of ["", "   "]) {
      const r = billingConfig({ ...FULL, PORTONE_BILLING_CHANNEL_KEY: v } as NodeJS.ProcessEnv);
      assert.equal(r.ok, false, `통과하면 안 되는 값: "${v}"`);
    }
  });
});

describe("KG이니시스 필수 고객정보", () => {
  const ok = { fullName: "홍길동", email: "a@b.kr", phoneNumber: "010-1234-5678" };

  it("셋 다 있으면 통과하고 전화번호는 숫자만 남는다", () => {
    const r = checkCustomer(ok);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.customer.phoneNumber, "01012345678");
  });

  it("하나라도 없으면 결제창을 안 띄운다", () => {
    for (const k of ["fullName", "email", "phoneNumber"] as const) {
      const r = checkCustomer({ ...ok, [k]: "" });
      assert.equal(r.ok, false, `${k} 없이 통과했다`);
    }
  });

  it("무엇이 없는지 이름을 말해준다", () => {
    // "실패했습니다"만 띄우면 사용자가 뭘 채워야 하는지 알 수 없다.
    const r = checkCustomer({});
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.missing, ["이름", "이메일", "휴대폰번호"]);
  });

  it("전화번호 자릿수를 본다", () => {
    assert.equal(checkCustomer({ ...ok, phoneNumber: "010123" }).ok, false, "너무 짧다");
    assert.equal(checkCustomer({ ...ok, phoneNumber: "0101234567890" }).ok, false, "너무 길다");
    assert.equal(normalizePhone("+82 10-1234-5678"), "821012345678");
  });

  it("이메일 오타를 잡는다", () => {
    for (const bad of ["a", "a@", "@b.kr", "a@b"]) {
      assert.equal(checkCustomer({ ...ok, email: bad }).ok, false, bad);
    }
  });
});

describe("카드 상태", () => {
  it("카드가 없거나 해지됐으면 못 긁는다", () => {
    assert.ok(cardBlockReason(null));
    assert.ok(cardBlockReason({ billingKey: null, revokedAt: null }), "빌링키가 비었으면 못 긁는다");
    assert.ok(cardBlockReason({ billingKey: "bk", revokedAt: new Date() }));
    assert.equal(cardBlockReason({ billingKey: "bk", revokedAt: null }), null);
  });

  it("막는 사유를 code 로 구분한다 — 미등록과 해지는 다른 사건이다", () => {
    // 자동 충전 알림이 이 둘을 갈라야 한다: 미등록은 사용자가 이미 아는 상태(노이즈),
    // 해지는 켜 둔 뒤 벌어진 변화(조치 필요)다.
    assert.equal(cardBlock(null)?.code, "no_card");
    assert.equal(cardBlock({ billingKey: null, revokedAt: null })?.code, "no_card");
    assert.equal(cardBlock({ billingKey: "bk", revokedAt: new Date() })?.code, "card_revoked");
    // 해지는 billing_key 를 비우면서 revoked_at 을 찍는다(revokeBillingCard) — 실제 해지 행이
    // no_card 로 접히면 "카드를 지워서 자동 충전이 멈췄다" 를 영영 알릴 수 없다.
    assert.equal(cardBlock({ billingKey: null, revokedAt: new Date() })?.code, "card_revoked");
    assert.equal(cardBlock({ billingKey: "bk", revokedAt: null }), null);
  });

  it("표시 문구에 카드 번호가 없다", () => {
    assert.equal(cardLabel("신한", "1234"), "신한 ****1234");
    assert.equal(cardLabel(null, null), "등록된 카드");
    assert.equal(cardLabel("현대", null), "현대");
  });

  it("식별자가 회사별로 갈린다", () => {
    assert.notEqual(issueIdFor("1", "n"), issueIdFor("2", "n"));
    assert.notEqual(cardTopupPaymentId("1", "n"), cardTopupPaymentId("2", "n"));
    // 같은 입력이면 같은 값 — 재시도 시 멱등키가 유지돼야 중복 결제가 막힌다.
    assert.equal(cardTopupPaymentId("1", "n"), cardTopupPaymentId("1", "n"));
  });
});

describe("결제 거절 문구", () => {
  // 실제 실패 모양: 우리가 만든 message 는 "포트원 POST … 실패 (400)" 이고, 진짜 사유는 body 안에 있다.
  const err = (body: unknown) => new PortOneError(400, body, "포트원 POST /payments/card_t1_x 실패 (400)");

  it("PG 가 준 거절 사유(pgMessage)를 꺼낸다 — 사용자가 카드사에 물을 수 있어야 한다", () => {
    assert.equal(declineMessage(err({ type: "PG_PROVIDER_ERROR", pgMessage: "한도초과" })), "한도초과");
    // pgMessage 가 없으면 포트원 message 로 내려간다.
    assert.equal(declineMessage(err({ message: "유효하지 않은 카드입니다" })), "유효하지 않은 카드입니다");
  });

  it("카드사 사유가 없으면 **사람 말 폴백** — 우리 원문을 알림으로 내보내지 않는다", () => {
    // 예전엔 err.message 로 폴백해서 "포트원 POST /payments/… 실패 (400)" · "fetch failed" 가
    // 그대로 운영자 알림에 떴다. 이 함수 주석이 막겠다고 선언한 바로 그 문자열이었다.
    for (const e of [err(null), err({}), new Error("fetch failed"), new Error("네트워크 오류"), null]) {
      const msg = declineMessage(e);
      assert.equal(msg, DECLINE_FALLBACK_MESSAGE);
      assert.doesNotMatch(msg, /[A-Za-z]/, "영어 원문이 사용자 문구로 샜다");
      assert.doesNotMatch(msg, /\b[1-5]\d\d\b/, "HTTP 상태코드가 사용자 문구로 샜다");
    }
    // 원문이 사라지면 안 된다 — 호출부가 서버 로그로 남긴다.
    for (const [file, tag] of [["auto-topup.ts", "거절"], ["index.ts", "거절"]] as const) {
      const src = fs.readFileSync(path.join(SRC, file), "utf-8");
      assert.match(src, new RegExp(`console\\.warn\\([^)]*${tag}`),
        `${file}: 거절 원문을 로그에도 안 남기면 개발자가 볼 곳이 사라진다`);
    }
  });

  it("body 를 통째로 흘리지 않는다 — 빌링키·PG 내부 필드가 화면에 새면 안 된다", () => {
    const msg = declineMessage(err({ pgMessage: "한도초과", billingKey: "bk_super_secret", request: { billingKey: "bk_super_secret" } }));
    assert.doesNotMatch(msg, /bk_super_secret/, "화이트리스트가 아니라 stringify 를 쓰고 있다");
    assert.doesNotMatch(msg, /billingKey/);
  });

  it("길이를 자른다 — PG 가 장문을 보내도 화면이 무너지지 않는다", () => {
    assert.equal(declineMessage(err({ pgMessage: "가".repeat(500) })).length, 200);
  });
});

describe("승인 응답 대조", () => {
  // V2 빌링키 결제 응답은 { payment: {...} } 로 감싸 온다 — 실전과 같은 모양으로 테스트한다.
  const wrap = (p: unknown) => ({ payment: p });

  it("감싸인(billing-key) 응답을 언랩해 대조한다", () => {
    assert.equal(verifyCharge({ response: wrap({ status: "PAID", amount: { total: 1680 } }), expectedKrw: 1680 }).ok, true);
    assert.equal(verifyCharge({ response: wrap({ status: "PAID", amount: { total: 1000 } }), expectedKrw: 1680 }).ok, false);
    assert.equal(verifyCharge({ response: wrap({ status: "FAILED" }), expectedKrw: 100 }).ok, false);
  });

  it("최상위(GET /payments) 응답도 그대로 대조한다", () => {
    const r = verifyCharge({ response: { status: "PAID", amount: { total: 1000 } }, expectedKrw: 1680 });
    assert.equal(r.ok, false);
    assert.equal(verifyCharge({ response: { status: "PAID", amount: { total: 100 } }, expectedKrw: 100 }).ok, true);
  });

  it("상태가 PAID 가 아니면 막는다", () => {
    assert.equal(verifyCharge({ response: { status: "FAILED" }, expectedKrw: 100 }).ok, false);
  });

  it("빈/누락 status 는 실패다 — 모양이 어긋나면 통과 금지", () => {
    // 예전엔 "status 를 안 주면 통과"였고, 그 관용이 언랩 버그(감싸인 응답의 status 가
    // 항상 빈 값)를 숨겼다. 모양이 어긋난 응답으로 크레딧을 주면 안 된다.
    assert.equal(verifyCharge({ response: {}, expectedKrw: 100 }).ok, false);
    assert.equal(verifyCharge({ response: null, expectedKrw: 100 }).ok, false);
    assert.equal(verifyCharge({ response: wrap({}), expectedKrw: 100 }).ok, false);
  });

  it("PAID 인데 금액을 안 주면 통과 — 긁힌 결제를 금액 누락만으로 버리지 않는다", () => {
    assert.equal(verifyCharge({ response: { status: "PAID" }, expectedKrw: 100 }).ok, true);
    assert.equal(verifyCharge({ response: wrap({ status: "PAID" }), expectedKrw: 100 }).ok, true);
  });

  it("unwrapPayment — 감싸임/맨몸 양쪽에서 같은 결제 객체가 나온다", () => {
    assert.deepEqual(unwrapPayment({ payment: { status: "PAID" } }), { status: "PAID" });
    assert.deepEqual(unwrapPayment({ status: "PAID" }), { status: "PAID" });
    assert.equal(unwrapPayment(null), null);
    assert.equal(unwrapPayment("oops"), null);
  });
});

describe("배선", () => {
  const route = (m: string, p: string) =>
    new RegExp(`app\\.${m}\\("${p}"[\\s\\S]*?\\n\\}\\);`).exec(INDEX)?.[0] ?? "";

  it("카드 등록 준비가 설정·고객정보를 먼저 본다", () => {
    const r = route("post", "/api/billing/card/prepare");
    assert.notEqual(r, "", "준비 라우트를 찾지 못했다");
    assert.match(r, /billingConfig\(\)/);
    assert.match(r, /checkCustomer\(/);
    assert.match(r, /billingKeyMethod: "CARD"/, "KG이니시스는 CARD 고정이다");
    assert.match(r, /issueId/, "issueId·issueName 은 KG이니시스 필수다");
  });

  it("빌링키를 화면으로 내보내지 않는다", () => {
    // 빌링키 = 그 카드로 긁을 권한이다. 조회 응답에 실리면 유출 한 번이 결제 권한 유출이 된다.
    const r = route("get", "/api/billing/card");
    assert.notEqual(r, "", "조회 라우트를 찾지 못했다");
    assert.doesNotMatch(r, /billingKey:/, "빌링키가 응답에 실린다");
    assert.match(r, /registered:/);
  });

  it("결제는 금액을 서버가 계산한다", () => {
    const r = route("post", "/api/credits/topup/card");
    assert.notEqual(r, "", "카드 결제 라우트를 찾지 못했다");
    assert.match(r, /buildTopup\(body\.credits\)/, "클라이언트가 보낸 금액을 쓰면 1원에 10만 크레딧을 산다");
    assert.doesNotMatch(r, /body\.amountKrw/);
  });

  it("승인 대조 뒤에만 원장에 올린다", () => {
    const r = route("post", "/api/credits/topup/card");
    const verifyAt = r.indexOf("verifyCharge(");
    const ledgerAt = r.indexOf("addCreditEntry(");
    assert.ok(verifyAt >= 0 && ledgerAt > verifyAt, "대조 전에 크레딧을 올리면 안 된다");
    assert.match(r, /topupDedupeKey\(paymentId\)/, "멱등키가 없으면 재시도가 중복 충전이 된다");
  });

  it("결제 호출이 던지면 failed, 승인 대조 실패는 pending 유지", () => {
    const r = route("post", "/api/credits/topup/card");
    // 호출이 던진 실패는 failed 로 닫는다(웹훅의 failed→paid 전이가 진실을 정산한다).
    assert.match(r, /markTopupPaid\(paymentId, "failed"\)/);
    assert.match(r, /markTopupPaid\(paymentId, "paid"\)/);
    // 승인 대조(verifyCharge) 실패는 **failed 로 찍지 않는다** — 응답 모양이 어긋났을 뿐
    // 돈은 나갔을 수 있어, pending 으로 두고 웹훅이 정산하게 한다.
    const afterVerify = r.slice(r.indexOf("const verdict = verifyCharge"));
    assert.doesNotMatch(afterVerify, /markTopupPaid\(paymentId, "failed"\)/,
      "대조 실패를 failed 로 닫으면 '안 긁힘' 이라는 거짓 기록이 남고 재결제→이중 청구가 된다");
  });

  it("수동 카드충전은 멱등키 + 테넌트 잠금으로 이중 결제를 막는다", () => {
    const r = route("post", "/api/credits/topup/card");
    // 멱등키가 없으면 더블클릭·재시도마다 새 paymentId 가 되어 카드가 두 번 긁힌다.
    assert.match(r, /idempotencyKey/, "브라우저 멱등키를 필수로 받아야 한다");
    assert.match(r, /withTenantLock\(/, "잠금 없이는 동시 클릭 둘이 나란히 긁는다");
    assert.match(r, /getTopup\(paymentId\)/, "잠금 안에서 기존 주문(paid 여부)을 먼저 봐야 한다");
    assert.doesNotMatch(r, /randomBytes/, "랜덤 paymentId 는 포트원 멱등키 보호를 무력화한다");
  });

  it("자동 충전 정책은 절대 상한·임계<충전량 불변식을 라우트에서 막는다", () => {
    const r = route("put", "/api/credits/auto-topup");
    assert.match(r, /AUTO_TOPUP_HARD_MAX_PER_DAY/, "일 횟수 절대 상한이 없다");
    assert.match(r, /AUTO_TOPUP_HARD_MAX_KRW_PER_MONTH/, "월 금액 절대 상한이 없다");
    assert.match(r, /topupCredits <= thresholdCredits/,
      "충전량 ≤ 임계면 충전 후에도 임계 아래라 하루 한도까지 연속 과금된다");
  });

  it("웹훅은 일시적 실패에만 503 을 돌려 재전송을 살린다", () => {
    // 일괄 200 이면 포트원 재전송이 영영 안 온다 — 조회 실패·READY/PENDING 은 503,
    // 확정 실패(금액 불일치·이미 처리·우리 주문 아님)는 200 으로 닫는다.
    const r = route("post", "/api/billing/portone/webhook");
    assert.notEqual(r, "", "웹훅 라우트를 찾지 못했다");
    assert.match(r, /503/, "재전송을 살리는 5xx 분기가 없다");
    assert.match(r, /"READY" \|\| st === "PENDING"/, "진행 중 상태는 재전송 대상이어야 한다");
    assert.match(r, /금액 불일치/, "금액 불일치는 알람 로그를 남기고 200 으로 닫아야 한다");
  });

  it("돈이 나가거나 결제수단을 없애는 경로는 owner/admin 세션만", () => {
    // member 는 분석을 돌리는 사람이지 회사 카드를 해지하거나 돈을 쓰는 사람이 아니다.
    // 안 막으면 초대받은 외주 편집자가 회사 카드를 긁을 수 있다.
    // **API 키로도 못 부른다** — 화이트리스트에 없다(api-keys.test.ts 가 지킨다).
    for (const [m, p] of [
      ["delete", "/api/billing/card"],
      ["post", "/api/credits/topup/card"],
      // 자동 충전 — 돈이 자동으로 나가는 설정이라 더더욱 owner/admin 만.
      ["put", "/api/credits/auto-topup"],
      ["post", "/api/credits/auto-topup/run"],
    ] as [string, string][]) {
      assert.match(route(m, p), /requireManager\(c\)/, `권한 검사 없음: ${m.toUpperCase()} ${p}`);
    }
  });

  it("카드 **등록**은 세션 매니저 또는 billing:write 키만 (2026-08-20)", () => {
    // 고객사가 자기 도메인 화면에서 카드를 등록한다. requireManager 를 그냥 뺀 게 아니라
    // requireCardActor 로 바꿨다 — 여기가 무방비가 되면 로그인 없이도 카드가 갈아끼워진다.
    for (const [m, p] of [
      ["post", "/api/billing/card/prepare"],
      ["post", "/api/billing/card"],
    ] as [string, string][]) {
      assert.match(route(m, p), /requireCardActor\(c\)/, `권한 검사 없음: ${m.toUpperCase()} ${p}`);
    }
    // 그 헬퍼가 실제로 두 경로만 통과시키는지 — api-key 이거나 세션 매니저.
    const src = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");
    const fn = /function requireCardActor[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.notEqual(fn, "", "requireCardActor 를 찾지 못했다");
    assert.match(fn, /via === "api-key"/, "키 경로 판정이 없다");
    assert.match(fn, /requireManager\(c\)/, "세션 경로가 매니저 검사를 안 거친다");
    // 행위자를 남긴다 — 안 남기면 "누가 이 카드를 등록했나" 에 답할 근거가 사라진다.
    assert.match(fn, /apiKeyId/, "키로 등록한 행위자 기록이 없다");
  });

  it("자동 충전 결제는 수동 저장카드 충전과 같은 안전 경로를 쓴다", () => {
    // 자동으로 카드를 긁는 코드다. 멱등키·원장 먼저·자동/수동 구분이 빠지면 이중 충전이나
    // 상한 오집계로 돈 사고가 난다. maybeAutoTopup 이 그 불변식을 지키는지 소스로 고정한다.
    const auto = fs.readFileSync(path.resolve(SRC, "auto-topup.ts"), "utf-8");
    assert.match(auto, /topupDedupeKey\(paymentId\)/, "멱등키가 없으면 재시도가 이중 충전이 된다");
    assert.match(auto, /requestedBy: "auto-topup"/, "자동/수동 구분이 없으면 하루·월 상한이 수동 충전까지 센다");
    assert.match(auto, /shouldAutoTopup\(/, "상한·임계 판정을 반드시 거친다");
    assert.match(auto, /chargeWithBillingKey\(/, "빌링 채널 결제 경로를 재사용한다");
    const ledgerAt = auto.indexOf("addCreditEntry(");
    const paidAt = auto.indexOf('markTopupPaid(paymentId, "paid")');
    assert.ok(ledgerAt >= 0 && paidAt > ledgerAt, "원장(addCreditEntry)이 'paid' 표시보다 먼저여야 크레딧이 안 샌다");
  });

  it("조회는 막지 않는다", () => {
    // 잔액·등록 여부는 member 도 봐야 한다 — "왜 분석이 안 돌지"의 답이 거기 있다.
    assert.doesNotMatch(route("get", "/api/billing/card"), /requireManager\(c\)/);
  });

  it("카드 표는 RLS 대상이라 스코프 있는 풀을 쓴다", () => {
    const dbpg = fs.readFileSync(path.resolve(SRC, "db-pg.ts"), "utf-8");
    const fn = /export async function getBillingCard[\s\S]*?\n\}(?=\r?\n)/.exec(dbpg)?.[0] ?? "";
    assert.notEqual(fn, "", "getBillingCard 를 찾지 못했다");
    assert.doesNotMatch(fn, /rawPool/, "rawPool 로 읽으면 0행이 나온다");
  });

  it("재등록이 해지 표시를 지운다", () => {
    // revoked_at 을 안 비우면 새 카드가 '해지됨' 상태로 저장돼 바로 못 긁는다.
    const dbpg = fs.readFileSync(path.resolve(SRC, "db-pg.ts"), "utf-8");
    const fn = /export async function saveBillingCard[\s\S]*?\n\}(?=\r?\n)/.exec(dbpg)?.[0] ?? "";
    assert.match(fn, /revoked_at = NULL/);
  });

  it("해지가 빌링키를 비운다", () => {
    const dbpg = fs.readFileSync(path.resolve(SRC, "db-pg.ts"), "utf-8");
    const fn = /export async function revokeBillingCard[\s\S]*?\n\}(?=\r?\n)/.exec(dbpg)?.[0] ?? "";
    assert.match(fn, /billing_key = NULL/, "해지된 결제 권한을 계속 들고 있으면 안 된다");
  });
});

describe("카드 표시정보 추출 (extractCardDisplay)", () => {
  it("methods[].card 에서 발급사와 마스킹 끝 4자리를 뽑는다", () => {
    const info = {
      methods: [{ type: "BillingKeyPaymentMethodCard", card: { issuer: "신한카드", brand: "MASTER", number: "533274******1234" } }],
    };
    assert.deepEqual(extractCardDisplay(info), { brand: "신한카드", last4: "1234" });
  });

  it("최상위 card 경로도 지원한다", () => {
    assert.deepEqual(
      extractCardDisplay({ card: { name: "국민", number: "94301032******6809" } }),
      { brand: "국민", last4: "6809" },
    );
  });

  it("발급사가 없으면 브랜드 enum 으로 폴백한다", () => {
    assert.equal(extractCardDisplay({ card: { brand: "VISA", number: "4111********1111" } }).brand, "VISA");
  });

  it("카드정보를 못 찾으면 조용히 null (표시만 못 할 뿐 저장은 된다)", () => {
    assert.deepEqual(extractCardDisplay(null), { brand: null, last4: null });
    assert.deepEqual(extractCardDisplay({}), { brand: null, last4: null });
    assert.deepEqual(extractCardDisplay({ methods: [] }), { brand: null, last4: null });
  });

  it("끝 4자리는 맨 뒤 숫자 묶음에서 — 앞 BIN 을 잘못 집지 않는다", () => {
    // 마스킹이 *가 아니라 공백이어도, x여도 맨 뒤 4자리를 집어야 한다.
    assert.equal(extractCardDisplay({ card: { number: "5327 74xx xxxx 4321" } }).last4, "4321");
  });
});

describe("빌링키 결제는 발급 채널에서 긁는다", () => {
  it("chargeWithBillingKey 는 빌링 채널키로 결제한다 — 일반결제 채널이면 빌링키를 못 찾는다", () => {
    // 빌링키는 발급한 채널(MID)에 묶여 있다. 카드 등록은 PORTONE_BILLING_CHANNEL_KEY 로
    // 발급하므로 결제도 같은 채널이어야 긁힌다. 일반결제 채널키로 긁으면 채널 불일치로 실패한다
    // (2026-08-12 · developers.portone.io: 발급 채널과 결제 채널이 일치해야 함).
    const portone = fs.readFileSync(path.resolve(SRC, "portone.ts"), "utf-8");
    const fn = /export async function chargeWithBillingKey[\s\S]*?\n\}(?=\r?\n)/.exec(portone)?.[0] ?? "";
    assert.notEqual(fn, "", "chargeWithBillingKey 를 찾지 못했다");
    assert.match(fn, /process\.env\.PORTONE_BILLING_CHANNEL_KEY/, "빌링키는 발급한 빌링 채널에서만 긁힌다");
    // 코드가 실제로 읽는 env 만 본다(설명 주석의 PORTONE_CHANNEL_KEY 언급은 제외).
    assert.doesNotMatch(fn, /process\.env\.PORTONE_CHANNEL_KEY\b/, "일반결제 채널키로 긁으면 채널 불일치로 실패한다");
  });
});

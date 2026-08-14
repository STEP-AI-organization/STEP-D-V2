/**
 * 포트원 웹훅 서명 검증 고정 (Standard Webhooks 규격).
 *
 * **위조 웹훅 하나로 크레딧이 올라가면 되돌릴 수 없다.** SDK 대신 직접 구현했으므로
 * (portone.ts 헤더 참조) 규격의 각 조건을 여기서 못 박는다.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import { WEBHOOK_TOLERANCE_SEC, verifyWebhook } from "./portone.ts";

const SECRET_RAW = Buffer.from("stepd-webhook-test-secret-0001").toString("base64");
const SECRET = `whsec_${SECRET_RAW}`;

function sign(id: string, ts: number, body: string, secret = SECRET_RAW): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${id}.${ts}.${body}`).digest("base64");
}

const NOW = 1_770_000_000;
const BODY = JSON.stringify({ type: "Transaction.Paid", data: { paymentId: "cr_t_default_abc" } });

describe("웹훅 서명 — 맞을 때만 통과", () => {
  it("올바른 서명은 통과한다", () => {
    const id = "msg_1";
    const r = verifyWebhook(BODY, { id, timestamp: String(NOW), signature: `v1,${sign(id, NOW, BODY)}` }, SECRET, NOW);
    assert.equal(r.ok, true);
  });

  it("v1, 접두 없이 와도 통과한다", () => {
    const id = "msg_1";
    const r = verifyWebhook(BODY, { id, timestamp: String(NOW), signature: sign(id, NOW, BODY) }, SECRET, NOW);
    assert.equal(r.ok, true);
  });

  it("여러 서명 중 하나만 맞아도 통과한다 (시크릿 로테이션)", () => {
    const id = "msg_1";
    const good = sign(id, NOW, BODY);
    const r = verifyWebhook(BODY, { id, timestamp: String(NOW), signature: `v1,AAAA v1,${good}` }, SECRET, NOW);
    assert.equal(r.ok, true);
  });
});

describe("웹훅 서명 — 하나라도 어긋나면 거부", () => {
  const id = "msg_1";
  const sig = `v1,${sign(id, NOW, BODY)}`;

  it("본문이 한 글자만 달라도 거부", () => {
    const r = verifyWebhook(BODY + " ", { id, timestamp: String(NOW), signature: sig }, SECRET, NOW);
    assert.equal(r.ok, false);
  });

  it("id 가 다르면 거부 (재전송 방어)", () => {
    const r = verifyWebhook(BODY, { id: "msg_2", timestamp: String(NOW), signature: sig }, SECRET, NOW);
    assert.equal(r.ok, false);
  });

  it("시크릿이 다르면 거부", () => {
    const other = Buffer.from("another-secret").toString("base64");
    const r = verifyWebhook(BODY, { id, timestamp: String(NOW), signature: sig }, `whsec_${other}`, NOW);
    assert.equal(r.ok, false);
  });

  it("오래된 웹훅은 거부한다 (재전송 공격 창을 좁힌다)", () => {
    const old = NOW - WEBHOOK_TOLERANCE_SEC - 1;
    const r = verifyWebhook(BODY, { id, timestamp: String(old), signature: `v1,${sign(id, old, BODY)}` }, SECRET, NOW);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /허용 오차/);
  });

  it("미래 시각도 같은 오차로 막는다", () => {
    const future = NOW + WEBHOOK_TOLERANCE_SEC + 1;
    const r = verifyWebhook(BODY, { id, timestamp: String(future), signature: `v1,${sign(id, future, BODY)}` }, SECRET, NOW);
    assert.equal(r.ok, false);
  });

  it("헤더가 없으면 거부", () => {
    for (const h of [
      { id: null, timestamp: String(NOW), signature: sig },
      { id, timestamp: null, signature: sig },
      { id, timestamp: String(NOW), signature: null },
    ]) {
      assert.equal(verifyWebhook(BODY, h, SECRET, NOW).ok, false);
    }
  });

  it("시크릿이 비어 있으면 거부한다 — 검증을 건너뛰지 않는다", () => {
    // env 를 빼먹었을 때 "검증 통과"로 흘러가면 그게 최악이다.
    const r = verifyWebhook(BODY, { id, timestamp: String(NOW), signature: sig }, "", NOW);
    assert.equal(r.ok, false);
  });

  it("거부에는 사유가 있다", () => {
    const r = verifyWebhook(BODY, { id, timestamp: "abc", signature: sig }, SECRET, NOW);
    assert.equal(r.ok, false);
    assert.notEqual(r.ok === false ? r.reason : "", "");
  });
});

// (구 paymentIdFor 테스트는 함수 삭제와 함께 제거 — 2026-08-14. 결정적 결제 식별자 고정은
//  billing-card.test.ts(cardTopupPaymentId)·auto-topup.test.ts(autoTopupNonce)가 담당한다.)

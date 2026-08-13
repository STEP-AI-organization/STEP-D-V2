/**
 * 자동 충전 이중 결제 방어 고정.
 *
 * paymentId 가 포트원의 멱등키다(portone.ts) — 시도마다 랜덤이면 그 보호가 통째로 죽어
 * 동시 트리거에 카드가 두 번 긁힌다. 같은 (테넌트, KST 날짜, 슬롯)에서 항상 같은 값이
 * 나와야 잠금이 못 잡는 경계에서도 중복이 포트원 단에서 충돌한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { autoTopupNonce, kstDateStamp } from "./auto-topup.ts";
import { cardTopupPaymentId } from "./billing-card.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));

describe("자동 충전 paymentId 는 결정적이다", () => {
  it("같은 (날짜, 슬롯) → 항상 같은 값 — 재시도·동시 시도가 포트원 멱등키에서 충돌한다", () => {
    assert.equal(autoTopupNonce("20260813", 1), autoTopupNonce("20260813", 1));
    assert.equal(
      cardTopupPaymentId("t_a", autoTopupNonce("20260813", 1)),
      cardTopupPaymentId("t_a", autoTopupNonce("20260813", 1)),
    );
  });

  it("테넌트·날짜·슬롯이 다르면 다른 값 — 정상 재충전을 막지 않는다", () => {
    assert.notEqual(autoTopupNonce("20260813", 1), autoTopupNonce("20260813", 2));
    assert.notEqual(autoTopupNonce("20260813", 1), autoTopupNonce("20260814", 1));
    assert.notEqual(
      cardTopupPaymentId("t_a", autoTopupNonce("20260813", 1)),
      cardTopupPaymentId("t_b", autoTopupNonce("20260813", 1)),
    );
  });

  it("날짜 스탬프는 KST 다 — UTC 15시(=KST 자정)에 날짜가 바뀐다", () => {
    // 서버 타임존이 어디든 같은 순간엔 같은 슬롯 키가 나와야 한다.
    assert.equal(kstDateStamp(new Date("2026-08-13T14:59:00Z")), "20260813");
    assert.equal(kstDateStamp(new Date("2026-08-13T15:00:00Z")), "20260814");
  });
});

describe("이중 결제 방어 배선 — 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "auto-topup.ts"), "utf-8");

  it("paymentId 에 랜덤을 쓰지 않는다", () => {
    assert.doesNotMatch(src, /randomBytes|randomUUID/,
      "랜덤 paymentId 는 포트원 멱등키 보호를 무력화한다 — 결정적으로 만들 것");
  });

  it("판정~과금이 테넌트 잠금 안에서 돈다", () => {
    assert.match(src, /withTenantLock\(/,
      "잠금 없이는 동시 트리거 둘이 판정을 같이 통과해 카드가 두 번 긁힌다");
  });
});

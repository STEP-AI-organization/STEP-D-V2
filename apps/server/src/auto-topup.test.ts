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

  it("새 결제 전에 미정산 주문을 먼저 정산한다", () => {
    // 승인 후 타임아웃이면 주문은 pending/failed 인데 카드는 긁혀 있다 — 그 위에 새 결제를
    // 이어가면 이중 청구다. 정산(listUnsettledAutoTopups + getPayment 조회)이 반드시
    // 새 결제(chargeWithBillingKey)보다 앞서야 한다.
    const reconcileAt = src.indexOf("listUnsettledAutoTopups(");
    const chargeAt = src.indexOf("chargeWithBillingKey(");
    assert.ok(reconcileAt >= 0, "미정산 정산 호출이 없다");
    assert.ok(chargeAt > reconcileAt, "정산이 새 결제보다 앞서지 않는다");
    // 정산도 같은 대조 경로(verifyCharge = PAID + 금액 일치)를 지나야 한다.
    const seg = src.slice(reconcileAt, chargeAt);
    assert.match(seg, /getPayment\(/, "포트원 실제 상태를 조회하지 않고 정산하면 안 된다");
    assert.match(seg, /verifyCharge\(/, "미승인·금액 불일치를 정산하면 안 된다");
    assert.match(seg, /topupDedupeKey\(/, "정산 적립도 멱등키(dedupe_key)를 지나야 한다");
  });
});

describe("하루 기준 통일 — 소스 스캔 (db-pg.ts)", () => {
  const dbpg = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
  const fn = (name: string) =>
    new RegExp(`export async function ${name}[\\s\\S]*?\\n\\}(?=\\r?\\n)`).exec(dbpg)?.[0] ?? "";

  it("성공 카운트와 시도 슬롯이 같은 'KST 달력일' 을 쓴다", () => {
    // UI 문구가 "하루 최대 N회"(달력일)이고 paymentId 슬롯(kstDateStamp)도 KST 달력일이다.
    // 카운트만 롤링 24시간이면 자정 직후 슬롯과 판정이 서로 다른 "하루"를 산다.
    for (const name of ["autoTopupTodayCount", "autoTopupTodayAttempts"]) {
      const src = fn(name);
      assert.notEqual(src, "", `${name} 를 찾지 못했다`);
      assert.match(src, /Asia\/Seoul/, `${name} 가 KST 달력일을 쓰지 않는다`);
      assert.doesNotMatch(src, /interval '24 hours'/, `${name} 가 롤링 24시간을 쓴다`);
    }
  });

  it("미정산 목록은 자동 충전 요청분만 · 미결제 상태만 · 기간 제한", () => {
    const src = fn("listUnsettledAutoTopups");
    assert.notEqual(src, "", "listUnsettledAutoTopups 를 찾지 못했다");
    assert.match(src, /requested_by = 'auto-topup'/, "수동 충전 미정산은 웹훅 몫 — 자동 충전이 결정하면 안 된다");
    assert.match(src, /status <> 'paid'/);
    assert.match(src, /interval '3 days'/, "무기한이면 오래된 주문을 영원히 재조회한다");
    assert.match(src, /LIMIT 20/);
  });
});

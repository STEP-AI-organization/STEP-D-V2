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

/**
 * 자동 충전 실패가 **제품 안에서 보이는가.**
 *
 * 예전엔 maybeAutoTopup 의 실패 사유가 호출부의 console.warn 하나로 끝났다 — 카드 한도초과·
 * 정지·상한 도달처럼 사용자가 조치해야 끝나는 실패가 화면 어디에도 없었고, 잔액이 0 이 되면
 * "크레딧 부족" 만 보였다. 생산(알림 저장)과 소비(라우트 응답) 양쪽을 다 고정한다 —
 * 이 리포 최빈 실패모드가 "기능은 있는데 출력이 소비처에 미도달" 이다.
 */
describe("자동 충전 실패 노출 — 소스 스캔", () => {
  const auto = fs.readFileSync(path.join(SRC, "auto-topup.ts"), "utf-8");
  const pipeline = fs.readFileSync(path.join(SRC, "content-pipeline.ts"), "utf-8");
  const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
  /** 라우트 블록만 잘라낸다(automation.test.ts 관용구) — 파일 어딘가에 있는 것만으론 부족하다. */
  const route = (re: RegExp) => re.exec(index)?.[0] ?? "";

  it("판정은 code 한 곳에서만 한다 — 호출부의 사유 문구 정규식을 되살리지 않는다", () => {
    // 문구로 거르면 문구를 고치는 순간 판정이 깨지고, "미정산 정산했습니다" 같은 정상
    // 결과까지 경고로 나간다. 판정의 정본은 credits.ts 의 심각도 표 하나뿐이다.
    assert.doesNotMatch(pipeline, /꺼져\|임계보다 많/,
      "자동 충전 사유를 문구 정규식으로 거르고 있다 — autoTopupNeedsAttention(code) 를 쓸 것");
    assert.match(pipeline, /autoTopupNeedsAttention\(/,
      "호출부가 공용 판정 함수를 쓰지 않는다");
  });

  it("알림 저장이 maybeAutoTopup 안에 있다 — 호출부별 배선이면 한쪽이 반드시 빠진다", () => {
    assert.match(auto, /nextAutoTopupAlert\(/, "알림을 만들지 않는다");
    assert.match(auto, /setAutoTopupAlert\(/, "알림을 저장하지 않는다 — 실패가 화면에 도달하지 않는다");
    const fn = /export async function maybeAutoTopup[\s\S]*?\n\}/.exec(auto)?.[0] ?? "";
    assert.match(fn, /setAutoTopupAlert\(/,
      "저장이 maybeAutoTopup 밖에 있다 — 분석 경로·수동 실행 중 한쪽만 알림을 남기게 된다");
  });

  it("실패 사유는 사람이 조치할 수 있는 문구다 — 포트원 body 의 pgMessage 를 꺼낸다", () => {
    // "포트원 POST /payments/… 실패 (400)" 만 남기면 사용자가 카드사에 물을 게 없다.
    assert.match(auto, /declineMessage\(/, "거절 사유를 사람 말로 바꾸지 않는다");
  });

  /** 사유 문구를 code 기준으로 뽑는다 — 주석이 사이에 껴 있어도 잡히게. */
  const reasonOf = (code: string) =>
    new RegExp(`code: "${code}",[\\s\\S]{0,400}?reason: (?:"([^"]*)"|\`([^\`]*)\`)`).exec(auto)?.slice(1)
      .find((v) => typeof v === "string") ?? "";

  it("확인 보류는 사람 말로 — 결제사 상태값·우리끼리 쓰는 말을 사용자에게 내보내지 않는다", () => {
    // 예전 문구: "자동 충전 확인 보류: 결제가 완료되지 않았습니다 (상태 READY). — 웹훅/재조회가
    // 정산합니다." 운영자는 READY 가 뭔지도, 웹훅이 뭔지도 알 필요가 없다.
    const reason = reasonOf("unverified");
    assert.notEqual(reason, "", "unverified 사유 문구를 못 찾았다");
    assert.match(reason, /결제 확인 중/, "지금 무슨 상태인지가 없다");
    assert.doesNotMatch(reason, /웹훅|재조회|READY/, "내부 용어·결제사 상태값이 사용자 문구로 샜다");
    assert.doesNotMatch(reason, /\$\{/, "확인 실패 원문을 그대로 이어 붙인다");
    assert.match(auto, /console\.warn\([^)]*확인 보류/, "원문을 로그에도 안 남기면 개발자가 볼 곳이 없다");
  });

  it("같은 조치를 두 이름으로 부르지 않는다 — 화면 어휘 '직접 충전' 으로 통일", () => {
    // 알림 본문은 "수동 충전", 힌트는 "직접 충전" 이라 사용자는 서로 다른 두 방법이 있는 줄 안다.
    const reason = reasonOf("no_buyer_info");
    assert.match(reason, /직접 충전/);
    assert.doesNotMatch(reason, /수동 충전/, "같은 조치를 message 와 hint 가 다르게 부른다");
  });

  it("사용자가 못 고치는 실패는 사유를 가른다 — 단가 미설정은 관리자 몫", () => {
    // 예전엔 단가 미설정도 bad_amount 라 "자동 충전 설정에서 충전량을 다시 지정하세요" 힌트가
    // 붙었다 — 사용자가 충전량을 몇 번을 고쳐도 절대 안 풀린다. 게다가 buildTopup 의 원문에는
    // 서버 설정 이름이 들어 있어 그대로 이어 붙이면 그것도 화면에 샌다.
    assert.match(auto, /code: "price_unset"/, "단가 미설정을 따로 가르지 않는다");
    const reason = reasonOf("price_unset");
    assert.match(reason, /단가/);
    assert.doesNotMatch(reason, /[A-Z_]{6,}/, "서버 설정 이름이 사용자 문구로 샜다");
    assert.doesNotMatch(reason, /\$\{/, "원문을 그대로 이어 붙인다 — 설정 이름이 다시 샌다");
  });

  it("소비처 도달 — GET /api/automation 과 GET /api/credits 가 알림을 내려준다", () => {
    const automation = route(/app\.get\("\/api\/automation",[\s\S]*?\n\}\);/);
    assert.notEqual(automation, "", "GET /api/automation 라우트를 찾지 못했다");
    assert.match(automation, /autoTopupAlert/,
      "'크레딧 부족' 옆에 원인이 없다 — 사용자가 카드 문제를 추리해야 한다");
    const credits = route(/app\.get\("\/api\/credits",[\s\S]*?\n\}\);/);
    assert.notEqual(credits, "", "GET /api/credits 라우트를 찾지 못했다");
    assert.match(credits, /autoTopupAlert/, "실제로 조치하는 결제 화면에 사유가 안 간다");
  });

  it("조치한 자리에서 알림을 해제한다 — 카드 재등록·정책 저장·직접 충전", () => {
    // 조치했는데 경고가 남아 있으면 화면이 거짓말하고, 그 다음부터 아무도 경고를 안 본다.
    const card = route(/app\.post\("\/api\/billing\/card",[\s\S]*?\n\}\);/);
    assert.match(card, /clearAutoTopupAlert\(/, "카드를 다시 등록해도 옛 사유가 남는다");
    const policy = route(/app\.put\("\/api\/credits\/auto-topup",[\s\S]*?\n\}\);/);
    assert.match(policy, /clearAutoTopupAlert\(/, "상한·정책을 고쳐도 옛 사유가 남는다");
    // 직접 충전이 빠져 있었다 — no_buyer_info 힌트가 "직접 충전 1회로 채워집니다" 라고
    // 안내하고 사용자가 그대로 했는데 경고가 남았다. 안내한 조치는 반드시 경고를 지워야 한다.
    const topup = route(/app\.post\("\/api\/credits\/topup\/card",[\s\S]*?\n\}\);/);
    assert.notEqual(topup, "", "POST /api/credits/topup/card 라우트를 찾지 못했다");
    assert.match(topup, /clearAutoTopupAlert\(/,
      "직접 충전으로 문제를 해결해도 경고가 남는다 — 힌트가 안내한 조치가 화면에 반영되지 않는다");
  });

  it("해제는 한 함수로만 한다 — 라우트마다 배선하면 반드시 한 자리가 빠진다", () => {
    // 실제로 그렇게 빠졌다(직접 충전 경로). 해제 지점이 늘어날수록 누락 확률이 올라가므로
    // 라우트가 저장 함수를 직접 부르지 못하게 막는다.
    assert.doesNotMatch(index, /setAutoTopupAlert\(null\)/,
      "index.ts 가 setAutoTopupAlert 를 직접 부른다 — clearAutoTopupAlert 한 곳으로 모을 것");
    assert.match(auto, /export async function clearAutoTopupAlert/,
      "공용 해제 함수가 없다");
  });

  it("상한 알림은 유효기간이 지나면 읽는 쪽에서 만료된다", () => {
    // "오늘 자동 충전 횟수 상한" 을 지우는 유일한 경로가 다음 maybeAutoTopup 정상 판정인데,
    // 그 호출부는 분석 완료뿐이라 잔액 0 으로 분석이 멈추면 영영 안 불린다 — 사흘 전 기록이
    // 오늘도 "오늘" 로 보였다. 판정은 읽는 한 곳(getAutoTopupAlert)에서 한다.
    const dbpg = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    const fn = /export async function getAutoTopupAlert[\s\S]*?\n\}/.exec(dbpg)?.[0] ?? "";
    assert.notEqual(fn, "", "getAutoTopupAlert 가 없다");
    assert.match(fn, /liveAutoTopupAlert\(/,
      "읽을 때 유효기간을 안 본다 — 사흘 전 상한 알림이 오늘 것처럼 남는다");
  });

  it("알림은 테넌트당 한 행이다 — 새 표 없이 기존 KV 를 쓴다", () => {
    const dbpg = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    const fn = /export async function setAutoTopupAlert[\s\S]*?\n\}/.exec(dbpg)?.[0] ?? "";
    assert.notEqual(fn, "", "setAutoTopupAlert 가 없다");
    assert.match(fn, /setAutomationSetting\(/,
      "저장을 기존 테넌트 KV 로 하지 않는다 — 행이 쌓이면 로그와 같은 문제(같은 줄로 덮임)가 된다");
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

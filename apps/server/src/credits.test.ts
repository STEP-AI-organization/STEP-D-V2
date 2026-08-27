/**
 * 크레딧 불변식 고정. **크레딧 1개 = 분석 1분.**
 *
 * 돈이 걸린 코드라 실패 방향이 중요하다:
 *  - 브라우저가 뭐라 하든 **금액이 안 맞으면 크레딧을 안 올린다**
 *  - 웹훅 재전송·워커 재시도에도 **한 번만** 반영된다
 *  - 잔액을 모르거나 모자라면 **시작하지 않는다** (원가를 쓴 뒤에 알면 늦다)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));

import {
  AUTO_TOPUP_CODES,
  AUTO_TOPUP_SEVERITY,
  MAX_TOPUP_CREDITS,
  autoTopupActionHint,
  autoTopupAlertExpired,
  autoTopupNeedsAttention,
  buildTopup,
  checkCredits,
  creditPriceKrw,
  kstDayKey,
  liveAutoTopupAlert,
  nextAutoTopupAlert,
  settleTopup,
  shouldAutoTopup,
  topupDedupeKey,
  topupPaymentId,
  usageDedupeKey,
  type AutoTopupCode,
  type AutoTopupPolicy,
} from "./credits.ts";

/**
 * ⚠️ 이 describe 는 **비어 있었다**(2026-08-12 발견). 돈의 핵심 불변식이 이름만 있고
 * 아무것도 검증하지 않은 채 조용히 통과하고 있었다.
 *
 * 잔액은 SQL `SUM(delta)` 라 순수 함수로 증명할 수 없다. 그래서 `publish-guard.test.ts` 의
 * 소스 스캔 관용구로 **구조**를 고정한다 — "잔액의 정본은 원장이고, 멱등의 정본은
 * dedupe_key 다" 를 코드에서 확인한다.
 */
describe("잔액은 원장 합계다", () => {
  const dbSrc = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
  const indexSrc = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

  it("creditBalance 는 credit_ledger 의 SUM(delta) 다 — 캐시 컬럼이 아니다", () => {
    const fn = dbSrc.match(/export async function creditBalance[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /SUM\(delta\)/, "잔액이 원장 합계가 아니다");
    assert.match(fn, /FROM credit_ledger/, "잔액을 credit_ledger 가 아닌 곳에서 읽는다");
  });

  it("원장 insert 가 dedupe_key 로 멱등이다 — 웹훅 재전송·워커 재시도에 두 번 오르지 않는다", () => {
    const fn = dbSrc.match(/export async function addCreditEntry[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /ON CONFLICT \(dedupe_key\) DO NOTHING/,
      "원장이 멱등이 아니면 재시도마다 크레딧이 중복 적립된다");
  });

  it("충전 주문 상태를 멱등 기준으로 쓰지 않는다", () => {
    // 예전에는 markTopupPaid 의 `WHERE status='pending'` 이 사실상 멱등 게이트였다.
    // 결제가 던져 'failed' 로 찍힌 주문은 이후 웹훅에서 0행이 되어 크레딧이 영영 안 들어갔고,
    // 응답은 "이미 처리됨" 이었다 — 돈은 나갔는데. 상태는 표시일 뿐 관문이면 안 된다.
    const fn = dbSrc.match(/export async function markTopupPaid[\s\S]*?\n\}/)?.[0] ?? "";
    assert.doesNotMatch(fn, /status\s*=\s*'pending'/,
      "markTopupPaid 가 'pending' 만 갱신하면 failed→paid 전이를 막아 크레딧이 유실된다");
    assert.match(fn, /status\s*<>\s*'paid'/, "failed→paid 전이를 허용해야 웹훅이 진실을 반영한다");
  });

  it("충전 경로는 원장을 먼저 쓰고 상태를 나중에 찍는다", () => {
    // 순서가 뒤집히면 그 사이의 예외가 "주문은 paid, 원장은 빈" 상태를 만들고,
    // 재시도는 settleTopup 의 'paid' 가드에 막혀 복구가 불가능해진다.
    // 앵커는 **두 호출보다 앞선 지점**이어야 한다. 결제 실행/정산 판정 직후부터 본다.
    for (const [label, block] of [
      // 창 크기는 "판정 직후 ~ 성공 경로 끝"을 덮으면 된다. 2026-08-14 웹훅에 재전송
      // 분기(일시적 실패 503)가 늘어 1600자로는 성공 경로가 창 밖으로 밀렸다 — 3000자.
      ["카드 결제", indexSrc.match(/verifyCharge\(\{[\s\S]{0,3000}/)?.[0] ?? ""],
      ["포트원 웹훅", indexSrc.match(/const settle = settleTopup\([\s\S]{0,3000}/)?.[0] ?? ""],
    ] as const) {
      // 성공 경로만 본다. `markTopupPaid(…, "failed")` 는 결제가 실제로 거절됐을 때의
      // 조기 반환이라 원장보다 앞서는 게 정상이다.
      const ledgerAt = block.indexOf("addCreditEntry");
      const statusAt = block.indexOf('markTopupPaid(paymentId, "paid")');
      assert.ok(ledgerAt >= 0, `${label}: addCreditEntry 를 못 찾았다`);
      assert.ok(statusAt >= 0, `${label}: markTopupPaid(…, "paid") 를 못 찾았다`);
      assert.ok(ledgerAt < statusAt,
        `${label}: markTopupPaid 가 addCreditEntry 보다 먼저다 — 그 사이에서 던지면 크레딧이 영구 손실된다`);
    }
  });
});

describe("사용자 내역과 운영 원장은 다르다", () => {
  const dbSrc = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
  const indexSrc = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

  it("사용자 내역에는 delta 0 행이 안 나온다", () => {
    // PG 취소·실패 웹훅이 delta 0 운영 기록을 원장에 남긴다 — 필터 없이 뿌리면
    // "조정 +0" 이 결제 취소 때마다 쌓여 결제 내역처럼 보인다 (2026-08-14 실측).
    const fn = dbSrc.match(/export async function listCreditLedger[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /delta\s*<>\s*0/, "user 스코프가 delta 0 행을 거르지 않는다");
    const userRoute = indexSrc.match(/app\.get\("\/api\/credits",[\s\S]{0,400}/)?.[0] ?? "";
    assert.match(userRoute, /listCreditLedger\(50,\s*"user"\)/,
      "취소 이벤트 기록이 사용자 결제 내역처럼 보이면 안 된다");
  });

  it("운영·정산 경로는 전부 본다 — user 스코프는 사용자 라우트 한 곳뿐", () => {
    // 운영자는 취소 흔적까지 봐야 대사가 된다. 기본값이 ops 라 다른 호출부는 무변경이다.
    const userCalls = indexSrc.match(/listCreditLedger\([^)]*"user"\)/g) ?? [];
    assert.equal(userCalls.length, 1, "user 스코프가 운영 경로로 번지면 대사 근거가 사라진다");
  });
});

describe("잔액 게이트가 원가 진입점마다 선다", () => {
  const indexSrc = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
  const workerSrc = fs.readFileSync(path.join(SRC, "worker.ts"), "utf-8");

  it("/api/media/from-youtube 는 잔액 0 이하를 402 로 거부한다", () => {
    // /api/factory/videos 와 같은 성격(다운로드·분석 = 원가)인데 이 라우트만 게이트가
    // 없으면 화면 경로로 잔액 없는 워크스페이스가 원가를 계속 쓴다.
    const route = indexSrc.match(/app\.post\("\/api\/media\/from-youtube"[\s\S]{0,1500}/)?.[0] ?? "";
    assert.match(route, /creditBalance\(\)/, "from-youtube 에 잔액 확인이 없다");
    assert.match(route, /insufficient_credits/, "402 사유 코드는 factory 쪽과 같아야 한다");
    // 게이트는 행을 만들기 **전에** 서야 한다 — 뒤에 서면 placeholder 회차가 남는다.
    assert.ok(route.indexOf("creditBalance()") < route.indexOf("buildEpisodeAndMedia"),
      "잔액 게이트가 미디어·회차 생성보다 뒤에 있다");
  });

  it("다운로드 완료 → content.analyze 자동 큐잉 전에 정밀 잔액 판정이 선다", () => {
    // 등록 라우트는 러닝타임을 몰라 0 판정만 했다. 다운로드가 끝나면 실제 길이를 아니
    // 여기서 checkCredits 로 정밀 판정한다. 막히면 잡 실패가 아니라 스킵 기록이어야
    // 한다 — 실패면 큐 백오프가 매일 같은 사유로 재시도하는 루프가 된다.
    const fn = workerSrc.match(/async function handleYoutubeDownload[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /checkCredits\(/, "다운로드 완료 후 분석 큐잉 전 잔액 판정이 없다");
    assert.ok(fn.indexOf("checkCredits(") < fn.indexOf('enqueue("content.analyze"'),
      "잔액 판정이 content.analyze 큐잉보다 뒤에 있다");
    assert.match(fn, /크레딧 부족/, "막힌 사유가 사람 말(에피소드 노트)로 안 남는다");
  });
});

describe("모자라면 시작하지 않는다", () => {
  it("잔액이 부족하면 거부하고 몇 개 모자란지 말한다", () => {
    const r = checkCredits({ balance: 10, needMinutes: 59 });
    assert.equal(r.allow, false);
    assert.match(r.allow === false ? r.reason : "", /49개/);
    assert.match(r.allow === false ? r.reason : "", /충전/);
  });

  it("딱 맞으면 통과하고 잔액 0 이 된다", () => {
    const r = checkCredits({ balance: 59, needMinutes: 59 });
    assert.equal(r.allow, true);
    assert.equal(r.allow === true && r.remainingAfter, 0);
  });

  it("러닝타임을 모르면(0) 이 함수는 막지 않는다 — 대신 실행 길목이 막는다", () => {
    // 이 통과 자체는 유지한다: 프로브 실패로 **큐잉조차** 못 하게 만드는 것보다, 길이를
    // 알게 되는 지점까지 진행시키는 편이 낫다(차감은 끝난 뒤 실제 길이로).
    //
    // ⚠️ 다만 예전엔 이게 **유일한** 판정이라 그대로 구멍이었다 — durationSec 이 0 인
    // 미디어는 잔액 0 이어도 60분 분석이 시작됐다(2026-08-26 감사). 지금은 분석을 실제로
    // 시작하는 길목(runContentAnalyze)이 길이가 확정된 뒤 다시 재므로, 이 통과가
    // "공짜 분석" 으로 이어지지 않는다. 아래 describe 가 그 길목을 고정한다.
    assert.equal(checkCredits({ balance: 0, needMinutes: 0 }).allow, true);
  });

  it("음수·NaN 은 통과가 아니라 거부다", () => {
    for (const need of [-1, NaN, Infinity]) {
      const r = checkCredits({ balance: 9999, needMinutes: need });
      assert.equal(r.allow, false, String(need));
    }
  });
});

describe("멱등 — 두 번 충전·두 번 차감 금지", () => {
  it("같은 결제는 같은 키 (웹훅 재전송 방어)", () => {
    assert.equal(topupDedupeKey("cr_t1_abc"), topupDedupeKey("cr_t1_abc"));
    assert.notEqual(topupDedupeKey("cr_t1_abc"), topupDedupeKey("cr_t1_abd"));
  });

  it("같은 미디어는 같은 키 (워커 재시도 방어)", () => {
    assert.equal(usageDedupeKey("m1"), usageDedupeKey("m1"));
  });

  it("사람이 시킨 재분석은 별개다 (원가가 다시 든다)", () => {
    assert.notEqual(usageDedupeKey("m1"), usageDedupeKey("m1", 1));
  });

  it("결제 식별자는 우리가 만들고 이상 문자를 지운다", () => {
    assert.equal(topupPaymentId("t_default", "a1b2"), "cr_t_default_a1b2");
    assert.equal(topupPaymentId("t/../x", "a b"), "cr_tx_ab");
  });
});

describe("충전 주문 — 금액은 서버가 계산한다", () => {
  const env = { CREDIT_PRICE_KRW: "50" } as NodeJS.ProcessEnv;

  it("크레딧 × 단가 — 단가는 공급가액이고 청구액엔 부가세가 붙는다", () => {
    // 2026-08-27 확정: CREDIT_PRICE_KRW 는 **공급가액**이다(부가세 별도).
    // 예전엔 총액을 부가세 포함으로 봐서 60원/개가 실수령 54.5원이 됐다.
    const r = buildTopup(600, env);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.supplyKrw, 30_000, "공급가액 = 크레딧 × 단가");
    assert.equal(r.ok === true && r.vatKrw, 3_000, "세액 = 공급가액의 10%");
    assert.equal(r.ok === true && r.amountKrw, 33_000, "청구액 = 공급가액 + 세액");
    // 고정 정책 수량(5,000개)도 같은 규칙 — 단가는 픽스처 값을 그대로 따른다
    // (프로덕션 60원이면 공급가 300,000 + 세액 30,000 = 330,000 청구).
    const price = Number(env.CREDIT_PRICE_KRW);
    const fixed = buildTopup(5_000, env);
    assert.equal(fixed.ok === true && fixed.amountKrw, 5_000 * price * 1.1);
  });

  it("단가가 없으면 결제창을 띄우지 않는다", () => {
    // 0원 결제나 임의 단가보다 "안 됨"이 낫다.
    const r = buildTopup(600, {} as NodeJS.ProcessEnv);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /CREDIT_PRICE_KRW/);
  });

  it("정수 아닌 값·0·음수를 거부한다", () => {
    for (const bad of [0, -1, 1.5, "abc", null, undefined, {}]) {
      assert.equal(buildTopup(bad, env).ok, false, JSON.stringify(bad));
    }
  });

  it("한 번에 살 수 있는 상한이 있다 (0 하나 더 붙는 사고 방지)", () => {
    assert.equal(buildTopup(MAX_TOPUP_CREDITS, env).ok, true);
    assert.equal(buildTopup(MAX_TOPUP_CREDITS + 1, env).ok, false);
  });

  it("단가는 양수만", () => {
    for (const bad of ["", "0", "-5", "abc"]) {
      assert.equal(creditPriceKrw({ CREDIT_PRICE_KRW: bad } as NodeJS.ProcessEnv), null, bad);
    }
  });
});

describe("결제 대조 — 브라우저를 믿지 않는다", () => {
  const order = { credits: 600, amountKrw: 30000, status: "pending" };

  it("금액이 맞고 PAID 여야 올린다", () => {
    const r = settleTopup({ order, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, true);
    assert.equal(r.credit === true && r.credits, 600);
  });

  it("금액이 다르면 올리지 않는다", () => {
    // 결제창 파라미터가 조작됐거나 우리 계산이 틀렸다 — 둘 다 크레딧을 주면 안 된다.
    const r = settleTopup({ order, payment: { status: "PAID", amountTotal: 1 } });
    assert.equal(r.credit, false);
    assert.match(r.credit === false ? r.reason : "", /금액/);
  });

  it("PAID 가 아니면 올리지 않는다", () => {
    for (const st of ["READY", "FAILED", "CANCELLED", "", undefined]) {
      const r = settleTopup({ order, payment: { status: st, amountTotal: 30000 } });
      assert.equal(r.credit, false, String(st));
    }
  });

  it("이미 처리된 충전은 다시 올리지 않는다", () => {
    const r = settleTopup({ order: { ...order, status: "paid" }, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, false);
  });

  it("우리 주문이 없으면 올리지 않는다 (남이 만든 paymentId 방어)", () => {
    const r = settleTopup({ order: null, payment: { status: "PAID", amountTotal: 30000 } });
    assert.equal(r.credit, false);
  });

  it("조회 실패를 성공으로 치지 않는다", () => {
    assert.equal(settleTopup({ order, payment: null }).credit, false);
  });
});

describe("자동 충전 — 상한이 없으면 못 켠다", () => {
  const policy: AutoTopupPolicy = {
    enabled: true, thresholdCredits: 60, topupCredits: 600,
    maxPerDay: 2, maxKrwPerMonth: 200_000,
  };
  const base = { policy, balance: 10, todayCount: 0, monthKrw: 0, amountKrw: 30_000 };

  it("기본은 꺼져 있다", () => {
    assert.equal(shouldAutoTopup({ ...base, policy: { ...policy, enabled: false } }).charge, false);
  });

  it("임계 위면 충전하지 않는다", () => {
    assert.equal(shouldAutoTopup({ ...base, balance: 100 }).charge, false);
  });

  it("일 한도에 걸리면 멈춘다 — 조용히 계속 긁지 않는다", () => {
    const r = shouldAutoTopup({ ...base, todayCount: 2 });
    assert.equal(r.charge, false);
    const reason = r.charge === false ? r.reason : "";
    assert.match(reason, /한도/);
    // 이 사유는 이제 사용자 화면(상시 배너)에 그대로 뜬다. "긁다" 는 우리끼리의 설계
    // 설명이지 방송사 운영자가 읽을 말이 아니다 — 사실 + 다음 행동만 남긴다.
    assert.doesNotMatch(reason, /긁/, "판정 로직의 설계 설명이 사용자 문구로 샜다");
  });

  it("월 한도를 넘기면 멈춘다", () => {
    const r = shouldAutoTopup({ ...base, monthKrw: 190_000 });
    assert.equal(r.charge, false);
  });

  it("전부 통과해야 긁는다", () => {
    assert.equal(shouldAutoTopup(base).charge, true);
  });

  it("충전량 ≤ 임계면 긁지 않는다 — 충전해도 임계 아래라 하루 한도까지 연속 과금된다", () => {
    // 라우트가 400 으로 막지만, 검증이 생기기 전에 저장된 행도 판정에서 걸려야 한다.
    for (const topupCredits of [60, 30]) {
      const r = shouldAutoTopup({ ...base, policy: { ...policy, topupCredits } });
      assert.equal(r.charge, false, `topupCredits=${topupCredits} 가 통과했다`);
    }
    // 임계보다 1 이라도 크면 정상 — 정상 설정을 막지 않는다.
    assert.equal(shouldAutoTopup({ ...base, policy: { ...policy, topupCredits: 61 } }).charge, true);
  });

  it("절대 상한 — 정책값이 미쳐도 월 500만원·일 10회에서 멈춘다", () => {
    // 검증 전 저장분·수동 조작 대비: 판정은 min(정책, 절대 상한)으로 조인다.
    const r = shouldAutoTopup({
      ...base, policy: { ...policy, maxKrwPerMonth: 99_999_999 }, monthKrw: 5_000_000,
    });
    assert.equal(r.charge, false, "월 절대 상한이 안 걸렸다");
    const r2 = shouldAutoTopup({
      ...base, policy: { ...policy, maxPerDay: 999 }, todayCount: 10,
    });
    assert.equal(r2.charge, false, "일 절대 상한이 안 걸렸다");
  });

  it("판정마다 기계 판독 code 를 준다 — 문구가 바뀌어도 소비처가 안 깨진다", () => {
    // 예전엔 "알려야 할 실패인가" 를 호출부가 사유 **문구 정규식**으로 갈랐다.
    // 문구는 사람용이라 언제든 바뀐다 — code 가 판정의 정본이어야 한다.
    const cases: [AutoTopupCode, Parameters<typeof shouldAutoTopup>[0]][] = [
      ["disabled", { ...base, policy: { ...policy, enabled: false } }],
      ["bad_policy", { ...base, policy: { ...policy, topupCredits: 60 } }],
      ["above_threshold", { ...base, balance: 100 }],
      ["daily_cap", { ...base, todayCount: 2 }],
      ["monthly_cap", { ...base, monthKrw: 190_000 }],
    ];
    for (const [code, input] of cases) {
      const r = shouldAutoTopup(input);
      assert.equal(r.charge, false, `${code} 케이스가 통과했다`);
      assert.equal(r.charge === false ? r.code : "", code);
    }
  });
});

/**
 * 자동 충전 실패 알림 — **정상 사유는 노이즈다.**
 *
 * 실패가 화면에 안 뜨는 것과, 정상 사유까지 다 띄워 경고가 배경음이 되는 것은 같은 구멍의
 * 양쪽 끝이다. 무엇을 알리고 무엇을 지우는지의 **실행 가능한 정의**를 여기 고정한다.
 */
describe("자동 충전 실패 알림", () => {
  const at = (n: number) => `2026-08-18T0${n}:00:00.000Z`;

  it("정상 사유는 알림을 만들지 않는다 — 꺼짐·잔액 충분·정산됨·충전됨·카드 미등록", () => {
    for (const code of ["charged", "disabled", "above_threshold", "reconciled", "no_card", "unverified"] as const) {
      assert.equal(
        nextAutoTopupAlert(null, { code, reason: "무언가" }, at(1)), null,
        `${code} 는 사용자가 할 일이 없다 — 알리면 진짜 경고가 묻힌다`,
      );
      assert.equal(autoTopupNeedsAttention(code), false);
    }
  });

  it("조치가 필요한 실패는 알림 + 할 일(hint) 을 같이 남긴다", () => {
    // 사유만 있고 할 일이 없으면 사용자는 여전히 카드사에 뭘 물어야 할지 모른다.
    for (const code of [
      "card_revoked", "no_buyer_info", "bad_amount", "bad_policy", "price_unset",
      "daily_cap", "monthly_cap", "charge_declined",
    ] as const) {
      const a = nextAutoTopupAlert(null, { code, reason: "실패 사유", balance: 0 }, at(1));
      assert.ok(a, `${code} 알림이 안 만들어졌다`);
      assert.equal(a!.code, code);
      assert.equal(a!.message, "실패 사유");
      assert.notEqual(a!.hint.trim(), "", `${code} 에 조치 안내가 없다`);
      assert.equal(a!.firstAt, at(1));
      assert.equal(a!.count, 1);
      assert.equal(a!.balance, 0);
    }
  });

  it("모든 code 가 심각도로 분류돼 있다 — 미분류가 조용히 생기면 구멍이 재발한다", () => {
    for (const code of AUTO_TOPUP_CODES) {
      assert.ok(AUTO_TOPUP_SEVERITY[code], `${code} 가 분류되지 않았다`);
    }
    // action_required 는 전부 조치 문구가 있어야 한다(반대로 info/ok 는 없어야 노이즈가 안 된다).
    for (const code of AUTO_TOPUP_CODES) {
      const hint = autoTopupActionHint(code);
      if (AUTO_TOPUP_SEVERITY[code] === "action_required") assert.notEqual(hint, "", `${code} hint 누락`);
      else assert.equal(hint, "", `${code} 는 알리지 않는데 조치 문구가 있다`);
    }
  });

  it("사용자가 못 고치는 실패에 사용자 조치를 시키지 않는다 — 단가 미설정 vs 충전량 오류", () => {
    // 단가는 **서비스 쪽 설정**이다. 예전엔 둘 다 bad_amount 로 접혀 "자동 충전 설정에서
    // 충전량을 다시 지정하세요" 라고 안내했는데, 사용자가 충전량을 몇 번을 고쳐도 안 풀린다.
    const price = autoTopupActionHint("price_unset");
    assert.match(price, /문의/, "사용자가 못 푸는 실패인데 문의처가 없다");
    assert.doesNotMatch(price, /충전량/, "충전량을 고치라고 안내한다 — 그래도 안 풀린다");
    assert.notEqual(price, autoTopupActionHint("bad_amount"), "두 사유가 같은 조치를 안내한다");
    // 설정 이름(서버 env)은 사용자 화면에 나가지 않는다.
    for (const code of AUTO_TOPUP_CODES) {
      assert.doesNotMatch(autoTopupActionHint(code), /[A-Z_]{6,}/, `${code}: 설정 이름이 문구로 샜다`);
    }
  });

  it("같은 사유가 반복되면 한 건으로 센다 — firstAt 보존 + count 증가", () => {
    // 분석이 끝날 때마다 도는 경로라 로그처럼 쌓으면 화면이 같은 줄로 덮인다
    // (rule_run 의 hasRunNote 와 같은 정신). "언제부터 실패 중인지" 가 보존돼야 한다.
    let a = nextAutoTopupAlert(null, { code: "charge_declined", reason: "한도초과" }, at(1));
    a = nextAutoTopupAlert(a, { code: "charge_declined", reason: "한도초과" }, at(2));
    a = nextAutoTopupAlert(a, { code: "charge_declined", reason: "한도초과" }, at(3));
    assert.equal(a!.count, 3);
    assert.equal(a!.firstAt, at(1), "처음 실패한 시각이 덮였다 — 카드사에 물을 근거가 사라진다");
    assert.equal(a!.lastAt, at(3));
  });

  it("사유가 바뀌면 새 알림이다 — 옛 시각을 물려주지 않는다", () => {
    const prev = nextAutoTopupAlert(null, { code: "charge_declined", reason: "한도초과" }, at(1));
    const next = nextAutoTopupAlert(prev, { code: "monthly_cap", reason: "월 한도" }, at(2));
    assert.equal(next!.code, "monthly_cap");
    assert.equal(next!.firstAt, at(2));
    assert.equal(next!.count, 1);
  });

  it("해소되면 알림을 지운다 — 해결된 경고가 남으면 다음부터 아무도 안 본다", () => {
    const prev = nextAutoTopupAlert(null, { code: "charge_declined", reason: "한도초과" }, at(1));
    assert.ok(prev);
    // 사용자가 직접 충전(잔액 회복) 하거나, 다음 시도가 성공한 경우.
    assert.equal(nextAutoTopupAlert(prev, { code: "above_threshold", reason: "잔액이 임계보다 많습니다." }, at(2)), null);
    assert.equal(nextAutoTopupAlert(prev, { code: "charged", reason: "" }, at(2)), null);
  });
});

/**
 * 상한 알림의 **유효기간** — "오늘" 이라고 쓰려면 정말 오늘이어야 한다.
 *
 * 알림을 지우는 유일한 경로가 "다음 maybeAutoTopup 이 정상 판정" 인데, 그 호출부는 분석
 * 완료뿐이다 — 잔액 0 으로 분석이 멈추면 영영 다시 안 불려 사흘 전 daily_cap 이 그대로
 * 남는다. 사용자는 사흘 전 기록을 보고 오늘 상한에 걸린 줄 안다.
 */
describe("자동 충전 상한 알림은 기간이 지나면 만료된다", () => {
  const alert = (code: "daily_cap" | "monthly_cap" | "charge_declined", lastAt: string) =>
    nextAutoTopupAlert(null, { code, reason: "사유" }, lastAt)!;

  it("daily_cap 은 KST 날짜가 바뀌면 만료 — 같은 날이면 유효", () => {
    const a = alert("daily_cap", "2026-08-15T02:00:00.000Z"); // KST 8/15 11:00
    assert.equal(a.kstDay, "2026-08-15");
    assert.equal(autoTopupAlertExpired(a, "2026-08-15T13:00:00.000Z"), false, "같은 KST 날짜인데 만료됐다");
    assert.equal(autoTopupAlertExpired(a, "2026-08-18T02:00:00.000Z"), true,
      "사흘 전 기록이 오늘 '오늘 상한 도달' 로 보인다");
  });

  it("경계는 KST 자정(UTC 15:00) 이다 — 서버 타임존과 무관하게 같은 판정", () => {
    const a = alert("daily_cap", "2026-08-15T14:59:00.000Z"); // 아직 KST 8/15
    assert.equal(a.kstDay, "2026-08-15");
    assert.equal(autoTopupAlertExpired(a, "2026-08-15T14:59:59.000Z"), false);
    assert.equal(autoTopupAlertExpired(a, "2026-08-15T15:00:00.000Z"), true, "KST 자정을 넘겼는데 그대로다");
  });

  it("monthly_cap 은 달이 바뀌어야 만료 — 같은 달 다른 날은 유효", () => {
    const a = alert("monthly_cap", "2026-08-03T02:00:00.000Z");
    assert.equal(autoTopupAlertExpired(a, "2026-08-28T02:00:00.000Z"), false, "이번 달 상한은 이번 달 내내 참이다");
    assert.equal(autoTopupAlertExpired(a, "2026-09-01T02:00:00.000Z"), true, "달이 바뀌었는데 '이번 달' 이라고 한다");
  });

  it("사람이 조치해야 끝나는 사유는 안 늙는다 — 카드 거절은 한 달 뒤에도 유효하다", () => {
    // 기간으로 지우면 안 되는 쪽이다. 카드가 여전히 막혀 있는데 경고만 사라지면
    // 자동 충전이 조용히 멈춘 상태로 돌아간다(이 기능이 메우려던 바로 그 구멍).
    const a = alert("charge_declined", "2026-08-03T02:00:00.000Z");
    assert.equal(autoTopupAlertExpired(a, "2026-09-30T02:00:00.000Z"), false);
  });

  it("kstDay 이전에 저장된 알림은 lastAt 으로 판정한다 — 배포 순간의 기존 알림도 늙는다", () => {
    const legacy = { ...alert("daily_cap", "2026-08-15T02:00:00.000Z"), kstDay: "" };
    assert.equal(autoTopupAlertExpired(legacy, "2026-08-15T13:00:00.000Z"), false);
    assert.equal(autoTopupAlertExpired(legacy, "2026-08-18T02:00:00.000Z"), true);
  });

  it("언제 생긴 건지 못 읽으면 만료로 본다 — 모르면 '오늘' 이라고 주장하지 않는다", () => {
    const broken = { ...alert("daily_cap", "2026-08-15T02:00:00.000Z"), kstDay: "", lastAt: "깨진 값" };
    assert.equal(kstDayKey("깨진 값"), "");
    assert.equal(autoTopupAlertExpired(broken, "2026-08-15T13:00:00.000Z"), true);
  });

  it("읽는 쪽 게이트(liveAutoTopupAlert)가 만료분을 null 로 만든다", () => {
    const a = alert("daily_cap", "2026-08-15T02:00:00.000Z");
    assert.equal(liveAutoTopupAlert(a, "2026-08-15T13:00:00.000Z"), a);
    assert.equal(liveAutoTopupAlert(a, "2026-08-18T02:00:00.000Z"), null);
    assert.equal(liveAutoTopupAlert(null, "2026-08-18T02:00:00.000Z"), null);
  });
});


/**
 * **분석은 잔액 ≥ 필요분일 때만 시작한다** (사용자 확정 2026-08-26:
 * "잔액 40 에 60분 영상이 들어오면 분석에 들어가면 안 된다 — 돈 받고 시작").
 *
 * 큐잉 시점 게이트(라우트·factory·media.prepare·youtube.download)만으로는 이 불변식이
 * 지켜지지 않는다. 셋이 새기 때문이다:
 *   ① 길이를 모르면 통과(need=0) ② 차감이 분석 완료 후라 큐잉분끼리 같은 잔액을 본다
 *   ③ 게이트를 안 거치는 큐잉 경로(어드민 큐 정리·GEBD 완료 후 재큐잉)
 * 그래서 **실제로 분석을 시작하는 한 지점**에서 다시 재야 한다.
 */
describe("분석 시작 길목이 잔액을 다시 잰다 (소스 스캔)", () => {
  const pipe = fs.readFileSync(path.join(SRC, "content-pipeline.ts"), "utf-8");
  const fn = pipe.match(/export async function runContentAnalyze[\s\S]*?\n\}/)?.[0] ?? "";

  it("runContentAnalyze 가 시작 전에 checkCredits 로 판정한다", () => {
    assert.notEqual(fn, "", "runContentAnalyze 를 못 잘랐다");
    assert.match(fn, /checkCredits\(/, "실행 길목에 잔액 판정이 없다 — 큐잉 게이트의 구멍이 그대로 통과한다");
    assert.match(fn, /billableMinutes\(media\.durationSec/,
      "필요분을 실제 영상 길이로 재지 않는다");
  });

  it("판정이 **무거운 일을 시작하기 전**에 선다", () => {
    // 워크디렉토리 생성·GCS 체크포인트 복원·소스 다운로드보다 앞이어야 원가가 안 나간다.
    assert.ok(fn.indexOf("checkCredits(") < fn.indexOf("sweepStaleWorkDirs()"),
      "잔액 판정이 작업 디렉토리 준비보다 뒤에 있다 — 막을 거면 아무것도 시작하기 전에 막아야 한다");
  });

  it("모자라면 조용히 넘기지 않고 던진다 — 그리고 회차에 사유를 남긴다", () => {
    assert.match(fn, /throw new Error\(`content\.analyze: 크레딧 부족/,
      "부족한데 계속 진행하거나 조용히 return 한다");
    assert.match(fn, /setEpisodePipeline\(/, "회차 화면이 오지 않을 완료를 기다리게 된다");
    // 자동배포 순방(episodeAnalysisState)이 '크레딧|충전' 문구로 blocked 를 판정한다 —
    // 문구가 갈라지면 "분석 중" 으로 잘못 세어 오지 않을 완료를 기다린다.
    assert.match(fn, /크레딧 부족/, "순방이 읽는 어휘(크레딧/충전)가 사유에 없다");
  });

  it("막기 전에 자동 결제를 먼저 시도한다 — '돈 받고 시작' 의 돈 받는 자리", () => {
    assert.match(fn, /topupAndRecheck\(/, "카드가 있어도 충전 시도 없이 막는다");
    assert.ok(fn.indexOf("topupAndRecheck(") < fn.indexOf("throw new Error(`content.analyze: 크레딧 부족"),
      "충전 시도가 차단보다 뒤면 카드가 있어도 분석이 멈춘다");
  });
});

/**
 * **길이 미상(durationSec=0)이 공짜 분석으로 새지 않는다** (2026-08-26 감사에서 발견).
 *
 * 실제로 갇히는 경로가 있다: media.prepare 가 바이트를 운영 버킷으로 옮긴(promoteUpload) 뒤
 * probe 에서 죽으면 DB 는 durationSec=0 인데 파일은 받아진다. 그러면
 *   게이트 need=0 → 통과 · 차감 billableMinutes(0)=0 → 0
 * 이 되어 **잔액 0 으로 60분 분석이 돌고 크레딧은 1도 안 빠지며, 재분석마다 반복**된다.
 * 통과와 차감이 같은 값을 읽으므로 "무료 실행" 이 구조적으로 가능해지는 게 핵심이다.
 */
describe("길이를 모르면 통과가 아니라 확정 대상이다 (소스 스캔)", () => {
  const pipe = fs.readFileSync(path.join(SRC, "content-pipeline.ts"), "utf-8");
  const fn = pipe.match(/export async function runContentAnalyze[\s\S]*?\n\}/)?.[0] ?? "";
  const workerSrc = fs.readFileSync(path.join(SRC, "worker.ts"), "utf-8");
  const indexSrc = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

  it("소스를 받은 뒤 길이를 재서 DB 에 백필한다 — 게이트만 통과시키고 정산 0 인 반쪽 금지", () => {
    assert.notEqual(fn, "", "runContentAnalyze 를 못 잘랐다");
    assert.match(fn, /updateMediaDuration\(/,
      "길이를 재측정해도 DB 에 안 쓰면 차감(billableMinutes)이 계속 0 이다");
    assert.match(fn, /probe\(videoPath\)/, "로컬 소스로 길이를 재는 자리가 없다");
    // 백필은 **파이썬 파이프라인(회차당 ≈₩800) 앞**이어야 막는 의미가 있다.
    // 앵커는 `core.analyze` 모듈 인자 — 그게 실제 지출이 시작되는 지점이다.
    const backfillAt = fn.indexOf("updateMediaDuration(");
    const spendAt = fn.indexOf("core.analyze");
    assert.ok(backfillAt >= 0 && spendAt >= 0, "백필 또는 파이프라인 실행 지점을 못 찾았다");
    assert.ok(backfillAt < spendAt,
      "길이 백필이 파이프라인 실행보다 뒤에 있다 — 막아도 이미 원가가 나간 뒤다");
  });

  it("끝내 길이를 모르면 시작하지 않는다 — 모르면 안 내보낸다", () => {
    assert.match(fn, /영상 길이를 확인하지 못해 시작하지 않음/,
      "길이 미상이 조용히 통과한다 — 원가는 나가고 차감은 0 인 무료 분석이 된다");
  });

  it("재측정한 길이로 크레딧을 **다시** 잰다", () => {
    // 1단(큐잉 길이)만 있으면 durationSec=0 이던 미디어는 판정을 한 번도 안 받는다.
    assert.match(fn, /gateCredits\([\s\S]{0,40}"실측 길이"\)/,
      "실측 길이로 재판정하지 않는다 — 길이를 알아내고도 잔액을 안 본다");
  });

  it("바이트를 옮겼으면 DB 경로도 즉시 쓴다 — 실제 위치와 기록이 어긋나면 안 된다", () => {
    const prep = workerSrc.match(/async function handleMediaPrepare[\s\S]*?\n\}/)?.[0] ?? "";
    assert.notEqual(prep, "", "handleMediaPrepare 를 못 잘랐다");
    const promoteAt = prep.indexOf("promoteUpload(");
    const pathAt = prep.indexOf("updateMediaPath(");
    assert.ok(promoteAt >= 0 && pathAt > promoteAt,
      "promoteUpload 뒤에 경로 기록이 없다 — remux·probe 가 죽으면 DB 가 옛 경로에 갇힌다");
    // 그 사이에 실패할 수 있는 무거운 단계(remux·probe)가 끼면 안 된다.
    const between = prep.slice(promoteAt, pathAt);
    assert.doesNotMatch(between, /await probe\(|remuxFaststart\(/,
      "경로 기록 전에 실패 가능한 단계가 끼어 있다 — 그 창에서 죽으면 어긋남이 그대로 굳는다");
  });

  it("길이를 몰라도 잔액 0 이면 큐잉 단계에서 막는다", () => {
    const gate = indexSrc.match(/async function creditBlockReason[\s\S]*?\n\}/)?.[0] ?? "";
    assert.notEqual(gate, "", "creditBlockReason 을 못 잘랐다");
    const zeroBranch = gate.slice(gate.indexOf("need <= 0"), gate.indexOf("checkCredits("));
    assert.match(zeroBranch, /creditBalance\(\)/,
      "길이 미상이면 잔액을 아예 안 본다 — 잔액 0 워크스페이스가 다운로드 이그레스부터 태운다");
  });
});

/**
 * 운영자 수동 크레딧 조정 고정.
 *
 * **원장은 append-only 다**(migrations/0024 트리거가 UPDATE/DELETE 를 막는다).
 * 정정도 반대 부호 행을 하나 더 쌓는 것이지 지우는 게 아니라, **잘못 넣으면 영구히 남는다.**
 * 그래서 막는 방향이 전부 "안 들어감" 이어야 한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MANUAL_REASONS,
  MAX_MANUAL_DELTA,
  manualDedupeKey,
  planManualCredit,
} from "../billing/credits.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf-8");

const ok = (over: Record<string, unknown> = {}) =>
  planManualCredit({ delta: 60, reason: "grant", note: "영업 체험분", ...over });

describe("수동 조정 판정", () => {
  it("정상 입력을 통과시킨다", () => {
    const r = ok();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.delta, 60);
    assert.equal(r.reason, "grant");
  });

  it("음수(차감)도 된다", () => {
    // 테스트 결제 취소처럼 되돌려야 하는 경우가 있다.
    const r = ok({ delta: -60, reason: "adjust", note: "테스트 결제 취소" });
    assert.equal(r.ok && r.delta, -60);
  });

  it("0 과 빈 값은 막는다", () => {
    for (const d of [0, "0", "", null, undefined, "abc", NaN, 0.4]) {
      assert.equal(ok({ delta: d }).ok, false, `통과하면 안 되는 값: ${String(d)}`);
    }
  });

  it("소수는 잘라서 정수로 넣는다", () => {
    assert.equal(ok({ delta: 60.9 }).ok && (ok({ delta: 60.9 }) as any).delta, 60);
    assert.equal(ok({ delta: "60" }).ok, true);
  });

  it("한 번에 움직일 수 있는 양에 상한이 있다", () => {
    // 0 을 하나 더 붙이는 실수를 여기서 막는다 — 원장은 되돌릴 수 없다.
    assert.equal(ok({ delta: MAX_MANUAL_DELTA }).ok, true);
    assert.equal(ok({ delta: MAX_MANUAL_DELTA + 1 }).ok, false);
    assert.equal(ok({ delta: -(MAX_MANUAL_DELTA + 1) }).ok, false);
  });

  it("topup·usage 는 손으로 못 쓴다", () => {
    // topup 은 실결제가 붙은 행이라 손으로 쓰면 매출이 부풀고,
    // usage 는 파이프라인이 실제로 원가를 쓴 기록이라 손으로 쓰면 원가 집계가 어긋난다.
    assert.equal(ok({ reason: "topup" }).ok, false);
    assert.equal(ok({ reason: "usage" }).ok, false);
    assert.equal(ok({ reason: "" }).ok, false);
    assert.equal(ok({ reason: "GRANT" }).ok, false, "대소문자가 다르면 같은 값이 아니다");
    for (const r of MANUAL_REASONS) assert.equal(ok({ reason: r }).ok, true, r);
  });

  it("메모 없이는 못 넣는다", () => {
    // 6개월 뒤에 이 행을 보고 "왜 넣었지" 가 되면 원장이 있으나 마나다.
    for (const n of ["", "   ", "ㅇㅇ", undefined]) {
      assert.equal(ok({ note: n }).ok, false, `통과하면 안 되는 메모: ${String(n)}`);
    }
    const long = ok({ note: "가".repeat(500) });
    assert.equal(long.ok && long.note.length, 300, "메모는 잘라서 저장한다");
  });

  it("dedupe 키는 회사·nonce 로 갈린다", () => {
    assert.notEqual(manualDedupeKey("t_a", "n1"), manualDedupeKey("t_b", "n1"));
    assert.notEqual(manualDedupeKey("t_a", "n1"), manualDedupeKey("t_a", "n2"));
    assert.equal(manualDedupeKey("t_a", "n1"), manualDedupeKey("t_a", "n1"));
  });
});

describe("배선", () => {
  const route = (m: string, p: string) =>
    new RegExp(`app\\.${m}\\("${p}"[\\s\\S]*?\\n\\}\\);`).exec(INDEX)?.[0] ?? "";

  it("조정 라우트가 판정을 거친다", () => {
    const r = route("post", "/api/superadmin/tenants/:id/credits");
    assert.notEqual(r, "", "조정 라우트를 찾지 못했다");
    assert.match(r, /planManualCredit\(/, "검증 없이 원장에 쓰면 안 된다");
    assert.match(r, /requireReason\(/, "남의 회사 크레딧을 사유 없이 바꿀 수 없다");
    assert.match(r, /action: "credit\.adjust"/, "감사 기록이 빠졌다");
  });

  it("조정은 원장에 INSERT 만 한다", () => {
    // UPDATE/DELETE 는 트리거가 막지만, 코드가 시도한다는 건 설계를 잘못 이해한 것이다.
    const r = route("post", "/api/superadmin/tenants/:id/credits");
    assert.match(r, /INSERT INTO credit_ledger/);
    assert.doesNotMatch(r, /UPDATE credit_ledger|DELETE FROM credit_ledger/);
  });

  it("잔액은 원장 합계로 다시 센다 — 캐시하지 않는다", () => {
    const r = route("post", "/api/superadmin/tenants/:id/credits");
    assert.match(r, /SUM\(delta\)/, "어긋난 잔액은 조용히 틀린 채로 굴러간다");
  });

  it("결제 로그가 실패·대기 건도 보여준다", () => {
    const r = route("get", "/api/superadmin/payments");
    assert.notEqual(r, "", "결제 로그 라우트를 찾지 못했다");
    // 성공분만 보여주면 "결제창까지 갔다가 안 된 건" 이 몇 건인지 알 수 없다.
    assert.doesNotMatch(r, /status\s*=\s*'paid'/, "성공한 결제만 거르면 안 된다");
    assert.match(r, /c\.req\.query\("tenant"\)/, "회사 필터가 없다");
  });

  it("크레딧 표는 RLS 대상이라 시스템 스코프로 읽는다", () => {
    for (const r of [
      route("get", "/api/superadmin/payments"),
      route("get", "/api/superadmin/tenants/:id/credits"),
      route("post", "/api/superadmin/tenants/:id/credits"),
    ]) {
      assert.match(r, /asSystem\(/, "rawPool 로 읽으면 0행이 나온다");
    }
  });
});

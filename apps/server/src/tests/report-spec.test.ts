/**
 * 리포트 **기간 해석**을 고정한다.
 *
 * 여기서 틀리면 보고서 전체가 조용히 틀린다 — 숫자는 정확히 집계되는데 **엉뚱한 기간**의
 * 숫자다. 표를 아무리 검산해도 안 걸린다. 그래서 기간을 정하는 함수만 따로 순수하게 뽑아
 * 두고 테스트가 여기를 본다.
 *
 * 모델이 준 값은 절대 그대로 안 쓴다. 모르는 종류·날짜 아닌 문자열·뒤집힌 기간·미래·너무
 * 긴 기간이 전부 여기서 눌러 담긴다 — **거절이 아니라 가장 가까운 말이 되는 값**으로.
 * 거절하면 사용자가 다시 쓰는 수밖에 없는데, 기간은 화면에 보이므로 고치는 게 더 빠르다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PERIOD_DAYS, kstDayEnd, kstDayStart, normalizeSpec, previousPeriod, thisMonth,
} from "../report/spec.ts";

/** 2026-09-03 12:00 KST. */
const NOW = new Date("2026-09-03T03:00:00Z");

describe("기간 계산", () => {
  it("KST 달력일의 시작·끝", () => {
    assert.equal(kstDayStart("2026-09-03"), Date.parse("2026-09-02T15:00:00Z"));
    assert.equal(kstDayEnd("2026-09-03"), Date.parse("2026-09-03T14:59:59.999Z"));
  });

  it("기본 기간은 이번 달 1일 ~ 오늘", () => {
    assert.deepEqual(thisMonth(NOW), { from: "2026-09-01", to: "2026-09-03" });
  });

  it("직전 기간은 **같은 일수**만큼 앞이다 — 달 길이가 제각각이라 '전월' 로 잡으면 어긋난다", () => {
    assert.deepEqual(previousPeriod({ from: "2026-08-01", to: "2026-08-31" }),
      { from: "2026-07-01", to: "2026-07-31" });
    assert.deepEqual(previousPeriod({ from: "2026-09-01", to: "2026-09-03" }),
      { from: "2026-08-29", to: "2026-08-31" });
  });
});

describe("스펙 정규화", () => {
  it("정상 입력은 그대로 통과한다", () => {
    const s = normalizeSpec(
      { kind: "channel-performance", from: "2026-08-01", to: "2026-08-31", title: "8월 성과" }, NOW);
    assert.equal(s.kind, "channel-performance");
    assert.equal(s.from, "2026-08-01");
    assert.equal(s.to, "2026-08-31");
    assert.equal(s.title, "8월 성과");
    assert.equal(s.compareToPrevious, true);
  });

  it("모르는 종류는 운영 실적으로 떨어진다", () => {
    assert.equal(normalizeSpec({ kind: "무엇인가" }, NOW).kind, "operations");
    assert.equal(normalizeSpec({}, NOW).kind, "operations");
  });

  it("날짜가 아니면 이번 달로 떨어진다", () => {
    const s = normalizeSpec({ from: "지난달", to: "" }, NOW);
    assert.deepEqual({ from: s.from, to: s.to }, thisMonth(NOW));
  });

  it("미래는 오늘까지로 잘린다 — 없는 날의 숫자를 뽑지 않는다", () => {
    assert.equal(normalizeSpec({ from: "2026-09-01", to: "2026-12-31" }, NOW).to, "2026-09-03");
  });

  it("뒤집힌 기간은 하루로 접힌다", () => {
    const s = normalizeSpec({ from: "2026-08-31", to: "2026-08-01" }, NOW);
    assert.equal(s.from, s.to);
  });

  it("지나치게 긴 기간은 상한으로 자른다", () => {
    const s = normalizeSpec({ from: "2020-01-01", to: "2026-09-03" }, NOW);
    const days = (kstDayStart(s.to) - kstDayStart(s.from)) / 86_400_000 + 1;
    assert.equal(days, MAX_PERIOD_DAYS);
  });

  it("제목이 없으면 종류와 기간으로 만든다 — 빈 제목의 보고서를 내보내지 않는다", () => {
    const s = normalizeSpec({ kind: "usage-cost", from: "2026-08-01", to: "2026-08-31" }, NOW);
    assert.equal(s.title, "사용량 보고 (2026-08-01 ~ 2026-08-31)");
  });

  it("compareToPrevious 는 명시적으로 false 일 때만 꺼진다", () => {
    assert.equal(normalizeSpec({ compareToPrevious: false }, NOW).compareToPrevious, false);
    assert.equal(normalizeSpec({ compareToPrevious: "아니오" }, NOW).compareToPrevious, true);
  });
});

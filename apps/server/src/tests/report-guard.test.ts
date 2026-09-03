/**
 * 리포트의 **방어선 세 개**가 실제로 도는지 — 모델을 부르지 않고 확인한다.
 *
 *  1. 지어낸 숫자를 잡는다.
 *  2. 평가 문장을 잡는다.
 *  3. 검산이 어긋나면 내보내지 못한다.
 *
 * 셋 다 순수 함수라 LLM 없이 검증된다. 이게 중요한 이유: 방어선을 모델 호출 안에 숨겨 두면
 * "정말 도는가"를 확인하려면 매번 돈을 써야 하고, 그러면 아무도 확인하지 않게 된다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVALUATIVE_WORDS, collectAllowedNumbers, evaluativeWords, fabricatedNumbers, numbersIn,
} from "../report/narrate.ts";
import { crosscheckFailures, toHtml, toMarkdown } from "../report/render.ts";
import type { ReportData } from "../report/aggregate.ts";

/** 손으로 계산한 픽스처 — 채널 둘, 합계 300. */
function fixture(overrides: Partial<ReportData> = {}): ReportData {
  return {
    kind: "channel-performance",
    title: "채널 성과 보고 (2026-08-01 ~ 2026-08-31)",
    period: { from: "2026-08-01", to: "2026-08-31", compare: { from: "2026-07-01", to: "2026-07-31" } },
    headline: [
      { label: "조회수", value: 300, unit: "회", delta: 50 },
      { label: "시청시간", value: 1200, unit: "분" },
    ],
    sections: [{
      title: "채널별",
      columns: ["채널", "조회수"],
      rows: [["가 채널", 200], ["나 채널", 100]],
      total: ["합계", 300],
    }],
    sources: [{ what: "유튜브 채널 지표", asOf: null }],
    crosscheck: [{ name: "채널별 합 = 헤드라인", expected: 300, actual: 300, ok: true }],
    empty: false,
    ...overrides,
  };
}

describe("숫자 가드", () => {
  const allowed = collectAllowedNumbers(fixture());

  it("본문에서 숫자를 뽑는다 — 천 단위 콤마·퍼센트 포함", () => {
    assert.deepEqual(numbersIn("조회수 1,200회 · 18% 증가"), [1200, 18]);
  });

  it("집계에 있는 값은 통과한다", () => {
    assert.deepEqual(fabricatedNumbers("조회수는 300회이고 가 채널이 200회입니다.", allowed), []);
  });

  it("직전 기간 대비 증감과 그 비율도 통과한다 — 우리가 미리 계산해 넣기 때문", () => {
    // 300 = 250 + 50 → 50 / 250 = 20.0%
    assert.deepEqual(fabricatedNumbers("직전 기간 대비 50회(20%) 늘었습니다.", allowed), []);
  });

  it("비중(%)도 통과한다", () => {
    // 200 / 300 = 66.7%
    assert.deepEqual(fabricatedNumbers("가 채널이 전체의 66.7%를 차지합니다.", allowed), []);
  });

  it("없는 숫자는 잡힌다 — 이게 이 파일의 존재 이유다", () => {
    assert.deepEqual(fabricatedNumbers("조회수가 4,321회였습니다.", allowed), [4321]);
  });

  it("기간의 연·월·일은 사실이라 통과한다", () => {
    assert.deepEqual(fabricatedNumbers("2026년 8월 1일부터 31일까지입니다.", allowed), []);
  });

  it("표가 커져도 허용 집합이 폭발하지 않는다", () => {
    const big = fixture({
      sections: [{
        title: "채널별",
        columns: ["채널", "조회수"],
        rows: Array.from({ length: 40 }, (_, i) => [`채널 ${i}`, i * 7]),
        total: ["합계", 40 * 39 / 2 * 7],
      }],
    });
    assert.ok(collectAllowedNumbers(big).size < 20_000, "허용 숫자 집합이 지나치게 커졌다");
  });
});

describe("평가 문장 검사", () => {
  it("사실 서술은 통과한다", () => {
    assert.deepEqual(evaluativeWords("조회수는 300회로 직전 기간보다 50회 늘었습니다."), []);
  });

  it("값매김은 잡힌다", () => {
    assert.ok(evaluativeWords("전반적으로 성공적이었습니다.").length > 0);
    assert.ok(evaluativeWords("구독 전환이 저조했습니다.").length > 0);
  });

  it("제품 용어를 금칙어로 삼지 않는다 — '성과' 는 화면 이름이다", () => {
    assert.deepEqual(evaluativeWords("성과 화면에서 채널별 지표를 볼 수 있습니다."), []);
    assert.ok(!EVALUATIVE_WORDS.includes("성과"));
  });
});

describe("검산", () => {
  it("맞으면 통과", () => {
    assert.deepEqual(crosscheckFailures(fixture()), []);
  });

  it("어긋나면 사유가 나온다 — 내보내기 라우트가 이걸로 막는다", () => {
    const bad = fixture({
      crosscheck: [{ name: "채널별 합 = 헤드라인", expected: 300, actual: 280, ok: false }],
    });
    const f = crosscheckFailures(bad);
    assert.equal(f.length, 1);
    assert.match(f[0], /기대 300 · 실제 280/);
  });
});

describe("산출물", () => {
  it("마크다운에 헤드라인·표·합계·기준일이 다 있다", () => {
    const md = toMarkdown(fixture(), "조회수는 300회입니다.");
    assert.match(md, /# 채널 성과 보고/);
    assert.match(md, /\| 조회수 .*\| 300회 \| \+50회 \|/);
    assert.match(md, /\| 가 채널 \| 200 \|/);
    assert.match(md, /\*\*합계\*\*/);
    assert.match(md, /데이터 기준 —/);
  });

  it("검산이 어긋난 문서는 본문에도 그 사실이 남는다", () => {
    const md = toMarkdown(fixture({
      crosscheck: [{ name: "합계", expected: 1, actual: 2, ok: false }],
    }), "");
    assert.match(md, /검산 불일치/);
  });

  it("HTML 은 바깥 자산을 하나도 안 부른다 — 메일·인쇄에서 같은 모양이어야 한다", () => {
    const html = toHtml(fixture(), "조회수는 300회입니다.");
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:\/\//, "외부 리소스를 참조하고 있다");
    assert.match(html, /<table>/);
  });

  it("HTML 이 값을 이스케이프한다", () => {
    const html = toHtml(fixture({ title: '<img src=x onerror="alert(1)">' }), "");
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
});

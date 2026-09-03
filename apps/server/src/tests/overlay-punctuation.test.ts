/**
 * **화면에 얹는 제목의 부호** — 고객 피드백(2026-09-03): *"오버레이되는 곳에 `,` `!` `.`
 * 넣지 말라 — AI 틱하다."*
 *
 * 사람이 만든 예능 자막은 짧은 문구에 종결 부호를 안 붙인다. 붙는 순간 문장처럼 보이고 그게
 * 기계가 쓴 티다. 그래서 **화면에 그리는 줄에서만** 턴다 — 유튜브 제목·설명은 그대로 둔다
 * (거긴 문장이 자연스럽고, 어그로 톤을 위해 일부러 부호를 쓰기로 한 자리다).
 *
 * 여기서 지키는 건 규칙 셋이다:
 *   ① `.` `,` `!` 를 뺀다
 *   ② **물음표는 남긴다** (피드백에 없고 뜻을 바꾼다)
 *   ③ **숫자 사이의 `.` `,` 는 살린다** — `3.5초`→`35초` 는 뜻이 달라진다
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { autoEditorState, cleanOverlayText } from "../pipeline/factory.ts";

describe("오버레이 제목 — 부호 털기", () => {
  it("마침표·쉼표·느낌표를 뺀다", () => {
    assert.equal(cleanOverlayText("경찰의 거짓말, 실종자 시신 발견 충격."), "경찰의 거짓말 실종자 시신 발견 충격");
    assert.equal(cleanOverlayText("이게 말이 됩니까!"), "이게 말이 됩니까");
    assert.equal(cleanOverlayText("충격, 반전!"), "충격 반전");
  });

  it("**물음표는 남긴다** — 피드백에 없고 뜻을 바꾼다", () => {
    assert.equal(cleanOverlayText("경찰의 거짓말?"), "경찰의 거짓말?");
    assert.equal(cleanOverlayText("등급이요? B예요."), "등급이요? B예요");
  });

  it("**숫자 사이 부호는 살린다** — 3.5초가 35초가 되면 뜻이 달라진다", () => {
    assert.equal(cleanOverlayText("3.5초 만에 끝났다."), "3.5초 만에 끝났다");
    assert.equal(cleanOverlayText("구독자 1,000명 돌파!"), "구독자 1,000명 돌파");
    assert.equal(cleanOverlayText("21조 원 폭증, 빚투까지"), "21조 원 폭증 빚투까지");
  });

  it("끝에 붙은 부호는 숫자 뒤라도 뺀다 — 그건 소수점이 아니라 종결 부호다", () => {
    assert.equal(cleanOverlayText("총점은 13."), "총점은 13");
    assert.equal(cleanOverlayText("정답은 2026,"), "정답은 2026");
  });

  it("빈 자리·공백을 정리한다 — 부호를 빼고 남은 두 칸이 화면에서 보인다", () => {
    assert.equal(cleanOverlayText("충격 ,  반전"), "충격 반전");
    assert.equal(cleanOverlayText("  ...  "), "");
    assert.equal(cleanOverlayText(undefined as unknown as string), "");
  });

  it("중간점·물결·말줄임은 건드리지 않는다 — 피드백 범위 밖이다", () => {
    assert.equal(cleanOverlayText("한동훈 · 경찰청장"), "한동훈 · 경찰청장");
    assert.equal(cleanOverlayText("설마~"), "설마~");
    assert.equal(cleanOverlayText("그래서…"), "그래서…");
  });
});

describe("오버레이 제목 — 실제 화면 줄에 적용된다", () => {
  const es = (rec: Record<string, unknown>) =>
    autoEditorState({ kind: "short", ...rec }, "프로그램", undefined) as any;

  it("두 줄 제목에서 턴다", () => {
    const lines = es({ titleLine1: "경찰의 거짓말,", titleLine2: "실종자 시신 발견 충격!" }).titleLines;
    assert.deepEqual(lines.map((l: any) => l.text), ["경찰의 거짓말", "실종자 시신 발견 충격"]);
  });

  it("훅 치환 경로에서도 턴다", () => {
    const lines = es({ hookQuote: '"지금은 다 지워졌죠?"', titleLine1: "안 쓰임" }).titleLines;
    assert.equal(lines[0].text, "지금은 다 지워졌죠?");
  });

  it("한 줄(title 폴백) 경로에서도 턴다", () => {
    const lines = es({ title: "총점 13점, B등급 충격." }).titleLines;
    assert.ok(lines.length > 0);
    assert.ok(!lines.some((l: any) => /[.,!]/.test(String(l.text).replace(/\d[.,]\d/g, ""))),
      `부호가 남았다: ${JSON.stringify(lines.map((l: any) => l.text))}`);
  });

  it("**부호를 턴 뒤에 줄을 접는다** — 먼저 접으면 부호까지 세어 엉뚱하게 갈린다", () => {
    // 부호 포함 15자 / 제외 12자. 부호를 먼저 털면 한 줄로 남아야 한다(wrapAutoTitle 기준 14자).
    const lines = es({ title: "아, 이게 진짜 말이 돼!" }).titleLines;
    assert.equal(lines.length, 1, `두 줄로 갈렸다: ${JSON.stringify(lines.map((l: any) => l.text))}`);
  });
});

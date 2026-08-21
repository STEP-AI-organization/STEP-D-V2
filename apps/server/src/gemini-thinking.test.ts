/**
 * Gemini 2.5+ thinking 예산 함정 고정 (2026-08-20).
 *
 * 2.5 부터 **추론(thinking) 토큰이 maxOutputTokens 안에서 소비된다.** 예산이 작으면 추론이
 * 그걸 다 먹고 본문 파트가 **빈 채로** 돌아온다 — 예외도 안 나고 `text` 가 "" 다. 그래서
 * 증상이 호출부마다 다르게 나타난다:
 *   · 제목 재생성(1024) → 후보 0개 → 화면에 "no titles generated"
 *   · 훅 재선정(256)    → parseJsonLoose("") 가 {} → idx 0 → **오류 없이 늘 첫 대사 선택**
 * 두 번째가 더 나쁘다(조용한 오답).
 *
 * core 는 같은 함정을 이미 겪고 schema JSON 호출의 thinking 을 껐다(beat_annot.py:441).
 * 서버도 같은 규칙을 쓴다 — **구조화 출력이면 기본 끔**, 산문은 종전대로.
 * 순수 함수로 증명 안 되는 배선 불변식이라 소스 스캔이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const GEMINI = fs.readFileSync(path.join(SRC, "gemini.ts"), "utf-8");
const INDEX = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

describe("thinking 예산 — 구조화 출력 호출은 추론을 끈다", () => {
  it("geminiGenerate 가 schema 호출에서 thinkingBudget=0 을 보낸다", () => {
    assert.match(GEMINI, /thinkingConfig = \{ thinkingBudget: 0 \}/,
      "thinkingConfig 를 안 보내면 예산 작은 호출이 빈 응답으로 돌아온다");
    assert.match(GEMINI, /const thinkingOn = opts\.thinking \?\? !\(opts\.schema && !opts\.tools\)/,
      "기본 규칙이 바뀌었다 — schema(구조화 출력)면 끄고, 산문이면 켠 채로 둬야 한다");
  });

  it("산문 생성은 끄지 않는다 (opts.thinking 으로 되돌릴 수 있다)", () => {
    // 전부 끄면 추론이 결과를 좌우하는 호출의 품질이 조용히 내려간다 — 되돌릴 손잡이를 남긴다.
    assert.match(GEMINI, /thinking\?: boolean/, "thinking 옵션이 없으면 예외 호출을 못 만든다");
  });

  it("빈 응답의 원인을 남긴다 (finishReason)", () => {
    // 이유 없이 "" 만 돌려주면 호출부가 '모델이 안 만들었다' 로 오해한다 — MAX_TOKENS 인지 갈려야 한다.
    assert.match(GEMINI, /finishReason\?: string/, "GeminiResult 에 finishReason 이 없다");
    assert.match(GEMINI, /\[gemini\] 빈 응답 — finishReason=/, "빈 응답 경고 로그가 없다");
  });

  it("schema 없이 JSON 을 뽑는 호출부는 thinking:false 를 명시한다", () => {
    // schema 가 없으면 위 기본 규칙이 안 걸린다 — 호출부가 직접 꺼야 한다.
    const jsonNoSchema = INDEX.match(/geminiGenerate\(prompt, \{ temperature: [\d.]+, maxOutputTokens: \d+[^}]*\}\)/g) ?? [];
    assert.ok(jsonNoSchema.length >= 2, "대상 호출부를 못 찾았다 — 정규식이 낡았는지 확인");
    for (const call of jsonNoSchema) {
      assert.match(call, /thinking: false/,
        `schema 없는 호출에 thinking:false 가 없다 — 빈 응답이 조용한 오답이 된다: ${call.slice(0, 90)}`);
    }
  });

  it("훅 재선정은 빈 응답을 오답으로 삼키지 않는다", () => {
    // parseJsonLoose("") 는 {} 를 돌려주고 idx 가 0 으로 떨어진다 — 늘 첫 대사가 훅이 된다.
    assert.match(INDEX, /if \(!res\.text\.trim\(\)\) \{[\s\S]{0,200}?error: "empty_response"/,
      "빈 응답을 막지 않으면 오류 없이 항상 첫 대사를 고른다");
  });
});

describe("실패 응답은 사람이 읽을 문장을 준다", () => {
  // 웹 json() 은 message → nested.message → error 순으로 폴백한다(api.ts). message 를 빼면
  // error 코드가 그대로 화면에 뜬다 — 사용자가 "no titles generated" 를 봤다(2026-08-20).
  it("제목 재생성의 실패 경로 4개가 모두 message 를 담는다", () => {
    for (const code of ["no_titles_generated", "generation_failed", "no_captions", "invalid_segment"]) {
      const re = new RegExp(`error: "${code}",\\s*\\n(?:\\s*//[^\\n]*\\n)*\\s*message:`);
      assert.match(INDEX, re, `${code} 응답에 사람용 message 가 없다 — 영어 코드가 화면에 뜬다`);
    }
  });
});

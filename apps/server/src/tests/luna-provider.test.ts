/**
 * GPT-5.6 Luna 실험 (2026-09-16) — 메타데이터 생성의 OpenAI 게이트 + 유튜브체 톤.
 *
 * 게이트는 upload-gate 와 같은 실패 방향이어야 한다: **미설정·오타·빈값·반쪽 설정 = OFF**
 * (= Gemini 유지). 잘못된 env 의 실패 모드가 "Luna 로 안 감"이지 "라우트가 죽음"이면 안 된다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { openaiMetadataModel } from "../ai/openai.ts";
import { buildMetadataPrompt, clip } from "../pipeline/clip-metadata.ts";

describe("openaiMetadataModel — env 게이트", () => {
  const saved = {
    model: process.env.OPENAI_METADATA_MODEL,
    key: process.env.OPENAI_API_KEY,
  };
  afterEach(() => {
    if (saved.model === undefined) delete process.env.OPENAI_METADATA_MODEL;
    else process.env.OPENAI_METADATA_MODEL = saved.model;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
  });

  it("미설정 = OFF (Gemini 유지)", () => {
    delete process.env.OPENAI_METADATA_MODEL;
    delete process.env.OPENAI_API_KEY;
    assert.equal(openaiMetadataModel(), null);
  });

  it("모델명만 있고 키가 없으면 OFF — 반쪽 설정으로 라우트가 죽으면 안 된다", () => {
    process.env.OPENAI_METADATA_MODEL = "gpt-5.6-luna";
    delete process.env.OPENAI_API_KEY;
    assert.equal(openaiMetadataModel(), null);
  });

  it("키만 있고 모델명이 없으면 OFF — 키 존재가 스위치가 아니다(썸네일도 같은 키를 쓴다)", () => {
    delete process.env.OPENAI_METADATA_MODEL;
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(openaiMetadataModel(), null);
  });

  it("빈값·공백은 OFF", () => {
    process.env.OPENAI_METADATA_MODEL = "   ";
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(openaiMetadataModel(), null);
  });

  it("둘 다 있어야 ON — 모델명을 그대로 돌려준다", () => {
    process.env.OPENAI_METADATA_MODEL = "gpt-5.6-luna";
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(openaiMetadataModel(), "gpt-5.6-luna");
  });
});

describe("메타 프롬프트 톤 — 유튜브체 (사용자 2026-09-16)", () => {
  it("유튜브체·이모지 지시가 들어간다 — 진지한 내용분석체 방지", () => {
    const p = buildMetadataPrompt({ program: "전참시" });
    assert.match(p, /유튜브 감성/, "역할이 보고서 문체를 금지하지 않는다");
    assert.match(p, /이모지를 쓴다/, "이모지 지시가 빠졌다");
    assert.match(p, /\[톤 — 유튜브체\]/, "톤 블록 자체가 없다");
  });

  it("톤을 바꿔도 사실 규칙은 그대로다 — 날조 금지와 문체는 별개 축", () => {
    const p = buildMetadataPrompt({ program: "전참시" });
    assert.match(p, /사실을 만들지 마라/, "절대 규칙이 사라졌다");
    assert.match(p, /사실 날조 금지는 그대로다/, "톤 블록이 절대 규칙과의 관계를 명시하지 않는다");
  });
});

describe("clip — 이모지(서로게이트 페어) 안전 자르기", () => {
  it("이모지 한가운데에서 잘리면 반쪽을 남기지 않고 한 칸 물린다", () => {
    // "a"×10 + 😂(2유닛). max=11 이면 slice 가 😂 의 고위 서로게이트에서 끊긴다.
    const cut = clip("a".repeat(10) + "😂 뒷내용", 11);
    assert.equal(cut, "a".repeat(10), "깨진 반쪽 문자가 제목에 남았다");
    // 어떤 입력에서도 짝 없는 서로게이트가 끝에 남으면 안 된다.
    assert.doesNotMatch(cut, /[\uD800-\uDBFF]$/);
  });

  it("이모지가 안 걸리면 종전과 같다", () => {
    assert.equal(clip("짧은 제목", 100), "짧은 제목");
    // 상한 안에서 끝나는 자르기는 그대로.
    assert.equal(clip("가나다라 마바사아 자차카타", 9), "가나다라 마바사아");
    // 단어 한가운데서 끊기면 마지막 공백까지 물린다 (sp > max*0.6 경로).
    assert.equal(clip("가나다라마바 사아", 8), "가나다라마바", "단어 경계 자르기가 깨졌다");
  });
});

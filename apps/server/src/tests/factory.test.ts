/**
 * 콘텐츠 공장 — 스위치·상한 불변식 고정.
 *
 * FLOWS F6 은 "자동 배포는 게이트를 건너뛰지 않는다"와 "규칙이 없으면 아무것도 하지 않는다"를
 * 요구한다. 그 본체(게이트 연동)는 F3 을 세운 뒤에 붙지만, **켜지는 조건과 상한**은 지금
 * 고정해 둘 수 있다. 자동 배포에서 가장 비싼 사고는 "의도치 않게 켜져 있었다"이기 때문이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { autoEditorState, dailyCap, FACTORY_DEFAULTS, mediaNeedsPreparation, publicizeDelayMs } from "../pipeline/factory.ts";

describe("공장은 env 로 켜지 않는다", () => {
  // 2026-09-07: FACTORY_ENABLED 를 없앴다. API 키가 이미 같은 일을 하고(키 없으면 503)
  // 실업로드는 upload-gate 가 막으므로 중복이었다 — 켜야 할 env 가 많을수록
  // "하나만 켜서 안 도는" 실패가 늘어난다. env 는 시크릿·인프라 위치에만 쓴다.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "pipeline", "factory.ts"), "utf-8");

  it("factory.ts 가 제품 동작을 env 에서 읽지 않는다", () => {
    assert.doesNotMatch(src, /process\.env\.FACTORY_/,
      "공장 동작이 다시 env 로 갔다 — 하루 상한·유예는 FACTORY_DEFAULTS·policy 가 정본이다");
  });

  it("라우트에도 킬 스위치가 남아 있지 않다", () => {
    const index = fs.readFileSync(
      path.join(import.meta.dirname, "..", "index.ts"), "utf-8");
    assert.doesNotMatch(index, /factoryEnabled\(\)|FACTORY_ENABLED/);
    // 대신 **워크스페이스 API 키 스코프**가 방어선이다(구 x-factory-key 를 대체했다).
    const keys = fs.readFileSync(
      path.join(import.meta.dirname, "..", "auth", "api-keys.ts"), "utf-8");
    assert.ok(
      keys.includes('/^\\/api\\/factory\\/ingest$/, scope: "factory:write"'),
      "ingest 가 API 키 스코프를 안 요구하면 킬 스위치를 없앤 만큼 구멍이 된다");
  });
});

describe("무편집 렌더 기본 프리셋", () => {
  it("쇼츠 제목 1·2줄은 출력 기준 106px·107px이고 채널은 세로 82%다", () => {
    const state = autoEditorState({
      kind: "short",
      titleLine1: "첫 번째 제목",
      titleLine2: "두 번째 제목",
    }, "STEP-D") as any;
    assert.equal(state.titleLines[0].size * 3, 106);
    assert.equal(state.titleLines[1].size * 3, 107);
    assert.equal(state.channelY, 82);
  });

  it("자동배포가 가로형을 골라도 제목 출력 크기는 106px·107px로 유지된다", () => {
    const state = autoEditorState({
      kind: "short",
      titleLine1: "첫 번째 제목",
      titleLine2: "두 번째 제목",
    }, "STEP-D", undefined, undefined, undefined, "16:9") as any;
    const scale = 1080 / ((900 * 1080) / 1920);
    assert.equal(state.aspect, "16:9");
    assert.equal(state.titleLines[0].size * scale, 106);
    assert.equal(state.titleLines[1].size * scale, 107);
    assert.equal(state.channelY, 82);
  });

  it("규칙이 고른 템플릿은 시드 표에 없어도 버리지 않는다 — 새 캔바 템플릿이 조용히 무시되던 구멍", () => {
    // 렌더는 editorState.templateId 로 자산 디렉토리를 직접 찾는다. 시드(색·위치)만 표준으로
    // 폴백하면 되고, 사용자가 고른 이름 자체가 살아야 "넣은 템플릿이 나온다"(2026-08-25 점검).
    const state = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", undefined, "canva-new-template") as any;
    assert.equal(state.templateId, "canva-new-template");
    assert.equal(state.channelY, 82); // 위치 시드는 broadcast-standard 폴백
  });

  it("강제 지정이 없으면 프로그램 기본 → 장르 자동 순서다", () => {
    const state = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", { autoPublish: { templateId: "broadcast-drama" } }) as any;
    assert.equal(state.templateId, "broadcast-drama");
    const auto = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", { pipelineGenre: "drama" }) as any;
    assert.equal(auto.templateId, "broadcast-drama");
  });
});

describe("일일 상한 — policy 가 정본", () => {
  it("policy 없으면 기본값", () => {
    assert.equal(dailyCap(), FACTORY_DEFAULTS.dailyCap);
    assert.equal(dailyCap({}), FACTORY_DEFAULTS.dailyCap);
  });

  it("policy 숫자를 그대로 쓴다", () => {
    assert.equal(dailyCap({ dailyCap: 12 }), 12);
  });

  it("0·음수·비숫자는 기본값으로 되돌린다 — 상한 없음으로 해석되면 안 된다", () => {
    // "0" 을 '무제한'으로 읽는 순간 사고가 무한히 커진다.
    for (const v of [0, -1, NaN, "abc", null, undefined]) {
      assert.equal(dailyCap({ dailyCap: v as never }), FACTORY_DEFAULTS.dailyCap,
        `${JSON.stringify(v)} 는 기본값이어야 한다`);
    }
  });
});

describe("공개 전환 유예 — policy 가 정본", () => {
  it("policy 없으면 10분", () => {
    assert.equal(publicizeDelayMs(), FACTORY_DEFAULTS.publicizeDelayMin * 60_000);
    assert.equal(publicizeDelayMs({}), FACTORY_DEFAULTS.publicizeDelayMin * 60_000);
  });

  it("0 은 허용한다 — '유예 없음'은 의도할 수 있는 선택이다", () => {
    assert.equal(publicizeDelayMs({ publicizeDelayMin: 0 }), 0);
  });

  it("음수·비숫자는 기본값으로 — 과거 시각으로 즉시 공개되는 일이 없어야 한다", () => {
    for (const v of [-5, NaN, "abc", null]) {
      assert.equal(publicizeDelayMs({ publicizeDelayMin: v as never }),
        FACTORY_DEFAULTS.publicizeDelayMin * 60_000, `${JSON.stringify(v)} 는 기본값`);
    }
  });
});

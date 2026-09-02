/**
 * 계획의 세로 배치 목록(RULE_ASPECTS)이 편집기 프리셋과 갈라지지 않는지 지킨다.
 *
 * `pipeline/automation.ts` 는 **import 0개짜리 순수 모듈**이라(웹이 `@server-pure/…` 로
 * 그대로 가져간다) 프리셋을 직접 들여와 파생시킬 수 없다. 그래서 값을 손으로 적었고,
 * 그 대가로 이 대조를 둔다 — 프리셋에 세로가 하나 늘었는데 계획 목록에 안 적으면
 * "편집기엔 있는데 자동배포에선 못 고르는 배치"가 조용히 생긴다.
 *
 * aspect-parity.test.ts(웹↔서버 미러 대조)와 짝이다: 저건 두 미러가 같은지, 이건
 * 그 미러의 세로 부분집합과 계획 목록이 같은지 본다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ASPECT_PRESETS, isPortraitAspect } from "../media/aspect-presets.ts";
import { RULE_ASPECTS, isRuleAspect } from "../pipeline/automation.ts";

test("RULE_ASPECTS = 프리셋의 세로 전부 (순서까지)", () => {
  const portrait = ASPECT_PRESETS.filter((p) => isPortraitAspect(p.id)).map((p) => p.id);
  assert.deepEqual([...RULE_ASPECTS], portrait);
});

test("가로(16:9)는 계획 배치로 받지 않는다", () => {
  // orientation 이 이미 가로/세로를 정한다. 여기서도 받으면 두 필드가 다른 말을 한다.
  assert.equal(isRuleAspect("16:9"), false);
  assert.equal(RULE_ASPECTS.includes("16:9" as never), false);
});

test("isRuleAspect — 알 수 없는 값·타입은 거른다", () => {
  assert.equal(isRuleAspect("9:16-letterbox"), true);
  assert.equal(isRuleAspect("9:16-crop-sub"), true);
  // 구형 bare 값. normalizeAspectPreset 이 접어 주는 값이지만 계획에는 그대로 저장하지 않는다.
  assert.equal(isRuleAspect("9:16"), false);
  assert.equal(isRuleAspect("9:16-crop"), false);
  assert.equal(isRuleAspect(""), false);
  assert.equal(isRuleAspect(null), false);
  assert.equal(isRuleAspect(undefined), false);
  assert.equal(isRuleAspect(0), false);
});

test("모든 계획 배치는 프리셋에서 실제로 찾을 수 있다", () => {
  // 오타 하나면 렌더가 프리셋을 못 찾아 기본으로 조용히 떨어진다.
  for (const id of RULE_ASPECTS) {
    assert.ok(ASPECT_PRESETS.some((p) => p.id === id), `프리셋에 없는 배치: ${id}`);
  }
});

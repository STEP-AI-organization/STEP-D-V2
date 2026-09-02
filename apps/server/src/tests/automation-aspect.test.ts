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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, test } from "node:test";

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

/**
 * **저장까지 이어지는가** (2026-09-02 실측 사고).
 *
 * 배치 고르기(71806ef)와 렌더 배선(e8b441a)이 들어간 뒤에도 **DB 컬럼도 INSERT/SELECT 도
 * 없어서** 화면에서 고른 값이 저장 단계에서 조용히 버려지고 있었다. 라우트는 통과하고
 * 화면도 바뀌는데 결과물만 그대로 — 이 리포 최빈 실패모드(생산·저장·소비 3단 중 저장 누락)다.
 * 마이그레이션 0049 로 잇고, 그 고리를 여기서 고정한다.
 */
describe("배치가 DB 까지 간다 — 화면만 바뀌고 끝나지 않게", () => {
  const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rd = (p: string) => fs.readFileSync(path.resolve(SRC_DIR, p), "utf-8");
  const db = rd("db-pg.ts");

  it("SELECT 가 aspect 를 읽는다 — 안 읽으면 항상 undefined 다", () => {
    const sel = /const RULE_SEL = `([\s\S]*?)`;/.exec(db);
    assert.ok(sel, "RULE_SEL 을 못 찾았다");
    assert.match(sel![1], /\baspect\b/, "조회에 aspect 가 없으면 저장돼 있어도 못 읽는다");
  });

  it("INSERT · UPDATE 둘 다 aspect 를 쓴다 — 하나만 있으면 수정이 안 먹는다", () => {
    const ins = db.slice(db.indexOf("INSERT INTO automation_rule"));
    assert.match(ins.slice(0, 1200), /weekdays, slots, aspect\)/, "INSERT 컬럼에 aspect 가 없다");
    const upd = db.slice(db.indexOf("UPDATE automation_rule SET"));
    assert.match(upd.slice(0, 900), /aspect = \$\d+/, "UPDATE 에 aspect 가 없다");
    // 값 바인딩이 빠지면 컬럼만 늘고 항상 null 이 들어간다.
    assert.equal((db.match(/r\.aspect \?\? null/g) ?? []).length, 2,
      "INSERT·UPDATE 각각의 값 바인딩이 필요하다");
  });

  it("마이그레이션이 컬럼을 만든다 · 기본값을 박지 않는다", () => {
    const mig = fs.readFileSync(path.resolve(SRC_DIR, "../migrations/0049_rule-aspect.cjs"), "utf-8");
    assert.match(mig, /ADD COLUMN IF NOT EXISTS aspect TEXT;/);
    // ⚠️ 주석이 아니라 **up 의 SQL 만** 본다 — 설명에 SHORTS_DEFAULT_ASPECT 같은 낱말이
    //    들어가는 것과 컬럼에 기본값을 박는 것은 전혀 다른 일이다.
    const upSql = /exports\.up[\s\S]*?pgm\.sql\(`([\s\S]*?)`\)/.exec(mig);
    assert.ok(upSql, "up 의 SQL 을 못 찾았다");
    assert.doesNotMatch(upSql![1], /DEFAULT/i,
      "기본값을 박으면 옛 계획 전부가 배치를 '명시한' 것이 되어 렌더 경로가 바뀐다(무회귀 위반)");
    assert.doesNotMatch(upSql![1], /NOT NULL/i, "NULL 이 '미지정' 을 뜻한다");
  });

  it("순방은 명시된 계획에만 videoAspect 를 싣는다 — 무회귀 조건", () => {
    const cycle = rd("pipeline/automation-cycle.ts");
    assert.match(cycle, /\.\.\.\(rule\.aspect \? \{ videoAspect: rule\.aspect \} : \{\}\)/,
      "미지정 계획에 기본값을 실으면 이미 돌던 계획의 결과물이 조용히 바뀐다");
  });
});

/**
 * 자동 배포 불변식 고정 (FLOWS F6) — 사용자가 F3 과 함께 "서버 테스트로 막으라"고 지목한 것.
 *
 * 두 문장이 전부다 (FLOWS.md:142):
 *  - 자동 배포는 게이트를 건너뛰지 않는다. 보류된 건은 **사람이 확정해야** 다시 잡힌다.
 *  - 규칙이 없으면 파이프라인은 아무것도 하지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  decidePublish,
  initialRuleState,
  isGatePolicy,
  isRuleCriterion,
  isRuleMediaKind,
  planCycle,
  ruleCreatedNotice,
  selectCandidates,
  type AutomationRule,
  type GateSnapshot,
} from "./automation.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: "r1",
  programId: "p1",
  platform: "youtube",
  accountId: "c1",
  mediaKind: "both",
  criterion: "score80",
  gatePolicy: "hold_on_issue",
  window: "수시",
  enabled: true,
  ...over,
});

const PASS: GateSnapshot = { allowed: true, state: "pass", reason: "" };
const HOLD: GateSnapshot = { allowed: false, state: "rights_hold", reason: "미해결 권리 이슈 2건" };

describe("자동 배포는 게이트를 건너뛰지 않는다 (F6 Invariant)", () => {
  it("게이트 미통과면 어떤 정책에서도 나가지 않는다", () => {
    for (const gatePolicy of ["approve_first", "hold_on_issue"] as const) {
      const d = decidePublish({
        rule: rule({ gatePolicy }),
        gate: HOLD,
        approved: true,          // 사람이 승인해도
        heldAwaitingHuman: false,
      });
      assert.equal(d.action, "hold", gatePolicy);
    }
  });

  it("사람 승인이 게이트를 이기지 못한다", () => {
    // 승인은 게이트 **위에** 얹히는 조건이지 게이트를 대신하지 않는다.
    const d = decidePublish({ rule: rule({ gatePolicy: "approve_first" }), gate: HOLD, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "hold");
    assert.match(d.reason, /권리/);
  });

  it("막힌 결정에는 사유가 있다", () => {
    const d = decidePublish({ rule: rule(), gate: HOLD, approved: false, heldAwaitingHuman: false });
    assert.notEqual(d.reason, "");
  });
});

describe("보류된 건은 사람이 확정해야 다시 잡힌다 (F6 Invariant)", () => {
  it("게이트가 열려도 보류 상태면 그대로 보류다", () => {
    // 이게 핵심이다. 이슈를 해제하면 게이트는 열리지만, 그것만으로 자동이 다시 밀어내면
    // "사람이 확정한다"는 약속이 깨진다.
    const d = decidePublish({ rule: rule(), gate: PASS, approved: true, heldAwaitingHuman: true });
    assert.equal(d.action, "hold");
    assert.equal(d.needsHuman, true);
  });

  it("사람이 확정하면(heldAwaitingHuman=false) 나간다", () => {
    const d = decidePublish({ rule: rule(), gate: PASS, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "publish");
  });
});

describe("승인 배선 — automation-cycle 소스 스캔", () => {
  /**
   * decidePublish 의 approve_first 는 순수 함수라 옳아도, 호출부가 `approved: !held` 로
   * 배선하면 **보류된 적 없는 새 클립이 전부 자동 승인**되어 정책이 무력화된다.
   * 승인의 근거는 사람이 보류를 해제한 기록(released_at)이어야 한다.
   */
  it("automation-cycle 는 approved 에 released 기반 값을 넘긴다 (!held 금지)", () => {
    const src = fs.readFileSync(path.join(SRC, "automation-cycle.ts"), "utf-8");
    assert.match(src, /hasReleasedHold\(/,
      "automation-cycle 이 보류 해제 기록(hasReleasedHold)을 읽지 않는다");
    assert.doesNotMatch(src, /approved:\s*!\s*held/,
      "`approved: !held` 는 보류된 적 없는 새 클립을 자동 승인한다 — approve_first 무력화");
  });
});

describe("승인 정책", () => {
  it("approve_first 는 승인 없이 안 나간다", () => {
    const d = decidePublish({ rule: rule({ gatePolicy: "approve_first" }), gate: PASS, approved: false, heldAwaitingHuman: false });
    assert.equal(d.action, "hold");
    assert.equal(d.needsHuman, true);
  });

  it("hold_on_issue 는 게이트만 통과하면 나간다", () => {
    const d = decidePublish({ rule: rule({ gatePolicy: "hold_on_issue" }), gate: PASS, approved: false, heldAwaitingHuman: false });
    assert.equal(d.action, "publish");
  });

  it("멈춘 규칙은 아무것도 안 한다", () => {
    const d = decidePublish({ rule: rule({ enabled: false }), gate: PASS, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "skip");
  });
});

describe("규칙이 없으면 아무것도 하지 않는다 (F6 Invariant)", () => {
  it("빈 규칙 목록을 '전체 대상'으로 해석하지 않는다", () => {
    // 이 실수 한 번이면 손대지 않은 프로그램들이 배포된다.
    const p = planCycle({ paused: false, rules: [] });
    assert.deepEqual(p.rules, []);
    assert.notEqual(p.idleReason, "");
  });

  it("규칙이 전부 꺼져 있어도 아무것도 안 한다", () => {
    const p = planCycle({ paused: false, rules: [rule({ enabled: false })] });
    assert.deepEqual(p.rules, []);
  });

  it("일시정지는 새 회차를 잡지 않는 것이다", () => {
    const p = planCycle({ paused: true, rules: [rule()] });
    assert.deepEqual(p.rules, []);
    assert.match(p.idleReason, /일시정지/);
  });

  it("실행 중 규칙만 평가한다", () => {
    const p = planCycle({ paused: false, rules: [rule({ id: "a" }), rule({ id: "b", enabled: false })] });
    assert.deepEqual(p.rules.map((r) => r.id), ["a"]);
  });
});

describe("채택 기준 (F6 03단계)", () => {
  const cands = [
    { id: "a", kind: "short", score100: 92 },
    { id: "b", kind: "short", score100: 81 },
    { id: "c", kind: "clip", score100: 88 },
    { id: "d", kind: "short", score100: 60 },
    { id: "e", kind: "short" },                              // 점수 없음
    { id: "f", kind: "short", score100: 99, status: "rejected" }, // 사람이 거절함
  ];

  it("점수 하한을 넘는 것만", () => {
    assert.deepEqual(selectCandidates(rule({ criterion: "score85" }), cands).map((c) => c.id), ["a", "c"]);
  });

  it("점수가 없으면 기준을 만족한다고 보지 않는다", () => {
    // 모르면 안 내보낸다.
    assert.equal(selectCandidates(rule({ criterion: "score80" }), cands).some((c) => c.id === "e"), false);
  });

  it("상위 3건에서도 점수 없는 후보는 뺀다", () => {
    // 0점으로 치면 아무거나 상위에 올라온다.
    const got = selectCandidates(rule({ criterion: "top3" }), cands).map((c) => c.id);
    assert.deepEqual(got, ["a", "c", "b"]);
  });

  it("사람이 이미 판단한 것은 다시 잡지 않는다", () => {
    // 사람이 거절한 걸 자동이 되살리면 안 된다.
    for (const criterion of ["score80", "score85", "top3"] as const) {
      assert.equal(selectCandidates(rule({ criterion }), cands).some((c) => c.id === "f"), false, criterion);
    }
  });

  it("미디어 종류로 거른다", () => {
    assert.deepEqual(selectCandidates(rule({ mediaKind: "clip", criterion: "score80" }), cands).map((c) => c.id), ["c"]);
    assert.deepEqual(
      selectCandidates(rule({ mediaKind: "short", criterion: "score80" }), cands).map((c) => c.id),
      ["a", "b"],
    );
  });
});

describe("규칙 생성 분기 (F6)", () => {
  it("YouTube 만 실행 중, 나머지는 기록만", () => {
    assert.equal(initialRuleState("youtube"), "running");
    for (const p of ["instagram", "facebook", "tiktok"]) {
      assert.equal(initialRuleState(p), "record_only", p);
    }
  });

  it("기록만 하는 채널은 생성 문구가 그 사실을 말한다", () => {
    assert.match(ruleCreatedNotice("tiktok"), /기록만/);
    assert.match(ruleCreatedNotice("tiktok"), /직접/);
  });
});

describe("입력 검증", () => {
  it("모르는 값을 통과시키지 않는다", () => {
    assert.equal(isRuleMediaKind("both"), true);
    assert.equal(isRuleMediaKind("all"), false);
    assert.equal(isRuleCriterion("score80"), true);
    assert.equal(isRuleCriterion("score70"), false);
    assert.equal(isGatePolicy("approve_first"), true);
    assert.equal(isGatePolicy("skip_gate"), false);
  });

  it("게이트를 끄는 정책값이 존재하지 않는다", () => {
    // 정책 목록에 'skip'/'ignore' 류가 생기면 F6 Invariant 가 무너진다.
    const src = fs.readFileSync(path.join(SRC, "automation.ts"), "utf-8");
    const list = /GATE_POLICIES = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    assert.doesNotMatch(list, /skip|ignore|bypass|off|none/i, `게이트 우회 정책이 생겼다: ${list}`);
  });
});

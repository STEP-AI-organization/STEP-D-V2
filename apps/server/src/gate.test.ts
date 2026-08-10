/**
 * 게이트 불변식 고정 (FLOWS F3) — 이 제품에서 가장 중요한 테스트 파일.
 *
 * "게이트를 통과하지 않은 미디어는 **어떤 경로로도** 게시되지 않는다"(FLOWS.md:73).
 * 그 판정 자체가 여기서 고정된다. 강제 지점 4곳을 관문 하나로 모으는 건 S2 이고,
 * 관문이 옳게 판정하는지는 이 파일이 책임진다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canResolve,
  evaluateGate,
  exclusionNotice,
  inheritedIssues,
  isIssueKind,
  isResolution,
  overlaps,
  screenBatch,
  type Issue,
} from "./gate.ts";

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i1",
  kind: "music",
  resolution: "open",
  ...over,
});

describe("미판정 ≠ 이슈 없음 (F2 Invariant · FLOWS.md:51)", () => {
  it("아무도 안 본 미디어는 검수 대기지 통과가 아니다", () => {
    const g = evaluateGate({ judged: false, issues: [] });
    assert.equal(g.state, "review_pending");
    assert.equal(g.allowed, false);
  });

  it("'이슈 없음' 판정이 있어야 통과한다", () => {
    const g = evaluateGate({ judged: true, issues: [] });
    assert.equal(g.state, "pass");
    assert.equal(g.allowed, true);
  });

  it("이슈를 등록한 것 자체가 사람의 판단이다", () => {
    // 이슈를 달았다가 전부 해제한 미디어는 검수 대기로 되돌아가지 않는다.
    const g = evaluateGate({ judged: false, issues: [issue({ resolution: "resolved" })] });
    assert.equal(g.state, "pass");
  });
});

describe("게이트 상태 우선순위 — 가장 나쁜 것이 이긴다", () => {
  it("차단이 다른 모든 것을 이긴다", () => {
    const g = evaluateGate({
      judged: true,
      issues: [issue({ resolution: "conditional" }), issue({ id: "i2", resolution: "blocked" })],
    });
    assert.equal(g.state, "blocked");
  });

  it("미해결이 조건부를 이긴다", () => {
    const g = evaluateGate({
      judged: true,
      issues: [issue({ resolution: "conditional" }), issue({ id: "i2", resolution: "open" })],
    });
    assert.equal(g.state, "rights_hold");
  });

  it("해제된 이슈는 판정에서 빠진다", () => {
    const g = evaluateGate({
      judged: true,
      issues: [issue({ resolution: "resolved" }), issue({ id: "i2", resolution: "resolved" })],
    });
    assert.equal(g.state, "pass");
  });

  it("어떤 조합에서도 pass 말고는 allowed 가 아니다", () => {
    for (const r of ["open", "conditional", "blocked"] as const) {
      const g = evaluateGate({ judged: true, issues: [issue({ resolution: r })] });
      assert.equal(g.allowed, false, `${r} 는 통과 불가`);
      assert.notEqual(g.reason, "", `${r} 는 사유가 있어야 한다`);
    }
  });

  it("모르는 resolution 값은 통과로 취급하지 않는다", () => {
    // 오타나 미래의 새 값이 조용히 통과가 되면 안 된다.
    const g = evaluateGate({ judged: true, issues: [issue({ resolution: "허용됨" })] });
    assert.equal(g.allowed, false);
  });
});

describe("조건부 해제는 근거가 있어야 한다 (F3 · FLOWS.md:61)", () => {
  it("근거 없이 해제할 수 없다", () => {
    assert.equal(canResolve(issue({ resolution: "conditional" }), "").ok, false);
    assert.equal(canResolve(issue({ resolution: "conditional" }), "   ").ok, false);
    assert.equal(canResolve(issue({ resolution: "conditional" }), "o").ok, false);
  });

  it("조치 문장이 있으면 해제할 수 있다", () => {
    assert.equal(canResolve(issue({ resolution: "conditional" }), "블러 처리 완료").ok, true);
  });

  it("이미 해제된 이슈는 다시 해제하지 않는다", () => {
    assert.equal(canResolve(issue({ resolution: "resolved" }), "블러 처리 완료").ok, false);
  });
});

describe("승계 — 이슈가 승계되지 않은 미디어는 존재할 수 없다 (F2 Invariant)", () => {
  const source: Issue[] = [
    issue({ id: "a", kind: "music", bandStart: 10, bandEnd: 20 }),
    issue({ id: "b", kind: "brand_blur", bandStart: 100, bandEnd: 120 }),
    issue({ id: "c", kind: "cast_hold" }), // 밴드 없음 = 전체
    issue({ id: "d", kind: "ppl", bandStart: 12, bandEnd: 15, resolution: "resolved" }),
  ];

  it("겹치는 구간 이슈만 물려받는다", () => {
    const got = inheritedIssues({ start: 5, end: 25 }, source).map((i) => i.id);
    assert.deepEqual(got.sort(), ["a", "c"]);
  });

  it("밴드 없는 이슈는 어느 구간이든 따라온다", () => {
    const got = inheritedIssues({ start: 500, end: 520 }, source).map((i) => i.id);
    assert.deepEqual(got, ["c"]);
  });

  it("이미 해제된 이슈는 승계하지 않는다", () => {
    const got = inheritedIssues({ start: 11, end: 16 }, source).map((i) => i.id);
    assert.equal(got.includes("d"), false);
  });

  it("경계가 닿기만 하면 겹친 게 아니다", () => {
    // [10,20] 이슈와 [20,30] 구간은 한 프레임도 공유하지 않는다.
    assert.equal(overlaps({ start: 20, end: 30 }, { start: 10, end: 20 }), false);
    assert.equal(overlaps({ start: 19, end: 30 }, { start: 10, end: 20 }), true);
  });
});

describe("일괄 배포 — 조용히 빼지도, 전부 실패시키지도 않는다 (FLOWS.md:70)", () => {
  const gateOf = (id: string) =>
    id === "ok"
      ? evaluateGate({ judged: true, issues: [] })
      : evaluateGate({ judged: true, issues: [issue({ resolution: "open" })] });

  it("통과 건만 진행한다", () => {
    const r = screenBatch(["ok", "bad", "ok2"], (id) => gateOf(id === "ok2" ? "ok" : id));
    assert.deepEqual(r.passed, ["ok", "ok2"]);
    assert.equal(r.blocked.length, 1);
  });

  it("제외된 건을 버리지 않는다 — 사유와 함께 돌려준다", () => {
    const r = screenBatch(["bad"], gateOf);
    assert.equal(r.blocked[0].gate.state, "rights_hold");
    assert.notEqual(r.blocked[0].gate.reason, "");
  });

  it("한 건이 막혀도 전체가 실패하지 않는다", () => {
    const r = screenBatch(["ok", "bad"], gateOf);
    assert.equal(r.passed.length, 1);
  });

  it("제외 안내 문구에 건수가 들어간다", () => {
    const r = screenBatch(["bad", "bad2"], () => gateOf("bad"));
    const notice = exclusionNotice(r.blocked);
    assert.match(notice, /2건/);
    assert.match(notice, /권리 홀드/);
  });

  it("제외가 없으면 안내하지 않는다", () => {
    assert.equal(exclusionNotice([]), "");
  });
});

describe("입력 검증 — 모르는 값을 통과시키지 않는다", () => {
  it("이슈 종류는 FLOWS 의 6종뿐", () => {
    for (const k of ["music", "portrait", "ppl", "cast_hold", "brand_blur", "vod_window"]) {
      assert.equal(isIssueKind(k), true, k);
    }
    for (const k of ["", "기타", "spoiler", null, undefined, 1]) {
      assert.equal(isIssueKind(k), false, String(k));
    }
  });

  it("resolution 은 4종뿐", () => {
    for (const r of ["open", "conditional", "resolved", "blocked"]) {
      assert.equal(isResolution(r), true, r);
    }
    for (const r of ["", "pass", "통과", null]) {
      assert.equal(isResolution(r), false, String(r));
    }
  });
});

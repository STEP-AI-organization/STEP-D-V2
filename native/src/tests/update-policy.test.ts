/**
 * 자동 업데이트 판정 — **하던 일 위에 덮어쓰지 않는가.**
 *
 * 업데이트가 안 되는 건 사고가 아니다(지금까지 계속 그랬다). 사고는 설치가 편집자의
 * 작업을 날리는 것이다. 설치는 앱을 종료시키므로 굽던 영상은 통째로 사라진다.
 * 여기서 보는 건 대부분 "안 깔았는가" 다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECK_INTERVAL_MS, type UpdateState,
  installDecision, isNewerVersion, isStableVersion, shouldAccept, shouldCheck, statusLine,
} from "../update/policy.js";

const busy = (transfers = false, rendering = false) => ({ transfers, rendering });

describe("갈아끼울 때 판정", () => {
  it("다 받았고 노는 중이면 깐다", () => {
    assert.deepEqual(installDecision("ready", busy(), false), { install: true, reason: "idle" });
  });

  it("아직 받는 중이면 안 깐다", () => {
    for (const stage of ["idle", "checking", "available", "downloading", "error"] as const) {
      const d = installDecision(stage, busy(), true);
      assert.equal(d.install, false, `${stage} 에서 깔았다`);
    }
  });

  it("**굽는 중이면 안 깐다** — 이어받을 수 없는 유일한 작업이다", () => {
    const d = installDecision("ready", busy(false, true), false);
    assert.equal(d.install, false);
    assert.equal(d.install === false && d.reason, "rendering");
  });

  it("**굽는 중이면 사용자가 눌러도 안 깐다** — 90초 뒤 자동 재시작이 있는데 날릴 이유가 없다", () => {
    const d = installDecision("ready", busy(true, true), true);
    assert.equal(d.install, false, "사용자가 눌렀다고 굽던 걸 날렸다");
    assert.equal(d.install === false && d.reason, "rendering");
    // 왜 안 하는지 말해 줘야 한다 — 안 그러면 버튼이 고장 난 것처럼 보인다.
    assert.match(d.install === false ? d.message : "", /끝나면/);
  });

  it("전송 중이면 기다리되, **사용자가 누르면 한다** — 큐가 영속이라 이어받는다", () => {
    const auto = installDecision("ready", busy(true, false), false);
    assert.equal(auto.install, false);
    assert.equal(auto.install === false && auto.reason, "transfers");

    const asked = installDecision("ready", busy(true, false), true);
    assert.deepEqual(asked, { install: true, reason: "user" });
  });

  it("기다리는 이유는 사람 말로 준다 — 화면이 그대로 쓴다", () => {
    for (const b of [busy(true), busy(false, true)]) {
      const d = installDecision("ready", b, false);
      assert.ok(d.install === false && d.message.length > 5, "사유가 비었다");
    }
  });
});

describe("어떤 버전을 받나", () => {
  it("**안정 버전만 받는다** — 프리릴리스가 전 편집자 PC 로 자동 배포되면 안 된다", () => {
    assert.equal(isStableVersion("1.2.3"), true);
    assert.equal(isStableVersion("0.2.0"), true);
    assert.equal(isStableVersion("1.2.3-beta.1"), false);
    assert.equal(isStableVersion("1.2.3-rc1"), false);
    assert.equal(isStableVersion("1.2"), false);
    assert.equal(isStableVersion(""), false);
  });

  it("버전 비교는 자리마다 숫자로 — 문자열 비교면 10 이 9 보다 작다", () => {
    assert.equal(isNewerVersion("0.10.0", "0.9.0"), true, "문자열로 비교했다");
    assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
    assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
    assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
  });

  it("낮은 버전으로는 안 내려간다 — 피드가 되돌려져도 다운그레이드하지 않는다", () => {
    assert.equal(shouldAccept("0.1.0", "0.2.0"), false);
    assert.equal(shouldAccept("0.2.0", "0.2.0"), false, "같은 버전을 또 깔았다");
    assert.equal(shouldAccept("0.3.0", "0.2.0"), true);
  });

  it("프리릴리스는 더 높아도 안 받는다", () => {
    assert.equal(shouldAccept("0.3.0-beta.1", "0.2.0"), false);
  });
});

describe("확인 주기", () => {
  const T = 1_800_000_000_000;

  it("한 번도 안 했으면 확인한다", () => {
    assert.equal(shouldCheck(T, 0), true);
  });

  it("주기가 안 됐으면 안 한다", () => {
    assert.equal(shouldCheck(T + 1000, T), false);
    assert.equal(shouldCheck(T + CHECK_INTERVAL_MS, T), true);
  });

  it("**시계가 뒤로 가도 다시 확인한다** — 안 그러면 영영 확인 안 한다", () => {
    // 수면 복귀·시간대 변경으로 lastCheckedAt 이 미래에 박히는 경우.
    assert.equal(shouldCheck(T, T + CHECK_INTERVAL_MS * 10), true);
  });
});

describe("화면 문구", () => {
  const s = (over: Partial<UpdateState>): UpdateState => ({
    stage: "idle", currentVersion: "0.2.0", newVersion: null,
    progress: 0, message: null, lastCheckedAt: 0, ...over,
  });

  it("상태마다 문구가 다르고 비지 않는다", () => {
    const lines = (["idle", "checking", "available", "downloading", "ready", "error"] as const)
      .map((stage) => statusLine(s({ stage, newVersion: "0.3.0", progress: 0.42 })));
    assert.equal(new Set(lines).size, lines.length, "같은 문구가 둘 있다");
    for (const l of lines) assert.ok(l.length > 3, `빈 문구: ${l}`);
  });

  it("받는 중엔 퍼센트를 보여준다 — 멈춘 것처럼 보이면 사람이 앱을 끈다", () => {
    assert.match(statusLine(s({ stage: "downloading", newVersion: "0.3.0", progress: 0.42 })), /42%/);
  });

  it("최신이면 지금 버전을 말해 준다", () => {
    assert.match(statusLine(s({})), /0\.2\.0/);
  });
});

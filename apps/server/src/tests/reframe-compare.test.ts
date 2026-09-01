import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  COMPARE_FILE_RE,
  COMPARE_ID_RE,
  compareArtifactPrefix,
  contactFrameName,
  contactSheetTimes,
} from "../reframe.ts";

describe("세로 4택 비교 — 산출물 경로·파일명 계약", () => {
  it("compareId 는 fingerprint 형식(24 hex)만 통과한다 — 경로 세그먼트라 형식이 곧 방어다", () => {
    assert.ok(COMPARE_ID_RE.test("0123456789abcdef01234567"));
    assert.ok(!COMPARE_ID_RE.test("0123456789ABCDEF01234567")); // 대문자 없음
    assert.ok(!COMPARE_ID_RE.test("..%2f..%2fetc"));
    assert.ok(!COMPARE_ID_RE.test("0123456789abcdef0123456"));  // 23자
  });

  it("스트리밍 파일명 화이트리스트 — 목록 밖 이름은 전부 거른다", () => {
    for (const ok of ["candidates.json", "index.json", "proxy.mp4", "frame-0.jpg", "frame-123456.jpg"]) {
      assert.ok(COMPARE_FILE_RE.test(ok), ok);
    }
    for (const bad of ["../index.json", "frame-.jpg", "frame-12.png", "plan.json", "proxy.mp4.exe", "frame-1.jpg/x"]) {
      assert.ok(!COMPARE_FILE_RE.test(bad), bad);
    }
  });

  it("산출물 경로는 clipId 를 파일명 안전 문자로 눌러 담는다", () => {
    assert.equal(
      compareArtifactPrefix("m_1", "c/../evil", "0123456789abcdef01234567"),
      "analysis/m_1/reframe-compare/c____evil/0123456789abcdef01234567",
    );
  });

  it("프레임 이름은 소스 절대초 ms — 정렬이 자명하다", () => {
    assert.equal(contactFrameName(12.3456), "frame-12346.jpg");
    assert.equal(contactFrameName(0), "frame-0.jpg");
  });
});

describe("contact sheet 프레임 위치 (계획 §3)", () => {
  it("시작·끝·25/50/75% 분위수가 기본으로 들어간다", () => {
    const times = contactSheetTimes({ start: 100, end: 200 });
    assert.equal(times.length, 5);
    assert.equal(times[0], 100);
    assert.ok(Math.abs(times[1] - 125) < 0.001);
    assert.ok(Math.abs(times[2] - 150) < 0.001);
    assert.ok(Math.abs(times[3] - 175) < 0.001);
    assert.ok(times[4] < 200); // 끝은 마지막 프레임 직전(-0.05)으로 앉는다
  });

  it("레이아웃 전환 지점과 샷 경계가 추가되고, 0.2초 이내 중복은 접힌다", () => {
    const times = contactSheetTimes({
      start: 0, end: 40,
      layoutSwitches: [12, 12.1],   // 0.1초 간격 → 한 장으로
      shots: [12.05, 33],           // 12.05 는 전환과 겹쳐 접힘
    });
    assert.ok(times.includes(12));
    assert.ok(!times.some((t) => t > 12 && t < 12.5));
    assert.ok(times.includes(33));
  });

  it("cap 을 넘으면 샷 경계부터 버린다 — 분위수·전환 지점이 우선이다", () => {
    const shots = Array.from({ length: 50 }, (_, i) => 1 + i * 0.5);
    const times = contactSheetTimes({ start: 0, end: 30, shots, layoutSwitches: [29], cap: 8 });
    assert.ok(times.length <= 8);
    assert.ok(times.includes(0));   // 분위수 유지
    assert.ok(times.includes(29));  // 전환 지점 유지
  });

  it("범위 밖 전환·샷은 무시하고, 잘못된 범위는 빈 목록이다", () => {
    assert.deepEqual(contactSheetTimes({ start: 5, end: 5 }), []);
    const times = contactSheetTimes({ start: 10, end: 20, shots: [3, 25], layoutSwitches: [9, 21] });
    assert.ok(times.every((t) => t >= 10 && t < 20));
  });
});

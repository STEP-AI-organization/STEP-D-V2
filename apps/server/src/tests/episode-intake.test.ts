/**
 * 회차 원본 수용 규칙 고정 (FLOWS F1).
 *
 * 핵심은 첫 번째 describe 다: **업로드 완료 ≠ 분석 완료.**
 * 이게 깨지면 큐가 밀려 있는 동안에도 화면이 "분석 중"이라고 말하고,
 * 몇 시간째 30% 인 회차가 생긴다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultTrackFor,
  initialPipeline,
  isoDateOrToday,
  readEpisodeNumber,
  readTrack,
} from "../pipeline/episode-intake.ts";

describe("업로드 완료 ≠ 분석 완료 (F1 Invariant)", () => {
  it("회차는 `분석 대기` 로만 들어간다 — 진행 중이 아니다", () => {
    const p = initialPipeline();
    assert.equal(p.stageStatus, "idle");
    assert.equal(p.note, "분석 대기");
  });

  it("진행률을 미리 채우지 않는다", () => {
    // 워커가 잡을 집기도 전의 30% 는 거짓말이다. 진짜 값은 @@PROGRESS 로 온다.
    assert.equal(initialPipeline().progress, 0);
    assert.equal(initialPipeline("워커 다운로드 대기").progress, 0);
  });

  it("어떤 경우에도 done/progress 로 시작하지 않는다", () => {
    for (const note of [undefined, "", "워커 다운로드 대기"]) {
      const p = initialPipeline(note || undefined);
      assert.notEqual(p.stageStatus, "done", `note=${note}`);
      assert.notEqual(p.stageStatus, "progress", `note=${note}`);
    }
  });
});

describe("회차 번호 파싱 (F1 필수 입력)", () => {
  it("숫자 문자열과 숫자를 받는다", () => {
    assert.equal(readEpisodeNumber("12"), 12);
    assert.equal(readEpisodeNumber(" 7 "), 7);
    assert.equal(readEpisodeNumber(3), 3);
  });

  it("0·음수·소수·빈값·쓰레기는 undefined (서버가 MAX+1 로 매김)", () => {
    for (const bad of ["", "  ", "0", "-1", "1.5", "12화", null, undefined, {}, NaN, "1e3x"]) {
      assert.equal(readEpisodeNumber(bad), undefined, `${JSON.stringify(bad)} 는 거부`);
    }
  });

  it("빈 문자열이 0 으로 읽히면 안 된다", () => {
    // Number("") === 0 이라 실수하기 쉬운 자리. 0번 회차가 생기면 MAX+1 도 어긋난다.
    assert.equal(readEpisodeNumber(""), undefined);
  });
});

describe("분석 트랙 (F1 필수 입력)", () => {
  it("variety·drama 만 통과", () => {
    assert.equal(readTrack("variety"), "variety");
    assert.equal(readTrack("drama"), "drama");
  });

  it("모르는 값은 undefined — 임의로 예능으로 밀지 않는다", () => {
    for (const bad of ["", "예능", "auto", "VARIETY", null, undefined, 1]) {
      assert.equal(readTrack(bad), undefined, `${JSON.stringify(bad)} 는 거부`);
    }
  });

  it("트랙 미지정 프로그램은 폼 기본값을 비워 둔다", () => {
    // 짐작해서 채우면 잘못된 트랙으로 분석이 돌고 씬 청크·shot 임계·추천 팩이 어긋난다.
    assert.equal(defaultTrackFor(undefined), "");
    assert.equal(defaultTrackFor("auto"), "");
    assert.equal(defaultTrackFor("drama"), "drama");
    assert.equal(defaultTrackFor("variety"), "variety");
  });
});

describe("방영일 (F1 — 기본값은 오늘)", () => {
  const today = new Date(2026, 7, 10); // 2026-08-10 (월은 0-base)

  it("YYYY-MM-DD 는 그대로 통과", () => {
    assert.equal(isoDateOrToday("2026-03-24", today), "2026-03-24");
    assert.equal(isoDateOrToday("  2026-03-24  ", today), "2026-03-24");
  });

  it("형식이 아니거나 없으면 오늘", () => {
    for (const bad of ["", "2026/03/24", "24-03-2026", "오늘", null, undefined, 20260324]) {
      assert.equal(isoDateOrToday(bad, today), "2026-08-10", `${JSON.stringify(bad)} → 오늘`);
    }
  });

  it("한 자리 월·일에 0 을 채운다", () => {
    assert.equal(isoDateOrToday(null, new Date(2026, 0, 5)), "2026-01-05");
  });
});

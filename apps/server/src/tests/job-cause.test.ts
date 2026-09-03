/**
 * 잡 오류 원인 분류 — **실제로 나는 오류**로 고정한다.
 *
 * 어드민 개선안(2026-09-03 handoff §2-1)이 예시로 든 표는 quota·ffmpeg·credits·timeout 넷이었다.
 * 그런데 프로덕션 실패 189건을 세어 보니 그 넷은 **한 건도 없었다**:
 *   187건 video.comments 404 · 1건 spawn python ENOENT · 1건 파일 ENOENT
 * 예시표만 넣었으면 189건이 전부 `unknown` 으로 떨어져 "원인별로 묶는다" 가 첫날부터
 * 무의미했다. 그래서 **실측 셋을 먼저** 넣고 예상 넷을 같이 넣었다.
 *
 * 이 파일이 지키는 것은 규칙 목록이 아니라 **그 판단**이다 — 실제 문자열이 실제 원인으로
 * 떨어지는가, 그리고 헛재시도를 막는가.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyJobError, causeKey } from "../pipeline/job-cause.ts";

/** 프로덕션에서 그대로 긁어온 문자열 (2026-09-03). */
const REAL_COMMENTS_404 =
  'Comment threads failed (404): {\n  "error": {\n    "code": 404,\n    "message": "The video identified by the \\u003ccode\\u003e\\u003ca href=\\"/youtube/v3/d';
const REAL_SPAWN = "spawn C:\\Program Files\\Git\\opt\\corevenv\\bin\\python ENOENT";
const REAL_ENOENT = "ENOENT: no such file or directory, open '/tmp/stepd-refcmp-c_f0991bc9-I1hQzf/frame-418600.jpg'";

describe("잡 원인 분류 — 실측 오류가 제자리로 간다", () => {
  it("유튜브 댓글 404 — **재시도 불가**. 실패의 99%가 이것이다", () => {
    const r = classifyJobError(REAL_COMMENTS_404);
    assert.equal(r.cause, "not_found");
    assert.equal(r.retryable, false,
      "댓글이 꺼진 영상은 100번을 눌러도 404 다 — 187건이 이미 5회씩 헛돌았다");
    assert.match(r.causeHint, /제거/);
  });

  it("python 실행 파일 없음 — 설정 문제지 일시 오류가 아니다", () => {
    const r = classifyJobError(REAL_SPAWN);
    assert.equal(r.cause, "config");
    assert.equal(r.retryable, false);
  });

  it("임시 파일 없음 — 이건 재시도가 맞다 (다시 만들면 된다)", () => {
    const r = classifyJobError(REAL_ENOENT);
    assert.equal(r.cause, "missing_file");
    assert.equal(r.retryable, true);
  });

  it("**순서가 규칙의 일부다** — `spawn … ENOENT` 가 일반 ENOENT 보다 먼저 걸린다", () => {
    // 둘 다 ENOENT 를 담고 있다. 순서가 뒤집히면 설정 문제가 "재시도하면 됨" 으로 잘못 뜬다.
    assert.equal(causeKey(REAL_SPAWN), "config");
    assert.equal(causeKey(REAL_ENOENT), "missing_file");
  });

  it("404 를 401/403 보다 먼저 본다 — 유튜브는 비공개 영상에 404 를 준다", () => {
    assert.equal(causeKey("Request failed 404 not found"), "not_found");
    assert.equal(causeKey("invalid_grant: Token has been expired or revoked"), "auth");
  });
});

describe("잡 원인 분류 — 아직 안 났지만 날 것들", () => {
  it("쿼터 소진은 재시도 가능", () => {
    for (const e of ["429 Too Many Requests", "RESOURCE_EXHAUSTED", "quotaExceeded"]) {
      const r = classifyJobError(e);
      assert.equal(r.cause, "quota", e);
      assert.equal(r.retryable, true);
    }
  });

  it("ffmpeg·크레딧은 재시도 불가 — 재배포·충전 전에는 같은 실패다", () => {
    assert.equal(classifyJobError("ffmpeg exit 1: no such filter 'zscale'").retryable, false);
    assert.equal(classifyJobError("insufficient credits for tenant 1").retryable, false);
  });

  it("시간초과·외부 5xx 는 재시도 가능", () => {
    assert.equal(classifyJobError("connect ETIMEDOUT 142.250.x.x:443").cause, "timeout");
    assert.equal(classifyJobError("Vertex returned 503 Service Unavailable").cause, "vendor_5xx");
    assert.ok(classifyJobError("read ECONNRESET").retryable);
  });
});

describe("잡 원인 분류 — 모르는 것의 처리", () => {
  it("**모르면 재시도 가능으로 둔다** — 분류기의 무지가 운영을 막으면 안 된다", () => {
    const r = classifyJobError("무언가 아주 새로운 오류");
    assert.equal(r.cause, "unknown");
    assert.equal(r.retryable, true);
  });

  it("빈 오류(아직 안 끝난 잡)도 터지지 않는다", () => {
    for (const e of [null, undefined, "", "   "]) {
      assert.equal(classifyJobError(e as any).cause, "unknown");
    }
  });

  it("라벨·힌트가 **항상** 있다 — 그룹 머리글이 비면 화면이 무너진다", () => {
    for (const e of [REAL_COMMENTS_404, REAL_SPAWN, "429", "아무거나", ""]) {
      const r = classifyJobError(e);
      assert.ok(r.causeLabel.length > 0, `라벨 없음: ${e}`);
      assert.ok(r.causeHint.length > 0, `힌트 없음: ${e}`);
    }
  });
});

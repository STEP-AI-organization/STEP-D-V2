/**
 * 비밀번호 해시 불변식. DB 없이 도는 부분만 여기서 고정한다.
 *
 * 고정하려는 것: **틀린 비밀번호가 통과하는 경로가 없다.** 특히 저장값이 손상됐을 때
 * 예외로 새어 500 이 되거나, 빈 해시가 아무 비밀번호나 받아주는 일이 없어야 한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, passwordProblem, verifyPassword } from "../auth.ts";

describe("비밀번호 해시", () => {
  it("맞는 비밀번호는 통과한다", async () => {
    const h = await hashPassword("correct horse battery");
    assert.equal(await verifyPassword("correct horse battery", h), true);
  });

  it("틀린 비밀번호는 막힌다", async () => {
    const h = await hashPassword("correct horse battery");
    assert.equal(await verifyPassword("correct horse batteryy", h), false);
    assert.equal(await verifyPassword("", h), false);
  });

  it("같은 비밀번호도 매번 다른 해시 — salt 가 실제로 붙는다", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("correct horse battery", b), true);
  });

  it("해시에 알고리즘·파라미터가 남아 나중에 교체할 수 있다", async () => {
    const h = await hashPassword("correct horse battery");
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
  });

  it("유니코드는 정규화 후 비교 — 자소 분리된 한글도 같은 비밀번호로 취급", async () => {
    const composed = "비밀번호12345678";
    const decomposed = composed.normalize("NFD");
    assert.notEqual(composed, decomposed);
    const h = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, h), true);
  });

  it("손상된 저장값은 던지지 않고 false — 실패 방향이 '로그인 거부'여야 한다", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "argon2$x$y$z$w$v", "scrypt$32768$8$1$$", "$$$$$"]) {
      assert.equal(await verifyPassword("아무거나12345678", bad), false, `bad=${bad}`);
    }
  });
});

describe("비밀번호 입력", () => {
  it("빈 값만 거부", () => {
    assert.ok(passwordProblem(""));
    assert.equal(passwordProblem("short"), null);
    assert.equal(passwordProblem("12345678901"), null);
  });

  it("길이·문자 종류는 따지지 않는다", () => {
    assert.equal(passwordProblem("a"), null);
    assert.equal(passwordProblem("123456789012"), null);
    assert.equal(passwordProblem("아주 긴 한국어 비밀번호"), null);
  });

  it("긴 입력도 통과한다", () => {
    assert.equal(passwordProblem("a".repeat(201)), null);
  });
});

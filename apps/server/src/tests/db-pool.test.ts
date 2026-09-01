/**
 * 커넥션 상한 — **확장에서 제일 먼저 부딪히는 벽**을 고정한다.
 *
 * 실측(2026-09-01): Cloud SQL `max_connections = 100`, 상시 22개 사용. 인스턴스당 풀이 10이면
 * **Cloud Run 인스턴스 8개**에서 고갈되고, 그때 새 인스턴스는 DB 를 못 잡아 요청이 통째로
 * 실패한다. 트래픽이 늘어야 나타나므로 평소 테스트로는 절대 안 보인다 — 그래서 숫자를
 * 여기 박아 둔다.
 *
 * 이 테스트가 지키는 것은 "5" 라는 값이 아니라 **그 값이 근거를 갖는다**는 사실이다.
 * 인프라가 바뀌면(연결 풀러 도입·max_connections 상향) 여기 주석과 함께 바꾼다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");

/** 실측 기준값 — 인프라를 바꾸면 이 둘도 같이 바꾼다. */
const MAX_CONNECTIONS = 100;
const RESERVED = 30;          // 워커·운영 접속·여유

describe("DB 커넥션 풀 — 인스턴스가 늘어도 고갈되지 않는다", () => {
  it("풀 크기가 env 로 조절된다 — 한계에 부딪혔을 때 배포 없이 바꿔야 한다", () => {
    assert.match(db, /const POOL_MAX = Math\.max\(1, Number\(process\.env\.PG_POOL_MAX\) \|\| \d+\)/);
    assert.match(db, /max: POOL_MAX/, "Pool 이 그 값을 안 쓰면 env 는 장식이다");
  });

  it("기본값이 인스턴스 10개를 버틴다 — 8개에서 죽던 값(10)으로 되돌아가지 않게", () => {
    const m = /Number\(process\.env\.PG_POOL_MAX\) \|\| (\d+)/.exec(db);
    assert.ok(m, "기본값을 못 찾았다");
    const poolMax = Number(m[1]);
    const instances = Math.floor((MAX_CONNECTIONS - RESERVED) / poolMax);
    assert.ok(instances >= 10,
      `풀 ${poolMax} 이면 인스턴스 ${instances}개에서 커넥션이 고갈된다 (max_connections=${MAX_CONNECTIONS})`);
  });

  it("기동 로그에 값을 찍는다 — 장애 때 제일 먼저 확인할 숫자다", () => {
    assert.match(db, /\[db\] pool max=/);
  });
});

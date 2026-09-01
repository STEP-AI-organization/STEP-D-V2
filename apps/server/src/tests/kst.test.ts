/**
 * 시각 표시 — **서버가 KST 로 내보낸다.**
 *
 * 이 파일이 있는 이유: 화면이 서버 값을 잘라 쓰는 코드가 여럿이라(`at.slice(0,16)`),
 * 서버가 UTC 를 내보내면 **9시간 밀린 시각이 그대로 사용자에게 보인다.** 에러가 아니라
 * 그럴듯한 숫자라 아무도 못 잡는다 — 실제로 자동배포 이력·크레딧 원장·거래명세서에서
 * 그렇게 나가고 있었다(2026-08-27 사용자 신고 → 실측 확인).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { TIMESTAMPTZ_OID, installKstTimestampParser, toKstIso } from "../kst.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

describe("toKstIso — KST 벽시계 + 오프셋", () => {
  it("UTC 05:56 → KST 14:56 (+9시간)", () => {
    assert.equal(toKstIso(new Date("2026-08-27T05:56:23.330Z")), "2026-08-27T14:56:23+09:00");
  });

  it("**날짜 경계** — UTC 로는 전날인 순간도 KST 날짜로 나온다", () => {
    // KST 2026-08-27 08:00 = UTC 2026-08-26 23:00. 예전엔 결제일이 하루 전으로 찍혔다.
    assert.equal(toKstIso(new Date("2026-08-26T23:00:00Z")), "2026-08-27T08:00:00+09:00");
    assert.equal(toKstIso(new Date("2026-08-26T23:00:00Z"))!.slice(0, 10), "2026-08-27");
  });

  it("자정은 00 이다 (h23 — 런타임에 따라 24 로 나오는 걸 막는다)", () => {
    // KST 자정 = UTC 15:00 전날
    assert.equal(toKstIso(new Date("2026-08-26T15:00:00Z")), "2026-08-27T00:00:00+09:00");
  });

  it("절대 시각이 보존된다 — 기록이 흐려지지 않아야 한다", () => {
    const src = new Date("2026-08-27T05:56:23.000Z");
    assert.equal(new Date(toKstIso(src)!).getTime(), src.getTime());
  });

  it("같은 오프셋이라 문자열 정렬 = 시간 정렬", () => {
    const a = toKstIso(new Date("2026-08-27T05:00:00Z"))!;
    const b = toKstIso(new Date("2026-08-27T06:00:00Z"))!;
    assert.ok(a < b);
  });

  it("없거나 잘못된 값은 null — 쿼리를 죽이지 않는다", () => {
    assert.equal(toKstIso(null), null);
    assert.equal(toKstIso(undefined), null);
    assert.equal(toKstIso(new Date("아무거나")), null);
  });
});

describe("node-pg 파서 교체", () => {
  it("timestamptz 만 바꾸고, 기본 파서 위에 얹는다", () => {
    const calls: number[] = [];
    let installed: ((v: string) => unknown) | null = null;
    installKstTimestampParser({
      getTypeParser: (oid) => {
        calls.push(oid);
        return (v: string) => new Date(v);
      },
      setTypeParser: (oid, parser) => {
        calls.push(oid);
        installed = parser;
      },
    });
    assert.deepEqual(calls, [TIMESTAMPTZ_OID, TIMESTAMPTZ_OID], "timestamptz(1184) 외를 건드렸다");
    assert.equal(installed!("2026-08-27T05:56:23.330Z"), "2026-08-27T14:56:23+09:00");
  });

  it("date(1082)·timestamp(1114) 는 건드리지 않는다 — 날짜 전용 컬럼이다", () => {
    assert.equal(TIMESTAMPTZ_OID, 1184);
    const src = read("kst.ts");
    assert.equal(/setTypeParser\(\s*1082/.test(src), false);
    assert.equal(/setTypeParser\(\s*1114/.test(src), false);
  });
});

describe("배선 — 서버 기동에 실제로 걸린다", () => {
  it("db-pg 가 파서를 설치한다", () => {
    const db = read("db-pg.ts");
    assert.match(db, /installKstTimestampParser\(pg\.types\)/,
      "설치가 안 되면 모든 시각이 UTC 로 나가 화면에서 9시간 밀린다");
  });

  it("저장 경로는 그대로다 — 기록을 바꾸지 않는다", () => {
    // 파서는 **읽기** 표현만 바꾼다. 컬럼 타입을 바꾸는 마이그레이션이 함께 오면 안 된다.
    const src = read("kst.ts");
    assert.equal(/ALTER TABLE|CREATE TABLE/.test(src), false, "표시 계층이 스키마를 건드린다");
  });
});

/**
 * 큐 공정성 고정 (다회사 5단계).
 *
 * 순수 FIFO 면 **한 회사가 큐를 독점한다.** A 가 100건을 먼저 넣으면 그 뒤에 온 B 의 1건은
 * 100건이 다 끝날 때까지 기다린다. 회사가 하나일 땐 안 아프지만 늘면 바로
 * "우리 것만 왜 안 도나"가 된다.
 *
 * 로컬 PG 실측(A 100건 선점 + B·C 1건씩, 앞 10건):
 *   FIFO  A=10 B=0 C=0   — B·C 는 아예 차례가 안 온다
 *   공정   A=8  B=1 C=1   — B 는 2번째, C 는 3번째에 차례를 받는다
 *
 * 굶기지 않는 게 목적이지 균등 분배가 아니다. A 가 여전히 대부분을 가져가되 B 가
 * **무한정 밀리지 않는다**는 것만 보장한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claim = () =>
  // 이 리포 파일은 CRLF 라 `}` 다음이 `\r` 이다. `\r?` 를 빼면 아무것도 안 잡힌다.
  new RegExp("async function claimJobInner[\\s\\S]*?\\n\\}(?=\\r?\\n)").exec(
    fs.readFileSync(path.resolve(SRC, "queue.ts"), "utf-8"),
  )?.[0] ?? "";

describe("claim 정렬", () => {
  it("claimJobInner 를 찾는다", () => {
    assert.notEqual(claim(), "", "claimJobInner 를 찾지 못했다");
  });

  it("회사별 마지막 처리 시각이 1순위다", () => {
    // SQL 이 템플릿 조각으로 조립되므로(ORDER BY ${fairOrder} …) `ORDER BY` 뒤만 잘라
    // 보면 조각 이름만 보인다. 함수 전체에서 조각의 내용과 **보간 순서**를 같이 본다.
    const fn = claim();
    assert.match(fn, /MAX\(s\.lockedAt\)/, "공정성 정렬이 없다 — 한 회사가 큐를 독점한다");
    // 1순위여야 의미가 있다. FIFO 뒤에 두면 A 의 100건이 먼저 다 나간 뒤에야 적용된다.
    assert.match(
      fn,
      /ORDER BY \$\{fairOrder\}\s*q\.runAfter ASC, q\.createdAt ASC/,
      "공정성이 FIFO 뒤에 있으면 효과가 없다",
    );
  });

  it("같은 회사 안에서는 FIFO 를 지킨다", () => {
    // 회사 간 공정성 때문에 회사 **안**의 순서까지 흔들리면 안 된다 —
    // 먼저 올린 회차가 나중 것보다 늦게 처리되면 사람이 이유를 알 수 없다.
    assert.match(claim(), /q\.runAfter ASC, q\.createdAt ASC/);
  });

  it("한 번도 안 집힌 회사가 맨 앞에 온다", () => {
    // COALESCE(..., 0) 이 그 역할이다. 빼면 NULL 이 되고, Postgres 는 ASC 에서 NULL 을
    // **마지막**으로 보내므로 신규 회사가 제일 뒤로 밀린다 — 정반대가 된다.
    assert.match(claim(), /COALESCE\(\([\s\S]*?MAX\(s\.lockedAt\)[\s\S]*?\), 0\)/);
  });

  it("행 잠금이 job_queue 에만 걸린다", () => {
    // 상관 서브쿼리가 생겼으므로 `FOR UPDATE` 만 쓰면 대상이 모호해진다.
    // `OF q` 로 명시해야 tenants 나 서브쿼리 대상까지 잠그려 들지 않는다.
    assert.match(claim(), /FOR UPDATE OF q SKIP LOCKED/);
  });

  it("정렬을 뒷받침하는 인덱스가 있다", () => {
    // 상관 서브쿼리가 후보 행마다 돈다 — 인덱스가 없으면 큐가 커질수록
    // **잡을 집는 것 자체가** 느려지고, 그건 파이프라인 전체가 느려지는 것과 같다.
    const migrations = path.resolve(SRC, "..", "migrations");
    const all = fs
      .readdirSync(migrations)
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => fs.readFileSync(path.join(migrations, f), "utf-8"))
      .join("\n");
    assert.match(all, /idx_job_queue_tenant_locked/, "공정성 정렬용 인덱스 마이그레이션이 없다");
    assert.match(all, /\(tenant_id, lockedAt DESC\)/i);
  });
});

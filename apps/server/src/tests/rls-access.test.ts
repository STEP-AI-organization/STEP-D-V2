/**
 * RLS 표를 스코프 없는 풀로 만지지 않는다.
 *
 * ## 왜 이게 조용한 사고인가
 * 정책은 `tenant_id = current_setting('app.tenant_id', true) OR current_setting(...) = '*'`
 * 다. `getRawPool()` 은 그 변수를 **세우지 않으므로** `current_setting(..., true)` 가 NULL 이
 * 되고, 비교가 전부 NULL 로 평가돼 **한 행도 안 나온다.** 에러가 아니라 빈 결과다.
 *
 * 그래서 증상이 "터짐"이 아니라 "아무것도 없음"이다 — 목록이 비어 보이고, API 키는
 * 전부 "알 수 없는 키"가 되고, 아무도 왜인지 모른다. 실제로 2026-08-11 에 API 키 3단계를
 * 이렇게 배선해서 프로덕션에서 통째로 안 도는 상태로 나갔다(순수·소스 테스트만 있어서
 * 전부 통과했다).
 *
 * `auth.ts` 가 rawPool 을 쓰는 건 users/sessions/invites 가 **RLS 대상이 아니기** 때문이지
 * "테넌트 컨텍스트 이전이라서"가 아니다. 그 구분을 헷갈리면 같은 사고가 반복된다.
 *
 * 전 회사를 가로질러 읽어야 하면 `asSystem()` / `runAsSystem()` 을 쓴다 —
 * 시스템 스코프('*')는 정책이 명시적으로 허용하는 값이라 우회가 아니라 정문이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.resolve(SRC, "..", "migrations");
const read = (p: string) => fs.readFileSync(p, "utf-8");

/**
 * RLS 가 걸린 표 — 마이그레이션에서 직접 읽는다. 여기 목록을 손으로 적어 두면
 * 표가 늘어날 때 테스트만 낡아서 새 표가 무방비로 남는다.
 */
function rlsTables(): string[] {
  const out = new Set<string>();
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".cjs"))) {
    const src = read(path.join(MIGRATIONS, f));
    // ENABLE ROW LEVEL SECURITY 를 거는 파일에서만 표 목록을 걷는다.
    if (!/ENABLE ROW LEVEL SECURITY/.test(src)) continue;
    for (const m of src.matchAll(/const (?:TENANT_)?TABLES\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const t of m[1].matchAll(/"([a-z_]+)"/g)) out.add(t[1]);
    }
    // `for (const t of ["credit_ledger", "credit_topup"])` 같은 인라인 목록도 걷는다.
    for (const m of src.matchAll(/for \(const t of \[([^\]]*)\]\)/g)) {
      for (const t of m[1].matchAll(/"([a-z_]+)"/g)) out.add(t[1]);
    }
  }
  return [...out];
}

describe("RLS 표 목록", () => {
  it("마이그레이션에서 걷어진다", () => {
    const tables = rlsTables();
    assert.ok(tables.length >= 10, `너무 적다 — 파싱이 깨졌다: ${tables.join(", ")}`);
    // 대표적인 것들이 빠지면 파싱이 잘못된 것이다.
    // instagram_accounts 는 런타임 CREATE 로만 생기다 0034 에서 편입됐다 — 여기서 고정해
    // 마이그레이션이 지워지면(격리 회귀) 테스트가 알게 한다.
    for (const t of ["api_keys", "credit_ledger", "channel_rule", "usage_events", "instagram_accounts"]) {
      assert.ok(tables.includes(t), `${t} 를 못 걷었다`);
    }
  });

  it("RLS 가 아닌 표를 잘못 걷지 않는다", () => {
    // users/sessions/invites 는 RLS 대상이 아니다 — auth.ts 가 rawPool 을 쓰는 근거다.
    const tables = rlsTables();
    for (const t of ["users", "sessions", "invites", "tenants"]) {
      assert.ok(!tables.includes(t), `${t} 는 RLS 대상이 아닌데 걷혔다`);
    }
  });
});

describe("RLS 표를 rawPool 로 만지지 않는다", () => {
  const FILES = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ name: f, src: read(path.join(SRC, f)) }));

  /** 주석을 지운다 — 주석에 적힌 `getRawPool()` 경고문까지 위반으로 잡히면 안 된다. */
  function stripComments(src: string): string {
    // 길이를 보존해야 아래에서 계산하는 줄 번호가 어긋나지 않는다.
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  }

  it("getRawPool() 호출과 같은 문장에 RLS 표가 오지 않는다", () => {
    const tables = rlsTables();
    const bad: string[] = [];

    for (const { name, src: original } of FILES) {
      const src = stripComments(original);
      // `getRawPool().query(...)` 와 `const p = getRawPool(); p.query(...)` 둘 다 잡는다.
      const aliases = [...src.matchAll(/const (\w+)\s*=\s*getRawPool\(\)/g)].map((m) => m[1]);
      const receivers = ["getRawPool\\(\\)", ...aliases.map((a) => `\\b${a}\\b`)].join("|");
      const call = new RegExp(`(?:${receivers})\\s*\\.query\\(`, "g");

      for (const m of src.matchAll(call)) {
        // 정규식으로 `);` 까지 잘라내면 인자 안의 괄호·다음 문장까지 삼킨다
        // (`Promise.all([...])` 안에서 특히). 괄호 균형으로 이 호출만 정확히 자른다.
        let i = m.index! + m[0].length;
        for (let depth = 1; i < src.length && depth > 0; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") depth--;
        }
        const stmt = src.slice(m.index!, i);
        // db-pg.ts 의 스키마 부트스트랩(CREATE TABLE / ALTER)은 정당한 rawPool 사용이다.
        if (!/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i.test(stmt)) continue;
        for (const t of tables) {
          if (new RegExp(`\\b${t}\\b`).test(stmt)) {
            const line = src.slice(0, m.index).split("\n").length;
            bad.push(`${name}:${line} — ${t}`);
          }
        }
      }
    }

    assert.deepEqual(
      bad,
      [],
      "RLS 표를 스코프 없는 풀로 만진다 → 에러가 아니라 **0행**이 나온다. " +
        `asSystem()/runAsSystem() 을 쓸 것:\n  ${bad.join("\n  ")}`,
    );
  });

  it("api_keys 경로는 시스템 스코프를 명시한다", () => {
    const dbpg = read(path.join(SRC, "db-pg.ts"));
    // `\n}` 로 끊으면 반환 타입의 `} | null> {` 에서 먼저 멈춘다 — 줄 전체가 `}` 인 곳까지.
    // 이 리포 파일은 CRLF 라 `}` 다음이 `\r` 이다. `\r?` 를 빼면 아무것도 안 잡힌다.
    const fn = /export async function lookupApiKey[\s\S]*?\n\}(?=\r?\n)/.exec(dbpg)?.[0] ?? "";
    assert.notEqual(fn, "", "lookupApiKey 를 찾지 못했다");
    assert.match(fn, /runAsSystem\(/, "rawPool 로 읽으면 모든 키가 '알 수 없는 키'가 된다");
    assert.doesNotMatch(fn, /rawPool\./, "스코프 없는 풀을 쓰고 있다");
  });
});

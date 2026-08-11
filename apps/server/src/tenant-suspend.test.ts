/**
 * 회사(워크스페이스) 정지가 실제로 막는지 고정한다.
 *
 * 2026-08-11 조사에서 나온 구멍: 어드민의 정지 버튼이 `tenants.status` 행 하나만 바꾸고,
 * 세션 검증·로그인·잡 큐 어디도 그 값을 보지 않았다. **정지된 회사 사람들이 아무 일 없이
 * 계속 썼다.** 미납·계약종료를 못 막는다는 뜻이고, 다회사 운영의 전제가 깨진다.
 *
 * 판정(workspaceBlockReason)은 순수 함수라 값으로 검증하고, **배선은 소스 스캔으로 잠근다** —
 * 판정이 옳아도 부르는 데가 없으면 아무것도 안 막히기 때문이다. 실제로 직전 사고
 * (ops_role 이 SELECT 엔 있는데 return 에서 빠진 건)가 정확히 그 모양이었다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { workspaceBlockReason } from "./auth.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.resolve(SRC, f), "utf-8");

describe("workspaceBlockReason — 회사 상태 판정", () => {
  it("active 는 통과한다", () => {
    assert.equal(workspaceBlockReason("active", "owner"), null);
    assert.equal(workspaceBlockReason("active", "member"), null);
  });

  it("suspended·closed 는 막고, 사유를 다르게 말한다", () => {
    const suspended = workspaceBlockReason("suspended", "owner");
    const closed = workspaceBlockReason("closed", "owner");
    assert.ok(suspended, "정지된 회사가 통과했다");
    assert.ok(closed, "종료된 회사가 통과했다");
    assert.notEqual(suspended, closed, "정지와 종료는 사용자가 할 일이 다르다 — 같은 문구면 안 된다");
  });

  it("모르는 상태값은 막는다 (fail-closed)", () => {
    // 손으로 고친 행, 오타, 미래에 추가될 상태값. 통과시키면 정지 우회로가 된다.
    assert.ok(workspaceBlockReason(null, "owner"));
    assert.ok(workspaceBlockReason(undefined, "owner"));
    assert.ok(workspaceBlockReason("", "owner"));
    assert.ok(workspaceBlockReason("pending_review", "owner"));
    assert.ok(workspaceBlockReason("ACTIVE", "owner"), "대소문자가 다르면 같은 값이 아니다");
  });

  it("superadmin 은 자기 회사가 정지돼도 안 막힌다 — 잠김 방지", () => {
    // 정지를 되돌릴 사람이 정지에 걸리면 어드민 콘솔에 못 들어가고,
    // 복구 경로가 DB 직접 접속밖에 안 남는다.
    assert.equal(workspaceBlockReason("suspended", "superadmin"), null);
    assert.equal(workspaceBlockReason("closed", "superadmin"), null);
    assert.equal(workspaceBlockReason(null, "superadmin"), null);
  });

  it("owner 라고 봐주지 않는다", () => {
    // 회사 정지는 회사 전체를 막는 것이다. 워크스페이스 안의 최고 권한이 예외가 되면
    // 정지의 의미가 없다 — 예외는 플랫폼 역할(superadmin)뿐이다.
    assert.ok(workspaceBlockReason("suspended", "owner"));
    assert.ok(workspaceBlockReason("suspended", "admin"));
  });
});

describe("배선 — 판정을 실제로 부르는가", () => {
  it("resolveSession 이 회사 상태를 읽고 판정한다", () => {
    const fn = new RegExp("export async function resolveSession[\\s\\S]*?\\n}").exec(read("auth.ts"))?.[0] ?? "";
    assert.notEqual(fn, "", "resolveSession 을 찾지 못했다");
    assert.match(fn, /LEFT JOIN tenants/, "세션 조회가 tenants 를 안 읽는다");
    assert.match(fn, /workspaceBlockReason\(/, "읽어만 놓고 판정을 안 한다");
  });

  it("로그인이 회사 상태를 본다", () => {
    const src = read("index.ts");
    const route = /app\.post\("\/api\/auth\/login"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.notEqual(route, "", "로그인 라우트를 찾지 못했다");
    assert.match(route, /workspaceBlockReason\(/, "로그인이 회사 정지를 안 본다");
    // 자격증명 실패(401)와 구분되는 코드여야 사용자가 "재입력"과 "문의"를 가릴 수 있다.
    assert.match(route, /403/, "회사 정지를 401 로 뭉뚱그리면 안 된다");
  });

  it("회사를 정지하면 그 회사 세션을 끊는다", () => {
    const src = read("index.ts");
    const route = /app\.patch\("\/api\/superadmin\/tenants\/:id"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.notEqual(route, "", "테넌트 PATCH 라우트를 찾지 못했다");
    assert.match(route, /destroyTenantSessions\(/, "상태만 바꾸고 세션을 안 끊으면 로그인해 있던 사람은 계속 쓴다");
  });

  it("destroyTenantSessions 는 superadmin 세션을 남긴다", () => {
    const fn = new RegExp("export async function destroyTenantSessions[\\s\\S]*?\\n}").exec(read("auth.ts"))?.[0] ?? "";
    assert.notEqual(fn, "", "destroyTenantSessions 를 찾지 못했다");
    assert.match(fn, /superadmin/, "정지를 되돌릴 사람의 세션까지 끊으면 잠긴다");
  });
});

describe("잡 큐 — 정지된 회사의 잡은 안 돈다", () => {
  const claim = () =>
    new RegExp("async function claimJobInner[\\s\\S]*?\\n}").exec(read("queue.ts"))?.[0] ?? "";

  it("claim 이 회사 상태로 거른다", () => {
    const fn = claim();
    assert.notEqual(fn, "", "claimJobInner 를 찾지 못했다");
    assert.match(fn, /FROM tenants/, "잡을 집을 때 회사 상태를 안 본다");
  });

  it("시스템 잡을 죽이지 않는다 — NOT EXISTS(<> active) 여야 한다", () => {
    // 시스템 스코프 잡은 tenant_id 가 '*' 라 tenants 에 대응 행이 없다.
    // `EXISTS (… status = 'active')` 로 뒤집어 쓰면 그 잡들이 **영영 안 돈다** —
    // 큐는 조용히 쌓이고 아무도 실패를 못 본다. 방향을 테스트로 못박는다.
    const fn = claim();
    assert.match(fn, /NOT EXISTS/, "NOT EXISTS 가 아니면 모르는 tenant_id 의 잡이 전부 막힌다");
    assert.match(fn, /status\s*<>\s*'active'/, "조건이 뒤집혔다 — 시스템 잡이 굶는다");
    assert.doesNotMatch(fn, /EXISTS\s*\(\s*\n?\s*SELECT 1 FROM tenants[\s\S]*?status\s*=\s*'active'/);
  });

  it("회사 공정성 정렬이 정지 검사보다 뒤에 오지 않는다", () => {
    // 정지 회사를 거르는 건 WHERE, 공정성은 ORDER BY 다. 공정성을 넣다가 WHERE 를
    // 건드리면 정지된 회사 잡이 되살아난다 — 두 개가 같이 있는지 확인한다.
    // SQL 이 조각으로 조립된다(`${laneFilter}${suspendedFilter}`). 잘라 보면 조각 이름만
    // 나오므로, **보간 위치**로 확인한다 — 정지 필터가 WHERE 안에 있어야 한다.
    const fn = claim();
    assert.match(fn, /NOT EXISTS/, "정지 필터가 사라졌다");
    assert.match(
      fn,
      /WHERE q\.status[\s\S]*?\$\{suspendedFilter\}[\s\S]*?ORDER BY/,
      "정지 필터가 WHERE 밖으로 나갔다 — 정지된 회사 잡이 되살아난다",
    );
  });

  it("claim 은 실패시키지 않고 건너뛴다", () => {
    // 정지 중 실패로 처리하면 attempts 가 차서, 회사가 복구돼도 잡이 안 살아난다.
    const fn = claim();
    assert.doesNotMatch(fn, /status\s*=\s*'failed'/, "정지된 회사의 잡을 실패 처리하면 복구 시 안 돌아온다");
  });
});

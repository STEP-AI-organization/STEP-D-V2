/**
 * 어드민 조치 라우트 — 벌크 재시도 · 역할 변경 · 정지 사전영향 (개선안 §2-4·§2-5·§2-6).
 *
 * 셋 다 **되돌리기 어렵거나 남의 회사를 건드리는** 조작이다. 그래서 여기서 지키는 건 기능이
 * 아니라 **가드**다 — 사유를 받는가, 못 하게 막을 것을 막는가, 조용히 실패하지 않는가.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
const cut = (marker: string) => {
  const from = index.indexOf(marker);
  assert.ok(from > 0, `${marker} 를 못 찾았다`);
  const rest = index.slice(from);
  return rest.slice(0, rest.indexOf("\n});"));
};

describe("벌크 재시도 (§2-4)", () => {
  const body = cut('app.post("/api/superadmin/jobs/retry"');

  it("superadmin 만 · 회사마다 사유를 확인한다", () => {
    assert.match(body, /requireSuperadmin\(c\)/);
    assert.ok(body.includes("requireReason(actor, j.tenantId,"),
      "회사가 섞인 벌크인데 사유를 한 회사 기준으로만 보면 남의 회사가 새 나간다");
  });

  it("**재시도해도 같은 실패인 건 안 민다** — 유튜브 쿼터만 태운다", () => {
    assert.ok(body.includes("classifyJobError(j.error).retryable"),
      "분류를 안 보고 밀면 404 187건을 그대로 다시 쏜다");
  });

  it("거른 이유를 **돌려준다** — 조용히 빼면 사람은 다 된 줄 안다", () => {
    assert.match(body, /skipped\.push\(\{ id: j\.id, why:/);
    assert.match(body, /return c\.json\(\{ retried: retried\.length, skipped \}\)/);
  });

  it("상한이 있다 — 실수로 전체를 미는 걸 막는다", () => {
    assert.ok(body.includes("slice(0, 200)"));
  });

  it("감사는 **회사별 한 줄** — 200줄을 쓰면 사람이 로그를 못 읽는다", () => {
    assert.ok(body.includes('action: "job.retry.bulk"'));
    assert.ok(body.includes("for (const [tenantId, reason] of reasonBy)"));
  });
});

describe("역할 변경 (§2-5)", () => {
  const body = cut('app.post("/api/superadmin/users/:id/role"');

  it("허용 역할이 셋뿐 — **superadmin 을 콘솔로 만들 수 없다**", () => {
    assert.ok(body.includes('["owner", "admin", "member"].includes(role)'));
    assert.ok(!body.includes('"superadmin"') || body.includes("cannot_change_superadmin"));
  });

  it("superadmin 계정의 역할은 **못 내린다** — 내리면 복구할 길이 없다", () => {
    assert.match(body, /rows\[0\]\.role === "superadmin"/);
    assert.match(body, /cannot_change_superadmin/);
  });

  it("사유를 받고 **앞뒤 역할을 감사에 남긴다** — 무엇이 바뀌었는지가 기록의 본체다", () => {
    assert.match(body, /requireReason\(actor, rows\[0\]\.tenantId, body\.reason\)/);
    assert.match(body, /action: "user\.role\.change"/);
    assert.match(body, /from: rows\[0\]\.role, to: role/);
  });
});

describe("정지 사전 영향 (§2-6)", () => {
  const body = cut('app.get("/api/superadmin/tenants/:id/suspend-preview"');

  it("세 가지를 센다 — 세션 · 실행 중 · 대기", () => {
    for (const k of ["activeSessions", "runningJobs", "queuedJobs"]) {
      assert.ok(body.includes(k), `${k} 가 없다`);
    }
  });

  it("**세션 만료를 epoch 로 비교한다** — `expires_at` 은 BIGINT 다", () => {
    // `now()` 와 비교하면 타입이 안 맞아 500 이 난다(2026-09-03 작성 중 실제로 걸렸다).
    assert.ok(body.includes("expires_at > $2"), "타임스탬프 함수와 비교하고 있다");
    assert.ok(body.includes("Date.now()"));
  });

  it("열람도 감사에 남긴다 — 남의 회사를 들여다본 기록이다", () => {
    assert.match(body, /action: "tenant\.suspend\.preview"/);
  });
});

describe("메타 수정 집계 (§2-3)", () => {
  const body = cut('app.get("/api/superadmin/metadata-edits/stats"');

  it("전체를 SQL 로 센다 — 최근 N건 프런트 집계는 **최근 편향**이다", () => {
    assert.ok(body.includes("FROM metadata_edit_log"));
    assert.ok(body.includes("GROUP BY field"));
  });

  it("**'수정률'을 만들지 않는다** — 분모가 없다", () => {
    // 안 고친 건은 로그에 행이 없다. 없는 분모로 비율을 적으면 지어낸 숫자다(§3-3).
    // 비율을 **필드로 내보내지** 않는지를 본다. 문구로 "수정률은 못 낸다" 고 설명하는 건
    // 오히려 있어야 할 줄이라, 단어 검색으로 잡으면 설명을 못 쓰게 된다.
    assert.ok(!/(keepRate|editRate|editedRatio)\s*:/.test(body), "근거 없는 비율 필드를 내보낸다");
    assert.ok(body.includes("total: t.total, wasAiPairs: t.wasAiPairs"), "분자는 그대로 준다");
    // 나눗셈 자체가 없어야 한다 — 분모가 없는데 나누고 있으면 그게 지어낸 숫자다.
    assert.ok(!/\/\s*t\.total/.test(body), "total 로 나눈 비율이 있다");
  });
});

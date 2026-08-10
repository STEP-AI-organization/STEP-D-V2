/**
 * 테넌트 컨텍스트 불변식.
 *
 * 실제 행 격리는 Postgres RLS 가 한다(migrations/0014). 여기서 고정하는 건 그 앞단 —
 * **컨텍스트가 없으면 조용히 넘어가지 않는다**는 것. 이게 무너지면 RLS 에 넘길 스코프가
 * 잘못된 값이 되고, 격리는 코드가 아니라 운으로 유지된다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_TENANTS,
  currentScope,
  currentTenantId,
  runAsSystem,
  runWithTenant,
  tenantWhere,
} from "./tenant.ts";

describe("컨텍스트 없음 = 실수 (조용한 폴백 금지)", () => {
  it("컨텍스트 밖에서 currentScope()는 던진다", () => {
    assert.throws(() => currentScope(), /tenant scope missing/);
  });

  it("컨텍스트 밖에서 currentTenantId()도 던진다", () => {
    assert.throws(() => currentTenantId(), /tenant scope missing/);
  });
});

describe("스코프 전달", () => {
  it("runWithTenant 안에서는 그 테넌트가 보인다", () => {
    runWithTenant({ scope: "t_a", via: "web" }, () => {
      assert.equal(currentScope(), "t_a");
      assert.equal(currentTenantId(), "t_a");
    });
  });

  it("중첩되면 안쪽이 이긴다 — 잡이 다른 테넌트로 갈아타는 경우", () => {
    runWithTenant({ scope: "t_a", via: "web" }, () => {
      runWithTenant({ scope: "t_b", via: "job" }, () => {
        assert.equal(currentTenantId(), "t_b");
      });
      assert.equal(currentTenantId(), "t_a");
    });
  });

  it("비동기 경계를 넘어도 유지된다 (라우트 핸들러의 await 체인)", async () => {
    await runWithTenant({ scope: "t_a", via: "web" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      assert.equal(currentTenantId(), "t_a");
    });
  });
});

describe("시스템 스코프", () => {
  it("runAsSystem 은 횡단 스코프를 준다", () => {
    runAsSystem(() => assert.equal(currentScope(), ALL_TENANTS));
  });

  it("횡단 스코프로는 **쓸 수 없다** — 어느 테넌트 것인지 모르기 때문", () => {
    runAsSystem(() => {
      assert.throws(() => currentTenantId(), /ALL_TENANTS/);
    });
  });
});

describe("tenantWhere — 애플리케이션 단에서 추가로 거를 때", () => {
  it("파라미터 번호를 이어 붙인다", () => {
    runWithTenant({ scope: "t_a", via: "web" }, () => {
      const t = tenantWhere(2);
      assert.equal(t.sql, " AND tenant_id = $3");
      assert.deepEqual(t.params, ["t_a"]);
    });
  });

  it("횡단 스코프에서는 필터가 붙지 않는다", () => {
    runAsSystem(() => {
      const t = tenantWhere(1);
      assert.equal(t.sql, "");
      assert.deepEqual(t.params, []);
    });
  });
});

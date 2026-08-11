/**
 * 운영 역할 고정 (FLOWS F9).
 *
 * 핵심은 **두 축이 섞이지 않는 것**이다. 워크스페이스 owner 라는 이유로 배포가 열리면
 * "계정을 자기가 만든 외주 편집자"에게 송출 버튼이 생긴다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  OPS_CAPABILITIES,
  OPS_ROLES,
  canPublish,
  canSeeRevenue,
  defaultOpsRoleFor,
  isOpsRole,
  opsCapabilityOf,
} from "./ops-role.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));

describe("두 축은 섞이지 않는다", () => {
  it("워크스페이스 역할로는 배포가 열리지 않는다", () => {
    for (const wsRole of ["owner", "admin", "member", "superadmin"]) {
      assert.equal(canPublish(wsRole), false, `${wsRole} 은 운영 역할이 아니다`);
    }
  });

  it("배포는 cp 만", () => {
    assert.equal(canPublish("cp"), true);
    for (const r of ["editor", "pd", "vendor"]) assert.equal(canPublish(r), false, r);
  });

  it("초대 기본값은 출발점이지 관리 권한의 승계가 아니다", () => {
    assert.equal(defaultOpsRoleFor("owner"), "cp");
    // admin 은 사람을 초대할 수 있지만 그게 송출 권한은 아니다.
    assert.equal(defaultOpsRoleFor("admin"), "editor");
    assert.equal(canPublish(defaultOpsRoleFor("admin")), false);
    assert.equal(defaultOpsRoleFor("member"), "editor");
  });
});

describe("모르는 값은 가장 좁은 권한으로", () => {
  it("오타·빈값·미래 값이 넓은 권한으로 열리지 않는다", () => {
    for (const bad of ["", "  ", "CP", "관리자", "admin", null, undefined, 1, {}]) {
      const cap = opsCapabilityOf(bad);
      assert.equal(cap.key, "vendor", JSON.stringify(bad));
      assert.equal(cap.publish, false);
      assert.equal(cap.revenue, false);
      assert.equal(cap.scope, "assigned");
    }
  });

  it("검증 함수가 4종만 통과시킨다", () => {
    for (const r of OPS_ROLES) assert.equal(isOpsRole(r), true, r);
    for (const bad of ["owner", "member", "", null]) assert.equal(isOpsRole(bad), false, String(bad));
  });
});

describe("F9 권한 표", () => {
  it("수익은 editor·cp 만", () => {
    assert.equal(canSeeRevenue("editor"), true);
    assert.equal(canSeeRevenue("cp"), true);
    assert.equal(canSeeRevenue("pd"), false);
    assert.equal(canSeeRevenue("vendor"), false);
  });

  it("범위 3종", () => {
    assert.equal(OPS_CAPABILITIES.cp.scope, "all");
    assert.equal(OPS_CAPABILITIES.pd.scope, "owned");
    assert.equal(OPS_CAPABILITIES.vendor.scope, "assigned");
  });

  it("승인은 cp·pd", () => {
    assert.equal(OPS_CAPABILITIES.cp.approve, true);
    assert.equal(OPS_CAPABILITIES.pd.approve, true);
    assert.equal(OPS_CAPABILITIES.editor.approve, false);
    assert.equal(OPS_CAPABILITIES.vendor.approve, false);
  });
});

describe("화면과 서버가 같은 표를 쓴다", () => {
  it("apps/web 의 roles.ts 와 권한 값이 일치한다", () => {
    // 두 벌이 되면 화면은 버튼을 열어 주는데 서버가 막는(또는 그 반대) 상태가 된다.
    const webPath = path.resolve(SRC, "../../web/src/lib/roles.ts");
    if (!fs.existsSync(webPath)) return; // 웹이 없는 체크아웃에서는 건너뛴다
    const web = fs.readFileSync(webPath, "utf-8");

    for (const role of OPS_ROLES) {
      const line = new RegExp(`${role}:\\s*\\{[^}]*\\}`).exec(web)?.[0] ?? "";
      assert.notEqual(line, "", `web roles.ts 에 ${role} 이 없다`);
      const cap = OPS_CAPABILITIES[role];
      assert.match(line, new RegExp(`publish:\\s*${cap.publish}`), `${role} publish 불일치`);
      assert.match(line, new RegExp(`approve:\\s*${cap.approve}`), `${role} approve 불일치`);
      assert.match(line, new RegExp(`revenue:\\s*${cap.revenue}`), `${role} revenue 불일치`);
      assert.match(line, new RegExp(`scope:\\s*"${cap.scope}"`), `${role} scope 불일치`);
    }
  });
});

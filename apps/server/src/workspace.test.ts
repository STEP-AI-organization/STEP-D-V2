/**
 * 워크스페이스 권한 불변식.
 *
 * 집단형 워크플로에서 제일 위험한 사고는 "권한 없는 사람이 들어오는 것"보다
 * **"아무도 관리할 수 없는 상태가 되는 것"** 이다 — 마지막 owner 가 사라지면 남은 사람들은
 * 동료를 초대할 수도, 역할을 고칠 수도 없이 갇힌다. 그 경로가 없다는 걸 여기서 고정한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canManageWorkspace, isWorkspaceOwner, type Role } from "./auth.ts";

const ROLES: Role[] = ["owner", "admin", "member", "superadmin"];

describe("워크스페이스 관리 권한", () => {
  it("owner·admin·superadmin 만 동료를 초대·관리할 수 있다", () => {
    assert.deepEqual(
      ROLES.filter(canManageWorkspace),
      ["owner", "admin", "superadmin"],
    );
  });

  it("member 는 관리 권한이 없다 — 작업은 같이 하되 조직은 못 바꾼다", () => {
    assert.equal(canManageWorkspace("member"), false);
  });

  it("owner 급은 owner 와 superadmin 뿐 — admin 은 owner 를 건드릴 수 없다", () => {
    assert.deepEqual(ROLES.filter(isWorkspaceOwner), ["owner", "superadmin"]);
    assert.equal(isWorkspaceOwner("admin"), false);
  });

  it("superadmin 은 자기 워크스페이스 안에서 owner 처럼 행동한다", () => {
    // 안 그러면 사내 워크스페이스를 정작 우리가 운영하지 못하는 상태가 된다.
    assert.equal(canManageWorkspace("superadmin"), true);
    assert.equal(isWorkspaceOwner("superadmin"), true);
  });
});

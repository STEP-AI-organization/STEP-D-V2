/**
 * 운영 역할 — 방송 업무 권한 축 (FLOWS F9). 순수 모듈.
 *
 * **워크스페이스 역할과 다른 질문에 답한다.**
 *
 *   auth.ts 의 Role(owner/admin/member/superadmin) = *워크스페이스를 관리할 수 있는가*
 *     — 사람을 초대하고, 채널을 연결하고, 결제를 보는 축.
 *   여기의 OpsRole(editor/cp/pd/vendor)               = *방송 업무에서 무엇을 할 수 있는가*
 *     — 배포를 누를 수 있는가, 검수를 승인할 수 있는가, 수익을 볼 수 있는가,
 *       어디까지가 내 목록인가.
 *
 * 둘을 하나로 합치려다 보면 반드시 이런 사람이 생긴다: **워크스페이스 owner 인 외주 편집자.**
 * 계정은 자기가 만들었으니 owner 인데, 방송 권한은 vendor 여야 한다. 축이 하나면 이 사람에게
 * 배포 버튼이 열린다. 그래서 축을 둘로 둔다(2026-08-11 결정).
 */

export const OPS_ROLES = ["editor", "cp", "pd", "vendor"] as const;
export type OpsRole = (typeof OPS_ROLES)[number];

export interface OpsCapability {
  key: OpsRole;
  label: string;
  /** 배포 버튼을 누를 수 있는가. */
  publish: boolean;
  /** 검수를 승인/해제할 수 있는가. */
  approve: boolean;
  /** 수익 금액을 볼 수 있는가. 없으면 "비공개"(0 이 아니다 — F9 ⊘). */
  revenue: boolean;
  /** 목록·검색·분석에 무엇까지 나오는가. */
  scope: "all" | "owned" | "assigned";
}

/** FLOWS F9 표 그대로. 화면(roles.ts)과 **같은 값**이어야 한다. */
export const OPS_CAPABILITIES: Record<OpsRole, OpsCapability> = {
  editor: { key: "editor", label: "에디터",    publish: false, approve: false, revenue: true,  scope: "all" },
  cp:     { key: "cp",     label: "팀장·CP",   publish: true,  approve: true,  revenue: true,  scope: "all" },
  pd:     { key: "pd",     label: "담당 PD",   publish: false, approve: true,  revenue: false, scope: "owned" },
  vendor: { key: "vendor", label: "외주 편집", publish: false, approve: false, revenue: false, scope: "assigned" },
};

export function isOpsRole(v: unknown): v is OpsRole {
  return typeof v === "string" && (OPS_ROLES as readonly string[]).includes(v);
}

/**
 * 저장값 → 권한. **모르는 값은 가장 좁은 권한(vendor)으로 떨어뜨린다.**
 * 오타나 미래의 새 값이 넓은 권한으로 열리면, 실패 방향이 "권한 초과"가 된다.
 */
export function opsCapabilityOf(raw: unknown): OpsCapability {
  return isOpsRole(raw) ? OPS_CAPABILITIES[raw] : OPS_CAPABILITIES.vendor;
}

/**
 * 워크스페이스 역할에서 유추하는 **초대 시 기본값**. 지정이 아니라 출발점이다.
 *
 * 계정을 만든 사람(owner)은 보통 그 조직에서 판단을 내리는 사람이라 cp 로 시작한다.
 * 그래도 **admin 이라고 배포 권한을 주지는 않는다** — 워크스페이스 관리와 송출은 다른 일이다.
 */
export function defaultOpsRoleFor(workspaceRole: string): OpsRole {
  return workspaceRole === "owner" ? "cp" : "editor";
}

/**
 * 이 사람이 배포를 누를 수 있는가 — **운영 역할만 본다.**
 * 워크스페이스 owner 라는 이유로 통과시키지 않는다(관리 권한 ≠ 송출 권한).
 */
export function canPublish(opsRole: unknown): boolean {
  return opsCapabilityOf(opsRole).publish;
}

/** 수익 금액을 볼 수 있는가. */
export function canSeeRevenue(opsRole: unknown): boolean {
  return opsCapabilityOf(opsRole).revenue;
}

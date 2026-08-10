/**
 * 역할 · 권한 (FLOWS F9 · README "State Management" 표).
 *
 * ⚠️ **클라이언트는 표시만 제어한다. 모든 권한은 서버에서 다시 검사한다** (FLOWS.md:174).
 * 여기 값으로 버튼을 감추는 건 편의이지 방어가 아니다 — 서버 강제는 S3 에서 붙는다.
 *
 * 수익 지표는 권한이 없을 때 **0 이 아니라 "비공개"** 로 표기한다(FLOWS.md:169).
 * 0 으로 렌더하면 "수익이 0 원"과 "볼 권한이 없음"이 같은 화면이 된다.
 */

export type Role = "editor" | "cp" | "pd" | "vendor";

/** 목록·검색·분석에 무엇까지 나오는가 (FLOWS.md:172). */
export type Scope = "all" | "owned" | "assigned";

export interface RoleCapability {
  key: Role;
  label: string;
  /** 배포(게시) 실행 */
  publish: boolean;
  /** 검수 승인 · 게이트 해제 */
  approve: boolean;
  /** 수익 금액 열람 */
  revenue: boolean;
  scope: Scope;
}

export const ROLES: Record<Role, RoleCapability> = {
  editor: { key: "editor", label: "에디터",     publish: false, approve: false, revenue: true,  scope: "all" },
  cp:     { key: "cp",     label: "팀장·CP",    publish: true,  approve: true,  revenue: true,  scope: "all" },
  pd:     { key: "pd",     label: "담당 PD",    publish: false, approve: true,  revenue: false, scope: "owned" },
  vendor: { key: "vendor", label: "외주 편집",  publish: false, approve: false, revenue: false, scope: "assigned" },
};

export function capabilityOf(role: Role): RoleCapability {
  return ROLES[role] ?? ROLES.vendor;   // 모르는 역할은 가장 좁은 권한으로 떨어뜨린다
}

/** 수익 금액 표시값. 권한이 없으면 숫자가 아니라 "비공개" 다. */
export function revenueDisplay(
  role: Role,
  amount: number,
  format: (n: number) => string,
): { text: string; masked: boolean; barRatio: number } {
  if (!capabilityOf(role).revenue) {
    // 막대 길이도 0 이어야 한다 — 길이로 금액이 유추되면 마스킹이 아니다.
    return { text: "비공개", masked: true, barRatio: 0 };
  }
  return { text: format(amount), masked: false, barRatio: 1 };
}

/**
 * 지표를 볼 수 없는 채널의 사유 — **문구를 유형별로 다르게** 한다 (FLOWS.md:171-173).
 * "권한이 없다"와 "구조적으로 데이터가 없다"를 같은 문장으로 뭉개면,
 * 운영자는 권한을 요청해야 할지 채널 설정을 고쳐야 할지 알 수 없다.
 */
export type BlockedReason = "no_permission" | "upload_only";

export function blockedCopy(reason: BlockedReason): { title: string; body: string } {
  return reason === "no_permission"
    ? {
        title: "이 채널의 지표 접근 권한이 없습니다",
        body: "채널 담당자에게 권한을 요청하면 이 화면에서 지표를 볼 수 있습니다.",
      }
    : {
        title: "구조적으로 데이터가 존재하지 않습니다",
        body: "업로드 전용으로 연결된 채널이라 지표를 수집하지 않습니다. 데이터가 0 인 것과 다릅니다.",
      };
}

/** 역할 키 → 권한. 모르는 값은 가장 좁은 권한(vendor)으로 떨어뜨린다 — 모르면 못 하게. */
export function roleOf(key: Role | string | undefined): RoleCapability {
  return ROLES[(key ?? "") as Role] ?? ROLES.vendor;
}

"use client";

/**
 * 세션 / 역할 (FLOWS F9).
 *
 * **역할이 두 축이다** (2026-08-11 결정):
 *   `workspaceRole` — owner/admin/member/superadmin. 워크스페이스를 관리할 수 있는가
 *                     (사람 초대·채널 연결·결제).
 *   `role`(운영)    — editor/cp/pd/vendor. 방송 업무에서 무엇을 할 수 있는가
 *                     (배포·승인·수익·범위). **화면의 권한 판단은 전부 이쪽을 본다.**
 *
 * 하나로 합치면 "워크스페이스 owner 인 외주 편집자"에게 배포 버튼이 열린다.
 *
 * ⚠️ **클라이언트 역할은 표시 제어용이다.** 서버가 다시 검사한다 —
 * 배포는 publish-dispatch 가, 데이터 범위는 테넌트 RLS 가 막는다.
 * 여기 값을 고쳐도 나가는 것이 달라지지 않는다.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { API_BASE } from "@/lib/data/api";
import type { Role } from "@/lib/roles";

export type WorkspaceRole = "owner" | "admin" | "member" | "superadmin";

export interface Session {
  user: {
    name: string;
    email: string;
    /** 운영 역할 (FLOWS F9) — 화면 권한의 기준. */
    role: Role;
    /** 워크스페이스 관리 역할. 설정 화면에서만 쓴다. */
    workspaceRole?: WorkspaceRole;
  };
  /** 서버가 인증을 요구하는가. false 면 단일 테넌트 개발 모드다. */
  authRequired: boolean;
  /** 아직 /api/auth/me 응답을 못 받았는가. */
  loading: boolean;
  /** 현재 워크스페이스(테넌트) 이름 — 로그인 후 "어느 회사 것인지" 셸에 표시(사용자 2026-08-20). */
  workspaceName?: string;
}

/**
 * 로그인 전/서버 미연결일 때의 값.
 *
 * **가장 좁은 권한(vendor)으로 시작한다.** 로딩 중에 cp 로 보이면 배포 버튼이 잠깐 열렸다가
 * 닫히고, 그 틈에 누르면 서버에서 막힌 이유를 알 수 없다.
 */
const ANONYMOUS: Session = {
  user: { name: "", email: "", role: "vendor" },
  authRequired: false,
  loading: true,
};

const SessionContext = createContext<Session>(ANONYMOUS);

interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: WorkspaceRole;
    opsRole: Role;
    tenantId: string;
    tenantName: string | null;
  } | null;
  authRequired: boolean;
}

export function SessionProvider({
  children,
  session,
}: {
  children: ReactNode;
  /** 테스트·스토리북에서 고정 세션을 주입할 때만 쓴다. */
  session?: Session;
}) {
  const [value, setValue] = useState<Session>(session ?? ANONYMOUS);

  useEffect(() => {
    if (session) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/me`, { cache: "no-store", credentials: "include" });
        const body = (await res.json()) as MeResponse;
        if (!alive) return;
        setValue({
          user: body.user
            ? {
                name: body.user.name || body.user.email,
                email: body.user.email,
                role: body.user.opsRole,
                workspaceRole: body.user.role,
              }
            // 서버가 인증을 요구하지 않는 모드(단일 테넌트 로컬/사내 단독 운영)에서는
            // 로그인 자체가 없으므로 사용자도 없다. 이때 vendor 로 잠그면 화면이 통째로
            // 막혀 아무 일도 못 한다 — 운영자 본인의 박스라는 전제라 cp 로 연다.
            //
            // ⚠️ 이건 **표시 권한만**이다. 배포는 서버의 publish-dispatch 가, 데이터 범위는
            // 테넌트 RLS 가 막는다. 그리고 서버는 테넌트가 둘 이상이면서 AUTH_REQUIRED 가
            // 꺼져 있으면 아예 서빙을 거부한다(auth posture 점검) — 이 분기가 다중 방송사
            // 환경에서 열릴 일이 없는 이유다.
            : body.authRequired
              ? ANONYMOUS.user
              : { name: "운영자", email: "", role: "cp" as const },
          workspaceName: body.user?.tenantName ?? undefined,
          authRequired: body.authRequired,
          loading: false,
        });
      } catch {
        // 서버를 못 읽으면 익명 그대로 둔다 — 넓은 권한으로 추측하지 않는다.
        if (alive) setValue({ ...ANONYMOUS, loading: false });
      }
    })();
    return () => { alive = false; };
  }, [session]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

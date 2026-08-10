"use client";

/**
 * 세션 / 역할 (FLOWS F9).
 *
 * 지금은 목 세션이고 역할이 `cp` 로 고정돼 있다 — 프로토타입과 같은 값이다.
 * ⚠️ **클라이언트 역할은 표시 제어용이다.** 권한은 서버에서 다시 검사해야 하고,
 * 그 강제는 S3 에서 붙는다 (FLOWS.md:174). 그 전까지 이 값으로 막히는 건
 * 화면뿐이라는 걸 전제로 읽을 것.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/roles";

export interface Session {
  user: { name: string; email: string; role: Role };
}

const MOCK_SESSION: Session = {
  user: { name: "운영자", email: "hkj@stepai.kr", role: "cp" },
};

const SessionContext = createContext<Session>(MOCK_SESSION);

export function SessionProvider({
  children,
  session,
}: {
  children: ReactNode;
  session?: Session;
}) {
  return <SessionContext.Provider value={session ?? MOCK_SESSION}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  return useContext(SessionContext);
}

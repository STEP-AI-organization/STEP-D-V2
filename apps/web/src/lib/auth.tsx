"use client";

/**
 * Session / RBAC seam. Today returns a mock superadmin; at M6 the SessionProvider
 * reads from @spfn/auth (same 3 roles as STEPD) and the rest of the app is unchanged.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/nav";

export interface Session {
  user: { name: string; email: string; role: Role };
}

const MOCK_SESSION: Session = {
  user: { name: "운영자", email: "hkj@stepai.kr", role: "superadmin" },
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

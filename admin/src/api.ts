/**
 * 서버 호출. 경로는 항상 상대경로다 — 프로덕션은 vercel rewrite, 개발은 vite proxy 가
 * 같은 오리진처럼 보이게 해준다(세션이 HttpOnly 쿠키라 오리진이 갈리면 로그인이 안 된다).
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as any) : {};
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const get = <T>(p: string) => call<T>(p);
const post = <T>(p: string, body?: unknown) =>
  call<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body?: unknown) =>
  call<T>(p, { method: "PATCH", body: JSON.stringify(body ?? {}) });

// ── 타입 ───────────────────────────────────────────────────────────────────────

export interface Me {
  id: string; email: string; name: string; role: string; tenantId: string;
}
export interface Tenant {
  id: string; name: string; kind: string; status: string;
  billingEmail: string | null; createdAt: number;
  userCount: number; mediaCount: number; mediaSec: number;
}
export interface AdminUser {
  id: string; tenantId: string; email: string; name: string; role: string;
  status: string; createdAt: number; lastLoginAt: number | null;
}
export interface AdminJob {
  id: string; type: string; status: string; attempts: number;
  tenantId: string; error: string | null; createdAt: number; updatedAt: number;
}
export interface AuditEntry {
  id: number; actorEmail: string; action: string; targetTenant: string | null;
  targetId: string | null; reason: string | null; detail: Record<string, unknown>;
  ip: string | null; at: number;
}
export interface Overview {
  tenants: number; users: number;
  jobs: Record<string, number>;
  media: { count: number; minutes: number };
}

// ── 호출 ───────────────────────────────────────────────────────────────────────

export const api = {
  me: () => get<{ user: Me | null; authRequired: boolean }>("/api/auth/me"),
  login: (email: string, password: string) => post<{ user: Me }>("/api/auth/login", { email, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),

  overview: () => get<Overview>("/api/superadmin/overview"),
  tenants: () => get<{ tenants: Tenant[] }>("/api/superadmin/tenants"),
  createTenant: (t: { id?: string; name: string; kind: string; billingEmail?: string }) =>
    post<{ id: string }>("/api/superadmin/tenants", t),
  updateTenant: (id: string, patchBody: { status?: string; name?: string; reason?: string }) =>
    patch<{ ok: true }>(`/api/superadmin/tenants/${encodeURIComponent(id)}`, patchBody),

  users: (tenant?: string, reason?: string) => {
    const q = new URLSearchParams();
    if (tenant) q.set("tenant", tenant);
    if (reason) q.set("reason", reason);
    return get<{ users: AdminUser[] }>(`/api/superadmin/users${q.size ? `?${q}` : ""}`);
  },
  setUserStatus: (id: string, status: "active" | "suspended", reason?: string) =>
    post<{ ok: true }>(`/api/superadmin/users/${encodeURIComponent(id)}/status`, { status, reason }),
  invite: (tenantId: string, email: string, role: string, reason?: string) =>
    post<{ inviteId: string; token: string; expiresAt: number }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/invite`, { email, role, reason }),

  jobs: () => get<{ jobs: AdminJob[] }>("/api/superadmin/jobs"),
  audit: () => get<{ entries: AuditEntry[] }>("/api/superadmin/audit"),
};

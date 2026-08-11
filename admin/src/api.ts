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
  /** 잔여 크레딧(1개 = 분석 1분) · 이번 달 사용 · 마지막 로그인. 회사가 살아 있는지 보는 축. */
  credits: number; usedThisMonth: number; lastLoginAt: number | null;
}
export interface ApiKey {
  id: string; name: string | null; prefix: string; scopes: string[];
  lastUsedAt: string | null; revokedAt: string | null; createdAt: string;
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
  /**
   * 회사 개설. 서버가 회사 + 첫 owner 초대 + 초기 크레딧을 **한 트랜잭션**으로 처리한다.
   * `ownerEmail` 은 필수 — 들어갈 사람 없이 회사만 만들면 아무도 못 쓴다.
   * `inviteToken`·`inviteUrl` 은 **응답에서 한 번만** 나온다(서버가 평문을 저장하지 않는다).
   */
  createTenant: (t: {
    id?: string; name: string; kind: string;
    ownerEmail: string; billingEmail?: string; initialCredits?: number;
  }) =>
    post<{
      id: string;
      ownerEmail: string;
      initialCredits: number;
      inviteToken: string;
      inviteExpiresAt: number;
      inviteUrl: string | null;
    }>("/api/superadmin/tenants", t),
  // sessionsRevoked — 정지·종료로 끊은 세션 수. 정지가 실제로 먹었는지 화면이 보여줄 근거다.
  updateTenant: (id: string, patchBody: { status?: string; name?: string; reason?: string }) =>
    patch<{ ok: true; sessionsRevoked?: number }>(`/api/superadmin/tenants/${encodeURIComponent(id)}`, patchBody),

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

  // ── 회사별 API 키 ──
  // 고객사 **시스템**이 우리를 호출하는 열쇠다. 평문은 발급 응답에 한 번만 나오고
  // 서버가 저장하지 않으므로, 목록에서는 접두(stepd_live_ab12)만 보인다.
  apiKeys: (tenantId: string) =>
    get<{ keys: ApiKey[]; scopes: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/api-keys`),
  createApiKey: (tenantId: string, body: { name?: string; scopes: string[]; reason?: string }) =>
    post<{ id: string; key: string; prefix: string; scopes: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/api-keys`, body),
  revokeApiKey: (keyId: string, reason?: string) =>
    post<{ ok: true; alreadyRevoked: boolean }>(
      `/api/superadmin/api-keys/${encodeURIComponent(keyId)}/revoke`, { reason }),

  jobs: (tenant?: string) =>
    get<{ jobs: AdminJob[] }>(
      `/api/superadmin/jobs${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`),
  // 감사 로그는 300건 상한이라 필터 없이는 "누가 우리 회사를 봤나" 를 못 찾는다.
  audit: (opts: { tenant?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.tenant) qs.set("tenant", opts.tenant);
    if (opts.q) qs.set("q", opts.q);
    return get<{ entries: AuditEntry[] }>(`/api/superadmin/audit${qs.size ? `?${qs}` : ""}`);
  },
};

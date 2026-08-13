/**
 * 서버 호출. 경로는 항상 상대경로다 — 프로덕션은 vercel rewrite, 개발은 vite proxy 가
 * 같은 오리진처럼 보이게 해준다(세션이 HttpOnly 쿠키라 오리진이 갈리면 로그인이 안 된다).
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public field?: string) {
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
  // 프록시 502/503·Cloud Run 콜드스타트는 HTML/plain 을 준다. res.ok 판정 전에 JSON.parse 하면
  // 진짜 상태 코드 대신 SyntaxError 로 터져 장애가 클라 버그처럼 보인다 → 파싱 실패를 흡수한다.
  let body: any = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { message: text.slice(0, 300) }; }
  }
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${res.status}`, body.field);
  return body as T;
}

const get = <T>(p: string) => call<T>(p);
const post = <T>(p: string, body?: unknown) =>
  call<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body?: unknown) =>
  call<T>(p, { method: "PATCH", body: JSON.stringify(body ?? {}) });
const del = <T>(p: string) => call<T>(p, { method: "DELETE" });

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
export interface BusinessProfile {
  bizName: string; bizNo: string; ceoName: string; address: string;
  bizType: string; bizItem: string; contactEmail: string; contactPhone: string;
  updatedBy: string; updatedAt: string;
}
export interface Payment {
  paymentId: string; tenantId: string; credits: number; amountKrw: number;
  status: string; requestedBy: string; createdAt: string; settledAt: string | null;
}
export interface LedgerRow {
  id: number; delta: number; reason: string; mediaId: string | null;
  paymentId: string | null; amountKrw: number | null; note: string;
  actor: string; occurredAt: string;
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
export interface UsageRow {
  tenantId: string; minutes: number; events: number;
  costKrw: number; revenueKrw: number; marginKrw: number;
}
export interface UsageSummary {
  days: number;
  totals: { minutes: number; costKrw: number; revenueKrw: number; marginKrw: number };
  byTenant: UsageRow[];
}
export interface AuditQuery { tenant?: string; q?: string; from?: string; to?: string; limit?: number }

function auditParams(o: AuditQuery): string {
  const qs = new URLSearchParams();
  if (o.tenant) qs.set("tenant", o.tenant);
  if (o.q) qs.set("q", o.q);
  if (o.from) qs.set("from", o.from);
  if (o.to) qs.set("to", o.to);
  if (o.limit) qs.set("limit", String(o.limit));
  return qs.toString();
}
export interface CompanyDetail {
  tenant: Pick<Tenant, "id" | "name" | "kind" | "status" | "billingEmail" | "createdAt">;
  members: AdminUser[];
  summary: {
    members: number; mediaCount: number; mediaMinutes: number; credits: number;
    usedThisMonth: number; channels: number; failedJobs: number;
    performance: { views: number; minutesWatched: number; netSubscribers: number; revenue: number };
  };
  jobs: Omit<AdminJob, "tenantId" | "createdAt">[];
  payments: Omit<Payment, "tenantId">[];
  audit: Array<Pick<AuditEntry, "id" | "actorEmail" | "action" | "targetId" | "reason" | "detail" | "at">>;
}
export interface Performance {
  from: string;
  summary: { views: number; minutesWatched: number; netSubscribers: number; revenue: number };
  channels: Array<{ channelId: string; channelName: string; status: string; views: number; minutesWatched: number; netSubscribers: number; revenue: number }>;
  daily: Array<{ day: string; views: number }>;
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
  // id 는 보내지 않는다 — 서버가 순번을 매긴다. 사람에게 의미 있는 건 이름이다.
  createTenant: (t: {
    name: string; kind: string; ownerEmail: string; ownerName?: string; ownerPassword?: string;
    billingEmail?: string; initialCredits?: number;
  }) =>
    post<{
      id: string;
      name: string;
      ownerEmail: string;
      initialCredits: number;
      owner: AdminUser;
      temporaryPassword: string;
      /** Legacy inline company form is no longer rendered; retained while its file is retired. */
      inviteToken?: string;
      inviteUrl?: string | null;
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
  company: (tenantId: string) => get<CompanyDetail>(`/api/superadmin/tenants/${encodeURIComponent(tenantId)}/detail`),
  performance: (tenantId: string) => get<Performance>(`/api/superadmin/tenants/${encodeURIComponent(tenantId)}/performance`),
  createMember: (tenantId: string, body: { email: string; name?: string; role: string; password?: string }) =>
    post<{ member: AdminUser; temporaryPassword: string }>(`/api/superadmin/tenants/${encodeURIComponent(tenantId)}/members`, body),
  resetMemberPassword: (id: string, password?: string) =>
    post<{ ok: true; temporaryPassword: string }>(`/api/superadmin/users/${encodeURIComponent(id)}/password`, { password }),
  deleteMember: (id: string) => del<{ ok: true }>(`/api/superadmin/users/${encodeURIComponent(id)}`),

  // ── 회사별 API 키 ──
  // 고객사 **시스템**이 우리를 호출하는 열쇠다. 평문은 발급 응답에 한 번만 나오고
  // 서버가 저장하지 않으므로, 목록에서는 접두(stepd_live_ab12)만 보인다.
  apiKeys: (tenantId: string) =>
    get<{ keys: ApiKey[]; scopes: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/api-keys`),
  createApiKey: (tenantId: string, body: { name?: string; scopes?: string[]; reason?: string }) =>
    post<{ id: string; key: string; prefix: string; scopes: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/api-keys`, body),
  revokeApiKey: (keyId: string, reason?: string) =>
    post<{ ok: true; alreadyRevoked: boolean }>(
      `/api/superadmin/api-keys/${encodeURIComponent(keyId)}/revoke`, { reason }),
  // 같은 스코프·이름으로 새 키 발급 후 옛 키 폐기(무중단 회전). 새 평문은 응답에 1회만.
  rotateApiKey: (keyId: string, reason?: string) =>
    post<{ id: string; key: string; prefix: string; scopes: string[]; replaced: string }>(
      `/api/superadmin/api-keys/${encodeURIComponent(keyId)}/rotate`, { reason }),

  // ── 회사 사업자정보 (거래명세서의 "공급받는 자") ──
  business: (tenantId: string) =>
    get<{ profile: BusinessProfile | null; incomplete: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/business`),
  saveBusiness: (tenantId: string, body: Partial<BusinessProfile> & { reason?: string }) =>
    call<{ ok: true; profile: BusinessProfile; incomplete: string[] }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/business`,
      { method: "PUT", body: JSON.stringify(body) }),

  // ── 인보이스(거래명세서) ──
  // 세금계산서가 아니다 — 그건 별도 발행 서비스가 필요하다.
  invoiceMonths: (tenantId: string) =>
    get<{ months: Array<{ month: string; paid: number; totalKrw: number }> }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/invoice-months`),
  invoice: (tenantId: string, month: string) =>
    get<{
      invoice: {
        number: string; monthKey: string; credits: number;
        supplyKrw: number; vatKrw: number; totalKrw: number;
        lines: Array<{ paymentId: string; date: string; desc: string; credits: number; amountKrw: number }>;
      };
      customer: { id: string; name: string; billingEmail: string | null; profile: BusinessProfile | null; incomplete: string[] };
      issuer: { name: string; bizNo: string; address: string; contact: string };
      issuerMissing: string[];
      note: string;
    }>(`/api/superadmin/tenants/${encodeURIComponent(tenantId)}/invoice?month=${encodeURIComponent(month)}`),

  // ── 결제 · 크레딧 ──
  payments: (tenant?: string) =>
    get<{ payments: Payment[] }>(
      `/api/superadmin/payments${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`),
  credits: (tenantId: string) =>
    get<{ entries: LedgerRow[]; balance: number; reasons: string[]; unit: string }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/credits`),
  adjustCredits: (tenantId: string, body: { delta: number; kind: string; note: string; reason?: string }) =>
    post<{ ok: true; delta: number; balance: number }>(
      `/api/superadmin/tenants/${encodeURIComponent(tenantId)}/credits`, body),

  jobs: (tenant?: string) =>
    get<{ jobs: AdminJob[] }>(
      `/api/superadmin/jobs${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`),
  retryJob: (id: string) => post<{ ok: true }>(`/api/superadmin/jobs/${encodeURIComponent(id)}/retry`),
  removeJob: (id: string) => del<{ ok: true }>(`/api/superadmin/jobs/${encodeURIComponent(id)}`),
  // 감사 로그는 필터(회사·검색·기간) 없이는 "누가 우리 회사를 봤나" 를 못 찾는다.
  audit: (opts: AuditQuery = {}) => {
    const qs = auditParams(opts);
    return get<{ entries: AuditEntry[] }>(`/api/superadmin/audit${qs ? `?${qs}` : ""}`);
  },
  // CSV 내려받기 — 쿠키 인증 fetch 로 Blob 을 받아 뷰가 다운로드한다(대량은 limit 상향).
  auditCsv: async (opts: AuditQuery = {}): Promise<Blob> => {
    const qs = auditParams({ limit: 5000, ...opts });
    const res = await fetch(`/api/superadmin/audit?${qs}&format=csv`, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, `CSV ${res.status}`);
    return res.blob();
  },
  // 사용 원가 · 충전 · 마진 (플랫폼/회사별)
  usage: (days = 30) => get<UsageSummary>(`/api/superadmin/usage?days=${days}`),
};

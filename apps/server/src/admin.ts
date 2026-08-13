/**
 * 플랫폼 관리자(superadmin) — admin.stepd.stepai.kr 이 쓰는 서버측 기반.
 *
 * ## 이 파일이 다루는 위험
 * superadmin 은 **테넌트 격리를 합법적으로 우회**하는 유일한 경로다(runAsSystem → RLS 의
 * '*' 스코프). 즉 0013/0014 로 세운 벽에 우리가 직접 낸 문이다. 그래서 세 가지를 강제한다:
 *
 *   1. 역할 확인 — `users.role = 'superadmin'` 인 **로그인 세션**에서만. API 키·헤더로는 못 연다.
 *   2. 사유 기록 — 남의 테넌트를 건드리는 호출은 `reason` 없이는 통과하지 못한다.
 *   3. 열람도 감사 — 쓰기만이 아니라 **읽기도** admin_audit 에 남는다. 유출 조사에서 정작
 *      알고 싶은 건 "누가 봤나"이기 때문이다.
 *
 * ## 왜 감사 기록 실패를 무시하지 않나
 * 감사 로그가 안 남는데 조회는 성공하면, 그 순간부터 기록은 "대체로 남는 것"이 되고
 * 증거로서의 가치가 사라진다. 그래서 기록 실패는 요청 실패다(아래 audit()).
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getRawPool } from "./db-pg.ts";
import { authRequired, type User } from "./auth.ts";

export function isSuperadmin(user: User | undefined): boolean {
  return user?.role === "superadmin" && user.status === "active";
}

/**
 * superadmin 전용 라우트 관문. 세션이 없거나 역할이 아니면 **404 가 아니라 403** 을 준다 —
 * 이 경로의 존재 자체는 비밀이 아니고, 403 이어야 운영자가 "권한 문제"임을 바로 안다.
 */
export function requireSuperadmin(c: Context<{ Variables: { user?: User } }>): User {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "login required" });
  if (!isSuperadmin(user)) throw new HTTPException(403, { message: "superadmin only" });
  return user;
}

/**
 * 기존 `/api/admin/*` 운영 라우트(reset · queue/purge · vm wake …)용 관문.
 *
 * 지금 이 라우트들은 **무인증**이고, AUTH_REQUIRED 도 기본 OFF 라 웹에 로그인 화면이 붙기
 * 전까지는 그대로 둬야 도구가 돈다. 그래서 "인증을 켠 순간 자동으로 엄격해지는" 형태로 만든다:
 *   · AUTH_REQUIRED off → 기존 동작 유지 (단일 테넌트라 지금은 이게 현상 유지다)
 *   · AUTH_REQUIRED on  → superadmin 세션 필수
 * 잊어버려서 영영 열려 있는 상태를 피하는 게 목적이다.
 */
export function requireOpsAccess(c: Context<{ Variables: { user?: User } }>): User | null {
  if (!authRequired()) return c.get("user") ?? null;
  return requireSuperadmin(c);
}

/**
 * ops 라우트 중 **머신(Cloud Scheduler·워커)도 호출**하는 것용 관문 (큐 통계·VM wake).
 * 내부 토큰으로 들어온 호출(`via === "internal"`)은 통과시키고, 그 외에는 `requireOpsAccess` 와 같다.
 * 스케줄러가 주기적으로 때리는 라우트가 AUTH_REQUIRED 를 켜는 순간 "세션 없음"으로 401 나서
 * VM 이 안 깨어나는 사고(머신엔 로그인 세션이 없다)를 막는다. via 는 호출부가 넘긴다.
 */
export function requireOpsOrInternal(
  c: Context<{ Variables: { user?: User } }>, via: string | undefined,
): User | null {
  if (via === "internal") return null;
  return requireOpsAccess(c);
}

export interface AuditEntry {
  action: string;
  targetTenant?: string | null;
  targetId?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * 감사 기록. **실패하면 던진다** — 기록되지 않은 관리자 행위를 성공으로 돌려주지 않는다.
 * 호출 순서는 항상 "기록 먼저, 작업 나중"이다. 반대로 하면 작업만 되고 기록이 빠지는 창이 생긴다.
 */
export async function audit(actor: User, entry: AuditEntry, ip?: string): Promise<void> {
  await getRawPool().query(
    `INSERT INTO admin_audit
       (actor_user_id, actor_email, action, target_tenant, target_id, reason, detail, ip, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [
      actor.id, actor.email, entry.action,
      entry.targetTenant ?? null, entry.targetId ?? null, entry.reason ?? null,
      JSON.stringify(entry.detail ?? {}), ip ?? null, Date.now(),
    ],
  );
}

/**
 * 남의 테넌트를 대상으로 하는 호출에 사유를 강제한다. 빈 문자열·공백은 사유가 아니다.
 * 자기 테넌트(=운영사 내부)를 볼 때는 요구하지 않는다 — 매번 사유를 적게 하면 사람들이
 * "확인"이라고만 쓰기 시작하고 기록의 의미가 죽는다.
 */
export function requireReason(actor: User, targetTenant: string | null | undefined, reason: unknown): string | null {
  if (!targetTenant || targetTenant === actor.tenantId) return typeof reason === "string" ? reason.trim() || null : null;
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 4) {
    throw new HTTPException(400, {
      message: "다른 회사의 데이터를 열람·변경하려면 사유(reason, 4자 이상)가 필요합니다.",
    });
  }
  return r;
}

export function clientIp(c: Context): string | undefined {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
}

/**
 * 로그인 — 이메일 + 비밀번호, 초대제.
 *
 * ## 왜 scrypt 인가 (argon2 가 아니라)
 * argon2 계열은 전부 네이티브 빌드가 딸린다. 이 리포는 Cloud Run 이미지 두 종(서버·워커) +
 * 로컬 Windows 에서 같은 코드를 돌리는데, 네이티브 모듈 하나가 그 셋 중 하나에서 깨지면
 * **로그인이 안 되는 게 아니라 서버가 안 뜬다.** node:crypto 의 scrypt 는 내장이라 그 실패
 * 모드가 없고, 파라미터(N=2^15)를 제대로 주면 OWASP 권장 범위에 든다. 나중에 argon2 로
 * 옮기더라도 해시 문자열에 알고리즘 접두사를 넣어뒀으므로 점진 교체가 된다.
 *
 * ## 저장 원칙
 * 비밀번호·세션토큰·초대토큰 어느 것도 평문으로 DB 에 두지 않는다. 토큰류는 조회 키가
 * sha256(원문)이라, DB 를 통째로 들고 가도 그것만으로는 로그인할 수 없다.
 *
 * ## 이 파일은 rawPool 을 쓴다
 * 세션 조회가 "요청이 어느 테넌트인가"를 **결정하는** 단계라, 테넌트 컨텍스트가 아직 없다.
 * 그래서 스코프 없는 풀로 읽는다(users/sessions/invites 는 RLS 대상이 아니다 · 0015 참조).
 * 대신 조회 조건이 곧 열쇠라 스코프 없이도 남의 것이 안 나온다.
 */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { getRawPool, type Queryable } from "./db-pg.ts";

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// N=32768·r=8·p=1 → 대략 50~100ms/회. 로그인 체감엔 지장 없고 대량 오프라인 크래킹엔 비싸다.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 64;

/**
 * `superadmin` 은 **테넌트 안의 역할이 아니라 플랫폼 역할**이다 — 전 테넌트를 가로지른다.
 * 그래서 초대(=테넌트 소속을 만드는 경로)로는 절대 부여되지 않고, `pnpm user:create` 로만 준다.
 * owner/admin/member 는 자기 테넌트 안에서만 의미를 갖는다.
 */
export type Role = "owner" | "admin" | "member" | "superadmin";

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  /** 워크스페이스 관리 권한 — 사람 초대·채널 연결·결제. */
  role: Role;
  /**
   * 방송 업무 권한 (editor|cp|pd|vendor · FLOWS F9) — 배포·승인·수익·범위.
   * `role` 과 **다른 질문에 답한다.** 판정은 ops-role.ts 가 한다(모르는 값 → vendor).
   */
  opsRole?: string;
  status: string;
}

// ── 비밀번호 ───────────────────────────────────────────────────────────────────

/** `scrypt$N$r$p$salt$key` — 알고리즘·파라미터를 같이 저장해 나중에 파라미터를 올릴 수 있게 한다. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * 저장된 해시와 대조. 형식이 깨졌거나 알고리즘이 낯설면 **false** 를 돌려준다(던지지 않는다) —
 * 실패 방향이 "로그인 거부"여야지, 500 으로 새어 나가면 안 된다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(keyB64, "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * 비밀번호 정책은 두지 않는다. B2B 운영자가 계정을 직접 발급하는 흐름이라
 * 길이·문자 종류를 강제하지 않고, 비어 있는 값만 막는다.
 */
export function passwordProblem(password: string): string | null {
  if (password.length === 0) return "비밀번호를 입력해 주세요.";
  return null;
}

// ── 토큰 ───────────────────────────────────────────────────────────────────────

function newToken(prefix: string): { raw: string; hash: string } {
  const raw = `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256(raw) };
}

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

export const SESSION_COOKIE = "stepd_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── 사용자 ─────────────────────────────────────────────────────────────────────

// ops_role 은 **워크스페이스 역할과 다른 축**이다(ops-role.ts 참조).
// 여기 한 줄에 넣어 두면 findUserByEmail·createUser·resolveSession 이 전부 같이 읽는다.
const USER_COLS = `id, tenant_id AS "tenantId", email, name, role, status, ops_role AS "opsRole"`;

/**
 * 로그인 대조용 조회. **소속 회사 상태까지 같이 읽는다** — 로그인 시점에 회사가 정지됐는지
 * 봐야 하는데, 여기서 안 읽으면 라우트가 쿼리를 한 번 더 쏘게 된다.
 * 회사 행이 없어도 사용자는 나와야 하므로 LEFT JOIN 이다(판정은 workspaceBlockReason 이 한다).
 */
export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string; tenantStatus: string | null }) | null> {
  const { rows } = await getRawPool().query(
    `SELECT u.id, u.tenant_id AS "tenantId", u.email, u.name, u.role, u.status,
            u.ops_role AS "opsRole", u.password_hash AS "passwordHash",
            t.status AS "tenantStatus"
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE LOWER(u.email) = LOWER($1)`,
    [email],
  );
  return (rows[0] as (User & { passwordHash: string; tenantStatus: string | null }) | undefined) ?? null;
}

/**
 * 워크스페이스 관리(멤버 초대·역할 변경·정지)를 할 수 있는 역할.
 * superadmin 은 플랫폼 역할이지만 자기 워크스페이스 안에서는 owner 처럼 행동한다 —
 * 안 그러면 사내 워크스페이스를 자기가 운영하지 못하는 이상한 상태가 된다.
 */
export function canManageWorkspace(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "superadmin";
}

/** 워크스페이스의 주인 급 — 역할 변경·owner 승격은 여기까지만 허용한다. */
export function isWorkspaceOwner(role: Role): boolean {
  return role === "owner" || role === "superadmin";
}

/**
 * 회사(워크스페이스)가 살아 있는가 — 막아야 하면 사유 문자열, 아니면 null.
 *
 * **미납·계약종료를 실제로 막는 지점이다.** 2026-08-11 이전에는 어드민의 정지 버튼이
 * `tenants.status` 행 하나만 바꾸고 끝이었다. 세션 검증도 로그인도 잡 큐도 그 값을 보지
 * 않아서, 정지된 회사 사람들이 아무 일 없이 계속 썼다. 버튼이 있는데 안 먹는 건
 * 없느니만 못하다.
 *
 * **superadmin 은 예외다.** 플랫폼 역할이라 테넌트를 가로지르고(이 파일 상단 Role 주석),
 * 자기 소속 워크스페이스가 정지되면 어드민 콘솔에 못 들어가서 **되돌릴 방법이 DB 직접
 * 접속밖에 없는 잠김**이 된다. 정지를 푸는 사람이 정지에 걸리면 안 된다.
 *
 * 테넌트 행을 못 찾으면(null) 막는다 — 모르면 막는 쪽이 안전하다. FK 가 있어서 정상
 * 경로에선 안 생기지만, 손으로 고친 행이나 미래에 추가될 상태값이 조용히 통과하면 곤란하다.
 */
export function workspaceBlockReason(
  tenantStatus: string | null | undefined,
  role: string | null | undefined,
): string | null {
  if (role === "superadmin") return null;
  if (tenantStatus === "active") return null;
  if (tenantStatus === "suspended") return "워크스페이스가 정지되었습니다. 담당자에게 문의해 주세요.";
  if (tenantStatus === "closed") return "종료된 워크스페이스입니다.";
  return "워크스페이스 상태를 확인할 수 없습니다.";
}

export async function createUser(input: {
  tenantId: string;
  email: string;
  name?: string;
  password: string;
  role?: Role;
  /**
   * 최소 길이 검사를 건너뛴다. **부트스트랩 CLI 전용** — 운영자가 명시적으로 택한 경우에만.
   * API 경로에서는 절대 쓰지 않는다(약한 비밀번호가 조용히 들어오는 문이 되면 안 된다).
   */
  allowWeakPassword?: boolean;
}, db?: Queryable): Promise<User> {
  const problem = input.allowWeakPassword ? null : passwordProblem(input.password);
  if (problem) throw new Error(problem);
  const id = `u_${crypto.randomBytes(9).toString("base64url")}`;
  const hash = await hashPassword(input.password);
  const { rows } = await (db ?? getRawPool()).query(
    `INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${USER_COLS}`,
    [id, input.tenantId, input.email.trim(), input.name ?? "", hash, input.role ?? "member", Date.now()],
  );
  return rows[0] as User;
}

export async function setPassword(userId: string, password: string, allowWeak = false): Promise<void> {
  const problem = allowWeak ? null : passwordProblem(password);
  if (problem) throw new Error(problem);
  await getRawPool().query("UPDATE users SET password_hash = $2 WHERE id = $1", [
    userId,
    await hashPassword(password),
  ]);
}

// ── 세션 ───────────────────────────────────────────────────────────────────────

/** 로그인 성공 시 발급. 원문 토큰은 여기서 딱 한 번 나가고 다시는 못 얻는다. */
export async function createSession(
  user: User,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiresAt: number }> {
  const { raw, hash } = newToken("sess");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await getRawPool().query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$4,$6,$7)`,
    [hash, user.id, user.tenantId, now, expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );
  await getRawPool().query("UPDATE users SET last_login_at = $2 WHERE id = $1", [user.id, now]);
  return { token: raw, expiresAt };
}

/**
 * 쿠키의 토큰 → 사용자. 만료·정지 계정은 null.
 * `last_seen_at` 갱신은 **하루 한 번만** 한다 — 매 요청 UPDATE 는 요청마다 쓰기를 만들고,
 * 마지막 접속 시각을 분 단위로 알아야 할 이유가 없다.
 */
export async function resolveSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const now = Date.now();
  const { rows } = await getRawPool().query(
    // ops_role 을 빼먹으면 세션이 undefined 를 주고, "모르면 가장 좁은 권한"이 걸려
    // **모든 로그인 사용자가 vendor 가 된다.** 판정은 옳은데 입력이 없던 사고.
    `SELECT u.id, u.tenant_id AS "tenantId", u.email, u.name, u.role, u.status,
            u.ops_role AS "opsRole", s.last_seen_at AS "lastSeenAt",
            t.status AS "tenantStatus"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(token), now],
  );
  const row = rows[0] as (User & { lastSeenAt: number; tenantStatus: string | null }) | undefined;
  if (!row || row.status !== "active") return null;
  // 회사가 정지되면 이미 로그인해 있던 사람도 여기서 끊긴다. 세션 파기(destroyTenantSessions)
  // 와 겹쳐 보이지만 둘 다 필요하다 — 파기는 정지 "시점"에 한 번, 이 검사는 그 뒤에 만들어진
  // 세션과 파기가 놓친 것까지 잡는 상시 그물이다. index.ts 의 app.use("*") 가 이 결과로
  // 401 을 내므로, 정지된 회사는 잡 큐잉을 포함해 **모든 요청**이 막힌다.
  if (workspaceBlockReason(row.tenantStatus, row.role)) return null;
  if (now - Number(row.lastSeenAt) > 24 * 60 * 60 * 1000) {
    await getRawPool()
      .query("UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1", [sha256(token), now])
      .catch(() => {});
  }
  // 필드를 하나씩 골라 담는다 — lastSeenAt 같은 내부 값이 세션 객체로 새지 않게.
  // ⚠️ 그래서 **새 필드를 User 에 추가하면 여기도 같이 고쳐야 한다.** ops_role 을 SELECT 에만
  // 넣고 여기를 빼먹어서, 로그인한 모든 사용자가 vendor 로 떨어졌다(2026-08-11).
  return {
    id: row.id, tenantId: row.tenantId, email: row.email, name: row.name,
    role: row.role, opsRole: row.opsRole, status: row.status,
  };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await getRawPool().query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

/** 비밀번호를 바꾸면 다른 기기의 세션은 전부 끊는다 — 탈취 대응의 핵심 동작. */
export async function destroyAllSessions(userId: string, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await getRawPool().query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [
      userId, sha256(exceptToken),
    ]);
  } else {
    await getRawPool().query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }
}

/**
 * 회사를 정지·종료할 때 그 회사 사람들을 즉시 끊는다. 끊은 세션 수를 돌려준다.
 *
 * 사용자 정지는 예전부터 `destroyAllSessions` 로 세션을 끊었는데 **회사 정지만 안 끊고
 * 있었다** — 상태 행만 바꾸니 이미 로그인한 사람은 그대로 쓰고 있었다.
 *
 * superadmin 세션은 남긴다. workspaceBlockReason 의 예외와 같은 이유로, 정지를 되돌릴
 * 사람까지 끊으면 잠긴다.
 */
export async function destroyTenantSessions(tenantId: string): Promise<number> {
  const { rowCount } = await getRawPool().query(
    `DELETE FROM sessions s USING users u
      WHERE u.id = s.user_id AND s.tenant_id = $1 AND u.role <> 'superadmin'`,
    [tenantId],
  );
  return rowCount ?? 0;
}

// ── 초대 ───────────────────────────────────────────────────────────────────────

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `db` 를 주면 그 연결에서 실행한다 — 회사 개설처럼 **초대까지 한 트랜잭션**으로 묶어야
 * 하는 경우에 쓴다(초대가 실패하면 회사도 안 만들어져야 한다). 안 주면 평소대로 풀에서.
 */
export async function createInvite(input: {
  tenantId: string;
  email: string;
  role?: Role;
  invitedBy?: string;
}, db?: Queryable): Promise<{ token: string; expiresAt: number; id: string }> {
  // 중복 검사는 커밋된 데이터만 보면 되므로 풀로 읽어도 된다.
  const existing = await findUserByEmail(input.email);
  if (existing) throw new Error("이미 계정이 있는 이메일입니다.");
  const { raw, hash } = newToken("inv");
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const id = `inv_${crypto.randomBytes(9).toString("base64url")}`;
  await (db ?? getRawPool()).query(
    `INSERT INTO invites (id, tenant_id, email, role, token_hash, invited_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.tenantId, input.email.trim(), input.role ?? "member", hash, input.invitedBy ?? null, now, expiresAt],
  );
  return { token: raw, expiresAt, id };
}

/**
 * 초대 수락 = 계정 생성. 한 번 쓰면 끝(accepted_at 기록).
 * 초대에 적힌 이메일·테넌트·역할을 그대로 쓴다 — 수락자가 바꿀 수 있으면 초대제가 무의미해진다.
 */
export async function acceptInvite(token: string, input: { name?: string; password: string }): Promise<User> {
  const now = Date.now();
  const { rows } = await getRawPool().query(
    `SELECT id, tenant_id AS "tenantId", email, role FROM invites
      WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
    [sha256(token), now],
  );
  const inv = rows[0] as { id: string; tenantId: string; email: string; role: Role } | undefined;
  if (!inv) throw new Error("초대가 유효하지 않거나 만료되었습니다.");

  const user = await createUser({
    tenantId: inv.tenantId,
    email: inv.email,
    name: input.name,
    password: input.password,
    role: inv.role,
  });
  // 계정이 만들어진 뒤에 소진 표시 — 순서가 반대면 계정 생성 실패 시 초대만 날아간다.
  await getRawPool().query("UPDATE invites SET accepted_at = $2 WHERE id = $1", [inv.id, now]);
  return user;
}

// ── 워크스페이스 멤버 ──────────────────────────────────────────────────────────

export interface Member extends User {
  createdAt: number;
  lastLoginAt: number | null;
}

export async function listMembers(tenantId: string): Promise<Member[]> {
  const { rows } = await getRawPool().query(
    `SELECT ${USER_COLS}, created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows as Member[];
}

export async function getMember(tenantId: string, userId: string): Promise<Member | null> {
  const { rows } = await getRawPool().query(
    `SELECT ${USER_COLS}, created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId],
  );
  return (rows[0] as Member | undefined) ?? null;
}

/**
 * 살아 있는 owner 급 계정 수. **마지막 owner 를 강등·정지·삭제하지 못하게** 막는 데 쓴다.
 * 주인 없는 워크스페이스가 되면 아무도 멤버를 초대할 수 없어 사람이 갇힌다 — 그 상태를
 * 만들 수 있는 경로를 아예 두지 않는다.
 */
export async function countActiveOwners(tenantId: string): Promise<number> {
  const { rows } = await getRawPool().query(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE tenant_id = $1 AND status = 'active' AND role IN ('owner','superadmin')`,
    [tenantId],
  );
  return rows[0].n as number;
}

export async function updateMember(
  tenantId: string,
  userId: string,
  patch: { role?: Role; status?: string },
): Promise<boolean> {
  const { rowCount } = await getRawPool().query(
    `UPDATE users SET role = COALESCE($3, role), status = COALESCE($4, status)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId, patch.role ?? null, patch.status ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export interface PendingInvite {
  id: string; email: string; role: Role; createdAt: number; expiresAt: number; invitedBy: string | null;
}

export async function listPendingInvites(tenantId: string): Promise<PendingInvite[]> {
  const { rows } = await getRawPool().query(
    `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt",
            invited_by AS "invitedBy"
       FROM invites
      WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC`,
    [tenantId, Date.now()],
  );
  return rows as PendingInvite[];
}

/** 초대 취소. 행을 지우지 않고 revoked_at 을 찍는다 — 누가 누구를 불렀다 취소했는지가 기록으로 남아야 한다. */
export async function revokeInvite(tenantId: string, inviteId: string): Promise<boolean> {
  const { rowCount } = await getRawPool().query(
    `UPDATE invites SET revoked_at = $3
      WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [tenantId, inviteId, Date.now()],
  );
  return (rowCount ?? 0) > 0;
}

export async function getWorkspace(tenantId: string): Promise<{
  id: string; name: string; kind: string; status: string; createdAt: number;
} | null> {
  const { rows } = await getRawPool().query(
    `SELECT id, name, kind, status, created_at AS "createdAt" FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export async function renameWorkspace(tenantId: string, name: string): Promise<void> {
  await getRawPool().query("UPDATE tenants SET name = $2 WHERE id = $1", [tenantId, name]);
}

export async function countUsers(): Promise<number> {
  const { rows } = await getRawPool().query("SELECT COUNT(*)::int AS n FROM users");
  return rows[0].n as number;
}

/**
 * 인증 강제 스위치. **기본 OFF** — 지금 웹에 로그인 화면이 없어서 ON 으로 두면 제품이 멈춘다.
 * 테넌트가 t_default 하나뿐인 동안 OFF 는 유출이 아니라 현상 유지다.
 * 다만 그 전제가 깨지는 순간(외부 테넌트 생성)에는 위험해지므로 index.ts 가 기동 시 점검한다.
 */
export function authRequired(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.AUTH_REQUIRED ?? "").trim().toLowerCase());
}

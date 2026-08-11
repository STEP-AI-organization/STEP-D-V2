/**
 * 기존 계정의 역할을 바꾼다. **superadmin 승격의 유일한 경로**다.
 *
 *   node --import tsx --env-file .env scripts/set-role.mts --email you@stepai.kr --role superadmin
 *
 * ## 왜 CLI 인가
 * `superadmin` 은 테넌트 안의 역할이 아니라 **플랫폼 역할**이라 전 회사를 가로지른다
 * (auth.ts Role 주석). 초대로는 절대 부여되지 않고, 어드민 콘솔에서도 못 준다 —
 * 콘솔 자체가 superadmin 전용이라 그걸 허용하면 **자기 권한을 자기가 늘리는 고리**가 생긴다.
 * 그래서 DB 에 직접 닿을 수 있는 사람만 줄 수 있게 CLI 로 남긴다.
 *
 * 프로덕션은 Cloud SQL 이 공인 IP 를 안 열어서 로컬에서 못 붙는다 —
 * `deploy/cloud.sh` 의 migrate 와 같은 방식으로 Cloud Run Job 에서 돌린다.
 */
import { initDb, getRawPool } from "../src/db-pg.ts";

const ROLES = ["owner", "admin", "member", "superadmin"] as const;
type Role = (typeof ROLES)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg("email") ?? "").trim();
  const role = (arg("role") ?? "").trim() as Role;

  if (!email || !role) {
    console.error("사용법: --email <이메일> --role owner|admin|member|superadmin");
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    console.error(`role 은 ${ROLES.join("|")} 중 하나여야 합니다 (받은 값: ${role})`);
    process.exit(1);
  }

  await initDb();
  const pool = getRawPool();

  const { rows } = await pool.query(
    `SELECT id, email, role, tenant_id AS "tenantId", status FROM users WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
  const user = rows[0];
  if (!user) {
    // 계정을 여기서 만들지 않는다 — 만드는 건 create-user.mts 다. 두 스크립트가 같은 일을
    // 하기 시작하면 어느 쪽이 무엇을 했는지 로그로 못 되짚는다.
    console.error(`계정을 찾을 수 없습니다: ${email} (먼저 create-user.mts 로 만드세요)`);
    process.exit(1);
  }
  if (user.role === role) {
    console.log(`이미 ${role} 입니다: ${user.email} · ${user.id} · tenant=${user.tenantId}`);
    process.exit(0);
  }

  // 마지막 주인을 강등하면 그 회사는 아무도 멤버를 초대할 수 없어 사람이 갇힌다.
  if (["owner", "superadmin"].includes(user.role) && !["owner", "superadmin"].includes(role)) {
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE tenant_id = $1 AND status = 'active' AND role IN ('owner','superadmin')`,
      [user.tenantId],
    );
    if ((cnt[0]?.n ?? 0) <= 1) {
      console.error(
        `${user.tenantId} 의 마지막 owner 급 계정입니다 — 강등하면 그 워크스페이스에 아무도 ` +
        `사람을 초대할 수 없게 됩니다. 다른 계정을 먼저 owner 로 올리세요.`,
      );
      process.exit(1);
    }
  }

  await pool.query("UPDATE users SET role = $2 WHERE id = $1", [user.id, role]);
  console.log(`역할 변경: ${user.email} · ${user.id} · ${user.role} → ${role} · tenant=${user.tenantId}`);

  // 역할이 바뀌면 기존 세션이 낡은 권한을 들고 있다. 다시 로그인하게 만든다 —
  // 승격이 즉시 먹지 않아서 "왜 아직 권한이 없지" 로 헤매는 걸 막는다.
  const { rowCount } = await pool.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
  console.log(`세션 ${rowCount ?? 0}개를 끊었습니다 — 다시 로그인하면 새 역할이 적용됩니다.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("실패:", err?.message ?? err);
  process.exit(1);
});

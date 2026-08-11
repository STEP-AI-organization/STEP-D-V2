/**
 * 첫 계정 만들기 — 워크스페이스 owner 한 명.
 *
 * 초대는 로그인한 관리자가 있어야 하는데 사용자가 0명이면 아무도 로그인할 수 없다.
 * 그 닭과 달걀을 푸는 **유일한 경로**다. 그래서 HTTP 라우트로 두지 않았다 —
 * `countUsers() === 0` 로 가드한 부트스트랩 엔드포인트는 그 자체로 영구적인 공격면이고,
 * 데이터를 지운 순간 남이 첫 계정을 가져갈 수 있다. CLI 는 DB 접근 권한이 있어야 돈다.
 *
 * 실행:
 *   DATABASE_URL=... npx tsx scripts/bootstrap-owner.mts <이메일> [이름]
 *
 * 비밀번호는 **인자로 받지 않는다** — 셸 히스토리와 프로세스 목록에 남는다.
 * stdin 으로 받는다:
 *   printf '%s' '비밀번호' | DATABASE_URL=... npx tsx scripts/bootstrap-owner.mts me@stepai.kr "이름"
 */
import { countUsers, createUser } from "../src/auth.ts";
import { initDb, closeDb, getRawPool } from "../src/db-pg.ts";
import { DEFAULT_TENANT_ID, runAsSystem } from "../src/tenant.ts";

async function readPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--allow-weak");
  // 운영자가 명시적으로 택할 때만. 첫 계정은 워크스페이스 전체 권한을 가지므로 기본은 막는다.
  const allowWeak = process.argv.includes("--allow-weak");
  const email = args[0];
  const name = args[1] ?? "";
  if (!email || !email.includes("@")) {
    console.error("사용법: printf '%s' '비밀번호' | npx tsx scripts/bootstrap-owner.mts <이메일> [이름]");
    process.exit(1);
  }

  const password = await readPassword();
  if (!password) {
    console.error("⛔ 비밀번호를 stdin 으로 넘겨야 한다 (인자로 주면 셸 히스토리에 남는다).");
    process.exit(1);
  }

  await initDb();

  await runAsSystem(async () => {
    const n = await countUsers();
    if (n > 0) {
      // **이미 사용자가 있으면 만들지 않는다.** 이 스크립트는 부트스트랩 전용이고,
      // 두 번째 계정부터는 초대로 만들어야 누가 누구를 불렀는지가 기록에 남는다.
      console.error(`⛔ 이미 사용자가 ${n}명 있다 — 두 번째부터는 초대(/api/workspace/invites)로 만들 것.`);
      process.exit(2);
    }

    const { rows } = await getRawPool().query(
      "SELECT id, name FROM tenants WHERE id = $1",
      [DEFAULT_TENANT_ID],
    );
    if (rows.length === 0) {
      console.error(`⛔ 워크스페이스(${DEFAULT_TENANT_ID})가 없다 — 마이그레이션 0013 이 안 돌았다.`);
      process.exit(3);
    }

    const user = await createUser({
      tenantId: DEFAULT_TENANT_ID,
      email,
      name,
      password,
      role: "owner",
      allowWeakPassword: allowWeak,
    });
    if (allowWeak) {
      console.warn("⚠️  --allow-weak: 비밀번호 길이 검사를 건너뛰었다. 이 계정은 워크스페이스");
      console.warn("    전체 권한(초대·채널 연결·결제)을 가진다 — 되도록 빨리 바꿀 것.");
    }

    // ops_role 은 0022 의 UPDATE 로 owner→cp 가 되지만, 그건 이미 있던 행만 대상이다.
    // 새로 만든 첫 계정에도 같은 규칙을 적용한다(운영 역할 = 방송 업무 권한).
    await getRawPool().query("UPDATE users SET ops_role = 'cp' WHERE id = $1", [user.id]);

    console.log(`✔ 첫 계정 생성: ${user.email}`);
    console.log(`  워크스페이스 : ${rows[0].name} (${DEFAULT_TENANT_ID})`);
    console.log(`  관리 역할    : owner (초대·채널 연결·결제)`);
    console.log(`  운영 역할    : cp (배포·승인·수익)`);
    console.log("");
    console.log("다음: AUTH_REQUIRED=1 로 켜고 재배포하면 로그인이 강제된다.");
  });

  await closeDb();
}

main().catch((e) => {
  console.error("⛔ 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});

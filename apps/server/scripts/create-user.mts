/**
 * 첫 계정(또는 추가 계정)을 만든다. **초대제라서 UI 로는 첫 사람을 만들 수 없다** —
 * 초대하려면 이미 로그인한 owner/admin 이 있어야 하기 때문이다. 그 닭과 달걀을 여기서 끊는다.
 *
 *   pnpm --filter @stepd/server exec node --import tsx --env-file .env \
 *     scripts/create-user.mts --email you@stepai.kr --role owner [--tenant t_default] [--name 이름]
 *
 * 비밀번호는 인자로 받지 않는다 — 셸 히스토리·프로세스 목록(ps)에 평문이 남기 때문이다.
 * 실행하면 stdin 으로 물어본다. 파이프로 넘겨도 된다:  echo '비밀번호' | node ... create-user.mts ...
 */
import readline from "node:readline";
import { initDb, getRawPool } from "../src/db-pg.ts";
import { createUser, findUserByEmail, passwordProblem, setPassword } from "../src/auth/auth.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    // 파이프 입력 — 첫 줄을 비밀번호로 본다.
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question("비밀번호(12자 이상): ", r));
  rl.close();
  return answer;
}

async function main() {
  const email = arg("email");
  // superadmin(플랫폼 관리자)은 **여기서만** 부여된다 — 초대로는 절대 만들어지지 않는다.
  const role = (arg("role") ?? "owner") as "owner" | "admin" | "member" | "superadmin";
  const tenantId = arg("tenant") ?? "t_default";
  const name = arg("name") ?? "";

  if (!email) {
    console.error("사용법: --email <이메일> [--role owner|admin|member] [--tenant t_xxx] [--name 이름]");
    process.exit(1);
  }
  if (!["owner", "admin", "member", "superadmin"].includes(role)) {
    console.error(`role 은 owner|admin|member|superadmin 중 하나여야 합니다 (받은 값: ${role})`);
    process.exit(1);
  }

  await initDb();

  const { rows } = await getRawPool().query("SELECT id FROM tenants WHERE id = $1", [tenantId]);
  if (!rows[0]) {
    console.error(`테넌트 ${tenantId} 가 없습니다. 먼저 tenants 에 추가하세요.`);
    process.exit(1);
  }

  const allowWeak = process.argv.includes("--allow-weak-password");
  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem && !allowWeak) {
    console.error(`${problem}\n(운영자가 의도한 것이면 --allow-weak-password 를 붙이세요.)`);
    process.exit(1);
  }
  // 약한 비밀번호를 **조용히** 통과시키지 않는다. 예외를 택했다는 사실이 로그에 남아야 한다.
  if (problem) console.warn(`⚠️  ${problem} — --allow-weak-password 로 진행합니다. 첫 로그인 후 변경하세요.`);

  const existing = await findUserByEmail(email);
  if (existing) {
    // 있는 계정이면 비밀번호 재설정으로 취급한다 — 잠긴 계정을 여는 유일한 경로이기도 하다.
    await setPassword(existing.id, password, allowWeak);
    console.log(`기존 계정 ${existing.email} (${existing.id}) 의 비밀번호를 재설정했습니다.`);
  } else {
    const user = await createUser({ tenantId, email, name, password, role, allowWeakPassword: allowWeak });
    console.log(`계정 생성: ${user.email} · ${user.id} · role=${user.role} · tenant=${user.tenantId}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("실패:", err?.message ?? err);
  process.exit(1);
});

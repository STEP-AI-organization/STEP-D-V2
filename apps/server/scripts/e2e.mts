/**
 * 서버 API e2e — **진짜 Postgres + 진짜 서버 프로세스**에 HTTP 로 묻는다.
 *
 * ## 왜 필요했나
 *
 * 서버 테스트 1671개는 전부 순수 함수이거나 소스 스캔이다. **DB 를 켜고 라우트를 타는
 * 테스트가 하나도 없었다.** 그 공백이 실제로 사고를 냈다 — `rls-access.test.ts` 주석:
 *
 *   "2026-08-11 에 API 키 3단계를 이렇게 배선해서 프로덕션에서 통째로 안 도는 상태로
 *    나갔다(순수·소스 테스트만 있어서 전부 통과했다)."
 *
 * 테넌트 격리는 **DB 안에서만** 증명된다. 정책이 `current_setting('app.tenant_id')` 를 읽고,
 * 그게 안 세워지면 에러가 아니라 **빈 결과**가 나온다. 소스를 아무리 읽어도 "정책이 실제로
 * 걸려 있고 실제로 남의 행을 막는다"는 알 수 없다.
 *
 * ## 이 스크립트가 CI 와 로컬에서 **같은 한 명령**인 이유
 *
 * CI 가 yaml 안에서 psql 로 역할을 만들고 마이그레이션을 돌리면, 로컬에서 재현할 때
 * 그 절차를 손으로 흉내내야 한다 — "내 컴에선 되는데"의 시작점이다. 그래서 DB·역할 생성부터
 * 서버 기동·정리까지 전부 여기 넣었다. CI 는 **Postgres 를 하나 띄워 주기만** 한다.
 *
 *   pnpm --filter @stepd/server test:e2e
 *
 * 로컬에 Postgres 가 없으면:
 *   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres --name stepd-e2e-pg pgvector/pgvector:pg16
 *
 * ## ⚠️ 전용 역할을 만드는 이유 — 이게 없으면 격리 테스트가 **거짓 통과**한다
 *
 * `assertRlsEnforced()`(db-pg.ts)는 접속 역할에 BYPASSRLS/SUPERUSER 가 있으면 격리가 없다고
 * 경고하는데, **DSN 이 localhost 면 경고만 하고 계속 간다.** CI 의 Postgres 는 당연히
 * localhost 고 기본 계정은 superuser 다. 그대로 쓰면 RLS 정책이 통째로 무시돼서
 * "격리가 된다"가 아니라 "격리를 안 켜고 통과"가 된다.
 *
 * 그래서 NOSUPERUSER·NOBYPASSRLS 역할을 따로 만들어 그걸로 접속한다. 표에는 FORCE RLS 가
 * 걸려 있어 **소유자에게도** 정책이 적용된다 — 프로덕션과 같은 조건이다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 관리자 접속 — 역할과 DB 를 만들 때만 쓴다. 서버는 절대 이걸로 붙지 않는다. */
const ADMIN_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const DB_NAME = "stepd_e2e";
const APP_ROLE = "stepd_e2e_app";
const APP_PASSWORD = "e2e_only_not_a_secret";
const PORT = Number(process.env.E2E_PORT ?? 4100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** 부트스트랩 superadmin — 회사(워크스페이스)를 만들 수 있는 유일한 역할. */
export const SUPERADMIN = { email: "super@e2e.local", password: "e2e-superadmin-pw" };

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

/** 관리자 자격 그대로, 붙는 DB 만 바꾼 접속 문자열. */
function adminUrlFor(db: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${db}`;
  return url.toString();
}

/** 관리자 커넥션으로 깨끗한 DB + 격리 전용 역할을 만든다. */
async function resetDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    console.error(
      `[e2e] 관리자 DB 에 접속하지 못했습니다: ${ADMIN_URL.replace(/:[^:@]*@/, ":***@")}\n` +
        `      Postgres 를 띄우거나 E2E_ADMIN_DATABASE_URL 을 지정하세요:\n` +
        `      docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres --name stepd-e2e-pg pgvector/pgvector:pg16`,
    );
    throw e;
  }

  try {
    // 이전 실행이 남긴 것을 지운다 — e2e 는 **매번 빈 DB 에서** 시작해야 재현된다.
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    // ⚠️ NOSUPERUSER NOBYPASSRLS — 위 주석의 "거짓 통과" 를 막는 핵심이다. 지우지 말 것.
    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await admin.query(
      `CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD '${APP_PASSWORD}'`,
    );
    // 마이그레이션이 표를 만들어야 하므로 DB 소유자로 준다. FORCE RLS 라 소유자도 정책을 탄다.
    await admin.query(`CREATE DATABASE ${DB_NAME} OWNER ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  // 확장은 **관리자가 미리** 깔아 둔다. `CREATE EXTENSION vector` 는 superuser 를 요구하는데
  // 우리 앱 역할은 일부러 NOSUPERUSER 라 직접 못 만든다. 프로덕션 Cloud SQL 도 같은 구조다 —
  // 확장은 특권 역할이 깔아 두고 앱은 쓰기만 한다. 마이그레이션의 `IF NOT EXISTS` 가
  // 이미 있는 확장을 만나면 권한 검사 전에 통과하므로 그대로 지나간다.
  const bootstrap = new pg.Client({ connectionString: adminUrlFor(DB_NAME) });
  await bootstrap.connect();
  try {
    await bootstrap.query("CREATE EXTENSION IF NOT EXISTS vector");   // 검색 임베딩 768d
    await bootstrap.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");  // 키워드축 폴백
  } finally {
    await bootstrap.end();
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  log(`DB 준비 완료 — ${DB_NAME} (역할 ${APP_ROLE}: NOSUPERUSER·NOBYPASSRLS)`);
  return url.toString();
}

/**
 * 자식 프로세스를 돌리고 종료 코드를 준다.
 *
 * ⚠️ **`shell: true` 를 쓰지 않는다.** `.bin` 셔임(.cmd)을 부르려고 윈도우에서 셸을 켰더니
 * cmd.exe 가 인자를 다시 해석해서 `--ignore-pattern "(?!\d{4}_.*\.cjs$).*"` 가 통째로
 * 깨졌다(2026-09-11 실측: 마이그레이션이 exit 255). 셔임 대신 **패키지의 JS 진입점을
 * node 로 직접** 부르면 셸이 끼지 않아 윈도우·리눅스가 같게 돈다.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** 서버가 /health 에 응답할 때까지 기다린다. */
async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`서버가 ${timeoutMs}ms 안에 뜨지 않았습니다 (마지막 오류: ${String(lastErr)})`);
}

async function main(): Promise<void> {
  const databaseUrl = await resetDatabase();

  // 서버가 로컬 모드로 쓸 임시 저장소. GCS_BUCKET 을 안 주므로 여기로 떨어진다.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "stepd-e2e-"));

  const serverEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: databaseUrl,
    PORT: String(PORT),
    // 프로덕션과 같게 로그인을 강제한다(cloudbuild.yaml `_AUTH_REQUIRED: "1"`).
    AUTH_REQUIRED: "1",
    STEPD_STORAGE_DIR: storageDir,
    // ⚠️ 송출 게이트는 **전부 끈 채로** 둔다. e2e 가 실수로 바깥에 무언가를 올리면 안 된다.
    YOUTUBE_UPLOAD_ENABLED: "",
    TIKTOK_UPLOAD_ENABLED: "",
    NAVER_UPLOAD_ENABLED: "",
    INSTAGRAM_UPLOAD_ENABLED: "",
    FACEBOOK_UPLOAD_ENABLED: "",
    COMMERCE_LINKS_ENABLED: "",
    // 메일도 나가면 안 된다 — SMTP 미설정이면 mailer.ts 가 조용히 건너뛴다.
    SMTP_HOST: "",
    SMTP_USER: "",
  };

  log("마이그레이션 (node-pg-migrate)…");
  const migrateCode = await run(
    process.execPath,
    [
      path.join(SERVER_DIR, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js"),
      "up",
      "--migrations-dir", "migrations",
      "--migrations-table", "pgmigrations",
      "--ignore-pattern", "(?!\\d{4}_.*\\.cjs$).*",
    ],
    { DATABASE_URL: databaseUrl },
  );
  if (migrateCode !== 0) throw new Error(`마이그레이션 실패 (exit ${migrateCode})`);

  log("부트스트랩 superadmin 생성…");
  // DATABASE_URL 을 세운 **뒤에** import 한다 — db-pg 가 모듈 로드 시점의 env 를 본다.
  process.env.DATABASE_URL = databaseUrl;
  const { initDb, closeDb } = await import("../src/db-pg.ts");
  const { createUser } = await import("../src/auth/auth.ts");
  await initDb();
  await createUser({
    tenantId: "t_default",           // 0013_tenants.cjs 가 만든다
    email: SUPERADMIN.email,
    name: "e2e superadmin",
    password: SUPERADMIN.password,
    role: "superadmin",             // 회사 개설은 이 역할로만 된다
    allowWeakPassword: true,
  });
  await closeDb();

  log(`서버 기동 (:${PORT})…`);
  let server: ChildProcess | undefined;
  let testCode = 1;
  try {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      { cwd: SERVER_DIR, env: { ...process.env, ...serverEnv }, stdio: "inherit" },
    );
    server.on("exit", (code, signal) => {
      // 테스트 도중 서버가 죽으면 조용히 전부 실패한다 — 그 사실을 눈에 보이게 찍는다.
      if (!shuttingDown) console.error(`[e2e] ⚠️ 서버가 먼저 종료됐습니다 (code=${code} signal=${signal})`);
    });
    await waitForHealth();
    log("서버 준비됨 — 테스트 실행");

    testCode = await run(
      process.execPath,
      ["--import", "tsx", "--test", "src/tests/e2e/**/*.e2e.ts"],
      { E2E_BASE_URL: BASE_URL, DATABASE_URL: databaseUrl },
    );
  } finally {
    shuttingDown = true;
    if (server && server.exitCode === null) server.kill("SIGTERM");
    fs.rmSync(storageDir, { recursive: true, force: true });
  }

  process.exit(testCode);
}

let shuttingDown = false;

main().catch((e) => {
  console.error("[e2e] 실패:", e);
  process.exit(1);
});

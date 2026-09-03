/**
 * 화면 없이 챗봇·리포트를 돌려 보는 CLI.
 *
 *   pnpm --filter @stepd/server chatbot:ask "자동배포는 어디서 켜요?"
 *   pnpm --filter @stepd/server chatbot:ask --screen /automation "여기서 뭘 하면 되나요?"
 *   pnpm --filter @stepd/server chatbot:ask --thread th_1234 "그럼 그건 어디서 봐요?"
 *   pnpm --filter @stepd/server chatbot:ask --report "8월 채널 성과 보고서"
 *
 * ## 왜 필요한가
 *
 * 위젯은 프론트 개편 뒤에 붙는다. 그때까지 답변 품질을 확인할 방법이 없으면 **도움말 문서가
 * 실제로 쓸모 있는지**를 아무도 모르는 채로 시간이 간다. 답의 품질은 문서의 품질이라,
 * 문서를 고치고 바로 물어볼 수 있는 자리가 있어야 한다.
 *
 * 사용자는 `CHATBOT_USER_EMAIL` 로 고르고, 없으면 그 워크스페이스의 첫 사용자를 쓴다 —
 * 대화·리포트가 사람 단위로 남기 때문에 아무나로 돌리면 남의 목록이 지저분해진다.
 */
import { initDb, getRawPool } from "../src/db-pg.ts";
import { runWithTenant, DEFAULT_TENANT_ID } from "../src/auth/tenant.ts";
import { ask } from "../src/chatbot/agent.ts";
import { buildReport } from "../src/report/index.ts";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const threadId = flag("thread");
const screen = flag("screen");
const reportMode = argv.includes("--report");
const message = argv.filter((a, i) =>
  !a.startsWith("--") && argv[i - 1] !== "--thread" && argv[i - 1] !== "--screen").join(" ").trim();

if (!message) {
  console.error('사용법: chatbot:ask [--thread <id>] [--screen /automation] [--report] "질문"');
  process.exit(1);
}

await initDb();

// 사용자 찾기. users 는 RLS 대상이 아니라 스코프 없는 풀로 읽는다(rls-access.test.ts 주석).
const wanted = process.env.CHATBOT_USER_EMAIL?.trim().toLowerCase();
const { rows } = await getRawPool().query(
  wanted
    ? `SELECT id, tenant_id AS "tenantId", email, role FROM users WHERE lower(email) = $1 LIMIT 1`
    : `SELECT id, tenant_id AS "tenantId", email, role FROM users
        WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
  wanted ? [wanted] : [],
);
const user = rows[0];
if (!user) {
  console.error("사용자를 찾을 수 없다. CHATBOT_USER_EMAIL 을 지정하거나 먼저 사용자를 만들 것.");
  process.exit(1);
}
console.log(`· ${user.email} (${user.role}) · 워크스페이스 ${user.tenantId}\n`);

const actor = { id: user.id, tenantId: user.tenantId ?? DEFAULT_TENANT_ID, role: user.role };
const started = Date.now();

await runWithTenant({ scope: actor.tenantId, via: "web" }, async () => {
  if (reportMode) {
    const built = await buildReport(actor, message);
    console.log(built.markdown);
    if (built.warnings.length) console.log(`\n⚠️ ${built.warnings.join("\n⚠️ ")}`);
    console.log(`\n(리포트 ${built.reportId} · ${((Date.now() - started) / 1000).toFixed(1)}초)`);
    return;
  }

  const out = await ask({ user: actor, threadId, message, screen });
  console.log(out.reply);
  if (out.links.length) {
    console.log("\n링크:");
    for (const l of out.links) console.log(`  · ${l.label} → ${l.href}`);
  }
  if (out.report) {
    console.log(`\n─── 보고서 초안 (${out.report.id}) ───\n`);
    console.log(out.report.markdown);
    if (out.report.warnings.length) console.log(`\n⚠️ ${out.report.warnings.join("\n⚠️ ")}`);
  }
  console.log(
    `\n(대화 ${out.threadId} · 참고 문서 ${out.usedDocs.join(", ") || "없음"}` +
    ` · ${((Date.now() - started) / 1000).toFixed(1)}초)`,
  );
  console.log(`이어서 물으려면: --thread ${out.threadId}`);
});

process.exit(0);

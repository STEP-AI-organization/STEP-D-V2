/**
 * 평가셋을 돌려 채점한다 — 엑셀을 읽고, 진짜 챗봇에 물어보고, 결과를 md 로 떨군다.
 *
 *   pnpm --filter @stepd/server eval:run              전체
 *   pnpm --filter @stepd/server eval:run -- --only U  ID 가 U 로 시작하는 것만
 *   pnpm --filter @stepd/server eval:run -- --dry     모델을 안 부르고 표만 검사(무료)
 *   pnpm --filter @stepd/server eval:run -- --no-judge 기계 채점만(싸게)
 *
 * ## 왜 이게 있어야 하나
 *
 * 평가셋만 있고 돌릴 것이 없으면 그 표는 금방 낡는다. **고칠 때마다 같은 질문을 다시
 * 던져 숫자가 오르는지 보는 것**이 이 파일의 전부다.
 *
 * ## 무엇을 채점하나
 *
 *   기계   필수 링크 · 기대 문서 · 기대 도구 + **금칙어(전역)**
 *          — 사실만 본다. 싸고 확실하지만 "이 답이 물음에 맞나" 는 못 본다.
 *   심판   기대 동작 대비 O/△/X (모델이 판정 · `--no-judge` 로 끔)
 *          — 첫 실행에서 **맞는 답 9건이 '링크 없음' 으로 실패**로 찍혔다. 기계 축만 보면
 *            점수가 거짓말을 한다. 두 숫자를 같이 봐야 무엇을 고칠지가 갈린다.
 *
 * 리포트 시트는 **자동 채점이 100%** 다. 자연어 → 스펙은 출력이 구조화돼 있어서
 * 정답이 하나로 떨어진다.
 *
 * ⚠️ 모델을 부르므로 **돈이 든다.** 시작 전에 예상 호출 수를 찍고, `--dry` 로 표만
 * 점검할 수 있게 해 뒀다.
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { REPO_ROOT } from "../src/repo-root.ts";
import { initDb, getRawPool } from "../src/db-pg.ts";
import { runWithTenant, DEFAULT_TENANT_ID } from "../src/auth/tenant.ts";
import { ask } from "../src/chatbot/agent.ts";
import { geminiChat, parseJsonLoose } from "../src/ai/gemini.ts";
import { SUPPORT, SUPPORT_LOCATION } from "../src/ai/models.ts";
import { normalizeSpec, parseSpec } from "../src/report/spec.ts";

// ── 아주 작은 xlsx 읽기 ─────────────────────────────────────────────────────────
//
// 우리가 쓴 파일은 inlineStr 이지만, **사람이 엑셀에서 저장하면 sharedStrings 로 바뀐다.**
// 둘 다 읽어야 한다 — 안 그러면 "편집하면 러너가 빈 표를 본다" 는 함정이 생긴다.

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};
function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** `<t>` 안의 글자만 이어 붙인다(리치 텍스트는 `<r><t>` 조각으로 쪼개져 온다). */
function textOf(xml: string): string {
  return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join("");
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheets(file: string): Map<string, string[][]> {
  const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const get = (p: string) => (zip[p] ? strFromU8(zip[p]) : "");

  const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  // 시트 이름 → 파일. workbook 의 순서와 rels 의 대상 파일을 맞춘다.
  const rels = new Map(
    [...get("xl/_rels/workbook.xml.rels").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map((m) => [m[1], m[2].replace(/^\/?xl\//, "")]),
  );
  const out = new Map<string, string[][]>();

  for (const m of get("xl/workbook.xml").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const target = rels.get(m[2]);
    if (!target) continue;
    const xml = get(`xl/${target}`);
    const rows: string[][] = [];
    for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      // ⚠️ **빈 셀은 자기닫힘(`<c r="D2" s="2"/>`)으로 온다.** 이걸 따로 받지 않으면
      //    여는 태그로 오인해 **다음 셀의 값까지 삼킨다** — 열이 통째로 한 칸씩 밀려서
      //    "입력이 비었다" 같은 엉뚱한 증상으로 나타난다(실측 2026-09-03).
      for (const cm of rm[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[2];
        const inner = cm[3] ?? "";
        let value = "";
        if (/t="s"/.test(attrs)) {
          const idx = Number(/<v>(\d+)<\/v>/.exec(inner)?.[1] ?? -1);
          value = shared[idx] ?? "";
        } else if (/t="inlineStr"/.test(attrs)) {
          value = textOf(inner);
        } else {
          value = unesc(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        }
        cells[colIndex(cm[1])] = value.trim();
      }
      rows[Number(rm[1]) - 1] = Array.from(cells, (v) => v ?? "");
    }
    out.set(unesc(m[1]), rows.filter(Boolean).map((r) => Array.from(r, (v) => v ?? "")));
  }
  return out;
}

/** 머리글 행을 키로 한 객체 배열. 열 순서가 바뀌어도 읽힌다(사람이 엑셀에서 옮길 수 있다). */
function asRecords(rows: string[][]): Record<string, string>[] {
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1)
    .filter((r) => r.some((c) => (c ?? "").trim()))
    // 머리글 아래 회색 안내 행은 데이터가 아니다. ID 가 "(…)" 로 시작하는 행은 건너뛴다 —
    // 지우고 쓰라고 안내해 두었지만, 안 지우고 채우기 시작해도 채점이 깨지지 않게.
    .filter((r) => !/^\(/.test((r[0] ?? "").trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const list = (v: string) => (v ?? "").split(";").map((s) => s.trim()).filter(Boolean);

// ── 채점 ────────────────────────────────────────────────────────────────────────

interface Check { axis: string; ok: boolean; detail: string }

/**
 * 어떤 답에도 나오면 안 되는 **내부 사실**. 표가 아니라 여기 있는 이유: 모든 행에 같은 값을
 * 적던 열이었고, 그건 열이 아니라 규칙이다.
 *
 * ⚠️ **흔한 낱말을 넣지 말 것.** "서버" 를 넣었더니 *"서버 위치는 알 수 없습니다"* 라는
 * **옳은 거절**이 실패로 찍혔다(실측 2026-09-03). 오탐이 나면 사람이 검사를 느슨하게
 * 고치게 되고, 그러면 진짜가 샌다. 경계는 `(?<!회)원가` 처럼 정확히 긋는다.
 */
const BANNED: RegExp[] = [
  /(?<!회)원가/, /마진/, /gemini/i, /vertex/i, /cloud run/i, /flash-lite/i, /pgvector/i,
];

function scoreChat(
  row: Record<string, string>,
  got: { reply: string; links: { href: string }[]; usedDocs: string[]; toolsUsed: string[] },
): Check[] {
  const checks: Check[] = [];
  const hrefs = got.links.map((l) => l.href);

  const must = list(row["필수 링크"]);
  if (must.length) {
    const missing = must.filter((h) => !hrefs.some((x) => x === h || x.startsWith(`${h}/`)));
    checks.push({ axis: "필수 링크", ok: !missing.length, detail: missing.length ? `빠짐: ${missing.join(", ")}` : "" });
  }

  const docs = list(row["기대 문서"]);
  if (docs.length) {
    const missing = docs.filter((d) => !got.usedDocs.includes(d));
    checks.push({ axis: "기대 문서", ok: !missing.length, detail: missing.length ? `안 실림: ${missing.join(", ")} (실제 ${got.usedDocs.join(",") || "없음"})` : "" });
  }

  const tool = (row["기대 도구"] ?? "").trim();
  if (tool) {
    const want = tool === "없음" ? [] : list(tool);
    const ok = want.length
      ? want.every((t) => got.toolsUsed.includes(t))
      : got.toolsUsed.length === 0;
    checks.push({ axis: "기대 도구", ok, detail: ok ? "" : `실제 ${got.toolsUsed.join(",") || "없음"}` });
  }

  // 금칙어는 **표에 없다** — 모든 답에 같은 규칙이라 행마다 적을 이유가 없었다.
  const leaked = BANNED.filter((w) => w.test(got.reply));
  if (leaked.length) {
    checks.push({
      axis: "금칙어",
      ok: false,
      detail: `나옴: ${leaked.map((w) => w.source).join(", ")}`,
    });
  }

  return checks;
}

// ── 심판 — 기계가 못 보는 것을 본다 ─────────────────────────────────────────────
//
// 기계 채점은 **사실**만 본다: 링크가 실재하나, 금칙어가 새나, 도구를 옳게 골랐나.
// 그건 싸고 확실하지만, "이 답이 물음에 맞나" 는 못 본다 — 실제로 첫 실행에서 **맞는 답
// 9건이 '링크 없음' 으로 실패로 찍혔다.** 기준을 기계에 맞춰 조이면 점수가 거짓말을 한다.
//
// 그래서 내용 판정은 모델에게 맡긴다. 사람이 표에 적어 둔 '기대 동작' 과 실제 답을 나란히
// 주고 O/△/X 를 받는다. 사람이 매번 읽지 않아도 되고, 기계 축은 회귀 방지로 남는다.

const JUDGE_RULES = [
  "너는 고객지원 챗봇의 답변을 채점한다. 아래 '기대 동작' 은 사람이 미리 적어 둔 기준이다.",
  "",
  "판정:",
  "  O — 기대한 내용을 담고 있다. 표현이 달라도 된다.",
  "  △ — 틀리진 않았지만 핵심을 빠뜨렸거나 군더더기가 많다.",
  "  X — 틀렸거나, 묻지 않은 것을 답했거나, 지어냈다.",
  "",
  "말투·길이·링크 유무로 깎지 마라. **내용이 맞는지만** 본다.",
  "맨 앞에 '실제로 일어난 일' 이 적혀 있으면 그것도 답의 일부로 쳐라 —",
  "보고서가 만들어졌다면 '만들었습니다' 라는 짧은 답도 옳은 응답이다.",
  "reason 은 한 문장. JSON 만 출력한다.",
].join("\n");

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["O", "△", "X"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
};

/**
 * `context` 는 **답변 글자만으로는 알 수 없는 사실**을 심판에게 알려 준다.
 *
 * 실측 2026-09-03: 보고서 요청에 봇이 옳게 make_report 를 부르고 "초안을 만들었습니다" 라고
 * 답했는데, 심판이 *"직접적인 응답이 아니다"* 로 X 를 줬다 — 화면에 보고서 카드가 붙는다는
 * 걸 심판은 볼 수 없기 때문이다. 심판에게도 그 사실을 줘야 사람과 같은 판단을 한다.
 */
async function judge(
  input: string, expect: string, reply: string, context = "",
): Promise<{ verdict: string; reason: string }> {
  if (!reply) return { verdict: "X", reason: "답변이 비었다" };
  try {
    const out = await geminiChat(
      [{ role: "user", parts: [{ text: `${context ? `${context}

` : ""}물음: ${input}

기대 동작: ${expect}

실제 답변:
${reply}` }] }],
      { system: JUDGE_RULES, model: SUPPORT, location: SUPPORT_LOCATION, schema: JUDGE_SCHEMA, temperature: 0, maxOutputTokens: 300 },
    );
    const j = parseJsonLoose(out.text) as { verdict?: string; reason?: string };
    return { verdict: j.verdict ?? "?", reason: j.reason ?? "" };
  } catch (e) {
    return { verdict: "?", reason: `심판 실패: ${String(e).slice(0, 80)}` };
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : "";
const dry = argv.includes("--dry");
const withJudge = !argv.includes("--no-judge");

const BOOK = path.join(REPO_ROOT, "docs", "eval", "chatbot-evalset.xlsx");
if (!fs.existsSync(BOOK)) {
  console.error(`평가셋이 없다: ${BOOK}\n먼저 만들 것:  pnpm --filter @stepd/server eval:make`);
  process.exit(1);
}

const sheets = readSheets(BOOK);

/** 시트 이름을 **부분일치**로 찾는다 — 사람이 "챗봇(v2)" 처럼 바꿔도 계속 읽히게. */
function sheetNamed(part: string): string[][] {
  for (const [name, rows] of sheets) if (name.includes(part)) return rows;
  return [];
}

const chatRows = asRecords(sheetNamed("챗봇")).filter((r) => !only || r.ID?.startsWith(only));
const reportRows = asRecords(sheetNamed("리포트")).filter((r) => !only || r.ID?.startsWith(only));

console.log(`평가셋: 챗봇 ${chatRows.length}행 · 리포트 ${reportRows.length}행`);
if (!chatRows.length && !reportRows.length) {
  console.error("읽을 행이 없다 — 시트 이름(챗봇/리포트)이나 머리글이 바뀌었는지 확인할 것.");
  process.exit(1);
}

// 모델 호출 수 = 챗봇 행 + 리포트 행 + (심판을 켰으면) 챗봇 행. 돈이 드는 일이라 먼저 밝힌다.
const calls = chatRows.length + reportRows.length + (withJudge ? chatRows.length : 0);
console.log(`예상 모델 호출 ${calls}회 (도구·재시도 제외) · 대략 ₩${Math.round(calls * 4)} 안팎\n`);
if (dry) {
  console.log("--dry: 표만 읽고 끝낸다. 각 행의 필수 열이 채워졌는지만 본다.\n");
  let bad = 0;
  for (const r of chatRows) {
    const problems: string[] = [];
    if (!r["입력(사용자 질문)"]) problems.push("입력 없음");
    if (!r["기대 동작(사람이 채점)"]) problems.push("기대 동작 없음");
    for (const col of ["반드시 포함", "절대 금지", "금지 링크", "선행 질문"]) {
      if (r[col]) problems.push(`'${col}' 열은 없어졌다 — 지워도 된다`);
    }
    if (problems.length) { bad++; console.log(`  ✗ ${r.ID}: ${problems.join(" · ")}`); }
  }
  console.log(bad ? `\n${bad}행이 비어 있다.` : "\n모든 행에 입력과 기대 동작이 있다.");
  process.exit(0);
}

await initDb();
const { rows: users } = await getRawPool().query(
  `SELECT id, tenant_id AS "tenantId", role FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
);
const u = users[0];
if (!u) { console.error("사용자가 없다. 먼저 계정을 만들 것(scripts/create-user.mts)."); process.exit(1); }
const actor = { id: u.id, tenantId: u.tenantId ?? DEFAULT_TENANT_ID, role: u.role };

interface Result {
  id: string; kind: string; input: string; expect: string;
  reply: string; checks: Check[]; error?: string;
  verdict?: string; judgeReason?: string;
}
const results: Result[] = [];
const started = Date.now();

await runWithTenant({ scope: actor.tenantId, via: "web" }, async () => {
  for (const row of chatRows) {
    const input = row["입력(사용자 질문)"];
    const screen = row["화면(screen)"] || null;
    process.stdout.write(`  ${row.ID} ${input.slice(0, 28)}… `);
    try {
      // 행마다 **새 대화**다. 이어지는 대화를 표로 검증하는 건 과하다고 판단해 뺐다
      // (2026-09-03) — 호출이 두 배가 되는데, 맥락 유지는 실제로 써 보면 바로 드러난다.
      const got = await ask({ user: actor, threadId: null, message: input, screen });
      const checks = scoreChat(row, got);
      const pass = checks.every((c) => c.ok);
      // 답변 글자 밖에서 실제로 일어난 일 — 심판이 이걸 모르면 옳은 동작을 깎는다.
      const facts: string[] = [];
      if (got.report) facts.push(`이 턴에 보고서 초안이 실제로 만들어져 화면에 함께 표시됐다: "${got.report.title}" (${got.report.period}).`);
      if (got.toolsUsed.length) facts.push(`부른 도구: ${got.toolsUsed.join(", ")}.`);
      const verdict = withJudge
        ? await judge(input, row["기대 동작(사람이 채점)"], got.reply, facts.join(" "))
        : null;
      results.push({
        id: row.ID, kind: row["분류"], input, expect: row["기대 동작(사람이 채점)"],
        reply: got.reply, checks,
        ...(verdict ? { verdict: verdict.verdict, judgeReason: verdict.reason } : {}),
      });
      console.log(`${pass ? "통과" : `실패 (${checks.filter((c) => !c.ok).map((c) => c.axis).join(", ")})`}` +
        (verdict ? ` · 심판 ${verdict.verdict}` : ""));
    } catch (e) {
      results.push({
        id: row.ID, kind: row["분류"], input, expect: row["기대 동작(사람이 채점)"],
        reply: "", checks: [], error: String(e instanceof Error ? e.message : e),
      });
      console.log("오류");
    }
    // 분당 상한(10회)에 걸리지 않게 — 평가가 제 방어선에 막히면 아무것도 못 잰다.
    await new Promise((r) => setTimeout(r, 6_500));
  }
});

// ── 리포트 시트: 자연어 → 스펙 ──────────────────────────────────────────────────

interface SpecResult { id: string; input: string; want: string; got: string; ok: boolean }
const specResults: SpecResult[] = [];
for (const row of reportRows) {
  const today = row["기준일(오늘)"];
  const now = new Date(`${today}T12:00:00+09:00`);
  process.stdout.write(`  ${row.ID} ${row["입력(요청문)"].slice(0, 24)}… `);
  const spec = await parseSpec(row["입력(요청문)"], now);
  const want = normalizeSpec(
    { kind: row["기대 종류"], from: row["기대 시작일"], to: row["기대 종료일"], title: "x" }, now,
  );
  const ok = spec.kind === want.kind && spec.from === want.from && spec.to === want.to;
  specResults.push({
    id: row.ID, input: row["입력(요청문)"],
    want: `${want.kind} ${want.from}~${want.to}`,
    got: `${spec.kind} ${spec.from}~${spec.to}`,
    ok,
  });
  console.log(ok ? "통과" : "실패");
}

// ── 결과 문서 ───────────────────────────────────────────────────────────────────

const chatPass = results.filter((r) => !r.error && r.checks.every((c) => c.ok)).length;
const specPass = specResults.filter((r) => r.ok).length;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

const docMissed = results.flatMap((r) => r.checks.filter((c) => c.axis === "기대 문서" && !c.ok));
const bannedHit = results.flatMap((r) => r.checks.filter((c) => c.axis === "금칙어" && !c.ok));

const lines: string[] = [];
lines.push(`# 평가셋 결과 — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "");
lines.push(`| 항목 | 값 |`, `|---|---:|`);
lines.push(`| 챗봇 자동 통과 | ${chatPass}/${results.length} (${pct(chatPass, results.length)}%) |`);
if (withJudge) {
  const good = results.filter((r) => r.verdict === "O").length;
  const soso = results.filter((r) => r.verdict === "△").length;
  lines.push(`| **심판 판정** | **O ${good} · △ ${soso} · X ${results.length - good - soso}** |`);
}
lines.push(`| 리포트 스펙 통과 | ${specPass}/${specResults.length} (${pct(specPass, specResults.length)}%) |`);
lines.push(`| 문서 적중 실패 | ${docMissed.length}건 |`);
lines.push(`| **금칙어 위반** | **${bannedHit.length}건** |`);
lines.push(`| 소요 | ${Math.round((Date.now() - started) / 1000)}초 |`, "");
if (bannedHit.length) lines.push("> ⚠️ 금칙어 위반은 다른 무엇보다 먼저 고친다 — 내부 사실이 고객에게 새는 것이다.", "");

lines.push("## 챗봇", "");
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  const mark = r.error ? "⚠️ 오류" : bad.length ? "❌" : "✅";
  lines.push(`### ${mark} ${r.id} · ${r.kind}${r.verdict ? ` · 심판 ${r.verdict}` : ""}`, "");
  if (r.judgeReason) lines.push(`_${r.judgeReason}_`, "");
  lines.push(`**물음** ${r.input}`, "");
  if (r.error) { lines.push(`오류: \`${r.error}\``, ""); continue; }
  if (bad.length) lines.push(...bad.map((c) => `- **${c.axis}** — ${c.detail}`), "");
  lines.push(`**기대** ${r.expect}`, "");
  lines.push(`**답변**`, "", r.reply.split("\n").map((l) => `> ${l}`).join("\n"), "");
}

lines.push("## 리포트 — 자연어 → 스펙", "");
lines.push("| ID | 요청 | 기대 | 실제 | |", "|---|---|---|---|---|");
for (const r of specResults) {
  lines.push(`| ${r.id} | ${r.input} | \`${r.want}\` | \`${r.got}\` | ${r.ok ? "✅" : "❌"} |`);
}

// 파일 이름에 **시각까지** 넣는다 — 날짜만 쓰면 같은 날 두 번째 실행이 첫 번째를 덮어써서,
// 하필 비교하려던 직전 결과가 사라진다(실측 2026-09-03: 전체 실행 결과를 부분 실행이 지웠다).
const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
const out = path.join(REPO_ROOT, "docs", "eval", `result-${stamp}.md`);
fs.writeFileSync(out, lines.join("\n"), "utf-8");

const judgedOk = results.filter((r) => r.verdict === "O").length;
console.log(
  `\n기계 ${chatPass}/${results.length}` +
  (withJudge ? ` · 심판 O ${judgedOk}/${results.length}` : "") +
  ` · 리포트 ${specPass}/${specResults.length}`,
);
if (bannedHit.length) console.log(`⚠️ 금칙어 위반 ${bannedHit.length}건 — 먼저 고칠 것`);
console.log(out);
process.exit(0);

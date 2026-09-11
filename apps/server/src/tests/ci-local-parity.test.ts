/**
 * `scripts/ci-local.mjs` 가 **CI 와 같은 것을 돌린다.**
 *
 * ## 왜 이 테스트가 있나
 *
 * `ci-local.mjs` 는 "로컬에선 초록인데 CI 는 빨강" 을 없애려고 만든 스크립트다. 그런데
 * 명령이 CI 와 갈라지면 **그 스크립트가 바로 그 상황을 만들어낸다** — 그것도 사람이
 * "CI 와 같은 걸 돌렸다" 고 믿는 상태에서. 원래 문제보다 나쁘다.
 *
 * 그래서 둘을 묶어 둔다: CI 에 단계를 추가하면 이 테스트가 빨개지고, 스크립트에도
 * 넣어야 통과한다.
 *
 * ## 규칙 — ci.yml 에서 **`name:` 이 붙은 step** 만 본다
 *
 * ci.yml 의 `- run:` 은 두 종류다:
 *   · 이름 없는 것  = 환경 준비 (`pnpm install --frozen-lockfile`, `pip install …`)
 *     → 로컬에선 이미 깔려 있으므로 스크립트가 다시 할 필요가 없다.
 *   · 이름 있는 것  = 실제 관문 (typecheck·테스트·빌드·e2e)
 *     → 이건 스크립트도 똑같이 돌려야 한다.
 *
 * **ci.yml 에 관문을 추가할 때는 `name:` 을 붙일 것.** 안 붙이면 이 테스트가 그 단계를
 * 준비 작업으로 오해해 그냥 지나간다(= 조용히 안 잡힌다).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.join(import.meta.dirname, "..");
const REPO = path.resolve(SRC, "..", "..", "..");
const CI_YML = path.join(REPO, ".github", "workflows", "ci.yml");

/**
 * 스크립트의 STEPS 만 가져온다.
 * ⚠️ 윈도우 절대경로(`C:\…`)를 그대로 `import()` 하면 ESM 이 스킴으로 오해해 죽는다
 *    (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). 반드시 file:// URL 로 바꿔서 넘긴다.
 */
async function importSteps(): Promise<{ STEPS: { name: string; cmd: string; group: string }[] }> {
  return await import(pathToFileURL(path.join(REPO, "scripts", "ci-local.mjs")).href) as any;
}

/** ci.yml 에서 `- name: X` 바로 뒤의 `run: Y` 를 뽑는다. */
function namedRunSteps(): { name: string; cmd: string }[] {
  const lines = fs.readFileSync(CI_YML, "utf8").split(/\r?\n/);
  const out: { name: string; cmd: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = /^\s*-\s+name:\s*(.+?)\s*$/.exec(lines[i]);
    if (!n) continue;
    // name 다음 몇 줄 안에 run: 이 있으면 그 step 은 실행 단계다(uses: 면 아니다).
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (/^\s*-\s/.test(lines[j])) break;            // 다음 step 시작
      if (/^\s*uses:/.test(lines[j])) break;          // 액션 step — 실행 명령이 아니다
      const r = /^\s*run:\s*(.+?)\s*$/.exec(lines[j]);
      if (r) {
        assert.notEqual(r[1], "|", `ci.yml "${n[1]}" 가 여러 줄 run 을 쓴다 — 이 테스트가 못 읽는다`);
        out.push({ name: n[1], cmd: r[1] });
        break;
      }
    }
  }
  return out;
}

describe("ci-local.mjs 가 CI 와 같은 것을 돌린다", () => {
  it("ci.yml 의 이름 있는 단계가 전부 STEPS 에 있다", async () => {
    const { STEPS } = await importSteps();

    const ciSteps = namedRunSteps();
    assert.ok(ciSteps.length >= 4, `ci.yml 에서 단계를 ${ciSteps.length}개밖에 못 읽었다 — 파서가 낡았다`);

    const scriptCmds = new Set(STEPS.map((s) => s.cmd));
    const missing = ciSteps.filter((s) => !scriptCmds.has(s.cmd));
    assert.deepEqual(
      missing.map((m) => `${m.name}: ${m.cmd}`), [],
      "CI 는 도는데 scripts/ci-local.mjs 는 안 도는 단계가 있다 —\n" +
        "  로컬에서 '전부 통과' 를 보고도 CI 에서 빨개진다. STEPS 에 추가할 것.",
    );
  });

  it("STEPS 에 CI 에 없는 명령을 넣지 않는다", async () => {
    const { STEPS } = await importSteps();

    const ciCmds = new Set(namedRunSteps().map((s) => s.cmd));
    const extra = STEPS.filter((s) => !ciCmds.has(s.cmd));
    assert.deepEqual(
      extra.map((e) => `${e.name}: ${e.cmd}`), [],
      "scripts/ci-local.mjs 가 CI 에 없는 것을 돌린다 —\n" +
        "  로컬만 빨개지는 관문이 되고, 그러면 사람이 스크립트를 안 쓰게 된다.",
    );
  });
});

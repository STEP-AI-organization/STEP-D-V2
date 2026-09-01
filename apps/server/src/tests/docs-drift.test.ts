/**
 * 문서-코드 드리프트 고정.
 *
 * 2026-08-12 실측에서 `api-reference.md` 는 **라우트 118개**라고 적혀 있었는데 실제는 **204개**,
 * `worker-queue.md` 는 **잡 5종**인데 실제는 **17종**이었다. 새 유지보수자가 레퍼런스를 믿으면
 * 존재하는 라우트 86개와 서브시스템 넷(naver·thumbnail·factory·GEBD)을 통째로 모른다.
 *
 * 숫자를 한 번 고치는 것으로는 부족하다 — 어긋난 채로 몇 달이 갔다는 게 요점이다.
 * 이 리포는 이미 같은 병을 한 번 앓았고(`AGENTS.md` 가 `CLAUDE.md` 의 낡은 사본이 되어
 * 서로 다른 사실을 말했다) 그때는 사본을 없애 해결했다. 문서는 없앨 수 없으니 **검사한다.**
 *
 * ⚠️ 목적은 "문서를 완벽히 유지" 가 아니라 **"틀린 숫자로 사람을 오도하지 않기"** 다.
 *    그래서 정확히 일치가 아니라 **오차 범위**를 본다 — 라우트 하나 추가할 때마다 테스트가
 *    깨지면 사람들은 숫자를 지워버릴 것이고, 그건 지금보다 나쁘다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SRC, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf-8");

/** 허용 오차. 이만큼 벌어졌으면 "문서가 낡았다" 고 봐도 된다. */
const TOLERANCE = 0.1;

function assertClose(actual: number, documented: number, what: string, where: string) {
  const drift = Math.abs(actual - documented) / Math.max(1, actual);
  assert.ok(
    drift <= TOLERANCE,
    `${where} 의 ${what} 이 ${documented} 인데 실제는 ${actual} 이다(${Math.round(drift * 100)}% 차이). ` +
    "문서를 갱신할 것 — 틀린 숫자는 없느니만 못하다.",
  );
}

describe("문서가 코드와 같은 사실을 말한다", () => {
  const indexSrc = read("apps/server/src/index.ts");
  const routeCount = (indexSrc.match(/^app\.(get|post|put|patch|delete)\(/gm) ?? []).length;
  const jobTypes = new Set(
    [...(read("apps/server/src/queue.ts").match(/export type JobType\s*=([\s\S]*?);/)?.[1] ?? "")
      .matchAll(/"([a-z]+\.[a-z]+)"/g)].map((m) => m[1]),
  );

  it("api-reference.md 의 라우트 수", () => {
    const doc = read("docs/reference/api-reference.md");
    const m = doc.match(/라우트\s*(\d+)\s*개/);
    assert.ok(m, "api-reference.md 에서 '라우트 N개' 를 못 찾았다 — 실측 수치를 적어둘 것");
    assertClose(routeCount, Number(m![1]), "라우트 수", "api-reference.md");
  });

  it("CLAUDE.md 의 라우트 수·잡 종류", () => {
    const doc = read("CLAUDE.md");
    const r = doc.match(/라우트\s*(\d+)\s*개/);
    assert.ok(r, "CLAUDE.md 에서 '라우트 N개' 를 못 찾았다");
    assertClose(routeCount, Number(r![1]), "라우트 수", "CLAUDE.md");

    const j = doc.match(/잡\s*(\d+)\s*종/);
    assert.ok(j, "CLAUDE.md 에서 '잡 N종' 을 못 찾았다");
    assert.equal(Number(j![1]), jobTypes.size,
      `CLAUDE.md 의 잡 종류가 ${j![1]} 인데 실제 JobType 은 ${jobTypes.size} 개다`);
  });

  it("worker-queue.md 의 잡 종류", () => {
    const doc = read("docs/ops/worker-queue.md");
    const m = doc.match(/잡 타입\s*(\d+)\s*종/);
    assert.ok(m, "worker-queue.md 에서 '잡 타입 N종' 을 못 찾았다");
    assert.equal(Number(m![1]), jobTypes.size,
      `worker-queue.md 의 잡 타입이 ${m![1]} 종인데 실제는 ${jobTypes.size} 종이다`);
  });

  it("인증 자세를 '없다' 고 말하지 않는다 — 안심시키는 방향의 드리프트가 제일 위험하다", () => {
    // 예전 api-reference.md 는 "대부분 라우트 자체 인증은 없고 인프라 레벨 몫" 이라고 적었다.
    // 그 사이 AUTH_REQUIRED·resolveTenant·API 키 화이트리스트·RLS 가 전부 들어왔다.
    // 보안 서술이 실제보다 느슨하게 적혀 있으면 사람이 그걸 믿고 라우트를 연다.
    const doc = read("docs/reference/api-reference.md");
    assert.match(doc, /AUTH_REQUIRED/,
      "api-reference.md 가 인증 자세(AUTH_REQUIRED)를 언급하지 않는다 — 서버는 인증을 강제할 수 있다");
  });
});

/**
 * 자동배포 실패모드 문서(`docs/ops/auto-deploy-failure-modes.md`)의 **임계값**.
 *
 * 그 문서는 "무엇이 멈추고 사용자는 어떻게 아는가" 의 정본인데, 그 안의 숫자는 코드 상수의
 * 사본이다. 실제로 렌더 확정 조건이 "5회 또는 30분" 이라고 적힌 채로 코드는 3회로 바뀌어
 * 있었다 — 5회는 순방 주기(15분) 탓에 **도달 불가**라, 문서를 믿은 사람은 30분 벨트가 이미
 * 확정시킨 클립을 두고 "아직 두 번 남았다" 고 기다리게 된다.
 *
 * ⚠️ 고정하는 것은 **숫자뿐**이다. 문구를 통째로 묶으면 문장 하나 고칠 때마다 테스트가
 *    깨지고, 그러면 사람들은 숫자를 지워버린다(그게 지금보다 나쁘다). 위 라우트 수 검사가
 *    오차 범위를 두는 것과 같은 이유 — 다만 여긴 임계값이라 **정확히** 같아야 한다.
 *    문서 §6 표가 이 검사의 입력이다(값 칸 = 두 번째 칸, 상수 이름 = 세 번째 칸).
 */
describe("자동배포 실패모드 문서의 임계값이 코드와 같다", () => {
  const DOC = "docs/ops/auto-deploy-failure-modes.md";
  const doc = read(DOC);
  const automation = read("apps/server/src/automation.ts");
  const credits = read("apps/server/src/credits.ts");

  /** 문서 §6 표에서 그 상수를 가리키는 행의 값 칸에 적힌 숫자들. */
  function documented(constName: string): number[] {
    const row = doc.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${constName}\``));
    assert.ok(row, `${DOC} §6 임계값 표에 \`${constName}\` 행이 없다 — 상수를 지웠거나 문서가 낡았다`);
    const cell = row!.split("|")[2] ?? "";
    const nums = [...cell.matchAll(/\d+/g)].map((m) => Number(m[0]));
    assert.ok(nums.length > 0, `\`${constName}\` 행의 값 칸("${cell.trim()}")에 숫자가 없다`);
    return nums;
  }

  /** `export const NAME = 30 * 60_000;` → 30(분). */
  function minutesOf(src: string, name: string): number {
    const m = src.match(new RegExp(`export const ${name} = (\\d+) \\* 60_000`));
    assert.ok(m, `${name} 을 못 찾았다 — 이름을 바꿨으면 문서 §6 표도 같이 바꿀 것`);
    return Number(m![1]);
  }
  function intOf(src: string, name: string): number {
    const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
    assert.ok(m, `${name} 을 못 찾았다 — 이름을 바꿨으면 문서 §6 표도 같이 바꿀 것`);
    return Number(m![1]);
  }
  const same = (actual: number, name: string, what: string) =>
    assert.equal(documented(name)[0], actual,
      `${DOC} 의 ${what} 이 ${documented(name)[0]} 인데 코드(${name})는 ${actual} 이다`);

  it("렌더 안전벨트 — 확정 횟수·정체 상한·순방 주기", () => {
    same(intOf(automation, "RENDER_MAX_ATTEMPTS"), "RENDER_MAX_ATTEMPTS", "렌더 확정 횟수");
    same(minutesOf(automation, "RENDER_STUCK_MS"), "RENDER_STUCK_MS", "렌더 정체 상한(분)");
    same(minutesOf(automation, "CYCLE_PERIOD_MS"), "CYCLE_PERIOD_MS", "순방 주기(분)");
  });

  it("본문의 'N회 또는 M분' 서술도 같은 값이다 — 표만 맞으면 본문을 읽는 사람이 속는다", () => {
    const attempts = intOf(automation, "RENDER_MAX_ATTEMPTS");
    const minutes = minutesOf(automation, "RENDER_STUCK_MS");
    // 서술이 사라지는 것은 막지 않는다(문구는 자유). 남아 있다면 값이 맞아야 할 뿐이다.
    for (const m of doc.matchAll(/(\d+)회 또는 (\d+)분/g)) {
      assert.equal(Number(m[1]), attempts, `본문 "${m[0]}" 의 횟수가 RENDER_MAX_ATTEMPTS(${attempts}) 와 다르다`);
      assert.equal(Number(m[2]), minutes, `본문 "${m[0]}" 의 분이 RENDER_STUCK_MS(${minutes}분) 와 다르다`);
    }
  });

  it("회차당 채택 상한", () => {
    same(intOf(automation, "TOP3_CAP"), "TOP3_CAP", "회차당 채택 상한");
  });

  it("활동 시간창 기본값 — 판정과 문구가 같은 값을 봐야 한다", () => {
    const fn = /export function ruleWindow[\s\S]*?\n\}/.exec(automation)?.[0] ?? "";
    assert.notEqual(fn, "", "ruleWindow 를 못 찾았다");
    const start = Number(fn.match(/start:.*activeStart.*?:\s*(\d+)/)?.[1]);
    const end = Number(fn.match(/end:.*activeEnd.*?:\s*(\d+)/)?.[1]);
    assert.ok(Number.isFinite(start) && Number.isFinite(end), "ruleWindow 의 기본값을 못 읽었다");
    assert.deepEqual(documented("ruleWindow").slice(0, 2), [start, end],
      `${DOC} 의 활동 시간창 기본값이 코드(${start}~${end}시)와 다르다`);
  });

  it("규칙 유휴 사유 개수 — 사유를 늘리면 문서의 우선순위 표도 낡는다", () => {
    const block = /export const RULE_IDLE_CODES = \[([\s\S]*?)\] as const;/.exec(automation)?.[1] ?? "";
    const codes = [...block.matchAll(/"[a-z0-9_]+"/g)].length;
    assert.ok(codes > 0, "RULE_IDLE_CODES 를 못 읽었다");
    same(codes, "RULE_IDLE_CODES", "규칙 유휴 사유 개수");
  });

  it("자동 충전에서 조치가 필요한 사유 개수 — 문서가 그 목록을 열거한다", () => {
    const block = /export const AUTO_TOPUP_SEVERITY[\s\S]*?\n\};/.exec(credits)?.[0] ?? "";
    assert.notEqual(block, "", "AUTO_TOPUP_SEVERITY 를 못 찾았다");
    // 타입 선언의 `"ok" | "info" | "action_required"` 는 콜론이 앞에 없어 세지 않는다.
    const need = [...block.matchAll(/:\s*"action_required"/g)].length;
    assert.ok(need > 0, "조치 필요 사유가 하나도 없다 — 심각도 표를 잘못 읽었다");
    same(need, "AUTO_TOPUP_SEVERITY", "자동 충전 조치 필요 사유 개수");
  });
});

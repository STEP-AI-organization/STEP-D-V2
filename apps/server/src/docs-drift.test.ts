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

const SRC = path.dirname(fileURLToPath(import.meta.url));
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

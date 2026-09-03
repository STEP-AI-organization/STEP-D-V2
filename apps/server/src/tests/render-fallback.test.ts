/**
 * 렌더 폴백 — **워커에 못 닿으면 클라우드가 굽는다** (사용자 2026-09-03:
 * "실패하면 클라우드라도 렌더해줘야지").
 *
 * ## 왜 오늘 폴백이 안 걸렸나
 *
 * 정체 감지는 두 신호만 본다: **시간**(oldestPendingAge = PC 가 죽었나) · **깊이**
 * (unfinishedCount = PC 가 바쁜가). 그런데 2026-09-03 에 윈도우2 는 **살아서 즉시 실패**했다 —
 * 렌더 워커가 잡을 바로 집어 `fetch failed` 로 끝냈으니 **대기 시간도 깊이도 안 쌓였다.**
 * 두 신호 다 안 걸렸고, 클립 16건이 클라우드로 못 넘어가고 그대로 탔다.
 *
 * ## 구분이 핵심이다
 *
 *   경로가 고장 났나 (응답 없음)   → 클라우드가 대신 구우면 된다
 *   클립이 고장 났나 (404·400·409) → 클라우드도 똑같이 실패한다. 우회는 낭비다
 *
 * 이 구분이 무너지면 둘 중 하나가 된다: 영영 안 나가거나(오늘), 못 굽는 클립을 무한히
 * 클라우드에서 다시 굽거나.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cycle = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");

/** 큐 경로(renderViaQueue) 블록만 잘라 본다. */
const block = (() => {
  const at = cycle.indexOf('const last = await lastJobByDedupe("clip.render", dedupeKey)');
  assert.ok(at > 0, "큐 렌더 블록을 못 찾았다");
  const rest = cycle.slice(at);
  return rest.slice(0, rest.indexOf("const { apiBase, internalHeaders }"));
})();

describe("렌더 폴백 — 워커가 못 구우면 클라우드가 굽는다", () => {
  it("**응답이 없었던 실패는 클라우드로 흘린다** — 오늘 비어 있던 고리", () => {
    assert.ok(block.includes("if (status <= 0 && !code) {"),
      "직전 잡이 전송 단계에서 실패했을 때 클라우드로 넘기는 분기가 없다");
    assert.ok(block.includes("클라우드가 직접 렌더한다"));
  });

  it("**서버가 답을 준 실패는 그대로 확정**한다 — 클라우드도 똑같이 실패한다", () => {
    assert.ok(block.includes("return { ok: false, kind: classifyRenderFailure(status, code)"),
      "404·400·409 까지 클라우드로 우회하면 못 굽는 클립을 무한히 다시 굽는다");
  });

  it("**코드가 붙은 실패는 우회하지 않는다** — reframe_not_ready 등은 기다려야 한다", () => {
    // `status<=0` 이어도 code 가 있으면(예: reframe_plan_invalid) 경로 문제가 아니다.
    assert.ok(block.includes("status <= 0 && !code"), "code 를 안 보면 대기해야 할 건을 클라우드가 굽는다");
  });

  it("정체 감지(시간·깊이)는 **직전 실패가 없을 때만** 돈다", () => {
    // 실패 회수와 정체 감지가 같은 층에 있으면 실패한 건이 다시 큐로 들어가 같은 워커가 또 죽인다.
    assert.ok(block.includes("} else {"), "실패 분기와 정체 분기가 갈라져 있지 않다");
    assert.ok(block.includes("oldestPendingAgeForType"));
    assert.ok(block.includes("unfinishedCountForType"));
  });

  it("두 신호를 **함께** 본다 — 시간만 보면 PC 가 꺼져도 10분을 기다린다", () => {
    assert.ok(block.includes("stalled < renderQueueStallMs() && depth < maxPending"));
  });
});

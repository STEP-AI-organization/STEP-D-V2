/**
 * 렌더 분담 — **사무실 PC 와 클라우드가 나눠서 굽는다** (사용자 2026-09-02).
 *
 * 예전엔 `RENDER_VIA_QUEUE=1` 이면 전부 큐(= 사무실 PC)로 갔고, 클라우드는 큐가 10분 넘게
 * 정체될 때만 끼어들었다 — 그건 분담이 아니라 장애 대비다. PC 는 렌더를 직렬로 굽는데
 * (건당 50~90초) 순방은 한 틱에 최대 8건을 만들어서, 뒤쪽 건은 줄만 서고 클라우드는 놀았다.
 *
 * 이 파일이 고정하는 것 둘:
 *  1. **깊이 상한이 실제로 배선돼 있다** — 없으면 조용히 예전(전부 PC)으로 돌아간다.
 *  2. **깊이는 running 을 포함해서 센다** — pending 만 세면 PC 가 한 건을 굽는 동안 깊이가
 *     0 으로 보여서 계속 밀어 넣게 되고, 결국 다시 전부 PC 행이 된다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderQueueMaxPending, renderQueueStallMs, renderViaQueue } from "../pipeline/automation.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.resolve(SRC, p), "utf-8");

describe("renderQueueMaxPending — 사무실 PC 에 걸어 둘 렌더 수", () => {
  const withEnv = (v: string | undefined, fn: () => void) => {
    const old = process.env.RENDER_QUEUE_MAX_PENDING;
    if (v === undefined) delete process.env.RENDER_QUEUE_MAX_PENDING;
    else process.env.RENDER_QUEUE_MAX_PENDING = v;
    try { fn(); } finally {
      if (old === undefined) delete process.env.RENDER_QUEUE_MAX_PENDING;
      else process.env.RENDER_QUEUE_MAX_PENDING = old;
    }
  };

  it("미설정 기본은 3 — PC 가 앞서 들고 있되 쌓아 두지는 않는다", () => {
    withEnv(undefined, () => assert.equal(renderQueueMaxPending(), 3));
  });

  it("env 로 조절된다 — 분담 비중을 재배포 없이 바꿀 수 있어야 한다", () => {
    withEnv("1", () => assert.equal(renderQueueMaxPending(), 1));
    withEnv("8", () => assert.equal(renderQueueMaxPending(), 8));
  });

  it("0 이면 큐를 아예 안 쓴다 — 전부 클라우드(사무실 PC 를 끄는 스위치)", () => {
    withEnv("0", () => assert.equal(renderQueueMaxPending(), 0));
  });

  it("오타·음수·빈값은 기본값으로 — 실패 방향이 '렌더가 안 나감' 이면 안 된다", () => {
    for (const bad of ["", "  ", "네", "-2", "abc"]) {
      withEnv(bad, () => assert.equal(renderQueueMaxPending(), 3, `입력 ${JSON.stringify(bad)}`));
    }
  });

  it("소수는 내림 — 3.9 를 3.9건으로 셀 수는 없다", () => {
    withEnv("3.9", () => assert.equal(renderQueueMaxPending(), 3));
  });
});

describe("분담이 실제로 배선돼 있다 (소스 스캔)", () => {
  const cycle = read("pipeline/automation-cycle.ts");

  it("깊이와 정체를 **함께** 보고, 둘 중 하나라도 걸리면 클라우드가 굽는다", () => {
    assert.match(cycle, /unfinishedCountForType\("clip\.render"\)/,
      "큐 깊이를 안 보면 분담이 아니라 전부 사무실 PC 행이다");
    assert.match(cycle, /stalled < renderQueueStallMs\(\) && depth < maxPending/,
      "깊이 상한이 큐잉 조건에 안 들어갔다 — 조용히 예전 동작으로 돌아간다");
  });

  it("깊이 상한에 걸린 건은 큐에 넣지 않고 아래 직접 렌더로 흐른다", () => {
    // enqueue 는 조건 안에서만 일어나야 한다. 밖에 있으면 상한이 무의미하다.
    const block = /if \(stalled < renderQueueStallMs\(\) && depth < maxPending\) \{[\s\S]*?\n      \}/.exec(cycle);
    assert.ok(block, "큐잉 분기를 못 찾았다");
    assert.match(block![0], /await enqueue\("clip\.render"/);
  });

  it("두 사유를 로그에서 구분한다 — '꺼졌다' 와 '바쁘다' 는 대응이 다르다", () => {
    assert.match(cycle, /clip\.render 정체/, "정체(=PC 가 죽었을 수 있다) 로그가 없다");
    assert.match(cycle, /clip\.render 대기 \$\{depth\}건/, "분담 로그가 없다");
  });
});

describe("깊이는 running 을 포함해서 센다", () => {
  it("unfinishedCountForType 가 pending·running 둘 다 센다", () => {
    const q = read("pipeline/queue.ts");
    const fn = /export async function unfinishedCountForType[\s\S]*?\n\}/.exec(q);
    assert.ok(fn, "unfinishedCountForType 를 못 찾았다");
    assert.match(fn![0], /status IN \('pending', 'running'\)/,
      "pending 만 세면 PC 가 한 건 굽는 동안 깊이가 0 으로 보여 계속 밀어 넣는다");
    assert.match(fn![0], /type = \$1/, "타입을 안 좁히면 다른 잡까지 세어 렌더가 클라우드로 쏠린다");
  });
});

describe("게이트는 그대로 — 실패 방향이 바뀌면 안 된다", () => {
  it("RENDER_VIA_QUEUE 오타·빈값은 여전히 OFF(=전부 클라우드)", () => {
    const old = process.env.RENDER_VIA_QUEUE;
    try {
      for (const bad of ["", "네", "0", "off"]) {
        process.env.RENDER_VIA_QUEUE = bad;
        assert.equal(renderViaQueue(), false, `입력 ${JSON.stringify(bad)}`);
      }
      process.env.RENDER_VIA_QUEUE = "1";
      assert.equal(renderViaQueue(), true);
    } finally {
      if (old === undefined) delete process.env.RENDER_VIA_QUEUE;
      else process.env.RENDER_VIA_QUEUE = old;
    }
  });

  it("정체 기본값 10분은 그대로 — 분담을 넣었다고 장애 대비를 빼지 않았다", () => {
    const old = process.env.RENDER_QUEUE_STALL_MS;
    delete process.env.RENDER_QUEUE_STALL_MS;
    try { assert.equal(renderQueueStallMs(), 10 * 60_000); } finally {
      if (old !== undefined) process.env.RENDER_QUEUE_STALL_MS = old;
    }
  });
});

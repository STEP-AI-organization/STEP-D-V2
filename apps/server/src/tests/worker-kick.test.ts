/**
 * 큐 적체 즉시 킥(worker-kick) — 배선 불변식.
 *
 * 이 기능의 실패 모드는 전부 **조용하다**: 킥 목록이 레인과 어긋나면 그 잡만 15분 틱으로
 * 돌아가고, enqueue 훅이 빠지면 기능 전체가 소리 없이 사라진다. 값이 틀리는 게 아니라
 * "아무 일도 안 일어나는" 축이라 소스 스캔으로 고정한다(CLAUDE.md 검증 컨벤션).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { KICK_TYPES, KICK_MIN_INTERVAL_MS, shouldKick } from "../pipeline/worker-kick.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");

describe("worker-kick — KICK_TYPES 는 content 레인과 같은 목록", () => {
  it("worker.ts JOB_LANES.content 와 집합이 일치한다", () => {
    // worker-lanes.test.ts 와 같은 방식으로 레인 배열을 소스에서 뽑는다. 목록을 복제해 둔
    // 이유(worker-kick 은 잎 모듈 — worker.ts 를 import 하면 서버 기동이 워커 의존을 문다)가
    // 곧 드리프트 위험이므로, 여기서 동일성을 강제한다.
    const worker = read("worker.ts");
    const block = /content:\s*\[([\s\S]*?)\]/.exec(worker)?.[1] ?? "";
    const lane = new Set([...block.matchAll(/"([a-z]+\.[a-z]+)"/g)].map((m) => m[1]));
    assert.ok(lane.size > 0, "worker.ts 에서 JOB_LANES.content 를 못 찾았다 — 정규식을 고칠 것");
    assert.deepEqual(
      [...KICK_TYPES].sort(), [...lane].sort(),
      "KICK_TYPES ≠ JOB_LANES.content — 레인에 잡을 넣고 빼면 worker-kick.ts 목록도 같이 고칠 것. " +
      "어긋나면 그 잡만 즉시 킥 없이 15분 틱으로 돌아간다(조용한 퇴행).",
    );
  });

  it("enqueue() 가 킥을 부른다 — 훅이 빠지면 기능이 소리 없이 사라진다", () => {
    const queue = read("pipeline/queue.ts");
    assert.match(queue, /maybeKickContentWorker\(type\)/,
      "queue.ts enqueue() 에 maybeKickContentWorker 호출이 없다");
    // dedupe 충돌·지연 잡 가드 — 없으면 헛킥이 는다(비용·로그 노이즈).
    assert.match(queue, /inserted && !opts\.delayMs/,
      "킥 가드(inserted && !opts.delayMs)가 없다 — dedupe 충돌·지연 잡에도 킥이 나간다");
  });

  it("잎 모듈 유지 — worker-kick 은 아무것도 import 하지 않는다", () => {
    // queue.ts 가 정적으로 무는 자리라, 여기서 db-pg 등을 import 하면 순환이 된다.
    const kick = read("pipeline/worker-kick.ts");
    assert.equal((kick.match(/^import /gm) ?? []).length, 0,
      "worker-kick.ts 에 import 가 생겼다 — queue → kick → … → queue 순환 위험. 잎으로 유지할 것");
  });
});

describe("worker-kick — 디바운스", () => {
  it("간격 경계에서 갈린다", () => {
    assert.equal(shouldKick(1_000_000, 1_000_000 - KICK_MIN_INTERVAL_MS + 1), false);
    assert.equal(shouldKick(1_000_000, 1_000_000 - KICK_MIN_INTERVAL_MS), true);
    assert.equal(shouldKick(KICK_MIN_INTERVAL_MS, 0), true);
  });
});

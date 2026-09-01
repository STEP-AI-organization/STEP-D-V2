import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");

/**
 * `withTenantLock` 은 fn() 이 끝날 때까지 커넥션 1개를 쥔 채로 fn() 이 같은 풀에서 더 꺼낸다.
 * 그래서 동시 보유자 수에 상한(`LOCK_SLOTS`)을 뒀는데, **그 상한 자체가 새 교착을 만들 수 있다** —
 * 커넥션 풀과 달리 이 세마포어에는 타임아웃이 없어서, 잘못 걸리면 10초 실패가 아니라
 * **영구 정지**다. 결제 경로가 여기 있다.
 *
 * 실제로 중첩된다(2026-09-01 확인): `runAutomationCycleLocked` 이 automation-cycle 잠금 안에서
 * `maybeAutoTopup()` 을 부르고, 그게 다시 `auto-topup:{tenantId}` 잠금을 잡는다.
 * 중첩 호출이 슬롯을 새로 요구하면 자기 바깥쪽이 끝나기를 기다리며 영원히 멈춘다.
 */
describe("withTenantLock — 중첩돼도 멈추지 않는다", () => {
  const db = read("db-pg.ts");

  it("중첩 호출은 슬롯을 새로 얻지 않는다", () => {
    const fn = /export async function withTenantLock[\s\S]*?\n}/.exec(db)?.[0] ?? "";
    assert.ok(fn, "withTenantLock 을 못 찾았다");
    const guard = fn.indexOf("lockSlotHeld.getStore()");
    const acquire = fn.indexOf("acquireLockSlot()");
    assert.ok(guard > 0, "중첩 판정이 없다 — 중첩되면 자기 자신을 기다린다");
    assert.ok(guard < acquire, "슬롯을 먼저 얻으면 중첩 판정이 늦다 — 그 순간 이미 멈춘다");
  });

  it("슬롯 상한이 중첩 깊이를 감안한다 — 남는 커넥션이 있어야 안쪽이 진행한다", () => {
    const m = /const LOCK_SLOTS = Math\.max\(1, Math\.floor\(\(POOL_MAX - 1\) \/ 2\)\)/.exec(db);
    assert.ok(m, "LOCK_SLOTS 가 중첩(바깥+안쪽 = 커넥션 2개)을 감안하지 않는다");
  });

  it("슬롯은 모든 경로에서 정확히 한 번 반환된다", () => {
    const fn = /export async function withTenantLock[\s\S]*?\n}/.exec(db)?.[0] ?? "";
    assert.equal((fn.match(/acquireLockSlot\(\)/g) ?? []).length, 1);
    assert.equal((fn.match(/releaseLockSlot\(\)/g) ?? []).length, 1);
    assert.match(fn, /finally\s*\{\s*releaseLockSlot\(\);/,
      "finally 가 아니면 fn() 이 던질 때 슬롯이 샌다 — 새면 그만큼 영구히 줄어든다");
  });

  /**
   * 이 중첩이 사라지면 위 장치도 단순해질 수 있다. 사라졌는지 여기서 알 수 있게 고정해 둔다
   * (없어졌다고 판단되면 이 테스트를 지우고 LOCK_SLOTS 를 되돌리면 된다).
   */
  it("중첩 경로가 아직 존재한다 — automation-cycle 안에서 auto-topup 을 부른다", () => {
    const cycle = read("pipeline/automation-cycle.ts");
    const topup = read("billing/auto-topup.ts");
    assert.match(cycle, /withTenantLock\(`automation-cycle:/);
    assert.match(cycle, /maybeAutoTopup\(\)/);
    assert.match(topup, /withTenantLock\(`auto-topup:/);
  });
});

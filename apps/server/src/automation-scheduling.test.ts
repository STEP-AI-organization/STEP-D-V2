import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inActiveWindow,
  kstMinutes,
  scheduledSlotAt,
  slotsReadyForQueue,
} from "./automation.ts";

const kst = (value: string) => new Date(`${value}+09:00`);

describe("automation slot queue timing", () => {
  it("queues two hours before the target and preserves KST", () => {
    const now = kst("2026-08-17T17:00");
    assert.equal(kstMinutes(now), 17 * 60);
    assert.equal(slotsReadyForQueue(["19:00", "21:00"], now), 1);
    assert.equal(scheduledSlotAt(["19:00"], 0, now)?.toISOString(), "2026-08-17T10:00:00.000Z");
  });

  it("allows an early queue even when the activity window starts at the target time", () => {
    const rule = { activeStart: 19, activeEnd: 21 } as any;
    const now = kst("2026-08-17T17:00");
    assert.equal(inActiveWindow(rule, now), false);
    assert.equal(slotsReadyForQueue(["19:00"], now), 1);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inActiveWindow,
  kstMinutes,
  ruleSlots,
  scheduledSlotAt,
  slotsElapsed,
  slotsReadyForQueue,
} from "./automation.ts";

const kst = (value: string) => new Date(`${value}+09:00`);
// 판정 함수들은 정규화된 슬롯(RuleSlot[])만 받는다 — 테스트도 같은 경로(ruleSlots)로 만든다.
const slots = (raw: unknown[]) => ruleSlots({ slots: raw as never });

describe("automation slot queue timing", () => {
  it("queues two hours before the target and preserves KST", () => {
    const now = kst("2026-08-17T17:00");
    assert.equal(kstMinutes(now), 17 * 60);
    assert.equal(slotsReadyForQueue(slots(["19:00", "21:00"]), now), 1);
    assert.equal(scheduledSlotAt(slots(["19:00"]), 0, now)?.toISOString(), "2026-08-17T10:00:00.000Z");
  });

  it("allows an early queue even when the activity window starts at the target time", () => {
    const rule = { activeStart: 19, activeEnd: 21 } as any;
    const now = kst("2026-08-17T17:00");
    assert.equal(inActiveWindow(rule, now), false);
    assert.equal(slotsReadyForQueue(slots(["19:00"]), now), 1);
  });
});

/**
 * 슬롯당 개수 (2026-08-25) — "시간대 하나 = 하루 1개" 의존성 파괴. 7시×2·9시×3 처럼
 * 각 시각에 나가는 개수를 따로 둔다. 판정(허용 누적·큐 선행·publishAt)이 전부 개수 합을
 * 봐야 하고, 하나라도 칸 수(length)를 보면 개수 설정이 조용히 1로 쪼그라든다.
 */
describe("per-slot counts", () => {
  const twoThree = slots([{ time: "07:00", count: 2 }, { time: "09:00", count: 3 }]);

  it("정규화 — 문자열(구형)=1개, 객체=count, 시각순 정렬·중복은 뒤가 이김", () => {
    assert.deepEqual(slots(["17:00", "25:00", "7:00", "", "17:00", "09:30"]), [
      { time: "09:30", count: 1 },
      { time: "17:00", count: 1 },
    ]);
    assert.deepEqual(slots([{ time: "09:00", count: 3 }, "07:00"]), [
      { time: "07:00", count: 1 },
      { time: "09:00", count: 3 },
    ]);
    // count 오염 방어 — 0·음수·비수치는 1, 과대는 상한으로.
    assert.deepEqual(slots([{ time: "07:00", count: 0 }, { time: "08:00", count: 999 }]), [
      { time: "07:00", count: 1 },
      { time: "08:00", count: 20 },
    ]);
  });

  it("허용 누적(slotsElapsed)은 지난 슬롯의 개수 합이다", () => {
    assert.equal(slotsElapsed(twoThree, kst("2026-08-17T06:59")), 0);
    assert.equal(slotsElapsed(twoThree, kst("2026-08-17T07:00")), 2);
    assert.equal(slotsElapsed(twoThree, kst("2026-08-17T09:30")), 5);
  });

  it("큐 선행(slotsReadyForQueue)도 개수 합 — 2시간 리드 안이면 그 칸 전량", () => {
    assert.equal(slotsReadyForQueue(twoThree, kst("2026-08-17T05:30")), 2);
    assert.equal(slotsReadyForQueue(twoThree, kst("2026-08-17T07:30")), 5);
  });

  it("publishAt(scheduledSlotAt)의 index 는 발행 순번 — 같은 시각 여러 건은 같은 시각", () => {
    const now = kst("2026-08-17T05:00");
    const iso = (i: number) => scheduledSlotAt(twoThree, i, now)?.toISOString();
    assert.equal(iso(0), "2026-08-16T22:00:00.000Z"); // 07:00 KST
    assert.equal(iso(1), "2026-08-16T22:00:00.000Z");
    assert.equal(iso(2), "2026-08-17T00:00:00.000Z"); // 09:00 KST
    assert.equal(iso(4), "2026-08-17T00:00:00.000Z");
    assert.equal(scheduledSlotAt(twoThree, 5, now), null); // 하루 5건을 넘는 순번은 오늘 슬롯이 없다
  });
});

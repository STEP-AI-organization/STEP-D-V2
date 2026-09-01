import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  AUTOMATION_MAX_PUBLISH_PER_TICK,
  AUTOMATION_QUEUE_LEAD_MIN,
  AUTOMATION_TICK_MIN,
  inActiveWindow,
  kstMinutes,
  maxPublishPerTick,
  ruleSlots,
  scheduledSlotAt,
  slotsElapsed,
  slotsReadyForQueue,
  staleMissedSlots,
} from "../pipeline/automation.ts";

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

  it("놓친 슬롯 몫은 오늘 포기(staleMissedSlots) — 저녁에 켠 계획이 아침 몫을 쏟지 않는다", () => {
    // 2026-08-25 ENA 실전: 09:00×3 계획을 20시에 켬 → 예전엔 3건이 밤에 즉시 게시됐다.
    const nineByThree = ruleSlots({ slots: [{ time: "09:00", count: 3 }] });
    assert.equal(staleMissedSlots(nineByThree, 0, kst("2026-08-25T20:10")), 3, "저녁이면 아침 몫 전부 포기");
    // 유예(60분) 안이면 놓친 게 아니다 — 순방이 조금 늦어도 제 몫은 나간다.
    assert.equal(staleMissedSlots(nineByThree, 0, kst("2026-08-25T09:40")), 0);
    // 유예를 막 넘긴 경계.
    assert.equal(staleMissedSlots(nineByThree, 0, kst("2026-08-25T10:01")), 3);
    // **오늘 한 건이라도 나간 계획의 몫은 버리지 않는다** (2026-08-26 ENA: 15:00×20 중
    // 8건 나간 뒤 유예가 남은 12건을 소멸 — 사용자가 정한 개수가 안 지켜지는 게 시각이
    // 밀리는 것보다 더 큰 사고). 포기는 오늘 0건인 계획(위 저녁-켬 사고 형태)에만 적용된다.
    assert.equal(staleMissedSlots(twoThree, 2, kst("2026-08-17T11:00")), 0, "배달 중인 계획의 남은 몫은 늦게라도 나간다");
    assert.equal(staleMissedSlots(twoThree, 5, kst("2026-08-17T23:00")), 0, "전부 제시간에 나갔으면 0");
  });

  it("순방의 슬롯 순번은 카운터(slotIndex)다 — 산식으로 쓰면 두 번 데였다 (소스 스캔)", () => {
    // ① publishedToday + (quota - remaining): 이미 게시분이 두 번 더해져 2건째부터 배열 밖
    //    → 예약 없이 즉시 게시(2026-08-25 critical). ② quota - remaining 단독: 틱당 상한이
    //    remaining 을 클램프하면 앞 슬롯을 건너뛰고 다음 틱이 같은 시각을 중복 배정(2026-08-26).
    // 순번은 publishedToday 에서 시작해 게시 성공마다 +1 하는 카운터여야 둘 다 안 밟는다.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pipeline/automation-cycle.ts"), "utf-8");
    assert.equal([...src.matchAll(/scheduledSlotAt\(slotted, slotIndex\)/g)].length, 2,
      "유튜브·비유튜브 두 자리 모두 slotIndex 카운터를 써야 한다");
    assert.match(src, /let slotIndex = /, "순번은 산식이 아니라 카운터여야 한다");
    assert.match(src, /\{ remaining -= 1; slotIndex \+= 1; \}/,
      "게시 성공 시 remaining 과 slotIndex 가 함께 움직여야 한다");
    assert.doesNotMatch(src, /scheduledSlotAt\(slotted, (publishedToday|quota)/,
      "산식 기반 순번(옛 형태)이 돌아왔다 — 이중 가산 또는 클램프 건너뜀을 다시 밟는다");
  });
});

describe("틱당 게시 상한은 하루 몫에 비례한다 (2026-08-26)", () => {
  // 고정 3 은 하루 3건 계획 전제였다. 하루 20건이면 20÷3 = 7틱 = 105분이 필요한데
  // 큐잉 리드가 120분뿐이라, 순방이 한 번만 밀려도 슬롯 시각을 넘긴다 —
  // 넘기면 예약이 아니라 즉시 게시라 "몇 시에 20개" 라는 약속이 깨진다.
  const rule = (raw: unknown[], quota?: number) =>
    ({ slots: raw as never, dailyQuota: quota }) as never;

  it("작은 계획은 종전 그대로 3건/틱", () => {
    assert.equal(maxPublishPerTick(rule(["09:00"])), AUTOMATION_MAX_PUBLISH_PER_TICK);
    assert.equal(maxPublishPerTick(rule([], 3)), AUTOMATION_MAX_PUBLISH_PER_TICK);
  });

  it("하루 20건이면 리드의 절반(60분·4틱) 안에 끝나는 페이스", () => {
    assert.equal(maxPublishPerTick(rule([{ time: "15:00", count: 20 }])), 5);
    // 실제로 그 페이스면 리드 안에 끝나는지 — 산식이 아니라 결과로 확인한다.
    const perTick = maxPublishPerTick(rule([{ time: "15:00", count: 20 }]));
    assert.ok(Math.ceil(20 / perTick) * AUTOMATION_TICK_MIN <= AUTOMATION_QUEUE_LEAD_MIN / 2,
      "하루 몫이 리드 절반 안에 안 끝난다 — 슬롯 시각을 넘겨 즉시 게시로 샌다");
  });

  it("할당량 방식(슬롯 없음)도 같은 산식을 탄다", () => {
    assert.equal(maxPublishPerTick(rule([], 20)), 5);
  });

  it("하루 몫을 넘겨 쏟지는 않는다 — 폭탄 방지라는 원래 목적은 그대로", () => {
    for (const n of [1, 3, 8, 20]) {
      assert.ok(maxPublishPerTick(rule([{ time: "15:00", count: n }])) <= Math.max(3, n),
        `틱당 상한이 하루 몫(${n})을 넘는다`);
    }
  });
});

describe("고아 클립 상속 — 게시와 상한이 같은 집합을 본다 (소스 스캔)", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pipeline/automation-cycle.ts"), "utf-8");

  it("지워진 계획의 클립을 현재 계획이 상속한다", () => {
    // 계획을 지웠다 다시 만들면 옛 클립이 고아가 돼 아무 순방도 안 집었다
    // (2026-08-26 ENA: 렌더까지 끝난 10건이 조용히 멈춤).
    assert.match(src, /liveRuleIds/, "상속 판정 집합이 없다");
    assert.equal([...src.matchAll(/!liveRuleIds\.has\(c\.automationRuleId\)/g)].length, 2,
      "게시(mine)와 상한(adoptedCountFor) 둘 다 같은 집합으로 상속을 판정해야 한다");
  });

  it("게시는 만들어진 순서대로 — 최신 우선(엔티티 ord)을 뒤집는다", () => {
    assert.match(src, /\.reverse\(\)/,
      "listEntities 는 최신 삽입이 먼저라 뒤집지 않으면 옛 클립이 계속 밀린다");
  });
});

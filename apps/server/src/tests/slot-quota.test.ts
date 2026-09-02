/**
 * 슬롯 단위 한도 — **지나간 슬롯 몫은 소멸한다** (사용자 2026-09-02:
 * "18시이면 그 시간에 정해둔 개수만 나가고 끝이야 · 6시30분 몫을 배포 X").
 *
 * ## 이 파일이 재현하는 실제 사고
 * ENA 계획 `06:30 ×2` + `18:00 ×2` 인데 **18시에 4건이 한꺼번에** 나갔다. 아침 몫이 저녁으로
 * 넘어간 것이다. 원인은 한도가 "오늘 몇 건" 이라는 **하루 누적**이었고, 게시가 어느 슬롯
 * 몫인지 몰라서 `staleMissedSlots` 의 포기분이 다음 틱에 되살아난 것이다.
 *
 * ## 동시에 지켜야 하는 반대편
 * "15시에 20개" 를 걸었는데 렌더가 밀려 배달이 16시를 넘겨도 **20개는 다 나가야 한다**
 * (2026-08-26: 12개가 소리 없이 증발한 사고). 창의 끝을 *다음 슬롯*으로 두어 둘을 함께 만족한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AUTOMATION_QUEUE_LEAD_MIN, claimableSlots, slotAtToday, slotForIndex } from "../pipeline/automation.ts";

const kst = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00+09:00`);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");
const S = (time: string, count: number) => ({ time, count });

describe("claimableSlots — 창이 닫히면 몫은 소멸한다", () => {
  const ena = [S("06:30", 2), S("18:00", 2)];   // 실제 ENA 계획

  it("18시엔 18:00 몫 2건만 — 06:30 몫은 안 나간다 (사고 재현)", () => {
    const c = claimableSlots(ena, {}, kst("18:00"));
    assert.deepEqual(c, [{ time: "18:00", remaining: 2 }],
      "06:30 이 남아 있으면 저녁에 4건이 나간다 — 실제로 그랬다");
  });

  it("18:00 몫 2건을 이미 채웠으면 더 없다 — '정해둔 개수만 나가고 끝'", () => {
    assert.deepEqual(claimableSlots(ena, { "18:00": 2 }, kst("18:30")), []);
  });

  it("아침엔 06:30 몫이 정상으로 열린다 — 소멸은 창이 닫힌 뒤에만", () => {
    assert.deepEqual(claimableSlots(ena, {}, kst("06:35")), [{ time: "06:30", remaining: 2 }]);
  });

  it("리드(2시간) 안에 들면 미리 채운다 — 예약 업로드의 전제", () => {
    // 16:00 = 18:00 − 120분. 그 전에는 안 열린다.
    assert.deepEqual(claimableSlots(ena, {}, kst("15:59")).map((c) => c.time), []);
    assert.deepEqual(claimableSlots(ena, {}, kst("16:00")).map((c) => c.time), ["18:00"]);
  });

  it("리드가 겹치면 두 슬롯이 함께 열린다 — 앞 슬롯 창이 아직 안 닫혔을 때만", () => {
    const tight = [S("17:00", 1), S("18:00", 1)];
    // 16:30 — 17:00 창 열림(15:00~18:00), 18:00 창도 리드로 열림(16:00~).
    assert.deepEqual(claimableSlots(tight, {}, kst("16:30")).map((c) => c.time), ["17:00", "18:00"]);
    // 17:30 — 17:00 창은 아직 열려 있다(다음 슬롯 18:00 전).
    assert.deepEqual(claimableSlots(tight, {}, kst("17:30")).map((c) => c.time), ["17:00", "18:00"]);
    // 18:10 — 17:00 창은 닫혔다. 남은 몫은 소멸.
    assert.deepEqual(claimableSlots(tight, {}, kst("18:10")).map((c) => c.time), ["18:00"]);
  });

  it("느린 배달이 몫을 삼키지 않는다 — '15시에 20개' 는 밤까지 다 나간다", () => {
    // 2026-08-26 사고의 반대편. 마지막 슬롯의 창은 **그날 끝까지**다.
    const big = [S("15:00", 20)];
    assert.deepEqual(claimableSlots(big, { "15:00": 8 }, kst("19:00")),
      [{ time: "15:00", remaining: 12 }],
      "유예(60분)로 잘라내면 12개가 소리 없이 사라진다 — 그게 예전 사고다");
    assert.deepEqual(claimableSlots(big, { "15:00": 8 }, kst("23:59")).length, 1);
  });

  it("앞 슬롯이 미달인 채 다음 슬롯이 와도 **넘어가지 않는다**", () => {
    // 06:30 에 1건만 나갔다 → 나머지 1건은 18시에 살아나면 안 된다.
    assert.deepEqual(claimableSlots(ena, { "06:30": 1 }, kst("18:05")),
      [{ time: "18:00", remaining: 2 }]);
  });

  it("리드 상수는 automation.ts 한 곳에서 온다", () => {
    assert.equal(AUTOMATION_QUEUE_LEAD_MIN, 120);
    // 리드를 인자로 줄이면 창도 같이 좁아진다(호출부가 실험할 수 있어야 한다).
    assert.deepEqual(claimableSlots(ena, {}, kst("17:00"), 30).map((c) => c.time), []);
    assert.deepEqual(claimableSlots(ena, {}, kst("17:30"), 30).map((c) => c.time), ["18:00"]);
  });
});

describe("slotForIndex · slotAtToday — 매핑 정본은 하나", () => {
  const slots = [S("06:30", 2), S("18:00", 3)];

  it("순번이 어느 슬롯 몫인지 센다", () => {
    assert.equal(slotForIndex(slots, 0)?.time, "06:30");
    assert.equal(slotForIndex(slots, 1)?.time, "06:30");
    assert.equal(slotForIndex(slots, 2)?.time, "18:00");
    assert.equal(slotForIndex(slots, 4)?.time, "18:00");
    assert.equal(slotForIndex(slots, 5), null, "범위를 넘으면 null — 즉시 게시로 떨어진다");
  });

  it("slotAtToday 가 오늘 KST 그 시각을 준다", () => {
    const at = slotAtToday("18:00", kst("16:00"));
    assert.ok(at);
    assert.equal(at!.toISOString(), "2026-09-02T09:00:00.000Z", "18:00 KST = 09:00 UTC");
    assert.equal(slotAtToday(null), null, "시각이 없으면 즉시 게시");
  });
});

describe("메일의 '다음 배포' — 그 시각에 나갈 개수만", () => {
  // 사용자 2026-09-02: 메일에 `2026. 09. 03 (목) 06:30 · 14건 예정` 이라고 적혔는데
  // 06:30 에 나가는 건 2건이었다. 하루 전체 합을 적어서 시각과 개수가 안 맞았다 —
  // 그러면 담당자가 아침에 14건을 기다린다.
  const src = readSrc("publish/publish-notify.ts");

  it("첫 슬롯 시각의 개수만 센다 — 하루 합이 아니다", () => {
    const fn = src.slice(src.indexOf("async function nextPublishInfo"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    assert.match(body, /\.filter\(\(s\) => s\.time === firstSlot\)/,
      "그 시각 슬롯만 골라야 한다");
    assert.doesNotMatch(body.split("const time =")[0], /^\s*const count = due\.reduce\(\(n, r\) => n \+ perDayCount/m,
      "하루 합을 그대로 쓰던 옛 형태가 남아 있다");
  });

  it("할당량 계획(슬롯 없음)은 하루 합이 맞다 — 시각이 없으니까", () => {
    const fn = src.slice(src.indexOf("async function nextPublishInfo"));
    assert.match(fn.slice(0, 1400), /: due\.reduce\(\(n, r\) => n \+ perDayCount\(r\)/,
      "슬롯이 없을 때의 폴백이 사라졌다");
  });
});

describe("리포트 목표도 슬롯 어휘를 쓴다 — 거짓 부족을 띄우지 않게", () => {
  const src = readSrc("publish/publish-notify.ts");

  it("소멸한 슬롯 몫은 목표에서 빠진다", () => {
    const fn = src.slice(src.indexOf("async function rulePlanTotals"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    assert.match(body, /claimableSlots\(slots, bySlot, now\)/,
      "순방과 다른 식으로 목표를 내면 이미 포기한 몫을 '못 채웠다' 고 말한다");
    assert.match(body, /target \+= n \+ open;/, "목표 = 이미 나간 수 + 아직 채울 수 있는 수");
  });
});

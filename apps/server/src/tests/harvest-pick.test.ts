/**
 * 완전자동화 수확 판정 — **여기서 새면 돈이 나간다.**
 *
 * 60분짜리 한 편이 60크레딧이다. 상한이 하나라도 무력화되면 채널 하나 등록에 잔액이 통째로
 * 사라지고, 사용자는 무엇이 그랬는지도 모른 채 분석이 전부 멈춘 화면을 본다.
 * 그래서 이 판정은 DB 없이 검증한다 — 확인하는 데 돈이 들면 아무도 확인하지 않는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DAILY_CAP, DEFAULT_MIN_DURATION_SEC, HARVEST_HOUR_KST, MAX_IN_FLIGHT, MAX_PER_DAY,
  STOCK_BUFFER_DAYS, STUCK_AFTER_MS, stuckWarning,
  candidates, clampCap, clampMinDuration, effectiveDailyCap, enoughStock, estimate, isHarvestWindow,
  parseChannelRef,
  pickNext, publishSummary, type ChannelVideo, type HarvestSource,
} from "../pipeline/harvest.ts";
import type { AutomationRule } from "../pipeline/automation.ts";

const REGISTERED = Date.parse("2026-06-01T00:00:00Z");

function source(over: Partial<HarvestSource> = {}): HarvestSource {
  return {
    id: "hs_1", sourceChannelId: "UC1234567890123456789012", programId: "p1",
    status: "active", dailyCap: DEFAULT_DAILY_CAP, minDurationSec: DEFAULT_MIN_DURATION_SEC,
    backfill: true, createdAt: REGISTERED, ...over,
  };
}

/** 최신 → 과거 순으로 만든 표본. */
const VIDEOS: ChannelVideo[] = [
  { videoId: "new1", title: "이번 주 회차", publishedAt: "2026-08-20T09:00:00Z", durationSec: 3600 },
  { videoId: "new2", title: "지난 주 회차", publishedAt: "2026-08-13T09:00:00Z", durationSec: 2700 },
  { videoId: "short", title: "예고편", publishedAt: "2026-08-12T09:00:00Z", durationSec: 45 },
  { videoId: "old1", title: "작년 회차", publishedAt: "2025-11-01T09:00:00Z", durationSec: 5400 },
];

const NO_CREDIT_LIMIT = null;

describe("후보 고르기", () => {
  it("롱폼만 — 하한보다 짧은 것은 빠진다", () => {
    const list = candidates({ source: source(), videos: VIDEOS, alreadyMade: new Set() });
    assert.ok(!list.some((v) => v.videoId === "short"), "예고편(45초)이 후보에 들어왔다");
  });

  it("이미 만든 것은 다시 안 집는다 — 이 집합이 곧 커서다", () => {
    const list = candidates({
      source: source(), videos: VIDEOS, alreadyMade: new Set(["new1", "old1"]),
    });
    assert.deepEqual(list.map((v) => v.videoId), ["new2"]);
  });

  it("최신순이다 — 과거부터 처리하면 오늘 영상이 몇 달 뒤에 나간다", () => {
    const list = candidates({ source: source(), videos: [...VIDEOS].reverse(), alreadyMade: new Set() });
    assert.deepEqual(list.map((v) => v.videoId), ["new1", "new2", "old1"]);
  });

  it("소급을 끄면 등록 이후 업로드만 본다", () => {
    const list = candidates({
      source: source({ backfill: false }), videos: VIDEOS, alreadyMade: new Set(),
    });
    assert.deepEqual(list.map((v) => v.videoId), ["new1", "new2"], "작년 회차가 따라왔다");
  });

  it("날짜를 못 읽는 영상은 맨 뒤로 — 순서를 모르는 값이 먼저 처리되면 안 된다", () => {
    const list = candidates({
      source: source(),
      videos: [{ videoId: "bad", title: "?", publishedAt: "언젠가", durationSec: 3600 }, ...VIDEOS],
      alreadyMade: new Set(),
    });
    assert.equal(list[list.length - 1].videoId, "bad");
  });
});

describe("한 편만 집는다", () => {
  // 재고 0 · 하루 3편 배포 = 가져올 이유가 있는 상태. **수요 0 은 이제 아예 안 집는다**
  // (no_plan) — 배포할 곳이 없으면 다운로드조차 하지 않는다.
  const base = {
    videos: VIDEOS, alreadyMade: new Set<string>(), madeToday: 0, inFlight: 0, stuck: 0,
    creditBalance: NO_CREDIT_LIMIT, stock: 0, dailyDemand: 3,
  };

  it("가장 최신 롱폼 하나를 집고, 필요한 크레딧을 함께 알려 준다", () => {
    const v = pickNext({ source: source(), ...base });
    assert.ok(v.pick, "아무것도 안 집었다");
    assert.equal(v.pick.videoId, "new1");
    assert.equal(v.needCredits, 60, "3600초 = 60크레딧");
  });

  it("앞 편이 도는 중이면 안 집는다", () => {
    const v = pickNext({ source: source(), ...base, inFlight: MAX_IN_FLIGHT });
    assert.equal(v.pick, null);
    assert.equal(v.code, "in_flight");
  });

  it("오늘 한 편을 이미 가져왔으면 안 집는다 — 상한을 올려도 하루 1편이다", () => {
    const v = pickNext({ source: source({ dailyCap: 20 }), ...base, madeToday: 1 });
    assert.equal(v.pick, null);
    assert.equal(v.code, "daily_cap");
    // 순회가 하루 한 번이라 dailyCap 을 20 으로 올려도 실제로는 1편이다. 사유 문구가
    // **실제 상한**을 말해야 한다 — "하루 20편" 이라 적으면 사용자는 19편을 기다린다.
    assert.match(v.reason, /하루 1편/);
  });

  it("일시정지·미승인은 각각 다른 사유로 멈춘다", () => {
    const paused = pickNext({ source: source({ status: "paused" }), ...base });
    const blocked = pickNext({ source: source({ status: "blocked" }), ...base });
    assert.equal(paused.pick, null);
    assert.equal(blocked.pick, null);
    // `pick: null` 을 먼저 확인해야 타입이 좁혀진다 — 판정 결과는 둘 중 하나이고,
    // 그걸 코드로 강제하는 것이 이 유니온의 존재 이유다.
    if (paused.pick === null) assert.equal(paused.code, "paused");
    if (blocked.pick === null) assert.equal(blocked.code, "blocked");
  });

  it("승인 안 된 채널은 **어떤 경우에도** 안 집는다 — 저작권 사고의 자리다", () => {
    const v = pickNext({
      source: source({ status: "blocked" }), ...base,
      madeToday: 0, inFlight: 0, creditBalance: 999_999,
    });
    assert.equal(v.pick, null);
  });

  it("크레딧이 모자라면 안 집는다 — 분석을 돌리고 나서 알면 이미 늦다", () => {
    const v = pickNext({ source: source(), ...base, creditBalance: 59 });
    assert.equal(v.pick, null);
    assert.equal(v.code, "insufficient_credits");
    assert.match(v.reason, /필요 60 · 보유 59/);
  });

  it("잔액을 못 읽었으면 막지 않는다 — 조회 실패로 자동화를 세우지 않는다", () => {
    const v = pickNext({ source: source(), ...base, creditBalance: null });
    assert.ok(v.pick);
  });

  it("가져올 게 없으면 그렇게 말한다", () => {
    const v = pickNext({
      source: source(), ...base,
      alreadyMade: new Set(["new1", "new2", "old1"]),
    });
    assert.equal(v.pick, null);
    assert.equal(v.code, "no_candidate");
  });
});

describe("등록 전 예상치", () => {
  it("남은 편수·크레딧·소요일을 같이 준다", () => {
    const e = estimate({ source: source({ dailyCap: 2 }), videos: VIDEOS, alreadyMade: new Set() });
    assert.equal(e.remaining, 3, "롱폼 3편");
    assert.equal(e.credits, 60 + 45 + 90, "3600·2700·5400초");
    // **실제 페이스로 센다.** dailyCap 2 를 그대로 나누면 2일이라 적히는데, 순회가 하루
    // 한 번이라 실제로는 3일이다 — 화면이 지키지도 못할 소요일을 약속하면 안 된다.
    assert.equal(e.days, 3, "3편 ÷ 하루 1편 = 3일");
  });

  it("후보와 같은 기준을 쓴다 — 화면 숫자와 실제 수확이 어긋나면 그 숫자는 거짓말이다", () => {
    const args = { source: source({ backfill: false }), videos: VIDEOS, alreadyMade: new Set(["new1"]) };
    assert.equal(estimate(args).remaining, candidates(args).length);
  });
});

describe("값 범위", () => {
  it("하루 상한은 1~20 — 0·음수로 상한을 무력화하지 못한다", () => {
    assert.equal(clampCap(0), DEFAULT_DAILY_CAP);
    assert.equal(clampCap(-5), DEFAULT_DAILY_CAP);
    assert.equal(clampCap("aaa"), DEFAULT_DAILY_CAP);
    assert.equal(clampCap(999), 20);
    assert.equal(clampCap(3), 3);
  });

  it("롱폼 하한은 60초 이상", () => {
    assert.equal(clampMinDuration(10), DEFAULT_MIN_DURATION_SEC);
    assert.equal(clampMinDuration(600), 600);
  });
});

describe("채널 주소 해석", () => {
  it("UC 아이디는 그대로 읽는다", () => {
    assert.deepEqual(parseChannelRef("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"),
      { kind: "id", id: "UCabcdefghijklmnopqrstuv" });
    assert.deepEqual(parseChannelRef("UCabcdefghijklmnopqrstuv"),
      { kind: "id", id: "UCabcdefghijklmnopqrstuv" });
  });

  it("핸들은 '핸들이다' 까지만 — 여기서 채널 id 를 지어내면 남의 채널을 수확한다", () => {
    assert.deepEqual(parseChannelRef("https://www.youtube.com/@ena.official"),
      { kind: "handle", handle: "ena.official" });
  });

  it("알 수 없는 주소는 null", () => {
    assert.equal(parseChannelRef("https://example.com/x"), null);
    assert.equal(parseChannelRef(""), null);
  });
});

/**
 * 재고 게이트 — **완전자동화의 브레이크**.
 *
 * 수천 편짜리 채널을 보고 있을 수 있어서, 이게 없으면 배포되지도 않을 영상을 계속 분석한다.
 * 크레딧은 나가고 결과물만 쌓인다. 사용자 결정(2026-09-04): 배포 스케줄이 오늘 낼 몫을
 * 이미 갖고 있으면 분석을 돌리지 않는다.
 */
describe("재고 게이트", () => {
  const base = {
    videos: VIDEOS, alreadyMade: new Set<string>(), madeToday: 0, inFlight: 0, stuck: 0,
    creditBalance: null as number | null,
  };

  it("하루 3편 배포에 6편이 대기 중이면 더 안 만든다", () => {
    const v = pickNext({ source: source(), ...base, stock: 6, dailyDemand: 3 });
    assert.equal(v.pick, null);
    if (v.pick === null) {
      assert.equal(v.code, "stocked");
      assert.match(v.reason, /대기 6편 · 하루 3편/);
    }
  });

  it("재고가 모자라면 만든다", () => {
    const v = pickNext({ source: source(), ...base, stock: 5, dailyDemand: 3 });
    assert.ok(v.pick, "6편 미만인데 안 만들었다");
  });

  it("배포 계획이 없으면(수요 0) **아무것도 가져오지 않는다** — 다운로드조차도", () => {
    const v = pickNext({ source: source(), ...base, stock: 0, dailyDemand: 0 });
    assert.equal(v.pick, null, "배포할 곳이 없는데 받아 두면 채널 전체를 하루 한 편씩 받게 된다");
    if (v.pick === null) assert.equal(v.code, "no_plan");
  });

  it("계획을 멈춘 것도 같은 자리다 — 배포를 멈췄는데 다운로드가 계속되면 안 된다", () => {
    // 순방은 멈춘 계획을 하루 발행 수에서 빼므로(dailyDemandFor), 여기엔 수요 0 으로 온다.
    const v = pickNext({ source: source(), ...base, stock: 2, dailyDemand: 0 });
    if (v.pick === null) assert.equal(v.code, "no_plan");
  });

  it("기준은 하루치가 아니라 며칠치다", () => {
    assert.equal(STOCK_BUFFER_DAYS, 2);
    assert.equal(enoughStock(3, 3), false, "하루치만으론 부족하다 — 렌더 실패 한 번에 다음 날이 빈다");
    assert.equal(enoughStock(6, 3), true);
    assert.equal(enoughStock(999, 0), false, "수요가 없으면 판정 자체를 안 한다");
  });

  it("상한·정지가 재고보다 먼저다 — 싼 판정을 앞에 둔다", () => {
    const v = pickNext({ source: source({ status: "paused" }), ...base, stock: 0, dailyDemand: 3 });
    if (v.pick === null) assert.equal(v.code, "paused");
  });
});

/**
 * 하루 실질 상한 — **다운로드가 쌓이지 않는 근거.**
 *
 * 회차를 만드는 순간 다운로드와 분석이 한 줄로 묶여 나간다. 그래서 "하루 몇 편을 집는가" 가
 * 곧 "하루 몇 편을 받는가" 다. 순회가 하루 한 번이고 순회당 한 편이라 답은 1편이고,
 * 화면의 예상 소요일도 그 수로 나와야 한다.
 */
describe("하루 실질 상한", () => {
  it("수집원당 하루 1편이다", () => {
    assert.equal(MAX_PER_DAY, 1);
  });

  it("사용자가 상한을 올려도 실질 상한을 못 넘는다", () => {
    assert.equal(effectiveDailyCap({ dailyCap: 20 }), 1);
    assert.equal(effectiveDailyCap({ dailyCap: 2 }), 1);
  });

  it("빈 값·0 은 기본값으로 떨어지고, 그래도 실질 상한을 못 넘는다", () => {
    assert.equal(effectiveDailyCap({ dailyCap: 0 }), 1);
  });
});

describe("수확 시각", () => {
  it("KST 새벽 2시대에만 참", () => {
    // 2026-09-04 02:30 KST = 2026-09-03 17:30 UTC
    assert.equal(isHarvestWindow(new Date("2026-09-03T17:30:00Z")), true);
    assert.equal(isHarvestWindow(new Date("2026-09-03T18:30:00Z")), false, "3시대는 아니다");
    assert.equal(isHarvestWindow(new Date("2026-09-03T16:30:00Z")), false, "1시대는 아니다");
  });

  it("한 시간 창이다 — 워커가 정각에 깨어난다는 보장이 없다", () => {
    assert.equal(HARVEST_HOUR_KST, 2);
    assert.equal(isHarvestWindow(new Date("2026-09-03T17:00:00Z")), true);
    assert.equal(isHarvestWindow(new Date("2026-09-03T17:59:59Z")), true);
  });
});

/**
 * 배포 계획 요약 — **"만들기만 하고 안 나간다" 를 화면이 말할 수 있는가.**
 *
 * 이 판정이 틀리면 사용자는 계획이 있는 줄 알고 기다리는데 아무것도 안 나가거나, 반대로
 * 멀쩡히 도는 계획을 없다고 표시해 계획을 하나 더 만들게 된다(그러면 두 배로 나간다).
 */
describe("배포 계획 요약", () => {
  const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
    id: "ar_1", programId: "p1", platform: "youtube", accountId: "UCpub1",
    mediaKind: "short", gatePolicy: "hold_on_issue", window: "수시", enabled: true, ...over,
  });

  it("계획이 없으면 null — 이 상태가 곧 '아무 데도 안 나감' 이다", () => {
    assert.equal(publishSummary("p1", []), null);
  });

  it("멈춘 계획은 없는 것으로 본다", () => {
    assert.equal(publishSummary("p1", [rule({ enabled: false })]), null);
  });

  it("다른 프로그램 계획은 내 것이 아니다", () => {
    assert.equal(publishSummary("p1", [rule({ programId: "p2" })]), null);
  });

  it("채널 이름을 붙인다 — 모르는 id 는 id 그대로 남긴다", () => {
    const s = publishSummary("p1", [rule({ accountId: "UCpub1" })], [
      { channelId: "UCpub1", channelName: "우리 숏폼 채널" },
    ]);
    assert.deepEqual(s?.channels, [{ accountId: "UCpub1", name: "우리 숏폼 채널" }]);

    const unknown = publishSummary("p1", [rule({ accountId: "UCpub9" })], []);
    assert.equal(unknown?.channels[0].name, "UCpub9");
  });

  it("하루 발행 수는 슬롯 개수의 합 — 순방(perDayCount)과 같은 함수여야 한다", () => {
    const s = publishSummary("p1", [rule({ slots: [{ time: "07:00", count: 2 }, { time: "19:00", count: 3 }] })]);
    assert.equal(s?.perDay, 5);
    assert.deepEqual(s?.slots.map((x) => x.time), ["07:00", "19:00"]);
  });

  it("슬롯이 없으면 할당량 방식 기본값(3)", () => {
    assert.equal(publishSummary("p1", [rule()])?.perDay, 3);
  });

  it("계획이 여러 개면 하루 발행 수를 합친다", () => {
    const s = publishSummary("p1", [
      rule({ id: "ar_1", accountId: "UCa", slots: [{ time: "07:00", count: 2 }] }),
      rule({ id: "ar_2", accountId: "UCb", slots: [{ time: "19:00", count: 1 }] }),
    ]);
    assert.equal(s?.perDay, 3);
    assert.deepEqual(s?.channels.map((c) => c.accountId), ["UCa", "UCb"]);
  });

  it("같은 채널이 두 계획에 있어도 한 번만 센다", () => {
    const s = publishSummary("p1", [rule({ id: "ar_1" }), rule({ id: "ar_2", programId: "p1" })]);
    assert.equal(s?.channels.length, 1);
  });

  it("유튜브가 아닌 채널은 배포처로 말하지 않는다 — 완전자동화는 유튜브→유튜브다", () => {
    const s = publishSummary("p1", [rule({
      platform: "youtube", accountId: "UCa",
      channels: [{ platform: "instagram", accountId: "ig1" }, { platform: "youtube", accountId: "UCa" }],
    })]);
    assert.deepEqual(s?.channels.map((c) => c.accountId), ["UCa"]);
  });

  it("요일은 정규화해서 준다 — 비면 null(= 매일)", () => {
    assert.equal(publishSummary("p1", [rule()])?.weekdays, null);
    assert.deepEqual(publishSummary("p1", [rule({ weekdays: [5, 1, 1] })])?.weekdays, [1, 5]);
  });
});

/**
 * 멈춘 편 — **자동화가 조용히 죽는 자리.**
 *
 * 분석 완료 표시는 성공해야 생긴다. 그래서 다운로드나 분석이 죽은 회차는 영원히 미완이고,
 * 그걸 "진행 중" 으로 세면 MAX_IN_FLIGHT=1 에 걸려 수집원이 다시는 안 돈다
 * (프로덕션 실측 2026-09-04: 4일째 멈춘 미디어 하나가 수집원 하나를 세우고 있었다).
 */
describe("멈춘 편", () => {
  const base = {
    videos: VIDEOS, alreadyMade: new Set<string>(), madeToday: 0, inFlight: 0, stuck: 0,
    creditBalance: NO_CREDIT_LIMIT, stock: 0, dailyDemand: 3,
  };

  it("멈춘 편은 수확을 막지 않는다 — 막으면 수집원이 영영 안 돈다", () => {
    const v = pickNext({ source: source(), ...base, stuck: 1 });
    assert.ok(v.pick, "멈춘 편 하나가 수집원을 통째로 세웠다");
  });

  it("멈췄다는 사실은 결론과 함께 나온다 — 조용히 넘어가지 않는다", () => {
    const v = pickNext({ source: source(), ...base, stuck: 2 });
    assert.match(v.warning ?? "", /2편이 24시간 넘게 멈춰/);
    assert.match(v.warning ?? "", /사무실 PC/, "무엇을 확인해야 하는지가 문구에 있어야 한다");
  });

  it("안 집는 경우에도 경고가 붙는다", () => {
    const v = pickNext({ source: source(), ...base, stuck: 1, madeToday: 1 });
    assert.equal(v.pick, null);
    if (v.pick === null) assert.equal(v.code, "daily_cap");
    assert.match(v.warning ?? "", /멈춰 있습니다/);
  });

  it("멈춘 게 없으면 경고도 없다 — 없는 문제를 말하지 않는다", () => {
    assert.equal(stuckWarning(0), undefined);
    assert.equal(pickNext({ source: source(), ...base }).warning, undefined);
  });

  it("진짜 진행 중은 여전히 막는다 — 상한이 사라지면 안 된다", () => {
    const v = pickNext({ source: source(), ...base, inFlight: MAX_IN_FLIGHT, stuck: 3 });
    assert.equal(v.pick, null);
    if (v.pick === null) assert.equal(v.code, "in_flight");
  });

  it("임계값은 정상 파이프라인이 절대 못 넘는 값이다 — 60분 분석이 ~19분", () => {
    assert.equal(STUCK_AFTER_MS, 24 * 60 * 60 * 1000);
  });
});

/**
 * 주소 해석의 **오답 금지** — 확인하라고 만든 미리보기가 그럴듯한 오답을 보여주면
 * 확인이 없느니만 못하다(2026-09-04 프로덕션 실측: `@하하ㅔ` 오타가 `하하` 로 잘려
 * **실제로 존재하는 다른 채널**을 가리켰다).
 */
describe("채널 주소 해석 — 조용히 다른 채널이 되지 않는다", () => {
  it("핸들에 못 읽는 글자가 섞이면 잘라 쓰지 않고 못 읽었다고 한다", () => {
    // ㅔ 는 완성형 한글(가-힣)이 아니다 — 예전엔 여기서 끊어 '하하' 로 읽었다.
    assert.equal(parseChannelRef("https://www.youtube.com/@하하ㅔ"), null);
  });

  it("멀쩡한 핸들은 그대로 읽는다", () => {
    assert.deepEqual(parseChannelRef("https://www.youtube.com/@하하PD"), { kind: "handle", handle: "하하PD" });
  });

  it("경로·질의가 뒤에 붙어도 핸들만 뽑는다", () => {
    assert.deepEqual(parseChannelRef("https://www.youtube.com/@abc_pd/videos"), { kind: "handle", handle: "abc_pd" });
    assert.deepEqual(parseChannelRef("https://www.youtube.com/@abc_pd?si=x"), { kind: "handle", handle: "abc_pd" });
  });

  it("주소창에서 복사한 퍼센트 인코딩도 읽는다 — 사람이 붙여넣는 실제 모양이다", () => {
    assert.deepEqual(
      parseChannelRef("https://www.youtube.com/@%ED%95%98%ED%95%98PD"),
      { kind: "handle", handle: "하하PD" },
    );
  });

  it("깨진 인코딩은 예외로 번지지 않는다", () => {
    assert.doesNotThrow(() => parseChannelRef("https://www.youtube.com/@%E0%A4%A"));
  });
});

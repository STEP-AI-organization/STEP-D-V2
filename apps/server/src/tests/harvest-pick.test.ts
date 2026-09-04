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
  DEFAULT_DAILY_CAP, DEFAULT_MIN_DURATION_SEC, HARVEST_HOUR_KST, MAX_IN_FLIGHT, STOCK_BUFFER_DAYS,
  candidates, clampCap, clampMinDuration, enoughStock, estimate, isHarvestWindow, parseChannelRef,
  pickNext, type ChannelVideo, type HarvestSource,
} from "../pipeline/harvest.ts";

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
  // 재고 0 · 수요 0 = 재고 게이트를 끈 상태(수요가 없으면 판정하지 않는다).
  const base = {
    videos: VIDEOS, alreadyMade: new Set<string>(), madeToday: 0, inFlight: 0,
    creditBalance: NO_CREDIT_LIMIT, stock: 0, dailyDemand: 0,
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

  it("오늘 몫을 채웠으면 안 집는다", () => {
    const v = pickNext({ source: source({ dailyCap: 2 }), ...base, madeToday: 2 });
    assert.equal(v.pick, null);
    assert.equal(v.code, "daily_cap");
    assert.match(v.reason, /하루 2편/);
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
    assert.equal(e.days, 2, "3편 ÷ 하루 2편 = 2일");
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
    videos: VIDEOS, alreadyMade: new Set<string>(), madeToday: 0, inFlight: 0,
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

  it("배포 계획이 없으면(수요 0) 재고로 막지 않는다 — 계획을 나중에 만드는 순서도 정상이다", () => {
    const v = pickNext({ source: source(), ...base, stock: 999, dailyDemand: 0 });
    assert.ok(v.pick, "계획이 없다고 수집을 막으면 '등록했는데 아무 일도 안 남' 이 된다");
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

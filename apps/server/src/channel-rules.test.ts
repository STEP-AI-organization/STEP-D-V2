/**
 * 채널 규칙 판정 고정 (FLOWS F4-2).
 *
 * "길이 상한 초과 → 해당 채널은 선택 불가 + **사유 표시**" 가 핵심이다.
 * 그냥 못 고르게만 하면 사용자는 왜 안 되는지 몰라 다른 데를 찾아 헤맨다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRule,
  defaultRuleFor,
  eligibility,
  eligibilityForAll,
  frameOf,
  isShortForm,
  type ChannelRule,
  type MediaFacts,
} from "./channel-rules.ts";

const rule = (over: Partial<ChannelRule> = {}): ChannelRule => ({
  platform: "youtube",
  accountId: "c1",
  label: "본채널",
  role: "main",
  maxSec: null,
  aspect: "any",
  titlePrefix: "",
  hashtagTemplate: "",
  tonePreset: "기본",
  privacy: "public",
  scheduleWindow: "",
  enabled: true,
  ...over,
});

const media = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  id: "m1",
  durationSec: 45,
  aspectRatio: "9:16-crop-main",
  rendered: true,
  ...over,
});

describe("길이 상한 (F4-2)", () => {
  it("상한을 넘으면 막고 얼마나 넘었는지 말한다", () => {
    const r = eligibility(rule({ maxSec: 60 }), media({ durationSec: 74 }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "too_long");
    assert.match(r.reason, /60초/);
    assert.match(r.reason, /14초/);
  });

  it("정확히 상한이면 통과한다", () => {
    assert.equal(eligibility(rule({ maxSec: 60 }), media({ durationSec: 60 })).ok, true);
  });

  it("상한이 null 이면 길이를 보지 않는다", () => {
    assert.equal(eligibility(rule({ maxSec: null }), media({ durationSec: 9999 })).ok, true);
  });

  it("막힌 이유는 절대 빈 문자열이 아니다", () => {
    // 사유 없는 비활성화는 "왜 안 되지"에서 사용자를 세운다.
    const cases: [Partial<ChannelRule>, Partial<MediaFacts>][] = [
      [{ maxSec: 10 }, { durationSec: 30 }],
      [{ role: "shorts_only" }, { aspectRatio: "16:9" }],
      [{ aspect: "16:9" }, { aspectRatio: "9:16" }],
      [{ enabled: false }, {}],
      [{}, { rendered: false }],
    ];
    for (const [r, m] of cases) {
      const got = eligibility(rule(r), media(m));
      assert.equal(got.ok, false);
      assert.notEqual(got.reason.trim(), "", JSON.stringify(r));
      assert.notEqual(got.code, "");
    }
  });
});

describe("숏폼 전용 채널 (F4-2)", () => {
  it("가로 클립을 숏폼 전용 채널에 못 보낸다", () => {
    const r = eligibility(rule({ role: "shorts_only", label: "쇼츠채널" }), media({ aspectRatio: "16:9" }));
    assert.equal(r.code, "shorts_only");
    assert.match(r.reason, /쇼츠채널/);
  });

  it("세로 숏폼은 보낼 수 있다", () => {
    assert.equal(eligibility(rule({ role: "shorts_only" }), media({ aspectRatio: "9:16-letterbox" })).ok, true);
  });

  it("프레임을 모르면 프레임 때문에 막지는 않는다", () => {
    // 모르는 값으로 막으면 옛 데이터가 전부 배포 불가가 된다. 길이 등 다른 규칙은 그대로 본다.
    assert.equal(eligibility(rule({ role: "shorts_only", maxSec: 60 }), media({ aspectRatio: null })).ok, true);
    assert.equal(
      eligibility(rule({ role: "shorts_only", maxSec: 60 }), media({ aspectRatio: null, durationSec: 90 })).code,
      "too_long",
    );
  });
});

describe("렌더 전 · 사용 중지", () => {
  it("렌더 전이면 보내지 않는다", () => {
    assert.equal(eligibility(rule(), media({ rendered: false })).code, "not_rendered");
  });

  it("사용 중지 채널이 가장 먼저 걸린다", () => {
    // 길이도 넘고 중지도 됐으면 "중지"를 먼저 말해 준다 — 길이를 고쳐도 어차피 못 보낸다.
    assert.equal(eligibility(rule({ enabled: false, maxSec: 10 }), media({ durationSec: 99 })).code, "disabled");
  });
});

describe("제목 접두사·해시태그 (F4-2 선택 즉시 반영)", () => {
  it("접두사를 두 번 붙이지 않는다", () => {
    const r = rule({ titlePrefix: "[예능]" });
    const once = applyRule(r, { title: "제목" }).title;
    const twice = applyRule(r, { title: once }).title;
    assert.equal(once, "[예능] 제목");
    assert.equal(twice, once);
  });

  it("접두사가 없으면 제목을 건드리지 않는다", () => {
    assert.equal(applyRule(rule(), { title: "  제목  " }).title, "제목");
  });

  it("해시태그 템플릿의 프로그램명에서 공백을 뺀다", () => {
    const r = rule({ hashtagTemplate: "#{program} #{episode}회" });
    assert.equal(applyRule(r, { title: "t", program: "나는 솔로", episode: 12 }).hashtags, "#나는솔로 #12회");
  });
});

describe("여러 건 한꺼번에", () => {
  it("막힌 것만 사유와 함께 모은다", () => {
    const r = rule({ maxSec: 60 });
    const got = eligibilityForAll(r, [media({ id: "a", durationSec: 30 }), media({ id: "b", durationSec: 90 })]);
    assert.equal(got.ok, false);
    assert.deepEqual(got.blocked.map((b) => b.media.id), ["b"]);
  });

  it("전부 통과하면 ok", () => {
    assert.equal(eligibilityForAll(rule(), [media(), media({ id: "b" })]).ok, true);
  });
});

describe("역할 기본값", () => {
  it("숏폼 전용은 세로 + 길이 상한을 갖고 시작한다", () => {
    const yt = defaultRuleFor("shorts_only", "youtube");
    assert.equal(yt.aspect, "9:16");
    assert.equal(yt.maxSec, 60);
  });

  it("본채널은 제한 없이 시작한다", () => {
    const main = defaultRuleFor("main", "youtube");
    assert.equal(main.maxSec, null);
    assert.equal(main.aspect, "any");
  });

  it("SMR 은 가로 3분", () => {
    const smr = defaultRuleFor("main", "smr");
    assert.equal(smr.aspect, "16:9");
    assert.equal(smr.maxSec, 180);
  });
});

describe("프레임 해석", () => {
  it("에디터 어휘를 프레임으로 좁힌다", () => {
    assert.equal(frameOf("9:16-crop-main"), "9:16");
    assert.equal(frameOf("16:9"), "16:9");
    assert.equal(frameOf("1:1"), null);
    assert.equal(frameOf(null), null);
  });

  it("세로면 숏폼", () => {
    assert.equal(isShortForm(media({ aspectRatio: "9:16-crop-main" })), true);
    assert.equal(isShortForm(media({ aspectRatio: "16:9" })), false);
  });
});

/**
 * 채널 규칙 판정 고정 (FLOWS F4-2).
 *
 * "길이 상한 초과 → 해당 채널은 선택 불가 + **사유 표시**" 가 핵심이다.
 * 그냥 못 고르게만 하면 사용자는 왜 안 되는지 몰라 다른 데를 찾아 헤맨다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  applyRule,
  defaultRuleFor,
  eligibility,
  eligibilityForAll,
  frameOf,
  isShortForm,
  normalizePublishDelayMin,
  nextPublishSlot,
  DEFAULT_PUBLISH_DELAY_MIN,
  PUBLISH_SLOT_MIN,
  type ChannelRule,
  type MediaFacts,
} from "./channel-rules.ts";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

const rule = (over: Partial<ChannelRule> = {}): ChannelRule => ({
  platform: "youtube",
  accountId: "c1",
  label: "본채널",
  role: "main",
  publishDelayMin: 5,
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

  it("네이버 TV 는 가로 3분", () => {
    const smr = defaultRuleFor("main", "navertv");
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

/**
 * 공개 유예 — 자동 게시를 N분 비공개로 잡아뒀다 공개한다(유튜브 publishAt 예약).
 *
 * 근거는 "알고리즘이 영상을 이해할 시간"이 아니라 **처리 완료**다: 업로드 직후엔 HD 트랜스
 * 코딩이 안 끝났고(초기 시청자가 360p 를 본다) 커스텀 썸네일도 업로드 뒤에 붙는다.
 *
 * ⚠️ 여기서 제일 중요한 불변식은 **unlisted·private 에는 걸지 않는다** 는 것이다. publishAt
 * 예약은 결국 **공개로 끝나므로**, 운영자가 "링크 아는 사람만" 으로 둔 채널에 걸면 그 의도를
 * 조용히 뒤집어 전체공개가 된다 — 되돌리려면 채널에서 직접 내려야 하고 노출 이력이 남는다.
 */
describe("공개 유예 (publishDelayMin)", () => {
  it("값 정규화 — 음수·비수치는 기본값(0=다이렉트), 0 은 즉시로 살린다", () => {
    assert.equal(normalizePublishDelayMin(undefined), DEFAULT_PUBLISH_DELAY_MIN);
    assert.equal(normalizePublishDelayMin("abc"), DEFAULT_PUBLISH_DELAY_MIN);
    assert.equal(normalizePublishDelayMin(-3), DEFAULT_PUBLISH_DELAY_MIN);
    // 0 은 "즉시 공개" 라는 뜻이 있는 값이다 — 기본값으로 되돌리면 유예를 끌 수가 없다.
    assert.equal(normalizePublishDelayMin(0), 0);
    // 5분 격자로 **올림** — 내림하면 사용자가 정한 유예보다 짧아진다.
    assert.equal(normalizePublishDelayMin("12"), 15);
    assert.equal(normalizePublishDelayMin(7.6), 10);
    assert.equal(normalizePublishDelayMin(13), 15, "13분은 격자를 벗어난다 — 15분이어야 한다");
    assert.equal(normalizePublishDelayMin(10), 10, "이미 격자에 맞으면 그대로 둔다");
    assert.equal(normalizePublishDelayMin(99999), 360, "예약 상한(6시간)을 넘겨 잡으면 안 된다");
    assert.equal(360 % PUBLISH_SLOT_MIN, 0, "상한 자체가 격자에 안 맞으면 잘린 값이 예약을 깬다");
  });

  it("예약 시각은 5분 경계로 올림된다 — 유튜브가 격자 밖 시각을 거부할 수 있다", () => {
    // 15:31:10 + 5분 = 15:36:10 → 격자 밖. 15:40:00 으로 올린다.
    const base = Date.parse("2026-08-20T15:31:10.000Z");
    const at = nextPublishSlot(base + 5 * 60_000);
    assert.equal(at.toISOString(), "2026-08-20T15:40:00.000Z");
    assert.equal(at.getUTCMinutes() % PUBLISH_SLOT_MIN, 0, "분이 5의 배수가 아니다");
    assert.equal(at.getUTCSeconds(), 0, "초가 남아 있으면 격자에 맞지 않는다");
    // 항상 올림 — 설정한 유예보다 **짧아지지 않는다**.
    assert.ok(at.getTime() >= base + 5 * 60_000, "올림이 아니라 내림이 됐다");
    // 이미 경계면 그대로(불필요하게 5분 더 밀지 않는다).
    const exact = Date.parse("2026-08-20T15:40:00.000Z");
    assert.equal(nextPublishSlot(exact).toISOString(), "2026-08-20T15:40:00.000Z");
  });

  it("순방이 예약을 거는 조건 — public 일 때만, 그리고 유예가 0 이 아닐 때만", () => {
    const src = fs.readFileSync(path.join(SRC_DIR, "automation-cycle.ts"), "utf-8");
    // ⚠️ `\n\}` 만으로 끊으면 **반환 타입 객체**가 `\n} {` 로 끝나 시그니처에서 잘린다 —
    //    본문 단언이 전부 헛돈다. 줄 끝까지(`\n}\n`) 봐야 함수 전체가 잡힌다.
    const fn = src.match(/function youtubeReleasePlan[\s\S]*?\n\}\r?\n/)?.[0] ?? "";
    assert.ok(fn, "youtubeReleasePlan 을 못 찾았다");
    assert.match(fn, /if \(privacy !== "public"\) return \{ privacy \};/,
      "unlisted·private 에 예약을 걸면 운영자가 정한 공개 범위가 전체공개로 뒤집힌다");
    assert.match(fn, /if \(delayMin <= 0\) return \{ privacy \};/, "0 분이면 예약 없이 즉시여야 한다");
    // 폴백은 public(다이렉트 배포 · 사용자 2026-08-25) — unlisted 폴백은 "게시됨인데 채널에
    // 안 보인다"는 혼란을 만들었다. 검수는 승인배포 모드의 몫이지 공개 범위의 몫이 아니다.
    assert.match(fn, /: "public";/, "공개 범위 폴백이 public 이 아니다 — 다이렉트 배포 결정과 어긋난다");
  });

  it("예약 시각은 오프셋이 박힌 ISO 로 넘긴다 (KST 해석 여지 없이)", () => {
    const src = fs.readFileSync(path.join(SRC_DIR, "automation-cycle.ts"), "utf-8");
    // normalizeReserveDate 는 오프셋 없는 문자열을 KST 로 읽는다 — 로컬 포맷을 넘기면 9시간 어긋난다.
    assert.match(src, /nextPublishSlot\(Date\.now\(\) \+ delayMin \* 60_000\)/,
      "예약 시각을 5분 격자로 안 올리면 유튜브가 거부할 수 있다");
    assert.match(src, /reserveDate: at\.toISOString\(\)/,
      "예약 시각을 ISO(Z) 로 안 넘기면 타임존 해석에서 어긋난다");
  });

  it("유튜브 업로드가 publishAt 을 받으면 private 로 올린다 (유튜브가 스스로 공개)", () => {
    // 우리가 N분 뒤 공개 API 를 부르는 방식은 워커가 죽으면 영원히 비공개로 남는다.
    const yt = fs.readFileSync(path.join(SRC_DIR, "youtube.ts"), "utf-8");
    assert.match(yt, /privacyStatus: meta\.publishAt \? "private" : meta\.privacyStatus/,
      "publishAt 을 줬는데 private 로 안 올리면 유튜브가 예약을 거부한다");
  });
});

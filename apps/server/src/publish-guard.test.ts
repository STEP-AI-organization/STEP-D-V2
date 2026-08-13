/**
 * 배포 관문 — 불변식 고정 (FLOWS F3 강제 · F4).
 *
 * 이 파일의 마지막 테스트(아키텍처 테스트)가 이 작업 전체의 핵심이다.
 * "어떤 경로로도 게시되지 않는다"(FLOWS.md:73)는 순수 함수 테스트로는 증명할 수 없다 —
 * 새 경로가 하나 생기면 그만이기 때문이다. 소스 전체를 스캔해 **큐에 넣는 지점이
 * 한 곳뿐**임을 강제하는 형태로만 고정된다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  channelPublishMode,
  distributionStatusFor,
  hasAccountDistribution,
  isClipRendered,
  isPublishChannel,
  screenForPublish,
  upsertDistribution,
} from "./publish-guard.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PASS = () => ({ allowed: true, reason: "" });

describe("채널 모드 — 올리는 채널과 기록만 하는 채널 (FLOWS.md:86-87)", () => {
  it("YouTube 와 네이버 TV·클립이 실업로드다", () => {
    assert.equal(channelPublishMode("youtube"), "upload");
    // 네이버는 공개 API 가 없어 브라우저 자동화로 올리지만, **파일이 실제로 올라간다**.
    // record 로 두면 올라간 것을 '기록됨'으로 표시하게 된다 — 반대 방향의 F4 위반이다.
    assert.equal(channelPublishMode("navertv"), "upload");
    assert.equal(channelPublishMode("naverclip"), "upload");
  });

  it("나머지는 전부 기록만 — 새 채널이 추가돼도 기본이 record 여야 한다", () => {
    for (const ch of ["instagram", "facebook", "tiktok", "threads", "새채널"]) {
      assert.equal(channelPublishMode(ch), "record", `${ch} 는 record`);
    }
  });

  it("tiktok 은 게이트가 켜졌을 때만 실업로드(드래프트)다 — 기본은 record", () => {
    // env 를 직접 읽지 않는다(순수 모듈) — 게이트 판정은 호출부가 opts 로 넘긴다.
    assert.equal(channelPublishMode("tiktok"), "record");
    assert.equal(channelPublishMode("tiktok", { tiktokUpload: false }), "record");
    assert.equal(channelPublishMode("tiktok", { tiktokUpload: true }), "upload");
    // 이 스위치는 tiktok 전용이다 — 다른 record 채널을 열면 안 된다.
    assert.equal(channelPublishMode("instagram", { tiktokUpload: true }), "record");
  });
});

describe("'기록됨'을 '게시됨'처럼 보여주지 않는다 (F4 Invariant · FLOWS.md:92)", () => {
  it("record 모드는 예약 여부와 무관하게 recorded 다", () => {
    assert.equal(distributionStatusFor("record", false), "recorded");
    assert.equal(distributionStatusFor("record", true), "recorded");
  });

  it("published 는 어떤 조합에서도 초기 상태로 나오지 않는다", () => {
    // 실제 업로드가 끝난 뒤에만 워커가 published 를 쓴다. 진입 시점엔 절대 아니다.
    for (const mode of ["upload", "record"] as const) {
      for (const scheduled of [true, false]) {
        assert.notEqual(distributionStatusFor(mode, scheduled), "published",
          `${mode}/${scheduled} 가 published 를 만들면 안 된다`);
      }
    }
  });

  it("record 모드에서는 published·pending·scheduled 가 절대 나오지 않는다", () => {
    for (const scheduled of [true, false]) {
      const s = distributionStatusFor("record", scheduled);
      assert.ok(!["published", "pending", "scheduled"].includes(s), `record → ${s}`);
    }
  });
});

describe("렌더 판정", () => {
  it("렌더·미디어·게시 중 하나라도 있으면 배포 가능", () => {
    assert.equal(isClipRendered({ rendered: true }), true);
    assert.equal(isClipRendered({ mediaId: "m_1" }), true);
    assert.equal(isClipRendered({ status: "published" }), true);
  });

  it("채택만 한 클립은 배포 대상이 아니다", () => {
    assert.equal(isClipRendered({ status: "editing" }), false);
    assert.equal(isClipRendered({}), false);
  });
});

describe("distributions upsert", () => {
  it("원본을 변형하지 않는다", () => {
    const before = [{ channel: "youtube", status: "pending" }];
    const after = upsertDistribution(before, "youtube", { status: "published" });
    assert.equal(before[0].status, "pending", "원본이 바뀌면 동시 편집이 서로를 덮어쓴다");
    assert.equal(after[0].status, "published");
  });

  it("없는 채널은 추가한다", () => {
    const after = upsertDistribution([], "instagram", { status: "recorded" });
    assert.deepEqual(after, [{ channel: "instagram", status: "recorded" }]);
  });

  it("같은 플랫폼 두 계정은 두 항목이다 — 덮어쓰면 매 순방 재업로드가 난다", () => {
    // 채널당 1행이던 시절: 계정 B 기록이 A 기록을 덮어 already 체크가 매번 거짓 →
    // 규칙에 YouTube 채널 A·B 를 넣으면 같은 클립이 순방마다 다시 올라갔다.
    const one = [{ channel: "youtube", status: "published", youtubeChannelId: "UC_A" }];
    const two = upsertDistribution(one, "youtube", { status: "pending", youtubeChannelId: "UC_B" });
    assert.equal(two.length, 2);
    assert.equal(two[0].youtubeChannelId, "UC_A");
    assert.equal(two[0].status, "published", "A 계정 기록이 B 에 덮이면 안 된다");
  });

  it("같은 계정으로 다시 쓰면 그 항목만 갱신된다", () => {
    const two = [
      { channel: "youtube", status: "published", youtubeChannelId: "UC_A" },
      { channel: "youtube", status: "pending", youtubeChannelId: "UC_B" },
    ];
    const after = upsertDistribution(two, "youtube", { status: "failed", error: "e", youtubeChannelId: "UC_B" });
    assert.equal(after.length, 2);
    assert.equal(after.find((d: any) => d.youtubeChannelId === "UC_B")?.status, "failed");
    assert.equal(after.find((d: any) => d.youtubeChannelId === "UC_A")?.status, "published");
  });

  it("정체성 없는 쓰기(기록 전용 채널·레거시)는 채널 단독 매칭을 유지한다", () => {
    const before = [{ channel: "instagram", status: "recorded" }];
    const after = upsertDistribution(before, "instagram", { status: "recorded", externalId: "x" });
    assert.equal(after.length, 1, "기록 전용 채널이 계정 없이 항목을 불리면 안 된다");
  });

  it("재순방에 중복 큐잉이 없다 — 계정별 기록이 계정별 already 판정을 성립시킨다", () => {
    // 순방 1: A 로 게시 성공, B 는 아직.
    const dists = [{ channel: "youtube", status: "published", youtubeChannelId: "UC_A" }];
    assert.equal(hasAccountDistribution(dists, "youtube", "UC_A"), true, "A 는 다시 큐잉되면 안 된다");
    assert.equal(hasAccountDistribution(dists, "youtube", "UC_B"), false, "B 는 아직 나가야 한다");
    // 순방 2: B 게시 뒤에는 둘 다 막힌다.
    const both = upsertDistribution(dists, "youtube", { status: "published", youtubeChannelId: "UC_B" });
    assert.equal(hasAccountDistribution(both, "youtube", "UC_A"), true);
    assert.equal(hasAccountDistribution(both, "youtube", "UC_B"), true);
  });

  it("tiktok 다계정도 계정 정체성으로 갈린다 — openId 가 열쇠다", () => {
    const one = [{ channel: "tiktok", status: "published", tiktokOpenId: "open_A" }];
    const two = upsertDistribution(one, "tiktok", { status: "pending", tiktokOpenId: "open_B" });
    assert.equal(two.length, 2, "다른 openId 는 별도 항목이어야 한다");
    assert.equal((two[0] as any).status, "published", "A 계정 기록이 B 에 덮이면 안 된다");
    assert.equal(hasAccountDistribution(two as any, "tiktok", "open_A"), true);
    assert.equal(hasAccountDistribution([{ channel: "tiktok", status: "recorded" }], "tiktok", "open_A"),
      true, "정체성 없는 구 기록은 보수적으로 already 다");
  });

  it("실패한 기록은 already 로 치지 않는다 — 사람이 재시도할 길을 막으면 안 된다", () => {
    const dists = [{ channel: "youtube", status: "failed", youtubeChannelId: "UC_A" }];
    assert.equal(hasAccountDistribution(dists, "youtube", "UC_A"), false);
  });

  it("계정 식별자 없는 구 데이터는 보수적으로 already 다 — 중복 게시가 더 나쁘다", () => {
    const dists = [{ channel: "youtube", status: "published" }];
    assert.equal(hasAccountDistribution(dists, "youtube", "UC_A"), true);
  });
});

describe("채널명 검증 — 모르는 값이 조용히 record 로 수락되면 안 된다", () => {
  it("실제 채널만 통과한다", () => {
    for (const ch of ["youtube", "instagram", "facebook", "tiktok", "navertv", "naverclip"]) {
      assert.equal(isPublishChannel(ch), true, ch);
    }
  });

  it("죽은 이름·오타를 거른다", () => {
    // "meta" 는 폐기된 분기의 잔재다 — channelPublishMode 는 모르는 값을 record 로
    // 처리하므로, 이 검증이 없으면 존재하지 않는 채널에 '기록됨'이 쌓인다.
    for (const ch of ["meta", "youtub", "", "naver"]) {
      assert.equal(isPublishChannel(ch), false, ch);
    }
  });

  it("관문(dispatchPublish)이 이 검증을 쓴다", () => {
    const src = fs.readFileSync(path.join(SRC, "publish-dispatch.ts"), "utf-8");
    assert.match(src, /isPublishChannel\(/, "publish-dispatch 가 채널명을 검증하지 않는다");
  });
});

describe("선별 — 조용한 제외도, 전체 실패도 금지 (FLOWS.md:69)", () => {
  const clips = [
    { id: "c_ok", rendered: true },
    { id: "c_raw", status: "editing" },
    { id: "c_blocked", rendered: true },
  ];

  it("통과 건만 진행하고 나머지는 사유와 함께 반환한다", () => {
    const r = screenForPublish(clips, {
      channel: "youtube",
      gateOf: (id) => id === "c_blocked"
        ? { allowed: false, reason: "권리 홀드 — 음원 미확인" }
        : PASS(),
    });
    assert.deepEqual(r.queue, ["c_ok"]);
    assert.equal(r.skipped.length, 2);
  });

  it("⊘ 전체 실패 처리 금지 — 한 건이 막혀도 나머지는 나간다", () => {
    const r = screenForPublish(clips, {
      channel: "youtube",
      gateOf: (id) => id === "c_blocked" ? { allowed: false, reason: "차단" } : PASS(),
    });
    assert.ok(r.queue.length >= 1, "막힌 건 때문에 전체가 죽으면 안 된다");
  });

  it("⊘ 조용한 제외 금지 — 제외된 건은 전부 사유 문자열을 갖는다", () => {
    const r = screenForPublish(clips, {
      channel: "youtube",
      gateOf: (id) => id === "c_blocked" ? { allowed: false, reason: "권리 홀드" } : PASS(),
    });
    for (const s of r.skipped) {
      assert.ok(s.reason.trim().length > 0, `${s.clipId} 에 사유가 없다`);
      assert.ok(s.code, `${s.clipId} 에 사유 코드가 없다`);
    }
  });

  it("던지지 않는다 — 전부 막혀도 예외가 아니라 빈 queue 다", () => {
    const r = screenForPublish(clips, {
      channel: "youtube", gateOf: () => ({ allowed: false, reason: "전부 차단" }),
    });
    assert.deepEqual(r.queue, []);
    assert.equal(r.skipped.length, 3);
  });

  it("게이트가 막은 것과 렌더가 안 된 것을 코드로 구분한다", () => {
    const r = screenForPublish(clips, {
      channel: "youtube",
      gateOf: (id) => id === "c_blocked" ? { allowed: false, reason: "권리" } : PASS(),
    });
    assert.equal(r.skipped.find((s) => s.clipId === "c_raw")?.code, "not_rendered");
    assert.equal(r.skipped.find((s) => s.clipId === "c_blocked")?.code, "gate_blocked");
  });
});

describe("관문 우회 불가 (F3 Invariant · FLOWS.md:73)", () => {
  it("screenForPublish 에 우회 인자가 없다 — 관리자도 통과시킬 자리가 없다", () => {
    // 시그니처가 (clips, ctx) 두 개다. role·force·override 를 받을 자리를 만들지 않는다.
    assert.equal(screenForPublish.length, 2);
  });

  it("모듈이 force/override/bypass/admin 류를 export 하지 않는다", () => {
    const src = fs.readFileSync(path.join(SRC, "publish-guard.ts"), "utf-8");
    const offenders = [...src.matchAll(/export\s+(?:function|const|let|class)\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((n) => /force|override|bypass|admin|skipGate/i.test(n));
    assert.deepEqual(offenders, [], `우회 API 가 생겼다: ${offenders.join(", ")}`);
  });

  /**
   * ⚠️ 이 테스트가 이 파일의 존재 이유다.
   *
   * "게이트를 통과하지 않은 미디어는 **어떤 경로로도** 게시되지 않는다"(FLOWS.md:73)는
   * 순수 함수 테스트로 증명할 수 없다 — 새 경로가 하나 생기면 그만이기 때문이다.
   * 소스 전체를 스캔해 **큐에 넣는 파일이 하나뿐**임을 강제하는 형태로만 고정된다.
   *
   * 2026-08-10 S2 에서 4경로(publish 라우트 · retry 라우트 · factory · 워커)를
   * publish-dispatch 하나로 모은 뒤 todo 를 뗐다.
   */
  it("배포 큐 진입점은 한 파일뿐이어야 한다", () => {
    const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const hits: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(SRC, f), "utf-8");
      src.split(/\r?\n/).forEach((line, i) => {
        // 주석에 적힌 설명은 세지 않는다 — 규칙을 문서화한 줄까지 위반으로 잡히면
        // 규칙을 설명하지 못하게 된다.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        // 네이버는 잡 종류가 다르다(naver.publish · 별도 레인). 잡이 다르다고 다른 파일에서
        // 넣기 시작하면 게이트를 지나는 문이 둘이 된다 — 같은 규칙으로 묶는다.
        if (/enqueue\(\s*["'](distribution|naver)\.publish["']/.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    const filesWithHits = [...new Set(hits.map((h) => h.split(":")[0]))];
    assert.deepEqual(
      filesWithHits,
      ["publish-dispatch.ts"],
      `배포 큐 진입점이 여러 곳이다: ${hits.join(" · ")}`,
    );
  });

  /**
   * 관문을 지나야만 큐에 들어간다는 것과, 관문이 **게이트를 본다**는 것은 다른 명제다.
   * 후자가 빠지면 관문은 통로일 뿐이다.
   */
  it("관문이 게이트 판정을 읽는다", () => {
    const src = fs.readFileSync(path.join(SRC, "publish-dispatch.ts"), "utf-8");
    assert.match(src, /evaluateGate|clipGate/, "publish-dispatch 가 게이트를 조회하지 않는다");
    assert.match(src, /screenForPublish/, "publish-dispatch 가 순수 판정을 쓰지 않는다");
  });

  /** 업로드 직전 재확인 — 큐에 앉아 있는 동안 이슈가 새로 등록될 수 있다. */
  it("워커가 업로드 직전에 게이트를 다시 본다", () => {
    const src = fs.readFileSync(path.join(SRC, "worker.ts"), "utf-8");
    assert.match(src, /clipGate\(/, "워커에 업로드 직전 게이트 재확인이 없다");
  });
});

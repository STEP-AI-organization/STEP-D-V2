/**
 * 배포 관문 — 불변식 고정 (FLOWS F3 강제 · F4).
 *
 * 이 파일의 마지막 테스트(아키텍처 테스트)가 이 작업 전체의 핵심이다.
 * "어떤 경로로도 게시되지 않는다"(FLOWS.md:73)는 순수 함수 테스트로는 증명할 수 없다 —
 * 새 경로가 하나 생기면 그만이기 때문이다. 소스 전체를 스캔해 **큐에 넣는 지점이
 * 한 곳뿐**임을 강제하는 형태로만 고정된다.
 */
import { sourceFiles } from "./sources.ts";
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
} from "../publish/publish-guard.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    const src = fs.readFileSync(path.join(SRC, "publish/publish-dispatch.ts"), "utf-8");
    assert.match(src, /isPublishChannel\(/, "publish-dispatch 가 채널명을 검증하지 않는다");
  });
});

describe("선별 — 조용한 제외도, 전체 실패도 금지 (FLOWS.md:69)", () => {
  const clips = [
    { id: "c_ok", rendered: true },
    { id: "c_raw", status: "editing" },
    { id: "c_blocked", rendered: true },
  ];

  // ⚠️ 권리 게이트는 2026-08-31 에 제거됐다(사용자 결정 · rights_issue 0행).
  // 남은 관문은 **렌더 여부**뿐이다 — 파일이 없으면 올릴 게 없다.
  // 아래 불변식(⊘ 조용한 제외 금지 · ⊘ 전체 실패 처리 금지)은 게이트와 무관하게 계속 지킨다.
  it("렌더된 것만 진행하고 나머지는 사유와 함께 반환한다", () => {
    const r = screenForPublish(clips, { channel: "youtube" });
    assert.ok(r.queue.includes("c_ok"));
    assert.ok(!r.queue.includes("c_raw"), "렌더 안 된 클립이 큐에 들어갔다");
  });

  it("⊘ 전체 실패 처리 금지 — 한 건이 막혀도 나머지는 나간다", () => {
    const r = screenForPublish(clips, { channel: "youtube" });
    assert.ok(r.queue.length >= 1, "막힌 건 때문에 전체가 죽으면 안 된다");
  });

  it("⊘ 조용한 제외 금지 — 제외된 건은 전부 사유와 코드를 갖는다", () => {
    const r = screenForPublish(clips, { channel: "youtube" });
    for (const s of r.skipped) {
      assert.ok(s.reason.trim().length > 0, `${s.clipId} 에 사유가 없다`);
      assert.ok(s.code, `${s.clipId} 에 사유 코드가 없다`);
    }
  });

  it("던지지 않는다 — 전부 막혀도 예외가 아니라 빈 queue 다", () => {
    const r = screenForPublish([{ id: "c_raw" }], { channel: "youtube" });
    assert.deepEqual(r.queue, []);
    assert.equal(r.skipped[0]?.code, "not_rendered");
  });
});

describe("관문 우회 불가 (F3 Invariant · FLOWS.md:73)", () => {
  it("screenForPublish 에 우회 인자가 없다 — 관리자도 통과시킬 자리가 없다", () => {
    // 시그니처가 (clips, ctx) 두 개다. role·force·override 를 받을 자리를 만들지 않는다.
    assert.equal(screenForPublish.length, 2);
  });

  it("모듈이 force/override/bypass/admin 류를 export 하지 않는다", () => {
    const src = fs.readFileSync(path.join(SRC, "publish/publish-guard.ts"), "utf-8");
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
    const files = sourceFiles(SRC);
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
      ["publish/publish-dispatch.ts"],
      `배포 큐 진입점이 여러 곳이다: ${hits.join(" · ")}`,
    );
  });

  // ⚠️ 예전엔 "관문이 **게이트를 본다**" 와 "워커가 업로드 직전 다시 본다" 를 요구했다.
  // 권리 게이트는 2026-08-31 에 제거됐다(사용자 결정 · rights_issue 0행 · blocked 1건).
  // 관문이 **순수 판정을 쓴다**는 명제는 그대로 유효하므로 그것만 남긴다.
  it("관문이 순수 판정을 쓴다", () => {
    const src = fs.readFileSync(path.join(SRC, "publish/publish-dispatch.ts"), "utf-8");
    assert.match(src, /screenForPublish/, "publish-dispatch 가 순수 판정을 쓰지 않는다");
  });
});

/**
 * 예약 표시의 정직성 (2026-08-21).
 *
 * 우리는 업로드하며 예약을 건 시점에 'scheduled' 로 적고 **그 뒤 유튜브 상태를 다시 읽지 않는다.**
 * 그래서 예약 시각이 지나도 화면은 계속 "예약됨" 이었고, 채널에 가 보면 예약이 없다(이미 공개됐다).
 * 사용자가 이걸 잡았다 — "하단 예약됨이여서 유튜브 가서 보면 예약이 안 되어 있음".
 *
 * 지난 건을 '게시됨' 으로 바꾸는 것도 **거짓이다** — 유튜브가 실제로 공개했는지 우리는 모른다
 * (예약 실패·삭제·차단도 가능). 그래서 화면은 "아는 것만" 말해야 한다: 미래면 언제인지,
 * 지났으면 확인이 필요하다고. 이 규칙이 지워지지 않게 소스 스캔으로 고정한다.
 */
describe("예약 표시 — 지난 예약을 '예약됨'으로 두지 않는다", () => {
  const WEB = (f: string) => fs.readFileSync(path.resolve(SRC, "../../web/src", f), "utf-8");
  const MATRIX = WEB("components/distribution/distribution-matrix.tsx");
  const PAGE = WEB("app/(app)/distribution/page.tsx");

  it("칸: 지난 예약을 구분하고, 게시됨으로 단정하지 않는다", () => {
    assert.match(MATRIX, /const past = known && at <= Date\.now\(\);/,
      "지난 예약을 구분하지 않으면 채널엔 없는 예약 시각을 계속 표시한다");
    // 2026-08-26 상태 어휘 단순화: 지난 예약의 별도 라벨('게시 확인')은 뺐다 — 실제 공개는
    // youtube.reconcile 이 되읽어 확정하고 그때 게시됨이 된다. 대신 툴팁이 그 사실을 말한다.
    assert.match(MATRIX, /실제 공개 여부를 자동 확인 중/,
      "지난 예약 툴팁이 자동 확인(reconcile)을 설명하지 않으면 '왜 계속 예약이지' 가 된다");
    // '게시됨'으로 단정하지 않는다 — 실제 공개 여부는 reconcile 확정 전엔 모른다.
    assert.doesNotMatch(MATRIX, /past \? "게시됨"/,
      "확인하지 않은 것을 게시됨으로 단정하면 안 된다");
  });

  it("칸: 미래 예약은 **언제인지**를 보여준다", () => {
    assert.match(MATRIX, /`예약 \$\{when\}`/, "시각 없이 '예약됨' 만 쓰면 언제인지 알 수 없다");
  });

  it("요약: 지난 예약을 '예약' 수에 넣지 않는다", () => {
    assert.match(PAGE, /"scheduled_past"/,
      "지난 예약을 그대로 세면 상단 요약이 채널 상태와 어긋난다");
  });

  it("폴링: 지난 예약으로 무한 폴링하지 않는다", () => {
    // 우리 쪽에서 절대 안 바뀌는 행이라, 진행 중으로 세면 화면이 영원히 서버를 두드린다.
    assert.match(PAGE, /return Number\.isFinite\(at\) \? at > Date\.now\(\) : false;/,
      "지난 예약을 진행 중으로 보면 폴링이 멈추지 않는다");
  });
});

/**
 * 예약 시각 오전/오후 함정 (2026-08-21 실측).
 *
 * `<input type="datetime-local">` 은 한국어 로캘에서 오전/오후 선택으로 뜨는데
 * **오전 12시 = 자정(00:00)** 이다. "12시" 를 정오로 생각하고 오전인 채 두면 12시간 어긋난
 * 예약이 조용히 잡힌다 — 실제로 정오로 걸었다는 예약 2건이 00:00·00:05 로 저장돼 자정에
 * 지나갔다. 우리 코드엔 12시간 변환이 없다(입력값을 그대로 보낸다) — 그래서 **화면이
 * 되물어 주는 것** 말고는 막을 방법이 없다. 그 장치를 지우지 않게 고정한다.
 */
describe("예약 시각 — 오전 12시(자정) 착오를 화면이 잡아준다", () => {
  const WEB = (f: string) => fs.readFileSync(path.resolve(SRC, "../../web/src", f), "utf-8");
  const RESERVE = WEB("lib/reserve-date.ts");
  const DIALOG = WEB("components/publish/publish-dialog.tsx");

  it("우리 코드는 12시간 변환을 하지 않는다 — 입력값을 그대로 보낸다", () => {
    // 여기 %12 가 생기면 저장 시각이 실제로 어긋난다. 표시용 변환은 humanReserveVerbose 안에만 있다.
    const fn = RESERVE.match(/export function nowDatetimeLocal[\s\S]*?\n\}/)?.[0] ?? "";
    assert.doesNotMatch(fn, /% ?12/, "입력값 생성에 12시간 변환이 섞이면 저장 시각이 어긋난다");
    assert.match(DIALOG, /\.\.\.\(scheduled && reserveDate \? \{ reserveDate \} : \{\}\)/,
      "모달이 입력 문자열을 가공 없이 보내야 한다(단일 계약)");
  });

  it("표시가 오전/오후와 자정·정오를 말로 못 박는다", () => {
    assert.match(RESERVE, /export function humanReserveVerbose/, "오전/오후 표기 helper 가 없다");
    assert.match(RESERVE, /h === 0 \? " \(자정\)" : h === 12 \? " \(정오\)" : ""/,
      "자정·정오를 말로 안 붙이면 24시간제 숫자를 훑고 지나친다");
    assert.match(DIALOG, /humanReserveVerbose\(reserveDate\)/, "모달이 그 표기를 안 쓴다");
  });

  it("'몇 시간 뒤'를 같이 보여준다 — 12시간 오차가 여기서 드러난다", () => {
    assert.match(RESERVE, /export function untilReserve/, "상대 시각 helper 가 없다");
    assert.match(DIALOG, /untilReserve\(reserveDate\)/, "모달이 상대 시각을 안 보여준다");
  });

  it("새벽 예약이면 되묻는다 (오전/오후 착오의 전형적 결과)", () => {
    assert.match(RESERVE, /export function isLateNightReserve/, "새벽 판정 helper 가 없다");
    assert.match(DIALOG, /isLateNightReserve\(reserveDate\) && \(/, "모달이 새벽 경고를 안 띄운다");
    assert.match(DIALOG, /오전 12시는 자정/, "무엇을 잘못 골랐는지 말해주지 않으면 또 같은 실수를 한다");
  });
});

/**
 * 예약 게시 확인 (youtube.reconcile) — AENA `youtube-reconcile.job.ts` 이식.
 *
 * 예약으로 올린 뒤 상태를 되묻지 않으면 배포 화면이 "예약됨" 에 영구 고정된다. AENA 가 같은
 * 걸 먼저 겪고(2026-07-21) 고친 방식을 그대로 가져왔다. 옮겨온 **설계 이유 4가지**가 지워지면
 * quota 폭증·오판·무한 조회로 돌아가므로 여기서 고정한다.
 */
describe("예약 게시 확인 — AENA 이식 설계가 유지된다", () => {
  const W = fs.readFileSync(path.join(SRC, "worker.ts"), "utf-8");
  const fn = W.match(/async function handleYoutubeReconcile[\s\S]*?\n\}\r?\n/)?.[0] ?? "";

  it("잡이 레인에 등록돼 있다 (레인 밖이면 아무도 안 집는다)", () => {
    assert.ok(fn, "handleYoutubeReconcile 을 못 찾았다");
    assert.match(W, /"automation\.cycle", "youtube\.reconcile"\]/, "youtube 레인에 없다");
    assert.match(W, /case "youtube\.reconcile": return handleYoutubeReconcile\(job\);/, "디스패치에 없다");
  });

  it("① 폴링 창 — 오래된 예약을 영원히 조회하지 않는다", () => {
    assert.match(fn, /YT_RECONCILE_LOOKAHEAD_MS|YT_RECONCILE_LOOKBEHIND_MS/,
      "창 제한이 없으면 지난 예약을 매 주기 계속 조회한다");
  });

  it("② 채널별 그룹핑 + 배치 — 예약 영상은 소유자 토큰이라야 상태가 보인다", () => {
    assert.match(fn, /const byChannel = new Map/, "채널별로 안 나누면 남의 채널 영상 상태를 못 읽는다");
    assert.match(fn, /YT_RECONCILE_BATCH/, "배치 없이 건별 조회하면 quota 가 수 배로 든다");
    assert.match(fn, /part=status&id=/, "videos.list 배치 조회가 아니다");
  });

  it("③ 확정 신호일 때만 전환 — 조회 실패·private 는 손대지 않는다", () => {
    assert.match(fn, /!== "public"\) continue;/,
      "public 이 아닌데 전환하면 확인되지 않은 것을 게시됨으로 단정하게 된다");
  });

  it("④ 배치 단위 로그 — 건별 로그는 quota 초과 시 폭증한다", () => {
    assert.match(fn, /youtube\.reconcile 배치 실패/, "배치 단위 로그가 아니다");
  });

  it("응답에서 빠진 영상(삭제됨)을 순서로 매칭하지 않는다", () => {
    // items 순서는 요청 순서와 다르고 삭제분은 응답에서 빠진다 — 인덱스 매칭이면 엉뚱한 클립을 바꾼다.
    assert.match(fn, /for \(const it of \(data\?\.items \?\? \[\]\) as any\[\]\) if \(it\?\.id\) m\.set\(it\.id/,
      "id 로 매칭하지 않으면 삭제된 영상 때문에 상태가 밀린다");
  });

  it("drain 기동에서 팬아웃된다 (프로덕션은 drain 이다)", () => {
    assert.match(W, /export async function fanOutYoutubeReconcile/, "팬아웃 함수가 없다");
    assert.match(W, /drain 기동 예약 게시 확인 팬아웃/,
      "drain 에서 안 부르면 프로덕션에선 아무도 안 돌린다(순방이 겪은 그 함정)");
  });
});

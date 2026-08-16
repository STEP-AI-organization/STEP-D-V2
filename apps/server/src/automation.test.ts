/**
 * 자동 배포 불변식 고정 (FLOWS F6) — 사용자가 F3 과 함께 "서버 테스트로 막으라"고 지목한 것.
 *
 * 두 문장이 전부다 (FLOWS.md:142):
 *  - 자동 배포는 게이트를 건너뛰지 않는다. 보류된 건은 **사람이 확정해야** 다시 잡힌다.
 *  - 규칙이 없으면 파이프라인은 아무것도 하지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  decidePublish,
  initialRuleState,
  isGatePolicy,
  isRuleCriterion,
  isRuleMediaKind,
  isRuleOrientation,
  isRuleReframe,
  overlapsExistingClip,
  planCycle,
  ruleCreatedNotice,
  selectCandidates,
  type AutomationRule,
  type GateSnapshot,
} from "./automation.ts";
import { channelPublishMode } from "./publish-guard.ts";

describe("이미 내보낸 구간은 다시 채택하지 않는다 (재분석 중복 배포 방지)", () => {
  // 재분석은 추천을 **새 ID** 로 다시 만든다 — "채택됨" 표식이 사라지므로 구간 겹침으로
  // 막지 않으면 같은 쇼츠가 또 채택→배포된다.
  const clip = { startTime: 100, endTime: 160 };

  it("같은 구간(완전 일치·대부분 겹침)은 중복이다", () => {
    assert.equal(overlapsExistingClip({ startTime: 100, endTime: 160 }, [clip]), true);
    assert.equal(overlapsExistingClip({ startTime: 110, endTime: 165 }, [clip]), true);
  });

  it("절반 이하로 스치는 구간·전혀 다른 구간은 통과한다", () => {
    assert.equal(overlapsExistingClip({ startTime: 150, endTime: 260 }, [clip]), false);
    assert.equal(overlapsExistingClip({ startTime: 300, endTime: 360 }, [clip]), false);
  });

  it("수동 채택 클립도 존중한다 — 목록에 섞여 있으면 막힌다", () => {
    assert.equal(
      overlapsExistingClip({ startTime: 100, endTime: 160 }, [{ startTime: 500, endTime: 560 }, clip]),
      true,
    );
  });

  it("시간 정보가 없는 쪽은 판정하지 않는다 (막지도, 터지지도 않는다)", () => {
    assert.equal(overlapsExistingClip({ startTime: null, endTime: null }, [clip]), false);
    assert.equal(overlapsExistingClip({ startTime: 100, endTime: 160 }, [{ startTime: null, endTime: null }]), false);
  });

  it("순방이 이 가드를 실제로 통과시킨다 — 소스 배선 고정", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "automation-cycle.ts"), "utf-8");
    assert.match(src, /overlapsExistingClip\(/,
      "automation-cycle 이 구간 겹침 가드를 부르지 않으면 재분석 시 중복 배포가 재발한다");
  });
});

describe("자동 배포도 채널별 메타데이터를 만든 뒤 나간다", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "automation-cycle.ts"), "utf-8");

  it("채택 직후 clip.metadata 잡을 큐잉한다 — 수동 채택과 같은 배선", () => {
    assert.match(src, /enqueue\("clip\.metadata"/,
      "자동 채택이 메타 생성을 안 걸면 clip.title 폴백으로만 실업로드된다");
  });

  it("채널별 메타 없이는 게시하지 않는다 (생성 대기 후 다음 순방에 게시)", () => {
    assert.match(src, /channelMeta/,
      "게시 전 channelMeta 게이트가 없으면 메타 생성이 끝나기 전에 폴백 제목으로 나간다");
  });
});

const SRC = path.dirname(fileURLToPath(import.meta.url));

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: "r1",
  programId: "p1",
  platform: "youtube",
  accountId: "c1",
  mediaKind: "both",
  criterion: "score80",
  gatePolicy: "hold_on_issue",
  window: "수시",
  enabled: true,
  ...over,
});

const PASS: GateSnapshot = { allowed: true, state: "pass", reason: "" };
const HOLD: GateSnapshot = { allowed: false, state: "rights_hold", reason: "미해결 권리 이슈 2건" };

describe("자동 배포는 게이트를 건너뛰지 않는다 (F6 Invariant)", () => {
  it("게이트 미통과면 어떤 정책에서도 나가지 않는다", () => {
    for (const gatePolicy of ["approve_first", "hold_on_issue"] as const) {
      const d = decidePublish({
        rule: rule({ gatePolicy }),
        gate: HOLD,
        approved: true,          // 사람이 승인해도
        heldAwaitingHuman: false,
      });
      assert.equal(d.action, "hold", gatePolicy);
    }
  });

  it("사람 승인이 게이트를 이기지 못한다", () => {
    // 승인은 게이트 **위에** 얹히는 조건이지 게이트를 대신하지 않는다.
    const d = decidePublish({ rule: rule({ gatePolicy: "approve_first" }), gate: HOLD, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "hold");
    assert.match(d.reason, /권리/);
  });

  it("막힌 결정에는 사유가 있다", () => {
    const d = decidePublish({ rule: rule(), gate: HOLD, approved: false, heldAwaitingHuman: false });
    assert.notEqual(d.reason, "");
  });
});

describe("보류된 건은 사람이 확정해야 다시 잡힌다 (F6 Invariant)", () => {
  it("게이트가 열려도 보류 상태면 그대로 보류다", () => {
    // 이게 핵심이다. 이슈를 해제하면 게이트는 열리지만, 그것만으로 자동이 다시 밀어내면
    // "사람이 확정한다"는 약속이 깨진다.
    const d = decidePublish({ rule: rule(), gate: PASS, approved: true, heldAwaitingHuman: true });
    assert.equal(d.action, "hold");
    assert.equal(d.needsHuman, true);
  });

  it("사람이 확정하면(heldAwaitingHuman=false) 나간다", () => {
    const d = decidePublish({ rule: rule(), gate: PASS, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "publish");
  });
});

describe("재보류 유령 방지 — db-pg 소스 스캔", () => {
  /**
   * holdClip 의 ON CONFLICT DO UPDATE 가 released_at 을 안 되돌리면, 해제 후 재보류된
   * 클립이 (1) openHolds(승인 큐)에 안 보이면서 (2) hasReleasedHold 는 참이라
   * approve_first 를 **재승인 없이** 통과한다 — 사람 눈을 거쳐야 하는 건이 그냥 나간다.
   */
  it("holdClip 재보류는 released_at·released_by 를 NULL 로 되돌린다", () => {
    const src = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    const fn = src.match(/export async function holdClip[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /DO UPDATE/, "holdClip 이 upsert 가 아니다");
    assert.match(fn, /released_at\s*=\s*NULL/, "재보류가 해제 기록을 안 되돌린다 — 재승인 없이 통과하는 유령 보류");
    assert.match(fn, /released_by\s*=\s*NULL/, "released_by 도 함께 리셋해야 감사 기록이 안 헷갈린다");
  });
});

describe("순방 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "automation-cycle.ts"), "utf-8");

  it("채택 직후 렌더를 건다 — 안 걸면 not_rendered 로 매 순방 스킵되어 자동 게시가 0건", () => {
    assert.match(src, /requestAutoRender\(clipId\)/,
      "commitAndInherit 직후 렌더 요청이 없다");
    assert.match(src, /\/api\/clips\/\$\{clipId\}\/export/,
      "렌더는 factory 와 같은 경로(/api/clips/:id/export)여야 한다 — 복제하면 두 벌이 갈라진다");
  });

  it("규칙 channels[] 의 계정을 플랫폼별 필드로 풀어 넘긴다", () => {
    // youtube/naver 만 넘기면 TikTok·IG·FB 는 계정 미지정 배포(record 강등)가 된다.
    assert.match(src, /tiktokOpenId:\s*chan\.accountId/);
    assert.match(src, /igUserId:\s*chan\.accountId/);
    assert.match(src, /metaPageId:\s*chan\.accountId/);
  });

  it("순방이 채널 실업로드 게이트를 미리 본다 — OFF 채널로 큐잉·한도 차감 금지", () => {
    assert.match(src, /youtubeUploadEnabled\(\)/);
    assert.match(src, /naverUploadEnabled\(\)/);
    assert.match(src, /tiktokUploadEnabled\(\)/);
    assert.match(src, /instagramUploadEnabled\(\)/);
    assert.match(src, /facebookUploadEnabled\(\)/);
  });

  it("크레딧 잔액 0 이하면 순방이 정지하고 사유가 공용 상수다", () => {
    assert.match(src, /creditBalance\(\)/, "순방 시작에 잔액 확인이 없다");
    assert.match(src, /CREDIT_IDLE_REASON/,
      "정지 사유는 automation.ts 의 CREDIT_IDLE_REASON — 라우트와 같은 문구여야 한다");
  });
});

describe("채택 형태(방향·AI 리프레임) — 규칙 저장 왕복", () => {
  it("값 체계는 수동 채택 다이얼로그와 동일하다 (orientation·reframe)", () => {
    assert.equal(isRuleOrientation("portrait"), true);
    assert.equal(isRuleOrientation("landscape"), true);
    assert.equal(isRuleOrientation("vertical"), false); // 다른 어휘가 생기면 화면과 갈라진다
    assert.equal(isRuleReframe("ai"), true);
    assert.equal(isRuleReframe("none"), true);
    assert.equal(isRuleReframe("ai_multi"), false); // 잡 모드명(ai_multi)은 규칙 값이 아니다
  });

  it("db-pg 왕복 — SELECT·INSERT·UPDATE(id) 셋 다 orientation·reframe 를 안다", () => {
    // 0032 의 교훈: 컬럼이 upsert 에 없으면 저장이 조용히 유실된다. 세 지점 전부 고정.
    const src = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    const sel = /const RULE_SEL = `([\s\S]*?)`/.exec(src)?.[1] ?? "";
    assert.match(sel, /orientation/, "RULE_SEL 에 orientation 이 없다 — GET /api/automation 미도달");
    assert.match(sel, /reframe/, "RULE_SEL 에 reframe 이 없다");
    const up = src.match(/export async function upsertAutomationRule[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(up, /orientation, reframe/, "INSERT 컬럼에 orientation·reframe 이 없다");
    assert.match(up, /orientation = \$\d+, reframe = \$\d+/, "ON CONFLICT UPDATE 가 채택 형태를 유실한다");
    const byId = src.match(/export async function updateAutomationRuleById[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(byId, /orientation = \$\d+, reframe = \$\d+/, "id 갱신 경로가 채택 형태를 유실한다");
  });

  it("규칙 라우트가 orientation·reframe 를 검증해 받는다 — 틀린 값 침묵 저장 금지", () => {
    const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const route = /app\.post\("\/api\/automation\/rules"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.match(route, /isRuleOrientation\(body\.orientation\)/, "라우트가 orientation 을 안 받는다");
    assert.match(route, /isRuleReframe\(body\.reframe\)/, "라우트가 reframe 을 안 받는다");
    // 수동 다이얼로그는 세로형일 때만 리프레임을 묻는다 — 규칙도 같은 제약이어야
    // "AI 켰는데 영영 안 돈다"가 침묵 속에 저장되지 않는다.
    assert.match(route, /body\.reframe === "ai" && body\.orientation !== "portrait"/,
      "가로+AI 조합을 막는 검증이 없다");
  });
});

describe("채택 형태 순방 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "automation-cycle.ts"), "utf-8");

  it("규칙 방향이 클립 aspectRatio 에 수동 채택과 같은 매핑으로 적용된다", () => {
    assert.match(src, /rule\.orientation === "landscape"/,
      "규칙의 가로 지정이 반영되지 않는다");
    assert.match(src, /landscape \? "16:9" : "9:16-crop-main"/,
      "가로/세로 → aspectRatio 매핑(adopt 라우트와 동일)이 없다");
  });

  it("방향 미지정이면 추천 종류로 정한다 — 클립(롱폼)은 가로형", () => {
    // 클립은 본편 화면비를 유지해야 한다(사용자 확정 2026-08-16). 쇼츠만 세로.
    assert.match(src, /rule\.orientation !== "portrait" && rec\.kind !== "short"/,
      "방향 미지정 클립이 가로로 안 간다 — 롱폼이 세로로 잘려 나간다");
  });

  it("가로면 editorState.aspect 도 뒤집는다 — /export 는 editorState 를 최우선으로 읽는다", () => {
    // autoEditorState 는 쇼츠 전제 aspect 9:16 고정 — 여기서 안 뒤집으면 aspectRatio 에
    // 저장만 되고 렌더에 미도달(이 리포 최빈 실패모드).
    assert.match(src, /\.\.\.\(landscape \? \{ aspect: "16:9" \} : \{\}\)/);
  });

  it("클립도 자동배포 후보가 된다 — core 의 type 을 서버가 kind 로 보존한다", () => {
    // 예전엔 recFromShort 가 전부 kind:"short" 로 못박아, 규칙에서 '클립'을 골라도
    // selectCandidates(kind !== "short")가 항상 0건이었다 — 클립은 나갈 수가 없었다.
    const pipeline = fs.readFileSync(path.join(SRC, "content-pipeline.ts"), "utf-8");
    assert.match(pipeline, /kind: isClip \? "clip" : "short"/,
      "core 의 type(clip/highlight)이 recommendation.kind 로 넘어오지 않는다");
    assert.match(pipeline, /s\.type === "clip" \|\| s\.type === "highlight"/);
  });

  it("세로+AI 면 채택 직후 리프레임을 수동과 같은 라우트로 큐잉한다", () => {
    // 조건식은 store.tsx(수동 채택)와 동일: orientation==="portrait" && reframe==="ai".
    assert.match(src, /rule\.orientation === "portrait" && rule\.reframe === "ai"/,
      "세로+AI 조건이 없다 — 규칙에 저장만 되고 순방이 소비하지 않는다");
    assert.match(src, /\/api\/clips\/\$\{clipId\}\/reframe/,
      "리프레임은 수동과 같은 라우트(/api/clips/:id/reframe)여야 한다 — 큐잉·dedupe 복제 금지");
    assert.match(src, /"ai_multi"/, "mode=ai_multi 페이로드가 없다");
  });

  it("리프레임을 큐잉한 순방엔 렌더를 걸지 않는다 — /export 의 reframe_not_ready 409 가 순서를 강제한다", () => {
    assert.match(src, /wantsAiReframe && await requestAutoReframe\(clipId\)/,
      "리프레임→렌더 순서 분기가 없다 — 플랜 없이 기본 크롭이 먼저 렌더된다");
  });
});

describe("승인 배선 — automation-cycle 소스 스캔", () => {
  /**
   * decidePublish 의 approve_first 는 순수 함수라 옳아도, 호출부가 `approved: !held` 로
   * 배선하면 **보류된 적 없는 새 클립이 전부 자동 승인**되어 정책이 무력화된다.
   * 승인의 근거는 사람이 보류를 해제한 기록(released_at)이어야 한다.
   */
  it("automation-cycle 는 approved 에 released 기반 값을 넘긴다 (!held 금지)", () => {
    const src = fs.readFileSync(path.join(SRC, "automation-cycle.ts"), "utf-8");
    assert.match(src, /hasReleasedHold\(/,
      "automation-cycle 이 보류 해제 기록(hasReleasedHold)을 읽지 않는다");
    assert.doesNotMatch(src, /approved:\s*!\s*held/,
      "`approved: !held` 는 보류된 적 없는 새 클립을 자동 승인한다 — approve_first 무력화");
  });
});

describe("승인 정책", () => {
  it("approve_first 는 승인 없이 안 나간다", () => {
    const d = decidePublish({ rule: rule({ gatePolicy: "approve_first" }), gate: PASS, approved: false, heldAwaitingHuman: false });
    assert.equal(d.action, "hold");
    assert.equal(d.needsHuman, true);
  });

  it("hold_on_issue 는 게이트만 통과하면 나간다", () => {
    const d = decidePublish({ rule: rule({ gatePolicy: "hold_on_issue" }), gate: PASS, approved: false, heldAwaitingHuman: false });
    assert.equal(d.action, "publish");
  });

  it("멈춘 규칙은 아무것도 안 한다", () => {
    const d = decidePublish({ rule: rule({ enabled: false }), gate: PASS, approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "skip");
  });
});

describe("규칙이 없으면 아무것도 하지 않는다 (F6 Invariant)", () => {
  it("빈 규칙 목록을 '전체 대상'으로 해석하지 않는다", () => {
    // 이 실수 한 번이면 손대지 않은 프로그램들이 배포된다.
    const p = planCycle({ paused: false, rules: [] });
    assert.deepEqual(p.rules, []);
    assert.notEqual(p.idleReason, "");
  });

  it("규칙이 전부 꺼져 있어도 아무것도 안 한다", () => {
    const p = planCycle({ paused: false, rules: [rule({ enabled: false })] });
    assert.deepEqual(p.rules, []);
  });

  it("일시정지는 새 회차를 잡지 않는 것이다", () => {
    const p = planCycle({ paused: true, rules: [rule()] });
    assert.deepEqual(p.rules, []);
    assert.match(p.idleReason, /일시정지/);
  });

  it("실행 중 규칙만 평가한다", () => {
    const p = planCycle({ paused: false, rules: [rule({ id: "a" }), rule({ id: "b", enabled: false })] });
    assert.deepEqual(p.rules.map((r) => r.id), ["a"]);
  });
});

describe("채택 기준 (F6 03단계)", () => {
  const cands = [
    { id: "a", kind: "short", score100: 92 },
    { id: "b", kind: "short", score100: 81 },
    { id: "c", kind: "clip", score100: 88 },
    { id: "d", kind: "short", score100: 60 },
    { id: "e", kind: "short" },                              // 점수 없음
    { id: "f", kind: "short", score100: 99, status: "rejected" }, // 사람이 거절함
  ];

  it("점수 하한을 넘는 것만", () => {
    assert.deepEqual(selectCandidates(rule({ criterion: "score85" }), cands).map((c) => c.id), ["a", "c"]);
  });

  it("점수가 없으면 기준을 만족한다고 보지 않는다", () => {
    // 모르면 안 내보낸다.
    assert.equal(selectCandidates(rule({ criterion: "score80" }), cands).some((c) => c.id === "e"), false);
  });

  it("상위 3건에서도 점수 없는 후보는 뺀다", () => {
    // 0점으로 치면 아무거나 상위에 올라온다.
    const got = selectCandidates(rule({ criterion: "top3" }), cands).map((c) => c.id);
    assert.deepEqual(got, ["a", "c", "b"]);
  });

  it("top3 는 회차당 상한이다 — 이미 채택한 수만큼 덜 뽑는다", () => {
    // 채택하면 후보가 pending 풀에서 빠지므로, 이미 채택한 수를 안 빼면 순방마다
    // "새 상위 3건"이 또 뽑혀 상한이 없는 것과 같다(수 시간 내 추천 전량 클립화).
    const r = rule({ criterion: "top3" });
    assert.deepEqual(selectCandidates(r, cands, 2).map((c) => c.id), ["a"]);
    assert.deepEqual(selectCandidates(r, cands, 3), []);
    assert.deepEqual(selectCandidates(r, cands, 99), []);
    // 음수·소수 같은 이상값은 0 취급 — 상한이 늘어나는 방향의 실수를 막는다.
    assert.equal(selectCandidates(r, cands, -5).length, 3);
  });

  it("점수 하한 기준(score80/85)은 채택 수와 무관하다 — 상한은 top3 만의 의미다", () => {
    assert.deepEqual(
      selectCandidates(rule({ criterion: "score85" }), cands, 3).map((c) => c.id),
      ["a", "c"],
    );
  });

  it("사람이 이미 판단한 것은 다시 잡지 않는다", () => {
    // 사람이 거절한 걸 자동이 되살리면 안 된다.
    for (const criterion of ["score80", "score85", "top3"] as const) {
      assert.equal(selectCandidates(rule({ criterion }), cands).some((c) => c.id === "f"), false, criterion);
    }
  });

  it("미디어 종류로 거른다", () => {
    assert.deepEqual(selectCandidates(rule({ mediaKind: "clip", criterion: "score80" }), cands).map((c) => c.id), ["c"]);
    assert.deepEqual(
      selectCandidates(rule({ mediaKind: "short", criterion: "score80" }), cands).map((c) => c.id),
      ["a", "b"],
    );
  });
});

describe("규칙 생성 분기 (F6)", () => {
  // 상태·문구의 기준은 **실제로 우리가 올리는 채널인가** 다(publish-guard 의 channelPublishMode).
  // 예전엔 "youtube 아니면 기록만" 으로 못박아, 실제로는 브라우저 자동화로 올라가는 네이버에
  // "배포 기록만 남습니다" 라고 안내했다 — 안전 문구가 거꾸로 서면 최악이다.
  it("실업로드 채널은 실행 중 — channelPublishMode 와 같은 목록", () => {
    // 게이트가 켜졌을 때 실제로 올라가는 채널 전부. 게이트 온오프는 상태가 아니라
    // 배너(자동화 화면 gates)로 알리는 축이라 여기서는 켠 것으로 놓고 대조한다.
    const gatesOn = { tiktokUpload: true, instagramUpload: true, facebookUpload: true };
    for (const p of ["youtube", "navertv", "naverclip", "instagram", "facebook", "tiktok"] as const) {
      assert.equal(initialRuleState(p), "running", p);
      assert.equal(channelPublishMode(p, gatesOn), "upload", `${p}: 두 목록이 갈라졌다`);
    }
  });

  it("상태만 기록하는 채널(SMR 등)은 생성 문구가 그 사실을 말한다", () => {
    assert.equal(initialRuleState("smr"), "record_only");
    assert.match(ruleCreatedNotice("smr"), /기록만/);
    assert.match(ruleCreatedNotice("smr"), /직접/);
  });

  it("실업로드 채널에는 '기록만' 이라고 말하지 않는다", () => {
    for (const p of ["navertv", "naverclip", "instagram", "tiktok"]) {
      assert.doesNotMatch(ruleCreatedNotice(p), /기록만/, p);
    }
  });
});

describe("입력 검증", () => {
  it("모르는 값을 통과시키지 않는다", () => {
    assert.equal(isRuleMediaKind("both"), true);
    assert.equal(isRuleMediaKind("all"), false);
    assert.equal(isRuleCriterion("score80"), true);
    assert.equal(isRuleCriterion("score70"), false);
    assert.equal(isGatePolicy("approve_first"), true);
    assert.equal(isGatePolicy("skip_gate"), false);
  });

  it("게이트를 끄는 정책값이 존재하지 않는다", () => {
    // 정책 목록에 'skip'/'ignore' 류가 생기면 F6 Invariant 가 무너진다.
    const src = fs.readFileSync(path.join(SRC, "automation.ts"), "utf-8");
    const list = /GATE_POLICIES = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    assert.doesNotMatch(list, /skip|ignore|bypass|off|none/i, `게이트 우회 정책이 생겼다: ${list}`);
  });
});

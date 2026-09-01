/**
 * 자동 배포 불변식 고정 (FLOWS F6) — 사용자가 F3 과 함께 "서버 테스트로 막으라"고 지목한 것.
 *
 * 두 문장이 전부다 (FLOWS.md:142):
 *  - 자동 배포는 게이트를 건너뛰지 않는다. 보류된 건은 **사람이 확정해야** 다시 잡힌다.
 *  - 계획이 없으면 파이프라인은 아무것도 하지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  AUTO_RENDER_STOPPED_NOTE,
  CYCLE_PERIOD_MS,
  RENDER_MAX_ATTEMPTS,
  RENDER_STUCK_MS,
  RULE_IDLE_CODES,
  allowedToday,
  autoRenderFailedNote,
  formatWeekdays,
  findAutomationChannelConflicts,
  isPublishDay,
  kstWeekday,
  monthlyPublishEstimate,
  ruleSlots,
  ruleWeekdays,
  classifyRenderFailure,
  decidePublish,
  episodeAnalysisState,
  initialRuleState,
  isGatePolicy,
  isRuleMediaKind,
  isRuleOrientation,
  isRuleReframe,
  matchesMediaKind,
  nextAutoRenderState,
  overlapsExistingClip,
  planCycle,
  renderFailureAction,
  renderFailureReason,
  ruleCreatedNotice,
  ruleIdleNote,
  selectCandidates,
  episodeAdoptCap,
  shouldRequestAutoRender,
  type AutoRenderState,
  type AutomationRule,
  type GateSnapshot,
  type RuleIdleCode,
  type RuleIdleObservation,
} from "../pipeline/automation.ts";
import { channelPublishMode } from "../publish/publish-guard.ts";

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
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(src, /overlapsExistingClip\(/,
      "automation-cycle 이 구간 겹침 가드를 부르지 않으면 재분석 시 중복 배포가 재발한다");
  });
});

describe("자동 배포도 채널별 메타데이터를 만든 뒤 나간다", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pipeline/automation-cycle.ts"), "utf-8");

  it("채택 직후 clip.metadata 잡을 큐잉한다 — 수동 채택과 같은 배선", () => {
    assert.match(src, /enqueue\("clip\.metadata"/,
      "자동 채택이 메타 생성을 안 걸면 clip.title 폴백으로만 실업로드된다");
  });

  it("채널별 메타 없이는 게시하지 않는다 (생성 대기 후 다음 순방에 게시)", () => {
    assert.match(src, /channelMeta/,
      "게시 전 channelMeta 게이트가 없으면 메타 생성이 끝나기 전에 폴백 제목으로 나간다");
  });
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: "r1",
  programId: "p1",
  platform: "youtube",
  accountId: "c1",
  mediaKind: "both",
  gatePolicy: "hold_on_issue",
  window: "수시",
  enabled: true,
  ...over,
});


/**
 * **한 채널을 여러 자동배포가 함께 쓸 수 있다** (2026-08-28 사용자 확정 "자유롭게 가자").
 *
 * 예전엔 "채널 하나 = 계획 하나" 로 저장을 409 로 막았다. 그런데 A 프로그램을 A 채널로
 * 내보내는 중에 B 프로그램이 추가돼 같은 채널로 보내고 싶은 건 자연스러운 요구인데,
 * 그때마다 **돌고 있는 계획을 지워야** 했다(실사용에서 그 직전까지 갔다).
 *
 * 풀어도 안전한 근거는 **중복 방지가 다른 층에 있기 때문**이다: 같은 영상이 같은 채널로
 * 두 번 나가는 것은 계획이 아니라 **배포 행**이 막는다(hasAccountDistribution).
 * 이 describe 는 그 층이 살아 있는지를 지킨다 — 여기가 뚫리면 제한을 푼 대가가 중복 게시다.
 */
describe("채널 제한을 푼 대신 중복은 배포 행이 막는다", () => {
  it("계획 저장 라우트가 채널 중복을 막지 않는다 — 같은 채널에 계획 여럿 허용", () => {
    const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const route = /app\.post\("\/api\/automation\/rules"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.notEqual(route, "", "계획 저장 라우트를 못 잘랐다");
    assert.doesNotMatch(route, /automation_channel_in_use/,
      "채널 중복 409 가 되살아났다 — 돌던 계획을 지워야만 새 계획을 만들 수 있게 된다");
    assert.doesNotMatch(route, /findAutomationChannelConflicts\(/,
      "충돌 검사가 라우트로 돌아왔다");
    // 갱신 직렬화는 그대로 필요하다 — 같은 계획을 두 창에서 저장하는 틈은 여전히 막는다.
    assert.match(route, /withTenantLock\(`automation-rule-channels:\$\{currentTenantId\(\)\}`/,
      "갱신 직렬화 잠금까지 걷어내면 자연키 upsert 가 갈라진다");
  });

  it("순방은 **배포 행**으로 중복을 막는다 — 계획이 아니라", () => {
    // 채널을 공유하는 계획이 둘이어도, 이미 그 계정으로 나간 클립은 다시 안 나간다.
    const cycle = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(cycle, /hasAccountDistribution\(clip\.distributions, chan\.platform, chan\.accountId\)/,
      "클립 단위 중복 가드가 없으면 채널 공유가 곧 중복 게시가 된다");
    const guard = fs.readFileSync(path.join(SRC, "publish/publish-guard.ts"), "utf-8");
    assert.match(guard, /export function hasAccountDistribution/, "중복 판정 정본이 없다");
  });
});

describe("자동 확인은 테넌트당 한 번만 실행된다", () => {
  it("예약 순방과 지금 확인이 겹쳐도 같은 영상을 두 번 큐잉하지 않는다", () => {
    const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    const entry = src.match(/export async function runAutomationCycle[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(entry, /withTenantLock\(`automation-cycle:\$\{tenantId\}`/,
      "큐 dedupe 만으로는 API 직접 실행과 예약 순방의 동시 실행을 막지 못한다");
    assert.match(src, /async function runAutomationCycleLocked\(/,
      "잠금 안에서 전체 평가가 실행돼야 앞 실행의 배포 행을 뒤 실행이 볼 수 있다");
  });
});

describe("자동 배포는 게이트를 건너뛰지 않는다 (F6 Invariant)", () => {


});

describe("보류된 건은 사람이 확정해야 다시 잡힌다 (F6 Invariant)", () => {

  it("사람이 확정하면(heldAwaitingHuman=false) 나간다", () => {
    const d = decidePublish({ rule: rule(), approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "publish");
  });
});

describe("사유 로그 스팸 방지 — db-pg 소스 스캔", () => {
  const fn = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8")
    .match(/export async function hasRunNote[\s\S]*?\n\}/)?.[0] ?? "";

  it("rule_id 없는 워크스페이스 사유도 dedupe 된다", () => {
    // 크레딧 부족은 특정 계획 탓이 아니라 rule_id 가 NULL 이다. `= $1` 하나로 두면 NULL
    // 비교가 항상 거짓이라 dedupe 가 통째로 무력해져 그 사유가 매 순방 쌓인다.
    assert.match(fn, /ruleId: string \| null/, "hasRunNote 가 rule_id 없는 사유를 못 받는다");
    assert.match(fn, /rule_id IS NULL/,
      "rule_id NULL 갈래가 없다 — 워크스페이스 사유가 15분마다 쌓인다");
  });

  it("rule_id 가 있으면 `= $1` 로 인덱스를 탄다", () => {
    // `IS NOT DISTINCT FROM` 한 줄로 합치면 NULL 은 찾지만 **인덱스를 통째로 잃는다** —
    // btree 에 그 연산자 전략이 없고, rule_run 인덱스(0019 idx_rule_run_rule ·
    // 0032 idx_rule_run_quota)는 둘 다 rule_id 선행이라 남는 진입점이 없어 seq scan 이다.
    // 순방(15분)이 계획×채널×클립 수만큼 부르는 쿼리라 rule_run 이 자라는 만큼 느려진다.
    assert.match(fn, /rule_id = \$1/, "rule_id 있을 때의 인덱스 진입점이 없다");
    assert.doesNotMatch(fn, /rule_id IS NOT DISTINCT FROM/,
      "rule_id 에 IS NOT DISTINCT FROM 을 쓰면 인덱스를 못 탄다 — 두 갈래로 나눌 것");
  });

  it("문구까지 같아야 '이미 남겼다'로 본다", () => {
    // 사유가 여러 가지인 자리에서는 result 만으로는 "다른 사유로 이미 한 줄 남겼다" 와
    // 구분이 안 돼, 새 사유가 침묵한다.
    assert.match(fn, /detail\?: string \| null/, "detail 인자가 없다");
    assert.match(fn, /\$5::text IS NULL OR detail = \$5/, "문구 일치 조건이 없다");
  });
});

describe("하루 배포 개수는 계획 단위 — publishedTodayKst 소스 스캔", () => {
  /**
   * 사용자가 계획마다 적은 개수는 그대로 나가야 한다("A 계획 10개면 10개, B 계획 20개면
   * 20개 · 2026-08-28"). 한 채널을 여러 계획이 함께 쓸 수 있게 된 뒤로 채널 단위 집계는
   * **두 계획이 한 카운터를 나눠 갖는** 상태가 된다 — A(10)와 B(20)가 같은 채널이면 채널이
   * 20에서 멈추고 둘 다 자기 개수를 못 채운다. 사용자가 정한 개수가 안 나가는 것이 이
   * 제품에서 가장 큰 사고라 소스 스캔으로 고정한다.
   */
  const db = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
  const fn = db.match(/export async function publishedTodayKst[\s\S]*?\n\}/)?.[0] ?? "";

  it("ruleId 로 계획 몫만 센다", () => {
    assert.ok(fn.length > 200, "publishedTodayKst 를 못 잘랐다");
    assert.match(fn, /ruleId\?: string \| null/, "계획 인자가 없다 — 채널 총합으로 되돌아갔다");
    assert.match(fn, /r\.rule_id = \$2/, "rule_id 조건이 없다 — 다른 계획 건수가 이 계획 몫을 깎는다");
  });

  it("인자를 안 주면 채널 전체를 센다 — 표시용 질의의 축은 남긴다", () => {
    assert.match(fn, /\$2::text IS NULL OR/,
      "ruleId 생략 시 아무것도 안 세면 기존 호출부가 조용히 0 을 받는다");
  });

  it("한도를 판정하는 세 호출부가 전부 rule.id 를 넘긴다", () => {
    // 하나라도 빠지면 화면 숫자·순방 판정·리포트 목표가 서로 다른 축을 세게 된다.
    const cycle = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(cycle, /publishedTodayKst\(accountKey, rule\.id\)/,
      "순방이 채널 총합으로 한도를 본다 — 계획별 개수가 안 지켜진다");
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    assert.match(index, /publishedTodayKst\(key, rule\.id\)/,
      "화면의 '오늘 N/M' 이 순방과 다른 수를 보여준다");
    const notify = fs.readFileSync(path.join(SRC, "publish/publish-notify.ts"), "utf-8");
    const calls = notify.match(/publishedTodayKst\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 2, "리포트의 publishedTodayKst 호출을 못 찾았다");
    for (const call of calls) {
      assert.match(call, /rule\.id/, `리포트가 계획 몫이 아닌 수를 목표와 비교한다: ${call}`);
    }
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

/**
 * 승인 대기 = **영상 단위**(사용자 확정 2026-08-19: "걍 그 영상 하나하나만 떠야지").
 *
 * 화면의 승인 대기 목록과 자동 배포 기록의 '승인 대기' 줄 수가 안 맞았다. 원인이 하나가 아니라
 * 셋이었고(채널 곱 · 사유 덮어쓰기 · 계획 삭제 후 유령), 여기서 각각을 고정한다. 순수 함수로
 * 증명이 안 되는 배선·SQL 불변식이라 소스 스캔이다.
 */
describe("승인 대기는 영상 하나당 한 줄", () => {
  it("순방은 이미 열린 보류를 다시 쓰지 않는다 — 최초 사유가 보존돼야 한다", () => {
    // 덮어쓰면 두 번째 순방부터 사유가 "보류 상태입니다 — 사람이 확정해야…" 동어반복으로
    // 바뀌어, 승인 대기 화면이 **왜** 멈춰 있는지 말해주지 못한다.
    const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(src, /if \(!held\) await holdClip\(rule\.id, clip\.id, decision\.reason\)/,
      "이미 보류 중인데 holdClip 을 다시 부르면 최초 보류 사유가 덮인다");
  });

  it("계획을 지우면 그 계획의 보류도 지운다 — 아무도 게시 안 할 유령 항목 방지", () => {
    const src = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    const fn = src.match(/export async function deleteAutomationRule[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /DELETE FROM rule_hold WHERE rule_id = \$1/,
      "rule_hold 엔 FK·cascade 가 없다(0019) — 계획만 지우면 보류가 승인 대기에 영원히 남는다");
    // 해제 표시(UPDATE)로 치우면 hasReleasedHold 가 참이 되어 다음 계획이 재승인 없이 통과한다.
    assert.doesNotMatch(fn, /UPDATE rule_hold SET/,
      "계획 삭제를 '사람 승인'으로 기록하면 안 된다 — 다음 계획이 사람 눈을 건너뛴다");
  });

  it("화면은 보류를 클립 단위로 접고, 승인은 그 영상의 보류를 전부 푼다", () => {
    const page = fs.readFileSync(
      path.resolve(SRC, "../../web/src/app/(app)/automation/page.tsx"), "utf-8");
    assert.match(page, /const heldClips = useMemo/,
      "보류를 클립 단위로 접지 않으면 계획 두 개에 걸린 영상이 두 줄로 뜬다");
    assert.match(page, /const heldCount = heldClips\.length/,
      "헤더 건수도 영상 단위여야 한다 — 목록과 숫자가 갈라진다");
    assert.match(page, /entry\.holds\.map\(\(h\) => releaseAutomationHold/,
      "승인이 보류 하나만 풀면 남은 계획이 다음 순방에 다시 잡아 승인이 안 먹은 것처럼 보인다");
  });

  it("미리보기는 렌더 산출물을 재생한다 — 편집기 링크는 '편집' 으로 분리", () => {
    // 편집기는 원본 위에 오버레이를 **다시 그리는** 화면이라 결과물이 아니다. 승인 여부는
    // 나갈 파일을 보고 정해야 한다(사용자 2026-08-19). clip.mediaId = 자막·오버레이가 이미
    // 구워진 렌더 산출물(index.ts /export 가 여기에 clipMediaId 를 넣는다).
    const page = fs.readFileSync(
      path.resolve(SRC, "../../web/src/app/(app)/automation/page.tsx"), "utf-8");
    assert.match(page, /function HeldPreview/, "승인 대기 미리보기 컴포넌트가 없다");
    assert.match(page, /getStreamUrl\(clip\.mediaId\)/,
      "sourceMediaId(원본)를 재생하면 자막·오버레이 없는 원본이 나온다 — 승인 판단이 안 된다");
    assert.match(page, /href=\{`\/editor\/\$\{entry\.clipId\}`\}[\s\S]{0,60}>편집</,
      "편집기 링크가 '편집' 버튼으로 분리돼 있어야 한다");
  });

  it("기록의 '승인 대기' 줄도 영상 단위로 접는다 — 서버는 채널마다 한 줄을 남긴다", () => {
    const page = fs.readFileSync(
      path.resolve(SRC, "../../web/src/app/(app)/automation/page.tsx"), "utf-8");
    assert.match(page, /const visibleRuns = useMemo/, "기록 held 줄을 접는 파생값이 없다");
    assert.match(page, /if \(run\.result !== "held"\) return true/,
      "held 외 결과(게시·실패)까지 접으면 채널별 결과를 못 본다");
    assert.match(page, /const recentProcessRuns = visibleRuns\.filter/,
      "최근 처리 목록이 held 중복을 접은 visibleRuns 에서 파생되지 않는다");
    assert.match(page, /\{recentProcessRuns\.map\(\(run\)/, "기록이 접힌 목록을 안 그린다");
  });
});

describe("순방 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");

  it("채택 직후 렌더를 건다 — 안 걸면 not_rendered 로 매 순방 스킵되어 자동 게시가 0건", () => {
    assert.match(src, /requestAutoRender\(clipId, channel\)/,
      "commitAndInherit 직후 렌더 요청이 없다");
    assert.match(src, /\/api\/clips\/\$\{clipId\}\/export/,
      "렌더는 factory 와 같은 경로(/api/clips/:id/export)여야 한다 — 복제하면 두 벌이 갈라진다");
  });

  it("계획 channels[] 의 계정을 플랫폼별 필드로 풀어 넘긴다", () => {
    // youtube/naver 만 넘기면 TikTok·IG·FB 는 계정 미지정 배포(record 강등)가 된다.
    assert.match(src, /tiktokOpenId:\s*chan\.accountId/);
    assert.match(src, /igUserId:\s*chan\.accountId/);
    assert.match(src, /metaPageId:\s*chan\.accountId/);
  });


  it("크레딧 잔액 0 이하면 순방이 정지하고 사유가 공용 상수다", () => {
    assert.match(src, /creditBalance\(\)/, "순방 시작에 잔액 확인이 없다");
    assert.match(src, /CREDIT_IDLE_REASON/,
      "정지 사유는 automation.ts 의 CREDIT_IDLE_REASON — 라우트와 같은 문구여야 한다");
  });
});

describe("채택 형태(방향·AI 리프레임) — 계획 저장 왕복", () => {
  it("값 체계는 수동 채택 다이얼로그와 동일하다 (orientation·reframe)", () => {
    assert.equal(isRuleOrientation("portrait"), true);
    assert.equal(isRuleOrientation("landscape"), true);
    assert.equal(isRuleOrientation("vertical"), false); // 다른 어휘가 생기면 화면과 갈라진다
    assert.equal(isRuleReframe("ai"), true);
    assert.equal(isRuleReframe("none"), true);
    assert.equal(isRuleReframe("ai_multi"), false); // 잡 모드명(ai_multi)은 계획 값이 아니다
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

  it("계획 라우트가 orientation·reframe 를 검증해 받는다 — 틀린 값 침묵 저장 금지", () => {
    const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const route = /app\.post\("\/api\/automation\/rules"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.match(route, /isRuleOrientation\(body\.orientation\)/, "라우트가 orientation 을 안 받는다");
    assert.match(route, /isRuleReframe\(body\.reframe\)/, "라우트가 reframe 을 안 받는다");
    // 수동 다이얼로그는 세로형일 때만 리프레임을 묻는다 — 계획도 같은 제약이어야
    // "AI 켰는데 영영 안 돈다"가 침묵 속에 저장되지 않는다.
    assert.match(route, /body\.reframe === "ai" && body\.orientation !== "portrait"/,
      "가로+AI 조합을 막는 검증이 없다");
  });
});

describe("채택 형태 순방 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");

  it("계획 방향이 클립 aspectRatio 에 수동 채택과 같은 매핑으로 적용된다", () => {
    assert.match(src, /rule\.orientation === "landscape"/,
      "계획의 가로 지정이 반영되지 않는다");
    // 세로 기본값은 factory.SHORTS_DEFAULT_ASPECT 한 곳에서 온다(2026-09-01). 문자열을
    // 두 곳에 적으면 한쪽만 바뀌어 자동배포와 수동 채택이 다른 화면비로 갈린다.
    assert.match(src, /landscape \? "16:9" : SHORTS_DEFAULT_ASPECT/,
      "가로/세로 → aspectRatio 매핑(adopt 라우트와 동일)이 없다");
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    assert.match(index, /: \(rec\.kind === "short" \? SHORTS_DEFAULT_ASPECT : "16:9"\)/,
      "수동 채택이 같은 상수를 쓰지 않는다");
  });

  it("방향 미지정이면 추천 종류로 정한다 — 클립(롱폼)은 가로형", () => {
    // 클립은 본편 화면비를 유지해야 한다(사용자 확정 2026-08-16). 쇼츠만 세로.
    assert.match(src, /rule\.orientation !== "portrait" && rec\.kind !== "short"/,
      "방향 미지정 클립이 가로로 안 간다 — 롱폼이 세로로 잘려 나간다");
  });

  it("editorState.aspect 를 clip.aspectRatio(5-값 enum)와 일치시킨다 — /export 는 editorState 를 최우선으로 읽는다", () => {
    // autoEditorState 에도 최종 aspectRatio 를 넘기고, editorState 에 다시 명시한다.
    // 둘 중 하나라도 빠지면 제목 px basis 또는 실제 렌더 방향이 달라진다.
    // layout 은 73e9bf9 부터 스프레드({ ...layout, logo: … })로 넘어간다 — 정확한 모양이
    // 아니라 "layout 다음에 aspectRatio 가 같은 호출 안에 온다" 는 배선만 고정한다.
    assert.match(src, /autoEditorState\([\s\S]*?\(rule as any\)\.layout[\s\S]{0,200}?,\s*aspectRatio\)/,
      "자동배포 최종 방향을 factory에 넘기지 않으면 제목 106/107px basis가 어긋난다");
    assert.match(src, /aspect: aspectRatio,/,
      "editorState.aspect 를 clip.aspectRatio 와 일치시키지 않으면 계획 방향이 렌더에 미도달한다");
  });

  it("클립도 자동배포 후보가 된다 — core 의 type 을 서버가 kind 로 보존한다", () => {
    // 예전엔 recFromShort 가 전부 kind:"short" 로 못박아, 계획에서 '클립'을 골라도
    // selectCandidates(kind !== "short")가 항상 0건이었다 — 클립은 나갈 수가 없었다.
    const pipeline = fs.readFileSync(path.join(SRC, "pipeline/content-pipeline.ts"), "utf-8");
    assert.match(pipeline, /kind: isClip \? "clip" : "short"/,
      "core 의 type(clip/highlight)이 recommendation.kind 로 넘어오지 않는다");
    assert.match(pipeline, /s\.type === "clip" \|\| s\.type === "highlight"/);
  });

  it("세로+AI 면 채택 직후 리프레임을 수동과 같은 라우트로 큐잉한다", () => {
    // 조건식은 store.tsx(수동 채택)와 동일: orientation==="portrait" && reframe==="ai".
    assert.match(src, /rule\.orientation === "portrait" && rule\.reframe === "ai"/,
      "세로+AI 조건이 없다 — 계획에 저장만 되고 순방이 소비하지 않는다");
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
    const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(src, /hasReleasedHold\(/,
      "automation-cycle 이 보류 해제 기록(hasReleasedHold)을 읽지 않는다");
    assert.doesNotMatch(src, /approved:\s*!\s*held/,
      "`approved: !held` 는 보류된 적 없는 새 클립을 자동 승인한다 — approve_first 무력화");
  });
});

describe("승인 정책", () => {
  it("approve_first 는 승인 없이 안 나간다", () => {
    const d = decidePublish({ rule: rule({ gatePolicy: "approve_first" }), approved: false, heldAwaitingHuman: false });
    assert.equal(d.action, "hold");
    assert.equal(d.needsHuman, true);
  });


  it("멈춘 계획은 아무것도 안 한다", () => {
    const d = decidePublish({ rule: rule({ enabled: false }), approved: true, heldAwaitingHuman: false });
    assert.equal(d.action, "skip");
  });
});

describe("계획이 없으면 아무것도 하지 않는다 (F6 Invariant)", () => {
  it("빈 계획 목록을 '전체 대상'으로 해석하지 않는다", () => {
    // 이 실수 한 번이면 손대지 않은 프로그램들이 배포된다.
    const p = planCycle({ paused: false, rules: [] });
    assert.deepEqual(p.rules, []);
    assert.notEqual(p.idleReason, "");
  });

  it("계획이 전부 꺼져 있어도 아무것도 안 한다", () => {
    const p = planCycle({ paused: false, rules: [rule({ enabled: false })] });
    assert.deepEqual(p.rules, []);
  });

  it("일시정지는 새 회차를 잡지 않는 것이다", () => {
    const p = planCycle({ paused: true, rules: [rule()] });
    assert.deepEqual(p.rules, []);
    assert.match(p.idleReason, /일시정지/);
  });

  it("실행 중 계획만 평가한다", () => {
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

  it("점수 높은 순으로 뽑고, 점수 없는 후보는 뺀다", () => {
    // 0점으로 치면 아무거나 상위에 올라온다 — 모르면 안 내보낸다(2026-08-26 점수 하한 축 제거).
    assert.deepEqual(selectCandidates(rule({}), cands).map((c) => c.id), ["a", "c", "b"]);
    assert.equal(selectCandidates(rule({}), cands).some((c) => c.id === "e"), false);
  });

  it("점수가 낮아도 뽑는다 — 하한이 회차 전량을 막아 세우던 함정을 없앴다", () => {
    // 쇼츠 score100 은 회차 내 백분위라 42~72 대에 눌린다(실측 20편). 예전 score80 하한이면
    // 이런 회차가 통째로 0건이었다 — 이제는 그냥 상위부터 나간다.
    const low = [
      { id: "x", kind: "short", score100: 72 },
      { id: "y", kind: "short", score100: 55 },
      { id: "z", kind: "short", score100: 60 },
    ];
    assert.deepEqual(selectCandidates(rule({ mediaKind: "short" }), low).map((c) => c.id), ["x", "z", "y"]);
  });

  it("회차당 상한 — 이미 채택한 수만큼 덜 뽑는다", () => {
    // 채택하면 후보가 pending 풀에서 빠지므로, 이미 채택한 수를 안 빼면 순방마다
    // "새 상위 N건"이 또 뽑혀 상한이 없는 것과 같다(수 시간 내 추천 전량 클립화).
    const r = rule({});
    assert.deepEqual(selectCandidates(r, cands, 2).map((c) => c.id), ["a"]);
    assert.deepEqual(selectCandidates(r, cands, 3), []);
    assert.deepEqual(selectCandidates(r, cands, 99), []);
    // 음수·소수 같은 이상값은 0 취급 — 상한이 늘어나는 방향의 실수를 막는다.
    assert.equal(selectCandidates(r, cands, -5).length, 3);
  });

  it("상한은 하루 발행 수를 따라간다 — 하루 6개 계획은 회차 하나에서 6건까지", () => {
    // 3 고정이던 시절엔 하루 6개를 걸어도 회차가 하나뿐인 날엔 3건에서 멈췄다(사용자가 정한
    // 개수가 조용히 안 지켜지는 형태). 하한 3 은 종전 동작 보존용이다.
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, kind: "short", score100: 90 - i }));
    const six = rule({ mediaKind: "short", slots: [{ time: "19:00", count: 3 }, { time: "21:00", count: 3 }] });
    assert.equal(selectCandidates(six, many).length, 6);
    assert.equal(episodeAdoptCap(six), 6);
    // 하루 1~2개짜리 계획은 예전과 같은 3.
    assert.equal(episodeAdoptCap(rule({ slots: null, dailyQuota: 2 })), 3);
    assert.equal(selectCandidates(rule({ mediaKind: "short", slots: null, dailyQuota: 2 }), many).length, 3);
  });

  it("사람이 이미 판단한 것은 다시 잡지 않는다", () => {
    // 사람이 거절한 걸 자동이 되살리면 안 된다.
    assert.equal(selectCandidates(rule({}), cands).some((c) => c.id === "f"), false);
  });

  it("미디어 종류로 거른다", () => {
    assert.deepEqual(selectCandidates(rule({ mediaKind: "clip" }), cands).map((c) => c.id), ["c"]);
    // 하한이 없으니 점수 낮은 d(60) 도 상한 안에서 나간다 — 이게 이번 변경의 요점이다.
    assert.deepEqual(selectCandidates(rule({ mediaKind: "short" }), cands).map((c) => c.id), ["a", "b", "d"]);
  });
});

// ── 순방이 아무것도 안 했을 때: 사유를 남긴다 ───────────────────────────────────

const obs = (over: Partial<RuleIdleObservation> = {}): RuleIdleObservation => ({
  outOfWindow: false, activeStart: 9, activeEnd: 22,
  episodes: 1, analyzed: 1, analyzing: 0, analysisFailed: 0, analysisBlocked: 0,
  pending: 0, kindMatched: 0, overlapped: 0, tooLong: 0, scoreBlocked: 0, scoreMissing: 0, cappedEpisodes: 0,
  clipsAllSent: false, adopted: 0,
  renderStopped: false, gateOff: false, publishFailed: false, heldWaiting: false,
  vagueAccount: false, channelBlocked: false, quotaDone: false,
  renderWaiting: false, metaWaiting: false,
  mediaKind: "both",
  ...over,
});
const codeOf = (o: RuleIdleObservation) => ruleIdleNote(o)?.code ?? null;

describe("순방이 아무것도 안 했으면 이유를 남긴다 (ruleIdleNote 순수 판정)", () => {
  it("일을 했으면 사유가 없다", () => {
    assert.equal(ruleIdleNote(obs({ adopted: 1 })), null);
  });

  it("회차가 없으면 회차 없음", () => {
    assert.equal(codeOf(obs({ episodes: 0 })), "no_episode");
  });

  it("분석이 안 끝났으면 '추천 없음'이 아니라 '분석 중'이다", () => {
    // 이게 이 판정의 핵심이다. 분석 미완 회차뿐인데 후보 0건을 그대로 읽으면
    // "채택할 새 추천이 없습니다" 라는 **틀린 사유**가 나가고, 사용자는 계획을 의심한다.
    const o = obs({ analyzed: 0, analyzing: 2 });
    assert.equal(codeOf(o), "analyzing");
    assert.notEqual(codeOf(o), "no_pending");
  });

  it("분석이 실패했으면 분석 실패라고 말한다", () => {
    assert.equal(codeOf(obs({ analyzed: 0, analysisFailed: 1 })), "analysis_failed");
  });

  it("분석이 **큐잉조차 안 됐으면** '분석 중'이 아니다 — 기다려도 안 끝난다", () => {
    // 크레딧 부족으로 잡을 못 건 회차는 큐에 들어간 적이 없다. 이걸 analyzing 으로 세면
    // "끝나면 다음 확인 때 자동으로 이어집니다" 라고 말하게 되는데, 그 완료는 영원히 안 온다.
    const n = ruleIdleNote(obs({ analyzed: 0, analysisBlocked: 1 }))!;
    assert.equal(n.code, "analysis_blocked");
    assert.match(n.detail, /시작/, "사람이 무엇을 하면 되는지가 없다");
    assert.doesNotMatch(n.detail, /끝나면 다음 확인/, "오지 않을 완료를 약속한다");
    // 충전은 아무 잡도 큐잉하지 않는다 — "충전한 뒤에 시작됩니다" 는 **저절로 시작된다**로
    // 읽혀 사용자가 충전만 하고 기다린다(조용한 정지의 반복).
    assert.doesNotMatch(n.detail, /충전한 뒤에 시작됩니다/,
      "충전하면 저절로 시작되는 것처럼 읽힌다 — 사람이 다시 눌러야 한다");
    assert.match(n.detail, /다시 시작|시작해 주세요/, "사람이 눌러야 한다는 사실이 없다");
  });

  it("활동 시간창 밖이면 그 사실과 시간을 말한다", () => {
    const n = ruleIdleNote(obs({ outOfWindow: true, activeStart: 9, activeEnd: 22 }))!;
    assert.equal(n.code, "off_hours");
    assert.match(n.detail, /9~22시/, "몇 시부터 몇 시인지가 없으면 사용자가 설정을 못 찾는다");
  });

  it("게시 단계에서 멈춘 상태도 사유가 된다 — 눌린 로그를 계획 단위로 이어 준다", () => {
    // 이 사유들은 (클립,채널)당 한 줄로 눌러 두는데, 눌린 뒤에는 그 계획이 왜 멈춰
    // 있는지 아무도 말하지 않는다. 여기가 그 상태를 하루 한 줄로 잇는 자리다.
    assert.equal(codeOf(obs({ renderStopped: true })), "render_stopped");
    assert.equal(codeOf(obs({ gateOff: true })), "gate_off");
    assert.equal(codeOf(obs({ publishFailed: true })), "publish_failed");
    assert.equal(codeOf(obs({ heldWaiting: true })), "held_waiting");
    assert.equal(codeOf(obs({ vagueAccount: true })), "vague_account");
    assert.equal(codeOf(obs({ channelBlocked: true })), "channel_rule");
    assert.equal(codeOf(obs({ quotaDone: true })), "quota_done");
    assert.equal(codeOf(obs({ renderWaiting: true })), "render_waiting");
    assert.equal(codeOf(obs({ metaWaiting: true })), "meta_waiting");
  });

  it("채널 판정 미달은 사용자가 실제로 해결할 수 있는 편집기로 안내한다", () => {
    const detail = ruleIdleNote(obs({ channelBlocked: true }))!.detail;
    assert.match(detail, /편집기/);
    assert.doesNotMatch(detail, /배포 계획|채널 규칙/);
  });

  it("분석 완료 회차가 전부 상한이면 상한 도달", () => {
    assert.equal(codeOf(obs({ analyzed: 2, cappedEpisodes: 2 })), "top3_cap");
  });

  it("한 회차라도 상한이 아니면 상한 탓으로 돌리지 않는다", () => {
    // 과잉 주장(틀린 사유)보다 덜 정확한 기본값이 낫다.
    assert.notEqual(codeOf(obs({ analyzed: 3, cappedEpisodes: 1 })), "top3_cap");
  });

  it("탈락 사유는 '점수 없음' 하나뿐 — 기준을 낮추라는 안내는 없다 (2026-08-26 하한 제거)", () => {
    // 점수 하한 축이 사라져서, 여기 남는 탈락은 **점수가 없는 추천**뿐이다(selectCandidates 가
    // 뺀다). 예전 문구 "기준을 낮추거나 '상위 3건' 으로 바꾸면 잡힙니다" 는 이제 존재하지 않는
    // 설정을 가리키는 안내다 — 사용자가 따라 할 수 있는 조치(재분석)만 말한다.
    const n = ruleIdleNote(obs({ scoreBlocked: 3, scoreMissing: 3 }))!;
    assert.equal(n.code, "score_blocked");
    assert.match(n.detail, /다시 분석/, "재분석해야 풀리는데 안내가 없다");
    assert.doesNotMatch(n.detail, /기준을 낮추/, "없어진 설정을 조치로 안내하면 안 된다");
    assert.doesNotMatch(n.detail, /점수 8[05]/, "점수 하한 문구가 남아 있다");
  });

  it("회차 상한 문구도 없어진 '점수 기준' 을 안내하지 않는다", () => {
    const n = ruleIdleNote(obs({ analyzed: 2, cappedEpisodes: 2 }))!;
    assert.equal(n.code, "top3_cap");
    assert.doesNotMatch(n.detail, /점수 기준/, "없어진 설정을 조치로 안내하면 안 된다");
    assert.match(n.detail, /새 회차|하루 발행 수/, "실제로 가능한 조치를 말해야 한다");
  });

  it("종류가 안 맞으면 그 종류를 말한다 — 화면(자동배포 KIND_LABEL)과 같은 어휘로", () => {
    const n = ruleIdleNote(obs({ pending: 4, kindMatched: 0, mediaKind: "short" }))!;
    assert.equal(n.code, "kind_mismatch");
    // 화면은 "숏폼" 이라고 부른다. 같은 설정을 로그가 "쇼츠" 라고 부르면 사용자는 그 사유가
    // 자기가 고른 설정을 가리키는지조차 모른다.
    assert.match(n.detail, /숏폼/);
    assert.doesNotMatch(n.detail, /쇼츠/);
  });

  it("구간이 전부 겹쳐 제외됐으면 겹침이라고 말한다 (정상 동작임도 함께)", () => {
    const n = ruleIdleNote(obs({ pending: 3, kindMatched: 3, overlapped: 3 }))!;
    assert.equal(n.code, "overlap");
    assert.match(n.detail, /중복/);
  });

  it("만든 클립이 다 나갔으면 그렇게 말한다 — '추천 없음'과 다른 상태다", () => {
    assert.equal(codeOf(obs({ clipsAllSent: true })), "all_sent");
  });

  it("나머지는 추천 없음", () => {
    assert.equal(codeOf(obs()), "no_pending");
  });
});

describe("분석 상태 판정 — '분석 중'과 '큐잉조차 안 됨'은 다른 상태다", () => {
  /**
   * 크레딧 부족으로 분석을 못 건 회차는 **잡이 큐에 들어간 적이 없다.** 이걸 analyzing 으로
   * 세면 순방이 "끝나면 다음 확인 때 자동으로 이어집니다" 라고 말하는데, 그 완료는 영원히
   * 안 온다 — 이 리포 최빈 실패모드(조용한 정지)의 교과서적 형태다.
   */
  it("blockedReason 이 있으면 blocked — 업로드 경로(index.ts)가 남기는 모양", () => {
    assert.equal(episodeAnalysisState({
      stageStatus: "warn", note: "크레딧 부족 — 충전 후 분석을 시작하세요",
      blockedReason: "잔액이 모자랍니다",
    }), "blocked");
  });

  it("유튜브 가져오기 경로(worker.ts)는 idle + 사유 문구뿐이다 — 그것도 잡는다", () => {
    // 이 경로는 blockedReason 을 안 쓰고 note 에만 남긴다. 문구까지 안 보면 정상 대기와
    // 글자 그대로 구분이 안 된다.
    assert.equal(episodeAnalysisState({
      stageStatus: "idle", note: "크레딧 부족 — 충전 후 분석을 시작해 주세요 (잔액 0)",
    }), "blocked");
  });

  it("정상 대기·진행은 analyzing, 완료는 analyzed, 실패는 failed", () => {
    assert.equal(episodeAnalysisState({ stageStatus: "idle", note: "분석 대기" }), "analyzing");
    assert.equal(episodeAnalysisState({ stageStatus: "progress", note: "AI 분석 중…" }), "analyzing");
    assert.equal(episodeAnalysisState({ stageStatus: "done", note: "AI 쇼츠 추천 20건" }), "analyzed");
    assert.equal(episodeAnalysisState({ stageStatus: "warn", note: "일부 경고" }), "analyzed");
    assert.equal(episodeAnalysisState(undefined), "analyzed");
  });

  it("분석이 돌다가 실패한 것(error)은 blocked 가 아니다 — 사람이 할 일이 다르다", () => {
    // content-pipeline 은 error 에도 blockedReason 을 쓴다. 재시작 대상이지 '시작 안 됨'이 아니다.
    assert.equal(episodeAnalysisState({
      stageStatus: "error", blockedReason: "AI 분석 실패 — 자동 재시도가 끝났습니다",
    }), "failed");
  });
});

describe("사유는 하나만 — 우선순위 고정", () => {
  // 순서가 흔들리면 같은 상황에서 로그가 매번 다른 말을 한다. 원칙은
  // "사람이 계획을 바꾸면 풀리는 것 먼저, 시간이 저절로 풀어 주는 것은 뒤".
  const cases: Array<[string, RuleIdleObservation, RuleIdleCode]> = [
    ["활동 시간 밖이 모든 사유를 이긴다 — 평가 자체를 안 했다",
      obs({ outOfWindow: true, episodes: 0, renderStopped: true, gateOff: true }), "off_hours"],
    ["회차 없음이 분석 중을 이긴다", obs({ episodes: 0, analyzed: 0, analyzing: 3 }), "no_episode"],
    ["분석 미완이 후보 사유를 전부 이긴다",
      obs({ analyzed: 0, analyzing: 1, pending: 5, overlapped: 5, clipsAllSent: true }), "analyzing"],
    ["분석 실패가 분석 중을 이긴다", obs({ analyzed: 0, analyzing: 1, analysisFailed: 1 }), "analysis_failed"],
    ["큐잉 안 됨이 분석 실패·분석 중을 이긴다 — 가장 오래 조용한 상태다",
      obs({ analyzed: 0, analyzing: 2, analysisFailed: 1, analysisBlocked: 1 }), "analysis_blocked"],
    ["렌더 확정 실패가 채택 단계 사유를 이긴다 — 만든 게 못 나가는 쪽이 급하다",
      obs({ renderStopped: true, scoreBlocked: 3, clipsAllSent: true }), "render_stopped"],
    ["게이트 OFF 가 할당량 소진을 이긴다 — 켜기 전엔 할당량이 의미가 없다",
      obs({ gateOff: true, quotaDone: true }), "gate_off"],
    ["배포 실패가 승인 대기를 이긴다 — 이미 실패한 건이 급하다",
      obs({ publishFailed: true, heldWaiting: true }), "publish_failed"],
    ["승인 대기가 채널 규칙 미달을 이긴다", obs({ heldWaiting: true, channelBlocked: true }), "held_waiting"],
    ["할당량 소진이 점수 미달을 이긴다", obs({ quotaDone: true, scoreBlocked: 2 }), "quota_done"],
    ["상한 도달이 점수 미달을 이긴다",
      obs({ analyzed: 2, cappedEpisodes: 2, scoreBlocked: 4 }), "top3_cap"],
    ["점수 미달이 종류 불일치를 이긴다",
      obs({ scoreBlocked: 1, pending: 3, kindMatched: 0 }), "score_blocked"],
    ["종류 불일치가 겹침을 이긴다",
      obs({ pending: 3, kindMatched: 0, overlapped: 2 }), "kind_mismatch"],
    ["겹침이 '다 나감'을 이긴다",
      obs({ pending: 2, kindMatched: 2, overlapped: 2, clipsAllSent: true }), "overlap"],
    ["점수 미달(사람 몫)이 렌더 대기(시간 몫)를 이긴다",
      obs({ scoreBlocked: 2, renderWaiting: true }), "score_blocked"],
    ["렌더 대기가 '다 나감'을 이긴다", obs({ renderWaiting: true, clipsAllSent: true }), "render_waiting"],
    ["메타 대기가 '다 나감'을 이긴다", obs({ metaWaiting: true, clipsAllSent: true }), "meta_waiting"],
    ["'다 나감'이 기본값을 이긴다", obs({ clipsAllSent: true }), "all_sent"],
  ];
  for (const [name, o, expected] of cases) {
    it(name, () => assert.equal(codeOf(o), expected));
  }
});

describe("발행 요일 · 발행 시각 슬롯", () => {
  /** KST 기준 시각을 만든다 — 판정이 전부 Asia/Seoul 벽시계라 UTC 로 쓰면 하루가 밀린다. */
  const kst = (iso: string) => new Date(`${iso}+09:00`);

  it("요일 미지정은 매일이다 — 기존 계획이 이 변경으로 멈추면 안 된다", () => {
    assert.equal(ruleWeekdays({ weekdays: null }), null);
    assert.equal(ruleWeekdays({ weekdays: [] }), null);
    for (const d of ["2026-08-17", "2026-08-22", "2026-08-23"]) {
      assert.equal(isPublishDay({ weekdays: null }, kst(`${d}T12:00`)), true, d);
    }
  });

  it("요일은 ISO(월=1)로 읽는다 — 여기가 하루 밀리면 편성이 통째로 어긋난다", () => {
    // 2026-08-17 은 월요일, 08-22 토요일, 08-23 일요일.
    assert.equal(kstWeekday(kst("2026-08-17T12:00")), 1);
    assert.equal(kstWeekday(kst("2026-08-22T12:00")), 6);
    assert.equal(kstWeekday(kst("2026-08-23T12:00")), 7);
    const weekdayOnly = { weekdays: [1, 2, 3, 4, 5] };
    assert.equal(isPublishDay(weekdayOnly, kst("2026-08-17T12:00")), true, "월요일은 발행");
    assert.equal(isPublishDay(weekdayOnly, kst("2026-08-22T12:00")), false, "토요일은 미발행");
  });

  it("KST 경계에서 요일이 갈린다 — UTC 로 읽으면 월요일 아침이 일요일이 된다", () => {
    // UTC 2026-08-16T15:00 = KST 2026-08-17T00:00 (월요일 자정)
    assert.equal(kstWeekday(new Date("2026-08-16T15:00:00Z")), 1);
    assert.equal(kstWeekday(new Date("2026-08-16T14:59:00Z")), 7);
  });

  it("슬롯은 지난 개수만큼만 허용한다 — 정각 편성을 순방 주기 위에서 표현하는 방법", () => {
    const rule = { slots: ["17:00", "20:00", "22:00"], dailyQuota: 99 };
    assert.equal(allowedToday(rule, kst("2026-08-17T09:00")), 0, "첫 슬롯 전에는 0건");
    assert.equal(allowedToday(rule, kst("2026-08-17T17:00")), 1, "정각은 포함");
    assert.equal(allowedToday(rule, kst("2026-08-17T20:30")), 2);
    assert.equal(allowedToday(rule, kst("2026-08-17T23:59")), 3, "슬롯 수를 넘지 않는다");
  });

  it("슬롯이 없으면 예전처럼 하루 할당량이다", () => {
    assert.equal(allowedToday({ slots: null, dailyQuota: 5 }, kst("2026-08-17T09:00")), 5);
    assert.equal(allowedToday({ slots: [], dailyQuota: 0 }, kst("2026-08-17T09:00")), 3, "기본 3");
  });

  it("망가진 슬롯 값은 버린다 — 화면 입력이 그대로 판정에 들어오면 안 된다", () => {
    // 2026-08-25 슬롯당 개수 도입 — 구형 문자열은 count 1 객체로 정규화된다.
    assert.deepEqual(ruleSlots({ slots: ["17:00", "25:00", "7:00", "", "17:00", "09:30"] }),
      [{ time: "09:30", count: 1 }, { time: "17:00", count: 1 }]);
  });

  it("월 예상 건수는 판정과 같은 함수에서 나온다 — 화면 숫자와 실제가 갈라지지 않게", () => {
    // 목업 기준: 월화수목금 · 하루 3건 · 채널 1개 → 주 15건 · 월 65건(52/12 주 환산).
    const e = monthlyPublishEstimate({
      weekdays: [1, 2, 3, 4, 5], slots: ["17:00", "20:00", "22:00"],
      dailyQuota: 3, platform: "youtube", accountId: "UC1", channels: null,
    } as never);
    assert.equal(e.perDay, 3, "슬롯이 있으면 슬롯 수가 하루 발행 수다");
    assert.equal(e.days, 5);
    assert.equal(e.perWeek, 15);
    assert.equal(e.perMonth, Math.round(15 * (52 / 12)));
  });

  it("채널이 늘면 예상 건수도 는다 — 할당량이 채널당이기 때문", () => {
    const e = monthlyPublishEstimate({
      weekdays: [1], slots: [], dailyQuota: 2, platform: "youtube", accountId: "UC1",
      channels: [{ platform: "youtube", accountId: "UC1" }, { platform: "youtube", accountId: "UC2" }],
    } as never);
    assert.equal(e.channels, 2);
    assert.equal(e.perWeek, 4);
  });

  it("요일 문구는 설정만 싣는다 — dedupe 키라 오늘 요일 같은 변동값이 들어가면 안 된다", () => {
    assert.equal(formatWeekdays([1, 2, 3, 4, 5]), "월화수목금");
    assert.equal(formatWeekdays([7, 6]), "토일");
    assert.equal(formatWeekdays(null), "매일");
    assert.equal(formatWeekdays([]), "매일");
  });
});

describe("사유 문구는 dedupe 키다 — 변동값이 섞이면 안 된다", () => {
  /**
   * hasRunNote 가 detail 일치로 하루 한 줄을 막는다. 문구에 카운트가 들어가면 순방(15분)마다
   * 문구가 달라져 새 줄이 쌓이고, 실행 로그 창(최근 50건)이 이 줄로만 덮인다 —
   * 사유를 남기려다 정작 중요한 사유를 가리는 자충수가 된다.
   */
  const SAMPLES: Record<RuleIdleCode, [RuleIdleObservation, RuleIdleObservation]> = {
    // 활동 시간창은 **계획 설정**이라 하루 안에 안 바뀐다 — 문구에 넣어도 dedupe 가 산다.
    off_hours: [obs({ outOfWindow: true }), obs({ outOfWindow: true, episodes: 9, analyzing: 4 })],
    // 발행 요일도 **계획 설정**이라 하루 안에 안 바뀐다 — 문구에 실어도 dedupe 가 산다.
    // (오늘 요일 같은 변동값을 실으면 안 된다 — 그래서 문구는 설정된 요일만 쓴다.)
    off_day: [
      obs({ offDay: true, weekdays: [1, 2, 3, 4, 5] }),
      obs({ offDay: true, weekdays: [1, 2, 3, 4, 5], episodes: 9, analyzing: 4 }),
    ],
    no_episode: [obs({ episodes: 0 }), obs({ episodes: 0, analyzing: 7 })],
    analysis_blocked: [obs({ analyzed: 0, analysisBlocked: 1 }), obs({ analyzed: 0, analysisBlocked: 12 })],
    analysis_failed: [obs({ analyzed: 0, analysisFailed: 1 }), obs({ analyzed: 0, analysisFailed: 9 })],
    analyzing: [obs({ analyzed: 0, analyzing: 1 }), obs({ analyzed: 0, analyzing: 12 })],
    render_stopped: [obs({ renderStopped: true }), obs({ renderStopped: true, episodes: 4, analyzed: 4 })],
    gate_off: [obs({ gateOff: true }), obs({ gateOff: true, episodes: 7, analyzed: 7 })],
    publish_failed: [obs({ publishFailed: true }), obs({ publishFailed: true, episodes: 3, analyzed: 3 })],
    held_waiting: [obs({ heldWaiting: true }), obs({ heldWaiting: true, pending: 5, kindMatched: 5 })],
    vague_account: [obs({ vagueAccount: true }), obs({ vagueAccount: true, episodes: 3, analyzed: 3 })],
    channel_rule: [obs({ channelBlocked: true }), obs({ channelBlocked: true, episodes: 6, analyzed: 6 })],
    quota_done: [obs({ quotaDone: true }), obs({ quotaDone: true, episodes: 2, analyzed: 2 })],
    top3_cap: [obs({ analyzed: 1, cappedEpisodes: 1 }), obs({ analyzed: 6, cappedEpisodes: 6 })],
    score_blocked: [obs({ scoreBlocked: 1 }), obs({ scoreBlocked: 44 })],
    kind_mismatch: [obs({ pending: 1, kindMatched: 0 }), obs({ pending: 31, kindMatched: 0 })],
    overlap: [obs({ pending: 2, kindMatched: 2, overlapped: 2 }), obs({ pending: 9, kindMatched: 9, overlapped: 9 })],
    // 길이 상한 초과는 겹침보다 먼저 말한다 — 겹침은 정상 동작이고 이건 조치가 필요하다.
    too_long: [obs({ pending: 2, kindMatched: 2, tooLong: 2 }), obs({ pending: 9, kindMatched: 9, tooLong: 9 })],
    render_waiting: [obs({ renderWaiting: true }), obs({ renderWaiting: true, episodes: 5, analyzed: 5 })],
    meta_waiting: [obs({ metaWaiting: true }), obs({ metaWaiting: true, episodes: 5, analyzed: 5 })],
    all_sent: [obs({ clipsAllSent: true }), obs({ episodes: 8, analyzed: 8, clipsAllSent: true })],
    no_pending: [obs(), obs({ episodes: 5, analyzed: 5 })],
  };

  for (const code of RULE_IDLE_CODES) {
    it(`${code} — 개수가 달라도 문구는 글자 그대로 같다`, () => {
      const [a, b] = SAMPLES[code];
      const na = ruleIdleNote(a);
      const nb = ruleIdleNote(b);
      assert.equal(na?.code, code);
      assert.equal(nb?.code, code);
      assert.ok(na!.detail.length > 0, "빈 사유는 로그에서 아무 말도 안 한다");
      assert.equal(na!.detail, nb!.detail, "카운트가 문구에 섞였다 — 순방마다 새 줄이 쌓인다");
    });
  }

  it("개발자 말이 사용자 문구로 새지 않는다", () => {
    for (const code of RULE_IDLE_CODES) {
      const detail = ruleIdleNote(SAMPLES[code][0])!.detail;
      assert.doesNotMatch(detail, /not_rendered|eligibility|pending|selectCandidates|null|undefined/,
        `${code}: 개발자 어휘가 화면 문구에 섞였다`);
    }
  });
});

describe("종류 판정은 한 벌이다 (matchesMediaKind)", () => {
  it("selectCandidates 와 순방 관측치가 같은 함수를 쓴다", () => {
    // 두 벌이 되면 한쪽만 고쳐져, 로그가 채택과 다른 말을 한다.
    assert.equal(matchesMediaKind(rule({ mediaKind: "short" }), { id: "x", kind: "short" }), true);
    assert.equal(matchesMediaKind(rule({ mediaKind: "short" }), { id: "x", kind: "clip" }), false);
    assert.equal(matchesMediaKind(rule({ mediaKind: "clip" }), { id: "x", kind: "highlight" }), true);
    assert.equal(matchesMediaKind(rule({ mediaKind: "both" }), { id: "x", kind: "short" }), true);
    const src = fs.readFileSync(path.join(SRC, "pipeline/automation.ts"), "utf-8");
    const fn = src.match(/export function selectCandidates[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /matchesMediaKind\(rule, c\)/, "selectCandidates 가 종류 판정을 따로 갖고 있다");
  });
});

describe("유휴 사유 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
  const RULE_LOOP = src.slice(
    src.indexOf("for (const rule of plan.rules)"), src.indexOf("\n  return report;"));

  it("회차 없음이 조용한 continue 로 돌아가지 않는다", () => {
    assert.ok(RULE_LOOP.length > 1000, "계획 루프를 못 잘랐다 — 스캔 기준이 깨졌다");
    assert.doesNotMatch(src, /eps\.length === 0\)\s*continue/,
      "로그 없는 조용한 continue 가 되살아났다 — 회차가 없다는 사실을 아무도 모른다");
    assert.match(src, /noteRuleIdle\(rule, obs\)/, "유휴 사유를 남기는 호출이 없다");
    assert.match(src, /if \(!logged\) await idle\(\)/, "계획 끝에서 사유를 남기는 배선이 없다");
  });

  it("계획 루프 안에서는 실행 로그를 note() 로만 쓴다", () => {
    // 직접 호출이 하나라도 남으면 logged 플래그가 안 서서 "아무 일도 안 했다" 오진이 난다.
    assert.doesNotMatch(RULE_LOOP, /appendRuleRun\(/,
      "계획 루프 안에 appendRuleRun 직접 호출이 있다 — 전부 note() 를 지나야 한다");
    assert.match(RULE_LOOP, /await note\(\{/, "note() 래퍼가 쓰이지 않는다");
  });

  it("유휴 사유는 하루 한 줄로 막되, **판정은 dedupe 와 무관하게** 돌려준다", () => {
    // 예전엔 dedupe 에 걸리면 return 이 먼저라 배너(idleReason)까지 건너뛰었다 — 그날 첫
    // 순방에만 배너가 차고, 이후 "지금 확인" 은 유휴인데도 초록색 "미디어 0" 만 보여줬다.
    const fn = src.match(/async function noteRuleIdle[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /ruleIdleNote\(/, "판정을 순수 함수에 위임하지 않았다");
    assert.match(fn, /hasRunNote\([\s\S]*?idle\.detail\)/,
      "문구 일치 dedupe 가 없다 — 순방(15분)마다 같은 사유가 쌓여 로그 창을 덮는다");
    // 2026-08-27: 반환이 문구 하나 → {code, detail} 로 늘었다. 코드는 리포트의 "오늘은 더
    // 나올 게 없다" 판정(idleMeansNoMoreToday)이 쓴다 — 문구를 파싱해 추측하지 않게.
    assert.match(fn, /Promise<\{ code: RuleIdleCode; detail: string \} \| null>/,
      "사유를 돌려주지 않으면 배너가 dedupe 를 따라 사라진다");
    assert.match(fn, /return idle;/, "dedupe 여부와 무관하게 사유를 돌려줘야 한다");
    assert.doesNotMatch(fn, /report/,
      "계획 하나의 사유를 순방 전체 리포트에 직접 얹으면 다른 계획이 일한 순방까지 덮는다");
  });

  it("배너는 순방 전체가 아무 일도 안 했을 때만 — 계획 하나가 전체를 덮지 않는다", () => {
    // 계획 A 가 3건 채택·2건 게시했는데 계획 B 가 유휴면, 예전엔 리포트가
    // {adopted:3, published:2, idleReason:"회차가 없습니다"} 였다. 웹은 이 필드를
    // "왜 아무 일도 없었나" 로 렌더한다.
    const tail = src.slice(src.indexOf("if (!logged) await idle()"), src.indexOf("\n  return report;"));
    assert.match(tail, /report\.adopted === 0 && report\.published === 0 && report\.held === 0/,
      "일을 한 순방에도 배너가 뜬다");
    assert.match(tail, /idleReasons\.length === plan\.rules\.length/,
      "계획 하나만 유휴여도 배너가 뜬다 — 전부 유휴일 때만이어야 한다");
  });

  it("크레딧 정지도 로그에 남는다 — 배너는 지나간 시간을 설명하지 못한다", () => {
    const creditAt = src.indexOf("await creditBalance()");
    const credit = src.slice(creditAt, src.indexOf("const report: CycleReport"));
    assert.ok(credit.length > 100 && credit.length < 3000, "크레딧 분기를 못 잘랐다");
    assert.match(credit, /CREDIT_STOP_NOTE/, "정지 사유 상수를 안 쓴다 — 배너와 로그가 갈라진다");
    assert.match(credit, /hasRunNote\(/, "하루 한 줄 가드가 없다");
    assert.match(credit, /appendRuleRun\(/, "로그를 남기지 않는다");
    // 계획이 없는 워크스페이스에 "충전하면 다시 시작합니다" 는 지킬 수 없는 약속이다 —
    // 자동배포를 한 번도 안 쓴 곳에 매일 한 줄씩 쌓였다.
    assert.match(credit, /plan\.rules\.length > 0/,
      "계획이 없어도 크레딧 정지 로그가 쌓인다 — 충전해도 시작될 게 없다");
    assert.ok(src.indexOf("listAutomationRules()") < creditAt,
      "계획 조회가 크레딧 판정보다 뒤면 '계획이 있을 때만' 을 판단할 수 없다");
  });

  it("멈추기 전에 자동 충전을 먼저 시도한다 — 충전되면 알리지 않고 이어간다", () => {
    // 예전엔 충전 트리거가 분석 완료 경로뿐이라, 잔액 0 인 채로 분석이 안 도는 날은
    // 카드가 등록돼 있어도 자동배포가 하루 종일 멈췄다(교착). 그리고 충전으로 살아난
    // 경우에까지 "멈췄습니다" 메일이 가면 안 된다(사용자 2026-08-26).
    const creditAt = src.indexOf("await creditBalance()");
    const credit = src.slice(creditAt, src.indexOf("const report: CycleReport"));
    assert.match(credit, /maybeAutoTopup\(\)/, "멈추기 전에 자동 충전을 시도하지 않는다");
    assert.ok(credit.indexOf("maybeAutoTopup()") < credit.indexOf("CREDIT_STOP_NOTE"),
      "충전 시도가 정지 처리보다 뒤면 살아날 수 있는 날에도 멈춘다");
    assert.match(credit, /charged/, "충전 성공 여부를 안 본다 — 성공해도 멈춘다");
    // 정지 메일은 **하루 한 줄 가드 안**에 있어야 한다 — 밖이면 15분마다 발송된다.
    const guarded = /hasRunNote\([\s\S]*?notifyAutomationCreditStop/.test(credit);
    assert.ok(guarded, "정지 메일이 하루 한 줄 가드 밖이다 — 순방마다 메일이 나간다");
  });

  it("dedupe 로 눌린 줄은 '말했다'가 아니다 — 대신 상태가 유휴 판정에 들어간다", () => {
    // 평생 dedupe(todayKstOnly=false)를 쓰는 문구가 한 번 걸리면, 예전엔 그 계획이
    // **그 뒤로 영원히** 유휴 사유를 안 냈다(logged 를 무조건 세웠으므로).
    const fn = src.match(/async function writeRun[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(fn, /Promise<boolean>/, "실제로 썼는지를 안 돌려준다");
    assert.match(RULE_LOOP, /if \(await writeRun\(ev, dedupe\)\) logged = true;/,
      "append 하지 않은 순방에도 logged 가 서면 유휴 사유가 영원히 안 나간다");
    // 눌린 상태는 관측치로 이어져 계획 단위 하루 한 줄이 된다.
    for (const flag of ["obs.renderStopped = true", "obs.renderWaiting = true",
      "obs.metaWaiting = true", "obs.vagueAccount = true", "obs.gateOff = true",
      "obs.quotaDone = true", "obs.heldWaiting = true", "obs.channelBlocked = true",
      "obs.publishFailed = true"]) {
      assert.ok(RULE_LOOP.includes(flag), `${flag} 이 없다 — 눌린 사유가 어디에도 안 남는다`);
    }
  });

  it("매 순방 마주치는 스킵은 전부 dedupe 를 건다 — 실행 로그 50건을 덮지 않는다", () => {
    // 활동시간 9~22시 · 15분 주기면 무가드 한 줄이 (계획,채널)당 하루 52줄이다.
    const gate = src.slice(src.indexOf("if (!upGate.send)"), src.indexOf("const quota ="));
    assert.match(gate, /hasRunNote\(rule\.id, null, accountKey, "skipped", true, upGate\.offNote\)/,
      "게이트 OFF 사유가 매 순방 쌓인다");
    assert.match(src, /detail: META_WAIT_NOTE[\s\S]{0,120}hasRunNote\([\s\S]{0,80}META_WAIT_NOTE\)/,
      "메타데이터 대기 사유가 매 순방 쌓인다");
    assert.match(src, /result: "held", detail: decision\.reason[\s\S]{0,120}hasRunNote\(/,
      "보류는 사람이 확정할 때까지 유지되는 상태다 — 무가드면 하루 90여 줄이다");
    assert.match(src, /detail: why\.reason[\s\S]{0,120}hasRunNote\([\s\S]{0,80}why\.reason\)/,
      "채널 규칙 미달 사유가 매 순방 쌓인다");
  });

  it("활동 시간창 밖에도 하루 한 줄은 남긴다 — 하루 11~14시간이 통째로 비면 안 된다", () => {
    // 아침에 "밤새 올린 회차가 왜 안 나갔지" 를 볼 때, 순방이 안 돈 건지 워커가 죽은
    // 건지 구분할 근거가 제품 안에 있어야 한다.
    const win = src.slice(src.indexOf("if (!inActiveWindow(rule))"), src.indexOf("const renderTried"));
    assert.match(win, /obs\.outOfWindow = true/, "활동 시간 밖 사유를 관측치에 안 넣는다");
    assert.match(win, /await idle\(\)/, "활동 시간 밖에서 로그가 0줄이다");
  });

  it("분석이 큐잉조차 안 된 회차를 '분석 중'으로 세지 않는다", () => {
    // 크레딧 부족으로 잡을 못 건 회차는 pipeline 에 사유만 남고 큐에는 행이 없다 —
    // "끝나면 이어집니다" 는 영원히 안 지켜진다.
    assert.match(src, /episodeAnalysisState\(ep\.pipeline\)/, "분석 상태 판정을 한 벌로 안 쓴다");
    assert.match(src, /state === "blocked"[\s\S]{0,60}obs\.analysisBlocked/,
      "큐잉 안 된 회차를 따로 세지 않는다");
  });

  it("새 result 값을 만들지 않는다 — 웹이 모르는 값은 원문 그대로 노출된다", () => {
    const results = RULE_LOOP.match(/result: "(\w+)"/g) ?? [];
    for (const r of results) {
      const v = /result: "(\w+)"/.exec(r)![1];
      assert.ok((["published", "recorded", "media_created", "held", "failed", "skipped"] as string[]).includes(v),
        `모르는 실행 로그 종류: ${v}`);
    }
  });
});

describe("계획 생성 분기 (F6)", () => {
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

// ── 렌더 안전벨트 ───────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 7, 18, 3, 0, 0); // 2026-08-18 12:00 KST
const st = (over: Partial<AutoRenderState> = {}): AutoRenderState => ({
  attempts: 1, firstAt: T0, lastAt: T0,
  lastError: "500 render failed", lastStatus: 500, lastCode: null,
  failed: false, ...over,
});
const fail = (
  kind: "permanent" | "waiting" | "retryable",
  error = "500 render failed", status = 500, code: string | null = null,
) => ({ ok: false as const, kind, error, status, code });

describe("렌더 실패는 확정된다 (지킬 수 없는 약속을 멈춘다)", () => {
  it("실패의 성격을 나눈다 — 대기와 영구 실패를 뭉뚱그리지 않는다", () => {
    assert.equal(classifyRenderFailure(404, null), "permanent");   // 클립 없음
    assert.equal(classifyRenderFailure(400, null), "permanent");   // 구간 없음
    assert.equal(classifyRenderFailure(409, "reframe_not_ready"), "waiting");
    // 원본 소실·ffmpeg 없음(409)·렌더 실패(500)·네트워크(0)는 복구될 수 있다.
    assert.equal(classifyRenderFailure(409, "no master video or ffmpeg unavailable to render"), "retryable");
    assert.equal(classifyRenderFailure(500, null), "retryable");
    assert.equal(classifyRenderFailure(0, null), "retryable");
  });

  it("플랜 무효(reframe_plan_invalid)는 대기가 아니다 — 아무도 안 잡으면 영구 침묵이다", () => {
    // 리프레임 강등 벨트의 조건은 `rf.status !== "ready"` 인데, plan_invalid 는
    // **status=ready 인 채 플랜만 무효**라(index.ts /export: 해시 불일치·정규화 실패)
    // 벨트를 그대로 통과한다. waiting 으로 두면 카운터도 시계도 안 움직여서 매 순방 409,
    // autoRender 상태는 생기지도 않고, 로그엔 낙관 문구 한 줄만 평생 남는다.
    assert.equal(classifyRenderFailure(409, "reframe_plan_invalid"), "retryable");
    const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
    assert.match(src, /rf\.status !== "ready"/,
      "리프레임 벨트 조건이 바뀌었다 — plan_invalid 를 누가 잡는지 다시 정해야 한다");
  });

  it("첫 실패로 포기하지 않는다", () => {
    const s = nextAutoRenderState(null, fail("retryable"), T0)!;
    assert.equal(s.attempts, 1);
    assert.equal(s.failed, false);
    assert.equal(s.firstAt, T0);
  });

  it("3회째에 확정한다 — 15분 주기 × 30분 벨트에서 **실제로 닿는** 값", () => {
    let s: AutoRenderState | null = null;
    for (let i = 0; i < RENDER_MAX_ATTEMPTS; i += 1) s = nextAutoRenderState(s, fail("retryable"), T0 + i);
    assert.equal(s!.attempts, RENDER_MAX_ATTEMPTS);
    assert.equal(s!.failed, true);
  });

  it("확정 횟수는 도달 가능해야 한다 — 못 지킬 약속을 문구에 쓰지 않는다", () => {
    // 렌더 재시도는 클립당 순방 한 번(renderTried)이라 간격이 곧 순방 주기다. 예전 값 5 는
    // 5회째가 60분인데 30분 벨트가 3회째에 먼저 확정시켜 **절대 도달하지 않았다** —
    // "렌더가 5회 실패해 멈춥니다" 는 아무도 못 보는 문구였다.
    assert.ok((RENDER_MAX_ATTEMPTS - 1) * CYCLE_PERIOD_MS <= RENDER_STUCK_MS,
      `${RENDER_MAX_ATTEMPTS}회는 ${RENDER_STUCK_MS / 60000}분 벨트가 먼저 확정시켜 못 닿는다`);
  });

  it("횟수가 모자라도 30분째 진행이 없으면 확정한다 (리프레임 벨트와 같은 값)", () => {
    const s = nextAutoRenderState(st({ attempts: 1 }), fail("retryable"), T0 + RENDER_STUCK_MS)!;
    assert.equal(s.attempts, 2);
    assert.equal(s.failed, true);
    assert.equal(s.firstAt, T0, "첫 실패 시각이 재시도마다 밀리면 정체를 영원히 못 잰다");
  });

  it("영구 실패(404·400)는 한 번에 확정한다 — 시간이 못 고치는 것을 기다리지 않는다", () => {
    const s = nextAutoRenderState(null, fail("permanent", "404 clip not found"), T0)!;
    assert.equal(s.attempts, 1);
    assert.equal(s.failed, true);
  });

  it("리프레임 대기는 시도가 아니다 — 카운터도 시계도 안 움직인다", () => {
    // 시간축이 같은 30분이라, 대기를 실패로 세면 리프레임 벨트가 돌기 전에 렌더가 먼저
    // 확정 실패로 굳어 **멀쩡한 클립이 죽는다.**
    const prev = st({ attempts: 3 });
    assert.deepEqual(nextAutoRenderState(prev, fail("waiting"), T0 + RENDER_STUCK_MS * 2), prev);
    assert.equal(nextAutoRenderState(null, fail("waiting"), T0), null);
  });

  it("성공하면 상태를 지운다", () => {
    assert.equal(nextAutoRenderState(st({ attempts: 4 }), { ok: true }, T0), null);
  });

  it("확정 뒤에는 매 순방 다시 때리지 않고, 한 시간에 한 번 다시 본다", () => {
    // 일시 장애가 걷히면 사람 손 없이 되살아나야 한다(2026-08-26 ENA: maxBuffer 초과로
    // 3회 실패 확정 → 옛 동작은 이튿날까지 통째로 대기). 반대로 매 순방 때리면 실패 폭주다.
    const dead = st({ failed: true, lastAt: T0 });
    assert.equal(shouldRequestAutoRender(dead, T0 + 60_000), false);
    assert.equal(shouldRequestAutoRender(dead, T0 + 15 * 60_000), false); // 다음 순방 — 아직
    assert.equal(shouldRequestAutoRender(dead, T0 + 60 * 60_000), true); // 한 시간 뒤
    assert.equal(shouldRequestAutoRender(null, T0), true);
    assert.equal(shouldRequestAutoRender(st(), T0), true);
  });

  it("확정 문구는 사람 말로, 다음 행동까지 말한다", () => {
    const note = autoRenderFailedNote(st({ attempts: 3, failed: true }));
    assert.match(note, /실패했습니다/);
    assert.match(note, /다시 시도/, "자동 재시도가 돈다는 사실이 빠지면 사람이 불필요하게 손을 댄다");
    assert.match(note, /확정\(렌더\)/, "사용자가 무엇을 하면 되는지가 없다 — 편집기 버튼 이름으로 말해야 한다");
    assert.doesNotMatch(AUTO_RENDER_STOPPED_NOTE, /\d/,
      "매 순방 마주치는 문구에 변동값이 들어가면 dedupe 키가 매번 달라진다");
  });

  it("조치는 사유마다 다르다 — 못 지킬 안내를 고정으로 붙이지 않는다", () => {
    // 예전엔 조치가 사유와 무관하게 하나였다("원본 영상이 남아 있는지 확인하고, 편집기에서
    // 내보내기를 다시 하면…"). 그런데 세로형 리프레임 플랜이 무효면 **편집기 내보내기도 같은
    // 라우트라 똑같이 409 로 막힌다** — 안내대로 해도 같은 실패를 다시 본다.
    const plan = autoRenderFailedNote(st({ attempts: 3, failed: true, lastStatus: 409, lastCode: "reframe_plan_invalid" }));
    assert.match(plan, /리프레임/, "리프레임 사유인데 리프레임 조치가 없다");
    assert.doesNotMatch(plan, /원본 영상이 남아 있는지/,
      "리프레임 플랜 무효에 '원본 확인' 을 시킨다 — 원본과 무관한 실패다");
    // 원본 없음(409)은 반대로 원본 확인이 맞는 조치다.
    const master = autoRenderFailedNote(st({ attempts: 3, failed: true, lastStatus: 409, lastCode: null }));
    assert.match(master, /원본 영상/);
    assert.doesNotMatch(master, /리프레임/);
    // 변환 실패(500)는 편집기 재시도가 통한다.
    assert.match(renderFailureAction(500, null), /확정\(렌더\)/);
    // 조치가 실제로 통하는 경로인지 라우트로 확인한다 — 리프레임은 재분석·끄기 둘 다 열려 있다.
    const idx = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const route = idx.slice(idx.indexOf('app.post("/api/clips/:id/reframe"')).slice(0, 4000);
    assert.ok(route.length > 1000, "/reframe 라우트를 못 잘랐다");
    assert.match(route, /body\.mode === "basic"/, "리프레임 끄기 경로가 없다 — 안내가 지킬 수 없는 말이 된다");
    assert.match(route, /body\.retry === true/, "리프레임 재분석 경로가 없다");
  });

  it("확정 실패를 '끝나지 않아' 라고 부르지 않는다 — 렌더 대기와 구분이 안 된다", () => {
    // 바로 옆에 진짜 '렌더 대기'(render_waiting) 사유가 있다. 확정 실패를 진행 중처럼 쓰면
    // 사용자는 기다리면 되는 줄 알고, 실제로는 아무도 다시 시도하지 않는다.
    assert.match(AUTO_RENDER_STOPPED_NOTE, /렌더가 실패해/);
    assert.doesNotMatch(AUTO_RENDER_STOPPED_NOTE, /끝나지 않아/);
    assert.match(ruleIdleNote(obs({ renderStopped: true }))!.detail, /렌더가 실패해/);
    assert.doesNotMatch(ruleIdleNote(obs({ renderStopped: true }))!.detail, /끝나지 않아/);
  });

  it("한 문장에 렌더·영상 변환을 섞지 않는다 — 화면 어휘는 '렌더'·'확정(렌더)' 다", () => {
    const texts = [
      AUTO_RENDER_STOPPED_NOTE,
      ruleIdleNote(obs({ renderStopped: true }))!.detail,
      ruleIdleNote(obs({ renderWaiting: true }))!.detail,
      ...[404, 400, 409, 403, 500, 0].flatMap((s) => [renderFailureReason(s, null), renderFailureAction(s, null)]),
      autoRenderFailedNote(st({ attempts: 3, failed: true })),
    ];
    for (const t of texts) {
      assert.doesNotMatch(t, /영상 변환/, `같은 일을 세 이름으로 부른다: ${t}`);
      // 편집기에는 "내보내기" 라는 버튼이 없다 — 화면 이름은 "확정(렌더)" 다.
      assert.doesNotMatch(t, /내보내기/, `화면에 없는 버튼 이름을 시킨다: ${t}`);
    }
  });

  it("확정 문구에 개발자 어휘가 새지 않는다 — 방송사 운영자가 읽는 줄이다", () => {
    // 예전엔 lastError 를 그대로 붙여서 "(마지막 오류: 409 no master video or ffmpeg
    // unavailable to render)" 가 운영자 화면에 떴다. 원문은 상태에만 남긴다.
    const cases: Array<[number, string | null]> = [
      [409, null], [409, "reframe_plan_invalid"], [404, null], [400, null],
      [500, null], [0, null], [403, null],
    ];
    for (const [status, code] of cases) {
      const note = autoRenderFailedNote(st({
        attempts: 3, failed: true, lastStatus: status, lastCode: code,
        lastError: "409 no master video or ffmpeg unavailable to render",
      }));
      // 화면이 쓰는 고유명 "AI"(AI 리프레임 패널) 만 허용하고 나머지 로마자는 막는다 —
      // 예전 사고는 영어 **원문**이 샌 것이지 로마자 자체가 아니었다. 전부 막으면 화면과
      // 같은 이름을 못 쓰게 되어 "갈 곳은 맞는데 거기 없는 이름" 을 시키게 된다.
      assert.doesNotMatch(note.replace(/AI/g, ""), /[A-Za-z]/, `${status}/${code}: 영어 원문이 문구로 샜다`);
      assert.doesNotMatch(note, /\b[1-5]\d\d\b/, `${status}/${code}: HTTP 상태코드가 문구로 샜다`);
      assert.doesNotMatch(note, /not_rendered|eligibility|null|undefined/,
        `${status}/${code}: 개발자 어휘가 화면 문구에 섞였다`);
    }
  });

  it("사람 말 사유는 상태·코드마다 다르다 — 무엇을 고칠지 갈린다", () => {
    assert.match(renderFailureReason(409, null), /원본 영상/);
    assert.match(renderFailureReason(500, null), /렌더/);
    assert.match(renderFailureReason(0, null), /응답/);
    assert.match(renderFailureReason(404, null), /클립/);
    assert.match(renderFailureReason(409, "reframe_plan_invalid"), /리프레임/);
  });

  it("원문 오류는 상태에 남는다 — 개발자가 볼 곳이 사라지면 안 된다", () => {
    const s = nextAutoRenderState(null,
      fail("retryable", "409 no master video or ffmpeg unavailable to render", 409, null), T0)!;
    assert.match(s.lastError, /no master video/);
    assert.equal(s.lastStatus, 409);
  });
});

/**
 * **하루 발행 수는 화면이 직접 계산하지 않는다** (2026-08-27 사용자 신고).
 *
 * 슬롯(발행 시각)이 있으면 서버는 dailyQuota 를 **아예 무시하고** 슬롯 개수 합을 쓴다
 * (perDayCount). 그런데 화면 세 자리가 각자 다른 식을 갖고 있었다 — "오늘: YouTube 0/3"
 * 배지는 `r.dailyQuota ?? 3` 이라, 15:00×20 계획인데 분모가 늘 3 이었다. 사용자가 정한
 * 개수와 화면이 말하는 개수가 다르면 "안 나가는 건가?" 를 화면으로는 판단할 수 없다.
 */
describe("하루 발행 수는 서버와 같은 함수로만 낸다 (화면 스캔)", () => {
  const page = fs.readFileSync(
    path.resolve(SRC, "../../web/src/app/(app)/automation/page.tsx"), "utf-8");

  it("dailyQuota 를 표시용으로 직접 읽지 않는다 — 슬롯 계획에서 틀린 수가 된다", () => {
    // 폼 상태(setDailyQuota·input value·저장 payload)는 정상이다. 금지하는 건
    // **표시 자리에서 원시 dailyQuota 로 개수를 말하는 것**이다.
    assert.doesNotMatch(page, /\{r\.dailyQuota \?\? 3\}/,
      "배지 분모가 원시 dailyQuota 다 — 슬롯 계획에서 늘 틀린 수가 뜬다(0/3 사고)");
    assert.doesNotMatch(page, /하루 \{dailyQuota\}개/,
      "채널 요약이 슬롯을 무시하고 dailyQuota 를 그대로 쓴다");
  });

  it("슬롯 합을 손으로 더하지 않는다 — perDayCount 한 벌만 쓴다", () => {
    assert.doesNotMatch(page, /slots\.reduce\(\(n, s\) => n \+ s\.count, 0\)/,
      "같은 합을 화면이 한 번 더 적고 있다 — 두 벌이 되면 한쪽만 고쳐진다");
    assert.match(page, /perDayCount\(/, "서버 판정 함수를 안 쓴다");
  });

  it("실업로드 채널 목록도 서버 정본을 쓴다 — 안전 문구 역전 재발 금지", () => {
    // 화면이 `youtube || naver*` 로 좁혀 두고 TikTok·Instagram·Facebook 에는
    // "기록만 — 실제 게시는 담당자가 직접" 이라고 안내했다. 그런데 프로덕션은 그 셋의
    // 업로드 게이트가 전부 켜져 있고 틱톡은 채널에 바로 공개된다 — **안 올라간다고 안내한
    // 채널로 영상이 나갔다**(2026-08-27). automation.ts:449 가 네이버 사례로 경고한 그 형태다.
    assert.match(page, /UPLOAD_PLATFORMS/, "서버의 실업로드 목록을 안 쓴다");
    assert.doesNotMatch(page, /p === "youtube" \|\| p\.startsWith\("naver"\)/,
      "화면이 실업로드 판정 사본을 갖고 있다 — 채널이 늘면 한쪽만 고쳐진다");
    // 그 목록이 실제로 export 되어 공유되는지도 확인한다(사본 금지의 반대편).
    const auto = fs.readFileSync(path.join(SRC, "pipeline/automation.ts"), "utf-8");
    assert.match(auto, /export const UPLOAD_PLATFORMS/,
      "서버가 목록을 export 하지 않으면 화면은 사본을 만들 수밖에 없다");
  });

  it("그 함수는 서버의 순수 모듈에서 온다 — 화면이 자기 사본을 두지 않는다", () => {
    assert.match(page, /from "@server-pure\/pipeline\/automation"/,
      "화면이 자기 계산식을 들면 서버와 다른 수를 말하게 된다");
  });
});

describe("자동배포 화면 책임 — 설정은 한곳에만 둔다", () => {
  const automationPage = fs.readFileSync(
    path.resolve(SRC, "../../web/src/app/(app)/automation/page.tsx"), "utf-8");
  const channelsPage = fs.readFileSync(
    path.resolve(SRC, "../../web/src/app/(app)/publish-channels/page.tsx"), "utf-8");

  it("배포 채널 화면은 연결 관리만 하고 별도 설정 UI를 만들지 않는다", () => {
    // 예외 하나(2026-08-26): **공개범위 드롭다운**은 이 화면에 산다 — 자동배포 기본
    // 공개범위(unlisted)를 채널별로 public 으로 올리는 자리가 제품에 없으면 운영자가
    // 손댈 방법이 없다. fetchChannelRules/saveChannelRule 은 그 저장에만 쓴다.
    // 길이·화면비 같은 **전체 규칙 설정 UI**(다이얼로그·삭제)는 여전히 금지다.
    assert.doesNotMatch(channelsPage, /ChannelRuleDialog|deleteChannelRule/);
    assert.match(channelsPage, /privacy/, "규칙 저장을 쓰면서 공개범위 용도가 아니면 이 예외의 근거가 없다");
  });

  it("자동배포는 별도 채널 설정에 의존하지 않고 실제 연결 계정을 읽는다", () => {
    assert.doesNotMatch(automationPage, /fetchChannelRules|ChannelRule/);
    for (const fetcher of [
      "fetchYouTubeChannels",
      "fetchNaverAccounts",
      "fetchMetaAccounts",
      "fetchInstagramAccounts",
      "fetchTikTokAccounts",
    ]) {
      assert.match(automationPage, new RegExp(`${fetcher}\\(`), `${fetcher} 연결을 자동배포에서 읽지 않는다`);
    }
  });
});

describe("렌더 벨트 배선 — automation-cycle 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
  const NOT_RENDERED = src.slice(
    src.indexOf('why.code === "not_rendered"'), src.indexOf("detail: why.reason"));

  it("렌더 선행 준비는 할당량 루프 **밖**에 있다 — 채택되면 미리 렌더된다", () => {
    // 예전엔 렌더 재요청이 게시 루프 안에만 있어, 오늘 할당량을 다 쓴 계획은
    // `remaining <= 0` 에서 채널을 통째로 continue 하며 렌더 시도까지 건너뛰었다.
    // 그러면 오늘 채택분이 내일까지 미렌더로 남고, 그때 실패하면 "렌더가 안 돼서
    // 못 나갔다" 가 된다 — 사용자가 명시적으로 거부한 실패 모드(2026-08-26).
    const prepAt = src.indexOf("AUTOMATION_MAX_RENDERS_PER_TICK");
    const chanLoopAt = src.indexOf("for (const chan of channels)");
    assert.ok(prepAt > 0, "렌더 선행 준비 패스가 없다");
    assert.ok(prepAt < chanLoopAt,
      "렌더 준비가 채널 루프 안이면 할당량 소진일에 렌더가 통째로 건너뛰어진다");
    const prep = src.slice(src.indexOf("let prepared = 0"), chanLoopAt);
    assert.match(prep, /clip\.rendered !== false/, "이미 렌더된 클립까지 다시 때린다");
    assert.match(prep, /shouldRequestAutoRender/, "확정 실패분 쿨다운을 무시한다 — 실패 폭주");
    assert.match(prep, /renderTried/, "같은 순방에 두 번 렌더를 건다");
  });

  it("확정 실패면 낙관 문구 대신 실패로 넘긴다", () => {
    assert.ok(NOT_RENDERED.length > 200, "not_rendered 분기를 못 잘랐다");
    assert.match(NOT_RENDERED, /autoRender/, "렌더 상태를 안 본다 — 낙관 문구가 무조건 나간다");
    assert.match(NOT_RENDERED, /result: "failed"/, "확정 실패를 사람이 볼 수 있게 남기지 않는다");
    assert.match(NOT_RENDERED, /AUTO_RENDER_STOPPED_NOTE/);
  });

  it("렌더 실패 로그에 채널 키를 붙이지 않는다", () => {
    // 같은 (clip, account) 의 뒤이은 'failed' 행은 publishedTodayKst 의 published 슬롯을
    // 되돌린다 — 하루 할당량 도배 방지가 조용히 뚫린다. 렌더는 채널 무관한 사실이기도 하다.
    assert.match(NOT_RENDERED, /accountKey: null/,
      "렌더 실패에 accountKey 를 붙이면 하루 할당량이 되돌아간다");
  });

  it("낙관 문구도 (클립,채널)당 한 줄로 막는다", () => {
    assert.match(NOT_RENDERED, /hasRunNote\([\s\S]*?RENDER_WAIT_NOTE\)/,
      "렌더 대기 문구가 매 순방·매 채널 쌓인다 — 진짜 사유가 로그 창 밖으로 밀린다");
  });

  it("보류(holdClip)로 처리하지 않는다 — 해제가 게시 승인으로 읽힌다", () => {
    assert.doesNotMatch(NOT_RENDERED, /holdClip/,
      "rule_hold 해제는 approve_first 의 '승인' 근거다 — 렌더 실패를 풀어주는 게 게시 승인이 되면 안 된다");
  });

  it("클립당 export 는 순방 한 번 — 채널 수만큼 때리면 카운터가 배수로 부푼다", () => {
    assert.match(src, /const renderTried = new Set<string>\(\)/);
    assert.match(src, /renderTried\.has\(clip\.id\)/);
    assert.match(src, /shouldRequestAutoRender\(/, "확정 후에도 매 순방 재요청하면 폭주한다");
  });

  it("실패를 boolean 으로 삼키지 않는다 — 사유를 읽어 분류한다", () => {
    assert.match(src, /classifyRenderFailure\(/);
    assert.match(src, /nextAutoRenderState\(/);
    // 상태는 클립 엔티티에 — 실행 로그는 일부러 중복을 안 남기므로 횟수를 셀 수 없다.
    assert.match(src, /merged\.autoRender = next/);
  });
});

describe("렌더 실패 분류 어휘가 라우트와 같다 — index.ts 소스 스캔", () => {
  it("/export 가 실제로 내는 코드·문구를 분류가 알고 있다", () => {
    // 라우트가 코드/문구를 바꾸면 분류가 조용히 어긋나 '대기' 와 '실패' 가 뒤바뀐다.
    const idx = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    const route = idx.slice(idx.indexOf('app.post("/api/clips/:id/export"')).slice(0, 15000);
    assert.ok(route.length > 5000, "/export 라우트를 못 잘랐다");
    assert.match(route, /"reframe_not_ready"/);
    assert.match(route, /"reframe_plan_invalid"/);
    assert.match(route, /no master video/);
    assert.match(route, /render failed/);
  });
});

describe("승인 대기 거부 — 게시로 변하면 안 된다 (0044)", () => {
  const DBPG = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
  const CYCLE = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");
  const IDX = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

  it("rejectHold 는 rejected_at 만 세운다 — released_at 을 건드리면 approve_first 가 뚫려 되레 게시된다", () => {
    const fn = DBPG.slice(DBPG.indexOf("export async function rejectHold")).slice(0, 500);
    assert.ok(fn.length > 100, "rejectHold 를 못 찾았다");
    assert.match(fn, /SET rejected_by = \$3, rejected_at = now\(\)/);
    assert.doesNotMatch(fn, /released_at = now\(\)/, "거부가 released_at 을 세우면 hasReleasedHold 로 게시된다");
  });

  it("승인 큐(openHolds)·대기 판정(isHeldAwaitingHuman)에서 거부는 빠진다", () => {
    const open = DBPG.slice(DBPG.indexOf("export async function openHolds")).slice(0, 500);
    assert.match(open, /rejected_at IS NULL/, "거부한 건이 승인 큐에 남는다");
    const awaiting = DBPG.slice(DBPG.indexOf("export async function isHeldAwaitingHuman")).slice(0, 400);
    assert.match(awaiting, /rejected_at IS NULL/);
  });


  it("거부 라우트가 있고 사람(actor)을 요구한다", () => {
    const route = IDX.slice(IDX.indexOf('app.post("/api/automation/holds/reject"')).slice(0, 900);
    assert.ok(route.length > 100, "거부 라우트가 없다");
    assert.match(route, /rejectHold\(ruleId, clipId, actor\)/);
    assert.match(route, /actor required/, "거부는 사람이 한다 — actor 강제가 없다");
  });
});

describe("입력 검증", () => {
  it("모르는 값을 통과시키지 않는다", () => {
    assert.equal(isRuleMediaKind("both"), true);
    assert.equal(isRuleMediaKind("all"), false);
    assert.equal(isGatePolicy("approve_first"), true);
    assert.equal(isGatePolicy("skip_gate"), false);
  });

  it("점수 하한 축이 코드에서 사라졌다 — 채택은 항상 상위 순 (2026-08-26)", () => {
    // 2026-08-17 실측: 쇼츠 score100 이 42.1~72.6 이라 score80 계획은 한 건도 안 내보냈다.
    // "계획은 켜져 있는데 아무것도 안 나간다" 가 이 리포 최빈 실패모드라 축 자체를 없앴다.
    // 되살아나면(선택지·분기) 같은 사고가 다시 난다 — 소스로 잠근다.
    const auto = fs.readFileSync(path.join(SRC, "pipeline/automation.ts"), "utf-8");
    assert.doesNotMatch(auto, /criterion === "score85"/, "점수 하한 분기가 되살아났다");
    assert.match(auto, /RULE_CRITERIA = \["top3"\]/, "채택 기준은 하나여야 한다");
    const route = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    assert.doesNotMatch(route, /invalid criterion/,
      "레거시 값(score80)이 400 이 되면 저장된 계획을 편집만 해도 못 저장한다");
  });

});

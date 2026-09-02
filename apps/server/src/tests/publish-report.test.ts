/**
 * 자동배포 리포트(묶음 메일) — 목표 판정과 템플릿 렌더 (2026-08-26 영상별 → 하루 묶음 전환).
 *
 * 핵심 불변식:
 *  - "오늘 몫 완료" 판정은 순방과 같은 어휘(슬롯 합·staleMissed·dailyQuota)를 쓴다 —
 *    다른 식을 쓰면 리포트가 너무 일찍(몫 남았는데) 또는 영영(포기한 몫을 기다리며) 안 나간다.
 *  - 마감(마지막 슬롯+90분 · 활동창 끝)이 지나면 목표 미달이어도 보낸다 — 확정 실패 하나가
 *    리포트를 영원히 잠그면 안 된다.
 *  - HTML 은 사용자 확정 템플릿(final-normal.html)의 구조를 유지한다: 통계 3칸 + 항목 리스트
 *    + 다음 배포 박스. 제목·URL 은 이스케이프되어 그대로 담긴다.
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import pathMod from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildAutoPublishReportHtml, ruleDayTarget, type AutoReportItem,
} from "../publish/publish-notify.ts";

const kst = (v: string) => new Date(`${v}+09:00`);
const SRC_DIR = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), "..");

describe("ruleDayTarget — 오늘 몫과 마감", () => {
  const slotted = { slots: [{ time: "09:00", count: 3 }], dailyQuota: 3, activeEnd: 22 } as never;

  it("슬롯 계획: 슬롯 전이면 목표 그대로·마감 전", () => {
    const r = ruleDayTarget(slotted, 0, kst("2026-08-26T08:00"));
    assert.equal(r.target, 3);
    assert.equal(r.deadlinePassed, false);
  });

  it("슬롯 계획: 다 나갔으면 published 가 목표에 닿는다", () => {
    const r = ruleDayTarget(slotted, 3, kst("2026-08-26T10:00"));
    assert.ok(3 >= r.target, "3건 나갔는데 목표가 더 크면 리포트가 영영 안 나간다");
  });

  it("슬롯 계획: 늦게 켜서 포기한 몫은 목표에서 빠진다 (staleMissed 와 같은 어휘)", () => {
    const r = ruleDayTarget(slotted, 0, kst("2026-08-26T20:10"));
    assert.equal(r.target, 0, "저녁에 켠 계획의 아침 몫을 기다리면 리포트가 안 나간다");
    assert.equal(r.deadlinePassed, true, "마지막 슬롯 +90분이 지났다");
  });

  it("소재 고갈 즉시 발송의 전제 — 마지막 슬롯 경과 여부를 따로 알려준다 (2026-08-27)", () => {
    // 목표(20)에 못 닿아도 **마지막 슬롯이 지났고** 더 뽑을 후보가 없으면 마감(+90분)을
    // 기다릴 이유가 없다. 슬롯이 여럿이면 마지막 슬롯 전에는 절대 참이면 안 된다 —
    // 뒤 슬롯 몫이 리포트에서 빠진다.
    const twoSlots = { slots: [{ time: "09:00", count: 3 }, { time: "15:00", count: 20 }], dailyQuota: 3, activeEnd: 22 } as never;
    assert.equal(ruleDayTarget(twoSlots, 3, kst("2026-08-27T09:30")).lastSlotPassed, false,
      "앞 슬롯만 지났는데 마지막이라고 하면 오후 몫이 리포트에서 빠진다");
    assert.equal(ruleDayTarget(twoSlots, 3, kst("2026-08-27T15:02")).lastSlotPassed, true);
    // 마감은 여전히 +90분 — 안전장치는 그대로다.
    assert.equal(ruleDayTarget(twoSlots, 3, kst("2026-08-27T15:02")).deadlinePassed, false);
    assert.equal(ruleDayTarget(twoSlots, 3, kst("2026-08-27T16:31")).deadlinePassed, true);
  });

  it("할당량 계획: 목표 = dailyQuota · 마감 = activeEnd", () => {
    const q = { slots: null, dailyQuota: 2, activeEnd: 22 } as never;
    assert.equal(ruleDayTarget(q, 0, kst("2026-08-26T12:00")).target, 2);
    assert.equal(ruleDayTarget(q, 0, kst("2026-08-26T12:00")).deadlinePassed, false);
    assert.equal(ruleDayTarget(q, 0, kst("2026-08-26T23:00")).deadlinePassed, true,
      "활동창이 끝나면 미달이어도 마감 — 확정 실패가 리포트를 영원히 잠그면 안 된다");
  });
});

describe("buildAutoPublishReportHtml — 템플릿 렌더", () => {
  const items: AutoReportItem[] = [
    {
      date: "2026-08-26", title: "\"불가사리를 먹습니까?\" <충격> 아침", program: "눈떠보니 OOO",
      channelLabel: "AENA_TEST", videoId: "abc123", url: "https://youtu.be/abc123",
      durationSec: 113, publishedAtMs: Date.parse("2026-08-26T09:00:00+09:00"), publishAt: null,
    },
    {
      date: "2026-08-26", title: "예약된 영상", program: "눈떠보니 OOO",
      channelLabel: "AENA_TEST", videoId: "def456", url: "https://youtu.be/def456",
      durationSec: 97, publishedAtMs: Date.parse("2026-08-26T09:01:00+09:00"),
      publishAt: "2026-08-26T19:00:00.000Z",
    },
  ];
  const html = buildAutoPublishReportHtml(items, kst("2026-08-26T09:30"), { label: "2026. 08. 27 (목) 09:00 · 3건 예정" });

  it("항목 제목이 이스케이프되어 담긴다 — HTML 주입 방지", () => {
    assert.match(html, /&quot;불가사리를 먹습니까\?&quot; &lt;충격&gt; 아침/);
    assert.doesNotMatch(html, /<충격>/);
  });

  it("통계 3칸 — 템플릿 그대로 배포·게시·확인 필요 (사용자: '보낸 html 똑같이')", () => {
    assert.match(html, />배포<\/div>[\s\S]*?>2<\/div>/);
    assert.match(html, />게시<\/div>[\s\S]*?>1<\/div>/);
    assert.match(html, />확인 필요<\/div>[\s\S]*?>0<\/div>/);
  });

  it("영상 열기 버튼이 항목별 실제 URL 을 단다 — 채널 홈이 아니라 그 영상으로", () => {
    assert.match(html, /href="https:\/\/youtu\.be\/abc123"/);
    assert.match(html, /href="https:\/\/youtu\.be\/def456"/);
  });

  it("예약 항목은 '예약' 점과 공개 예정 시각으로 표기된다", () => {
    assert.match(html, /공개 예정/);
  });

  it("다음 배포 박스와 길이(M:SS) 표기", () => {
    assert.match(html, /다음 배포/);
    assert.match(html, /2026\. 08\. 27 \(목\) 09:00 · 3건 예정/);
    assert.match(html, /1:53/);
  });

  it("다음 배포가 없으면 박스를 그리지 않는다", () => {
    const noNext = buildAutoPublishReportHtml(items, kst("2026-08-26T09:30"), null);
    assert.doesNotMatch(noNext, /다음 배포/);
  });

  it("생 채널 ID(UC…)는 사람이 읽는 자리에 안 나온다", () => {
    // channelLabel 은 이름이 없으면 accountId 로 폴백한다 — 그 꼴이 제목줄·항목 메타에
    // 그대로 노출됐다(2026-08-26 ENA 메일). 렌더가 마지막 방어선이다.
    const raw = buildAutoPublishReportHtml(
      items.map((i) => ({ ...i, channelLabel: "UCd39hfW7B7U1IdJxFg9GnCQ" })),
      kst("2026-08-26T09:30"), null);
    assert.doesNotMatch(raw, /UCd39hfW7B7U1IdJxFg9GnCQ/);
  });
});

describe("리포트는 실패를 숨기지 않는다 (2026-08-26)", () => {
  // 예전엔 성공만 적립돼, 20건 중 3건이 실패한 날에도 "확인 필요 0" 이 나갔다.
  // 실패는 자동 재시도가 없는 상태(F4-4)라 이 숫자가 곧 사람이 할 일의 개수다.
  const ok: AutoReportItem = {
    date: "2026-08-26", title: "정상 게시분", program: "눈떠보니 OOO",
    channelLabel: "AENA_TEST", videoId: "ok1", url: "https://youtu.be/ok1",
    durationSec: 60, publishedAtMs: Date.parse("2026-08-26T15:00:00+09:00"), publishAt: null,
  };
  const bad: AutoReportItem = {
    date: "2026-08-26", title: "실패한 영상", program: "눈떠보니 OOO",
    channelLabel: "AENA_TEST", videoId: "", url: "",
    durationSec: 45, publishedAtMs: Date.parse("2026-08-26T15:02:00+09:00"), publishAt: null,
    failed: true, error: "할당량이 초과되었습니다", clipId: "c_bad", accountKey: "youtube:UC1",
  };
  const html = buildAutoPublishReportHtml([ok, bad], kst("2026-08-26T16:30"), null);

  it("통계가 실패를 '확인 필요' 로 세고 '게시' 에서 뺀다", () => {
    assert.match(html, />배포<\/div>[\s\S]*?>2<\/div>/);
    assert.match(html, />게시<\/div>[\s\S]*?>1<\/div>/);
    assert.match(html, />확인 필요<\/div>[\s\S]*?>1<\/div>/);
  });

  it("실패 사유와 다음 행동이 실린다 — 자동 재시도가 없다는 사실까지", () => {
    assert.match(html, /할당량이 초과되었습니다/);
    assert.match(html, /자동으로 다시 보내지 않습니다/);
    assert.match(html, /배포 화면에서 재시도/);
  });

  it("실패 항목엔 '영상 열기' 버튼이 없다 — 열 영상이 없다", () => {
    // 성공분 1건의 버튼만 있어야 한다.
    assert.equal([...html.matchAll(/영상 열기/g)].length, 1);
    assert.doesNotMatch(html, /href=""/);
  });

  it("실패가 있으면 프리헤더가 그 사실부터 말한다 — 열기 전에 보인다", () => {
    assert.match(html, /1건 확인 필요/);
    assert.doesNotMatch(html, /전부 게시 완료/);
    // 실패 없는 날은 종전 문구 그대로.
    assert.match(buildAutoPublishReportHtml([ok], kst("2026-08-26T16:30"), null), /전부 게시 완료/);
  });
});

/**
 * **마감 후 하루 한 통** (정책 2026-09-02 · 사용자 "메일이 2개로 나눠져서 온다").
 *
 * 예전(2026-08-27)엔 몫이 다 나가거나 소재가 고갈되면 마지막 슬롯 직후 바로 보냈다. 그러면
 * 리포트가 나간 **뒤에** 확정되는 사실(재시도 성공 · 슬롯 직전 예약 업로드)이 갈 곳이 없어
 * 두 번째 통이 됐다. 조기 발송과 하루 한 통은 동시에 가질 수 없어 후자를 골랐다.
 *
 * ⚠️ 이 블록이 깨지면 **정책이 되돌아간 것**이다. 숫자를 고치지 말고 어느 쪽이 정본인지
 *    먼저 정할 것 — 되돌리려면 publish-notify 의 ruleReportDue 한 함수만 보면 된다.
 */
describe("리포트는 마감 후에 한 통으로 나간다", () => {
  const read = (f: string) => fsSync.readFileSync(pathMod.join(SRC_DIR, f), "utf-8");

  it("발송 판정이 마감만 본다 — '몫이 다 나갔으면 즉시' 분기가 없다", () => {
    const src = read("publish/publish-notify.ts");
    assert.match(src, /function ruleReportDue\(rule: AutomationRule, now: Date\): boolean/,
      "마감 판정 함수가 없다");
    assert.match(src, /return ruleDayTarget\(rule, 0, now\)\.deadlinePassed;/,
      "마감 외의 조건으로 보내면 늦게 확정되는 건이 두 번째 통으로 갈라진다");
    assert.doesNotMatch(src, /published >= target \|\| deadlinePassed/,
      "'몫이 다 나갔으면 즉시 발송' 분기가 살아 있다 — 정책이 되돌아갔다");
    assert.doesNotMatch(src, /exhausted && lastSlotPassed/,
      "소재 고갈 조기 발송이 살아 있다 — 이것이 갈라짐의 원인이었다");
  });

  it("순방이 exhausted 를 더 넘기지 않는다 — 넘길 곳이 없어졌다", () => {
    const src = read("pipeline/automation-cycle.ts");
    assert.match(src, /await maybeFlushAutoPublishReport\(\);/,
      "리포트 호출이 인자를 넘기고 있다 — 조기 발송 배선이 남았다는 뜻");
    assert.doesNotMatch(src, /idleMeansNoMoreToday/,
      "쓰지 않는 판정을 계속 계산하면 다음 사람이 그게 동작한다고 믿는다");
  });

  it("마감 판정은 게시 수를 세지 않는다 — 발송 경로에서 DB 조회가 빠진다", () => {
    // ruleDayTarget 의 deadlinePassed 는 시각만 본다. published 를 0 으로 줘도 같아야 한다.
    const rule = { slots: [{ time: "09:00", count: 1 }, { time: "18:00", count: 2 }] } as never;
    const at = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00+09:00`);
    for (const p of [0, 3, 99]) {
      assert.equal(ruleDayTarget(rule, p, at("19:00")).deadlinePassed, false, "18:00+90분 전");
      assert.equal(ruleDayTarget(rule, p, at("19:31")).deadlinePassed, true, "18:00+90분 후");
    }
  });

  it("기다림형 코드 집합은 셋 그대로 — 어휘는 남겨 뒀다(배선만 걷어냈다)", () => {
    const src = read("pipeline/automation.ts");
    const m = /WAITING_IDLE_CODES[^=]*=\s*new Set<RuleIdleCode>\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(m, "WAITING_IDLE_CODES 를 못 찾았다");
    const codes = [...m![1].matchAll(/"([\w_]+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual(codes, ["analyzing", "meta_waiting", "render_waiting"]);
  });
});

/**
 * 소재 부족 안내 + 업로드·충전 유도 (2026-08-27) — "20건 예정인데 16건" 인 날, 리포트가
 * 그 사실과 조치를 말한다. 목표에 닿은 날엔 섹션 자체가 없어야 한다(없는 문제를 만들지 않는다).
 */
describe("영상이 모자란 날의 안내", () => {
  const ok: AutoReportItem = {
    date: "2026-08-27", title: "정상 게시분", program: "눈떠보니 OOO",
    channelLabel: "AENA_TEST", videoId: "ok1", url: "https://youtu.be/ok1",
    durationSec: 60, publishedAtMs: Date.parse("2026-08-27T15:01:00+09:00"), publishAt: null,
  };
  const short = { target: 20, published: 16 };
  const html = buildAutoPublishReportHtml([ok], kst("2026-08-27T15:32"), null, short);

  it("몇 건 예정 중 몇 건 나갔고 몇 건이 비었는지 말한다", () => {
    assert.match(html, /영상이 모자랍니다/);
    assert.match(html, /오늘 20건 예정 중 16건 게시 · 4건은 만들 영상이 없었습니다/);
  });

  it("조치는 대사로만 — 잔액 숫자는 넣지 않는다 (사용자 2026-08-27)", () => {
    assert.match(html, /회차 영상을 올려 주시면/);
    assert.match(html, /크레딧이 넉넉해야 분석이 끊기지 않습니다/);
    // 담당자 메일에 잔액을 노출하지 않는다 — 유도는 버튼이 한다.
    assert.doesNotMatch(html, /남은 크레딧|1,292|\d+개\(분석/);
  });

  it("버튼은 넣지 않는다 — 안내는 문구로만 (사용자 2026-08-27)", () => {
    assert.doesNotMatch(html, /영상 올리기|크레딧 충전/);
    // 항목의 '영상 열기' 버튼은 그대로다 — 이 절은 소재 부족 안내에만 해당한다.
    assert.match(html, /영상 열기/);
  });

  it("목표를 채운 날엔 섹션이 아예 없다", () => {
    const full = buildAutoPublishReportHtml([ok], kst("2026-08-27T15:32"), null,
      { target: 20, published: 20 });
    assert.doesNotMatch(full, /영상이 모자랍니다/);
    assert.doesNotMatch(full, /크레딧 충전/);
    // shortfall 을 안 넘긴 경우(구 호출부)도 마찬가지.
    assert.doesNotMatch(buildAutoPublishReportHtml([ok], kst("2026-08-27T15:32"), null), /영상이 모자랍니다/);
  });

  it("프리헤더가 소재 부족을 먼저 말한다 — 열기 전에 보인다", () => {
    assert.match(html, /오늘 16건 게시 · 영상이 모자라 4건을 못 채웠습니다/);
  });

  it("배너가 **위**에 온다 — 통계·항목 목록보다 앞 (사용자 2026-08-28 \"밑에 두면 사람이 안 봄\")", () => {
    // 리포트를 여는 사람이 알아야 할 첫 사실은 "몇 건 나갔나" 가 아니라 "왜 계획보다
    // 적게 나갔나" 다 — 그 조치(회차 영상 올리기)는 오늘 해야 하기 때문이다.
    const bannerAt = html.indexOf("영상이 모자랍니다");
    const statsAt = html.indexOf(">배포</div>");
    const itemsAt = html.indexOf("영상 열기");
    assert.ok(bannerAt > 0 && statsAt > 0 && itemsAt > 0, "앵커를 못 찾았다");
    assert.ok(bannerAt < statsAt, "부족 배너가 통계 3칸보다 아래다 — 스크롤해야 보인다");
    assert.ok(bannerAt < itemsAt, "부족 배너가 항목 목록보다 아래다 — 20건이면 한참 내려야 한다");
    // 제목(헤더 밴드) 다음이어야 한다 — 밴드보다 위로 올라가면 문서 구조가 깨진다.
    assert.ok(html.indexOf("자동배포 리포트") < bannerAt, "배너가 제목보다 위에 있다");
  });

  it("발송부가 순방과 같은 함수로 목표를 낸다 (소스 스캔)", () => {
    const src = fsSync.readFileSync(pathMod.join(SRC_DIR, "publish/publish-notify.ts"), "utf-8");
    assert.match(src, /target \+= ruleDayTarget\(rule, n, now\)\.target;/,
      "메일이 순방과 다른 식으로 목표를 세면 두 숫자가 갈라진다");
    assert.match(src, /buildAutoPublishReportHtml\(group, now, next, shortfall\)/,
      "메일 본문이 그 계획 몫(group)이 아니라 버퍼 전체를 그린다");
  });
});

describe("리포트는 자동배포 계획마다 한 통 (2026-08-28)", () => {
  // 사용자 지시: "메일 나가는 것도 자동배포계획당으로 나가야 해."
  // 예전엔 워크스페이스 전체가 한 통이라 ① 프로그램·채널이 섞여 "A 외 1" 로만 적히고
  // ② **모든 계획이 끝나야** 발송돼, 늦게까지 도는 계획 하나가 이미 끝난 계획의 리포트를
  // 밤까지 붙잡았다. 순수 함수로 증명 안 되는 구조라 소스 스캔으로 고정한다.
  const src = fsSync.readFileSync(pathMod.join(SRC_DIR, "publish/publish-notify.ts"), "utf-8");
  const flush = src.match(/export async function maybeFlushAutoPublishReport[\s\S]*$/)?.[0] ?? "";

  it("적립 항목이 계획 id 를 지닌다 — 없으면 나눌 축이 없다", () => {
    assert.match(src, /ruleId\?: string;/, "AutoReportItem 에 계획 축이 없다");
    const records = src.match(/\.\.\.ruleIdOf\(/g) ?? [];
    assert.equal(records.length, 2, "성공·실패 두 적립 지점 모두에서 계획 id 를 심어야 한다");
  });

  it("버퍼를 계획별로 나눠 계획마다 보낸다", () => {
    assert.ok(flush.length > 400, "발송부를 못 잘랐다");
    assert.match(flush, /byRule/, "계획별로 나누지 않는다 — 한 통에 다 섞인다");
    assert.match(flush, /for \(const \[ruleId, group\] of byRule\)/,
      "계획마다 한 통이 아니다");
  });

  it("아직 진행 중인 계획의 적립분은 버퍼에 남는다 — 보낸 것만 뺀다", () => {
    // 통째로 비우면 늦게 도는 계획의 오늘 게시분이 리포트에서 통째로 사라진다.
    assert.match(flush, /kept\.push\(\.\.\.group\)/, "진행 중인 계획 몫을 안 남긴다");
    assert.match(flush, /REPORT_BUFFER_KEY, kept\.length \? JSON\.stringify\(kept\) : ""/,
      "버퍼를 통째로 비운다 — 아직 안 보낸 계획의 적립분이 사라진다");
  });

  it("한 통이 실패해도 나머지는 나가고, 실패분만 남는다", () => {
    // 발송 루프가 통째로 던지면 이미 보낸 묶음까지 버퍼에 남아 다음 순방에 두 번 나간다.
    assert.match(flush, /catch \(e\) \{[\s\S]*?kept\.push\(\.\.\.group\);[\s\S]*?continue;/,
      "개별 발송 실패를 가두지 않는다 — 중복 발송이나 전체 중단이 된다");
  });

  it("계획을 못 찾은 묶음도 기다리지 않고 나간다", () => {
    // 지워진 계획의 고아 클립·ruleId 없는 옛 항목. 기다릴 근거가 없는데 붙잡으면 영영 안 나간다.
    assert.match(flush, /!hasStale && rule && !ruleReportDue\(rule, now\)/,
      "계획을 못 찾으면 무한 대기한다 — rule 이 있을 때만 마감을 기다려야 한다");
  });
});

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
import { describe, it } from "node:test";

import {
  buildAutoPublishReportHtml, ruleDayTarget, type AutoReportItem,
} from "./publish-notify.ts";

const kst = (v: string) => new Date(`${v}+09:00`);

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

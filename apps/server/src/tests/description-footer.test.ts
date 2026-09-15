/**
 * 채널 배포 설명 고정 문구(channel_rule.descriptionFooter) — 조립 규칙 + **생산→저장→소비 3단 배선**.
 *
 * 이 리포 최빈 실패모드가 "기능은 있는데 출력이 소비처에 미도달"이다. 고정 문구는 특히
 * 위험하다: 채널 화면(생산)·PUT 라우트+DB 컬럼(저장)·발행 조립(소비) 중 하나만 빠져도
 * "저장했는데 설명에 안 붙는" 상태가 조용히 굳는다. 커머스 링크가 밟았던 그 구멍
 * (titleColor 유실 · titlePrefix 1년 미배선)과 같은 계열이라 소스 스캔으로 고정한다.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withDescriptionFooter } from "../publish/description-footer.ts";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(HERE, p), "utf8");
const ROOT = path.resolve(HERE, "../../..");
const readRepo = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("withDescriptionFooter — 조립 규칙", () => {
  it("동적 설명 아래 빈 줄 하나 두고 붙는다", () => {
    assert.equal(withDescriptionFooter("생성된 설명", "고정 문구"), "생성된 설명\n\n고정 문구");
  });

  it("문구가 비면 원문 그대로 — 안 적은 채널의 발행은 1바이트도 안 바뀐다(무회귀)", () => {
    assert.equal(withDescriptionFooter("생성된 설명", ""), "생성된 설명");
    assert.equal(withDescriptionFooter("생성된 설명", undefined), "생성된 설명");
    assert.equal(withDescriptionFooter("생성된 설명", "   "), "생성된 설명");
  });

  it("설명이 비면 문구만 나간다 (앞에 빈 줄을 남기지 않는다)", () => {
    assert.equal(withDescriptionFooter("", "고정 문구"), "고정 문구");
    assert.equal(withDescriptionFooter("   ", "고정 문구"), "고정 문구");
  });

  it("멱등 — 이미 붙어 있으면 다시 붙이지 않는다 (updatemeta 재조립·네이버 이중 적용 경로)", () => {
    const once = withDescriptionFooter("설명", "고정 문구");
    assert.equal(withDescriptionFooter(once, "고정 문구"), once);
  });
});

describe("배선 — 채널 화면(생산) → channel_rule(저장) → 발행 조립(소비)", () => {
  const worker = read("worker.ts");
  const index = read("index.ts");
  const dbpg = read("db-pg.ts");

  it("저장: PUT /api/channel-rules 가 descriptionFooter 를 받고, DB 컬럼·upsert 에도 있다", () => {
    assert.match(index, /descriptionFooter: str\(body\.descriptionFooter/,
      "라우트가 안 받으면 화면에서 저장해도 조용히 유실된다");
    assert.match(dbpg, /description_footer AS "descriptionFooter"/,
      "RULE_COLS 에 없으면 저장돼도 읽히지 않는다");
    assert.match(dbpg, /description_footer = \$14/,
      "upsert 갱신 목록에 없으면 두 번째 저장부터 안 바뀐다");
    const mig = fs.readdirSync(path.join(HERE, "../migrations"))
      .some((f) => /description-footer/.test(f));
    assert.ok(mig, "channel_rule.description_footer 마이그레이션이 없다 — 프로덕션에서 컬럼 없음으로 죽는다");
  });

  it("소비: metaForChannel(clip, channel, accountId) 이 채널 문구를 커머스 블록 **앞에서** 붙인다", () => {
    const fn = /function metaForChannel[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";
    assert.notEqual(fn, "", "metaForChannel 을 못 찾았다");
    assert.match(fn, /channelDescriptionFooter\(channel, accountId\)/,
      "채널 규칙에서 문구를 로드하지 않는다");
    assert.match(fn, /withCommerceLinks\(withDescriptionFooter\(description, footer\)/,
      "고정 문구가 커머스 블록 밖(뒤)에 붙으면 대가성 문구가 맨 아래가 아니게 된다");
  });

  it("소비: 발행 5경로 전부 계정을 넘긴다 — 안 넘기면 그 채널만 문구가 조용히 빠진다", () => {
    assert.match(worker, /await metaForChannel\(clip, "youtube", channelId\)/, "유튜브");
    assert.match(worker, /await metaForChannel\(clip, "instagram", igUserId\)/, "인스타그램");
    assert.match(worker, /await metaForChannel\(clip, "facebook", pageId\)/, "페이스북");
    assert.match(worker, /await metaForChannel\(clip, "tiktok", openId\)/, "틱톡");
    assert.match(worker, /await metaForChannel\(clip, channel, accountId \|\| undefined\)/, "네이버");
  });

  it("소비: 틱톡은 캡션(제목) 끝에 붙는다 — 설명란이 없는 유일한 플랫폼", () => {
    assert.match(worker, /withDescriptionFooter\(meta\.title, await channelDescriptionFooter\("tiktok", openId\)\)/,
      "틱톡 캡션 꼬리표(예: '(Sub Indo/terjemahan AI)')가 발행에 미도달한다");
  });

  it("소비: 발행 후 메타 수정(updatemeta)이 고정 문구를 벗기지 않는다 (커머스와 같은 멱등 재적용)", () => {
    const fn = /async function handleDistributionUpdateMeta[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";
    assert.notEqual(fn, "", "handleDistributionUpdateMeta 를 못 찾았다");
    assert.match(fn, /withDescriptionFooter\(/,
      "저장본(saved.description)이 metaForChannel 을 우회한다 — 제목 수정 한 번에 고정 문구가 사라진다");
  });

  it("소비: 네이버 발행의 payload 설명 경로에도 붙는다 (metaForChannel 을 우회하는 유일한 발행 설명)", () => {
    assert.match(worker, /const description = withDescriptionFooter\(\s*typeof job\.payload\.description === "string"/,
      "네이버 발행 설명 조립에 withDescriptionFooter 가 없다");
  });

  it("생산: 배포채널 화면이 편집기를 5개 플랫폼 자리에 실제로 그린다", () => {
    const page = readRepo("apps/web/src/app/(app)/publish-channels/page.tsx");
    for (const p of ["youtube", "facebook", "instagram", "tiktok"]) {
      assert.match(page, new RegExp(`platform="${p}"`),
        `배포채널 화면에 ${p} 고정 문구 편집기가 없다 — 그 채널만 설정할 방법이 없다`);
    }
    const naver = readRepo("apps/web/src/components/publish/naver-accounts.tsx");
    assert.match(naver, /ChannelFooterEditor/, "네이버 계정 드로어에 편집기가 없다");
    const editor = readRepo("apps/web/src/components/publish/channel-footer-editor.tsx");
    assert.match(editor, /saveChannelRule\(platform, accountId/, "편집기가 채널 규칙으로 저장하지 않는다");
    // 부분 전송 함정 — 기존 규칙을 스프레드하지 않으면 PUT 라우트가 role 을 "main" 으로 되돌린다.
    assert.match(editor, /\.\.\.\(effective \?\? \{ label: accountId \}\)/,
      "저장 시 기존 규칙을 스프레드하지 않으면 다른 채널 설정(role 등)이 조용히 초기화된다");
    const api = readRepo("apps/web/src/lib/data/api.ts");
    assert.match(api, /descriptionFooter\?: string/, "웹 ChannelPublishTarget 타입에 descriptionFooter 가 없다");
  });

  it("프로그램 단위 흔적이 남아 있지 않다 (2026-09-15 채널 단위로 전환 — 두 벌이면 어느 쪽이 이기는지 아무도 모른다)", () => {
    assert.doesNotMatch(index, /"descriptionFooter",/,
      "프로그램 PATCH strFields 에 descriptionFooter 가 남아 있다");
    assert.doesNotMatch(worker, /programFooterForClip/, "worker 에 프로그램 단위 로더가 남아 있다");
    const settings = readRepo("apps/web/src/app/(app)/programs/[id]/settings/page.tsx");
    assert.doesNotMatch(settings, /descriptionFooter/, "프로그램 설정 화면에 고정 문구 UI가 남아 있다");
  });
});

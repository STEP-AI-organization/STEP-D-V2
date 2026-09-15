/**
 * 프로그램 배포 설명 고정 문구(descriptionFooter) — 조립 규칙 + **생산→저장→소비 3단 배선**.
 *
 * 이 리포 최빈 실패모드가 "기능은 있는데 출력이 소비처에 미도달"이다. 고정 문구는 특히
 * 위험하다: 설정 화면(생산)·PATCH 화이트리스트(저장)·발행 조립(소비) 중 하나만 빠져도
 * "저장했는데 설명에 안 붙는" 상태가 조용히 굳는다. 커머스 링크가 밟았던 그 구멍
 * (titleColor 유실 · titlePrefix 1년 미배선)과 같은 계열이라 소스 스캔으로 고정한다.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withProgramFooter } from "../publish/description-footer.ts";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(HERE, p), "utf8");
const ROOT = path.resolve(HERE, "../../..");
const readRepo = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("withProgramFooter — 조립 규칙", () => {
  it("동적 설명 아래 빈 줄 하나 두고 붙는다", () => {
    assert.equal(withProgramFooter("생성된 설명", "고정 문구"), "생성된 설명\n\n고정 문구");
  });

  it("문구가 비면 원문 그대로 — 안 적은 프로그램의 발행은 1바이트도 안 바뀐다(무회귀)", () => {
    assert.equal(withProgramFooter("생성된 설명", ""), "생성된 설명");
    assert.equal(withProgramFooter("생성된 설명", undefined), "생성된 설명");
    assert.equal(withProgramFooter("생성된 설명", "   "), "생성된 설명");
  });

  it("설명이 비면 문구만 나간다 (앞에 빈 줄을 남기지 않는다)", () => {
    assert.equal(withProgramFooter("", "고정 문구"), "고정 문구");
    assert.equal(withProgramFooter("   ", "고정 문구"), "고정 문구");
  });

  it("멱등 — 이미 붙어 있으면 다시 붙이지 않는다 (updatemeta 재조립·네이버 이중 적용 경로)", () => {
    const once = withProgramFooter("설명", "고정 문구");
    assert.equal(withProgramFooter(once, "고정 문구"), once);
  });
});

describe("배선 — 설정 화면(생산) → PATCH(저장) → 발행 조립(소비)", () => {
  const worker = read("worker.ts");
  const index = read("index.ts");

  it("저장: PATCH /api/programs/:id 화이트리스트(strFields)에 descriptionFooter 가 있다", () => {
    const block = /const strFields = \[([\s\S]*?)\] as const;/.exec(index)?.[1] ?? "";
    assert.match(block, /"descriptionFooter"/,
      "화이트리스트에 없으면 설정 화면에서 저장해도 조용히 유실된다");
  });

  it("소비: metaForChannel 이 커머스 블록 **앞에서** 고정 문구를 붙인다 (문구가 항상 위)", () => {
    const fn = /function metaForChannel[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";
    assert.notEqual(fn, "", "metaForChannel 을 못 찾았다");
    assert.match(fn, /withCommerceLinks\(withProgramFooter\(description, footer\)/,
      "고정 문구가 커머스 블록 밖(뒤)에 붙으면 대가성 문구가 맨 아래가 아니게 된다");
    assert.match(fn, /await programFooterForClip\(clip\)/, "프로그램 문구를 로드하지 않는다");
  });

  it("소비: 발행 후 메타 수정(updatemeta)이 고정 문구를 벗기지 않는다 (커머스와 같은 멱등 재적용)", () => {
    const fn = /async function handleDistributionUpdateMeta[\s\S]*?\n\}(?=\r?\n)/.exec(worker)?.[0] ?? "";
    assert.notEqual(fn, "", "handleDistributionUpdateMeta 를 못 찾았다");
    assert.match(fn, /withProgramFooter\(/,
      "저장본(saved.description)이 metaForChannel 을 우회한다 — 제목 수정 한 번에 고정 문구가 사라진다");
  });

  it("소비: 네이버 발행의 payload 설명 경로에도 붙는다 (metaForChannel 을 우회하는 유일한 발행 설명)", () => {
    // naver.publish 는 발행 시점에 사람이 넣은 설명(job.payload.description)을 우선한다 —
    // 그 값은 metaForChannel 밖이라 여기서 안 걸면 네이버만 고정 문구가 빠진다.
    assert.match(worker, /const description = withProgramFooter\(\s*typeof job\.payload\.description === "string"/,
      "네이버 발행 설명 조립에 withProgramFooter 가 없다");
  });

  it("생산: 프로그램 설정 화면이 descriptionFooter 를 저장 payload 에 싣는다", () => {
    const page = readRepo("apps/web/src/app/(app)/programs/[id]/settings/page.tsx");
    assert.match(page, /descriptionFooter: descriptionFooter\.trim\(\)/,
      "설정 화면이 필드를 안 보내면 textarea 는 장식이다");
    const api = readRepo("apps/web/src/lib/data/api.ts");
    assert.match(api, /descriptionFooter\?: string/, "웹 API 타입에 descriptionFooter 가 없다");
  });
});

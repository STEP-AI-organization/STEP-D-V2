/**
 * 챗봇의 화면 카탈로그가 **웹의 실제 화면 목록과 같은지** 검사한다.
 *
 * ## 왜 이걸 테스트로 묶나
 *
 * 화면 경로의 정본은 `apps/web/src/lib/nav.ts` 인데, 서버는 그걸 import 할 수 없다(별 패키지).
 * 그래서 서버가 사본을 갖는다. 사본은 반드시 낡는다 — 화면 하나를 지우거나 경로를 바꾸면
 * 챗봇은 **없어진 자리를 계속 가리킨다.** 사용자는 눌러 보고 404 를 만난 뒤에야 안다.
 *
 * 그래서 nav.ts 를 **소스로 읽어** 대조한다. 화면을 추가·삭제하면 여기가 먼저 깨진다.
 * (`worker-lanes.test.ts`·`docs-drift.test.ts` 와 같은 방식·같은 이유)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SCREENS, knownScreen, screenCatalogText } from "../chatbot/catalog.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAV = path.resolve(SRC, "..", "..", "web", "src", "lib", "nav.ts");

function navSource(): string {
  return fs.readFileSync(NAV, "utf-8");
}

/** `{ href: "/dashboard", label: "대시보드", … }` 에서 경로만 걷는다. */
function navHrefs(src: string): string[] {
  return [...src.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
}

/** `SCREEN_META` 의 키 — 사이드바에 없지만 존재하는 화면(회차 상세·크레딧 등). */
function screenMetaKeys(src: string): string[] {
  const block = /export const SCREEN_META[\s\S]*?\n\};/.exec(src)?.[0] ?? "";
  return [...block.matchAll(/^\s*"(\/[^"]*)":/gm)].map((m) => m[1]);
}

describe("챗봇 화면 카탈로그", () => {
  const src = navSource();
  const nav = navHrefs(src);
  const meta = screenMetaKeys(src);
  const catalog = SCREENS.map((s) => s.href);

  it("nav.ts 를 읽을 수 있다 — 못 읽으면 아래 검사가 전부 무의미해진다", () => {
    assert.ok(nav.length >= 15, `사이드바 경로를 ${nav.length}개밖에 못 걷었다 — 파싱이 깨졌다`);
    assert.ok(meta.length >= 10, `SCREEN_META 키를 ${meta.length}개밖에 못 걷었다 — 파싱이 깨졌다`);
  });

  it("사이드바 메뉴가 전부 카탈로그에 있다", () => {
    const missing = nav.filter((h) => !catalog.includes(h));
    assert.deepEqual(missing, [],
      `사이드바에 있는데 챗봇이 모르는 화면: ${missing.join(", ")} — catalog.ts 에 추가할 것`);
  });

  it("카탈로그에 실재하지 않는 화면이 없다", () => {
    const known = new Set([...nav, ...meta]);
    const ghosts = catalog.filter((h) => !known.has(h));
    assert.deepEqual(ghosts, [],
      `웹에 없는 경로를 챗봇이 링크로 줄 수 있다: ${ghosts.join(", ")}`);
  });

  it("모든 항목에 라벨과 설명이 있다 — 설명이 없으면 모델이 화면을 못 고른다", () => {
    for (const s of SCREENS) {
      assert.ok(s.label.trim().length > 0, `${s.href} 라벨 없음`);
      assert.ok(s.what.trim().length >= 8, `${s.href} 설명이 너무 짧다: "${s.what}"`);
    }
  });

  it("경로가 중복되지 않는다", () => {
    assert.equal(new Set(catalog).size, catalog.length, "카탈로그에 같은 경로가 두 번 있다");
  });

  it("하위 경로는 상위 화면으로 접힌다 — id 가 붙은 링크도 통과해야 한다", () => {
    assert.equal(knownScreen("/episodes/ep_1234")?.href, "/episodes");
    assert.equal(knownScreen("/programs/p_1/settings")?.href, "/programs");
    assert.equal(knownScreen("/automation")?.href, "/automation");
    assert.equal(knownScreen("/nope"), null);
  });

  it("프롬프트용 목록이 한 줄에 하나씩 나온다", () => {
    const text = screenCatalogText();
    assert.equal(text.split("\n").length, SCREENS.length);
    assert.match(text, /^\/dashboard · 대시보드 — /m);
  });
});

/**
 * 자막 서체 — **지마켓 산스 Bold** (사용자 확정 2026-08-28).
 *
 * 이 파일이 막는 실패는 하나뿐인데, 그게 눈으로 안 잡힌다:
 * **libass 는 Fontname 을 못 찾으면 오류를 내지 않고 Noto 로 대체한다.** 그래서 이름을 틀리거나
 * 폰트를 이미지에 안 넣으면 "폰트를 바꿨는데 결과물은 그대로"가 되고, 아무도 모르는 채
 * 몇 회차가 나간다. 그래서 문자열 대조가 아니라 **폰트 파일이 실제로 신고하는 이름을 읽어서**
 * 코드와 맞는지 본다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { FONT_FAMILIES } from "../media/overlay-canvas.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SRC, "../../..");
const read = (p: string) => fs.readFileSync(path.resolve(REPO, p), "utf-8");

/** TrueType `name` 테이블에서 nameID 를 읽는다 (Windows/유니코드 레코드 우선). */
function fontNames(file: string): Map<number, string> {
  const d = fs.readFileSync(path.resolve(REPO, file));
  const numTables = d.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (d.toString("latin1", rec, rec + 4) === "name") {
      nameOff = d.readUInt32BE(rec + 8);
      break;
    }
  }
  assert.ok(nameOff >= 0, `${file} 에 name 테이블이 없다 — 폰트 파일이 깨졌다`);

  const count = d.readUInt16BE(nameOff + 2);
  const stringOff = nameOff + d.readUInt16BE(nameOff + 4);
  const out = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const p = nameOff + 6 + 12 * i;
    const platformId = d.readUInt16BE(p);
    const nameId = d.readUInt16BE(p + 6);
    const len = d.readUInt16BE(p + 8);
    const off = d.readUInt16BE(p + 10);
    const raw = d.subarray(stringOff + off, stringOff + off + len);
    const text = platformId === 3 ? raw.swap16().toString("utf16le") : raw.toString("latin1");
    if (!out.has(nameId)) out.set(nameId, text);
  }
  return out;
}

const GMARKET_BOLD = "assets/invoice-fonts/GmarketSansTTFBold.ttf";

describe("자막 서체 — 이름이 파일과 일치해야 한다", () => {
  it("폰트 파일이 신고하는 패밀리는 'Gmarket Sans TTF' · 굵기는 Bold", () => {
    const n = fontNames(GMARKET_BOLD);
    assert.equal(n.get(1), "Gmarket Sans TTF", "패밀리명(nameID 1)이 바뀌면 ASS Fontname 도 같이 바꿔야 한다");
    assert.equal(n.get(2), "Bold");
  });

  it("captionAssStyle 이 고른 글꼴을 그대로 쓴다 — 별칭을 쓰면 조용히 폴백된다", () => {
    const src = read("apps/server/src/index.ts");
    const family = fontNames(GMARKET_BOLD).get(1)!;
    // 2026-08-28: 자막 글꼴을 규칙에서 고를 수 있게 되면서 기본값이 폴백 자리로 옮겼다.
    // 가드의 의도(이름이 폰트 파일과 일치)는 그대로 — 기본값과 매핑표 둘 다 본다.
    const m = /const font = \(fontId && ASS_FONT_BY_ID\[fontId\]\) \|\| "([^"]+)";/.exec(src);
    assert.ok(m, "captionAssStyle 의 자막 서체 선언을 찾지 못했다");
    assert.equal(m![1], family,
      "libass 는 못 찾은 폰트를 오류 없이 Noto 로 바꾼다 — 이름이 틀리면 조용히 무효가 된다");
    const table = /const ASS_FONT_BY_ID: Record<string, string> = \{([\s\S]*?)\};/.exec(src);
    assert.ok(table, "글꼴 카탈로그 → ASS 이름 매핑표를 찾지 못했다");
    assert.match(table![1], new RegExp(`gmarket:\\s*"${family}"`),
      "매핑표의 지마켓 항목도 폰트 파일이 신고하는 패밀리명이어야 한다");
  });

  it("제목·시간박스는 Pretendard 그대로 — 바꾼 건 자막뿐이다", () => {
    const src = read("apps/server/src/index.ts");
    assert.match(src, /Style: Default,Pretendard ExtraBold,/);
    assert.match(src, /Style: BoxLabel,Pretendard ExtraBold,/);
  });
});

describe("폰트가 렌더 이미지 안에 있어야 한다", () => {
  const docker = read("apps/server/Dockerfile");

  it("지마켓 폰트를 fontconfig 경로로 복사한다 — 앱 디렉토리 복사만으로는 libass 가 못 본다", () => {
    assert.match(docker, /COPY assets\/invoice-fonts \/usr\/share\/fonts\/truetype\/gmarket/);
  });

  it("복사가 fc-cache **앞**에 있다 — 뒤에 있으면 캐시에 안 들어간다", () => {
    const copyAt = docker.indexOf("/usr/share/fonts/truetype/gmarket");
    const cacheAt = docker.indexOf("RUN fc-cache -f");
    assert.ok(copyAt >= 0 && cacheAt >= 0, "COPY 또는 fc-cache 를 찾지 못했다");
    assert.ok(copyAt < cacheAt, "폰트 복사가 fc-cache 뒤면 등록되지 않는다");
  });

  it("인보이스용 앱 디렉토리 복사도 남아 있다 — 지우면 인보이스 PDF 만 조용히 실패한다", () => {
    assert.match(docker, /COPY assets\/invoice-fonts assets\/invoice-fonts/);
  });
});

/**
 * 제목(2줄 훅) 서체·강조색 — 고객사 레퍼런스 기준 (2026-08-28).
 * 강조색 `#F3AF4F` 는 눈대중이 아니라 레퍼런스 쇼츠의 **글자 속 화소를 샘플링한 median** 이다.
 */
describe("제목 — 지마켓 산스 + 레퍼런스 강조색", () => {
  const factory = read("apps/server/src/pipeline/factory.ts");
  const webSeed = read("apps/web/src/app/(app)/automation/page.tsx");
  const ACCENT = "#F3AF4F";

  it("두 템플릿 모두 레퍼런스 강조색을 시드로 갖는다", () => {
    const accents = [...factory.matchAll(/accent: "(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    assert.equal(accents.length, 2, "템플릿 시드가 2개가 아니다 — 추가됐으면 이 테스트도 같이 본다");
    for (const a of accents) assert.equal(a, ACCENT);
  });

  it("웹 미러(TEMPLATE_SEED_UI)가 서버 시드와 같은 색이다 — 갈라지면 미리보기가 거짓말한다", () => {
    const webAccents = [...webSeed.matchAll(/accent: "(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    assert.equal(webAccents.length, 2);
    for (const a of webAccents) assert.equal(a, ACCENT);
  });

  it("제목 줄 기본 글꼴이 지마켓 — 계획에서 고른 게 있으면 그게 이긴다", () => {
    assert.match(factory, /font: titleFont \|\| "gmarket",/,
      "기본값을 지우면 레지스트리 기본(프리텐다드)으로 조용히 돌아간다");
  });

  it("그 id 가 폰트 레지스트리에 있고 Bold(700) 를 갖는다 — 렌더가 800 을 요청해도 700 으로 스냅된다", () => {
    const overlay = read("apps/server/src/media/overlay-canvas.ts");
    assert.match(overlay, /id: "gmarket"/);
    assert.match(overlay, /700: \{ file: "GmarketSansTTFBold\.ttf"/);
  });

  it("자동배포 미리보기도 같은 글꼴로 그린다", () => {
    const preview = read("apps/web/src/components/automation/template-preview.tsx");
    assert.match(preview, /fontFamily: "'GmarketSans', var\(--font-sans\)"/);
  });
});

/**
 * 글꼴 카탈로그 전체 — 위 지마켓 가드를 **모든 패밀리로** 넓힌다.
 *
 * 글꼴 하나를 추가하려면 네 군데가 같이 움직여야 한다: 서버 레지스트리(overlay-canvas) ·
 * ASS 이름표(index.ts) · 웹 픽커(presets.ts) · @font-face(globals.css). 하나만 빠져도
 * **오류 없이 다른 글꼴이 나간다** — libass 는 Noto 로, 브라우저는 시스템 폰트로 조용히 간다.
 * 그래서 이름을 문자열끼리 대조하지 않고 **폰트 파일이 신고하는 패밀리명을 읽어** 맞춘다.
 * (2026-09-02 실측: 강원교육모두 파일의 패밀리는 `GangwonEduAll Bold` — 파일명과 다르다.)
 */
describe("글꼴 카탈로그 — 레지스트리·ASS 이름·픽커·@font-face 가 한 줄로 이어진다", () => {
  const src = read("apps/server/src/index.ts");
  const presets = read("apps/web/src/lib/editor/presets.ts");
  const css = read("apps/web/src/app/globals.css");

  /** index.ts 의 id → ASS Fontname 표. 주석 줄은 `id: "..."` 꼴이 아니라 자연히 걸러진다. */
  const assById: Record<string, string> = (() => {
    const m = /const ASS_FONT_BY_ID: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(m, "ASS_FONT_BY_ID 매핑표를 찾지 못했다");
    const out: Record<string, string> = {};
    for (const g of m![1].matchAll(/^\s*(\w+):\s*"([^"]+)",/gm)) out[g[1]] = g[2];
    return out;
  })();

  const FONT_DIRS = ["assets/fonts", "assets/invoice-fonts"];
  const resolve = (file: string) =>
    FONT_DIRS.map((d) => path.resolve(REPO, d, file)).find((p) => fs.existsSync(p)) ?? null;

  it("모든 패밀리의 ASS 이름이 실제 폰트 파일의 패밀리명과 같다", () => {
    assert.ok(FONT_FAMILIES.length >= 6, "레지스트리를 못 읽었다");
    for (const fam of FONT_FAMILIES) {
      const ass = assById[fam.id];
      assert.ok(ass, `${fam.id} 가 ASS_FONT_BY_ID 에 없다 — 자막·애니메이션 제목만 조용히 폴백한다`);
      // 제목 줄은 항상 weight 800 으로 그린다(index.ts) — 그때 고르는 파일로 대조한다.
      const avail = Object.keys(fam.weights).map(Number);
      const w = avail.reduce((best, x) => (Math.abs(x - 800) < Math.abs(best - 800) ? x : best), avail[0]);
      const file = resolve(fam.weights[w].file);
      assert.ok(file, `${fam.id}:${w} 폰트 파일(${fam.weights[w].file})이 assets 에 없다`);
      assert.equal(fontNames(file!).get(1), ass,
        `${fam.id}: ASS 이름이 파일이 신고하는 패밀리와 다르다 — libass 가 말없이 Noto 로 바꾼다`);
    }
  });

  it("웹 픽커(FONT_FAMILY_OPTIONS)가 서버 레지스트리와 같은 id 집합이다", () => {
    const block = /export const FONT_FAMILY_OPTIONS: FontFamilyOption\[\] = \[([\s\S]*?)\n\];/.exec(presets);
    assert.ok(block, "웹 픽커 목록을 찾지 못했다");
    const ids = [...block![1].matchAll(/\{\s*id:\s*"(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, FONT_FAMILIES.map((f) => f.id),
      "픽커와 서버 레지스트리의 id 가 어긋난다 — 고른 글꼴과 결과물이 갈라진다");
  });

  it("픽커가 가리키는 @font-face 가 globals.css 에 있고 파일도 실재한다", () => {
    const block = /export const FONT_FAMILY_OPTIONS: FontFamilyOption\[\] = \[([\s\S]*?)\n\];/.exec(presets)!;
    for (const m of block[1].matchAll(/id:\s*"(\w+)",\s*label:\s*"[^"]*",\s*css:\s*"'([^']+)'/g)) {
      assert.match(css, new RegExp(`font-family: "${m[2]}"`),
        `${m[1]}: 픽커가 '${m[2]}' 를 쓰는데 globals.css 에 @font-face 가 없다 — 편집 중 미리보기만 조용히 폴백한다`);
    }
    // css 가 가리키는 웹폰트 파일이 public 에 실제로 있어야 한다(404 면 같은 증상).
    const urls = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 8, `globals.css 에서 웹폰트 url 을 못 읽었다(${urls.length}개)`);
    for (const f of urls) {
      assert.ok(fs.existsSync(path.resolve(REPO, "apps/web/public/fonts", f)), `public/fonts/${f} 가 없다`);
    }
  });
});

describe("미리보기도 같은 서체 — 미리보기와 결과물이 갈라지지 않게", () => {
  it("에디터 자막 미리보기가 GmarketSans 를 쓴다", () => {
    const preview = read("apps/web/src/components/editor/editor-preview.tsx");
    assert.match(preview, /fontFamily: "'GmarketSans', var\(--font-sans\)"/);
  });

  it("웹에 그 @font-face 가 실제로 있다 — 없으면 미리보기만 조용히 폴백한다", () => {
    const css = read("apps/web/src/app/globals.css");
    assert.match(css, /font-family: "GmarketSans"/);
    assert.match(css, /GmarketSansTTFBold\.ttf/);
    assert.ok(fs.existsSync(path.resolve(REPO, "apps/web/public/fonts/GmarketSansTTFBold.ttf")));
  });
});

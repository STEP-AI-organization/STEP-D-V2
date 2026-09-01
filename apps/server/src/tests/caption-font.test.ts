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
  const factory = read("apps/server/src/factory.ts");
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

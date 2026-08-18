import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 미리보기(웹) ↔ 번인 렌더(서버) 파리티 고정.
 *
 * 편집 화면에서 본 자리와 결과물의 자리가 다르면 그건 곧 제품 결함이다. 두 경로는 언어도
 * 렌더러도 다르니(CSS vs libass) **같은 숫자를 두 파일이 각자 들고 있는 구조**가 문제다 —
 * 여기서 그 숫자들이 갈라지는 순간 빨간불이 켜지게 고정한다. 순수 함수로 증명이 안 되는
 * 불변식이라 소스 스캔이다(worker-lanes·docs-drift 와 같은 계열).
 *
 * ⚠️ 깨지면 숫자를 지우지 말고 **어느 쪽이 정본인지 정해서 맞출 것.** 정본은 미리보기다
 * (사용자가 디자인하는 화면).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "index.ts"), "utf-8");
const WEB = path.resolve(HERE, "../../web/src/components/editor/editor-preview.tsx");
const FONT_DIR = path.resolve(HERE, "../../../assets/fonts");

describe("자막 크기표 — 웹 cqh 와 서버 CAPTION_PCT 가 같아야 한다", () => {
  it("스타일별 % 가 1:1 로 일치", () => {
    const web = fs.readFileSync(WEB, "utf-8");
    // 웹: case "korean_pop": ... fontSize: "4.4cqh"
    const webPct: Record<string, number> = {};
    const caseRe = /case\s+"(\w+)":[\s\S]{0,400?}?fontSize:\s*"([\d.]+)cqh"/g;
    for (const m of web.matchAll(/case\s+"(\w+)":([\s\S]*?)(?=case\s+"|\n\s*default:)/g)) {
      const px = /fontSize:\s*"([\d.]+)cqh"/.exec(m[2]);
      if (px) webPct[m[1]] = Number(px[1]);
    }
    void caseRe;
    assert.ok(Object.keys(webPct).length >= 8, `웹 자막 표를 못 읽었다 (${Object.keys(webPct).length}종) — 정규식이 낡았는지 확인`);

    const block = /const CAPTION_PCT: Record<string, number> = \{([\s\S]*?)\};/.exec(SERVER);
    assert.ok(block, "서버 CAPTION_PCT 표를 못 찾았다");
    const srvPct: Record<string, number> = {};
    for (const m of block![1].matchAll(/(\w+):\s*([\d.]+)/g)) srvPct[m[1]] = Number(m[2]);

    for (const [style, pct] of Object.entries(webPct)) {
      assert.equal(srvPct[style], pct,
        `자막 "${style}" 크기가 미리보기 ${pct}cqh 인데 렌더는 ${srvPct[style]} — 결과물 글자 크기가 달라진다`);
    }
  });
});

describe("ASS Fontsize 보정 상수 — 실제 폰트 메트릭에서 나와야 한다", () => {
  it("ASS_FS_PER_CSS_PX == (winAscent+winDescent)/unitsPerEm (설치 폰트 실측)", () => {
    const files = fs.readdirSync(FONT_DIR).filter((f) => /\.otf$|\.ttf$/i.test(f));
    assert.ok(files.length, "assets/fonts 에 폰트가 없다 — 렌더가 Noto 로 조용히 폴백한다");
    for (const f of files) {
      const buf = fs.readFileSync(path.join(FONT_DIR, f));
      const tables: Record<string, number> = {};
      for (let i = 0; i < buf.readUInt16BE(4); i++) {
        const o = 12 + i * 16;
        tables[buf.toString("ascii", o, o + 4).trim()] = buf.readUInt32BE(o + 8);
      }
      const upem = buf.readUInt16BE(tables.head + 18);
      const cell = buf.readUInt16BE(tables["OS/2"] + 74) + buf.readUInt16BE(tables["OS/2"] + 76);
      const expected = cell / upem;
      const declared = /const ASS_FS_PER_CSS_PX = (\d+) \/ (\d+);/.exec(SERVER);
      assert.ok(declared, "ASS_FS_PER_CSS_PX 선언을 못 찾았다");
      assert.equal(Number(declared![1]) / Number(declared![2]), expected,
        `${f}: libass 는 Fontsize 를 셀 높이로 읽는다 — 보정이 ${expected} 여야 글자 크기가 미리보기와 같다`);
    }
  });
});

describe("제목 블록 기하 — 웹 블록 폭·패딩과 서버 상수가 같아야 한다", () => {
  it("width 86% · padding 4px", () => {
    const web = fs.readFileSync(WEB, "utf-8");
    assert.match(web, /width:\s*"86%"/, "웹 제목 블록 폭이 바뀌었다 — 서버 TITLE_BLOCK 도 같이 바꿔야 한다");
    assert.match(web, /padding:\s*"0 4px"/, "웹 제목 블록 패딩이 바뀌었다 — 서버 TITLE_PAD_PX 도 같이");
    assert.match(SERVER, /const TITLE_BLOCK = 0\.86;/);
    assert.match(SERVER, /const TITLE_PAD_PX = 4;/);
  });

  it("좌/우 정렬은 블록 안에서 움직인다 (titleX 에 직접 앵커하지 않는다)", () => {
    // 예전 버그: \an7 을 titleX 지점에 그대로 붙여 좌정렬 제목이 0.43·W 만큼 어긋났다.
    assert.match(SERVER, /align === "left" \? cx - half \+ pad : align === "right" \? cx \+ half - pad : cx/);
  });
});

describe("줄바꿈 — ASS 는 자동 줄바꿈이 없으니 서버가 대신 접는다", () => {
  it("제목은 블록 폭에서 미리 접는다", () => {
    assert.match(SERVER, /wrapTextToWidth\(t\.text, TITLE_BLOCK \* W - 2 \* pad, px\)/,
      "제목을 안 접으면 긴 제목이 화면 밖으로 나간다 (WrapStyle 2)");
  });
  it("자막 이벤트는 \\q1(그리디 줄바꿈)로 접는다", () => {
    const events = SERVER.match(/captionEv\.push\(`Dialogue:[^`]*`\)/g) ?? [];
    assert.ok(events.length >= 2, "자막 이벤트 생성부를 못 찾았다");
    for (const ev of events) {
      assert.ok(ev.includes("\\\\q1"), `자막 이벤트에 \\q1 이 없다 — 긴 문장이 화면 밖으로 뻗는다: ${ev.slice(0, 80)}`);
    }
  });
});

describe("채널 뱃지 — 이름과 아이콘이 같은 계산을 쓴다", () => {
  it("아이콘 좌표는 channelBadgeLayout 이 만든 것을 overlay 에 넘긴다", () => {
    assert.match(SERVER, /channelBadgeLayout\(editorState, W, H, scale, iconBox\)/,
      "렌더가 배치 함수를 안 쓰면 아이콘과 채널명이 서로 다른 기준으로 놓인다");
    const ff = fs.readFileSync(path.join(HERE, "ffmpeg.ts"), "utf-8");
    assert.match(ff, /badgeX\(opts\.badge\)/, "overlay x 가 고정 중앙이면 가로 배치가 재현되지 않는다");
  });
  it("부가줄(channelExtraLines)이 렌더에도 존재한다", () => {
    // 예전엔 미리보기에만 있고 서버엔 코드가 아예 없어 결과물에서 증발했다.
    assert.match(SERVER, /channelExtraLines/,
      "부가줄을 서버가 안 구우면 편집 화면에만 보이고 결과물엔 없다");
  });
});

/**
 * 자동배포 자막 오버레이 파리티 — **자동배포 화면 미리보기(template-preview.tsx)** ↔ 서버 렌더.
 *
 * 자막 위치·크기·색을 규칙에서 조절할 수 있게 되면서, 미리보기가 보여준 자리와 결과물 자리가
 * 갈라질 새 표면이 생겼다. 미리보기는 % 값(하단 기준·화면 높이 비율)으로 그리고, 서버 렌더는
 * capMV(\an2 하단 기준)·CAPTION_PCT(높이 비율)로 굽는다 — **같은 축·같은 기본값**이어야 한다.
 * 기본값이 두 파일에서 갈라지는 순간 빨간불이 켜지게 고정한다.
 */
const TPL = fs.readFileSync(
  path.resolve(HERE, "../../web/src/components/automation/template-preview.tsx"), "utf-8");

// 미리보기 자막 기본값: export const SUBTITLE_DEFAULTS = { y: 14, size: 4.4, color: "#FFFFFF" }
const subBlock = /SUBTITLE_DEFAULTS\s*=\s*\{([\s\S]*?)\}/.exec(TPL);
const subDefaults: Record<string, string> = {};
if (subBlock) for (const m of subBlock[1].matchAll(/(\w+):\s*"?([#\w.]+)"?/g)) subDefaults[m[1]] = m[2];

describe("자막 오버레이 기하 — 자동배포 미리보기 자막 기본값이 서버 렌더 기본과 같아야 한다", () => {
  it("SUBTITLE_DEFAULTS(y·size·color)를 읽을 수 있다", () => {
    assert.ok(subBlock, "template-preview 의 SUBTITLE_DEFAULTS 를 못 찾았다 — 정규식이 낡았는지 확인");
    for (const k of ["y", "size", "color"]) assert.ok(subDefaults[k] != null, `SUBTITLE_DEFAULTS.${k} 를 못 읽었다`);
  });

  it("자막 기본 세로 위치 — 미리보기 y 와 서버 CAPTION_MV_PCT 가 1:1", () => {
    const mv = /const CAPTION_MV_PCT = ([\d.]+);/.exec(SERVER);
    assert.ok(mv, "서버 CAPTION_MV_PCT 선언을 못 찾았다 — 자막 기본 세로 위치 상수");
    assert.equal(Number(subDefaults.y), Number(mv![1]),
      `자막 기본 위치가 미리보기 ${subDefaults.y}% 인데 렌더는 ${mv![1]}% — 결과물 자막이 다른 높이에 박힌다`);
  });

  it("자막 기본 크기 — 미리보기 size 와 서버 CAPTION_PCT.korean_pop 이 1:1", () => {
    const b = /const CAPTION_PCT: Record<string, number> = \{([\s\S]*?)\};/.exec(SERVER);
    assert.ok(b, "서버 CAPTION_PCT 표를 못 찾았다");
    const pct: Record<string, number> = {};
    for (const m of b![1].matchAll(/(\w+):\s*([\d.]+)/g)) pct[m[1]] = Number(m[2]);
    assert.equal(Number(subDefaults.size), pct.korean_pop,
      `자막 기본 크기가 미리보기 ${subDefaults.size}% 인데 렌더 기본은 ${pct.korean_pop}% — 글자 크기가 갈라진다`);
  });

  it("자막 기본색이 흰색 — 렌더 korean_pop 기본색과 일치", () => {
    assert.equal(String(subDefaults.color).toUpperCase(), "#FFFFFF",
      "자막 기본색이 흰색이 아니다 — 렌더 korean_pop 기본색(흰색)과 어긋난다");
  });
});

/**
 * 제목 2줄 파리티 (D) — 추천의 **시맨틱 2줄 분할**(titleLine1/titleLine2)이 무인 렌더 시드에서
 * 폭 기준으로 재분할되면 안 된다. 예전엔 factory 가 line2 를 버리고 line1 하나만 폭 분할해
 * (wrapAutoTitle), 그 결과를 렌더/에디터가 또 접어 **3줄**이 됐다. 이제 titleLines 줄 수 =
 * 시각 줄 수여야 한다. 순수 함수로 증명 안 되는 배선 불변식이라 소스 스캔이다.
 */
const FACTORY = fs.readFileSync(path.join(HERE, "factory.ts"), "utf-8");

describe("제목 2줄 — factory autoEditorState 가 titleLine1/2 시맨틱 분할을 재랩핑하지 않는다", () => {
  it("autoEditorState 가 titleLine1·titleLine2 를 둘 다 읽는다", () => {
    assert.match(FACTORY, /rec\.titleLine1/, "titleLine1 을 안 읽는다");
    assert.match(FACTORY, /rec\.titleLine2/,
      "titleLine2 를 안 읽는다 — 추천의 둘째 줄이 버려지면 렌더가 첫 줄을 폭 분할해 3줄이 된다");
  });

  it("둘 다 있으면 [line1, line2] 를 명시적 두 줄로 쓴다 (폭 기준 재분할 금지)", () => {
    assert.match(FACTORY, /lines = \[line1, line2\]/,
      "두 줄이 모두 있을 때 wrapAutoTitle 로 재분할하면 안 된다 — 시맨틱 분할을 그대로 쓴다");
  });

  it("명시적 2줄은 더 긴 줄이 한 줄에 맞도록 크기를 정한다 (nowrap 전제)", () => {
    assert.match(FACTORY, /fitTwoLineTitleSize\(line1, line2\)/,
      "폰트 크기를 최장 줄 기준으로 축소하지 않으면, 재랩핑을 끈 렌더에서 긴 줄이 화면 밖으로 나간다");
  });
});

describe("자막 오버레이 배선 — 미리보기와 렌더가 같은 값(위치·크기·색)을 실제로 소비한다", () => {
  it("서버 렌더가 captionY·captionSize·captionColor 오버라이드를 읽는다", () => {
    // 안 읽으면 규칙에서 조절한 자막이 결과물에 미도달한다(이 리포 최빈 실패모드).
    assert.match(SERVER, /captionY/, "렌더가 captionY 를 안 읽으면 자막 세로 위치 조절이 결과물에 미도달한다");
    assert.match(SERVER, /captionSize/, "렌더가 captionSize 를 안 읽으면 자막 크기 조절이 결과물에 미도달한다");
    assert.match(SERVER, /captionColor/, "렌더가 captionColor 를 안 읽으면 자막 색 조절이 결과물에 미도달한다");
  });

  it("미리보기가 자막을 하단 기준(bottom)으로 subtitle* 값에 그린다 — 렌더 capMV(\\an2)와 같은 축", () => {
    assert.match(TPL, /subtitleY/, "미리보기가 subtitleY 를 안 쓰면 위치 조절이 미리보기에 반영되지 않는다");
    assert.match(TPL, /subtitleSize/, "미리보기가 subtitleSize 를 안 쓴다");
    assert.match(TPL, /subtitleColor/, "미리보기가 subtitleColor 를 안 쓴다");
    // top 으로 그리면 렌더(하단 기준)와 부호가 뒤집혀 자막이 반대편에 뜬다.
    assert.match(TPL, /bottom:\s*`\$\{[^}]*subtitleY[^}]*\}%`/,
      "자막을 bottom(하단 기준)으로 안 그리면 렌더의 capMV(하단 기준)와 위치축이 어긋난다");
  });
});

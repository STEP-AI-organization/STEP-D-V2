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

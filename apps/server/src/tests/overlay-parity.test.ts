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
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = fs.readFileSync(path.join(HERE, "index.ts"), "utf-8");
const WEB = path.resolve(HERE, "../../web/src/components/editor/editor-preview.tsx");
const FONT_DIR = path.resolve(HERE, "../../../assets/fonts");
const OVERLAY_CANVAS = fs.readFileSync(path.join(HERE, "overlay-canvas.ts"), "utf-8");
const FF_OVERLAY = fs.readFileSync(path.join(HERE, "ffmpeg.ts"), "utf-8");

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

/**
 * 자막 끊기(청킹) 파리티 — STT 세그먼트를 화면 단위로 쪼개는 규칙은 미리보기와 렌더가 같아야 한다.
 *
 * 세그먼트 한 덩어리(40~60자)를 통째로 띄우면 9:16 에서 4~5줄이 화면 절반을 덮는다. 그래서 양쪽이
 * 각자 끊는데, **상한이 갈라지면 편집 화면에서 본 덩어리와 결과물 덩어리가 달라진다** — 자리(위치·
 * 크기)와 똑같은 계열의 파리티 표면이다.
 */
describe("자막 청킹 — 웹 상한과 서버 상한이 같아야 한다", () => {
  const WEB_PRESETS = fs.readFileSync(path.resolve(HERE, "../../web/src/lib/editor/presets.ts"), "utf-8");
  const CHUNK = fs.readFileSync(path.join(HERE, "caption-chunk.ts"), "utf-8");

  it("CAPTION_CHUNK_MAX_CHARS · CAPTION_CHUNK_MIN_SEC 가 1:1", () => {
    for (const [name, re] of [
      ["CAPTION_CHUNK_MAX_CHARS", /CAPTION_CHUNK_MAX_CHARS = ([\d.]+);/],
      ["CAPTION_CHUNK_MIN_SEC", /CAPTION_CHUNK_MIN_SEC = ([\d.]+);/],
    ] as const) {
      const srv = re.exec(CHUNK);
      const web = re.exec(WEB_PRESETS);
      assert.ok(srv, `서버 ${name} 선언을 못 찾았다`);
      assert.ok(web, `웹 ${name} 선언을 못 찾았다`);
      assert.equal(Number(srv![1]), Number(web![1]),
        `${name} 가 서버 ${srv![1]} / 웹 ${web![1]} — 미리보기와 결과물의 자막 끊는 자리가 달라진다`);
    }
  });

  it("렌더가 실제로 청킹을 거쳐 자막 이벤트를 만든다", () => {
    // 함수만 있고 배선이 없으면 결과물엔 여전히 세그먼트 통짜가 박힌다(이 리포 최빈 실패모드).
    assert.match(SERVER, /const capChunks = \(Array\.isArray\(captions\) \? captions : \[\]\)\.flatMap\(\(c\) => chunkCaption\(c, capMaxChars\)\)/,
      "buildEditorAss 가 captions 를 chunkCaption 으로 안 쪼개면 자막 끊기가 결과물에 미도달한다");
    assert.match(SERVER, /captionMaxChars/, "렌더가 captionMaxChars 오버라이드를 안 읽는다");
  });

  it("미리보기가 같은 함수로 끊어 현재 조각만 그린다", () => {
    const shell = fs.readFileSync(path.resolve(HERE, "../../web/src/components/editor/editor-shell.tsx"), "utf-8");
    assert.match(shell, /chunkCaption\(/,
      "미리보기가 세그먼트를 통째로 그리면 편집 화면에서 본 자막 양과 결과물이 갈라진다");
    assert.match(shell, /state\.captionMaxChars \?\? CAPTION_CHUNK_MAX_CHARS/,
      "미리보기가 captionMaxChars 오버라이드를 안 읽으면 슬라이더 조절이 화면에 반영되지 않는다");
  });
});

describe("ASS Fontsize 보정 상수 — 실제 폰트 메트릭에서 나와야 한다", () => {
  it("ASS_FS_PER_CSS_PX == (winAscent+winDescent)/unitsPerEm (설치 폰트 실측)", () => {
    // ⚠️ **Pretendard 만 스캔한다.** ASS 캡션 스타일(index.ts 의 Default·BoxLabel·
    // captionAssStyle 는 전부 "Pretendard"/"Pretendard ExtraBold"/"Pretendard Black")은
    // Pretendard 만 쓰고, ASS_FS_PER_CSS_PX 보정도 Pretendard 메트릭(2443/2048)에서 나왔다.
    // assets/fonts 의 나머지(BlackHanSans·DoHyeon·Jua·GothicA1)는 **canvas-PNG 정적 제목
    // 전용** 디스플레이 폰트라 ASS 를 절대 타지 않는다 — 셀높이 비율(예: BlackHanSans 1.02)이
    // Pretendard(1.193)와 달라도 캡션 크기 파리티와 무관하다. 디렉토리 전체를 스캔하면 그
    // 무관한 폰트들 때문에 보정 상수를 흔들게 되므로(과잉 일반화), 캡션 폰트만 검사한다.
    const files = fs.readdirSync(FONT_DIR).filter((f) => /^Pretendard-.*\.(otf|ttf)$/i.test(f));
    assert.ok(files.length, "assets/fonts 에 Pretendard(ASS 캡션 폰트)가 없다 — 렌더가 Noto 로 조용히 폴백한다");
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
  it("width 86% · padding 4(설계 px)×scale=출력 px", () => {
    const web = fs.readFileSync(WEB, "utf-8");
    assert.match(web, /width:\s*"86%"/, "웹 제목 블록 폭이 바뀌었다 — 서버 TITLE_BLOCK 도 같이 바꿔야 한다");
    // 스테이지가 출력 해상도라 패딩은 설계 px 4 를 opx(=×scale) 로 출력 px 로 올린다(서버 TITLE_PAD_PX*scale 와 동일 basis).
    assert.match(web, /padding:\s*`0 \$\{opx\(4\)\}px`/, "웹 제목 블록 패딩이 바뀌었다 — 서버 TITLE_PAD_PX 도 같이");
    assert.match(SERVER, /const TITLE_BLOCK = 0\.86;/);
    assert.match(SERVER, /const TITLE_PAD_PX = 4;/);
  });

  it("좌/우 정렬은 블록 안에서 움직인다 (titleX 에 직접 앵커하지 않는다)", () => {
    // 예전 버그: \an7 을 titleX 지점에 그대로 붙여 좌정렬 제목이 0.43·W 만큼 어긋났다.
    assert.match(SERVER, /align === "left" \? cx - half \+ pad : align === "right" \? cx \+ half - pad : cx/);
  });
});

/**
 * 정적 오버레이 크기 basis 파리티 — **단일 출력 해상도 좌표계.**
 *
 * 미리보기 스테이지가 출력 해상도(canvasW×canvasH) 고정 캔버스를 단일 scale(fit) 로 축소해 보여주고
 * (editor-preview.tsx), 서버 렌더(canvas-PNG·ASS)도 같은 출력 px 를 그대로 쓴다. 즉 오버레이 크기
 * (line.size 등)는 **저장부터 출력 px** 라 양쪽이 곱셈 없이 같은 숫자를 쓴다 → 편집 CSS = 서버 PNG =
 * 결과물(선택/해제 스왑에 안 튄다). 옛 저장분·시드(스테이지 px)는 normalizeEditorCoords 가 로드/렌더
 * 시 ×outScale(=H/stageH) 로 1회 올린다(결과 무회귀) — 그 계수 basis 가 양쪽에서 같아야 한다.
 * (예전엔 서버가 렌더 때 size×(H/640) 로 올리고 CSS 는 cqh 로 canonical 640 을 흉내냈다 — 이중 basis.)
 */
describe("정적 오버레이 크기 basis — 단일 출력 px (편집 CSS px == 서버 canvas px)", () => {
  it("제목·채널 CSS 폰트가 line.size / labelPx(출력 px)를 그대로 쓴다 (곱셈 없음)", () => {
    assert.match(WEB_PREVIEW, /fontSize:\s*line\.size,/,
      "제목 CSS 폰트가 line.size(출력 px)를 그대로 안 쓰면 단일 basis 가 깨진다");
    assert.match(WEB_PREVIEW, /fontSize:\s*labelPx\b/,
      "채널명 CSS 폰트가 labelPx(출력 px)를 그대로 안 쓰면 채널 선택 시 크기가 튄다");
    // 서버 정본(layoutTitleLines): t.size 를 그대로 쓰고 미설정 기본값(30)만 scale 배 — 저장값엔 곱하지 않는다.
    assert.match(SERVER, /Number\(t\.size\) > 0 \? Number\(t\.size\) : 30 \* scale/,
      "서버 layoutTitleLines 가 t.size(출력 px)를 그대로 안 쓰면(저장값에 ×scale 하면) 3배 커진다");
  });

  it("웹 designStageH·outputHeight 가 서버 renderDims(stageH·H)와 1:1 (마이그레이션 계수 basis)", () => {
    // 옛 저장분을 올리는 계수 = 출력H/설계stageH. 양쪽이 같은 표를 써야 무회귀로 올라온다.
    assert.match(PRESETS, /export function designStageH/,
      "웹에 designStageH(서버 renderDims stageH 미러)가 없다 — 마이그레이션 계수의 분모");
    assert.match(PRESETS, /export function outputHeight/,
      "웹에 outputHeight(서버 renderDims H 미러)가 없다 — 마이그레이션 계수의 분자");
    // 16:9 는 특이값((900*1080)/1920=506.25) — 양쪽이 같은 식을 써야 한다.
    assert.match(PRESETS, /case "16:9": return \(900 \* 1080\) \/ 1920;/,
      "16:9 designStageH 가 서버 renderDims stageH 와 다르다");
    assert.match(SERVER, /case "16:9": return \{ W: 1920, H: 1080, stageH: \(900 \* 1080\) \/ 1920 \};/,
      "서버 renderDims 16:9 stageH 가 바뀌었다 — 웹 designStageH 도 같이");
    // 세로 9:16 계열 기본값 640(양쪽 default).
    assert.match(PRESETS, /default: return 640; \/\/ 세로 9:16/,
      "웹 designStageH 9:16 default(640)가 서버 renderDims default 와 다르다");
    assert.match(SERVER, /default:\s*return \{ W: 1080, H: 1920, stageH: 640 \};/,
      "서버 renderDims 9:16 default stageH(640)가 바뀌었다 — 웹 designStageH 도 같이");
  });

  it("두 normalizeEditorCoords(웹·서버)가 같은 계수·같은 마커로 옛 저장분을 올린다", () => {
    // 마커: 웹이 coordBasis:"output" 로 저장/전송 → 서버가 재정규화하지 않는다(멱등).
    assert.match(PRESETS, /export function normalizeEditorCoords/,
      "웹 normalizeEditorCoords 가 없다 — 옛 저장분/시드를 출력 px 로 올리는 단일 지점");
    assert.match(PRESETS, /coordBasis === "output"/, "웹 정규화가 멱등 마커를 안 본다 — 이중 적용 위험");
    assert.match(SERVER, /function normalizeEditorCoords/,
      "서버 normalizeEditorCoords 가 없다 — 렌더 시 옛 DB 상태를 올려야 결과 무회귀");
    assert.match(SERVER, /if \(es\.coordBasis === "output"\) return es;/,
      "서버 정규화가 coordBasis 마커를 안 보면 웹이 올려 보낸 값을 또 곱해 3배가 된다");
    // 서버 계수 = H/stageH · 웹 계수 outScale = outputHeight/designStageH — 같은 값이어야 한다.
    assert.match(SERVER, /const f = H \/ stageH;/, "서버 마이그레이션 계수가 H/stageH 가 아니다");
    assert.match(PRESETS, /return outputHeight\(aspect\) \/ designStageH\(aspect\);/,
      "웹 outScale 이 outputHeight/designStageH 가 아니면 서버 H/stageH 와 갈라진다");
  });

  it("렌더가 editorState 를 정규화한 뒤에 굽는다 (생산→소비 배선)", () => {
    // 정규화를 안 하면 옛 DB 상태(스테이지 px)가 출력 px 로 오인돼 결과물 글자가 1/3 로 쪼그라든다.
    assert.match(SERVER, /const editorState = normalizeEditorCoords\(opts\.editorState, aspect\);/,
      "renderShort 진입에서 editorState 를 정규화하지 않으면 옛 클립이 3배 작게 렌더된다");
    assert.match(SERVER, /es = normalizeEditorCoords\(es, aspect\);/,
      "overlayPreviewItems(에디터 PNG)가 정규화를 안 하면 미리보기 PNG 가 옛 DB 상태에서 쪼그라든다");
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

// 미리보기 자막 기본값: export const SUBTITLE_DEFAULTS = { y: 26, size: 4.4, color: "#FFFFFF" }
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
const EDITOR_PRESETS = fs.readFileSync(
  path.resolve(HERE, "../../web/src/lib/editor/presets.ts"), "utf-8");

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

  it("무편집 제목은 첫 줄 106px·둘째 줄 107px 출력값을 쓴다", () => {
    assert.match(FACTORY, /size: \(i === 0 \? 106 : 107\) \/ titleOutScale/,
      "factory 제목 기본 크기가 106px·107px 출력값과 달라졌다");
  });
});

describe("무편집 렌더 기본 프리셋 — 편집기 초기값도 factory와 같다", () => {
  it("제목 첫 줄 106px·둘째 줄 107px를 출력 basis로 시드한다", () => {
    assert.match(EDITOR_PRESETS, /size: 106 \/ initialScale/);
    assert.match(EDITOR_PRESETS, /size: 107 \/ initialScale/);
  });

  it("채널 세로 위치 82%·자막 세로 위치 26%를 명시한다", () => {
    assert.match(EDITOR_PRESETS, /channelY: 82/);
    assert.match(EDITOR_PRESETS, /captionY: 26/);
  });
});

/**
 * 제목 2줄 — **생산처까지** 이어져 있는가 (2026-08-19).
 *
 * ⚠️ 위 describe 는 소비처(factory)가 titleLine1/2 를 *읽는지*만 봤다. 그래서 생산처가
 * 끊겨 있는 동안에도 **초록이었다** — core/recommend 는 title_line1/2 를 필수로 뽑는데
 * (실측: shorts.json 8/8 · 20/20 보유) content-pipeline 의 추천 매핑이 그 두 필드를 안 읽어
 * 추천 엔티티에 실리지 않았고, 결과적으로 제목 편집이 늘 한 줄로 떴다.
 * 그래서 여기서 **생산(core→추천) → 승계(채택→클립) → 소비(에디터 초기 상태)** 3단을 고정한다.
 * 소비처만 검사하는 테스트는 이 종류의 결함을 못 잡는다.
 */
describe("제목 2줄 — core 산출물이 에디터까지 도달한다", () => {
  const PIPELINE = fs.readFileSync(path.join(HERE, "content-pipeline.ts"), "utf-8");
  const PRESETS_SRC = fs.readFileSync(path.resolve(HERE, "../../web/src/lib/editor/presets.ts"), "utf-8");
  const SHELL = fs.readFileSync(path.resolve(HERE, "../../web/src/components/editor/editor-shell.tsx"), "utf-8");

  it("생산: content-pipeline 이 shorts 의 title_line1/2 를 추천 엔티티에 싣는다", () => {
    assert.match(PIPELINE, /titleLine1: typeof s\.title_line1 === "string"/,
      "여기서 안 실으면 추천에 두 줄이 없다 — 아래 소비처가 아무리 멀쩡해도 한 줄로 떨어진다");
    assert.match(PIPELINE, /titleLine2: typeof s\.title_line2 === "string"/,
      "둘째 줄이 없으면 makeInitialEditorState 가 한 줄 분기로 간다(둘 다 있어야 2줄)");
  });

  it("승계: 채택이 추천의 두 줄을 클립으로 넘긴다", () => {
    assert.match(SERVER, /titleLine1: rec\.titleLine1/, "채택이 titleLine1 을 안 넘기면 클립에서 끊긴다");
    assert.match(SERVER, /titleLine2: rec\.titleLine2/, "채택이 titleLine2 를 안 넘기면 클립에서 끊긴다");
  });

  it("소비: 에디터가 두 줄이 다 있을 때만 2줄로 시드한다", () => {
    assert.match(PRESETS_SRC, /const initialLines = \(titleLine1 && titleLine2\)/,
      "두 줄 시드 분기가 사라졌다 — 제목 편집이 한 줄로 고정된다");
    assert.match(SHELL, /clip\?\.titleLine1, clip\?\.titleLine2/,
      "에디터 셸이 클립의 두 줄을 안 넘기면 시드가 폴백 한 줄로 간다");
  });

  it("둘째 줄 색도 같은 3단으로 흐른다 (줄만 살리고 색을 버리지 않는다)", () => {
    assert.match(PIPELINE, /titleLine2Color: typeof s\.title_line2_color === "string"/,
      "색을 안 실으면 AI 가 고른 톤(폭로=red 등)이 사라지고 항상 파랑으로 굳는다");
    assert.match(SERVER, /titleLine2Color: rec\.titleLine2Color/, "채택이 색을 안 넘긴다");
    assert.match(PRESETS_SRC, /function titleLine2Hex/, "색 이름 → hex 변환이 없다");
    assert.match(PRESETS_SRC, /color: titleLine2Hex\(titleLine2Color\)/,
      "둘째 줄 색이 하드코딩으로 돌아갔다 — 색을 실어 보내도 소비되지 않는다");
  });
});

/**
 * 정적 오버레이 canvas→PNG 마이그레이션 (하이브리드 · AENA 방식).
 *
 * 제목(완전 정적 줄)·채널명 텍스트는 이제 ASS 번인이 아니라 **canvas 로 그린 투명 PNG** 를
 * ffmpeg overlay 로 합성한다 → 에디터가 **같은 PNG** 를 `<img>` 로 보여줘 구조적 WYSIWYG.
 * 시간축이 수백 개인 STT 자막·애니메이션/시간창 제목·요소는 여전히 ASS(하이브리드).
 *
 * ⚠️ 정적 오버레이의 "파리티"는 이제 **ASS 기하 손튜닝 일치**가 아니라 **에디터=렌더가 같은
 * PNG** 로 옮겨갔다. 위쪽 제목/뱃지 ASS 기하 단언은 애니메이션/폴백 경로가 여전히 그 ASS 를
 * 쓰기 때문에 유효하다(죽은 테스트 아님). 아래는 그 새 PNG 경로가 실제 배선돼 있는지 고정한다.
 */
describe("정적 오버레이 canvas-PNG 경로 (하이브리드)", () => {
  it("overlay-canvas 가 텍스트 레이어 PNG 렌더러를 export 하고 ASS 와 같은 폰트를 등록한다", () => {
    assert.match(OVERLAY_CANVAS, /export async function renderTextLayerPng/,
      "PNG 텍스트 레이어 렌더러가 없다");
    assert.match(OVERLAY_CANVAS, /@napi-rs\/canvas/, "canvas 네이티브 렌더러를 안 쓴다");
    assert.match(OVERLAY_CANVAS, /Pretendard-ExtraBold\.otf/,
      "ASS 와 같은 Pretendard 폰트를 canvas 에 등록해야 PNG 글자가 결과물과 일치한다");
  });

  it("index 가 정적 오버레이 아이템을 만들어 PNG 로 렌더하고 renderShort 에 넘긴다", () => {
    assert.match(SERVER, /function buildStaticOverlayItems/,
      "정적 오버레이 그리기 목록(제목·채널명) 생성부가 없다");
    assert.match(SERVER, /renderTextLayerPng\(/, "index 가 PNG 렌더러를 안 부른다");
    assert.match(SERVER, /overlayPngPath/,
      "renderShort 로 overlayPngPath 를 안 넘기면 정적 오버레이 합성이 결과물에 미도달한다");
  });

  it("buildEditorAss 가 staticToPng 로 정적 제목·채널명을 ASS 에서 뺀다 (이중 그리기 방지)", () => {
    assert.match(SERVER, /staticToPng/,
      "정적 항목을 ASS 에서 안 빼면 canvas-PNG 와 이중으로 그려진다");
    assert.match(SERVER, /if \(staticToPng && L\.isStatic\) continue;/,
      "정적 제목 줄을 ASS 에서 건너뛰지 않으면 PNG 와 겹친다");
  });

  it("ffmpeg renderShort 가 overlayPngPath 를 전체프레임 overlay=0:0 으로 합성한다", () => {
    assert.match(FF_OVERLAY, /overlayPngPath/, "renderShort 가 정적 오버레이 PNG 입력을 안 받는다");
    assert.match(FF_OVERLAY, /overlay=0:0/,
      "정적 오버레이 PNG 를 전체프레임 합성하는 필터가 없다");
  });

  it("자막(시간축 수백 개)은 여전히 ASS Caption 이벤트로 남는다 (하이브리드)", () => {
    const events = SERVER.match(/captionEv\.push\(/g) ?? [];
    assert.ok(events.length >= 1,
      "자막 ASS 이벤트 생성부가 사라졌다 — 시간축 자막은 PNG 로 옮기지 않는다(하이브리드)");
  });

  it("에디터가 서버 오버레이 PNG 를 content-hash 로 가져올 엔드포인트가 있다", () => {
    assert.match(SERVER, /app\.post\("\/api\/clips\/:id\/overlay-png"/,
      "에디터가 정적 오버레이 PNG 를 받을 엔드포인트가 없다(WYSIWYG 미완)");
    assert.match(SERVER, /app\.get\("\/api\/clips\/:id\/overlay-png\/:hash"/,
      "해시로 PNG 를 서빙하는 GET 라우트가 없다");
  });
});

describe("편집 중 WYSIWYG — CSS 폰트로 스왑하지 않고 실제 PNG를 유지한다", () => {
  it("서버가 제목·채널을 독립 레이어로 렌더할 수 있다", () => {
    assert.match(SERVER, /group:\s*"title"/, "제목 레이어 표식이 없다");
    assert.match(SERVER, /group:\s*"channel"/, "채널 레이어 표식이 없다");
    assert.match(SERVER, /preview\.items\.filter\(\(item\) => item\.group === body\.layer\)/,
      "통합 PNG만 있으면 제목을 끌 때 채널까지 같이 움직인다");
  });

  it("새 PNG가 완료되기 전에 직전 hash를 null로 버리지 않는다", () => {
    assert.doesNotMatch(OVERLAY_PNG_HOOK, /setHash\(null\)/,
      "hash=null 순간 CSS 근사본으로 전환되면 커닝·줄높이가 튀어 오른다");
    assert.match(OVERLAY_PNG_HOOK, /await preload\(overlayPngSrc\(/,
      "GET 이미지를 미리 로드하지 않으면 hash 교체 순간 빈 프레임이 난다");
    assert.match(OVERLAY_PNG_HOOK, /requestSeq !== seq\.current/,
      "느린 이전 응답이 최신 편집을 덮어쓰면 오버레이가 뒤로 튀다");
  });

  it("선택·드래그·타이핑 중에도 서버 PNG가 화면의 텍스트다", () => {
    assert.match(WEB_PREVIEW, /const showTitlePng\s*=/, "제목 PNG 표시 게이트가 없다");
    assert.match(WEB_PREVIEW, /translate\(\$\{titlePngDx\}px, \$\{titlePngDy\}px\)/,
      "디바운스 대기 중 제목 PNG를 현재 앵커로 즉시 이동시키지 않는다");
    assert.match(WEB_PREVIEW, /onDraftChange=\{\(v\) => setLine\(line\.id, \{ text: v \}\)\}/,
      "타이핑 중 state가 바뀌지 않으면 실제 PNG는 blur 전까지 예전 글자다");
    assert.match(WEB_PREVIEW, /showTitlePng[\s\S]*?color:\s*"transparent"/,
      "입력 DOM 글자가 보이면 실제 PNG 위에 CSS 폰트가 이중으로 겹친다");
  });

  it("채널명 x는 최종 렌더와 같은 실제 아이콘 박스를 쓴다", () => {
    assert.match(SERVER, /async function previewChannelIconBox/,
      "미리보기가 가짜 정사각 박스를 쓰면 채널명이 최종 렌더와 가로로 밀린다");
    assert.match(SERVER, /await measureOverlayImage\(/, "비원형 로고의 실제 폭을 재지 않는다");
    assert.match(SERVER, /!es\?\.showChannel \|\| es\?\.channelIconOff \|\| !clip\?\.episodeId/,
      "아이콘을 끄거나 실제 렌더할 수 없어도 텍스트를 가짜 아이콘 폭만큼 밀면 안 된다");
  });
});

/**
 * 텍스트 스타일 3종(색·글꼴·외곽선) — AENA 채택. 색은 이미 파이프를 통과했고(줄별 color),
 * 글꼴(font 패밀리 id)·외곽선(stroke)은 이번에 canvas-PNG 경로로 추가됐다. 정적 오버레이의
 * 파리티는 "에디터=렌더가 같은 PNG" 이므로, 여기선 **세 스타일이 모델→그리기목록→렌더로
 * 실제 배선됐는지**를 소스 스캔으로 고정한다(생산→저장→소비 3단이 안 끊기게).
 */
const PRESETS = fs.readFileSync(path.resolve(HERE, "../../web/src/lib/editor/presets.ts"), "utf-8");
const PANEL = fs.readFileSync(path.resolve(HERE, "../../web/src/components/editor/editor-panel.tsx"), "utf-8");
const OVERLAY_PNG_HOOK = fs.readFileSync(path.resolve(HERE, "../../web/src/components/editor/use-overlay-png.ts"), "utf-8");
const WEB_PREVIEW = fs.readFileSync(WEB, "utf-8");

describe("텍스트 색 — 커스텀 색 입력이 Swatches 프리미티브에 있다(모든 색 컨트롤에 전파)", () => {
  it("editor-panel Swatches 가 <input type=\"color\"> 를 품는다", () => {
    assert.match(PANEL, /type="color"/,
      "Swatches 에 네이티브 색 선택기가 없다 — 고정 스와치 6색만으론 임의 색을 못 넣는다");
    // 값은 #rrggbb 로 파이프를 그대로 통과 — 렌더/캔버스 변경이 없어야 한다.
    assert.match(PANEL, /function Swatches/, "Swatches 프리미티브가 사라졌다");
  });
});

describe("글꼴(글꼴 변환) — 패밀리가 모델→그리기목록→렌더로 흐른다", () => {
  it("모델: TitleLine 에 font(패밀리 id) 필드가 있다", () => {
    assert.match(PRESETS, /interface TitleLine[\s\S]*?font\?:\s*string/,
      "TitleLine.font 이 없으면 줄별 글꼴을 저장할 곳이 없다");
    assert.match(PRESETS, /FONT_FAMILY_OPTIONS/,
      "웹 글꼴 픽커 목록(FONT_FAMILY_OPTIONS)이 없다");
  });
  it("렌더: overlay-canvas 가 패밀리 레지스트리로 GmarketSans 를 등록한다", () => {
    assert.match(OVERLAY_CANVAS, /FONT_FAMILIES/,
      "패밀리 레지스트리(FONT_FAMILIES)가 없다 — 글꼴 변환할 대상이 없다");
    assert.match(OVERLAY_CANVAS, /GmarketSans/,
      "canvas 에 GmarketSans 를 등록하지 않으면 글꼴 변환 결과물이 Pretendard 로 열화된다");
    assert.match(OVERLAY_CANVAS, /Pretendard-ExtraBold\.otf/,
      "기본 Pretendard 등록은 유지돼야 한다(하위호환)");
  });
  it("배선: buildStaticOverlayItems 가 줄별 font 를 아이템에 실어 보낸다", () => {
    assert.match(SERVER, /font:\s*typeof L\.t\?\.font === "string" \? L\.t\.font : undefined/,
      "정본(index.ts)이 font 를 아이템에 안 실으면 픽커 선택이 결과물 PNG 에 미도달한다");
  });
  it("PNG 재요청 키가 font 변화를 감지한다(에디터 <img> 가 갱신)", () => {
    assert.match(OVERLAY_PNG_HOOK, /f:\s*l\.font/,
      "overlayKey 에 font 가 없으면 글꼴을 바꿔도 PNG 가 재요청되지 않는다");
  });
});

describe("외곽선(stroke) — 정적 오버레이 canvas strokeText 배선", () => {
  it("모델: TitleLine·OverlayTextItem 에 stroke 필드가 있다", () => {
    assert.match(PRESETS, /interface TitleLine[\s\S]*?stroke\?:\s*\{\s*color:\s*string;\s*width:\s*number\s*\}/,
      "TitleLine.stroke 이 없으면 외곽선을 저장할 곳이 없다");
    assert.match(OVERLAY_CANVAS, /stroke\?:\s*\{\s*color:\s*string;\s*width:\s*number\s*\}/,
      "OverlayTextItem.stroke 이 없으면 그리기 목록이 외곽선을 나를 수 없다");
  });
  it("렌더: renderTextLayerPng 가 fill 전에 strokeText 를 호출한다", () => {
    assert.match(OVERLAY_CANVAS, /ctx\.strokeText\(/,
      "strokeText 호출이 없으면 외곽선이 결과물에 안 그려진다");
    assert.match(OVERLAY_CANVAS, /ctx\.lineJoin\s*=\s*"round"/,
      "lineJoin=round 가 없으면 외곽선 모서리가 뾰족하게 튄다(AENA 방식)");
  });
  it("배선: index 가 stroke 를 아이템에 실어 보낸다 (stroke.width 는 출력 px 그대로)", () => {
    // stroke.width 는 이제 출력 px(정규화됨) — 저장값에 ×scale 하면 안 된다(3배 굵어짐).
    assert.match(SERVER, /\{ color: st\.color, width: st\.width \}/,
      "stroke.width(출력 px)를 그대로 안 실으면(×scale 하면) 외곽선이 3배 굵어진다");
  });
  it("미리보기: 편집 중 -webkit-text-stroke 로 근사한다(자막이 쓰는 패턴)", () => {
    // 외곽선 굵기도 출력 px(line.stroke.width) 그대로 — 스테이지 fit 축소가 CSS·PNG 를 똑같이 줄인다.
    assert.match(WEB_PREVIEW, /WebkitTextStroke:\s*`\$\{line\.stroke\.width\}px \$\{line\.stroke\.color\}`/,
      "미리보기가 외곽선을 출력 px(line.stroke.width)로 안 그리면 편집 중(PNG 숨김) 굵기와 결과물이 갈라진다");
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

/**
 * 마이그레이션 계수 — 옛 스테이지 px → 출력 px 가 **결과 무회귀(net-zero)** 임을 수치로 증명한다.
 *
 * 옛 서버 렌더는 출력 px = size × scale, scale = H/stageH. 이제 마이그레이션이 저장값을 size×(H/stageH)
 * 로 올리고 렌더는 그 출력 px 를 그대로 쓴다(×scale 없음). 두 출력 px 가 **정확히 같아야** 옛 클립이
 * 안 바뀐다. 계수 표(세로 3 · 16:9≈2.133 · 1:1=1.2 · 4:5≈2.109)는 renderDims(H·stageH)에서 나온다.
 */
describe("마이그레이션 계수 — 옛 스테이지 px → 출력 px 가 결과 무회귀(net-zero)", () => {
  // 서버 renderDims 의 (H, stageH) — 대표 aspect 별. designStageH(웹)·renderDims.stageH(서버)와 1:1.
  const dims: Record<string, { H: number; stageH: number }> = {
    "9:16-crop-main": { H: 1920, stageH: 640 },
    "16:9": { H: 1080, stageH: (900 * 1080) / 1920 },
    "1:1": { H: 1080, stageH: 900 },
    "4:5": { H: 1350, stageH: 640 },
  };
  const expected: Record<string, number> = {
    "9:16-crop-main": 3, "16:9": 1080 / 506.25, "1:1": 1.2, "4:5": 1350 / 640,
  };

  it("계수 = H/stageH = 예상값 (세로 3 · 16:9≈2.133 · 1:1=1.2 · 4:5≈2.109)", () => {
    for (const [a, d] of Object.entries(dims)) {
      assert.equal(d.H / d.stageH, expected[a], `${a} 마이그레이션 계수(H/stageH)가 ${expected[a]} 가 아니다`);
    }
  });

  it("net-zero: 옛 size×scale(옛 렌더) == size×계수(마이그레이션) → 렌더가 그대로 쓴 출력 px", () => {
    for (const S of [14, 30, 40, 56]) { // 옛 스테이지 px 예시(라벨·제목·아이콘)
      for (const [a, d] of Object.entries(dims)) {
        const oldRenderPx = S * (d.H / d.stageH); // 옛 렌더: 저장 스테이지 px × scale
        const migrated = S * expected[a];         // 마이그레이션: 저장값 × outScale → 출력 px
        // 새 렌더는 migrated 를 그대로 쓴다(×scale 없음) → 두 값이 같아야 회귀가 없다.
        assert.equal(migrated, oldRenderPx, `${a}(size=${S}): 마이그레이션 후 렌더 크기가 옛 렌더와 다르다 — 회귀`);
      }
    }
  });
});

/**
 * 미리보기 프레임에는 장식이 없어야 한다 — **기본 플레이어로 mp4 를 튼 화면과 같아야 한다**
 * (사용자 확정 2026-08-19).
 *
 * 예전엔 스테이지 뷰포트에 `rounded-lg shadow-2xl` 이 붙어 있었다. 둥근 모서리는 네 귀퉁이에
 * 놓인 것(로고·자막 끝·프레임 테두리)을 **편집 화면에서만** 깎아 보여주고, 그림자는 프레임
 * 경계를 실제보다 도드라지게 만든다 — 결과물엔 둘 다 없다. 자리·크기 파리티와 같은 계열인데
 * "다듬기" 로 되돌아오기 쉬운 종류라(순수 CSS 라 아무 테스트도 안 깨진다) 여기서 고정한다.
 */
describe("미리보기 프레임 장식 — 결과물엔 없는 것을 화면에 더하지 않는다", () => {
  /** 스테이지 뷰포트의 className — ref={viewportRef} 바로 뒤 줄. */
  const viewportCls = (() => {
    const m = /ref=\{viewportRef\}\s*\n\s*className="([^"]*)"/.exec(WEB_PREVIEW);
    assert.ok(m, "스테이지 뷰포트(ref={viewportRef})의 className 을 못 찾았다 — 정규식이 낡았는지 확인");
    return m![1];
  })();

  it("모서리를 둥글리지 않는다", () => {
    assert.doesNotMatch(viewportCls, /\brounded/,
      `뷰포트에 rounded 가 붙었다("${viewportCls}") — 귀퉁이 오버레이가 편집 화면에서만 깎여 보인다`);
  });

  it("그림자를 넣지 않는다", () => {
    assert.doesNotMatch(viewportCls, /\bshadow-/,
      `뷰포트에 shadow 가 붙었다("${viewportCls}") — 결과물에 없는 테두리감이 생긴다`);
  });

  it("overflow-hidden 은 남아 있어야 한다 (장식이 아니라 스테이지 축소본을 자르는 기능)", () => {
    assert.match(viewportCls, /\boverflow-hidden\b/,
      "overflow-hidden 을 지우면 scale 된 스테이지가 뷰포트 밖으로 새어 나온다");
  });
});

/**
 * 아이콘 끄기(channelIconOff) — 미리보기와 렌더가 같이 꺼져야 한다.
 *
 * 이 스위치는 **클립 아이콘이 없을 때 프로그램의 쇼츠 아이콘으로 폴백하는 경로까지** 끄는
 * 유일한 수단이다(index.ts: channelIconDataUrl > program.brandIconDataUrl). 예전엔 레이아웃 탭의
 * "하단 스타일(브랜딩) → 제목만" 이 유일한 생산자였는데 그 프리셋 뭉치를 걷어내면서
 * (2026-08-19) 채널 탭으로 옮겼다. 그때 미리보기는 이 값을 아예 안 봐서 꺼도 아이콘이 남았다 —
 * 생산(토글) → 저장(editorState) → 소비(미리보기·렌더) 3단이 다 이어져 있는지 고정한다.
 */
describe("채널 아이콘 끄기 — 토글·미리보기·렌더가 같은 값을 본다", () => {
  const PANEL_SRC = fs.readFileSync(
    path.resolve(HERE, "../../web/src/components/editor/editor-panel.tsx"), "utf-8");

  it("생산: 채널 탭에 아이콘 표시 토글이 있다", () => {
    assert.match(PANEL_SRC, /channelIconOff: !state\.channelIconOff/,
      "토글이 없으면 아이콘을 끌 방법이 사라진다(서버는 여전히 이 값을 읽는다)");
  });

  it("소비(미리보기): 꺼져 있으면 아이콘을 그리지 않는다", () => {
    assert.match(WEB_PREVIEW, /state\.channelIconOff === true \? null :/,
      "미리보기가 channelIconOff 를 안 보면 꺼도 편집 화면엔 아이콘이 남는다");
  });

  it("소비(렌더): 꺼져 있으면 아이콘 합성을 건너뛴다", () => {
    assert.match(SERVER, /if \(editorState\?\.showChannel && !editorState\?\.channelIconOff/,
      "렌더가 channelIconOff 를 안 보면 결과물에 아이콘이 그대로 박힌다");
  });
});

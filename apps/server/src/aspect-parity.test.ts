import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 종횡비/크롭 파리티 — **에디터(웹) ↔ 번인 렌더(서버)** 가 같은 5-값 enum·같은 사각형 숫자를 쓰게 고정.
 *
 * 예전엔 aspect × fit × bgType 3필드가 갈라져 "메인 크롭"으로 채택한 클립이 레터박스로 렌더됐다.
 * 이제 한 값(enum)이 컨테이너·크롭·밴드를 결정하고, 그 숫자는 두 패키지가 각자 파일로 들고 있다
 * (공유 패키지가 없다 — worker-lanes·overlay-parity 와 같은 소스 스캔 계열). 여기서 두 표가
 * 갈라지거나, 미리보기/렌더가 그 표를 안 읽는 순간 빨간불을 켠다.
 *
 * ⚠️ 깨지면 숫자를 지우지 말고 **정본(미리보기 = 사용자가 보는 화면)에 맞춰** 양쪽을 고칠 것.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PRESETS = fs.readFileSync(path.join(HERE, "aspect-presets.ts"), "utf-8");
const WEB_PRESETS = fs.readFileSync(
  path.resolve(HERE, "../../web/src/lib/editor/aspect-presets.ts"), "utf-8");
const WEB_PREVIEW = fs.readFileSync(
  path.resolve(HERE, "../../web/src/components/editor/editor-preview.tsx"), "utf-8");
const INDEX = fs.readFileSync(path.join(HERE, "index.ts"), "utf-8");
const FFMPEG = fs.readFileSync(path.join(HERE, "ffmpeg.ts"), "utf-8");

/** `export const ASPECT_PRESETS: AspectPreset[] = [ ... ];` 배열 리터럴 본문을 뽑는다. */
function presetsBlock(src: string): string {
  const m = /export const ASPECT_PRESETS: AspectPreset\[\] = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, "ASPECT_PRESETS 배열을 못 찾았다 — 정규식이 낡았는지 확인");
  return m![1];
}

describe("종횡비 프리셋 표 — 웹 정본과 서버 미러가 바이트 동일", () => {
  it("두 ASPECT_PRESETS 배열이 (공백 정규화 후) 1:1 로 일치", () => {
    const web = presetsBlock(WEB_PRESETS).replace(/\s+/g, " ").trim();
    const server = presetsBlock(SERVER_PRESETS).replace(/\s+/g, " ").trim();
    assert.equal(server, web,
      "웹·서버 ASPECT_PRESETS 가 갈라졌다 — 같은 id·fill·rect 를 두 파일이 들고 있어야 미리보기=결과물");
  });

  it("5-값 enum 의 채움·사각형 숫자가 실제로 고정돼 있다", () => {
    const block = presetsBlock(WEB_PRESETS).replace(/\s+/g, " ");
    // 16:9 가로 (contain — 자르지 않음)
    assert.match(block, /\{ id: "16:9", fill: "contain", canvasW: 1920, canvasH: 1080/);
    // 세로 · 전체 담기 = 레터박스(contain) + blur 하위옵션
    assert.match(block, /\{ id: "9:16-letterbox", fill: "contain", canvasW: 1080, canvasH: 1920, blurCapable: true/);
    // 세로 · 꽉 채우기 = cover
    assert.match(block, /\{ id: "9:16-crop-full", fill: "cover", canvasW: 1080, canvasH: 1920/);
    // 세로 · 위 자막띠(메인) = rect (0,440,1080,1480) — AENA 이식
    assert.match(block, /\{ id: "9:16-crop-main", fill: "rect", canvasW: 1080, canvasH: 1920, rect: \{ x: 0, y: 440, w: 1080, h: 1480 \}/);
    // 세로 · 위아래 띠(서브) = rect (0,440,1080,980)
    assert.match(block, /\{ id: "9:16-crop-sub", fill: "rect", canvasW: 1080, canvasH: 1920, rect: \{ x: 0, y: 440, w: 1080, h: 980 \}/);
  });
});

describe("에디터 미리보기가 렌더와 같은 프리셋을 읽는다 (구조적 파리티)", () => {
  it("editor-preview 가 getAspectPreset 으로 사각형을 %로 배치한다", () => {
    assert.match(WEB_PREVIEW, /getAspectPreset\(state\.aspect\)/,
      "미리보기가 프리셋을 안 읽으면 손 파리티로 되돌아간다 — 렌더와 갈라진다");
    // rect 를 캔버스 대비 %로 환산(= 서버 crop,scale,pad 와 같은 좌표 기준).
    assert.match(WEB_PREVIEW, /aspectPreset\.rect\.x \/ aspectPreset\.canvasW/,
      "미리보기가 rect 를 canvasW 로 나눠 %로 그려야 렌더 pad 위치와 일치한다");
    assert.match(WEB_PREVIEW, /aspectPreset\.rect\.y \/ aspectPreset\.canvasH/);
  });

  it("서버 렌더가 프리셋을 소비한다 (getAspectPreset → cropRect → renderShort)", () => {
    assert.match(INDEX, /const aspectPreset = getAspectPreset\(aspect\)/,
      "렌더가 aspect enum 으로 프리셋을 안 읽으면 5값이 구분되지 않는다");
    assert.match(INDEX, /cropRect = aspectPreset\.rect/,
      "rect 프리셋을 cropRect 로 안 넘기면 밴드 크롭이 렌더에 미도달한다");
    assert.match(INDEX, /bgType, bgColor, fit, cropRect, frame,/,
      "renderShort 호출에 cropRect 가 빠지면 crop-main/sub 가 그냥 무시된다");
  });

  it("renderShort 의 밴드 크롭 ffmpeg 수식이 crop,scale,pad 형태다 (AENA 이식)", () => {
    assert.match(FFMPEG,
      /crop=ih\*\$\{r\.w\}\/\$\{r\.h\}:ih,scale=\$\{r\.w\}:\$\{r\.h\},pad=\$\{W\}:\$\{H\}:\$\{r\.x\}:\$\{r\.y\}/,
      "밴드 크롭 수식이 바뀌었다 — 소스를 사각형 비율로 중앙 크롭 → 스케일 → 검정 pad 여야 한다");
  });
});

describe("normalizeAspect — 5값을 뭉개지 않고 그대로 통과시킨다", () => {
  it("crop-main/crop-sub/letterbox/crop-full 이 verbatim 반환된다", () => {
    const m = /function normalizeAspect\(aspectRatio: unknown\): string \| null \{([\s\S]*?)\n\}/.exec(INDEX);
    assert.ok(m, "normalizeAspect 를 못 찾았다");
    const body = m![1];
    assert.match(body,
      /if \(s === "9:16-letterbox" \|\| s === "9:16-crop-full" \|\| s === "9:16-crop-main" \|\| s === "9:16-crop-sub"\) return s;/,
      "5값을 verbatim 통과시키지 않으면 letterbox/crop-main/crop-sub 가 렌더에서 구분되지 않는다");
  });

  it("renderDims 가 세로 enum 4종을 1080×1920 으로 매핑한다", () => {
    for (const id of ["9:16-letterbox", "9:16-crop-full", "9:16-crop-main", "9:16-crop-sub"]) {
      assert.ok(INDEX.includes(`case "${id}":`),
        `renderDims 에 ${id} 케이스가 없다 — 세로 캔버스(1080×1920)로 안 떨어진다`);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTextLayerPng, overlayCanvasAvailable, FONT_FAMILIES, type OverlayTextItem } from "../media/overlay-canvas.ts";

/**
 * canvas→PNG 정적 오버레이 렌더러 스모크. ffmpeg 없이 PNG 경로가 실제로 도는지 증명한다:
 *  - 아이템이 있으면 비어있지 않은 PNG 버퍼가 나오고, 헤더가 요청한 캔버스 크기와 일치한다.
 *  - 아이템이 없으면 null (그릴 게 없음 → 호출자는 오버레이 합성을 건너뛴다).
 *
 * @napi-rs/canvas 네이티브 바이너리가 이 플랫폼에서 안 뜨면(overlayCanvasAvailable=false)
 * 크기 단언은 건너뛴다 — 그 경우 렌더는 null 을 반환하고 index.ts 가 ASS 로 폴백한다.
 */

/** PNG IHDR 에서 width/height 를 읽는다(8바이트 시그니처 + 4길이 + 4"IHDR" 다음 8바이트). */
function pngDims(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("overlay-canvas — 정적 텍스트 레이어 PNG", () => {
  it("빈 아이템은 null 을 반환한다", async () => {
    assert.equal(await renderTextLayerPng({ width: 1080, height: 1920, items: [] }), null);
  });

  it("제목+채널 아이템을 1080×1920 투명 PNG 로 렌더한다", async () => {
    if (!(await overlayCanvasAvailable())) {
      // 네이티브 바이너리 미탑재 환경 — 렌더는 null(ASS 폴백). 크기 단언 스킵.
      assert.equal(
        await renderTextLayerPng({ width: 1080, height: 1920, items: sampleItems() }),
        null,
      );
      return;
    }
    const buf = await renderTextLayerPng({ width: 1080, height: 1920, items: sampleItems() });
    assert.ok(buf && buf.length > 0, "PNG 버퍼가 비어있다");
    assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG 시그니처가 아니다");
    const dims = pngDims(buf!);
    assert.equal(dims.width, 1080, "PNG 폭이 캔버스 폭과 다르다");
    assert.equal(dims.height, 1920, "PNG 높이가 캔버스 높이와 다르다");
  });
});

describe("overlay-canvas — 폰트 패밀리 레지스트리(글꼴 변환)", () => {
  it("최소 두 패밀리(pretendard·gmarket)를 등록하고 각 파일을 가리킨다", () => {
    const ids = FONT_FAMILIES.map((f) => f.id);
    assert.ok(ids.includes("pretendard"), "기본 패밀리 pretendard 가 없다");
    assert.ok(ids.includes("gmarket"), "gmarket 패밀리가 없다 — 글꼴 변환할 대상이 없다");
    assert.equal(FONT_FAMILIES[0].id, "pretendard", "첫 항목(기본 폴백)은 pretendard 여야 한다(하위호환)");
    // 각 패밀리는 최소 1개 웨이트 파일 매핑을 갖는다.
    for (const fam of FONT_FAMILIES) {
      const weights = Object.keys(fam.weights).map(Number);
      assert.ok(weights.length >= 1, `${fam.id} 패밀리에 웨이트 매핑이 없다`);
      for (const w of weights) {
        assert.match(fam.weights[w].file, /\.(otf|ttf)$/i, `${fam.id}:${w} 파일 확장자가 폰트가 아니다`);
        assert.ok(fam.weights[w].family.length > 0, `${fam.id}:${w} canvas family 문자열이 비었다`);
      }
    }
    const gmarket = FONT_FAMILIES.find((f) => f.id === "gmarket")!;
    assert.ok(
      Object.values(gmarket.weights).some((v) => /GmarketSans/i.test(v.file)),
      "gmarket 패밀리가 GmarketSans 파일을 안 가리킨다",
    );
  });

  it("디스플레이 패밀리 7종(검은고딕·도현·주아·고딕A1·페이퍼로지·강원교육모두·레코체)이 등록되고 파일이 실제로 존재한다", () => {
    // 픽커에 나오려면 서버 레지스트리에 있어야 하고, canvas 가 등록하려면 파일이 FONT_DIRS 에
    // 실재해야 한다. id 존재 + 웨이트 파일 디스크 존재를 함께 고정한다(선언만 하고 파일이 없으면
    // 렌더가 Noto 로 조용히 폴백해 결과물이 열화된다).
    const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const FONT_DIRS = [
      path.resolve(HERE, "../../../assets/fonts"),
      path.resolve(HERE, "../../../assets/invoice-fonts"),
    ];
    const onDisk = (file: string) => FONT_DIRS.some((d) => fs.existsSync(path.join(d, file)));

    for (const id of ["blackhansans", "dohyeon", "jua", "gothica1", "paperlogy", "gangwonedumodu", "recipekorea"]) {
      const fam = FONT_FAMILIES.find((f) => f.id === id);
      assert.ok(fam, `새 패밀리 ${id} 가 레지스트리에 없다 — 픽커에 안 나온다`);
      const weights = Object.keys(fam!.weights).map(Number);
      assert.ok(weights.length >= 1, `${id} 패밀리에 웨이트 매핑이 없다`);
      for (const w of weights) {
        assert.ok(onDisk(fam!.weights[w].file), `${id}:${w} 폰트 파일(${fam!.weights[w].file})이 FONT_DIRS 에 없다`);
      }
    }
    // 픽커는 총 9종(기본 프리텐다드 + 지마켓 + 디스플레이 7종)이어야 한다.
    assert.equal(FONT_FAMILIES.length, 9, `패밀리 수가 9가 아니다(현재 ${FONT_FAMILIES.length}) — 픽커 항목 수 확인`);
  });
});

describe("overlay-canvas — 글꼴·외곽선이 렌더 경로로 흐른다", () => {
  it("font(패밀리 id)+stroke 를 준 아이템도 유효한 PNG 로 렌더된다", async () => {
    const items: OverlayTextItem[] = [
      {
        text: "임팩트 예능 훅",
        x: 540, y: 300, align: "center", baseline: "top",
        fontPx: 64, weight: 800, font: "gmarket", color: "#FFD400", opacity: 1,
        stroke: { color: "#000000", width: 8 },
        shadow: { offsetY: 4, blur: 12, color: "rgba(0,0,0,0.5)" },
      },
    ];
    const buf = await renderTextLayerPng({ width: 1080, height: 1920, items });
    if (!(await overlayCanvasAvailable())) {
      assert.equal(buf, null, "네이티브 바이너리 미탑재 — 렌더는 null(ASS 폴백)");
      return;
    }
    assert.ok(buf && buf.length > 0, "글꼴+외곽선 아이템 PNG 버퍼가 비었다");
    assert.equal(buf!.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG 시그니처가 아니다");
  });

  it("미등록 글꼴 id 는 크래시 없이 기본 패밀리로 폴백한다", async () => {
    const items: OverlayTextItem[] = [
      { text: "폴백", x: 540, y: 300, align: "center", baseline: "top", fontPx: 48, weight: 800, font: "does-not-exist", color: "#FFFFFF" },
    ];
    const buf = await renderTextLayerPng({ width: 1080, height: 1920, items });
    if (!(await overlayCanvasAvailable())) {
      assert.equal(buf, null);
      return;
    }
    assert.ok(buf && buf.length > 0, "미등록 글꼴 id 에서 렌더가 실패했다(폴백 미동작)");
  });
});

function sampleItems(): OverlayTextItem[] {
  return [
    {
      text: "충격적인 반전 결말",
      x: 540, y: 211, align: "center", baseline: "top",
      fontPx: 60, weight: 800, color: "#FFFFFF", opacity: 1,
      shadow: { offsetY: 4, blur: 12, color: "rgba(0,0,0,0.5)" },
    },
    {
      text: "STEP-D 채널",
      x: 460, y: 1690, align: "left", baseline: "top",
      fontPx: 28, weight: 700, color: "#FFFFFF", opacity: 1,
      shadow: { offsetY: 2, blur: 6, color: "rgba(0,0,0,0.6)" },
    },
  ];
}

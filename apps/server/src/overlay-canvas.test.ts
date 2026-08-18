import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTextLayerPng, overlayCanvasAvailable, type OverlayTextItem } from "./overlay-canvas.ts";

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

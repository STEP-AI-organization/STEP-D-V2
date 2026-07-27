"""Phase 3: Thumbnail Compositor — 생성된 레이어들을 합성해 최종 썸네일 출력.

입력: {layer_role: LayerResult} dict (generator 출력)
출력: 최종 합성 이미지 (16:9, 9:16 동시 생성 가능) + 메타데이터
"""

from __future__ import annotations

import pathlib
from typing import Any

from PIL import Image

from .canvas import Document, Layer, LayerRole, LayerTransform, ASPECT_SIZE, LAYER_ORDER
from .contrast import ensure_min_contrast, sample_bg_color


class ThumbnailCompositor:
    """레이어 합성 + 대비 보정 + 최종 렌더."""

    def __init__(self, aspect: str = "16:9"):
        self.aspect = aspect
        self.size = ASPECT_SIZE[aspect]
        self.cw, self.ch = self.size

    def composite_layers(self, layers: dict[str, Any], fix_caption_contrast: bool = True) -> Image.Image:
        """LayerResult dict → Document로 합성 → RGB 이미지 반환."""
        doc = Document(aspect=self.aspect)

        # 레이어를 Document에 세팅
        for role in LAYER_ORDER:
            if role not in layers:
                continue
            lr = layers[role]
            if lr.image is None:
                continue

            # Layer 객체 생성
            layer = Layer(
                role=role,
                source=lr.image,
                transform=lr.transform,
                blend=lr.blend,
                mask=lr.mask,
                visible=True,
                meta=lr.meta or {},
            )
            doc.layers[role] = layer

        # Caption 대비 보정 (배경이 합성된 상태에서 샘플링해야 정확)
        if fix_caption_contrast and "caption" in layers and "background" in layers:
            self._fix_caption_contrast(doc, layers["caption"])

        # 최종 합성
        return doc.composite()

    def _fix_caption_contrast(self, doc: Document, caption_lr: Any) -> None:
        """캡션 레이어의 텍스트/아웃라인 색을 배경 대비에 맞게 보정."""
        caption_layer = doc.layers["caption"]
        if caption_layer.source is None:
            return

        # 현재까지 합성된 배경 (background + backfx + person + personfx) 상태에서 샘플링
        # caption 레이어는 잠시 숨김
        caption_layer.visible = False
        bg_composite = doc.composite()  # RGB
        caption_layer.visible = True

        # 캡션 bbox 영역에서 배경 색 샘플링
        caption_meta = caption_lr.meta
        caption_bbox = caption_meta.get("caption_bbox")
        if not caption_bbox:
            return

        pad = caption_meta.get("outline_w", 8) + 6
        cx1, cy1, cx2, cy2 = caption_bbox
        sample_bbox = (cx1 - pad, cy1 - pad, cx2 + pad, cy2 + pad)

        bg_rgb = sample_bg_color(bg_composite, sample_bbox)

        text_color = caption_meta.get("text_color", "#ffffff")
        outline_color = caption_meta.get("outline_color", "#000000")
        outline_w = caption_meta.get("outline_w", 8)

        text_color_f, outline_color_f, outline_w_f, adjusted = ensure_min_contrast(
            text_color, outline_color, bg_rgb, min_contrast=4.5
        )

        if adjusted:
            # 캡션 레이어 다시 렌더링
            self._re_render_caption(caption_layer, caption_meta, text_color_f, outline_color_f, outline_w_f)
            caption_meta["text_color"] = text_color_f
            caption_meta["outline_color"] = outline_color_f
            caption_meta["outline_w"] = outline_w_f
            caption_meta["was_adjusted"] = True

    def _re_render_caption(self, caption_layer: Layer, meta: dict,
                           text_color: str, outline_color: str, outline_w: int) -> None:
        """캡션 레이어 재렌더링 (새 색상/아웃라인 적용)."""
        from PIL import ImageDraw, ImageFont

        FONT_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"
        FONT_PRESETS = {
            "variety": "NotoSansKR-Black.otf",
            "drama": "NotoSerifKR-Black.otf",
            "news": "Pretendard-ExtraBold.otf",
            "documentary": "Pretendard-Bold.otf",
            "_default": "Pretendard-Black.otf",
        }

        wrapped = meta.get("wrapped", meta.get("text", ""))
        font_role = meta.get("font_role", "variety")
        size_px = meta.get("size_px", 120)

        font_file = FONT_PRESETS.get(font_role, FONT_PRESETS["_default"])
        font_path = FONT_ROOT / font_file

        if not font_path.exists():
            return

        font = ImageFont.truetype(str(font_path), size_px)
        lines = wrapped.split("\n")
        line_h = int(size_px * 1.15)

        # 기존 bbox에서 위치 추출
        caption_bbox = meta.get("caption_bbox", [0, 0, self.cw, self.ch])
        cx = caption_bbox[0] + outline_w
        cy = caption_bbox[1] + outline_w

        # 새로 렌더링
        new_img = Image.new("RGBA", self.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(new_img)
        for i, ln in enumerate(lines):
            self._draw_text_with_outline(draw, (cx, cy + i * line_h), ln, font,
                                         fill=text_color, outline=outline_color, outline_w=outline_w)

        caption_layer.source = new_img

    def _draw_text_with_outline(self, draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str,
                                 font: ImageFont.FreeTypeFont, fill: str, outline: str, outline_w: int) -> None:
        from PIL import ImageDraw
        x, y = xy
        for dx in range(-outline_w, outline_w + 1):
            for dy in range(-outline_w, outline_w + 1):
                if dx == 0 and dy == 0:
                    continue
                draw.text((x + dx, y + dy), text, font=font, fill=outline)
        draw.text((x, y), text, font=font, fill=fill)

    def render_both_aspects(self, layers: dict[str, Any],
                            out_dir: pathlib.Path,
                            variant_id: str = "v1") -> dict[str, str]:
        """Retired: one layer set is valid only for the aspect it was generated for.

        Call ``generate_all_layers(..., aspect)`` followed by ``compose_thumbnail``
        per aspect.  Keeping the former implementation silently reused 16:9
        transforms for 9:16 and emitted a visually invalid portrait asset.
        """
        raise RuntimeError(
            "render_both_aspects is unsupported; regenerate layers for each aspect before composition"
        )


def compose_thumbnail(layers: dict[str, Any],
                      out_dir: pathlib.Path,
                      variant_id: str = "v1",
                      aspects: list[str] = ("16:9", "9:16")) -> dict[str, Any]:
    """편의 함수: 합성 → 저장 → 메타 반환."""
    results = {}
    all_paths = {}

    for aspect in aspects:
        compositor = ThumbnailCompositor(aspect)
        img = compositor.composite_layers(layers)

        out_dir.mkdir(parents=True, exist_ok=True)
        aspect_str = aspect.replace(":", "x")
        path = out_dir / f"{variant_id}_{aspect_str}.png"
        img.save(path, format="PNG", optimize=True)
        all_paths[aspect] = str(path)

    # 메타데이터 구성
    meta = {
        "variant_id": variant_id,
        "aspects": all_paths,
        "layers_used": list(layers.keys()),
        "size_by_aspect": {k: ASPECT_SIZE[k] for k in aspects},
    }

    # plan.json 옆에 meta 저장
    (out_dir / f"{variant_id}_meta.json").write_text(
        __import__("json").dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return meta


if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 3:
        print("Usage: python -m core.thumbnail.compositor <layers_dir> <variant_id>")
        sys.exit(1)
    # 테스트용: generator 출력 pickle/json 로드 후 합성
    print("Compositor module - use compose_thumbnail() function")
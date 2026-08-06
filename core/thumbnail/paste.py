"""결정론 합성 — 얼굴을 생성하지 않고 원본 픽셀 그대로 붙인다.

사용자 지시 (2026-08-06): "얼굴은 생성하지 말고 그대로 사용하도록 해주라,
얼굴이 너무 변형됨."

compose.py 는 생성 모델에게 인물 배치까지 맡긴다 — 모델이 얼굴을 다시 그리므로
아이덴티티가 흔들린다. 여기서는 모델을 아예 쓰지 않는다:

    배경 프레임 → 캔버스 맞춤 + backgroundStyle 적용
    인물 crop  → 배경 제거(rembg/remove.bg) → 템플릿 슬롯 bbox 에 그대로 붙임
    제목 영역  → 템플릿에서 색을 떠와 사각형만 그림 (글자는 caption_overlay)

얼굴 픽셀은 리샘플링(축소/확대) 외에 어떤 변형도 거치지 않는다.
"""
from __future__ import annotations

import pathlib
from typing import Any, Optional

CANVAS = (1536, 1024)   # 16:9


def _fit_cover(im, size: tuple[int, int]):
    """가로세로비 유지하며 캔버스를 덮도록 확대 후 중앙 크롭."""
    from PIL import Image

    tw, th = size
    w, h = im.size
    scale = max(tw / w, th / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    im = im.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - tw) // 2, (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))


def style_background(im, style: Optional[dict[str, Any]] = None):
    """backgroundStyle 적용. 인물보다 어둡고 덜 선명하게 — 시선을 인물로 보낸다."""
    from PIL import Image, ImageEnhance, ImageFilter

    style = style or {}
    blur = float(style.get("blur") or 0)
    if blur > 0:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    bright = float(style.get("brightness") or 0)
    if bright:
        im = ImageEnhance.Brightness(im).enhance(1.0 + bright / 100.0)
    sat = style.get("saturation")
    if sat is not None:
        im = ImageEnhance.Color(im).enhance(float(sat))
    vig = float(style.get("vignette") or 0)
    if vig > 0:
        w, h = im.size
        mask = Image.new("L", (w, h), 0)
        # 중앙에서 멀어질수록 어둡게 — 타원 그라디언트를 단계로 근사
        from PIL import ImageDraw
        steps = 24
        d = ImageDraw.Draw(mask)
        for i in range(steps):
            f = i / steps
            box = (int(w * 0.5 * f * 0.9), int(h * 0.5 * f * 0.9),
                   int(w - w * 0.5 * f * 0.9), int(h - h * 0.5 * f * 0.9))
            d.ellipse(box, fill=int(255 * (1 - f)))
        dark = Image.new("RGB", (w, h), (0, 0, 0))
        im = Image.composite(im, Image.blend(im, dark, vig), mask)
    return im


def _crop_to_content(rgba):
    bbox = rgba.getbbox()
    return rgba.crop(bbox) if bbox else rgba


def cutout(path: pathlib.Path):
    """인물 누끼. remove.bg 우선 · 실패 시 로컬 rembg (person_compositor 재사용)."""
    from core.thumbnail.person_compositor import cutout_person

    return _crop_to_content(cutout_person(path).convert("RGBA"))


def paste_person(canvas, person_rgba, bbox: list[float], anchor: str = "bottom"):
    """정규화 bbox 에 인물을 붙인다.

    슬롯 높이에 맞춰 비율 유지로 축소하고, 가로가 넘치면 가로 기준으로 다시 맞춘다.
    잘라내지 않는다 — 얼굴이 잘리는 것이 어긋난 크기보다 나쁘다.
    """
    from PIL import Image

    cw, ch = canvas.size
    x, y, w, h = bbox
    bx, by = int(x * cw), int(y * ch)
    bw, bh = int(w * cw), int(h * ch)

    pw, ph = person_rgba.size
    scale = bh / ph
    if pw * scale > bw:
        scale = bw / pw
    nw, nh = max(1, int(pw * scale)), max(1, int(ph * scale))
    person = person_rgba.resize((nw, nh), Image.LANCZOS)

    px = bx + (bw - nw) // 2
    py = by + (bh - nh) if anchor == "bottom" else by + (bh - nh) // 2
    canvas.paste(person, (px, py), person)
    return canvas


def draw_text_zones(canvas, template: dict[str, Any], template_image: Optional[pathlib.Path]):
    """제목 영역을 템플릿과 같은 색의 사각형으로 그린다. 글자는 넣지 않는다."""
    from PIL import Image, ImageDraw

    colors: dict[str, tuple[int, int, int]] = {}
    if template_image and pathlib.Path(template_image).exists():
        tpl = Image.open(template_image).convert("RGB")
        tw, th = tpl.size
        import numpy as np
        arr = np.asarray(tpl)
        for slot in template.get("textSlots") or []:
            x, y, w, h = slot["bbox"]
            # 중앙 픽셀은 '제목 1' 라벨 글자에 맞을 수 있다 (검게 나온다).
            # 슬롯 영역의 최빈색을 쓴다 — 글자보다 배경이 항상 넓다.
            region = arr[int(y * th):int((y + h) * th), int(x * tw):int((x + w) * tw)]
            flat = region.reshape(-1, region.shape[-1])
            vals, counts = np.unique(flat, axis=0, return_counts=True)
            colors[slot["id"]] = tuple(int(v) for v in vals[counts.argmax()])

    cw, ch = canvas.size
    d = ImageDraw.Draw(canvas)
    for slot in template.get("textSlots") or []:
        x, y, w, h = slot["bbox"]
        box = (int(x * cw), int(y * ch), int((x + w) * cw), int((y + h) * ch))
        d.rectangle(box, fill=colors.get(slot["id"], (255, 255, 255)))
    return canvas


def build(
    template: dict[str, Any],
    background_path: pathlib.Path,
    person_paths: list[pathlib.Path],
    template_image: Optional[pathlib.Path] = None,
    canvas_size: tuple[int, int] = CANVAS,
):
    """템플릿 좌표대로 결정론 합성. 생성 모델을 쓰지 않으므로 얼굴이 변형되지 않는다."""
    from PIL import Image

    bg = Image.open(background_path).convert("RGB")
    canvas = style_background(_fit_cover(bg, canvas_size),
                             template.get("backgroundStyle"))
    canvas = canvas.convert("RGBA")

    slots = sorted(template.get("personSlots") or [],
                   key=lambda s: s.get("zIndex", 0))
    for slot, ppath in zip(slots, person_paths):
        person = cutout(pathlib.Path(ppath))
        canvas = paste_person(canvas, person, slot["bbox"])

    canvas = draw_text_zones(canvas, template, template_image)
    return canvas.convert("RGB")

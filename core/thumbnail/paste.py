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


# 누끼 모델. 2026-08-06 실측 (상반신 crop 1장, 투명 픽셀 비율 = 배경이 빠진 정도):
#   u2net_human_seg   0.427   3.2s   ← 채택 (인물 전용 · 가장 빠름)
#   birefnet-general  0.440  43.8s
#   birefnet-portrait 0.420  29.5s   (기존 person_compositor 기본값)
#   isnet-general-use 0.292   2.7s
#   remove.bg API     0.257   (기존 1순위 — 상반신 crop 에서 배경을 가장 많이 남김)
# remove.bg 를 1순위로 쓰던 person_compositor.cutout_person 은 여기서 쓰지 않는다.
_CUTOUT_MODEL = "u2net_human_seg"
_SESSION = None


def cutout(path: pathlib.Path):
    """인물 누끼. 로컬 rembg 인물 세그 모델 고정 — 원본 픽셀은 건드리지 않는다."""
    import io as _io
    import os

    from PIL import Image
    from rembg import new_session, remove

    global _SESSION
    model = os.environ.get("THUMB_CUTOUT_MODEL") or _CUTOUT_MODEL
    if _SESSION is None or getattr(_SESSION, "model_name", None) != model:
        _SESSION = new_session(model)
        _SESSION.model_name = model
    out = remove(pathlib.Path(path).read_bytes(), session=_SESSION)
    rgba = Image.open(_io.BytesIO(out)).convert("RGBA")
    rgba = keep_main_subject(rgba)
    return _crop_to_content(rgba)


def keep_main_subject(rgba, anchor: tuple[float, float] = (0.5, 0.25)):
    """알파에서 대상 인물의 덩어리만 남긴다.

    인물 세그 모델은 **화면 안의 모든 사람**을 전경으로 본다. 예능 프레임에는
    뒤에 앉은 다른 출연자가 늘 같이 잡히므로, 누끼를 떠도 남이 딸려 온다.
    crop 은 대상 얼굴을 중심으로 잘랐으므로 anchor(가로 중앙·위쪽 1/4) 를 품는
    연결 성분만 남기면 대상만 걸러진다.
    """
    try:
        import numpy as np
        from scipy import ndimage
    except ImportError:
        return rgba

    a = np.asarray(rgba.split()[-1])
    mask = a > 32
    if not mask.any():
        return rgba
    lab, n = ndimage.label(mask)
    if n <= 1:
        return rgba

    h, w = mask.shape
    ay, ax = int(h * anchor[1]), int(w * anchor[0])
    target = lab[ay, ax]
    if target == 0:
        # anchor 가 배경에 떨어지면 가장 큰 덩어리를 대상으로 본다
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        target = int(np.argmax(sizes)) + 1

    from PIL import Image as _Image
    new_alpha = np.where(lab == target, a, 0).astype("uint8")
    r, g, b, _ = rgba.split()
    return _Image.merge("RGBA", (r, g, b, _Image.fromarray(new_alpha)))


def _placement(canvas_size, person_size, bbox, anchor="bottom"):
    """슬롯 bbox 안에 비율 유지로 넣었을 때의 (좌표, 크기)."""
    cw, ch = canvas_size
    x, y, w, h = bbox
    bx, by, bw, bh = int(x * cw), int(y * ch), int(w * cw), int(h * ch)
    pw, ph = person_size
    scale = bh / ph
    if pw * scale > bw:
        scale = bw / pw
    nw, nh = max(1, int(pw * scale)), max(1, int(ph * scale))
    px = bx + (bw - nw) // 2
    py = by + (bh - nh) if anchor == "bottom" else by + (bh - nh) // 2
    return (px, py), (nw, nh)


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


def harmonize_color(person_rgba, background, strength: float = 0.18):
    """인물 색온도를 배경 쪽으로 당긴다.

    "붙인 티"의 큰 축이 색온도 불일치다. 인물과 배경이 다른 조명에서 찍혔으면
    아무리 누끼가 깨끗해도 오려 붙인 게 보인다. 채널별 평균을 배경 쪽으로
    strength 만큼 이동시킨다 — 전부 맞추면 인물이 배경에 묻히므로 절반만.
    """
    import numpy as np
    from PIL import Image

    p = np.asarray(person_rgba).astype(np.float32)
    alpha = p[..., 3:4] / 255.0
    if alpha.sum() < 1:
        return person_rgba
    bg = np.asarray(background.convert("RGB")).astype(np.float32)

    for c in range(3):
        pm = float((p[..., c:c + 1] * alpha).sum() / alpha.sum())
        bm = float(bg[..., c].mean())
        p[..., c] = np.clip(p[..., c] + (bm - pm) * strength, 0, 255)
    return Image.fromarray(p.astype("uint8"), "RGBA")


def drop_shadow(canvas, person_rgba, pos: tuple[int, int],
                offset: tuple[int, int] = (14, 18), blur: int = 22,
                opacity: float = 0.42):
    """인물 실루엣을 접지 그림자로 깔아 배경에서 띄운다.

    그림자가 없으면 인물이 배경 '위에 올려진' 스티커로 보인다. 알파 마스크만
    있으면 계산으로 만들 수 있으므로 생성 모델이 필요 없다.
    """
    from PIL import Image, ImageFilter

    alpha = person_rgba.split()[-1]
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    dark = Image.new("RGBA", person_rgba.size, (0, 0, 0, 255))
    dark.putalpha(alpha.point(lambda v: int(v * opacity)))
    shadow.paste(dark, (pos[0] + offset[0], pos[1] + offset[1]), dark)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(canvas, shadow)


def rim_light(person_rgba, side: str = "right", width: int = 3, gain: float = 26.0):
    """인물 윤곽 한쪽에 빛을 얹어 배경과 분리한다 (방송 썸네일 관습)."""
    import numpy as np
    from PIL import Image, ImageFilter

    alpha = person_rgba.split()[-1]
    inner = alpha.filter(ImageFilter.MinFilter(width * 2 + 1))
    edge = np.asarray(alpha).astype(np.float32) - np.asarray(inner).astype(np.float32)
    edge = np.clip(edge, 0, 255) / 255.0

    h, w = edge.shape
    ramp = np.linspace(0, 1, w) if side == "right" else np.linspace(1, 0, w)
    edge = edge * ramp[None, :]

    p = np.asarray(person_rgba).astype(np.float32)
    for c in range(3):
        p[..., c] = np.clip(p[..., c] + edge * gain, 0, 255)
    return Image.fromarray(p.astype("uint8"), "RGBA")


def feather_bottom(person_rgba, ratio: float = 0.12):
    """crop 하단의 직선 절단면을 서서히 사라지게 한다.

    자막을 피해 자르면 몸이 일자로 끊긴다. 그 직선이 남아 있는 한 무엇을 해도
    '오려 붙인 것'으로 읽히므로, 아래쪽 알파를 그라디언트로 떨어뜨린다.
    """
    import numpy as np
    from PIL import Image

    a = np.asarray(person_rgba.split()[-1]).astype(np.float32)
    h = a.shape[0]
    n = max(1, int(h * ratio))
    ramp = np.linspace(1.0, 0.0, n)[:, None]
    a[h - n:] *= ramp
    r, g, b, _ = person_rgba.split()
    return Image.merge("RGBA", (r, g, b, Image.fromarray(a.astype("uint8"))))


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

    from PIL import Image as _Image

    slots = sorted(template.get("personSlots") or [],
                   key=lambda s: s.get("zIndex", 0))
    plate = canvas.copy()
    for slot, ppath in zip(slots, person_paths):
        person = cutout(pathlib.Path(ppath))
        # 붙인 티를 줄이는 세 가지. 전부 알파 마스크만으로 계산한다 —
        # 생성 모델을 쓰지 않으므로 얼굴은 그대로다.
        person = harmonize_color(person, plate)
        side = "right" if (slot.get("facing") == "right") else "left"
        person = rim_light(person, side=side)
        person = feather_bottom(person)

        pos, size = _placement(canvas.size, person.size, slot["bbox"])
        scaled = person.resize(size, _Image.LANCZOS)
        canvas = drop_shadow(canvas, scaled, pos)
        canvas.paste(scaled, pos, scaled)

    canvas = draw_text_zones(canvas, template, template_image)
    return canvas.convert("RGB")

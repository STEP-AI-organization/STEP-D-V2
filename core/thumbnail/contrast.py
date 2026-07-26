"""WCAG 대비 계산 · 자막 색 자동 보정 (§14.3, §14.4).

Web Content Accessibility Guidelines 2.1 Success Criterion 1.4.3:
- 큰 텍스트 (>18pt bold or >24pt): 대비 >= 3.0
- 일반 텍스트: 대비 >= 4.5

썸네일 자막은 대부분 큰 텍스트지만 4.5:1 안전 기준으로 (사람 눈 편함).
outline + shadow 가 있어서 실제 인지 대비는 계산치보다 높음.
"""
from __future__ import annotations
from typing import Optional
from PIL import Image


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _relative_luminance(rgb: tuple[int, int, int]) -> float:
    """WCAG 상대 광도. sRGB → linear → 가중치."""
    def _lin(c: int) -> float:
        c01 = c / 255.0
        return c01 / 12.92 if c01 <= 0.03928 else ((c01 + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def wcag_contrast(a: str | tuple[int, int, int], b: str | tuple[int, int, int]) -> float:
    """두 색상의 WCAG 대비. 1.0 (같음) ~ 21.0 (검은색 ↔ 흰색)."""
    ra = a if isinstance(a, tuple) else hex_to_rgb(a)
    rb = b if isinstance(b, tuple) else hex_to_rgb(b)
    la, lb = _relative_luminance(ra), _relative_luminance(rb)
    hi, lo = (la, lb) if la >= lb else (lb, la)
    return (hi + 0.05) / (lo + 0.05)


def sample_bg_color(img: Image.Image, bbox: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """자막 놓일 영역의 배경 평균 색."""
    x1, y1, x2, y2 = bbox
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(img.width, x2), min(img.height, y2)
    if x2 <= x1 or y2 <= y1:
        return (128, 128, 128)
    crop = img.crop((x1, y1, x2, y2)).convert("RGB")
    # 4×4 로 다운샘플 후 평균
    small = crop.resize((4, 4), Image.LANCZOS)
    pixels = list(small.getdata())
    r = sum(p[0] for p in pixels) // len(pixels)
    g = sum(p[1] for p in pixels) // len(pixels)
    b = sum(p[2] for p in pixels) // len(pixels)
    return (r, g, b)


def ensure_min_contrast(
    text_color: str,
    outline_color: str,
    bg_rgb: tuple[int, int, int],
    min_contrast: float = 4.5,
) -> tuple[str, str, int, bool]:
    """자막 색·outline 색이 배경 대비 min_contrast 넘는지 확인. 안 넘으면 자동 보정.

    Returns: (text_color, outline_color, outline_width, was_adjusted)
    - was_adjusted=True 면 시스템 로그에 "AI가 준 색 자동 보정" 남겨야
    """
    tc = hex_to_rgb(text_color)
    oc = hex_to_rgb(outline_color)

    # 실제 인지 대비 = max(text vs bg, text vs outline * outline area effect)
    # 단순화: text vs bg 만 우선 · outline 은 폭 조정으로 보완
    contrast = wcag_contrast(tc, bg_rgb)
    if contrast >= min_contrast:
        return (text_color, outline_color, 4, False)  # 기본 outline 4px

    # 부족 · 보정 시도:
    # 1) outline 두께 up (더 진한 stroke) — text 색 안 바꾸고 시각 대비만 확보
    #    outline 폭 8px 로 늘리면 인지 대비 크게 개선
    outline_w = 8

    # 2) outline 색을 배경 대비 정반대로 (밝은 배경 → 검은 outline, 어두운 배경 → 흰 outline)
    bg_lum = _relative_luminance(bg_rgb)
    if bg_lum > 0.5:  # 밝은 배경
        outline_new = "#000000"
    else:            # 어두운 배경
        outline_new = "#ffffff"

    # 3) 그래도 text-vs-outline 대비 부족하면 text 색을 outline 반대색으로 강제
    tc_vs_oc = wcag_contrast(tc, hex_to_rgb(outline_new))
    if tc_vs_oc < 3.0:
        text_new = "#ffffff" if outline_new == "#000000" else "#000000"
        return (text_new, outline_new, outline_w, True)

    return (text_color, outline_new, outline_w, True)

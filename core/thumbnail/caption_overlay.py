"""자막 오버레이 · nano banana 결과 이미지 위에 한글 폰트로 정확한 자막 얹기.

사용자 원칙 (2026-07-27):
"글자는 이미지 생성으로 처리하지 말고 위치만 잡아주고 · AI 는 글꼴로 렌더해서 붙이기."

nano banana 는 텍스트 없는 이미지 생성 · 여기서 Pillow 로 자막 렌더.
"""
from __future__ import annotations

import io
import pathlib
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"
DEFAULT_FONT = "BlackHanSans-Regular.ttf"  # 임팩트 톤 기본

# 9 슬롯 좌표 계산용 앵커 (x_frac, y_frac, h_anchor, v_anchor)
POSITION_ANCHORS: dict[str, tuple[float, float, str, str]] = {
    "top-left":       (0.05, 0.05, "left",   "top"),
    "top-center":     (0.50, 0.05, "center", "top"),
    "top-right":      (0.95, 0.05, "right",  "top"),
    "middle-left":    (0.05, 0.50, "left",   "middle"),
    "middle-center":  (0.50, 0.50, "center", "middle"),
    "middle-right":   (0.95, 0.50, "right",  "middle"),
    "bottom-left":    (0.05, 0.95, "left",   "bottom"),
    "bottom-center":  (0.50, 0.95, "center", "bottom"),
    "bottom-right":   (0.95, 0.95, "right",  "bottom"),
}

# 이미지 높이 대비 폰트 크기 비율
SIZE_RATIO = {"S": 0.08, "M": 0.11, "L": 0.14, "XL": 0.18}


def render_caption(
    img_bytes: bytes,
    caption: str,
    position: str = "bottom-left",
    size: str = "L",
    font_name: str = DEFAULT_FONT,
    text_color: tuple[int, int, int] = (255, 255, 255),
    outline_color: tuple[int, int, int] = (0, 0, 0),
) -> bytes:
    """이미지 위에 자막 렌더 → PNG bytes."""
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    W, H = img.size

    font_path = FONT_DIR / font_name
    if not font_path.exists():
        font_path = FONT_DIR / DEFAULT_FONT
    font_size = int(H * SIZE_RATIO.get(size, SIZE_RATIO["L"]))
    font = ImageFont.truetype(str(font_path), font_size)

    # 자막이 너무 길면 자동 줄바꿈 (안전영역 90% 폭 기준)
    lines = _wrap_text(caption, font, max_width=int(W * 0.9))

    line_h = font.getbbox("가")[3] - font.getbbox("가")[1]
    line_gap = int(line_h * 0.35)
    total_h = line_h * len(lines) + line_gap * (len(lines) - 1)

    ax, ay, h_anchor, v_anchor = POSITION_ANCHORS.get(
        position, POSITION_ANCHORS["bottom-left"])
    px = int(W * ax); py = int(H * ay)

    if v_anchor == "top":
        y_start = py
    elif v_anchor == "middle":
        y_start = py - total_h // 2
    else:  # bottom
        y_start = py - total_h

    draw = ImageDraw.Draw(img)
    outline_px = max(2, font_size // 20)

    for i, line in enumerate(lines):
        line_w = draw.textlength(line, font=font)
        if h_anchor == "left":
            x = px
        elif h_anchor == "center":
            x = px - int(line_w // 2)
        else:  # right
            x = px - int(line_w)
        y = y_start + i * (line_h + line_gap)
        # 외곽선
        for dx in range(-outline_px, outline_px + 1):
            for dy in range(-outline_px, outline_px + 1):
                if dx * dx + dy * dy <= outline_px * outline_px:
                    draw.text((x + dx, y + dy), line, font=font, fill=outline_color)
        # 본 텍스트
        draw.text((x, y), line, font=font, fill=text_color)

    out = io.BytesIO()
    img.convert("RGB").save(out, format="PNG", optimize=True)
    return out.getvalue()


def _wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """공백 기준 그리디 랩 · 한글은 어절 단위. 한 어절이 max_width 넘으면 그대로 한 줄."""
    if not text:
        return [""]
    words = text.split()
    if not words:
        return [text]
    dummy = Image.new("RGB", (1, 1))
    d = ImageDraw.Draw(dummy)
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = w if not cur else cur + " " + w
        if d.textlength(trial, font=font) <= max_width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines

"""자막 오버레이 · nano banana 결과 이미지 위에 한글 폰트로 자막 계층 얹기.

사용자 원칙 (2026-07-27):
"글자는 이미지 생성으로 처리하지 말고 위치만 잡아주고 · AI 는 글꼴로 렌더해서 붙이기."

방송사 톤 학습: 4단 자막 계층 (배지·인용·부제·메인) · 각 role 별 폰트·색·배경 다르게.
"""
from __future__ import annotations

import io
import pathlib
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"
DEFAULT_FONT = "BlackHanSans-Regular.ttf"

# 9 슬롯 좌표 앵커 (x_frac, y_frac, h_anchor, v_anchor)
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

# 이미지 높이 대비 폰트 크기 비율 (main 기준 · 다른 role 은 size_boost 로 축소)
# 방송사 절제 톤 · main 은 15~18% H 정도가 적정 (렉카 22%+ 너무 큼)
SIZE_RATIO = {"S": 0.08, "M": 0.11, "L": 0.14, "XL": 0.17}

# role 별 렌더 스타일 (참고 이미지 학습 기반)
ROLE_STYLES: dict[str, dict] = {
    "main": {
        "font": "BlackHanSans-Regular.ttf",
        "text_color": (255, 255, 255),
        "outline_color": (0, 0, 0),
        # 방송사 톤: pill 없이 흰 글씨 + 굵은 검정 외곽선 (참고 이미지 실제 톤)
        "pill_bg": None,
        "pill_padding": (0.3, 0.12),
        "size_boost": 0.9,
    },
    "quote": {
        "font": "GowunBatang-Bold.ttf",
        "text_color": (255, 255, 255),
        "outline_color": (0, 0, 0),
        "pill_bg": None,
        "size_boost": 0.6,
        "quote_wrap": True,
    },
    "badge": {
        "font": "Jua-Regular.ttf",
        "text_color": (255, 255, 255),
        "outline_color": (200, 60, 100),
        "pill_bg": (232, 92, 145),
        "pill_padding": (0.3, 0.12),
        "size_boost": 0.55,
    },
    "subtitle": {
        "font": "Pretendard-Bold.otf",
        "text_color": (200, 200, 200),
        "outline_color": (0, 0, 0),
        "pill_bg": None,
        "size_boost": 0.55,
    },
}


def render_captions(
    img_bytes: bytes,
    captions: list[dict],
) -> bytes:
    """이미지 위에 자막 계층 여러 개 렌더 → PNG bytes.

    captions: list of {text, role, position, size}
    role 별 폰트·색·배경 pill 자동 적용.
    """
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    for cap in captions or []:
        _render_one(img, cap)
    out = io.BytesIO()
    img.convert("RGB").save(out, format="PNG", optimize=True)
    return out.getvalue()


def render_caption(
    img_bytes: bytes,
    caption: str,
    position: str = "bottom-left",
    size: str = "L",
    role: str = "main",
) -> bytes:
    """단일 자막 (하위호환)."""
    return render_captions(img_bytes, [{
        "text": caption, "role": role, "position": position, "size": size,
    }])


def _render_one(img: Image.Image, cap: dict) -> None:
    """캡션 하나 렌더 (in-place · RGBA 이미지 위에).

    cap 좌표 우선순위:
    - xywh: [x, y, w, h] 정규화 박스 (HTML 디자이너 출력) · 이 박스 안에 맞춤
    - position (9슬롯) + size (S/M/L/XL): legacy 앵커
    """
    text = (cap.get("text") or "").strip()
    if not text:
        return
    role = cap.get("role", "main")
    style = ROLE_STYLES.get(role, ROLE_STYLES["main"])
    W, H = img.size
    draw = ImageDraw.Draw(img)

    xywh = cap.get("xywh")
    if xywh and len(xywh) == 4:
        # 신규: xywh 박스 · 폰트 크기는 box 높이의 60% 정도
        bx, by, bw, bh = xywh
        box_w = max(20, int(W * bw)); box_h = max(20, int(H * bh))
        font_size = max(16, int(box_h * 0.55))
        font_path = FONT_DIR / style["font"]
        if not font_path.exists():
            font_path = FONT_DIR / DEFAULT_FONT
        font = ImageFont.truetype(str(font_path), font_size)
        display = text
        if style.get("quote_wrap") and not (display.startswith('"') or display.startswith("“")):
            display = f'"{display}"'
        lines = _wrap_text(display, font, max_width=box_w)
        line_h = font.getbbox("가")[3] - font.getbbox("가")[1]
        line_gap = int(line_h * 0.25)
        total_h = line_h * len(lines) + line_gap * (len(lines) - 1)
        # 박스 하단 정렬 (자막은 통상 아래쪽)
        y_start = int(H * by) + box_h - total_h
        # 좌측 정렬 기본
        px = int(W * bx); h_anchor = "left"
        return _draw_lines(draw, font, lines, px, y_start, line_h, line_gap, style, h_anchor,
                            box_w=box_w)

    # legacy · 9슬롯 앵커
    position = cap.get("position", "bottom-left")
    size = cap.get("size", "L")
    font_path = FONT_DIR / style["font"]
    if not font_path.exists():
        font_path = FONT_DIR / DEFAULT_FONT
    boost = style.get("size_boost", 1.0)
    font_size = max(16, int(H * SIZE_RATIO.get(size, SIZE_RATIO["L"]) * boost))
    font = ImageFont.truetype(str(font_path), font_size)
    display = text
    if style.get("quote_wrap"):
        if not (display.startswith('"') or display.startswith("“")):
            display = f'"{display}"'
    lines = _wrap_text(display, font, max_width=int(W * 0.9))
    line_h = font.getbbox("가")[3] - font.getbbox("가")[1]
    line_gap = int(line_h * 0.3)
    total_h = line_h * len(lines) + line_gap * (len(lines) - 1)
    ax, ay, h_anchor, v_anchor = POSITION_ANCHORS.get(position, POSITION_ANCHORS["bottom-left"])
    px = int(W * ax); py = int(H * ay)
    if v_anchor == "top":
        y_start = py
    elif v_anchor == "middle":
        y_start = py - total_h // 2
    else:
        y_start = py - total_h

    _draw_lines(draw, font, lines, px, y_start, line_h, line_gap, style, h_anchor)


def _draw_lines(draw: ImageDraw.ImageDraw, font: ImageFont.FreeTypeFont,
                lines: list[str], px: int, y_start: int,
                line_h: int, line_gap: int, style: dict, h_anchor: str,
                box_w: int | None = None) -> None:
    outline_color = style["outline_color"]
    text_color = style["text_color"]
    pill_bg = style.get("pill_bg")
    pill_pad = style.get("pill_padding", (0.25, 0.1))
    font_size = font.size
    outline_px = max(2, font_size // 20)

    for i, line in enumerate(lines):
        line_w = int(draw.textlength(line, font=font))
        if h_anchor == "left":
            x = px
        elif h_anchor == "center":
            x = (px + (box_w // 2 if box_w else 0)) - line_w // 2 if box_w else px - line_w // 2
        else:
            x = px - line_w
        y = y_start + i * (line_h + line_gap)

        if pill_bg:
            pad_x = int(font_size * pill_pad[0])
            pad_y = int(font_size * pill_pad[1])
            pill_box = (x - pad_x, y - pad_y, x + line_w + pad_x, y + line_h + pad_y)
            radius = int(font_size * 0.25)
            draw.rounded_rectangle(pill_box, radius=radius, fill=pill_bg)

        px_out = 1 if pill_bg else outline_px
        for dx in range(-px_out, px_out + 1):
            for dy in range(-px_out, px_out + 1):
                if dx * dx + dy * dy <= px_out * px_out:
                    draw.text((x + dx, y + dy), line, font=font, fill=outline_color)
        draw.text((x, y), line, font=font, fill=text_color)


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

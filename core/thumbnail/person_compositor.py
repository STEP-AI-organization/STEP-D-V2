"""castPhoto 를 배경 이미지 위에 합성 · 얼굴 identity 100% 유지.

사용자 원칙 (2026-07-28):
"실제 프로그램인데 사람들 얼굴이 너무 변형되는 이슈"
"인물 누끼 따는거 이제 폰에서도 완벽하게 되는데 · 잘해봐"
"누끼 딸 때는 자막 없는 프레임 해야 함 · 자막이 같이 딸려옴"

접근:
1. castPhoto 는 등록된 스튜디오 포트레이트 (자막 X · 배경 clean)
2. rembg (birefnet-portrait) 으로 배경 세그 · RGBA 컷아웃
3. 지정 position/size 로 배경 이미지 위에 합성 (feather 필요 X · 진짜 세그니까)
"""
from __future__ import annotations

import io
import pathlib
from typing import Optional

from PIL import Image

# rembg lazy import (설치 안 되어 있을 수도)
_SESSION = None
def _get_session():
    global _SESSION
    if _SESSION is None:
        from rembg import new_session
        # birefnet-portrait: 인물 포트레이트 최상위 세그 품질
        _SESSION = new_session("birefnet-portrait")
    return _SESSION


# 9 슬롯 앵커 (caption_overlay 와 동일 좌표계)
POSITION_ANCHORS: dict[str, tuple[float, float, str, str]] = {
    "top-left":       (0.05, 0.05, "left",   "top"),
    "top-center":     (0.50, 0.05, "center", "top"),
    "top-right":      (0.95, 0.05, "right",  "top"),
    "middle-left":    (0.05, 0.50, "left",   "middle"),
    "middle-center":  (0.50, 0.50, "center", "middle"),
    "middle-right":   (0.95, 0.50, "right",  "middle"),
    "bottom-left":    (0.05, 1.00, "left",   "bottom"),
    "bottom-center":  (0.50, 1.00, "center", "bottom"),
    "bottom-right":   (0.95, 1.00, "right",  "bottom"),
}

# 인물 크기 · 배경 이미지 높이 대비 인물 최종 높이 비율
PERSON_SIZE_RATIO = {"S": 0.45, "M": 0.60, "L": 0.75, "XL": 0.95}


def cutout_person(img_path: pathlib.Path) -> Image.Image:
    """rembg 로 배경 제거 · RGBA 반환 (인물만 남기고 alpha)."""
    from rembg import remove
    src_bytes = img_path.read_bytes()
    out_bytes = remove(src_bytes, session=_get_session())
    return Image.open(io.BytesIO(out_bytes)).convert("RGBA")


def _crop_to_content(rgba: Image.Image) -> Image.Image:
    """alpha 채널의 bbox 로 여백 크롭."""
    bbox = rgba.getbbox()
    if bbox:
        return rgba.crop(bbox)
    return rgba


def composite_persons(
    bg_bytes: bytes,
    person_layouts: list[dict],
    cast_photo_paths: dict[str, pathlib.Path],
) -> bytes:
    """배경 이미지 위에 계획된 인물들 합성.

    person_layouts: [{name, position, size}]
    cast_photo_paths: {name: Path} · 매핑되지 않는 이름은 스킵
    """
    bg = Image.open(io.BytesIO(bg_bytes)).convert("RGBA")
    W, H = bg.size

    # z_index 낮은 순 (뒤부터) 렌더 · 없으면 배열 순서
    layouts = sorted(person_layouts or [], key=lambda p: p.get("z_index", 0))

    for pl in layouts:
        name = pl.get("name", "")
        photo = cast_photo_paths.get(name)
        if not photo or not photo.exists():
            continue
        try:
            cutout = cutout_person(photo)
            cutout = _crop_to_content(cutout)
        except Exception as e:
            import sys as _sys
            print(f"[person_compositor] cutout fail · {name} · {str(e)[:120]}", file=_sys.stderr)
            continue
        # 크기 조정 (인물 높이 기준)
        target_h = max(1, int(H * PERSON_SIZE_RATIO.get(pl.get("size", "L"), PERSON_SIZE_RATIO["L"])))
        src_w, src_h = cutout.size
        scale = target_h / src_h
        new_w = max(1, int(src_w * scale))
        cutout = cutout.resize((new_w, target_h), Image.LANCZOS)

        # 앵커 위치
        ax, ay, ha, va = POSITION_ANCHORS.get(
            pl.get("position", "middle-center"), POSITION_ANCHORS["middle-center"])
        px, py = int(W * ax), int(H * ay)
        if ha == "left":   x = px
        elif ha == "center": x = px - new_w // 2
        else:              x = px - new_w
        if va == "top":    y = py
        elif va == "middle": y = py - target_h // 2
        else:              y = py - target_h

        bg.alpha_composite(cutout, (x, y))

    out = io.BytesIO()
    bg.convert("RGB").save(out, format="PNG", optimize=True)
    return out.getvalue()

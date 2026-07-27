"""Gemini 2.5 flash image (nano banana) 로 썸네일 생성 · 극단적 심플.

사용자 실측 (2026-07-27): Gemini 웹에 포스터 이미지 하나 + "이거 바탕으로 유튜브 썸네일"
한 마디만 던져도 완성도 매우 높음. 자료 여러 개 · 강제 프롬프트 넣을수록 결과 나빠짐.

원칙:
- 이미지 하나만 던진다 (프로그램 대표 포스터 > 인물 콜라주 > 원본 프레임)
- 프롬프트 한 두 줄 · 자막 텍스트만 포함
- Gemini가 자막·구도·톤 알아서 · 창의성 제한 X
"""
from __future__ import annotations

import io
import os
import pathlib
from typing import Optional, Sequence

from PIL import Image
from google import genai
from google.genai import types

MODEL = "gemini-2.5-flash-image"
LOCATION = "us-central1"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


def _make_reference_collage(
    cast_photos: Sequence[pathlib.Path],
    frames: Sequence[pathlib.Path],
    size: tuple[int, int] = (1024, 1024),
) -> bytes:
    """castPhotos + 프레임 하나를 콜라주로 합쳐 단일 참고 이미지 만듦.
    Gemini는 여러 이미지 · 프롬프트 홍수보다 · 완성 콜라주 하나에 더 잘 반응.
    """
    W, H = size
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    # 프레임 하나(있으면) 배경으로 흐릿하게
    if frames:
        try:
            bg = Image.open(frames[0]).convert("RGB")
            sw, sh = bg.size
            sc = max(W / sw, H / sh)
            bg = bg.resize((int(sw * sc), int(sh * sc)), Image.LANCZOS)
            x = (bg.width - W) // 2; y = (bg.height - H) // 2
            bg = bg.crop((x, y, x + W, y + H))
            from PIL import ImageFilter
            bg = bg.filter(ImageFilter.GaussianBlur(radius=40))
            canvas.paste(bg, (0, 0))
        except Exception:
            pass
    # castPhoto 나란히 (2~4명)
    if cast_photos:
        n = min(4, len(cast_photos))
        cell_w = W // n
        cell_h = int(H * 0.7)
        for i, p in enumerate(cast_photos[:n]):
            try:
                im = Image.open(p).convert("RGB")
                sw, sh = im.size
                sc = min(cell_w / sw, cell_h / sh)
                im = im.resize((int(sw * sc), int(sh * sc)), Image.LANCZOS)
                x = i * cell_w + (cell_w - im.width) // 2
                y = (H - im.height) // 2
                canvas.paste(im, (x, y))
            except Exception:
                pass
    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def generate_thumbnail(
    caption_text: str,
    cast_photos: Sequence[pathlib.Path],
    frames: Sequence[pathlib.Path],
    program_title: str = "",
    program_section: str = "",
    project: Optional[str] = None,
) -> Optional[bytes]:
    """이미지 하나 + 짧은 프롬프트로 완성 썸네일 생성 (자막 포함)."""
    # 참고 이미지 콜라주 하나
    reference = _make_reference_collage(cast_photos, frames)

    program_hint = ""
    if program_title:
        program_hint = f" 프로그램: {program_title}"
        if program_section:
            program_hint += f" ({program_section})"

    prompt = (
        f"이 이미지를 바탕으로 실제 방송사 유튜브 썸네일을 만들어줘 (16:9 · 가로).\n"
        f"인물들의 얼굴은 그대로 유지.\n"
        f"자막 텍스트: '{caption_text}'\n"
        f"{program_hint}\n"
        f"유튜브 알고리즘이 좋아하는 톤 · 큰 자막 · 임팩트 있게."
    )

    client = _client(project)
    try:
        img_cfg = types.ImageConfig(aspect_ratio="16:9")
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"],
                                          image_config=img_cfg)
    except Exception:
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"])

    parts = [
        types.Part.from_bytes(data=reference, mime_type="image/jpeg"),
        types.Part.from_text(text=prompt),
    ]
    resp = client.models.generate_content(model=MODEL, contents=parts, config=cfg)
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None

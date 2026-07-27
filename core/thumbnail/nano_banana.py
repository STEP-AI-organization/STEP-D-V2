"""Gemini 2.5 flash image (nano banana) 로 썸네일 · 극단 심플.

사용자 원칙 (2026-07-27):
"생성형 AI 에게는 (배경, 배치, 제목) + 대표 프레임 하나만 넘긴다.
 castPhoto·벤치마크·프로그램 정보 등 다른 건 넘기지 마."
"""
from __future__ import annotations

import os
import pathlib
from typing import Optional

from google import genai
from google.genai import types

MODEL = "gemini-2.5-flash-image"
LOCATION = "us-central1"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


def generate_thumbnail(
    background: str,
    layout: str,
    caption_position: str,
    frame: pathlib.Path,
    project: Optional[str] = None,
) -> Optional[bytes]:
    """(배경, 배치) + 대표 프레임 → 자막 없는 이미지 (자막은 시스템이 나중에 오버레이).

    caption_position 은 자막 얹힐 자리를 비워두라고 이미지 AI 에게 알려주는 힌트일 뿐,
    실제 자막 텍스트는 렌더하지 않는다.
    """
    prompt = (
        f"이 프레임을 바탕으로 16:9 유튜브 썸네일 (방송사 톤).\n"
        f"인물 얼굴은 그대로 유지 · 재해석 X.\n\n"
        f"**배경**: {background}\n"
        f"**배치**: {layout}\n\n"
        f"**중요 규칙**:\n"
        f"- 이미지에 **어떤 텍스트도 그리지 마** (자막·로고·워터마크·부제·수식어 다 X)\n"
        f"- **{caption_position}** 위치에 자막이 나중에 얹힐 예정 · 그 공간은 인물·주요 요소 없이 비워둘 것\n"
        f"- 배경/배치 지시대로만 · 텍스트는 절대 그리지 마"
    )

    client = _client(project)
    try:
        img_cfg = types.ImageConfig(aspect_ratio="16:9")
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"],
                                          image_config=img_cfg)
    except Exception:
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"])

    parts = [
        types.Part.from_bytes(data=pathlib.Path(frame).read_bytes(), mime_type="image/jpeg"),
        types.Part.from_text(text=prompt),
    ]
    resp = client.models.generate_content(model=MODEL, contents=parts, config=cfg)
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None

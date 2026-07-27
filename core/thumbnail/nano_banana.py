"""Gemini 2.5 flash image (nano banana) 로 썸네일 · 극단 심플.

사용자 원칙 (2026-07-27):
"생성형 AI 에게는 기획(자막) 과 대표프레임만 넘긴다.
 castPhoto·벤치마크·프로그램 정보 등 다른 건 넘기지 마."

이유:
- 프레임 하나에 인물+배경 이미 다 있음
- 자료 여러 개 넘기면 Gemini 가 조합하려다 얼굴·구도 어긋남
- 프레임 + 자막 = 심플 · 완성도 높음
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
    caption_text: str,
    frame: pathlib.Path,
    project: Optional[str] = None,
) -> Optional[bytes]:
    """대표 프레임 하나 + 자막 → 완성 썸네일."""
    prompt = (
        f"이 프레임을 바탕으로 실제 방송사 유튜브 썸네일 (16:9 가로).\n"
        f"인물 얼굴은 그대로 유지 · 재해석 X.\n\n"
        f"**이미지에 넣을 자막 (이 문장 그대로 · 오타 X)**:\n{caption_text}\n\n"
        f"규칙:\n"
        f"- 자막은 위 문장 하나만 큰 폰트로 · 다른 텍스트·로고·부제·워터마크는 그리지 마\n"
        f"- 유튜브 알고리즘이 좋아하는 임팩트 톤"
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

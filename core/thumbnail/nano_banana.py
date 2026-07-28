"""Gemini 2.5 flash image (nano banana) 로 썸네일 · 극단 심플.

사용자 원칙 (2026-07-27):
"생성형 AI 에게는 (배경, 배치, 제목) + 대표 프레임 하나만 넘긴다.
 castPhoto·벤치마크·프로그램 정보 등 다른 건 넘기지 마."
"""
from __future__ import annotations

import mimetypes
import os
import pathlib
from typing import Optional

from google import genai
from google.genai import types

MODEL = "gemini-3-pro-image"     # 최신 최상위 이미지 모델 (2026-07)
LOCATION = "global"               # 3.x 이미지는 global 엔드포인트만


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


def _mime(path: pathlib.Path) -> str:
    m, _ = mimetypes.guess_type(str(path))
    return m or "image/jpeg"


def generate_thumbnail(
    background: str,
    layout: str,
    caption_position: str,
    frame: pathlib.Path,
    cast_photos: Optional[list[pathlib.Path]] = None,
    cast_names: Optional[list[str]] = None,
    mode: str = "hybrid",
    project: Optional[str] = None,
) -> Optional[bytes]:
    """(배경, 배치) + 프레임 → 이미지.

    mode:
      - "hybrid" (기본): **인물 없는 blur 배경** 만 생성 · 인물은 나중에 castPhoto 로 합성
      - "full": 인물 포함 완전 이미지 (이전 방식 · 얼굴 미묘 변형 이슈)

    자막은 시스템이 나중에 Pillow 로 오버레이.
    """
    cast_photos = cast_photos or []
    cast_names = cast_names or []

    if mode == "hybrid":
        # 인물 없는 배경만 · castPhoto 붙일 자리 비워둠
        prompt = (
            f"16:9 유튜브 썸네일 배경 (방송사 톤). 이 프레임의 톤·색·조명 유지.\n\n"
            f"**배경 지시**: {background}\n\n"
            f"**필수 규칙**:\n"
            f"- **인물(사람)을 그리지 마** · 프레임 안 인물 자리는 blur 처리 or 소품·환경으로 채움\n"
            f"- 이미지에 어떤 텍스트도 X (자막·로고·워터마크·부제)\n"
            f"- 원본 프레임 강한 blur (radius 15~25px) 처리 후 톤 조정 느낌\n"
            f"- 인물이 나중에 합성될 예정이므로 · 중앙·인물 자리는 심플하게"
        )
        parts: list = [
            types.Part.from_bytes(data=pathlib.Path(frame).read_bytes(),
                                   mime_type="image/jpeg"),
            types.Part.from_text(text=prompt),
        ]
    else:
        # full mode (이전 배선 유지 · castPhoto 함께 보내기)
        if cast_photos:
            cast_line = " · ".join(cast_names) if cast_names else f"{len(cast_photos)}명"
            cast_directive = (
                f"\n**주인공**: {cast_line}\n"
                f"- 아래 첨부된 인물 사진(들)의 얼굴 identity 100% 유지 · 재해석 X"
            )
        else:
            cast_directive = "\n- 프레임 안 인물 얼굴 그대로 유지 · 재해석 X"
        prompt = (
            f"16:9 유튜브 썸네일 (방송사 톤). 프레임 배경/톤 참고.\n\n"
            f"**배경**: {background}\n**배치**: {layout}{cast_directive}\n\n"
            f"**필수**: 어떤 텍스트도 X · {caption_position} 자리 비움"
        )
        parts = [
            types.Part.from_bytes(data=pathlib.Path(frame).read_bytes(),
                                   mime_type="image/jpeg"),
        ]
        for cp in cast_photos:
            try:
                parts.append(types.Part.from_bytes(data=pathlib.Path(cp).read_bytes(),
                                                    mime_type=_mime(pathlib.Path(cp))))
            except Exception:
                pass
        parts.append(types.Part.from_text(text=prompt))

    client = _client(project)
    try:
        img_cfg = types.ImageConfig(aspect_ratio="16:9")
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"],
                                          image_config=img_cfg)
    except Exception:
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"])

    resp = client.models.generate_content(model=MODEL, contents=parts, config=cfg)
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None

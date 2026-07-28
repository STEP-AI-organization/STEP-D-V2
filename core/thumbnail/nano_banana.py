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
    project: Optional[str] = None,
) -> Optional[bytes]:
    """(배경, 배치) + 프레임 + 계획된 출연자 사진 → 자막 없는 이미지.

    - frame: 배경/톤 참고용 대표 프레임 하나
    - cast_photos: Planner 가 이 variant 에 지목한 인물의 등록 사진들 (0~3장)
    - cast_names: cast_photos 와 순서 매칭되는 이름 배열 (프롬프트에 언급용)
    - caption_position: 자막 얹힐 자리 (그 공간 비워두라는 힌트)

    자막 텍스트는 이 함수가 그리지 않는다. 시스템이 나중에 Pillow 로 오버레이.
    """
    cast_photos = cast_photos or []
    cast_names = cast_names or []

    if cast_photos:
        cast_line = " · ".join(cast_names) if cast_names else f"{len(cast_photos)}명"
        cast_directive = (
            f"\n**주인공**: {cast_line}\n"
            f"- 아래 첨부된 인물 사진(들)이 이 썸네일의 주인공\n"
            f"- **첨부 사진의 얼굴 identity 100% 유지** · 얼굴 재해석·변형 절대 X\n"
            f"- 프레임 안 다른 인물은 참고만 · 주인공 얼굴은 첨부 사진 기준"
        )
    else:
        cast_directive = (
            "\n- 프레임 안 인물 얼굴 그대로 유지 · 재해석 X"
        )

    prompt = (
        f"16:9 유튜브 썸네일 (방송사 톤). 첨부한 프레임은 배경/톤 참고용.\n\n"
        f"**배경**: {background}\n"
        f"**배치**: {layout}"
        f"{cast_directive}\n\n"
        f"**필수 규칙**:\n"
        f"- 이미지에 **어떤 텍스트도 그리지 마** (자막·로고·워터마크·부제 다 X)\n"
        f"- **{caption_position}** 위치는 자막이 나중에 얹힐 자리 · 인물·주요 요소 없이 비워둘 것\n"
        f"- 배경/배치 지시대로만"
    )

    client = _client(project)
    try:
        img_cfg = types.ImageConfig(aspect_ratio="16:9")
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"],
                                          image_config=img_cfg)
    except Exception:
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"])

    parts: list = [
        types.Part.from_bytes(data=pathlib.Path(frame).read_bytes(), mime_type="image/jpeg"),
    ]
    for cp in cast_photos:
        try:
            parts.append(types.Part.from_bytes(data=pathlib.Path(cp).read_bytes(),
                                                mime_type=_mime(pathlib.Path(cp))))
        except Exception:
            pass
    parts.append(types.Part.from_text(text=prompt))

    resp = client.models.generate_content(model=MODEL, contents=parts, config=cfg)
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None

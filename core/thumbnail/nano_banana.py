"""OpenAI gpt-image-2 어댑터 · nano_banana 호환 인터페이스 (2026-07-30 Gemini→OpenAI 전환).

사용자 원칙 (2026-07-27, 유지):
"생성형 AI 에게는 (배경, 배치, 제목) + 대표 프레임 하나만 넘긴다.
 castPhoto·벤치마크·프로그램 정보 등 다른 건 넘기지 마."

이름은 nano_banana 그대로 유지 (호출부 pipeline_compose 배선 호환) · 내부는 OpenAI SDK.
"""
from __future__ import annotations

import pathlib
from typing import Optional

from core.common.models import IMAGE_FLASH as MODEL
from core.common.openai_client import edit as openai_edit


def generate_thumbnail(
    background: str,
    layout: str,
    caption_position: str,
    frame: pathlib.Path,
    cast_photos: Optional[list[pathlib.Path]] = None,
    cast_names: Optional[list[str]] = None,
    mode: str = "hybrid",
    project: Optional[str] = None,  # 호환 유지 · OpenAI 에서는 무시
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
        prompt = (
            f"16:9 유튜브 썸네일 배경 (방송사 톤). 이 프레임의 톤·색·조명 유지.\n\n"
            f"**배경 지시**: {background}\n\n"
            f"**필수 규칙**:\n"
            f"- **인물(사람)을 그리지 마** · 프레임 안 인물 자리는 blur 처리 or 소품·환경으로 채움\n"
            f"- 이미지에 어떤 텍스트도 X (자막·로고·워터마크·부제)\n"
            f"- 원본 프레임 강한 blur (radius 15~25px) 처리 후 톤 조정 느낌\n"
            f"- 인물이 나중에 합성될 예정이므로 · 중앙·인물 자리는 심플하게"
        )
        images: list[bytes] = [pathlib.Path(frame).read_bytes()]
    else:
        # full mode (castPhoto 함께 보내기)
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
        images = [pathlib.Path(frame).read_bytes()]
        for cp in cast_photos:
            try:
                images.append(pathlib.Path(cp).read_bytes())
            except Exception:
                pass

    return openai_edit(images=images, prompt=prompt, model=MODEL, size="1536x1024")

"""Gemini 2.5 flash image 어댑터 (배경 · 인물 이미지 생성).

- generate_background: Layer 0 배경 (사람 없음 · 텍스트 없음 · §13)
- generate_person_thumbnail: Layer 2 인물 (castPhoto reference · 얼굴 identity 유지 강제)

**얼굴 identity 강제 원칙**:
- 반드시 castPhoto 를 참고 이미지로 첨부 (텍스트 프롬프트만으로 사람 그리지 마)
- 프롬프트에 "얼굴 정확히 유지 · 얼굴 바꾸지 마" 명시적 · 여러 번
- 응답 후 face detect 로 검증 (Phase 2) — 신뢰도 낮으면 재생성 or 원본 castPhoto rembg 로 폴백
"""
from __future__ import annotations

import io
import os
import pathlib
from typing import Optional

from PIL import Image
from google import genai
from google.genai import types

IMAGE_MODEL = "gemini-2.5-flash-image"
IMAGE_LOCATION = "us-central1"   # asia-northeast3 에 이미지 모델 없음 (실측 완료)


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=IMAGE_LOCATION)


def _extract_image(resp) -> Optional[bytes]:
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None


BACKGROUND_SYSTEM = """목표: 아래 참고 이미지들의 실제 장소·인테리어·조명을 그대로 유지한 배경 (16:9).

**절대 규칙**:
1. 참고 이미지의 **인테리어·구도·시대·조명** 그대로. 다른 장소로 바꾸지 마.
   (예: 참고가 카페 실내면 → 도시 야경으로 바꾸지 마. 참고가 밝은 하우스면 → 어두운 스튜디오로 바꾸지 마.)
2. 사람 얼굴·전신 그리지 마 (사람 없는 빈 공간만)
3. 텍스트·자막·글자 그리지 마
4. 시간대(낮/밤)·색 온도 참고 이미지와 일치
5. 새로운 오브젝트·풍경·조명 임의 추가 금지 (참고에 없는 요소 X)

허용:
- 참고 프레임에서 인물만 제거 · 빈 공간 그대로 유지 (인페인팅 스타일)
- 살짝 blur/depth-of-field 강조
- 색 톤 채도 미세 조정
"""

def generate_background(
    prompt: str,
    style: str = "cinematic",
    palette_hint: Optional[list[str]] = None,
    context_frames: Optional[list[bytes]] = None,   # 원본 프레임 (인물 shot + 배경 shot)
    synopsis: Optional[str] = None,
    program_info: Optional[str] = None,
) -> Optional[bytes]:
    """§13 default: 프레임 2장 + 시놉시스만 · 인물 사진 안 첨부."""
    parts: list = []
    for fb in (context_frames or []):
        parts.append(types.Part.from_bytes(data=fb, mime_type="image/jpeg"))
    body = BACKGROUND_SYSTEM
    if program_info:
        body += f"\n[프로그램] {program_info}"
    if synopsis:
        body += f"\n[시놉시스] {synopsis[:300]}"
    body += f"\n\n[요청]\n{prompt}\nstyle: {style}"
    if palette_hint:
        body += f"\npalette hint: {', '.join(palette_hint)}"
    parts.append(body)

    client = _client()
    r = client.models.generate_content(
        model=IMAGE_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )
    return _extract_image(r)


PERSON_SYSTEM = """목표: 참고 사진의 인물을 그대로 사용해서 썸네일용 인물 이미지 생성.

**절대 규칙 · 어기지 마**:
1. 얼굴은 참고 사진과 100% 같은 사람. 다른 사람으로 바꾸지 마. 얼굴 특징 변경 금지.
2. 헤어 스타일·안경·이목구비·피부 톤 참고 사진 그대로.
3. 배경 없이 (투명 or 단색) — 인물만.
4. 텍스트·자막 그리지 마.
5. 이미지 안에 인물은 한 명만.

허용되는 조정:
- 상반신 or 흉상 크롭
- 포즈 · 각도 · 표정 (자연스러운 미소·놀람·정색 중 선택)
- 조명 톤 · 그림자
- 옷 색은 참고 사진 유지 (옷 자체를 바꾸지는 마)
"""

def generate_person_thumbnail(
    cast_photo: bytes,                    # castPhotos/<name>.jpg 원본 bytes
    style_prompt: str = "정면 · 자연스러운 미소 · 시네마틱 조명 · 상반신 · 배경 투명",
    program_info: Optional[str] = None,
) -> Optional[bytes]:
    """cast_photo 를 reference 로 · 썸네일용 인물 이미지 재생성 · 얼굴 identity 유지 강제."""
    body = PERSON_SYSTEM
    if program_info:
        body += f"\n\n[프로그램 톤] {program_info}"
    body += (
        f"\n\n[요청]\n{style_prompt}\n\n"
        "다시 강조: 얼굴은 위 참고 사진의 사람과 정확히 같아야 한다. "
        "얼굴 특징을 바꾸면 안 된다. 다른 얼굴로 대체하지 마라."
    )
    parts = [
        types.Part.from_bytes(data=cast_photo, mime_type="image/jpeg"),
        body,
    ]
    client = _client()
    r = client.models.generate_content(
        model=IMAGE_MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )
    return _extract_image(r)

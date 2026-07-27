"""Gemini 2.5 flash image (nano banana) 로 인물+배경 통짜 생성 · 자막은 시스템 Pillow.

하이브리드:
- Nano banana: castPhotos (여러 번 반복 첨부 · identity 각인) + 프레임 (톤) → 인물 배치된 배경 이미지 (자막 X)
- 시스템 Pillow: 그 위에 자막 얹음 (한글 오타 방지)

**얼굴 identity 강제**:
- castPhoto 를 3~4번 반복 첨부 (모델 각인)
- 프롬프트에 "재생성 절대 X · 원본 얼굴 그대로 붙여넣기"
- 여러 인물이면 각 castPhoto 반복
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

BENCHMARK_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-benchmark"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


SYSTEM_PROMPT = """방송사 유튜브 썸네일 이미지 생성 · **가로 16:9 (1280x720)**.

**절대 규칙**:
1. **가로 16:9** (세로형·정사각형 X). 캔버스는 반드시 옆으로 긴 형태.
2. **인물은 캔버스 상단 60퍼센트 영역에만** 배치 (하단 40퍼센트는 완전 비워둠 · 자막 자리).
3. 얼굴 참고 castPhoto 와 최대한 같은 사람 (표정·헤어·의상 유사).
4. **자막·텍스트·글자 절대 그리지 마** (시스템이 나중에 얹음).
5. 벤치마크 (JTBC·MBC·Netflix) 톤 참고 · 방송사 예능 스타일.
6. 인물 여러 명이면 각각 왼/중/오른 · 상반신 or 흉상.

**하단 40퍼센트는 무조건 자막 자리** · 인물 발·손·소품 넣지 마.
"""


def generate_image(
    cast_photos: Sequence[pathlib.Path],
    context_frames: Sequence[pathlib.Path],
    shorts_context: dict,
    program_info: dict,
    include_benchmark: bool = True,
    project: Optional[str] = None,
) -> Optional[bytes]:
    """자료 → 인물+배경 통짜 이미지 (자막 X). 시스템 Pillow가 후처리로 자막 얹음."""
    parts: list = []

    # 1) 벤치마크 (각 채널 1장 · 최대 4장)
    if include_benchmark and BENCHMARK_ROOT.exists():
        picks = []
        for ch_dir in sorted(BENCHMARK_ROOT.iterdir()):
            if ch_dir.is_dir():
                jpgs = sorted(ch_dir.glob("*.jpg"))
                if jpgs:
                    picks.append(jpgs[0])
        for p in picks[:4]:
            try:
                parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg"))
            except Exception:
                pass
        if picks:
            parts.append(types.Part.from_text(text=(
                "[위 이미지는 실제 방송사 유튜브 최근 썸네일 · 이 톤·구도·색·인물 크기 참고]"
            )))

    # 2) 원본 프레임 (톤 · 최대 3장)
    for p in context_frames[:3]:
        try:
            parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg"))
        except Exception:
            pass
    if context_frames:
        parts.append(types.Part.from_text(text=(
            f"[위 {min(3,len(context_frames))}장은 이 쇼츠 원본 프레임 · 장면 톤·인테리어 참고]"
        )))

    # 3) castPhotos (**identity 각인 위해 반복 첨부** · 각 인물 3번씩)
    if cast_photos:
        # 첫 pass · 이름과 함께
        names = [p.stem for p in cast_photos[:4]]
        parts.append(types.Part.from_text(text=(
            f"[이 쇼츠 출연 인물: {', '.join(names)} · 아래 사진들이 이 사람들의 실제 얼굴]"
        )))
        for cycle in range(3):  # 3번 반복해서 각인
            for p in cast_photos[:4]:
                try:
                    parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg"))
                except Exception:
                    pass
        parts.append(types.Part.from_text(text=(
            "[위 인물 사진들 · 반복 첨부한 이유 = 얼굴 각인. "
            "생성할 이미지의 인물 얼굴은 반드시 이 얼굴들과 100퍼센트 같아야 함. "
            "재생성 X · 재해석 X · 스티커처럼 붙여넣기.]"
        )))

    # 4) 컨텍스트 · 자막 위치 힌트 (자막 자체는 안 그림)
    ctx_text = (
        f"\n[프로그램] {program_info.get('title','')} ({program_info.get('section','')})\n"
        f"[분위기] {program_info.get('mood','')}\n"
        f"[시놉시스] {(program_info.get('synopsis','') or '')[:250]}\n\n"
        f"[쇼츠 제목] {shorts_context.get('title','')}\n"
        f"[쇼츠 설명] {shorts_context.get('description','')}\n\n"
        "위 자료·주제를 종합해 16:9 유튜브 썸네일. "
        "**자막·텍스트는 절대 그리지 마** (하단 40퍼센트는 자막 자리로 비워둘 것). "
        "인물 컷아웃 여러 개(왼/오른쪽 · 크기 다르게) + 참고 프레임의 배경. 출력은 이미지 하나만."
    )
    parts.append(types.Part.from_text(text=SYSTEM_PROMPT + ctx_text))

    client = _client(project)
    resp = client.models.generate_content(
        model=MODEL,
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )
    for c in resp.candidates or []:
        for p in (c.content.parts or []):
            if getattr(p, "inline_data", None) and p.inline_data.data:
                return p.inline_data.data
    return None

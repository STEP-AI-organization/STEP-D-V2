"""Gemini 2.5 flash image (nano banana) 로 썸네일 통짜 생성.

사용자 방향 전환 (2026-07-27): Layer 세그·합성 접근이 세그 품질 한계로 발전 어려움.
자료(castPhotos + 원본 프레임 + 벤치마크) + 주제(자막 · 톤) 던져서 이미지 생성 모델이
완성된 썸네일 한 장 직접 만들도록.

**얼굴 identity 유지 강제**: castPhotos 를 reference 로 첨부 · 프롬프트에 "다른 얼굴 X".
"""
from __future__ import annotations

import io
import os
import pathlib
from typing import Optional

from PIL import Image
from google import genai
from google.genai import types

MODEL = "gemini-2.5-flash-image"
LOCATION = "us-central1"  # 이미지 모델 asia-northeast3 없음

# 벤치마크 이미지 (JTBC·MBC·Netflix 등) 몇 장 첨부 · 톤 참고
BENCHMARK_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-benchmark"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


SYSTEM_PROMPT = """너는 방송사 유튜브 편집팀의 썸네일 디자이너다.
아래 자료들을 참고해서 **완성된 유튜브 썸네일 이미지 한 장**을 만든다 (16:9, 1280x720).

**반드시 지킬 것**:
1. 얼굴은 참고 castPhoto 사진의 인물과 100퍼센트 같은 사람 · 다른 얼굴로 바꾸지 마.
   (여러 인물이면 여러 castPhoto 다 참고 · 각 인물 얼굴 유지)
2. 자막 텍스트는 아래 지정된 텍스트 그대로 사용 · 자막 위치·크기·색·폰트 자연스럽게.
3. 톤: 첨부한 방송사 벤치마크 썸네일들처럼 · 요즘 유튜브 스타일 (뉴스 앵커 톤 X).
4. 인물 · 자막 · 배경 모두 하나의 완성된 이미지에.
"""


def generate_thumbnail(
    caption_text: str,
    cast_photos: list[pathlib.Path],
    context_frames: list[pathlib.Path],
    shorts_context: dict,
    program_info: dict,
    include_benchmark: bool = True,
    project: Optional[str] = None,
) -> Optional[bytes]:
    """
    자료 + 주제 → 완성된 썸네일 PNG bytes. 실패 시 None.

    caption_text        : 자막 (Planner가 뽑음 · "웹디→한의사 대박")
    cast_photos         : 얼굴 identity 유지할 인물 사진 파일 경로들
    context_frames      : 원본 프레임 (톤·구도 참고) · 최대 3장
    shorts_context      : {title, description, cast_names, ...}
    program_info        : {title, section, mood, synopsis}
    include_benchmark   : JTBC/MBC/Netflix 벤치마크 이미지 첨부 (톤 참고)
    """
    parts: list = []

    # 1) 벤치마크 (톤 참고 · 각 채널 1장씩 최대 4장)
    if include_benchmark and BENCHMARK_ROOT.exists():
        bench_picks: list[pathlib.Path] = []
        for ch_dir in sorted(BENCHMARK_ROOT.iterdir()):
            if not ch_dir.is_dir():
                continue
            jpgs = sorted(ch_dir.glob("*.jpg"))
            if jpgs:
                bench_picks.append(jpgs[0])
        for p in bench_picks[:4]:
            try:
                parts.append(types.Part.from_bytes(
                    data=p.read_bytes(), mime_type="image/jpeg"))
            except Exception:
                pass
        if bench_picks:
            parts.append(types.Part.from_text(text=(
                "[위 이미지들은 실제 방송사 유튜브 (JTBC·MBC·Netflix Korea) 최근 썸네일이다. "
                "이 톤·자막 스타일·구도·색·인물 크기·이모지 사용을 참고해서 만들어라.]"
            )))

    # 2) 원본 프레임 (톤·구도 참고 · 최대 3장)
    for p in context_frames[:3]:
        try:
            parts.append(types.Part.from_bytes(
                data=p.read_bytes(), mime_type="image/jpeg"))
        except Exception:
            pass
    if context_frames:
        parts.append(types.Part.from_text(text=(
            f"[위 {len(context_frames[:3])}장은 이 쇼츠 원본 프레임이다. "
            "장면 톤·조명·인테리어 참고. 필요하면 프레임 자체를 배경으로 써도 됨.]"
        )))

    # 3) castPhotos (인물 identity 유지 참고 · 각 얼굴 다 첨부)
    for p in cast_photos[:4]:
        try:
            parts.append(types.Part.from_bytes(
                data=p.read_bytes(), mime_type="image/jpeg"))
        except Exception:
            pass
    if cast_photos:
        names = [p.stem for p in cast_photos[:4]]
        parts.append(types.Part.from_text(text=(
            f"[위 {len(cast_photos[:4])}장은 이 쇼츠 등장인물 사진이다: {', '.join(names)}. "
            "썸네일에 이 인물들의 얼굴을 그대로 사용 · 다른 얼굴로 바꾸지 마.]"
        )))

    # 4) 컨텍스트 · 주제 · 자막 지시
    ctx_text = (
        f"\n[프로그램] {program_info.get('title','')} ({program_info.get('section','')})\n"
        f"[분위기] {program_info.get('mood','')}\n"
        f"[시놉시스] {(program_info.get('synopsis','') or '')[:250]}\n\n"
        f"[쇼츠 제목] {shorts_context.get('title','')}\n"
        f"[쇼츠 설명] {shorts_context.get('description','')}\n"
        f"[출연자] {', '.join(shorts_context.get('cast_names',[]))}\n\n"
        f"[자막 텍스트 (반드시 이 문장 그대로 이미지에 넣기)] {caption_text}\n\n"
        "위 자료 · 주제 · 자막을 종합해서 16:9 유튜브 썸네일 한 장을 완성. "
        "출력은 이미지 하나만."
    )
    parts.append(types.Part.from_text(text=SYSTEM_PROMPT + ctx_text))

    # 5) 호출
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

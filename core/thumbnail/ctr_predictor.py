"""⑦ CTR 점수 예측 · variant 여러 개 중 Best 자동 선택.

Gemini Vision 에게 여러 썸네일 이미지 + 벤치마크 (실제 잘 나가는 방송사 유튜브 썸네일)
비교시켜서 · 각 variant 예상 CTR (0-100) 점수화. Best 자동 선택.
"""
from __future__ import annotations

import io
import json
import os
import pathlib
from typing import Optional, Sequence

from google import genai
from google.genai import types

from ..models import TEXT as MODEL  # text 모델 · Vision 지원
LOCATION = "asia-northeast3"      # text 는 asia OK
BENCHMARK_ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-benchmark"


def _client(project: Optional[str] = None) -> genai.Client:
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
    return genai.Client(vertexai=True, project=project, location=LOCATION)


SYSTEM = """너는 유튜브 썸네일 CTR 전문가다. 아래 변형 썸네일들을 실제 방송사 유튜브 톤(참고)과
비교해서 각각의 예상 클릭률(CTR)을 평가한다.

평가 기준 (각 0-25점 · 총 100점):
1. 훅(hook): 3초 안에 시선 잡는 힘 (얼굴 크기·표정·자막 임팩트)
2. 명료(clarity): 자막 가독성·구도 정돈도·주제 파악 용이
3. 톤 매칭(tone): 실제 방송사 유튜브 스타일 부합도 (뉴스 앵커 톤 X · 요즘 톤)
4. 완성도(polish): 잘림·왜곡·오타·색 대비 문제 없음

출력 형식 (반드시 JSON · 배열 안 각 variant):
[
  {"variant": "v1", "hook": 22, "clarity": 20, "tone": 23, "polish": 18, "total": 83, "reason": "얼굴 크게·자막 임팩트·완성도 아쉬움"},
  ...
]
"""


def score_variants(
    variant_images: dict[str, bytes],
    project: Optional[str] = None,
) -> list[dict]:
    """
    variant_images: {"v1": png_bytes, "v2": png_bytes, ...}
    반환: [{variant, hook, clarity, tone, polish, total, reason}, ...] · total 내림차순
    """
    if not variant_images:
        return []

    parts: list = []

    # 벤치마크 이미지 3장 (톤 기준)
    if BENCHMARK_ROOT.exists():
        picks: list[pathlib.Path] = []
        for ch_dir in sorted(BENCHMARK_ROOT.iterdir()):
            if ch_dir.is_dir():
                jpgs = sorted(ch_dir.glob("*.jpg"))
                if jpgs:
                    picks.append(jpgs[0])
        for p in picks[:3]:
            try:
                parts.append(types.Part.from_bytes(
                    data=p.read_bytes(), mime_type="image/jpeg"))
            except Exception:
                pass
        if picks:
            parts.append(types.Part.from_text(text=(
                "[위는 실제 방송사 유튜브 썸네일 · CTR 톤 참고 기준]\n"
            )))

    # variant 이미지들
    variant_ids: list[str] = []
    for vid, img_bytes in variant_images.items():
        parts.append(types.Part.from_text(text=f"\n[variant {vid}]"))
        parts.append(types.Part.from_bytes(data=img_bytes, mime_type="image/png"))
        variant_ids.append(vid)

    parts.append(types.Part.from_text(text=(
        f"\n위 {len(variant_ids)}개 variant ({', '.join(variant_ids)})를 각각 평가. "
        "JSON 배열만 · 다른 텍스트 없이."
    )))

    client = _client(project)
    resp = client.models.generate_content(
        model=MODEL,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            temperature=0.3,
        ),
    )
    try:
        scores = json.loads(resp.text)
        if not isinstance(scores, list):
            return []
        scores.sort(key=lambda s: -s.get("total", 0))
        return scores
    except Exception:
        return []


def pick_best(scores: list[dict]) -> Optional[str]:
    """최고 점수 variant id 반환."""
    if not scores:
        return None
    return scores[0].get("variant")

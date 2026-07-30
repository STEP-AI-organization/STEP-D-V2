"""OpenAI client helper · thumbnail 이미지 생성용 (2026-07-30 도입).

Gemini SDK 에서 OpenAI SDK 로 이미지 생성 파이프라인 전환.
- 텍스트 to 이미지: `generate(prompt, size)` → bytes
- 이미지 편집 (얼굴/자막 교체 등): `edit(images, prompt, size)` → bytes

인증: `OPENAI_API_KEY` env var 필수. Cloud Run · pm2 워커 env 에 이미 설정됨.

사용:
    from core.openai_client import generate, edit
    from core.models import IMAGE_FLASH as MODEL
    png_bytes = edit([ref_bytes, cast_bytes], prompt="...", model=MODEL)
"""
from __future__ import annotations

import base64
import io
import os
from typing import Optional, Union

from openai import OpenAI

_CLIENT: OpenAI | None = None


def _client() -> OpenAI:
    global _CLIENT
    if _CLIENT is None:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError(
                "OPENAI_API_KEY env var 없음 · thumbnail 이미지 생성 불가. "
                "apps/server/.env 또는 .env.worker 에 OPENAI_API_KEY=sk-... 추가."
            )
        _CLIENT = OpenAI(api_key=key)
    return _CLIENT


def _decode(resp) -> Optional[bytes]:
    """OpenAI Images 응답에서 첫 이미지 bytes 추출. b64_json 또는 url 지원."""
    if not resp or not getattr(resp, "data", None):
        return None
    d = resp.data[0]
    if getattr(d, "b64_json", None):
        return base64.b64decode(d.b64_json)
    url = getattr(d, "url", None)
    if url:
        import urllib.request
        return urllib.request.urlopen(url, timeout=30).read()
    return None


def generate(
    prompt: str,
    model: str = "gpt-image-2",
    size: str = "1536x1024",  # 16:9 기본 · shorts 는 "1024x1536"
    n: int = 1,
) -> Optional[bytes]:
    """텍스트 → 이미지 (reference 없음)."""
    client = _client()
    resp = client.images.generate(
        model=model, prompt=prompt, size=size, n=n,
    )
    return _decode(resp)


def edit(
    images: list[bytes],
    prompt: str,
    model: str = "gpt-image-2",
    size: str = "1536x1024",
    n: int = 1,
) -> Optional[bytes]:
    """이미지 편집 · 여러 참고 이미지 + 프롬프트 → 새 이미지.
    - reference thumbnail + castPhoto 여러 장 → swap
    - 원본 프레임 + preprocess prompt → cleaned template
    """
    client = _client()
    # OpenAI SDK 는 file-like objects 필요 (BytesIO 로 감싸기)
    files = []
    for i, b in enumerate(images):
        bio = io.BytesIO(b)
        bio.name = f"image_{i}.png"  # SDK 가 name 속성 필요 (MIME 판정)
        files.append(bio)
    resp = client.images.edit(
        model=model,
        image=files if len(files) > 1 else files[0],
        prompt=prompt,
        size=size,
        n=n,
    )
    return _decode(resp)

"""OpenAI client helper · thumbnail 이미지 생성용 (2026-07-30 도입).

Gemini SDK 에서 OpenAI SDK 로 이미지 생성 파이프라인 전환.
- 텍스트 to 이미지: `generate(prompt, size)` → bytes
- 이미지 편집 (얼굴/자막 교체 등): `edit(images, prompt, size)` → bytes
- 텍스트 생성: `generate_text(system, user, model)` → TextResult (2026-09-16 · Luna 번역 실험)

인증: `OPENAI_API_KEY` env var 필수. Cloud Run · pm2 워커 env 에 이미 설정됨.

사용:
    from core.common.openai_client import generate, edit
    from core.common.models import IMAGE_FLASH as MODEL
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


# ── 텍스트 생성 (2026-09-16 · GPT-5.6 Luna 실험 — 번역) ──────────────────────────
#
# Gemini 2.5 은퇴(flash-lite 2027-01-28 종료) 대비로 번역(stt/translate_out.py)만 OpenAI 로
# 돌려 보는 경로다. 응답을 **genai 모양으로 감싸서** 돌려준다 — core 의 모든 LLM 호출은
# `call_with_retry` 로 감싸이고(재시도 + usage 원장), 그 `_record_usage` 가
# `resp.usage_metadata`(genai 필드명)를 읽기 때문이다. 어댑터 없이 직접 부르면 Luna 비용이
# usage.json 에서 통째로 빠진다 — retry.py 상단 경고("안 감싼 호출은 원장에서 사라진다")와
# 같은 문제다. 단가는 retry.py `_PRICE_KRW_PER_1M` 의 "gpt-5.6-luna" 항목이 잡는다.


class TextResult:
    """genai GenerateContentResponse 의 최소 호환 모양 (text · usage_metadata · model_version)."""

    def __init__(self, text: str, usage_metadata, model_version: str):
        self.text = text
        self.usage_metadata = usage_metadata
        self.model_version = model_version


def wrap_chat_response(resp, model: str) -> TextResult:
    """OpenAI chat.completions 응답 → TextResult. `_record_usage` 가 읽는 필드명으로 매핑한다."""
    from types import SimpleNamespace

    choice = (getattr(resp, "choices", None) or [None])[0]
    msg = getattr(choice, "message", None)
    text = str(getattr(msg, "content", "") or "")
    u = getattr(resp, "usage", None)
    details = getattr(u, "prompt_tokens_details", None)
    um = SimpleNamespace(
        prompt_token_count=int(getattr(u, "prompt_tokens", 0) or 0),
        candidates_token_count=int(getattr(u, "completion_tokens", 0) or 0),
        # OpenAI 프롬프트 캐시 적중분 — genai 의 cached_content_token_count 자리에 싣는다.
        cached_content_token_count=int(getattr(details, "cached_tokens", 0) or 0),
    )
    return TextResult(text, um, str(getattr(resp, "model", "") or model))


def generate_text(*, system: str, user: str, model: str, temperature: float = 0.3) -> TextResult:
    """system+user 1턴 텍스트 생성.

    JSON 이 필요하면 프롬프트로 시킨다 — `response_format` 의 json 모드는 **객체 루트만**
    허용해서 배열을 돌려받는 번역과 안 맞고, 코드펜스가 붙어도 호출부의 복구 파서
    (`_parse_json_array_recover`)가 이미 벗긴다.
    """
    client = _client()
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=temperature,
    )
    return wrap_chat_response(resp, model)


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
    mask: Optional[bytes] = None,
) -> Optional[bytes]:
    """이미지 편집 · 여러 참고 이미지 + 프롬프트 → 새 이미지.
    - reference thumbnail + castPhoto 여러 장 → swap
    - 원본 프레임 + preprocess prompt → cleaned template

    mask: 첫 번째 이미지에 적용되는 편집 범위. **투명한 곳만 모델이 다시 그리고,
    불투명한 곳은 원본 픽셀이 그대로 남는다.** 프롬프트로 "얼굴을 바꾸지 마라"고
    쓰는 것과 근본이 다르다 — 모델은 매 픽셀을 새로 만들기 때문에 부탁으로는
    아이덴티티를 못 지킨다. 얼굴을 지키려면 여기서 가려야 한다.
    """
    client = _client()
    # OpenAI SDK 는 file-like objects 필요 (BytesIO 로 감싸기)
    files = []
    for i, b in enumerate(images):
        bio = io.BytesIO(b)
        bio.name = f"image_{i}.png"  # SDK 가 name 속성 필요 (MIME 판정)
        files.append(bio)
    kwargs = {}
    if mask is not None:
        mbio = io.BytesIO(mask)
        mbio.name = "mask.png"
        kwargs["mask"] = mbio
    resp = client.images.edit(
        model=model,
        image=files if len(files) > 1 else files[0],
        prompt=prompt,
        size=size,
        n=n,
        **kwargs,
    )
    return _decode(resp)

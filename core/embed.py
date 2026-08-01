"""
STEP D Core — 텍스트 임베딩 백엔드

검색 세그먼트의 대사·요약을 벡터로 만든다. 백엔드는 두 개:

  vertex  (프로덕션 기본) — Vertex `text-multilingual-embedding-002` (768d, 한국어 지원,
          서울 리전). 프레임/음성이 아닌 순수 텍스트라 리전 제약은 없으나 Gemini와
          같은 프로젝트/리전으로 맞춘다.
  local   (오프라인 폴백) — 문자 bigram 해시 임베더. **의미 품질 보장 아님.**
          GCP 자격증명 없이 검색 배관(필터·하이브리드·주석)을 검증하기 위한 것.

선택: 환경변수 `EMBED_BACKEND` (vertex|local). 미지정이면 vertex.
⚠️ vertex 실패 시 **local로 폴백하지 않는다** — 인덱스에 local 벡터를 섞으면 쿼리(vertex)
임베딩과 다른 공간이라 코사인이 깨진다. 실패한 임베딩은 **None**(→ 저장 시 NULL)으로 두고,
검색은 키워드 축(pg_trgm)만으로 폴백한다. local은 오프라인 셀프테스트에서만 명시적으로 쓴다.
차원(DIM)은 백엔드 무관 고정.

task_type: 문서는 RETRIEVAL_DOCUMENT, 쿼리는 RETRIEVAL_QUERY (비대칭 검색 최적화).
"""
from __future__ import annotations

import hashlib
import math
import os
import sys

DIM = int(os.environ.get("EMBED_DIM") or 768)

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
_VERTEX_MODEL = os.environ.get("EMBED_MODEL") or "text-multilingual-embedding-002"

_BACKEND = (os.environ.get("EMBED_BACKEND") or "").strip().lower()
_warned = False


def _warn_once(msg: str) -> None:
    global _warned
    if not _warned:
        sys.stderr.write(f"[embed] {msg}\n")
        _warned = True


# ── 로컬 결정적 임베더 (오프라인 검증용) ────────────────────────────────────────
def _tokens(text: str) -> list[str]:
    """공백 단어 + 문자 bigram. 공유 부분문자열이 많을수록 코사인이 올라간다."""
    text = (text or "").strip()
    if not text:
        return []
    words = text.split()
    compact = "".join(text.split())
    bigrams = [compact[i:i + 2] for i in range(len(compact) - 1)]
    return words + bigrams


def _local_embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    for tok in _tokens(text):
        h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
        idx = h % DIM
        sign = 1.0 if (h >> 8) & 1 else -1.0
        vec[idx] += sign
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / n for v in vec]


# ── Vertex 임베더 (프로덕션) ────────────────────────────────────────────────────
_vertex_client = None


def _get_vertex_client():
    global _vertex_client
    if _vertex_client is None:
        from google import genai  # 지연 import — local 전용 실행에서 SDK 없어도 됨
        _vertex_client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    return _vertex_client


def _vertex_embed(texts: list[str], task_type: str) -> list[list[float]]:
    from google.genai import types
    client = _get_vertex_client()
    resp = client.models.embed_content(
        model=_VERTEX_MODEL,
        contents=texts,
        config=types.EmbedContentConfig(
            task_type=task_type,
            output_dimensionality=DIM,
        ),
    )
    return [list(e.values) for e in resp.embeddings]


# ── 공개 API ─────────────────────────────────────────────────────────────────
def _resolve_backend() -> str:
    if _BACKEND in ("vertex", "local"):
        return _BACKEND
    return "vertex"  # 기본 — 실패 시 embed_texts가 local로 폴백


def embed_texts(texts: list[str], *, is_query: bool = False) -> list[list[float] | None]:
    """텍스트 배열 → 벡터 배열 (DIM 차원). 빈 문자열·실패는 None (→ 저장 시 NULL).
    ⚠️ vertex 실패해도 local로 폴백하지 않는다 (인덱스 오염 방지)."""
    if not texts:
        return []
    backend = _resolve_backend()
    task_type = "RETRIEVAL_QUERY" if is_query else "RETRIEVAL_DOCUMENT"
    nonempty = [i for i, t in enumerate(texts) if (t or "").strip()]

    if backend == "local":
        return [_local_embed(t) if (t or "").strip() else None for t in texts]

    # vertex — 실패하면 전부 None (키워드 축으로 폴백)
    out: list[list[float] | None] = [None] * len(texts)
    if not nonempty:
        return out
    try:
        vecs = _vertex_embed([texts[i] for i in nonempty], task_type)
        for j, i in enumerate(nonempty):
            out[i] = vecs[j]
    except Exception as e:  # 자격증명 없음·SDK 없음·호출 실패
        _warn_once(f"vertex 임베딩 실패 → 임베딩 None, 키워드 축만 사용 ({str(e)[:120]})")
    return out


def embed_one(text: str, *, is_query: bool = False) -> list[float] | None:
    return embed_texts([text], is_query=is_query)[0]


def cosine(a: list[float], b: list[float]) -> float:
    """두 벡터 코사인 유사도. 어느 쪽이든 영벡터면 0."""
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def active_backend() -> str:
    return _resolve_backend()

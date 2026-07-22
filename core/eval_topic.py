"""주제(의미) 기반 채점 — "엔진이 편집자와 같은 순간을 숏폼감으로 잡았나".

기존 evaluate.py의 Hit@N(IoU≥0.5)은 **같은 초**를 요구한다. 하지만 제품이 진짜 묻는 건
"엔진이 같은 걸 숏폼으로 내보내려 했나"이지 "정확히 같은 프레임에서 잘랐나"가 아니다.
엔진이 '김종국 채널 오픈' 순간을 8초 앞에서 잡아도, 편집자가 발행한 그 숏폼과 **같은 순간**이면
히트로 세야 공정하다(2026-07-22 방법론 교정, 사용자 지적).

방식: 발행 숏폼(정답)과 엔진 추천을 각각 (제목 + 구간 자막)으로 표현하고, Gemini가 "이 발행
숏폼과 같은 순간/주제를 다룬 엔진 픽이 top-N 안에 있나"를 판단한다. IoU가 아니라 내용 일치.

Topic-Hit@N = 같은 순간을 잡힌 발행 숏폼 수 / 전체 발행 숏폼 수.
"""

from __future__ import annotations

import json
import os

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "matches": {
            "type": "ARRAY",
            "description": "발행 숏폼마다 하나. 순서·개수는 입력 발행 숏폼과 정확히 일치.",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "published_idx": {"type": "INTEGER", "description": "발행 숏폼 번호"},
                    "matched_rank": {"type": "INTEGER", "description": "같은 순간을 잡은 엔진 픽의 rank(1=최고). 없으면 0"},
                    "why": {"type": "STRING", "description": "왜 같은 순간인가(또는 왜 매칭 없나) 한 줄"},
                },
                "required": ["published_idx", "matched_rank"],
            },
        },
    },
    "required": ["matches"],
}

_PROMPT = """너는 한국 숏폼 편집 심사자다. 아래 [발행 숏폼]은 한 채널이 이 롱폼에서 실제로 잘라 올린
숏폼들(사람 편집자의 정답)이고, [엔진 추천]은 우리 AI가 같은 롱폼에서 뽑은 후보들이다.

각 [발행 숏폼]에 대해, [엔진 추천] 중 **같은 순간/주제를 숏폼감으로 잡은 것**이 있는지 판단하라.
- 판단 기준은 **내용(무슨 순간·무슨 주제·무슨 대사)**이다. 시작 초가 몇 초 어긋나든, 같은 사건·
  같은 대화·같은 웃음 포인트를 담았으면 **같은 순간**으로 본다.
- 표면 단어가 겹치는 게 아니라 **실제로 같은 장면/맥락**이어야 매칭이다. 애매하면 매칭 없음(0).
- 매칭되면 그 엔진 픽의 rank를 적어라. 여러 개면 가장 잘 맞는(보통 rank 낮은) 것.

=== 발행 숏폼 (정답, {n_pub}개) ===
{pub_block}

=== 엔진 추천 (top {n_rec}) ===
{rec_block}
"""


def _fmt(items: list[dict], kind: str) -> str:
    lines = []
    for i, it in enumerate(items, 1):
        title = (it.get("title") or "").strip()[:60]
        txt = (it.get("text") or "").strip()
        txt = " ".join(txt.split())[:140]
        tag = f"rank{it.get('rank', i)}" if kind == "rec" else f"#{i}"
        lines.append(f"[{tag}] {title}" + (f" — {txt}" if txt else ""))
    return "\n".join(lines)


def topic_hits(published: list[dict], recs: list[dict], n_list=(5, 10, 20)) -> dict:
    """published: [{title, text}], recs: [{rank, title, text}] (rank 순).
    반환: {topic_hit@N, matched(rank들), detail}."""
    if not published:
        return {"published": 0, **{f"topic_hit@{n}": 0.0 for n in n_list}}
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    prompt = _PROMPT.format(
        n_pub=len(published), n_rec=len(recs),
        pub_block=_fmt(published, "pub"), rec_block=_fmt(recs, "rec"),
    )
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL, contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0, response_mime_type="application/json", response_schema=_SCHEMA,
        ),
    ))
    matches = json.loads(resp.text or "{}").get("matches", [])
    ranks = [int(m.get("matched_rank") or 0) for m in matches]
    total = len(published) or 1
    out = {"published": len(published), "matched_ranks": ranks}
    for n in n_list:
        out[f"topic_hit@{n}"] = round(sum(1 for r in ranks if 1 <= r <= n) / total, 3)
    out["detail"] = matches
    return out

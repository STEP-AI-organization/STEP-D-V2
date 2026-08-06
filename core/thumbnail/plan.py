"""썸네일 기획 (Thumbnail Plan) — 에셋을 찾기 **전에** 무엇이 필요한지부터 정한다.

사용자 지시 (2026-08-06):
"먼저 영상 내용 보고 썸네일 기획(조회수가 폭발하기 위한) → 그거에 맞춰서 필요한
 영상 배경 프레임·인물 사진을 찾아야 함."

기존 planner.py 와 방향이 반대다:
- planner.py : 후보 프레임·출연자 사진을 **미리 받아서** 그중 고른다 (있는 것 중 최선)
- plan.py    : 영상 내용만 보고 **필요한 것을 규정한다** → sourcing.py 가 그 조건으로 찾는다

순서가 뒤집히면 기획이 에셋에 끌려간다. "마침 얼굴 큰 프레임이 있어서" 고른 썸네일은
클릭을 못 만든다. 먼저 "무엇을 보여줘야 눌리는가"를 정하고, 그 다음에 찾는다.

이 모듈이 정하는 것 (= sourcing 의 검색 조건):
- 후크 한 줄과 제목 2개 (문구는 LLM 이 쓴다 — 서술·생성은 LLM 영역)
- 배경 조건: 어떤 장면이어야 하는가 · 얼마나 비어 있어야 하는가 · 무엇이 없어야 하는가
- 인물 조건: 누구를 · 어떤 표정으로 · 어느 쪽을 보게

점수·순위는 여기서 만들지 않는다. 그건 sourcing/match 의 결정론 영역이다.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional, TypedDict


class PersonBrief(TypedDict, total=False):
    slotId: str                 # "person_1" | "person_2"
    castName: str               # 등록 인물명. 미상이면 빈 문자열
    expression: str             # "충격" · "분노" · "웃음" ...
    facing: Literal["left", "right", "center"]
    why: str                    # 이 인물이 왜 필요한가 (검수용)


class BackgroundBrief(TypedDict, total=False):
    scene: str                  # 어떤 장면이어야 하는가 (자연어)
    atSec: Optional[float]      # 기획이 특정 시점을 지목하면 그 초
    busyness: float             # 0(비어야 함) ~ 1(꽉 차도 됨)
    avoid: list[str]            # "자막" · "로고" · "얼굴 클로즈업" ...


class ThumbnailPlan(TypedDict, total=False):
    concept: str                # 이 썸네일이 파는 것 한 줄
    hook: str                   # 클릭을 만드는 긴장/의문
    title1: str                 # 부제 (짧게)
    title2: str                 # 메인 카피
    mood: list[str]
    category: str               # 템플릿 매칭 키 (dialogue_conflict 등)
    personCount: int
    people: list[PersonBrief]
    background: BackgroundBrief


SYSTEM = """너는 한국 방송사 유튜브 채널의 썸네일 기획자다.
영상 내용을 보고 **조회수가 터지는 썸네일의 설계 조건**을 JSON 하나로 출력한다.

너는 이미지를 만들지 않고, 프레임을 고르지도 않는다. 그건 뒤 단계가 한다.
너의 일은 "무엇을 보여줘야 눌리는가"를 규정하는 것이다.

[원칙]
- 후크 우선: 결말을 다 말하지 말고 **보고 싶게** 만든다. 요약형 금지.
- 제목은 어그로·클릭베이트 톤을 허용한다. 담백한 서술체는 지양한다.
  ?! · … · 인용문 · 경악 표현 자유. 단 영상에 없는 사실을 지어내지 않는다.
- title1(부제)은 20자 이내, title2(메인)는 24자 이내. 넘으면 잘린다.
- 인물은 **등록된 출연자 이름**만 쓴다. 모르면 castName 을 빈 문자열로 둔다.
- 배경은 "어떤 장면이어야 하는가"를 쓴다. 특정 파일을 고르지 않는다.
- avoid 에는 배경에 있으면 안 되는 것을 적는다 (기존 자막·로고 등).

[category 값]
dialogue_conflict(대립·다툼) · reveal(폭로·공개) · reaction(리액션·경악) ·
emotional(감동·눈물) · comedy(웃음) · info(정보·설명)

[출력 JSON 스키마]
{
  "concept": "...", "hook": "...",
  "title1": "...", "title2": "...",
  "mood": ["긴장","충격"], "category": "dialogue_conflict",
  "personCount": 2,
  "people": [
    {"slotId":"person_1","castName":"영숙","expression":"긴장","facing":"right","why":"..."},
    {"slotId":"person_2","castName":"영수","expression":"충격","facing":"left","why":"..."}
  ],
  "background": {"scene":"...","atSec":142.0,"busyness":0.4,"avoid":["자막","로고"]}
}
JSON 외 다른 텍스트는 출력하지 않는다."""


def build_context_block(
    summary: str,
    transcript_lines: Optional[list[str]] = None,
    cast_names: Optional[list[str]] = None,
    program: Optional[dict[str, Any]] = None,
    viewer_signals: Optional[dict[str, Any]] = None,
) -> str:
    """LLM 에 넣을 입력 블록. 있는 것만 넣는다 — 빈 섹션은 노이즈다."""
    parts = [f"[영상 내용]\n{summary.strip()}"]
    if program:
        title = program.get("title") or ""
        genre = program.get("genre") or ""
        if title or genre:
            parts.append(f"[프로그램]\n{title} · {genre}".strip(" ·"))
    if cast_names:
        parts.append("[등록 출연자]\n" + ", ".join(cast_names))
    if transcript_lines:
        joined = "\n".join(line.strip() for line in transcript_lines[:60] if line.strip())
        if joined:
            parts.append(f"[대사]\n{joined}")
    if viewer_signals:
        hot = viewer_signals.get("hotTopics") or viewer_signals.get("topics")
        if hot:
            parts.append("[시청자 반응]\n" + ", ".join(map(str, hot[:10])))
    return "\n\n".join(parts)


def _coerce(raw: dict[str, Any]) -> ThumbnailPlan:
    """LLM 출력 정리. 길이·범위는 여기서 강제한다 — 아래 단계가 믿고 쓰게."""
    people: list[PersonBrief] = []
    for i, p in enumerate(raw.get("people") or []):
        facing = p.get("facing")
        people.append({
            "slotId": p.get("slotId") or f"person_{i + 1}",
            "castName": (p.get("castName") or "").strip(),
            "expression": (p.get("expression") or "").strip(),
            "facing": facing if facing in ("left", "right", "center") else "center",
            "why": (p.get("why") or "").strip(),
        })
    bg_raw = raw.get("background") or {}
    try:
        busyness = float(bg_raw.get("busyness", 0.5))
    except (TypeError, ValueError):
        busyness = 0.5
    at_sec = bg_raw.get("atSec")
    try:
        at_sec = float(at_sec) if at_sec is not None else None
    except (TypeError, ValueError):
        at_sec = None

    return {
        "concept": (raw.get("concept") or "").strip(),
        "hook": (raw.get("hook") or "").strip(),
        "title1": (raw.get("title1") or "").strip()[:20],
        "title2": (raw.get("title2") or "").strip()[:24],
        "mood": [str(m).strip() for m in (raw.get("mood") or []) if str(m).strip()],
        "category": (raw.get("category") or "").strip(),
        "personCount": int(raw.get("personCount") or len(people)),
        "people": people,
        "background": {
            "scene": (bg_raw.get("scene") or "").strip(),
            "atSec": at_sec,
            "busyness": min(max(busyness, 0.0), 1.0),
            "avoid": [str(a).strip() for a in (bg_raw.get("avoid") or []) if str(a).strip()],
        },
    }


def build_plan(
    summary: str,
    transcript_lines: Optional[list[str]] = None,
    cast_names: Optional[list[str]] = None,
    program: Optional[dict[str, Any]] = None,
    viewer_signals: Optional[dict[str, Any]] = None,
    client: Any = None,
    model: Optional[str] = None,
) -> ThumbnailPlan:
    """영상 내용 → 썸네일 기획. Vertex Gemini 1회 호출."""
    from google import genai
    from google.genai import types

    from core.models import TEXT
    from core.retry import call_with_retry

    if client is None:
        import os
        client = genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d",
            location=os.environ.get("VERTEX_LOCATION") or "asia-northeast3",
        )

    prompt = build_context_block(summary, transcript_lines, cast_names, program, viewer_signals)
    resp = call_with_retry(lambda: client.models.generate_content(
        model=model or TEXT,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            temperature=0.7,          # 카피는 다양성이 필요하다
            response_mime_type="application/json",
            # thinking 을 켜두면 budget 을 사고에 다 쓰고 JSON 이 잘린 채 끝난다.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            max_output_tokens=4096,
        ),
    ))
    text = (resp.text or "").strip()
    try:
        return _coerce(json.loads(text))
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"기획 JSON 파싱 실패({e}). 응답 앞부분: {text[:400]!r}"
        ) from e


def to_match_context(plan: ThumbnailPlan) -> dict[str, Any]:
    """기획 → match.rank() 가 먹는 VideoContext. 템플릿 선택에 그대로 넘긴다."""
    return {
        "personCount": plan.get("personCount"),
        "mood": plan.get("mood") or [],
        "category": plan.get("category") or "",
        "title1": plan.get("title1") or "",
        "title2": plan.get("title2") or "",
        "people": [{"facing": p.get("facing")} for p in (plan.get("people") or [])],
        "backgroundBusyness": (plan.get("background") or {}).get("busyness"),
    }

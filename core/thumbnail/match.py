"""영상 분석 결과 → 구조 템플릿 후보 선정 (계획 3단계).

계획의 점수식을 그대로 구현한다:

    인물 수 일치      × 30
    분위기 일치        × 20
    시선 방향 일치     × 15
    제목 글자 수 수용  × 15
    콘텐츠 유형 일치   × 10
    배경 여백 적합도   × 10

1차는 규칙 기반만 쓴다. 처음부터 LLM 에 선택을 맡기면 같은 입력에 매번 다른
템플릿이 나와 측정이 불가능해진다 — 점수는 결정론으로 두고, LLM/비전 모델은
여기서 걸러진 소수 후보의 최종 순위에만 개입시킨다.
"""
from __future__ import annotations

from typing import Any, Optional, TypedDict

from core.thumbnail.structure import StructureTemplate, load_registry

W_PERSON_COUNT = 30.0
W_MOOD = 20.0
W_FACING = 15.0
W_TITLE_FIT = 15.0
W_CATEGORY = 10.0
W_BG_ROOM = 10.0


class VideoContext(TypedDict, total=False):
    personCount: int
    mood: list[str]
    category: str
    title1: str
    title2: str
    people: list[dict]          # [{facing: "right", ...}]
    backgroundBusyness: float   # 0(여백 많음) ~ 1(꽉 참). 없으면 이 축을 뺀다.


class Scored(TypedDict):
    templateId: str
    score: float
    breakdown: dict[str, float]
    fits: bool


def _person_count_score(ctx: VideoContext, t: StructureTemplate) -> float:
    want = ctx.get("personCount")
    have = t.get("personCount", len(t.get("personSlots") or []))
    if want is None:
        return 0.0
    if want == have:
        return W_PERSON_COUNT
    # 슬롯이 남는 건 인물을 지어내야 하므로 치명적. 반대(인물이 남음)는 덜 나쁘다.
    return 0.0 if have > want else W_PERSON_COUNT * 0.3


def _mood_score(ctx: VideoContext, t: StructureTemplate) -> float:
    want = {m.strip() for m in (ctx.get("mood") or []) if m and m.strip()}
    have = {m.strip() for m in (t.get("moods") or []) if m and m.strip()}
    if not want or not have:
        return 0.0
    return W_MOOD * len(want & have) / len(want)


def _facing_score(ctx: VideoContext, t: StructureTemplate) -> float:
    people = ctx.get("people") or []
    slots = t.get("personSlots") or []
    if not people or not slots:
        return 0.0
    pairs = min(len(people), len(slots))
    hit = 0
    for i in range(pairs):
        pf = (people[i].get("facing") or "").strip()
        sf = (slots[i].get("facing") or "").strip()
        if pf and sf and pf == sf:
            hit += 1
    return W_FACING * hit / pairs


def _title_fit_score(ctx: VideoContext, t: StructureTemplate) -> float:
    """제목이 슬롯에 안 들어가면 잘리거나 폰트가 뭉개진다. 가장 확실한 탈락 사유."""
    slots = {s.get("id"): s for s in (t.get("textSlots") or [])}
    checks = [("title_1", ctx.get("title1")), ("title_2", ctx.get("title2"))]
    scored, total = 0.0, 0
    for slot_id, text in checks:
        slot = slots.get(slot_id)
        if slot is None or text is None:
            continue
        total += 1
        cap = slot.get("maxCharacters") or 0
        if cap <= 0:
            continue
        n = len(text.strip())
        if n <= cap:
            scored += 1.0
        elif n <= cap * 1.15:   # 살짝 넘는 건 자간·줄바꿈으로 흡수 가능
            scored += 0.5
    return 0.0 if total == 0 else W_TITLE_FIT * scored / total


def _category_score(ctx: VideoContext, t: StructureTemplate) -> float:
    want = (ctx.get("category") or "").strip()
    have = (t.get("category") or "").strip()
    return W_CATEGORY if want and want == have else 0.0


def _bg_room_score(ctx: VideoContext, t: StructureTemplate) -> float:
    """배경이 복잡할수록 인물·제목이 캔버스를 많이 덮는 템플릿이 유리하다."""
    busy = ctx.get("backgroundBusyness")
    if busy is None:
        return 0.0
    covered = 0.0
    for slot in [*(t.get("personSlots") or []), *(t.get("textSlots") or [])]:
        bbox = slot.get("bbox") or []
        if len(bbox) == 4:
            covered += bbox[2] * bbox[3]
    covered = min(covered, 1.0)
    # busy=1 → covered 큰 쪽 만점 · busy=0 → covered 작은 쪽 만점
    return W_BG_ROOM * (1.0 - abs(busy - covered))


def score_template(ctx: VideoContext, t: StructureTemplate) -> Scored:
    breakdown = {
        "personCount": _person_count_score(ctx, t),
        "mood": _mood_score(ctx, t),
        "facing": _facing_score(ctx, t),
        "titleFit": _title_fit_score(ctx, t),
        "category": _category_score(ctx, t),
        "backgroundRoom": _bg_room_score(ctx, t),
    }
    # 인물 슬롯이 남으면 없는 사람을 생성해야 한다 — 점수와 무관하게 제외 대상.
    have = t.get("personCount", len(t.get("personSlots") or []))
    want = ctx.get("personCount")
    fits = want is None or have <= want
    return {
        "templateId": t.get("templateId", ""),
        "score": round(sum(breakdown.values()), 2),
        "breakdown": {k: round(v, 2) for k, v in breakdown.items()},
        "fits": fits,
    }


def rank(
    ctx: VideoContext,
    templates: Optional[list[StructureTemplate]] = None,
    top: int = 10,
    only_fitting: bool = True,
) -> list[Scored]:
    """규칙 기반 1차 필터. 계획대로 여기서 10개까지 좁힌 뒤 임베딩/LLM 으로 넘긴다."""
    pool = templates if templates is not None else load_registry()
    scored = [score_template(ctx, t) for t in pool]
    if only_fitting:
        scored = [s for s in scored if s["fits"]]
    scored.sort(key=lambda s: s["score"], reverse=True)
    return scored[:top]

"""기획 조건 → 실제 에셋 찾기 (배경 프레임 · 인물 사진).

사용자 지시 (2026-08-06): "이거를 알아서 찾는 것도 우리 엔진이 할 일."

plan.py 가 "어떤 배경/누구를"을 규정하면, 여기서 분석 산출물(faces.json ·
프레임 목록 · cast timeline)을 뒤져 **실제 파일**을 고른다.

점수는 전부 결정론이다. 같은 영상·같은 기획이면 같은 프레임이 나와야 한다 —
LLM 에 고르게 하면 매번 달라져서 "이 썸네일이 왜 이렇게 됐는지"를 추적할 수 없다.
LLM 은 plan.py 에서 문구를 쓰는 데까지만 개입한다.

기대 입력 (기존 파이프라인 산출물 형태):
    frames  : [{"path": ..., "sec": 12.5, "faces": [...], "sharpness": 0.0~1.0,
                "hasCaption": bool, "hasLogo": bool}]
    faces   : faces.py 형식 detections — {"bbox":[x1,y1,x2,y2], "area":..,
              "det_score":.., "embedding":[...], "gender":".."}
없는 필드는 그 축을 0점 처리한다 (있는 정보로만 판단하고, 없는 걸 지어내지 않는다).
"""
from __future__ import annotations

from typing import Any, Optional, TypedDict

from core.thumbnail.plan import BackgroundBrief, PersonBrief

# ── 배경 프레임 가중치 ────────────────────────────────────────────────────────
# 자막·로고는 생성 모델이 지운다 (2026-08-07 확인) — 감점 축을 없앴다.
# 미리 걸러내면 정작 쓸 만한 프레임(클로즈업일수록 자막이 붙는다)이 다 날아간다.
BG_W_CLEAN = 0.0
BG_W_SHARP = 40.0      # 선명도 (자막 축을 없앤 만큼 여기로)
BG_W_ROOM = 20.0       # 기획이 요구한 여백과 맞는가
BG_W_TIME = 15.0       # 기획이 지목한 시점과 가까운가
BG_W_NO_FACE = 10.0    # 배경이므로 큰 얼굴이 없는 편이 낫다

# ── 인물 사진 가중치 ──────────────────────────────────────────────────────────
P_W_IDENTITY = 40.0    # 기획이 지목한 인물인가
P_W_SIZE = 20.0        # 얼굴이 충분히 큰가 (작으면 확대 시 뭉갠다)
P_W_QUALITY = 20.0     # 검출 신뢰도 · 선명도
P_W_FACING = 20.0      # 슬롯이 요구하는 시선 방향


class BackgroundPick(TypedDict):
    path: str
    sec: Optional[float]
    score: float
    breakdown: dict[str, float]


class PersonPick(TypedDict):
    slotId: str
    path: str
    sec: Optional[float]
    castName: str
    score: float
    breakdown: dict[str, float]


def _face_area_ratio(frame: dict[str, Any]) -> float:
    """프레임에서 가장 큰 얼굴이 차지하는 면적 비율 0~1. 정보 없으면 0."""
    faces = frame.get("faces") or []
    w = float(frame.get("width") or 0) or 0.0
    h = float(frame.get("height") or 0) or 0.0
    if not faces or w <= 0 or h <= 0:
        return 0.0
    best = 0.0
    for f in faces:
        area = f.get("area")
        if area is None:
            bb = f.get("bbox") or []
            if len(bb) == 4:
                area = max(0.0, (bb[2] - bb[0]) * (bb[3] - bb[1]))
        if area:
            best = max(best, float(area) / (w * h))
    return min(best, 1.0)


def score_background(frame: dict[str, Any], brief: BackgroundBrief) -> BackgroundPick:
    clean = 0.0

    sharp = BG_W_SHARP * float(frame.get("sharpness") or 0.0)

    # 기획이 원한 여백(busyness) 과의 거리. 얼굴 면적을 '차 있음'의 대리 지표로 쓴다.
    want = brief.get("busyness")
    if want is None:
        room = 0.0
    else:
        room = BG_W_ROOM * (1.0 - abs(float(want) - _face_area_ratio(frame)))

    at = brief.get("atSec")
    sec = frame.get("sec")
    if at is None or sec is None:
        time_score = 0.0
    else:
        # 30초 벗어나면 0. 기획이 지목한 장면에서 멀어지면 다른 장면이다.
        time_score = BG_W_TIME * max(0.0, 1.0 - abs(float(sec) - float(at)) / 30.0)

    no_face = BG_W_NO_FACE * (1.0 - _face_area_ratio(frame))

    breakdown = {
        "clean": round(clean, 2), "sharpness": round(sharp, 2),
        "room": round(room, 2), "time": round(time_score, 2),
        "noBigFace": round(no_face, 2),
    }
    return {
        "path": str(frame.get("path") or ""),
        "sec": frame.get("sec"),
        "score": round(sum(breakdown.values()), 2),
        "breakdown": breakdown,
    }


def find_background(
    frames: list[dict[str, Any]],
    brief: BackgroundBrief,
    top: int = 5,
) -> list[BackgroundPick]:
    """기획의 배경 조건에 맞는 프레임 후보. 상위 top개."""
    picks = [score_background(f, brief) for f in frames if f.get("path")]
    picks.sort(key=lambda p: p["score"], reverse=True)
    return picks[:top]


def search_windows(
    query: str,
    media_id: str = "",
    limit: int = 8,
    api_base: Optional[str] = None,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """구간 검색엔진에 기획 문장을 던져 후보 시간창을 받는다.

    사용자 지시 (2026-08-06): "영상 검색엔진을 이용."
    시간축을 훑는 대신 여기서 받은 구간에서만 프레임을 뽑는다 — 기획이 원한
    "장면"을 의미로 찾는 것이 목적이고, 초 단위 추측은 그 다음 문제다.

    ⚠️ search_segments 의 emb_* 가 NULL 이면 벡터 축이 0 이 되어 키워드 검색으로
    조용히 격하된다. scripts/ops/backfill_segment_embeddings.py 로 먼저 확인할 것.
    """
    import json
    import os
    import urllib.parse
    import urllib.request

    base = api_base or os.environ.get("STEPD_API_BASE") or "http://localhost:4100/api"
    url = f"{base}/search?q={urllib.parse.quote(query)}&limit={limit}"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        data = json.load(r)

    out: list[dict[str, Any]] = []
    for hit in data.get("results") or []:
        if media_id and hit.get("mediaId") != media_id:
            continue
        out.append({
            "segmentId": hit.get("segmentId"),
            "start": float(hit.get("start") or 0.0),
            "end": float(hit.get("end") or 0.0),
            "score": float(hit.get("score") or 0.0),
            "vec": float(hit.get("vec") or 0.0),
            "characters": hit.get("characters") or [],
            "summary": hit.get("summary") or "",
        })
    return out


def sample_secs(windows: list[dict[str, Any]], per_window: int = 3) -> list[float]:
    """검색이 준 구간 안에서 프레임 시각을 고른다. 경계는 컷 전환이라 피한다."""
    secs: list[float] = []
    for w in windows:
        s, e = w["start"], w["end"]
        if e <= s:
            secs.append(round(s, 2))
            continue
        span = e - s
        for i in range(per_window):
            # 구간을 per_window+1 등분한 내부 지점 — 시작·끝 프레임은 안 쓴다.
            secs.append(round(s + span * (i + 1) / (per_window + 1), 2))
    return secs


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    # faces.py 가 L2 정규화된 embedding 을 넣으므로 내적이 곧 코사인이다.
    return sum(x * y for x, y in zip(a, b))


def score_person(
    candidate: dict[str, Any],
    brief: PersonBrief,
    cast_embedding: Optional[list[float]] = None,
) -> dict[str, float]:
    """candidate: {"path","sec","face":{...},"castName","facing","frameArea"}"""
    face = candidate.get("face") or {}

    # 정체성: cast 임베딩이 있으면 그걸로, 없으면 이름 일치로 판정한다.
    want_name = (brief.get("castName") or "").strip()
    if cast_embedding and face.get("embedding"):
        sim = _cosine(face["embedding"], cast_embedding)
        identity = P_W_IDENTITY * max(0.0, min(sim, 1.0))
    elif want_name:
        identity = P_W_IDENTITY if (candidate.get("castName") or "").strip() == want_name else 0.0
    else:
        identity = 0.0   # 기획이 인물을 특정 안 했으면 이 축은 판단 불가

    area = candidate.get("frameArea")
    size = P_W_SIZE * min(float(area), 1.0) / 0.25 if area else 0.0
    size = min(size, P_W_SIZE)      # 프레임의 25% 이상이면 만점

    det = float(face.get("det_score") or 0.0)
    sharp = float(candidate.get("sharpness") or 0.0)
    quality = P_W_QUALITY * (det * 0.6 + sharp * 0.4)

    want_facing = brief.get("facing")
    have_facing = candidate.get("facing")
    if want_facing in (None, "center") or not have_facing:
        facing = 0.0
    else:
        facing = P_W_FACING if have_facing == want_facing else 0.0

    return {
        "identity": round(identity, 2), "size": round(size, 2),
        "quality": round(quality, 2), "facing": round(facing, 2),
    }


# 얼굴이 이 비율보다 작으면 후보에서 뺀다. 작은 얼굴은 슬롯 크기로 확대하는 순간
# 뭉개져서, 점수가 아무리 높아도 쓸 수 없다 — 순위 문제가 아니라 자격 문제다.
MIN_FACE_AREA = 0.03


def find_people(
    candidates: list[dict[str, Any]],
    briefs: list[PersonBrief],
    cast_embeddings: Optional[dict[str, list[float]]] = None,
    top_per_slot: int = 3,
    min_face_area: float = MIN_FACE_AREA,
) -> dict[str, list[PersonPick]]:
    """슬롯별 인물 후보. 같은 프레임이 두 슬롯을 동시에 채우지 않도록 배제한다."""
    cast_embeddings = cast_embeddings or {}
    # 자격 미달(너무 작은 얼굴)은 순위에 올리기 전에 잘라낸다.
    if min_face_area > 0:
        candidates = [c for c in candidates
                      if float(c.get("frameArea") or 0.0) >= min_face_area]
    result: dict[str, list[PersonPick]] = {}
    used: set[str] = set()
    # 같은 사람이 두 슬롯을 채우면 안 된다. 파일 경로만 보면 1.5초 뒤 프레임의
    # 동일 인물이 통과하므로, 얼굴 임베딩으로 같은 사람인지 본다.
    taken_embeddings: list[list[float]] = []
    SAME_PERSON = 0.5   # 코사인 이상이면 동일 인물로 간주

    for brief in briefs:
        slot_id = brief.get("slotId") or "person_1"
        emb = cast_embeddings.get((brief.get("castName") or "").strip())
        picks: list[PersonPick] = []
        for c in candidates:
            path = str(c.get("path") or "")
            if not path or path in used:
                continue
            cemb = (c.get("face") or {}).get("embedding")
            if cemb is not None and any(
                _cosine(list(cemb), t) > SAME_PERSON for t in taken_embeddings
            ):
                continue
            bd = score_person(c, brief, emb)
            picks.append({
                "slotId": slot_id, "path": path, "sec": c.get("sec"),
                "castName": (c.get("castName") or "").strip(),
                "score": round(sum(bd.values()), 2), "breakdown": bd,
            })
        picks.sort(key=lambda p: p["score"], reverse=True)
        picks = picks[:top_per_slot]
        if picks:
            used.add(picks[0]["path"])   # 1순위만 점유 — 차순위는 다른 슬롯도 검토 가능
            chosen = next((c for c in candidates if str(c.get("path")) == picks[0]["path"]), None)
            cemb = (chosen or {}).get("face", {}).get("embedding") if chosen else None
            if cemb is not None:
                taken_embeddings.append(list(cemb))
        result[slot_id] = picks
    return result


def missing_assets(
    background: list[BackgroundPick],
    people: dict[str, list[PersonPick]],
    briefs: list[PersonBrief],
) -> list[str]:
    """합성을 걸기 전에 빠진 것을 알린다. 없는 채로 생성하면 모델이 지어낸다."""
    gaps: list[str] = []
    if not background:
        gaps.append("배경 프레임 후보 없음")
    for b in briefs:
        slot = b.get("slotId") or "person_1"
        if not people.get(slot):
            name = b.get("castName") or "미상"
            gaps.append(f"{slot}({name}) 인물 후보 없음")
    return gaps

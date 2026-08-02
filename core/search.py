"""
STEP D Core — 검색 코어 (query pipeline)

segments.json(=core.index_segments 산출) 위에서 자연어 쿼리를 처리한다. 별도 벡터 DB나
서버 없이 순수 파이썬으로 완결 — 검색 배관 전체를 오프라인에서 검증하기 위함이다.
프로덕션에선 필터=SQL WHERE, 벡터=pgvector로 그대로 옮겨진다(같은 로직, 다른 저장소).

파이프라인 (설계 §4):
  자연어 쿼리
    ↓ 쿼리 파서 (여기선 룰 스텁 · 프로덕션은 LLM 파서로 교체)
  {인물, 장면유형, 쇼츠여부, 잔여 의미쿼리} + 명시적 필터(스코프·회차·방영일)
    ↓ 메타데이터 필터  (필터 먼저 — 후보를 좁힌다)
    ↓ 하이브리드 랭킹  (BM25 + 벡터, RRF 융합 — 임베딩은 랭킹에서만)
    ↓ 권리·스포일러 필터 + 상태 주석  (못 쓰는 클립은 안 나온 것과 같다)
  결과 카드

한국어는 형태소 기반 키워드 매칭이 강해서(§4) BM25 비중이 크다. bigram 토큰으로
근사한다 — 고유명사·대사 인용은 키워드가, 상황 묘사는 벡터가 잡는다.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Optional

from .embed import cosine, embed_one

# RRF 상수 — 순위 역수 융합. 점수 스케일이 다른 BM25·코사인을 순위로 통일해 섞는다.
RRF_K = 60
W_BM25 = 1.0
W_VEC = 1.0

# 장면유형 표현 사전 (룰 파서 · scene_type.json 라벨과 매칭)
_SCENE_KW = {
    "인터뷰": "interview", "인터뷰컷": "interview", "인뷰": "interview",
    "현장": "on_scene", "현장컷": "on_scene",
}


# ── 토큰화 (BM25용) ─────────────────────────────────────────────────────────
def _tok(text: str) -> list[str]:
    """공백 단어 + 문자 bigram. 한국어 부분일치를 bigram으로 근사."""
    text = (text or "").strip().lower()
    if not text:
        return []
    words = re.findall(r"[0-9a-z]+|[가-힣]+", text)
    toks: list[str] = []
    for w in words:
        toks.append(w)
        if len(w) >= 2:
            toks.extend(w[i:i + 2] for i in range(len(w) - 1))
    return toks


def _seg_text(seg: dict) -> str:
    return " ".join(filter(None, [seg.get("dialogue"), seg.get("chyron"),
                                  seg.get("summary")]))


# ── BM25 (후보 집합 위에서) ─────────────────────────────────────────────────
def _bm25_scores(cands: list[dict], query: str, k1: float = 1.5, b: float = 0.75) -> list[float]:
    docs = [_tok(_seg_text(s)) for s in cands]
    if not docs:
        return []
    q_terms = set(_tok(query))
    if not q_terms:
        return [0.0] * len(cands)
    N = len(docs)
    avgdl = sum(len(d) for d in docs) / max(1, N)
    df = Counter()
    for d in docs:
        for t in set(d):
            if t in q_terms:
                df[t] += 1
    idf = {t: math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)) for t in q_terms if df[t]}
    scores = []
    for d in docs:
        tf = Counter(d)
        dl = len(d)
        s = 0.0
        for t in q_terms:
            if t not in idf or tf[t] == 0:
                continue
            num = tf[t] * (k1 + 1)
            den = tf[t] + k1 * (1 - b + b * dl / avgdl)
            s += idf[t] * num / den
        scores.append(s)
    return scores


# ── 쿼리 파서 (룰 스텁 — 프로덕션은 LLM으로 교체) ─────────────────────────────
def parse_query(query: str, roster: Optional[list[str]] = None) -> dict:
    """자연어에서 구조 신호를 뽑는다. roster(인물 이름 목록)가 있으면 인물 매칭.
    남은 텍스트가 의미쿼리(semantic). ⚠️ 스텁 — 실제는 LLM 쿼리 파서(설계 step 5)."""
    q = query or ""
    low = q.lower()

    characters: list[str] = []
    for name in (roster or []):
        if name and name in q:
            characters.append(name)

    scene_type: Optional[str] = None
    for kw, label in _SCENE_KW.items():
        if kw in q:
            scene_type = label
            break

    is_short: Optional[bool] = None
    if any(w in low for w in ("쇼츠", "숏폼", "터진", "하이라이트")):
        is_short = True

    # 의미쿼리 = 원문에서 매칭된 구조 토큰 제거한 나머지
    semantic = q
    for token in characters + list(_SCENE_KW.keys()):
        semantic = semantic.replace(token, " ")
    semantic = re.sub(r"\s+", " ", semantic).strip()

    return {"characters": characters, "scene_type": scene_type,
            "is_short": is_short, "semantic": semantic, "raw": q}


# ── 메타데이터 필터 ─────────────────────────────────────────────────────────
def _passes_filter(seg: dict, parsed: dict, filters: dict) -> bool:
    # 인물 — 파싱된 인물 전부가 세그먼트 인물에 있어야 (AND)
    want_chars = filters.get("characters") or parsed.get("characters") or []
    seg_chars = seg.get("characters") or []
    if want_chars and not all(c in seg_chars for c in want_chars):
        return False
    # 장면유형
    st = filters.get("scene_type") or parsed.get("scene_type")
    if st and seg.get("scene_type") != st:
        return False
    # 쇼츠 여부
    want_short = filters.get("is_short")
    if want_short is None:
        want_short = parsed.get("is_short")
    if want_short is not None and bool(seg.get("is_short")) != bool(want_short):
        return False
    # 장르
    if filters.get("genre") and seg.get("genre") != filters["genre"]:
        return False
    # 스코프 (기수/시즌/회차)
    scope = seg.get("scope") or {}
    for key in ("scope_type", "scope_id", "episode"):
        if filters.get(key) and scope.get(key) != filters[key]:
            return False
    # 방영일 범위
    aired = scope.get("aired_at")
    if filters.get("aired_from") and (not aired or aired < filters["aired_from"]):
        return False
    if filters.get("aired_to") and (not aired or aired > filters["aired_to"]):
        return False
    return True


# ── 권리·스포일러 (§ 원칙 4) ─────────────────────────────────────────────────
def _rights_status(seg: dict, allow_spoiler: bool) -> tuple[bool, dict]:
    """(노출가능?, 상태주석). 스포일러=참이면 기본 제외. cast_ok=거짓이면 제외.
    null(미확인)은 제외하지 않되 '확인필요'로 표시 — 판단은 사람에게 넘긴다."""
    r = seg.get("rights") or {}
    notes: dict[str, str] = {}
    ok = True

    if r.get("spoiler") is True and not allow_spoiler:
        return False, {"spoiler": "제외(방영 전 노출 금지)"}
    if r.get("spoiler") is True:
        notes["spoiler"] = "⚠️ 스포일러"

    if r.get("cast_ok") is False:
        return False, {"cast_ok": "제외(출연자 사용불가)"}
    if r.get("cast_ok") is None:
        notes["cast_ok"] = "출연자 권리 확인필요"

    if r.get("music_cleared") is False:
        notes["music_cleared"] = "⚠️ 음원 미클리어"
    elif r.get("music_cleared") is None:
        notes["music_cleared"] = "음원 확인필요"

    if r.get("ppl") is True:
        notes["ppl"] = "협찬/PPL 구간"

    return ok, notes


# ── 검색 ─────────────────────────────────────────────────────────────────────
def _rank_positions(scores: list[float]) -> dict[int, int]:
    """인덱스→순위(1부터). **점수>0인 문서만** 순위에 넣는다 — 점수 0(해당 모달리티
    무매칭) 문서에 인덱스 순으로 억지 순위를 주면 RRF에 노이즈가 섞여 다른 모달리티의
    승자를 상쇄한다. 무매칭 문서는 그 모달리티에서 기여 없음."""
    order = sorted((i for i in range(len(scores)) if scores[i] > 0),
                   key=lambda i: (-scores[i], i))
    return {idx: pos + 1 for pos, idx in enumerate(order)}


def search(segments: list[dict], query: str, *, filters: Optional[dict] = None,
           roster: Optional[list[str]] = None, top_k: int = 10,
           allow_spoiler: bool = False) -> dict:
    filters = filters or {}
    if roster is None:
        roster = sorted({c for s in segments for c in (s.get("characters") or [])},
                        key=len, reverse=True)
    parsed = parse_query(query, roster=roster)

    # 1) 메타데이터 필터
    cands = [s for s in segments if _passes_filter(s, parsed, filters)]
    if not cands:
        return {"parsed": parsed, "candidate_count": 0, "results": []}

    # 2) 하이브리드 랭킹 — BM25 + 벡터(RRF)
    semantic = parsed["semantic"] or query
    bm25 = _bm25_scores(cands, query)
    has_emb = any(s.get("emb_dialogue") for s in cands)
    cos: list[float] = [0.0] * len(cands)
    if has_emb and semantic:
        qv = embed_one(semantic, is_query=True)
        for i, s in enumerate(cands):
            cd = cosine(qv, s.get("emb_dialogue") or [])
            cs = cosine(qv, s.get("emb_summary") or [])
            cos[i] = max(cd, cs)  # 대사·요약 중 잘 맞는 쪽

    r_bm = _rank_positions(bm25)
    r_vec = _rank_positions(cos) if has_emb and semantic else {}
    fused = []
    for i in range(len(cands)):
        score = 0.0
        if i in r_bm:
            score += W_BM25 / (RRF_K + r_bm[i])
        if i in r_vec:
            score += W_VEC / (RRF_K + r_vec[i])
        fused.append((i, score))
    fused.sort(key=lambda x: -x[1])

    # 3) 권리·스포일러 필터 + 상태 주석 → 결과 카드
    results = []
    dropped_by_rights = 0
    for i, fscore in fused:
        seg = cands[i]
        ok, notes = _rights_status(seg, allow_spoiler)
        if not ok:
            dropped_by_rights += 1
            continue
        results.append({
            "segment_id": seg.get("segment_id"),
            "start": seg.get("start"), "end": seg.get("end"),
            "duration": seg.get("duration"),
            "characters": seg.get("characters"),
            "scene_type": seg.get("scene_type"),
            "is_short": seg.get("is_short"),
            "highlight_score": seg.get("highlight_score"),
            "summary": seg.get("summary"),
            "dialogue": seg.get("dialogue"),
            "rights_status": notes,
            "score": round(fscore, 6),
            "bm25": round(bm25[i], 4),
            "cosine": round(cos[i], 4),
        })
        if len(results) >= top_k:
            break

    return {"parsed": parsed, "candidate_count": len(cands),
            "filtered_out_by_rights": dropped_by_rights,
            "results": results}

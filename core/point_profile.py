"""채널 포인트 프로파일 — 고성과 구간엔 뭐가 있고, 저성과 구간엔 뭐가 결여됐나.

입력: /api/lab/match/export 응답 (매칭 구간 + 성과 tier + 구간 설명).
질문: high tier 구간이 low tier 구간과 무엇이 다른가?

두 단계로 답한다:
  1) **통계 대조** (이 파일): hook·emotion·길이 등 관측 가능한 신호를 tier별로 집계해
     "high에서 과대표집되고 low에서 결여된" 특성을 lift(고성과 출현율 / 저성과 출현율)로 낸다.
     표본이 작을 때 과신하지 않도록 최소 관측 수와 신뢰구간 폭을 함께 보고한다.
  2) LLM 규칙화 (별도, LEARN 프롬프트): 1)의 통계와 실제 자막·장면을 함께 모델에 주고
     사람이 읽을 수 있는 규칙으로 일반화. 1)이 없으면 LLM이 근거 없이 지어내므로 순서가 중요.

핵심 방법론:
  - 성과는 **절대 조회수 금지**, 이미 export가 ±90일 채널 중앙값 대비 tier로 정규화함.
  - hook/emotion은 모델이 자유 텍스트로 뱉어 값이 흩어진다 → 표준 카테고리로 스냅(_canon).
  - 표본이 작으면(각 tier <8) "방향성"으로만, 크면 "신호"로 격상 — 과장 방지.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from dataclasses import dataclass, asdict

# 파이프라인이 이미 쓰는 8개 훅 카테고리(core/channels.py HOOK_KEYS)로 스냅한다.
# 자유 텍스트 훅을 여기에 매핑 — 표본을 흩뿌리지 않고 모으기 위함.
_HOOK_CANON = {
    "반전": ["반전", "예상", "의외", "고정관념", "파괴", "뒤집"],
    "돌직구": ["돌직구", "단호", "직설", "팩트"],
    "갈등": ["갈등", "다툼", "언쟁", "분노", "대립", "싸움"],
    "웃음": ["웃음", "폭소", "코믹", "개그", "좌충우돌", "황당", "과몰입"],
    "공감": ["공감", "위로", "감동", "울컥", "짠"],
    "감정고조": ["감정", "고조", "긴장", "몰입", "격정", "공포", "놀라"],
    "질문": ["질문", "궁금", "떡밥"],
    "정보성": ["정보", "설명", "노하우", "꿀팁", "현실"],
}


def _canon(raw: str, table: dict[str, list[str]]) -> str:
    """자유 텍스트를 표준 카테고리로 스냅. 못 맞추면 '기타'."""
    s = (raw or "").strip()
    if not s:
        return "미상"
    for canon, keys in table.items():
        if any(k in s for k in keys):
            return canon
    return "기타"


@dataclass
class Signal:
    feature: str            # 예: "hook=반전"
    high_rate: float        # high tier에서 이 특성이 나온 비율
    low_rate: float         # low tier에서 나온 비율
    lift: float             # high_rate / low_rate (>1 = 고성과 특성, <1 = 결여 특성)
    high_n: int
    low_n: int
    note: str = ""


def _rate(items: list[str], value: str) -> tuple[float, int]:
    n = len(items)
    hit = sum(1 for x in items if x == value)
    return (hit / n if n else 0.0, hit)


def analyze(pairs: list[dict], min_desc: int = 6) -> dict:
    described = [p for p in pairs if (p.get("source") or {}).get("scene_summary")]
    by_tier: dict[str, list[dict]] = {"high": [], "mid": [], "low": []}
    for p in described:
        t = (p.get("performance") or {}).get("tier", "mid")
        by_tier.setdefault(t, []).append(p)

    high, low = by_tier["high"], by_tier["low"]
    result: dict = {
        "described": len(described),
        "high_n": len(high),
        "low_n": len(low),
        "ready": len(high) >= min_desc and len(low) >= min_desc,
    }

    if not (high and low):
        result["message"] = "high 또는 low tier의 설명이 아직 없어 대조 불가"
        return result

    # ── hook / emotion 대조 (표준 카테고리로 스냅 후) ──
    def feature_signals(field: str, table: dict | None) -> list[Signal]:
        def vals(ps):
            return [_canon(p["source"].get(field, ""), table) if table else (p["source"].get(field) or "미상")
                    for p in ps]
        hv, lv = vals(high), vals(low)
        cats = set(hv) | set(lv)
        out = []
        for c in cats:
            hr, hn = _rate(hv, c)
            lr, ln = _rate(lv, c)
            # 라플라스 보정 — 0으로 나눔·과장을 막는다.
            lift = (hr + 0.05) / (lr + 0.05)
            out.append(Signal(f"{field}={c}", round(hr, 3), round(lr, 3), round(lift, 2), hn, ln))
        return sorted(out, key=lambda s: -s.lift)

    result["hook_signals"] = [asdict(s) for s in feature_signals("hook", _HOOK_CANON)]
    result["emotion_signals"] = [asdict(s) for s in feature_signals("emotion", None)]

    # ── 구간 길이 대조 ──
    def seglen(ps):
        xs = [float(p["source"].get("segLenSec", 0)) for p in ps if p["source"].get("segLenSec")]
        return round(sum(xs) / len(xs), 1) if xs else 0.0
    result["seg_len"] = {"high_avg": seglen(high), "low_avg": seglen(low)}

    # ── 한 줄 해석 (통계 유의성은 표본이 커야 — 지금은 방향성) ──
    top_present = [s for s in result["hook_signals"] if s["lift"] >= 1.8 and s["high_rate"] >= 0.3]
    top_absent = [s for s in result["hook_signals"] if s["lift"] <= 0.55 and s["low_rate"] >= 0.3]
    result["reading"] = {
        "confidence": "신호(표본 충분)" if result["ready"] else "방향성만(표본 부족 — 확정 아님)",
        "high_tier_over": [s["feature"] for s in top_present],
        "low_tier_lacks": [s["feature"] for s in top_absent],
    }
    return result


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m core.point_profile <export.json> [min_desc]", file=sys.stderr)
        raise SystemExit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    pairs = data.get("pairs") if isinstance(data, dict) else data
    min_desc = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    print(json.dumps(analyze(pairs, min_desc), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

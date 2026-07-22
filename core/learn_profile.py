"""채널 포인트 규칙 학습 (LEARN) — 고성과 구간의 공통 특성을 규칙으로 뽑는다.

point_profile.py가 hook·emotion·길이의 '통계 대조'를 낸다면, 여기서는 그 통계 + 실제
자막·장면 텍스트를 **함께** Gemini에 주고, 사람이 읽고 적용할 수 있는 규칙으로 일반화한다.

왜 통계와 텍스트를 같이 주나: 통계만 주면 "반전 훅이 lift 1.4" 같은 숫자만 나오고 왜
그런지 모른다. 텍스트만 주면 모델이 근거 없이 지어낸다. 둘을 같이 줘야 "고성과는 명확한
한 방(주장/사건)이 있고 저성과는 상황 진행이라 뾰족한 순간이 없다" 같은 실행 가능한
규칙이 나온다.

출력: channel_point_profile — recommend.py 프롬프트에 그대로 넣을 수 있는 형태.
  {winning_patterns, avoid_patterns, optimal_length_sec, title_rules, confidence}

정직성: 표본이 작으면(각 tier <8) confidence를 낮추고 "방향성"으로만 낸다. 과장 금지.
"""

from __future__ import annotations

import json
import os
import sys

from google import genai
from google.genai import types

from .retry import call_with_retry
from .point_profile import analyze as stat_analyze

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "channel": {"type": "STRING"},
        "winning_patterns": {
            "type": "ARRAY", "items": {
                "type": "OBJECT",
                "properties": {
                    "pattern": {"type": "STRING", "description": "고성과 구간의 공통 특성 한 줄"},
                    "why": {"type": "STRING", "description": "왜 이게 성과로 이어지는가"},
                    "evidence": {"type": "ARRAY", "items": {"type": "STRING"},
                                 "description": "근거가 된 실제 숏폼 제목들"},
                },
                "required": ["pattern", "why"],
            },
        },
        "avoid_patterns": {
            "type": "ARRAY", "items": {"type": "STRING",
                "description": "저성과 구간에 공통으로 결여됐거나 있던 것(피해야 할 특성)"},
        },
        "optimal_length_sec": {
            "type": "OBJECT",
            "properties": {"min": {"type": "INTEGER"}, "max": {"type": "INTEGER"}},
            "required": ["min", "max"],
        },
        "title_rules": {"type": "ARRAY", "items": {"type": "STRING"}},
        "confidence": {"type": "NUMBER", "description": "0~1. 표본이 작으면 낮게."},
    },
    "required": ["channel", "winning_patterns", "avoid_patterns", "optimal_length_sec", "confidence"],
}

_PROMPT = """너는 한국 방송·미디어 숏폼 편성 분석가다. 아래는 한 유튜브 채널에서 실제 발행된 숏폼을
성과(같은 시기 채널 중앙값 대비 배수)로 high/low로 나눈 것이다. 각 항목은 그 숏폼이 잘려 나온
롱폼 구간의 자막·장면요약·훅·감정·길이를 담는다.

목표: **고성과(high) 구간이 저성과(low) 구간과 무엇이 다른가**를 규칙으로 뽑아라.
- 비교(고성과 평균 vs 저성과 평균)가 아니라, 고성과가 되게 만든 **소스 구간의 특성**을 찾아라.
- 반드시 실제 사례(제목)를 근거로 대라. 근거 없는 추측 금지.
- 통계 요약(아래 STATS)과 실제 내용을 함께 보고 판단하라. 숫자만으로도, 인상만으로도 안 된다.
- 표본이 작으면 confidence를 낮춰라. 없는 확신을 만들지 마라.

=== STATS (hook/emotion/길이 통계 대조) ===
{stats}

=== HIGH tier 구간 ({high_n}건) ===
{high_block}

=== LOW tier 구간 ({low_n}건) ===
{low_block}
"""


def _block(pairs: list[dict]) -> str:
    lines = []
    for p in pairs:
        s = p["source"]
        lines.append(
            f"- [×{p['performance']['ratio']:.1f}] {(p['short'].get('title') or '')[:40]}\n"
            f"  훅:{s.get('hook','')} 감정:{s.get('emotion','')} 길이:{int(s.get('segLenSec',0))}초\n"
            f"  자막: {(s.get('transcript') or s.get('transcript_slice') or '')[:160]}\n"
            f"  장면: {(s.get('scene_summary') or '')[:160]}"
        )
    return "\n".join(lines)


def learn(export: dict, min_desc: int = 5) -> dict:
    pairs = export.get("pairs") if isinstance(export, dict) else export
    described = [p for p in pairs if (p.get("source") or {}).get("scene_summary")]
    high = [p for p in described if (p.get("performance") or {}).get("tier") == "high"]
    low = [p for p in described if (p.get("performance") or {}).get("tier") == "low"]

    if len(high) < min_desc or len(low) < min_desc:
        return {
            "channel": export.get("channelName", "") if isinstance(export, dict) else "",
            "ready": False,
            "message": f"표본 부족 (high {len(high)}, low {len(low)} — 각 {min_desc}건 이상 필요)",
            "stats": stat_analyze(pairs),
        }

    stats = stat_analyze(pairs)
    prompt = _PROMPT.format(
        stats=json.dumps(stats.get("reading", {}), ensure_ascii=False),
        high_n=len(high), low_n=len(low),
        high_block=_block(sorted(high, key=lambda p: -p["performance"]["ratio"])),
        low_block=_block(sorted(low, key=lambda p: p["performance"]["ratio"])),
    )

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL, contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.2, response_mime_type="application/json", response_schema=_SCHEMA,
        ),
    ))
    profile = json.loads(resp.text or "{}")
    profile["ready"] = True
    profile["sample"] = {"high": len(high), "low": len(low), "described": len(described)}
    profile["stats"] = stats.get("reading", {})
    # recommend.py가 이미 읽는 프로파일 형식으로 변환 — 기존 스티어링 배선을 그대로 탄다.
    # 전체 통계(hook_signals)를 넘겨 hookWeights를 lift로 차등한다(균일 가중 회귀 방지).
    # + 실제 고/저성과 구간을 few-shot 예시로 첨부 — 추상 규칙보다 원본 예시가 LLM을 잘 이끈다(④).
    profile["recommend_profile"] = to_recommend_profile(profile, stats, _examples(high, low))
    return profile


def _examples(high: list[dict], low: list[dict], n: int = 3) -> dict:
    """실제 고성과/저성과 구간을 few-shot 예시로 뽑는다. 각 예시: 발행 숏폼 제목(무엇이 터졌나)
    + 소스 구간 자막 발췌(무슨 순간) + 성과 배수. recommend 프롬프트에 원본 예시로 들어간다."""
    def pick(pairs: list[dict], best: bool) -> list[dict]:
        ranked = sorted(pairs, key=lambda x: (x.get("performance") or {}).get("ratio", 0), reverse=best)
        out = []
        for p in ranked[:n]:
            s, src = p.get("short") or {}, p.get("source") or {}
            txt = (src.get("transcript_slice") or src.get("transcript") or src.get("scene_summary") or "")
            out.append({
                "title": (s.get("title") or "")[:50],
                "snippet": " ".join(str(txt).split())[:110],
                "hook": (src.get("hook") or "")[:12],
                "ratio": round(float((p.get("performance") or {}).get("ratio", 0)), 1),
            })
        return out
    return {"high": pick(high, True), "low": pick(low, False)}


# 훅 카테고리 매핑 (learn이 자유 텍스트로 훅을 뱉을 수 있어 8개 표준 키로 정규화)
_HOOK_MAP = {
    "반전": ["반전", "예상", "고정관념", "파괴"], "돌직구": ["돌직구", "단호", "소신", "직설"],
    "갈등": ["갈등", "분노", "다툼"], "웃음": ["웃음", "폭소", "코믹", "좌충우돌"],
    "공감": ["공감", "위로", "감동"], "감정고조": ["감정", "긴장", "몰입", "고조"],
    "질문": ["질문", "궁금", "호기심"], "정보성": ["정보", "설명", "리뷰"],
}


def to_recommend_profile(learned: dict, full_stats: dict | None = None, examples: dict | None = None) -> dict:
    """LEARN 규칙 → recommend/profile.ts가 읽는 ProgramProfile 형식.

    핵심은 hookWeights(고성과 훅을 1.0 위로 올림)와 targetLength·taboos·watchPoints다.
    recommend의 apply_profile_fit이 이 값들로 후보를 재랭킹한다 — 새 배선이 필요 없다.

    ⚠️ hookWeights는 **통계적 lift로 차등**한다. 2026-07-21 A/B 실측에서, 고성과 텍스트에
    언급된 훅을 전부 같은 1.3으로 올렸더니(5/8 훅 균일) 변별력이 없어 랭킹만 흔들려 Hit@5가
    0.67→0.33으로 떨어졌다. lift(고성과 출현율/저성과 출현율)>1이면 올리고 <1이면 내려야
    실제 신호가 된다. confidence로 강도를 눌러 소표본 과적합을 막는다."""
    conf = float(learned.get("confidence") or 0.5)
    gain = 0.5 * conf  # 가중 강도: conf 0.6 → 0.30, 1.0 → 0.5

    # 통계적 hook lift에서 차등 가중 (lift>1 우대, <1 억제). full_stats 없으면 텍스트 폴백.
    weights: dict[str, float] = {}
    hook_sigs = (full_stats or {}).get("hook_signals") if isinstance(full_stats, dict) else None
    if hook_sigs:
        for sig in hook_sigs:
            feat = sig.get("feature", "")  # "hook=반전"
            if not feat.startswith("hook="):
                continue
            hook = feat.split("=", 1)[1]
            if hook not in _HOOK_MAP or (sig.get("high_n", 0) + sig.get("low_n", 0)) < 2:
                continue
            lift = float(sig.get("lift") or 1.0)
            # lift 1.0을 기준으로 위/아래로, gain만큼만. [0.6, 1.6]로 클램프(극단 방지).
            w = 1.0 + gain * (min(2.5, max(0.4, lift)) - 1.0)
            weights[hook] = round(min(1.6, max(0.6, w)), 2)
    else:
        # 폴백: 통계 없으면 고성과 텍스트 언급 훅만 약하게(+gain).
        win_text = " ".join((p.get("pattern", "") + " " + p.get("why", ""))
                            for p in learned.get("winning_patterns", []))
        for hook, keys in _HOOK_MAP.items():
            if any(k in win_text for k in keys):
                weights[hook] = round(1.0 + gain, 2)

    length = learned.get("optimal_length_sec") or {}
    lo, hi = length.get("min"), length.get("max")
    target = f"{lo}~{hi}초" if lo and hi else ""

    return {
        "programName": learned.get("channel", ""),
        "formatGrammar": "; ".join(p.get("pattern", "") for p in learned.get("winning_patterns", [])[:3]),
        "watchPoints": [p.get("pattern", "") for p in learned.get("winning_patterns", [])][:8],
        "hookWeights": weights,
        "taboos": learned.get("avoid_patterns", [])[:6],
        "memes": [],
        "editTone": "",
        "targetLength": target,
        "castType": "",
        # ④ few-shot: 실제 고/저성과 구간 예시 — recommend 프롬프트에 원본으로 주입
        "examples": examples or {},
        # 출처 표식 — 프로그램 프로파일(사람 입력)과 구분, confidence 추적용
        "_source": "learned",
        "_confidence": conf,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m core.learn_profile <export.json|-> [min_desc]", file=sys.stderr)
        raise SystemExit(2)
    if sys.argv[1] == "-":  # 워커 경로: stdin으로 export JSON
        export = json.load(sys.stdin)
        min_desc = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    else:
        with open(sys.argv[1], encoding="utf-8") as f:
            export = json.load(f)
        min_desc = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    print(json.dumps(learn(export, min_desc), ensure_ascii=False))


if __name__ == "__main__":
    main()

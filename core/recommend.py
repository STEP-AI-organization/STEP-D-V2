"""
STEP D Core — Shorts recommendation (two-phase, genre-aware)

Reads the analyzed scene timeline (scenes.json: per-scene visual analysis + dialogue
+ name captions + vision score) and picks the best short-form clips in TWO passes:

  Phase 1 후보 추출 — the timeline is split into chunks (~80 scenes / ~10 min each,
    small overlap) and each chunk is scanned independently for candidate moments.
    Chunking keeps every scene inside a small, fully-attended context — late scenes
    no longer fade at the end of one giant prompt — and chunks run in parallel.
  Phase 2 합성 — one reasoning call sees ALL candidates (with evidence) and selects,
    merges, and ranks the final N, scoring each 1–5 on viral appeal. The appeal score
    is the model's judgment, not a mechanical rank inversion.

Genre matters: a sports highlight and a talk-show punchline are cut differently.
The prompt carries a per-genre pack (GENRE_PACKS); pass --genre or let "auto"
classify the content from the transcript sample first.

Temperature 0 everywhere: re-running the same video yields the same picks, so the
DELETE+INSERT re-wire on the recommendation board is stable across retries.

Run:
    python -m core.recommend core/scenes.json
    python -m core.recommend core/scenes.json --n 8 --genre variety
"""
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

WORKERS = 4          # parallel Phase-1 chunk calls
CHUNK_SCENES = 80    # max scenes per Phase-1 chunk (keeps the prompt fully attended)
CHUNK_MAX_SEC = 600  # …or max 10 minutes of footage, whichever comes first
CHUNK_OVERLAP = 6    # scenes repeated from the previous chunk so a bit spanning the cut isn't lost
PER_CHUNK = 6        # candidate cap per chunk (Phase 2 prunes)
MIN_SHORT_SEC = 3    # anything shorter is a glitch, not a short
MAX_SHORT_SEC = 180  # anything longer isn't a short

# ── genre packs ─────────────────────────────────────────────────────────────────
# What "터지는 구간" means differs by genre; the pack swaps the editorial judgment,
# the mechanics (완결 단위, 훅, 15~60s) stay shared.

GENRE_PACKS: dict[str, dict[str, str]] = {
    "variety": {
        "label": "예능/버라이어티",
        "guidance": """- 리액션·표정·몸개그·폭소 순간과 그 직전 빌드업을 한 단위로 묶어라.
- 방송 자막(밈 자막·상황 자막)이 박힌 순간은 편집자가 이미 찍은 포인트다 — 우선 포함.
- 훅(초반 시선강탈) → 전개 → 펀치라인/마무리가 서는 완결된 재미 단위만.
- 단순 정보전달/평범한 대화/인트로는 제외.""",
    },
    "talk": {
        "label": "토크/인터뷰",
        "guidance": """- 질문 → 핵심 답변(폭탄발언·의외의 고백·명언)을 한 단위로. 답변만 자르면 맥락이 죽는다.
- 게스트의 감정 변화(웃음·정색·울컥)가 드러나는 리액션 컷을 포함하라.
- 한 주제의 완결된 문답 단위. 주제를 넘나드는 긴 구간은 피한다.""",
    },
    "drama": {
        "label": "드라마/연기",
        "guidance": """- 감정의 절정(고백·오열·분노·반전)과 명대사를 중심으로, 이해에 필요한 최소 맥락만 앞에 붙여라.
- 관계가 뒤집히는 전환점, 시청자가 멈추게 되는 표정 클로즈업 우선.
- 스포일러가 되어도 임팩트가 최우선이다. 잔잔한 설명 신은 제외.""",
    },
    "sports": {
        "label": "스포츠",
        "guidance": """- 득점·역전·슈퍼플레이·결정적 실책 순간과 그 직전 빌드업(세트업 플레이)을 한 단위로.
- 세리머니·벤치/관중 리액션·리플레이가 이어지면 함께 포함하라.
- 해설의 샤우팅이 있는 순간은 강한 신호다. 경기 흐름 설명 구간은 제외.""",
    },
    "news": {
        "label": "뉴스/시사",
        "guidance": """- 핵심 발언·단독 정보·팩트 요약이 한 문장으로 서는 구간을 골라라.
- 발언은 오해가 생기지 않도록 앞뒤 맥락을 포함한 완결 단위로 자른다 (왜곡 금지).
- 자극적이기만 하고 정보가 없는 구간, 앵커 멘트만 있는 구간은 제외.""",
    },
    "music": {
        "label": "음악/공연",
        "guidance": """- 후렴·고음·댄스브레이크·킬링파트 등 무대의 하이라이트를 중심으로.
- 무대 전 긴장/무대 후 리액션(심사평·관객 반응)이 강하면 함께 후보로.
- 곡의 마디가 어색하게 끊기지 않는 지점에서 자른다.""",
    },
    "documentary": {
        "label": "다큐/교양",
        "guidance": """- 놀라운 사실 하나가 완결되게 전달되는 '지식 한 조각' 단위로 잘라라.
- 비주얼 스펙터클(자연·현장)과 감동적 순간(인물 서사의 절정) 우선.
- 도입부의 배경 설명은 최소화하고 핵심 장면으로 바로 들어가는 구간을 골라라.""",
    },
}
DEFAULT_GENRE = "variety"


def _pack(genre: str) -> dict[str, str]:
    return GENRE_PACKS.get(genre, GENRE_PACKS[DEFAULT_GENRE])


# The 8 hook categories the program profile weights.
HOOK_KEYS = ("반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감")


def _profile_block(profile: dict | None) -> str:
    """A steering block appended to the system prompt when a program profile is set —
    watch-points, taboos, tone, target length, and which hooks this program prizes.
    Returns '' (no-op) when there's no profile signal (non-destructive)."""
    if not profile or not isinstance(profile, dict):
        return ""
    hw = profile.get("hookWeights") or {}
    prized = [k for k in HOOK_KEYS if isinstance(hw.get(k), (int, float)) and hw.get(k) > 1.0]
    lines = ["", "이 프로그램의 이해 프로파일(우선 반영):"]
    if profile.get("formatGrammar"):
        lines.append(f"- 포맷 문법: {profile['formatGrammar']}")
    if profile.get("watchPoints"):
        lines.append("- 주목 포인트: " + ", ".join(str(w) for w in profile["watchPoints"][:8]))
    if prized:
        lines.append("- 특히 중요한 훅: " + ", ".join(prized) + " (이런 훅이 살아있는 구간을 우대)")
    if profile.get("taboos"):
        lines.append("- 금기(넣지 마라): " + ", ".join(str(t) for t in profile["taboos"][:6]))
    if profile.get("editTone"):
        lines.append(f"- 편집 톤: {profile['editTone']}")
    if profile.get("targetLength"):
        lines.append(f"- 목표 길이: {profile['targetLength']} 에 맞는 완결 구간 우선")
    if profile.get("castType"):
        lines.append(f"- 출연진: {profile['castType']}")
    # ④ few-shot: 이 채널에서 실제로 터진/안 터진 구간 예시. 추상 규칙보다 원본 예시가 훨씬
    # 잘 이끈다 — "이런 순간을 찾아라 / 이런 건 피해라"를 구체 사례로 보여준다.
    ex = profile.get("examples") or {}
    hi_ex, lo_ex = ex.get("high") or [], ex.get("low") or []
    if hi_ex:
        lines.append("- 이 채널에서 **실제로 터진 순간** 예시 (이런 걸 찾아라):")
        for e in hi_ex[:3]:
            snip = f' — "{e.get("snippet")}"' if e.get("snippet") else ""
            lines.append(f"    · [×{e.get('ratio','?')}] {e.get('title','')}{snip}")
    if lo_ex:
        lines.append("- 이 채널에서 **안 터진** 예시 (이런 건 피하라):")
        for e in lo_ex[:3]:
            snip = f' — "{e.get("snippet")}"' if e.get("snippet") else ""
            lines.append(f"    · [×{e.get('ratio','?')}] {e.get('title','')}{snip}")
    lines.append("- 각 후보의 hook 필드에 위 8개 훅 카테고리 중 가장 잘 맞는 하나(없으면 '기타')를 반드시 채워라.")
    return "\n".join(lines)


def _base_system(genre: str, profile: dict | None = None) -> str:
    p = _pack(genre)
    return f"""너는 {p['label']} 콘텐츠의 숏폼(쇼츠) 편집 전문가다. 아래는 영상을 장면 단위로 분석한
타임라인이다. 각 줄: [장면번호] 시작초~끝초 (시:분 표기, 길이) | 화면분석 | 대사 | 등장인물(화면자막) | 시각점수(0-100).

이 장르에서 쇼츠로 터지는 구간의 기준:
{p['guidance']}

공통 규칙(긴 영상에서 숏폼(쇼츠)을 뽑는 편집자의 눈으로):
- 하나의 완결된 '장면'을 담아라 — 펀치라인 한 순간이 아니라, 그 순간이 터지게 만드는
  짧은 빌드업(질문·상황설정·긴장)부터 리액션·마무리까지. 맥락이 있어야 웃음·감동이 터진다.
- 훅은 앞쪽에 두되(첫 2~3초 안에 관심), 그렇다고 펀치라인만 잘라내지 마라. 셋업 없이
  결정타만 있으면 왜 웃긴지 몰라 넘긴다 — 실제 잘 나가는 쇼츠는 셋업→터짐→여운을 담는다.
- **길이는 30~60초를 기본으로 하라.** 이보다 짧으면 대개 맥락이 잘려 약해진다. 20초 미만은
  정말 그 한 컷으로 완결될 때만. start/end는 장면·문장 경계에서 깔끔히 끊어라.
- appeal은 바이럴 잠재력의 절대평가다: 5=확실히 터진다, 4=강함, 3=쓸만함, 2=약함, 1=비추천.{_profile_block(profile)}"""


def _parse_target_len(profile: dict | None) -> float | None:
    """Pull a target-length seconds hint out of profile.targetLength (e.g. '30~45초' → 37.5)."""
    if not profile:
        return None
    import re
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", str(profile.get("targetLength", "")))]
    return (sum(nums) / len(nums)) if nums else None


def apply_profile_fit(shorts: list[dict], profile: dict | None, duration: float) -> list[dict]:
    """Program-fit re-ranking (non-destructive when profile has no signal):
      - taboos: drop candidates whose text hits a taboo term (hard filter)
      - hookWeights: multiply by the candidate's hook-category weight
      - targetLength: multiply by a length-proximity factor
    final_score = appeal(융합점수) × program_fit. Re-ranks by final_score."""
    if not profile or not isinstance(profile, dict):
        return shorts
    hw = profile.get("hookWeights") or {}
    weights = {k: float(hw[k]) for k in HOOK_KEYS if isinstance(hw.get(k), (int, float))}
    taboos = [str(t).strip() for t in (profile.get("taboos") or []) if str(t).strip()]
    target = _parse_target_len(profile)
    if not weights and not taboos and target is None:
        return shorts  # nothing to apply

    out = []
    for s in shorts:
        blob = " ".join([str(s.get("title", "")), str(s.get("reason", "")), " ".join(s.get("tags", []) or [])])
        if any(t in blob for t in taboos):
            print(f"   (프로파일 금기 제외: {str(s.get('title',''))[:30]})")
            continue
        hook_w = weights.get(str(s.get("hook", "")).strip(), 1.0)
        length = max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
        len_fit = 1.0
        if target and target > 0 and length > 0:
            len_fit = max(0.55, 1.0 - abs(length - target) / target * 0.5)
        program_fit = round(hook_w * len_fit, 3)
        appeal = s.get("appeal")
        base = float(appeal) if isinstance(appeal, (int, float)) else 3.0
        s = {**s, "program_fit": program_fit, "final_score": round(base * program_fit, 3)}
        out.append(s)

    out.sort(key=lambda s: -s.get("final_score", 0.0))
    for i, s in enumerate(out, 1):
        s["rank"] = i
    return out


def apply_learned_rerank(
    shorts: list[dict],
    scenes: list[dict],
    model=None,
    channel_ctx: dict | None = None,
) -> list[dict]:
    """RESERVED — the learned re-ranking layer. Currently a no-op by design.

    This is the seat the feasibility study (docs/research/highlight-model-feasibility.md §5-1)
    reserves for a trained scorer (LightGBM over the tabular features already persisted in
    `content_analysis.data`): `final = appeal × program_fit × channel_fit × learned`. It sits
    at THIS layer — after Gemini's judgment, alongside apply_profile_fit/apply_channel_fit —
    so Gemini keeps making the creative call and the model only re-ranks.

    Not implemented: the study's 1단계 (label/feature join + offline dataset) and 2단계
    (offline A/B gate) must land first. Shipping an untrained scorer here would degrade the
    pick with no evidence it helps. The signature is fixed now so the call site doesn't have
    to change when the model arrives; until then `model=None` returns the input untouched.
    """
    if model is None:
        return shorts
    raise NotImplementedError(
        "학습형 재랭킹은 아직 미구현 — 오프라인 데이터셋/AB 게이트(§7 1~2단계) 통과 후 편입"
    )


# ── genre auto-detection ────────────────────────────────────────────────────────

_DETECT_SCHEMA = {
    "type": "OBJECT",
    "properties": {"genre": {"type": "STRING", "enum": list(GENRE_PACKS.keys())}},
    "required": ["genre"],
}


def detect_genre(client, scenes: list[dict]) -> str:
    """One cheap text call: classify the content from a transcript/vision sample."""
    dialogue = [s["text"].strip() for s in scenes if (s.get("text") or "").strip()][:50]
    visions = [s["vision_reason"] for s in scenes if s.get("vision_reason")][:15]
    names = Counter(nm for s in scenes for nm in s.get("on_screen_names", []))
    texts = Counter(t for s in scenes for t in s.get("on_screen_text", []))
    sample = (
        "대사 샘플:\n" + "\n".join(f"- {d[:80]}" for d in dialogue)
        + "\n\n화면 분석 샘플:\n" + "\n".join(f"- {v[:80]}" for v in visions)
        + "\n\n화면 자막 인물: " + (", ".join(n for n, _ in names.most_common(10)) or "-")
        + "\n화면 텍스트 샘플: " + ("; ".join(t for t, _ in texts.most_common(10)) or "-")
    )
    labels = ", ".join(f"{k}({v['label']})" for k, v in GENRE_PACKS.items())
    try:
        # 429/503 일시 오류는 제자리 백오프 재시도 (실패 시 기본 장르 폴백은 그대로).
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=f"다음은 한 영상의 분석 샘플이다. 이 콘텐츠의 장르를 하나 골라라: {labels}\n\n{sample}",
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=_DETECT_SCHEMA,
                max_output_tokens=256,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        g = json.loads(resp.text or "{}").get("genre", DEFAULT_GENRE)
        return g if g in GENRE_PACKS else DEFAULT_GENRE
    except Exception as e:
        print(f"   (장르 감지 실패 → {DEFAULT_GENRE}: {str(e)[:80]})")
        return DEFAULT_GENRE


# ── timeline formatting + chunking ──────────────────────────────────────────────

def _mmss(s: float) -> str:
    s = int(s)
    if s >= 3600:  # 1시간 이상은 h:mm:ss — 75:30 같은 모호한 표기를 피한다
        return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"
    return f"{s // 60}:{s % 60:02d}"


def build_timeline(scenes: list[dict]) -> str:
    lines = []
    for s in scenes:
        names = ",".join(s.get("on_screen_names", []))
        vis = s.get("vision_reason", "")
        txt = (s.get("text") or "").strip() or "-"
        score = s.get("vision_score")
        # 원시 초를 함께 표기 — 모델이 start/end로 되돌려줄 값은 이 초 값이다
        # (mm:ss만 주면 모델이 초로 환산하다 어긋난다).
        lines.append(
            f"[{s['index']}] {float(s['start']):.1f}~{float(s['end']):.1f}초"
            f" ({_mmss(s['start'])}~{_mmss(s['end'])}, {s['duration']:.0f}s)"
            f" | 화면:{vis} | 대사:{txt} | 인물:{names or '-'} | 시각:{score if score is not None else '-'}"
        )
    return "\n".join(lines)


def chunk_scenes(
    scenes: list[dict],
    max_scenes: int = CHUNK_SCENES,
    max_sec: float = CHUNK_MAX_SEC,
    overlap: int = CHUNK_OVERLAP,
) -> list[list[dict]]:
    """Split the timeline into overlapping windows small enough to stay fully attended."""
    if not scenes:
        return []
    chunks: list[list[dict]] = []
    i = 0
    while i < len(scenes):
        start_t = scenes[i]["start"]
        j = i
        while j < len(scenes) and (j - i) < max_scenes and (scenes[j]["end"] - start_t) <= max_sec:
            j += 1
        if j == i:  # a single scene longer than max_sec — take it alone
            j = i + 1
        chunks.append(scenes[i:j])
        if j >= len(scenes):
            break
        # Step back a little so a bit spanning the cut isn't split — but never more
        # than a third of the chunk, or short chunks would advance one scene at a time.
        i = j - min(overlap, (j - i) // 3)
    return chunks


# ── Phase 1: per-chunk candidate extraction ─────────────────────────────────────

_CANDIDATE_FIELDS = {
    "start": {"type": "NUMBER"},
    "end": {"type": "NUMBER"},
    "title": {"type": "STRING"},
    "reason": {"type": "STRING"},
    "appeal": {"type": "INTEGER"},
    "scene_from": {"type": "INTEGER"},
    "scene_to": {"type": "INTEGER"},
    "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
    # Primary hook category (반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타) — used with
    # the program profile's hookWeights to compute a program-fit multiplier.
    "hook": {"type": "STRING"},
}

_PHASE1_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "candidates": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": _CANDIDATE_FIELDS,
                "required": ["start", "end", "title", "reason", "appeal"],
            },
        },
    },
    "required": ["candidates"],
}


def _extract_candidates(client, chunk: list[dict], genre: str, profile: dict | None = None) -> list[dict]:
    system = _base_system(genre, profile) + f"""

지금 보는 타임라인은 전체 영상의 일부 구간이다. 이 구간 안에서만 후보를 골라라.
- 최대 {PER_CHUNK}개. 확신 없는 구간은 넣지 마라 — 0개도 답이다.
- start/end는 타임라인 각 줄에 표기된 '초' 값(예: 754.2~779.8초)을 그대로 복사하라.
  분:초 표기를 초로 환산해 쓰지 마라.
- 각 후보: start(초), end(초), title(클릭 유도 한국어 제목), reason(왜 터지는지 한 문장),
  appeal(1-5 절대평가), scene_from/scene_to(포함 장면번호), tags(리액션/폭소/반전/서사/자막 등),
  hook(반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타 중 가장 잘 맞는 하나)."""
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=f"이 구간에서 쇼츠 후보를 골라라.\n\n=== 장면 타임라인 ({_mmss(chunk[0]['start'])}~{_mmss(chunk[-1]['end'])}) ===\n{build_timeline(chunk)}",
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="application/json",
            response_schema=_PHASE1_SCHEMA,
            # A long scene timeline can yield many candidates — give the JSON the full
            # output budget (default dynamic thinking tokens were truncating it).
            max_output_tokens=8192,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    ))
    return json.loads(resp.text or "{}").get("candidates", [])


# ── Phase 2: global synthesis ───────────────────────────────────────────────────

_PHASE2_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "shorts": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"rank": {"type": "INTEGER"}, **_CANDIDATE_FIELDS},
                "required": ["rank", "start", "end", "title", "reason", "appeal"],
            },
        },
    },
    "required": ["shorts"],
}


def _synthesize(client, candidates: list[dict], n: int, genre: str, duration: float, profile: dict | None = None) -> list[dict]:
    lines = []
    for i, c in enumerate(sorted(candidates, key=lambda c: c.get("start", 0)), 1):
        tags = "/".join(c.get("tags", []))
        # 원시 초를 함께 표기 — start/end는 이 초 값을 그대로 복사받는다.
        lines.append(
            f"[후보{i}] {float(c.get('start', 0)):.1f}~{float(c.get('end', 0)):.1f}초"
            f" ({_mmss(c.get('start', 0))}~{_mmss(c.get('end', 0))})"
            f" | appeal:{c.get('appeal', '-')} | {c.get('title', '')} | {c.get('reason', '')}"
            f" | 장면:{c.get('scene_from', '-')}~{c.get('scene_to', '-')} | {tags or '-'}"
        )
    system = _base_system(genre, profile) + f"""

아래는 영상 전체({_mmss(duration)})를 구간별로 스캔해 뽑은 쇼츠 후보 목록이다.
이 중에서 최종 {n}개를 골라 순위를 매겨라.
- start/end는 후보에 표기된 '초' 값(예: 754.2~779.8초)을 그대로 복사하라.
  분:초 표기를 초로 환산해 쓰지 마라.
- 겹치거나 바로 이어지는 후보는 하나로 병합해도 된다 (start/end를 병합 범위로).
- 후보 목록에 없는 새로운 구간을 만들지 마라.
- 비슷한 종류만 몰리지 않게, 영상 전체를 대표하도록 다양성도 고려하라.
- 각 항목: rank(1=최고), start, end, title, reason, appeal(1-5 절대평가 — 순위와 별개),
  scene_from/scene_to, tags, hook(반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타 중 하나)."""
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=f"최종 쇼츠 {n}개를 골라라.\n\n=== 후보 목록 ===\n" + "\n".join(lines),
        config=types.GenerateContentConfig(
            system_instruction=system,
            temperature=0,
            response_mime_type="application/json",
            response_schema=_PHASE2_SCHEMA,
            # NOTE: intentionally NO thinking_budget=0 here — Phase 2 is the deliberate
            # reasoning call (sees all candidates + evidence and selects). Only guard against
            # a blocked/empty response; the caller degrades to best candidates on empty.
        ),
    ))
    return json.loads(resp.text or "{}").get("shorts", [])


# ── validation ──────────────────────────────────────────────────────────────────

# 모델이 펀치라인만 짧게 뽑는 경향 보정용 하한. 실측(2026-07-21 홀드아웃): 현행 엔진은
# 4~8초로 자르는데 실제 발행 숏폼은 33~41초였다 — 셋업이 잘려 IoU가 무너졌다. 30초 미만은
# 장면 경계로 전방 확장해 이 창에 맞춘다(휴리스틱 폴백 HEUR_AIM/MIN과 같은 규범).
VALIDATE_MIN_SEC = 30.0
VALIDATE_AIM_SEC = 45.0
VALIDATE_MAX_SEC = 60.0  # 짧은 구간 확장 시 넘지 않는 상한(하드 실링 MAX_SHORT_SEC=180과 별개)


def _extend_to_min(start: float, end: float, scenes: list[dict] | None,
                   aim: float = VALIDATE_AIM_SEC, hard_max: float = VALIDATE_MAX_SEC) -> tuple[float, float]:
    """너무 짧은 구간을 장면 경계에 맞춰 목표 길이까지 늘린다.
    모델이 잡은 지점(펀치라인)은 대개 '터지는 순간'이라, 앞으로 확장해 셋업을 담고 뒤로도
    조금 확장해 여운을 담는다 — 실제 편집자의 30~60초 클립이 그렇게 구성된다.
    scenes가 있으면 장면 경계로 스냅해 깔끔히 끊고, 없으면 시간으로만 늘린다."""
    if end - start >= VALIDATE_MIN_SEC:
        return start, end
    if scenes:
        bounds = [(float(s["start"]), float(s["end"])) for s in scenes
                  if isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float))
                  and float(s["end"]) > float(s["start"])]
        starts_before = sorted((a for a, _ in bounds if a < start), reverse=True)
        ends_after = sorted(b for _, b in bounds if b > end)
        # 앞뒤를 번갈아 넓혀 균형 있게 aim에 도달한다(셋업:여운 ≈ 2:1이 되도록 앞을 먼저).
        fi = ei = 0
        for step in range(len(starts_before) + len(ends_after)):
            if end - start >= aim:
                break
            widen_front = (step % 3 != 2) and fi < len(starts_before)  # 3번 중 2번은 앞
            if widen_front:
                cand = starts_before[fi]; fi += 1
                if end - cand <= hard_max:
                    start = cand
            elif ei < len(ends_after):
                cand = ends_after[ei]; ei += 1
                if cand - start <= hard_max:
                    end = cand
    if end - start < VALIDATE_MIN_SEC:  # 장면이 부족하면 시간으로라도 채운다
        end = start + min(aim, hard_max)
    return max(0.0, start), end


# 발화 경계 스냅 — 클립이 대사 중간에서 시작하거나 문장을 뚝 끊는 걸 막는다.
# 장면 경계(시각적 컷)는 침묵이 아니라 말하는 도중일 수 있어, 그대로 자르면 "갑자기 대사 시작"·
# "말 끊김"이 난다. STT 발화(utterance) 타임스탬프로 경계를 자연스러운 지점으로 옮긴다.
SPEECH_SNAP_WINDOW = 2.5  # 이 범위 안에서만 스냅 — 넘으면 클립을 왜곡하므로 손대지 않는다.


def _snap_to_speech(start: float, end: float, utterances: list[dict] | None,
                    window: float = SPEECH_SNAP_WINDOW) -> tuple[float, float]:
    """클립 경계가 발화 도중이면 자연스러운 지점으로 옮긴다.

    시작: 발화 도중이면 그 발화 처음으로 당겨 문장 앞부터 시작. 발화 시작이 window보다 멀면
          그 발화를 건너뛰고 다음 대사 시작으로 밀어 깔끔히 연다.
    끝:   발화 도중이면 그 발화 끝까지 늘려 문장을 완결. 발화 끝이 window보다 멀면 그 발화
          앞으로 당겨 직전 대사에서 끝낸다.
    어느 경계든 window(기본 2.5s) 밖이면 손대지 않는다 — 침묵 구간의 장면 컷은 이미 깔끔하다."""
    utts = sorted(
        (float(u["start"]), float(u["end"])) for u in (utterances or [])
        if isinstance(u.get("start"), (int, float)) and isinstance(u.get("end"), (int, float))
        and float(u["end"]) > float(u["start"])
    )
    if not utts:
        return start, end
    ns, ne = start, end
    for us, ue in utts:
        if us >= start:
            break
        if us < start < ue:                        # 발화 도중에서 시작
            if start - us <= window:
                ns = us                            # 문장 처음부터 (앞으로 당김)
            elif ue - start <= window:
                ns = ue                            # 이 대사 건너뛰고 다음부터 (뒤로 밀기)
            break
    for us, ue in utts:
        if us >= end:
            break
        if us < end < ue:                          # 발화 도중에서 끝
            if ue - end <= window:
                ne = ue                            # 문장 끝까지 (뒤로 늘림)
            elif end - us <= window:
                ne = us                            # 직전 대사에서 끝 (앞으로 당김)
            break
    # 스냅이 구간을 뒤집거나 절반 넘게 깎으면 원복(안전장치)
    if ne - ns >= max(float(MIN_SHORT_SEC), (end - start) * 0.5):
        return round(ns, 1), round(ne, 1)
    return start, end


def validate_shorts(shorts: list[dict], duration: float, n: int,
                    candidates: list[dict] | None = None,
                    scenes: list[dict] | None = None,
                    transcript: list[dict] | None = None) -> list[dict]:
    """Clamp/normalize the model output; drop degenerate spans instead of 'fixing' them.
    candidates가 있으면 모델이 돌려준 구간을 1단계 후보에 대조한다: start가 어떤 후보의
    start와 ±3s면 그 후보의 정확한 값으로 스냅(모델의 분:초 환산 오차 제거), 모든 후보와
    15s 넘게 어긋나면 지어낸 구간으로 보고 버린다 (2단계 규칙: 후보 밖 구간 금지).
    scenes가 있으면 너무 짧은 구간을 장면 경계로 전방 확장해 30~60초 창에 맞춘다."""
    snap: list[tuple[float, float]] = []
    for c in candidates or []:
        try:
            snap.append((float(c.get("start", 0)), float(c.get("end", 0))))
        except (TypeError, ValueError):
            continue

    out = []
    for s in shorts:
        try:
            start = max(0.0, float(s.get("start", 0)))
            end = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if snap:
            near = min(snap, key=lambda c: abs(c[0] - start))
            dev = abs(near[0] - start)
            if dev <= 3.0:
                start, end = near
            elif dev > 15.0:
                print(f"   (후보와 불일치 {dev:.0f}s → 제외: {str(s.get('title', ''))[:30]})")
                continue
        # 역전/영길이 구간은 '3초로 늘리기'가 아니라 제외 — start>=end는 데이터가 아니라 오류다.
        if end <= start:
            print(f"   (역전/영길이 구간 제외 {start:.1f}~{end:.1f}s: {str(s.get('title', ''))[:30]})")
            continue
        if duration > 0:
            start = min(start, duration)
            end = min(end, duration)
        length = end - start
        if length > MAX_SHORT_SEC:
            # Over-length → TRIM the tail instead of dropping (the hook is usually early).
            # Dropping here is exactly how a whole board went empty; trimming keeps the pick.
            print(f"   (길이 초과 {length:.0f}s → {MAX_SHORT_SEC}s 트림: {s.get('title', '')[:30]})")
            end = start + MAX_SHORT_SEC
        elif length < 1.0:
            # 1초 미만은 데이터 오류 — 확장으로 살리지 않고 버린다.
            print(f"   (후보 제외 — 길이 {length:.1f}s: {s.get('title', '')[:30]})")
            continue
        elif length < VALIDATE_MIN_SEC:
            # 펀치라인만 짧게 뽑힌 것 → 장면 경계로 전방 확장해 30~60초 창에 맞춘다.
            start, end = _extend_to_min(start, end, scenes)
            if duration > 0:
                end = min(end, duration)
            print(f"   (짧은 구간 확장 {length:.0f}s → {end - start:.0f}s: {s.get('title', '')[:30]})")
        # 최종 다듬기: 발화 경계로 스냅해 대사 중간 시작/끊김 방지 (길이 재조정은 하지 않는다).
        if transcript:
            snapped = _snap_to_speech(start, end, transcript)
            if snapped != (round(start, 1), round(end, 1)) and snapped != (start, end):
                print(f"   (발화 스냅 {start:.1f}~{end:.1f} → {snapped[0]:.1f}~{snapped[1]:.1f}: {str(s.get('title', ''))[:24]})")
            start, end = snapped
        appeal = s.get("appeal")
        try:
            appeal = max(1, min(5, int(appeal)))
        except (TypeError, ValueError):
            appeal = None
        out.append({**s, "start": round(start, 1), "end": round(end, 1), "appeal": appeal})

    # Order by the model's rank when present, else by appeal — then re-number 1..n.
    out.sort(key=lambda s: (s.get("rank") if isinstance(s.get("rank"), int) else 99, -(s.get("appeal") or 0)))
    out = out[:n]
    for i, s in enumerate(out, 1):
        s["rank"] = i
        if s["appeal"] is None:
            s["appeal"] = max(1, 6 - i)  # last-resort fallback, not the normal path
    return out


# ── guaranteed floor: hook-first mechanical picker ───────────────────────────────
# When the AI path yields nothing shippable (model found nothing / synthesis flaked /
# everything trimmed away), the board must NOT go empty. This cuts shorts the way a
# shorts editor would from long-form: START at the hook (the peak) — no build-up, no
# intro — and extend FORWARD to fill the 30~60s window, snapping to scene boundaries.
# No model calls.

HEUR_AIM_SEC = 45.0      # target shorts length
HEUR_MIN_SEC = 30.0      # the 30~60s window to land in when the material allows
HEUR_MAX_SEC = 60.0      # the floor never cuts longer than this (validate's 180s is the hard ceiling)


def _scene_signal(s: dict) -> float:
    """0-1 'this is a payoff moment' score from whatever signals a scene carries —
    Gemini/heuristic vision score, dialogue density, on-screen captions."""
    vs = s.get("vision_score")
    vis = (float(vs) / 100.0) if isinstance(vs, (int, float)) else 0.4
    hs = s.get("heur_score")
    if isinstance(hs, (int, float)):
        vis = 0.6 * vis + 0.4 * (float(hs) / 100.0)
    dur = max(0.1, float(s.get("duration") or (float(s.get("end", 0)) - float(s.get("start", 0))) or 1.0))
    dialogue = min(1.0, (len((s.get("text") or "").strip()) / dur) / 12.0)  # ~12 chars/s = dense
    caption = 1.0 if (s.get("on_screen_text") or s.get("on_screen_names")) else 0.0
    return round(0.6 * vis + 0.3 * dialogue + 0.1 * caption, 4)


def _heur_title(s: dict) -> str:
    names = s.get("on_screen_names") or []
    if names:
        return f"{names[0]} 하이라이트"
    txt = (s.get("text") or "").strip()
    if txt:
        return f"“{txt[:18]}…”" if len(txt) > 18 else f"“{txt}”"
    ost = s.get("on_screen_text") or []
    if ost:
        return str(ost[0])[:20]
    return "하이라이트 구간"


def _heur_tags(window: list[dict]) -> list[str]:
    tags = []
    if any((s.get("text") or "").strip() for s in window):
        tags.append("대사")
    if any((s.get("on_screen_text") or s.get("on_screen_names")) for s in window):
        tags.append("자막")
    if not tags:
        tags.append("하이라이트")
    return tags


def _cut_from_hook(seed: int, usable: list[dict], used: list[bool], aim: float, hard_max: float) -> tuple[int, int, float, float]:
    """Cut a short that STARTS at the hook (the peak scene) — no lead-in — and extends
    FORWARD to the aim length, snapping to whole scenes (clean boundaries). Only pulls
    backward as a last-resort fallback when the peak sits too near the end to fill forward
    (a stub is worse than a hair of preceding context)."""
    lo = hi = seed
    start, end = float(usable[seed]["start"]), float(usable[seed]["end"])

    while end - start < aim and hi + 1 < len(usable) and not used[hi + 1]:
        cand_end = float(usable[hi + 1]["end"])
        if cand_end - start > hard_max:
            break
        hi += 1
        end = cand_end

    # Fallback only: peak too close to the end to reach the minimum forward → pull from behind.
    while end - start < HEUR_MIN_SEC and lo - 1 >= 0 and not used[lo - 1]:
        cand_start = float(usable[lo - 1]["start"])
        if end - cand_start > hard_max:
            break
        lo -= 1
        start = cand_start

    return lo, hi, start, end


def heuristic_shorts(scenes: list[dict], n: int, duration: float, genre: str) -> list[dict]:
    """Mechanical, model-free picker. Guarantees >=1 short whenever scenes exist so the
    recommendation board is never empty. Picks the highest-signal moments and cuts each into
    a 30~60s window that STARTS at the hook and runs forward, non-overlapping, top-n by signal."""
    usable = [
        s for s in scenes
        if isinstance(s.get("start"), (int, float))
        and isinstance(s.get("end"), (int, float))
        and float(s["end"]) > float(s["start"])
    ]
    if not usable:
        return []
    usable.sort(key=lambda s: float(s["start"]))
    sig = [_scene_signal(s) for s in usable]
    seeds = sorted(range(len(usable)), key=lambda i: -sig[i])

    aim = min(HEUR_AIM_SEC, max(MIN_SHORT_SEC, duration or HEUR_AIM_SEC))
    hard_max = min(HEUR_MAX_SEC, max(aim, duration or HEUR_MAX_SEC))

    used = [False] * len(usable)
    chosen: list[tuple[int, int, float, float, float]] = []
    for seed in seeds:
        if used[seed]:
            continue
        lo, hi, start, end = _cut_from_hook(seed, usable, used, aim, hard_max)
        for k in range(lo, hi + 1):
            used[k] = True
        seg_sig = max(sig[k] for k in range(lo, hi + 1))
        chosen.append((lo, hi, round(start, 1), round(end, 1), seg_sig))
        if len(chosen) >= n:
            break

    chosen.sort(key=lambda c: -c[4])
    out = []
    for rank, (lo, hi, start, end, sc) in enumerate(chosen, 1):
        peak = max(range(lo, hi + 1), key=lambda k: sig[k])
        out.append({
            "rank": rank,
            "start": start,
            "end": end,
            "title": _heur_title(usable[peak]),
            "reason": "AI 후보가 비어 자동 선별 — 신호(대사·자막·표정/움직임)가 가장 센 순간에서 시작해 30~60초로 컷",
            "appeal": max(1, min(5, 2 + round(sc * 3))),
            "scene_from": usable[lo].get("index"),
            "scene_to": usable[hi].get("index"),
            "tags": _heur_tags(usable[lo:hi + 1]),
            "hook": "기타",
            "source": "heuristic",
        })
    return out


# ── entrypoint ──────────────────────────────────────────────────────────────────

def recommend(
    scenes: list[dict],
    n: int = 5,
    genre: str = "auto",
    on_progress: Optional[Callable[[int, int], None]] = None,
    profile: dict | None = None,
    channels: list[str] | None = None,
    transcript: list[dict] | None = None,
) -> dict:
    """Two-phase shorts pick. Returns {"genre": resolved, "shorts": [...]}.
    A program `profile` (optional) steers the prompts and re-ranks by program-fit
    (hookWeights × targetLength, minus taboos) — non-destructive when absent.
    `channels` (배포처 keys, default all built-in) adds a per-destination fit matrix on
    each short (`channel_scores`) without touching the board's own ranking."""
    if not scenes:
        return {"genre": DEFAULT_GENRE, "shorts": []}
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    # 영상 길이에 맞춰 추천 수를 늘린다. 실측(2026-07-21): 13분 영상에서 편집자는 숏폼 3개를
    # 뽑았는데 엔진은 n=5 고정이라 후반부 지점을 놓쳤다. 60분이면 편집자가 10개 넘게 만든다 —
    # 고정 5개는 롱폼일수록 재현율을 떨어뜨린다. 약 10분당 3개, 상한 20개.
    vid_min = (scenes[-1]["end"]) / 60.0
    n = max(n, min(20, round(vid_min / 10.0 * 3) or n))

    if genre == "auto" or genre not in GENRE_PACKS:
        genre = detect_genre(client, scenes)
        print(f"   장르 감지: {genre} ({_pack(genre)['label']})")

    duration = scenes[-1]["end"]
    chunks = chunk_scenes(scenes)
    print(f"   1단계: {len(chunks)} 구간에서 후보 추출…")
    done = [0]

    failed = [0]

    def scan(chunk: list[dict]) -> list[dict]:
        try:
            cands = _extract_candidates(client, chunk, genre, profile)
        except Exception as e:
            failed[0] += 1
            # 워커 스레드 출력 — \n 포함 단일 write로 원자화 (@@PROGRESS 줄 섞임 방지)
            print(f"   (구간 {_mmss(chunk[0]['start'])}~ 후보 추출 실패, 스킵: {str(e)[:80]})\n",
                  end="", flush=True)
            cands = []
        done[0] += 1
        if on_progress:
            on_progress(done[0], len(chunks))
        return cands

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        per_chunk = list(ex.map(scan, chunks))
    candidates = [c for batch in per_chunk for c in batch]
    print(f"   후보 {len(candidates)}개")

    if not candidates:
        # EVERY chunk erroring is a real outage (not "the model found nothing"): raise so the
        # job retries and can still get real AI picks instead of locking a heuristic floor in.
        if failed[0] >= len(chunks):
            raise RuntimeError(
                f"candidate extraction failed for {failed[0]}/{len(chunks)} chunks with zero candidates"
            )
        # Model genuinely returned nothing (or only some chunks errored) → fall through to the
        # guaranteed floor below instead of dead-ending the board at 0.
        print("   (후보 0개 — 휴리스틱 폴백으로 보장)")
        shorts = []
    elif len(chunks) == 1:
        # Single chunk = Phase 1 already saw the whole video; a synthesis pass adds
        # nothing but latency. Rank by the model's own appeal.
        shorts = sorted(candidates, key=lambda c: -(c.get("appeal") or 0))
        for i, s in enumerate(shorts, 1):
            s["rank"] = i
    else:
        print(f"   2단계: 합성 — 최종 {n}개 선별…")
        try:
            shorts = _synthesize(client, candidates, n, genre, duration, profile)
        except Exception as e:
            print(f"   (합성 실패: {str(e)[:80]})")
            shorts = []
        if not shorts:  # synthesis flaked — degrade to best candidates, not to nothing
            print("   (합성 결과 없음 → 후보 appeal 순으로 대체)")
            shorts = sorted(candidates, key=lambda c: -(c.get("appeal") or 0))
            for i, s in enumerate(shorts, 1):
                s["rank"] = i

    if shorts:
        # Program-fit re-rank (최종 = 융합 × 프로그램적합): weights prized hooks, drops taboos,
        # nudges toward the target length. No-op when the profile carries no signal.
        before = len(shorts)
        shorts = apply_profile_fit(shorts, profile, duration)
        if profile and before != len(shorts):
            print(f"   프로파일 적합 적용: {before} → {len(shorts)} (금기 제외)")
        shorts = validate_shorts(shorts, duration, n, candidates=candidates, scenes=scenes, transcript=transcript)

    # GUARANTEE — the board is never empty. If the AI path produced nothing shippable
    # (found nothing, synthesis flaked, or validation trimmed everything away), cut shorts
    # mechanically from the scene signals. Always yields >=1 when scenes exist.
    if not shorts:
        floor = heuristic_shorts(scenes, n, duration, genre)
        shorts = validate_shorts(floor, duration, n, transcript=transcript) or floor
        print(f"   휴리스틱 폴백 — 쇼츠 {len(shorts)}개 생성 (편집자식 30~60초 컷)")

    # Channel(배포처) fit — 최종 = 융합 × 채널적합 × 프로그램적합, evaluated PER destination.
    # Runs after validation so the matrix only covers picks that actually survived, and is
    # purely additive (adds channel_scores; final_score/rank stay as-is).
    try:
        from .channels import apply_channel_fit
        shorts = apply_channel_fit(shorts, scenes, channels)
    except Exception as e:
        # The matrix is additive — losing it costs the per-destination view, not the pick.
        print(f"   (채널 적합 건너뜀: {str(e)[:80]})")
    _log_channel_matrix(shorts)

    return {"genre": genre, "shorts": shorts}


def _log_channel_matrix(shorts: list[dict]) -> None:
    """Log each destination's own #1 — the whole point of the axis is that they differ."""
    cells = shorts[0].get("channel_scores") if shorts else None
    if not cells:
        return
    for key, cell in cells.items():
        top = min(shorts, key=lambda s: s["channel_scores"][key]["rank"])
        print(f"   [{cell['label']}] #1 『{str(top.get('title',''))[:20]}』"
              f" (fit {top['channel_scores'][key]['fit']:.2f})")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.recommend <scenes.json> [--n 5] [--genre auto|variety|talk|drama|sports|news|music|documentary]")
        sys.exit(1)

    src = Path(sys.argv[1])
    n = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 5
    genre = sys.argv[sys.argv.index("--genre") + 1] if "--genre" in sys.argv else "auto"

    scenes = json.loads(src.read_text(encoding="utf-8"))
    print(f"쇼츠 추천: {len(scenes)} 장면 → {n}개 · 장르 {genre} · {MODEL} (Vertex AI {PROJECT}/{LOCATION})")

    result = recommend(scenes, n=n, genre=genre)
    shorts = result["shorts"]

    out = src.parent / "shorts.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== 추천 쇼츠 {len(shorts)}개 (장르: {result['genre']}) ===")
    for s in sorted(shorts, key=lambda x: x.get("rank", 99)):
        dur = s["end"] - s["start"]
        tags = "/".join(s.get("tags", []))
        print(f"  #{s.get('rank')} [{_mmss(s['start'])}~{_mmss(s['end'])}] {dur:.0f}s · appeal {s.get('appeal')} · {tags}")
        print(f"     『{s['title']}』")
        print(f"     {s['reason']}")
    print(f"\n  → {out}")


if __name__ == "__main__":
    main()

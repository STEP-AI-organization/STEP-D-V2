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
import re
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
from .shots import detect_shots, nearest_shot

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

    # ⑤ 시각 오프닝 훅 실증 (Exp 5): 이 채널 잘 터진 숏폼 첫 3초에서 발견된 시각 신호.
    # 롱폼 장면 선택 시 "이 장면을 30~60초로 자르면 오프닝이 이런 시각 신호를 낼 수 있는가?"
    # 를 판단 근거에 포함시킨다.
    vp = profile.get("visualProfile") or {}
    if vp:
        vlines = []
        prefer_h = vp.get("prefer_hook_types") or []
        avoid_h = vp.get("avoid_hook_types") or []
        prefer_c = vp.get("prefer_colors") or []
        if prefer_h:
            label_map = {"reaction": "리액션(놀람·웃음·감탄 얼굴)", "text_cue": "화면 자막·큐 텍스트",
                         "action": "움직임·행동", "situation": "상황 설정"}
            vlines.append("  · 선호 오프닝 훅: " + ", ".join(label_map.get(h, h) for h in prefer_h))
        if avoid_h:
            label_map = {"situation": "잔잔한 상황 설정(정적 배경·설명)", "action": "움직임", "reaction": "리액션", "text_cue": "자막"}
            vlines.append("  · 회피 오프닝: " + ", ".join(label_map.get(h, h) for h in avoid_h))
        if prefer_c:
            vlines.append("  · 선호 화면색: " + ", ".join(prefer_c) + " (밝은 톤·강한 대비가 오프닝 흡인력)")
        if vp.get("prefer_face_close"):
            vlines.append("  · 얼굴 클로즈업 오프닝 우대 (표정이 시청자 붙잡음)")
        if vp.get("prefer_overlay"):
            vlines.append("  · 화면 자막(overlay text) 있는 장면 오프닝 우대")
        if vlines:
            lines.append("- 이 채널의 **오프닝 훅 공식** (첫 3초 실증, 194편 대조):")
            lines.extend(vlines)
            lines.append("  → 위 신호를 낼 수 있는 장면(리액션 순간·자막 붙은 컷 등)을 시작으로 자를 수 있는 구간을 우대. 잔잔한 상황설정 오프닝은 피하라.")

    # ⑥ 시청자 실측 반응 (Exp 13): 이 롱폼 자기 자신의 상위 좋아요 댓글에서 추출된 신호.
    # 편집자가 발행 후 며칠~수주 지나 클립 뽑을 때, 그 시청자 반응을 실제 픽에 반영.
    # NOW: 원본 영상 자기 댓글만. LATER(B2B 스케일): 전 채널 종합 프로파일.
    vs = profile.get("viewer_signals") or {}
    if vs:
        slines = []
        top_moments = vs.get("top_moments") or []
        top_demands = vs.get("top_demands") or []
        explicit_ts = vs.get("explicit_timestamps") or []
        dominant_emotion = vs.get("dominant_emotion")
        if top_moments:
            slines.append("  · 시청자가 특히 지목한 순간(상위 좋아요): " + ", ".join(f'"{m}"({l}❤)' for m, l in top_moments[:5]))
        if dominant_emotion:
            slines.append(f"  · 시청자 지배 감정: **{dominant_emotion}**")
        if explicit_ts:
            slines.append("  · 시청자 명시 시간(**픽 후보로 반드시 고려**): " + ", ".join(f'{t["mmss"]}({t["likes"]}❤)' for t in explicit_ts[:5]))
        if top_demands:
            slines.append("  · 시청자 상위 요청 (관련 순간 있으면 우대): " + ", ".join(f'"{d[:40]}"' for d, _ in top_demands[:3]))
        if slines:
            lines.append("- 이 롱폼의 **시청자 실측 반응** (원본 영상 상위 좋아요 댓글에서 추출):")
            lines.extend(slines)
            lines.append("  → 위 순간·감정과 정합하는 구간을 우대. 시청자 명시 시간이 있는 순간은 반드시 픽 후보로 고려하라.")
    return "\n".join(lines)


def _cast_block(cast_registry: list[dict] | None) -> str:
    """출연진 명단 블록 — 등록 캐스트 이름을 제목·설명에 정확히 반영하도록. STT 오인식 정규화
    지시 포함. cast 없으면 빈 문자열(no-op)."""
    if not cast_registry:
        return ""
    names: list[str] = []
    for m in cast_registry:
        if not isinstance(m, dict):
            continue
        n = (m.get("name") or "").strip()
        if n:
            names.append(n)
        for a in (m.get("aliases") or []):
            a = (str(a) or "").strip()
            if a:
                names.append(a)
    if not names:
        return ""
    return (
        "\n\n등록된 출연진:\n"
        f"- 이 명단만 실명으로 사용: {', '.join(names)}\n"
        "- STT 오인식은 이 명단 기준으로 정규화 (예: 옥수→옥순, 정선→정순).\n"
        "- 대사에서 서로 부르는 호칭(XX 님/OO아)이 명단에 있으면 실명으로.\n"
        "- 명단에 없는 이름은 만들지 마라 — 잘 모르는 인물은 '한 출연자', '진행자' 같은 역할 지칭."
    )


def _program_context_block(ctx: dict | None) -> str:
    """프로그램 정보(시놉시스·태그·크레딧·방영정보)를 프롬프트에 힌트로 주입.
    사용자가 상세 페이지에서 입력한 정보 그대로 → AI가 이 프로그램의 결·톤·인물 관계를
    이해한 상태로 판단. 자막에 없는 사실을 만들라는 뜻은 아니고, '어떤 프로그램인지'만
    알려주는 배경 브리핑. 각 필드 optional — 채워진 것만 나열. 비면 no-op."""
    if not ctx or not isinstance(ctx, dict):
        return ""
    lines: list[str] = []
    if ctx.get("title"):
        lines.append(f"- 제목: {ctx['title']}")
    if ctx.get("section"):
        lines.append(f"- 장르: {ctx['section']}")
    if ctx.get("broadcaster"):
        lines.append(f"- 채널: {ctx['broadcaster']}")
    if ctx.get("schedule"):
        lines.append(f"- 편성: {ctx['schedule']}")
    if ctx.get("firstAiredDate") or ctx.get("currentInfo"):
        pair = " · ".join([p for p in [ctx.get("firstAiredDate"), ctx.get("currentInfo")] if p])
        lines.append(f"- 방영: {pair}")
    if ctx.get("director"):
        lines.append(f"- 연출: {ctx['director']}")
    if ctx.get("spinoff"):
        lines.append(f"- 스핀오프: {ctx['spinoff']}")
    if ctx.get("awards"):
        lines.append(f"- 수상: {ctx['awards']}")
    moods = ctx.get("moods")
    if isinstance(moods, list) and moods:
        lines.append(f"- 분위기 태그: {', '.join(str(m) for m in moods if m)}")
    synopsis = ctx.get("synopsis")
    if synopsis:
        # 시놉시스는 길 수 있으니 400자로 컷 (프롬프트 낭비 방지)
        s = str(synopsis).strip()
        if len(s) > 400:
            s = s[:400] + "…"
        lines.append(f"- 시놉시스: {s}")
    if not lines:
        return ""
    return (
        "\n\n프로그램 정보(사용자 입력 · 이 프로그램의 결을 이해하는 배경 브리핑):\n"
        + "\n".join(lines)
        + "\n- 위 정보는 '어떤 프로그램인지'만 알려주는 배경. 자막에 없는 사실을 이 정보로 채우지는 마라."
    )


# recommend()·recommend_narrative_first() 호출 스코프 동안만 활성 — _base_system에서 참조.
# 매 콜마다 recommend/RNF 진입시 세팅, 종료시 초기화. threading 없어 안전.
_CURRENT_PROGRAM_CTX: dict | None = None


def _base_system(genre: str, profile: dict | None = None, cast_registry: list[dict] | None = None) -> str:
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
- **길이는 완결성이 최우선.** 30~90초를 기본으로, 스토리 완결에 필요하면 120초까지 허용.
  스토리가 잘리면 실패 — 60초 안에 못 담으면 60초 넘어라. 하드 실링 180초. 20초 미만은
  정말 그 한 컷으로 완결될 때만. start/end는 장면·문장 경계에서 깔끔히 끊어라.
- appeal은 바이럴 잠재력의 절대평가다: 5=확실히 터진다, 4=강함, 3=쓸만함, 2=약함, 1=비추천.{_profile_block(profile)}{_cast_block(cast_registry)}{_program_context_block(_CURRENT_PROGRAM_CTX)}"""


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
        # final_score의 base는 3축 원점수(0-100). 이전엔 appeal(1-5 정수)라 곱하면 계단식으로
        # 튀었음 — 3축 연속값이라 이제 매끈함.
        base100 = _axes_score(s)
        if base100 <= 0:  # 3축·appeal 다 없으면 중립값
            base100 = 50.0
        s = {**s, "program_fit": program_fit,
             "final_score": round(base100 * program_fit, 3)}
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


DIALOG_LINE_CHARS = 140          # per-line dialogue snippet cap (keeps prompt bounded)
DIALOG_MAX_LINES_PER_SCENE = 60  # 5-minute chunk cap; further lines are stride-sampled


def _scene_dialogue_lines(scene: dict, transcript: list[dict] | None) -> list[str]:
    """Render the scene's dialogue as one-line-per-utterance with a [MM:SS] prefix and speaker.
    Without this, the whole chunk collapses into a single joined `text` blob and the model
    has no idea WHERE inside the 5-minute chunk each line lived — which is why picked titles
    drift from the actual clipped window."""
    if not transcript:
        return []
    start, end = float(scene.get("start", 0)), float(scene.get("end", 0))
    segs = []
    for s in transcript:
        try:
            sst, sen = float(s.get("start", 0)), float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if sen <= start or sst >= end:
            continue
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        segs.append(s)
    if len(segs) > DIALOG_MAX_LINES_PER_SCENE:
        step = len(segs) / DIALOG_MAX_LINES_PER_SCENE
        segs = [segs[int(i * step)] for i in range(DIALOG_MAX_LINES_PER_SCENE)]
    out = []
    for s in segs:
        sp = (s.get("speaker") or "").strip()
        prefix = f"[{_mmss(float(s.get('start', 0)))}]" + (f" [{sp}]" if sp else "")
        out.append(f"{prefix} {str(s.get('text','')).strip()[:DIALOG_LINE_CHARS]}")
    return out


def build_timeline(scenes: list[dict], transcript: list[dict] | None = None) -> str:
    """Render the timeline. When `transcript` is provided, dialogue is broken out into
    per-utterance lines with their own timestamps so the model can locate WHERE each moment
    sits inside the chunk — otherwise the whole chunk's dialogue collapses into one blob
    and picked titles drift from the actual 30~60s window that validate_shorts extends to."""
    lines = []
    for s in scenes:
        names = ",".join(s.get("on_screen_names", []))
        vis = s.get("vision_reason", "")
        score = s.get("vision_score")
        # 원시 초를 함께 표기 — 모델이 start/end로 되돌려줄 값은 이 초 값이다
        # (mm:ss만 주면 모델이 초로 환산하다 어긋난다).
        header = (
            f"[{s['index']}] {float(s['start']):.1f}~{float(s['end']):.1f}초"
            f" ({_mmss(s['start'])}~{_mmss(s['end'])}, {s['duration']:.0f}s)"
            f" | 화면:{vis} | 인물:{names or '-'} | 시각:{score if score is not None else '-'}"
        )
        dialog_lines = _scene_dialogue_lines(s, transcript)
        if dialog_lines:
            lines.append(header)
            lines.append("   대사:")
            for dl in dialog_lines:
                lines.append(f"     {dl}")
        else:
            # 폴백: transcript 없을 때 기존 방식 (5분 블록 텍스트 한 줄)
            txt = (s.get("text") or "").strip() or "-"
            lines.append(header + f" | 대사:{txt}")
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
    # 3축 직교 스코어 (2026-07-23) — 단일 appeal(1-5)은 해상도·기준점 부족으로 재실행마다
    # 3↔4 튐. 각 축은 독립 판단이라 서로 상쇄돼 종합이 안정된다.
    #   hook_strength   0-10 첫 2~3초 시선강탈 강도 (표정·자막·펀치 등장)
    #   payoff          0-10 결정타 임팩트 (터짐·반전·감동 정점)
    #   completeness    0-10 앞뒤 맥락·완결성 (셋업→터짐→여운의 자연스러움)
    "hook_strength": {"type": "INTEGER"},
    "payoff": {"type": "INTEGER"},
    "completeness": {"type": "INTEGER"},
    # appeal(1-5)은 legacy UI 호환용 — 프롬프트에서 요청하지 않고 3축에서 산출한다.
    "appeal": {"type": "INTEGER"},
    "scene_from": {"type": "INTEGER"},
    "scene_to": {"type": "INTEGER"},
    "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
    # Primary hook category (반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타) — used with
    # the program profile's hookWeights to compute a program-fit multiplier.
    "hook": {"type": "STRING"},
}


# 3축 가중합 → 0-100 원점수, 1-5 압축은 UI 호환용
_AXIS_WEIGHTS = {"hook_strength": 0.40, "payoff": 0.35, "completeness": 0.25}


def _axes_score(cand: dict) -> float:
    """3축 가중합 (0-100). 축이 없거나 잘못 나오면 legacy appeal(1-5)에서 역산."""
    hs = cand.get("hook_strength"); pf = cand.get("payoff"); cp = cand.get("completeness")
    if all(isinstance(x, (int, float)) for x in (hs, pf, cp)):
        raw = (float(hs) * _AXIS_WEIGHTS["hook_strength"]
               + float(pf) * _AXIS_WEIGHTS["payoff"]
               + float(cp) * _AXIS_WEIGHTS["completeness"])
        return round(max(0.0, min(10.0, raw)) * 10.0, 1)
    ap = cand.get("appeal")
    if isinstance(ap, (int, float)):
        return round((float(ap) - 1.0) / 4.0 * 100.0, 1)
    return 0.0


def _appeal_from_axes(cand: dict) -> int | None:
    """0-100 → 1-5 압축 (UI 호환). 근거 없으면 None."""
    hs = cand.get("hook_strength"); pf = cand.get("payoff"); cp = cand.get("completeness")
    if not all(isinstance(x, (int, float)) for x in (hs, pf, cp)):
        return None
    score100 = _axes_score(cand)
    return max(1, min(5, round(score100 / 25.0) + 1))

_PHASE1_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "candidates": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": _CANDIDATE_FIELDS,
                # appeal은 3축에서 산출(스키마 required에서 뺌)
                "required": ["start", "end", "title", "reason",
                             "hook_strength", "payoff", "completeness"],
            },
        },
    },
    "required": ["candidates"],
}


_AXES_PROMPT = """3축 스코어(각 0-10, 정수). 이 3축은 서로 독립이니 별도로 판단하라:
- hook_strength: 첫 2~3초의 시선강탈 강도. 표정·자막·펀치 등장·의외성 = 강함.
  0=평범한 인트로, 3=관심 유도, 5=명확한 시선고정, 8=강한 훅, 10=꺾이는 오프닝.
- payoff: 결정타 임팩트. 터짐·반전·감동·정보 정점의 세기. hook과 별개로 판단.
  0=평이한 마무리, 3=소소한 웃음/공감, 5=제대로 터짐, 8=예상 초과, 10=바이럴 확실.
- completeness: 앞뒤 맥락·완결성. 셋업→터짐→여운이 자연스러운가.
  0=문맥 없이 잘림, 3=이해 가능하지만 얕음, 5=완결된 한 장면, 8=편집자 컷 수준,
  10=그대로 발행 가능.
※ 세 축을 다 8+로 주지 마라 — 대부분 후보는 축마다 편차가 있다. 근거 없이 몰아주면 신뢰도 하락."""





def _extract_candidates(client, chunk: list[dict], genre: str, profile: dict | None = None, cast_registry: list[dict] | None = None, transcript: list[dict] | None = None, narrative_segments: list[dict] | None = None, key_conflicts: list[dict] | None = None, cast_people: list[dict] | None = None, ppl_detections: list[dict] | None = None) -> list[dict]:
    c_start, c_end = float(chunk[0]["start"]), float(chunk[-1]["end"])
    narrative_ctx = _narrative_context_for_range(narrative_segments, c_start, c_end)
    conflicts_ctx = _conflicts_context_for_range(key_conflicts, c_start, c_end)
    cast_ctx = _cast_timeline_context_for_range(cast_people, c_start, c_end)
    ppl_ctx = _ppl_context_for_range(ppl_detections, c_start, c_end)
    system = _base_system(genre, profile, cast_registry) + f"""

지금 보는 타임라인은 전체 영상의 일부 구간이다. 이 구간 안에서만 후보를 골라라.
- 각 장면 아래 '대사:' 블록의 [MM:SS] 접두어는 그 대사가 발화된 실제 시각이다.
  후보 start/end는 실제로 터지는 대사가 시작·끝나는 [MM:SS] 근처의 '초' 값에 맞춰라
  (장면 헤더의 5분 범위 아무 데나 잡지 말고, 대사 타임스탬프를 근거로 정확히).
- 최대 {PER_CHUNK}개. 확신 없는 구간은 넣지 마라 — 0개도 답이다.
- start/end는 초 단위 숫자로 반환. 분:초 표기를 초로 환산해 쓰지 마라 (예: 12:34 → 754.0).
- 각 후보 필수 필드: start(초), end(초), title(**예능 자막 톤 8~18자** — 담백한 상황 관찰조,
  현재형, 여운. **자막 없는 사실은 절대 만들지 마라**. 인용은 자막 원문 그대로 인용부호로.
  물음표는 답이 즉시 이어질 때만. 다음 어휘 금지: 미친/헐/실화/대박/소름/레전드/폭발/폭탄/충격/
  초토화/뒤집혔다/해버렸다/터졌다/저질렀다/스튜디오. 두루뭉술 명사(썰/이야기/모먼트/사연) 금지.
  ㅋㅋ·ㅎㅎ·이모지·화살표 금지), reason(왜 터지는지 한 문장), hook_strength/payoff/completeness
  (3축 각 0-10, 아래 기준), scene_from/scene_to(포함 장면번호), tags(리액션/폭소/반전/서사/자막
  등), hook(반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타 중 가장 잘 맞는 하나).

{_AXES_PROMPT}"""
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=(
            f"이 구간에서 쇼츠 후보를 골라라.\n\n"
            f"=== 장면 타임라인 ({_mmss(chunk[0]['start'])}~{_mmss(chunk[-1]['end'])}) ===\n"
            f"{build_timeline(chunk, transcript)}"
            f"{narrative_ctx}"
            f"{conflicts_ctx}"
            f"{cast_ctx}"
            f"{ppl_ctx}"
        ),
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
                "required": ["rank", "start", "end", "title", "reason",
                             "hook_strength", "payoff", "completeness"],
            },
        },
    },
    "required": ["shorts"],
}


def _synthesize(client, candidates: list[dict], n: int, genre: str, duration: float, profile: dict | None = None, cast_registry: list[dict] | None = None) -> list[dict]:
    lines = []
    for i, c in enumerate(sorted(candidates, key=lambda c: c.get("start", 0)), 1):
        tags = "/".join(c.get("tags", []))
        axes = (f"h{c.get('hook_strength', '-')}/p{c.get('payoff', '-')}"
                f"/c{c.get('completeness', '-')}")
        # 원시 초를 함께 표기 — start/end는 이 초 값을 그대로 복사받는다.
        lines.append(
            f"[후보{i}] {float(c.get('start', 0)):.1f}~{float(c.get('end', 0)):.1f}초"
            f" ({_mmss(c.get('start', 0))}~{_mmss(c.get('end', 0))})"
            f" | 3축:{axes} | {c.get('title', '')} | {c.get('reason', '')}"
            f" | 장면:{c.get('scene_from', '-')}~{c.get('scene_to', '-')} | {tags or '-'}"
        )
    system = _base_system(genre, profile, cast_registry) + f"""

아래는 영상 전체({_mmss(duration)})를 구간별로 스캔해 뽑은 쇼츠 후보 목록이다. 3축(h=hook_strength,
p=payoff, c=completeness — 각 0-10)은 Phase 1에서 매긴 근거값이다.
이 중에서 최종 {n}개를 골라 순위를 매겨라.
- start/end는 후보에 표기된 '초' 값(예: 754.2~779.8초)을 그대로 복사하라.
  분:초 표기를 초로 환산해 쓰지 마라.
- 겹치거나 바로 이어지는 후보는 하나로 병합해도 된다 (start/end를 병합 범위로).
- 후보 목록에 없는 새로운 구간을 만들지 마라.
- 비슷한 종류만 몰리지 않게, 영상 전체를 대표하도록 다양성도 고려하라.
- 3축을 다시 채점하라 (병합·재판단 반영). Phase 1 값과 달라도 된다 — 이번 시야는 전체 영상이다.
- 각 항목: rank(1=최고), start, end, title, reason, hook_strength/payoff/completeness,
  scene_from/scene_to, tags, hook(반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타 중 하나).

{_AXES_PROMPT}"""
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
# 완결성 우선 원칙 (2026-07-23 · 사용자 방향 전환): 60초 하드 트림이 스토리 잘림 유발.
# 완결에 필요하면 120초까지 허용 · MAX_SHORT_SEC=180 하드 실링만 유지.
VALIDATE_MAX_SEC = 120.0  # 확장·trim 판정 상한 (완결에 필요한 만큼 담기)


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

# 종결어미 스냅 — 발화 도중 절단은 _snap_to_speech가 잡지만, STT는 침묵마다 세그먼트를 끊어서
# "가야 하는데" [침묵] "진짜 힘들었어" 처럼 발화 경계는 정확한데 문장은 아직 안 끝난 컷이 남는다.
# refine이 자연스러운 구두점(. ! ? …)을 붙이므로 종결 부호 유무로 문장 완결을 판정하고, 미완결이면
# 종결 부호가 나오는 다음 세그먼트까지 뒤로 확장한다.
MAX_SENT_EXTEND_SEC = 8.0
_SENT_END_PUNCT = ".!?…"


def _text_ends_sentence(text: str) -> bool:
    """refined text가 종결 부호로 끝나면 True. refine이 문장 끝에 구두점을 붙이므로 이 신호가
    가장 안정적이다. 종결어미 문자만 검사하면 부사형(예: '가다가')과 혼동돼 false positive."""
    if not text:
        return True
    s = text.strip().rstrip("\"'')]》」』")
    if not s:
        return True
    return s[-1] in _SENT_END_PUNCT


# 서사 비트(beat) 완결 스냅 — 자기소개→리액션·인터뷰같이 편집상 "한 덩어리"인 순간을 함께 담기
# 위한 확장. narrative 단계에서 Gemini가 이미 "이 5분 블록의 주요 순간들"을 [MM:SS] 시점으로
# 정리해뒀으므로, 현재 end 바로 뒤에 key_moment가 있으면 같은 비트일 확률이 높다 — 최대 30초 안
# 마지막 key_moment까지 확장한다. 문장 종결어미 스냅과 별개로 동작.
MAX_BEAT_EXTEND_SEC = 30.0
_KM_TIME_RE = re.compile(r"^\[(\d+):(\d{2})\]\s*(.*)")


def _parse_km_time(km: str) -> tuple[float, str] | None:
    """narrative key_moment 문자열 '[MM:SS] 설명' → (초, 설명). 파싱 실패 시 None."""
    m = _KM_TIME_RE.match(km.strip())
    if not m:
        return None
    minutes = int(m.group(1))
    seconds = int(m.group(2))
    return float(minutes * 60 + seconds), m.group(3).strip()


def _snap_to_content_end(end: float, transcript: list[dict] | None,
                         min_trim: float = 3.0, max_trim: float = 20.0) -> float:
    """end 근처 침묵 구간 trim — 실제 대사 끝난 뒤 다음 신이 유입되는 것 방지 (클립 후처리).
    end 앞 마지막 발화 종료 시점을 찾아 end - last_utt_end 침묵 갭이 min_trim~max_trim 사이면
    발화 종료+2s 로 당김. 침묵 갭이 너무 작으면 자연 여운으로 유지 · 너무 크면 (max_trim 초과)
    잘못된 판단일 수 있어 손대지 않음. 사용자 관찰(2026-07-23): 한의사 클립이 내용 끝난 뒤
    다음 신까지 끌고 감."""
    if not transcript:
        return end
    last_utt_end = 0.0
    for t in transcript:
        try:
            tst, ten = float(t.get("start", 0)), float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if tst >= end:
            break
        if (t.get("text") or "").strip():
            last_utt_end = max(last_utt_end, ten)
    if last_utt_end <= 0:
        return end
    gap = end - last_utt_end
    if min_trim <= gap <= max_trim:
        return round(last_utt_end + 2.0, 1)
    return end


def _snap_to_beat_setup(start: float, narrative_segments: list[dict] | None,
                        max_extend: float = MAX_BEAT_EXTEND_SEC) -> float:
    """_snap_to_beat_closure의 미러 — start 쪽으로 setup 담기 위한 확장.
    현재 start에서 [start-max_extend, start] 범위 안 key_moment가 있으면 가장 이른 것 시점
    (-2s 여유)까지 앞으로 당김. Phase 1이 반응(payoff)만 잡고 setup을 놓치는 편향을 보정.
    key_moment는 Gemini가 정리한 '주요 순간'이라 start 바로 앞에 있으면 셋업 확률 높음.
    2026-07-23: 환승연애 #1 '직업 공개 반응' 클립이 진짜 반전 '저는 한의사입니다'를 놓치는
    현상 관찰 후 추가."""
    if not narrative_segments or start <= 0:
        return start
    earliest = start
    for seg in narrative_segments:
        for km in (seg.get("key_moments") or []):
            parsed = _parse_km_time(str(km))
            if not parsed:
                continue
            t, _desc = parsed
            if max(0.0, start - max_extend) <= t < start and t < earliest:
                earliest = t
    if earliest < start:
        return max(0.0, round(earliest - 2.0, 1))  # 순간 앞 살짝 여유
    return start


def _snap_to_beat_closure(end: float, narrative_segments: list[dict] | None,
                          max_extend: float = MAX_BEAT_EXTEND_SEC) -> float:
    """narrative.segments.key_moments를 이용한 서사 비트 완결 확장.
    현재 end에서 [end, end+max_extend] 범위 안 key_moment가 있으면 마지막 것 시점(+2s 여유)
    까지 확장. key_moment는 Gemini가 같은 5분 블록에서 정리한 '주요 순간'이라, end 바로 뒤에
    있으면 자기소개→리액션·인터뷰처럼 같은 편집 단위에 속할 확률이 높다. 못 찾으면 원 end 유지."""
    if not narrative_segments:
        return end
    latest = end
    for seg in narrative_segments:
        for km in (seg.get("key_moments") or []):
            parsed = _parse_km_time(str(km))
            if not parsed:
                continue
            t, _desc = parsed
            if end < t <= end + max_extend and t > latest:
                latest = t
    if latest > end:
        return round(latest + 2.0, 1)  # 순간 시점이라 살짝 여유
    return end


def _snap_to_sentence_end(end: float, utterances: list[dict] | None,
                          max_extend: float = MAX_SENT_EXTEND_SEC) -> float:
    """end 확장: 현재 end 앞 마지막 발화의 refined text가 종결 부호로 안 끝나면, 종결로 끝나는
    다음 발화까지 최대 max_extend초 뒤로 늘린다. 못 찾으면 원 end 유지 — 함부로 확장하지 않는다.
    _snap_to_speech(발화 도중 절단) 이후에 실행 — 이 함수는 '발화 경계엔 왔는데 문장이 안 끝난'
    경우만 담당한다."""
    if not utterances:
        return end
    utts = sorted(
        (
            (float(u["start"]), float(u["end"]), (u.get("text") or "").strip())
            for u in utterances
            if isinstance(u.get("start"), (int, float))
            and isinstance(u.get("end"), (int, float))
            and float(u["end"]) > float(u["start"])
        ),
        key=lambda x: x[0],
    )
    # end 바로 앞의 마지막 발화 찾기 (end에서 0.5초 여유 — 발화 스냅으로 end가 살짝 밀렸을 수 있음)
    last_i = -1
    for i, (us, ue, _) in enumerate(utts):
        if ue <= end + 0.5:
            last_i = i
        elif us >= end:
            break
    if last_i < 0:
        return end
    if _text_ends_sentence(utts[last_i][2]):
        return end  # 이미 완결
    cap = end + max_extend
    for j in range(last_i + 1, len(utts)):
        us, ue, txt = utts[j]
        if ue > cap:
            break
        if _text_ends_sentence(txt):
            return round(ue, 1)
    return end


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
                    transcript: list[dict] | None = None,
                    narrative_segments: list[dict] | None = None) -> list[dict]:
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
            # 종결어미 스냅: 발화 경계엔 왔지만 문장이 안 끝난 경우 (STT 침묵-분절 특성) 종결 부호가
            # 나오는 다음 발화까지 확장. cap 8초.
            new_end = _snap_to_sentence_end(end, transcript)
            if duration > 0:
                new_end = min(new_end, duration)
            if new_end > end:
                print(f"   (종결어미 확장 {end:.1f}s → {new_end:.1f}s (+{new_end - end:.1f}s): {str(s.get('title', ''))[:24]})")
                end = new_end
        # 서사 비트 완결 스냅: end 확장 + start 앞쪽 setup 미러링. 자기소개→리액션같이 편집상
        # 한 덩어리를 담기 위한 뒤 확장 + Phase 1이 payoff만 잡고 setup을 놓치는 편향 앞 보정.
        if narrative_segments:
            new_end = _snap_to_beat_closure(end, narrative_segments)
            if duration > 0:
                new_end = min(new_end, duration)
            if new_end > end:
                print(f"   (비트 확장 end {end:.1f}s → {new_end:.1f}s (+{new_end - end:.1f}s · 후속 key_moment): {str(s.get('title', ''))[:24]})")
                end = new_end
            new_start = _snap_to_beat_setup(start, narrative_segments)
            if new_start < start:
                print(f"   (비트 확장 start {start:.1f}s → {new_start:.1f}s (-{start - new_start:.1f}s · 선행 key_moment/setup): {str(s.get('title', ''))[:24]})")
                start = new_start
            # 확장 후 다시 문장 종결 확인 (확장된 지점에서 또 문장 중간에 걸릴 수 있음)
            if transcript:
                fixed = _snap_to_sentence_end(end, transcript)
                if duration > 0:
                    fixed = min(fixed, duration)
                if fixed > end:
                    end = fixed
        # 3축 정규화 + legacy appeal은 3축에서 산출(모델이 준 값보다 근거값이 우선)
        for k in ("hook_strength", "payoff", "completeness"):
            v = s.get(k)
            try:
                s[k] = max(0, min(10, int(v))) if v is not None else None
            except (TypeError, ValueError):
                s[k] = None
        derived_appeal = _appeal_from_axes(s)
        if derived_appeal is not None:
            appeal = derived_appeal
        else:
            appeal = s.get("appeal")
            try:
                appeal = max(1, min(5, int(appeal)))
            except (TypeError, ValueError):
                appeal = None
        score100 = _axes_score({**s, "appeal": appeal})
        out.append({**s, "start": round(start, 1), "end": round(end, 1),
                    "appeal": appeal, "score100": score100})

    # 정렬: rank가 있으면 그대로 유지 (Phase 2 판단 존중), 없으면 score100 내림차순.
    out.sort(key=lambda s: (s.get("rank") if isinstance(s.get("rank"), int) else 99,
                            -(s.get("score100") or 0.0)))
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
HEUR_MIN_SEC = 30.0      # the 30~90s window to land in when the material allows
HEUR_MAX_SEC = 90.0      # 완결성 우선 (2026-07-23): 60→90초로 완화. 하드 실링은 180s.


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
        # sc(0-1) → 3축 0-10 근사. 휴리스틱은 각 축을 구분 못 하므로 sc를 각 축에 동일 부여.
        axis10 = max(0, min(10, round(sc * 10)))
        out.append({
            "rank": rank,
            "start": start,
            "end": end,
            "title": _heur_title(usable[peak]),
            "reason": "AI 후보가 비어 자동 선별 — 신호(대사·자막·표정/움직임)가 가장 센 순간에서 시작해 30~60초로 컷",
            "hook_strength": axis10,
            "payoff": axis10,
            "completeness": axis10,
            "appeal": max(1, min(5, 2 + round(sc * 3))),
            "scene_from": usable[lo].get("index"),
            "scene_to": usable[hi].get("index"),
            "tags": _heur_tags(usable[lo:hi + 1]),
            "hook": "기타",
            "source": "heuristic",
        })
    return out


# ── entrypoint ──────────────────────────────────────────────────────────────────

_RETITLE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "titles": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "index": {"type": "INTEGER"},
                    # 대표 제목(1개) + 대체 후보(여러 개). candidates에 대표 title이 포함될
                    # 수도 있음 — 사용처(server/content-pipeline)에서 dedupe 처리.
                    "title": {"type": "STRING"},
                    "candidates": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                    },
                },
                "required": ["index", "title"],
            },
        },
    },
    "required": ["titles"],
}


# 재제목 패스에서 각 쇼츠에 뽑을 대체 제목 개수(대표 title 제외).
# 4개면 UI '제목 후보' 탭에 대표 포함 총 5개 노출 — 너무 많으면 선택 피로.
_TITLE_CANDIDATES_PER_SHORT = 4


def _retitle_final_windows(client, shorts: list[dict], transcript: list[dict] | None,
                           cast_registry: list[dict] | None = None) -> list[dict]:
    """validate_shorts 이후 최종 start/end 창의 실제 자막으로 title 재생성.

    확장(_extend_to_min) 때문에 원래 title이 결정한 좁은 창이 아니라 넓어진 창의 대사가 최종
    클립인데, 옛 title이 그대로 남으면 '잘 잘라놓고 제목이 쌩뚱맞은' 증상이 남는다. 한 번의
    배치 콜로 모든 최종 창의 title(+대체 후보 여러 개)을 다시 붙인다. 실패해도 원 title 유지."""
    if not shorts or not transcript:
        return shorts
    lines = []
    for i, s in enumerate(shorts):
        try:
            st, en = float(s["start"]), float(s["end"])
        except (KeyError, TypeError, ValueError):
            continue
        segs = []
        for t in transcript:
            try:
                tst, ten = float(t.get("start", 0)), float(t.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ten <= st or tst >= en:
                continue
            txt = (t.get("text") or "").strip()
            if not txt:
                continue
            sp = (t.get("speaker") or "").strip()
            prefix = f"[{_mmss(tst)}]" + (f" [{sp}]" if sp else "")
            segs.append(f"{prefix} {txt[:120]}")
        if not segs:
            continue
        old = str(s.get("title", "")).strip() or "-"
        lines.append(
            f"\n## 쇼츠 {i} — {_mmss(st)}~{_mmss(en)} (기존 제목: {old})\n"
            + "\n".join(segs)
        )
    if not lines:
        return shorts
    cast_block = _cast_block(cast_registry)
    n_alt = _TITLE_CANDIDATES_PER_SHORT
    # 예능 자막 톤 프롬프트. 원칙:
    #  1) 담백한 상황 묘사 + 여운 → 궁금증. clickbait 어휘 반복 금지.
    #  2) **프롬프트에 예시 제목 넣지 않는다** — 예시를 주면 모델이 그 문구·패턴에 갇힌다.
    #     대신 결(느낌)만 추상적으로 서술하고, 창의성은 temperature로 확보.
    #  3) 자막에 없는 사실은 절대 금지 (여운은 되지만 거짓은 안 됨).
    #  4) 짧게 (8~18자). 명사구 하나로도 충분.
    system = (
        "너는 한국 예능 방송의 자막 카피라이터다. 방송 화면 하단에 뜨는 CG 자막처럼 "
        "**담백하게 상황을 관찰조로 서술**하되, 다음 장면이 궁금해지는 여운을 남기는 톤으로 "
        "제목을 짓는다. 각 쇼츠의 실제 자막이 아래에 주어진다. 그 안에서 실제로 있는 일만 "
        "짧게 툭 던져라.\n"
        "\n"
        "[감성 — 이 톤을 지켜라]\n"
        "- 길이: 8~18자. 명사구 하나만으로도 좋다.\n"
        "- 담백한 상황 묘사·현재형·관찰조. 감정 어휘는 최소화, 벌어진 일을 담담히.\n"
        "- '…' 말줄임표로 여운 남기는 것은 강한 훅.\n"
        "- 인용은 자막 대사 원문 그대로 인용부호로 감쌀 것. 인용 뒤 서술은 최소.\n"
        "- 이름·직함·물건·숫자 등 구체 명사는 자막에 있는 것만.\n"
        "- 물음표(?)는 답이 즉시 이어질 때만. 단독 후크성 물음표는 금지.\n"
        "\n"
        "[치명적 금지 — 어기면 실격]\n"
        "- 다음 어휘는 **금지**: 미친, 헐, 실화, 대박, 소름, 레전드, 폭발, 폭탄, 어이없는, 충격, "
        "초토화, 뒤집어졌다, 뒤집혔다, 해버렸다, 터졌다, 터져버렸다, 저질렀다, 스튜디오.\n"
        "- 화살표(→)·물결(~) 사용 금지. 이모지·특수문자 금지 (인용부호와 말줄임표만 허용).\n"
        "- ㅋㅋㅋ·ㅎㅎ 등 자모 반복 금지. 감탄사(오·와·헐 등) 문두 금지.\n"
        "- 대괄호 뉴스 접두어([속보]/[단독]/[충격]) 금지.\n"
        "- 두루뭉술 명사(썰/이야기/모먼트/사연) 금지.\n"
        "- **자막에 없는 사실 금지**. 인물·장소·수치·행동을 만들지 마라. 인용은 자막 원문 그대로.\n"
        "\n"
        f"[제목 후보 {n_alt + 1}종 — 결을 흩어라 · 예시는 주지 않는다]\n"
        "각 쇼츠에 대표 title 1개 + 대체 candidates 4개, 총 5개를 아래 결로 흩어 뽑아라.\n"
        "각 결이 무엇인지만 지시한다. 구체적인 문구 예시는 주지 않으니 결에 맞게 스스로 만들어라.\n"
        "  (a) **상황 관찰형** — 지금 벌어지는 상황을 담담히 서술.\n"
        "  (b) **명사구형** — 인물/사물/개념 명사구 하나로 훅. 서술어 없이.\n"
        "  (c) **여운형** — '…'로 끝나는 미완성 문장. 답을 유보.\n"
        "  (d) **인용형** — 자막의 짧은 대사 조각을 인용부호로. 앞뒤 서술 최소.\n"
        "대표 title은 5개 중 가장 훅이 강한 것 하나를 골라 넣는다.\n"
        "5개 후보 모두 자막 근거는 동일. 서로 다른 결을 강제 — 문구·어미만 다른 것은 실격.\n"
        f"index는 입력의 쇼츠 번호를 그대로 돌려준다.{cast_block}"
        # 사용자가 입력한 프로그램 정보(시놉시스·태그·크레딧·방영정보)를 배경 브리핑으로 얹기.
        # recommend()가 활성화한 _CURRENT_PROGRAM_CTX를 읽어 program_context_block으로 렌더.
        f"{_program_context_block(_CURRENT_PROGRAM_CTX)}\n"
        "\n"
        'Return ONLY a valid JSON object like '
        '{"titles":[{"index":0,"title":"...","candidates":["...","...","...","..."]}]}.'
    )
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents="다음 쇼츠들에 새 제목을 지어라.\n" + "".join(lines),
            config=types.GenerateContentConfig(
                system_instruction=system,
                # Gemini 2.5 Flash 스케일 0~2. 2.0은 사실상 랜덤·JSON 파괴 확률↑라 1.5가
                # 창의 상한이자 안정 상한. 예시 문구를 프롬프트에서 뺐기 때문에 모델이 결(a~d)
                # 지시만 보고 스스로 문구를 만들어야 함 → temperature를 올려야 결이 실제로
                # 흩어진다(낮으면 모든 후보가 비슷해진다). 자막 근거를 금지 규칙으로 강하게
                # 잡아뒀으므로 hallucination은 별개 축에서 통제된다.
                temperature=1.5,
                top_p=0.98,
                response_mime_type="application/json",
                response_schema=_RETITLE_SCHEMA,
                max_output_tokens=2048,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        rows = json.loads(resp.text or "{}").get("titles", [])
    except Exception as e:
        print(f"   (재제목 패스 스킵: {str(e)[:80]})")
        return shorts
    by_index: dict[int, tuple[str, list[str]]] = {}
    for r in rows:
        try:
            idx = int(r.get("index"))
            new = str(r.get("title", "")).strip()
        except (TypeError, ValueError):
            continue
        raw_cands = r.get("candidates") or []
        cands: list[str] = []
        if isinstance(raw_cands, list):
            for c in raw_cands:
                c = str(c or "").strip()
                if c and c not in cands:
                    cands.append(c)
        if new:
            by_index[idx] = (new, cands)
    changed = 0
    for i, s in enumerate(shorts):
        entry = by_index.get(i)
        if not entry:
            continue
        new, cands = entry
        if new and new != s.get("title"):
            s["title_original"] = s.get("title")
            s["title"] = new
            changed += 1
        if cands:
            # 대표 title을 항상 첫 항목으로 두고 뒤에 대체 후보 이어 붙임 — dedupe 유지
            merged = [s["title"]] + [c for c in cands if c != s["title"]]
            s["title_candidates"] = merged
    if changed:
        print(f"   재제목 패스 — {changed}/{len(shorts)}개 제목 갱신")
    n_multi = sum(1 for s in shorts if len(s.get("title_candidates") or []) > 1)
    if n_multi:
        print(f"   제목 후보 다중 — {n_multi}/{len(shorts)}개 쇼츠")
    return shorts


def _conflicts_context_for_range(key_conflicts: list[dict] | None,
                                 start: float, end: float) -> str:
    """narrative.key_conflicts에서 청크 시간에 겹치는 갈등/핵심 사건을 뽑아 프롬프트 컨텍스트로.
    편집자가 잡는 지점의 정답에 가장 가까운 신호 (Gemini가 자막에서 이미 뽑아둔 결과). 없으면 no-op."""
    if not key_conflicts:
        return ""
    picked: list[str] = []
    for c in key_conflicts:
        try:
            tr = c.get("time_range") or {}
            cs, ce = float(tr.get("start", 0)), float(tr.get("end", 0))
        except (TypeError, ValueError):
            continue
        if ce <= start or cs >= end:
            continue
        title = str(c.get("title") or "").strip()
        desc = str(c.get("description") or "").strip()
        parts = [str(p).strip() for p in (c.get("participants") or []) if str(p).strip()][:5]
        res = str(c.get("resolution") or "").strip()
        lines = [f"[{_mmss(cs)}~{_mmss(ce)}] {title}"]
        if desc:
            lines.append(f"  설명: {desc}")
        if parts:
            lines.append(f"  참여: {', '.join(parts)}")
        if res:
            lines.append(f"  결과: {res}")
        picked.append("\n".join(lines))
    if not picked:
        return ""
    return "\n\n주요 갈등·사건 (편집자가 자주 잡는 지점):\n" + "\n".join(picked)


def _cast_timeline_context_for_range(cast_people: list[dict] | None,
                                     start: float, end: float) -> str:
    """cast.people의 인물별 등장 timeline에서 청크 시간에 겹치는 인물을 노출시간 순으로 나열.
    캐릭터 중심 쇼츠 판단 근거 (누가 이 시간대 화면에 얼마나 나오는지). 없으면 no-op."""
    if not cast_people:
        return ""
    hits: list[tuple[str, str, float]] = []
    for p in cast_people:
        if not isinstance(p, dict):
            continue
        name = (p.get("name") or "").strip()
        if not name:
            continue
        overlap = 0.0
        for seg in (p.get("appearances") or []):
            try:
                ps, pe = float(seg.get("start", 0)), float(seg.get("end", 0))
            except (TypeError, ValueError):
                continue
            if pe <= start or ps >= end:
                continue
            overlap += min(pe, end) - max(ps, start)
        if overlap > 0.5:  # 0.5s 이상 등장한 인물만
            role = (p.get("role") or "").strip()
            hits.append((name, role, overlap))
    if not hits:
        return ""
    hits.sort(key=lambda x: -x[2])
    lines = []
    for name, role, ov in hits[:8]:  # 상한 8명
        role_txt = f" ({role})" if role else ""
        lines.append(f"- {name}{role_txt} — 이 구간 노출 {_mmss(ov)}")
    return "\n\n이 구간 화면 등장 인물 (분석된 캐스트 타임라인):\n" + "\n".join(lines)


def _ppl_context_for_range(ppl_detections: list[dict] | None,
                           start: float, end: float) -> str:
    """ppl.detections에서 청크 시간에 겹치는 브랜드/제품 등장 구간을 나열.
    브랜디드 컨텐츠 회피 or 반대로 브랜드 쇼츠 신호. 없으면 no-op."""
    if not ppl_detections:
        return ""
    hits: list[str] = []
    for d in ppl_detections:
        try:
            ds, de = float(d.get("start", 0)), float(d.get("end", 0))
        except (TypeError, ValueError):
            continue
        if de <= start or ds >= end:
            continue
        brand = (d.get("brand") or "").strip()
        cat = (d.get("category") or "").strip()
        conf = d.get("confidence")
        conf_txt = f" · 신뢰 {int(conf * 100)}%" if isinstance(conf, (int, float)) else ""
        cat_txt = f" [{cat}]" if cat else ""
        hits.append(f"- [{_mmss(ds)}~{_mmss(de)}] {brand}{cat_txt}{conf_txt}")
    if not hits:
        return ""
    return "\n\nPPL·브랜드 노출 (이 구간에 등장한 상품/브랜드):\n" + "\n".join(hits[:10])  # 상한 10건


def _narrative_context_for_range(narrative_segments: list[dict] | None,
                                 start: float, end: float) -> str:
    """analyze.py에서 recommend 직전에 만들어둔 narrative의 블록 요약·key_moments를 청크
    시간 범위에 겹치는 것만 뽑아 프롬프트 컨텍스트로 변환. Phase 1이 이 정리된 근거 위에서
    후보를 고르니 title·근거의 밀착도가 올라간다. narrative가 없으면 no-op."""
    if not narrative_segments:
        return ""
    picked: list[str] = []
    for seg in narrative_segments:
        try:
            ss, se = float(seg.get("start", 0)), float(seg.get("end", 0))
        except (TypeError, ValueError):
            continue
        if se <= start or ss >= end:
            continue
        title = str(seg.get("title") or "").strip()
        summary = str(seg.get("summary") or "").strip()
        kms = [str(k).strip() for k in (seg.get("key_moments") or []) if str(k).strip()][:5]
        tone = str(seg.get("emotional_tone") or "").strip()
        chars = [str(c).strip() for c in (seg.get("characters") or []) if str(c).strip()][:6]
        lines = [f"[{_mmss(ss)}~{_mmss(se)}] {title}" + (f" · 톤:{tone}" if tone else "")]
        if summary:
            lines.append(f"  요약: {summary}")
        if kms:
            lines.append("  핵심 순간: " + " / ".join(kms))
        if chars:
            lines.append("  인물: " + ", ".join(chars))
        picked.append("\n".join(lines))
    if not picked:
        return ""
    return "\n\n서사 컨텍스트 (사전 분석 — 이 구간에서 실제로 벌어진 일):\n" + "\n".join(picked)


def recommend(
    scenes: list[dict],
    n: int = 5,
    genre: str = "auto",
    on_progress: Optional[Callable[[int, int], None]] = None,
    profile: dict | None = None,
    channels: list[str] | None = None,
    transcript: list[dict] | None = None,
    cast_registry: list[dict] | None = None,
    narrative_segments: list[dict] | None = None,
    key_conflicts: list[dict] | None = None,
    cast_people: list[dict] | None = None,
    ppl_detections: list[dict] | None = None,
    program_context: dict | None = None,
) -> dict:
    """Two-phase shorts pick. Returns {"genre": resolved, "shorts": [...]}.
    A program `profile` (optional) steers the prompts and re-ranks by program-fit
    (hookWeights × targetLength, minus taboos) — non-destructive when absent.
    `channels` (배포처 keys, default all built-in) adds a per-destination fit matrix on
    each short (`channel_scores`) without touching the board's own ranking."""
    if not scenes:
        return {"genre": DEFAULT_GENRE, "shorts": []}
    # 프로그램 컨텍스트 활성화 (recommend 스코프 동안만). _base_system이 이 globals을 읽는다.
    global _CURRENT_PROGRAM_CTX
    _prev_ctx = _CURRENT_PROGRAM_CTX
    _CURRENT_PROGRAM_CTX = program_context
    try:
        return _recommend_impl(scenes, n, genre, on_progress, profile, channels, transcript,
                               cast_registry, narrative_segments, key_conflicts, cast_people,
                               ppl_detections, program_context)
    finally:
        _CURRENT_PROGRAM_CTX = _prev_ctx


def _recommend_impl(
    scenes: list[dict],
    n: int,
    genre: str,
    on_progress: Optional[Callable[[int, int], None]],
    profile: dict | None,
    channels: list[str] | None,
    transcript: list[dict] | None,
    cast_registry: list[dict] | None,
    narrative_segments: list[dict] | None,
    key_conflicts: list[dict] | None,
    cast_people: list[dict] | None,
    ppl_detections: list[dict] | None,
    program_context: dict | None,
) -> dict:
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
            cands = _extract_candidates(client, chunk, genre, profile, cast_registry,
                                        transcript=transcript,
                                        narrative_segments=narrative_segments,
                                        key_conflicts=key_conflicts,
                                        cast_people=cast_people,
                                        ppl_detections=ppl_detections)
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
            shorts = _synthesize(client, candidates, n, genre, duration, profile, cast_registry)
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
        shorts = validate_shorts(shorts, duration, n, candidates=candidates, scenes=scenes,
                                 transcript=transcript, narrative_segments=narrative_segments)

    # GUARANTEE — the board is never empty. If the AI path produced nothing shippable
    # (found nothing, synthesis flaked, or validation trimmed everything away), cut shorts
    # mechanically from the scene signals. Always yields >=1 when scenes exist.
    if not shorts:
        floor = heuristic_shorts(scenes, n, duration, genre)
        shorts = validate_shorts(floor, duration, n, transcript=transcript,
                                 narrative_segments=narrative_segments) or floor
        print(f"   휴리스틱 폴백 — 쇼츠 {len(shorts)}개 생성 (편집자식 30~60초 컷)")

    # Post-validate 재제목 패스 — validate가 짧은 구간을 앞으로 확장하면 원래 title이 최종 창과
    # 어긋난다("잘 잘라놓고 제목 쌩뚱맞음"). 최종 창 안의 실제 자막만 근거로 title 다시 붙임.
    if shorts and transcript:
        shorts = _retitle_final_windows(client, shorts, transcript, cast_registry)

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


# ═════════════════════════════════════════════════════════════════════════════
# NARRATIVE-FIRST 파이프라인 (2026-07-23 신규 · docs/plans/narrative-first-recommend.md)
# ─────────────────────────────────────────────────────────────────────────────
# top-down 트리 구조: narrative를 먼저 보고 N 시나리오(주제) 정의 → 각 시나리오마다 K 변형
# (다른 setup/end 컷) 제안 → 시나리오당 best 1개 선정. 시나리오 다양성 보장 + 시나리오별
# 최적 컷 탐색. chunk_scan의 payoff 편향·재제목 mask·겹침 이슈 정면 해결.
# ═════════════════════════════════════════════════════════════════════════════

# 2026-07-23: 방송 실무 3-type 분화
#   숏폼(shortform): 40~60s · SNS 배포 (YT Shorts/IG Reels/TikTok)
#   클립(clip):     60~300s · SMR·유튜브 재생목록·재편집
#   하이라이트(highlight): 5~10분 · TV 재방송·홈페이지 · 여러 시나리오 조합 (별도 로직)
# 시나리오당 [숏폼 + 클립] 2개 명시적 반환 (best 선정 없음, 둘 다 output).
SHORTFORM_MIN_SEC = 40.0
SHORTFORM_MAX_SEC = 60.0
# 2026-07-23: 하이라이트(단일 영상용) 삭제 → 클립이 그 지위 흡수 (1~10분).
# 완결이 우선이라 하한은 강제 확장 안 함.
CLIP_MIN_SEC = 60.0
CLIP_MAX_SEC = 600.0
# 하이라이트는 multi-episode 전용 (docs/plans/multi-episode-highlight.md · 유예).
HIGHLIGHT_MIN_SEC = 300.0
HIGHLIGHT_MAX_SEC = 900.0

NARR_TRANSCRIPT_SAMPLE = 1500     # transcript 균등 샘플 라인 상한


def _narr_transcript_sample(transcript: list[dict], max_lines: int = NARR_TRANSCRIPT_SAMPLE) -> str:
    """전체 이해용 자막 균등 샘플. narrative가 놓친 미묘한 발화까지 컨텍스트로."""
    if not transcript:
        return ""
    segs = [s for s in transcript if (s.get("text") or "").strip()]
    if len(segs) > max_lines:
        step = len(segs) / max_lines
        segs = [segs[int(i * step)] for i in range(max_lines)]
    lines = []
    for s in segs:
        sp = (s.get("speaker") or "").strip()
        prefix = f"[{_mmss(float(s.get('start', 0)))}]" + (f" [{sp}]" if sp else "")
        lines.append(f"{prefix} {str(s.get('text','')).strip()[:120]}")
    return "\n".join(lines)


def _narr_full_context(narrative: dict | None) -> str:
    """narrative 전체를 프롬프트 컨텍스트로. full_summary + segments + key_conflicts + characters."""
    if not isinstance(narrative, dict):
        return ""
    parts = []
    fs = (narrative.get("full_summary") or "").strip()
    if fs:
        parts.append("=== 회차 전체 서사 ===\n" + fs)
    segs = narrative.get("segments") or []
    if segs:
        lines = ["=== 5분 블록별 요약 ==="]
        for seg in segs:
            try:
                ss, se = float(seg.get("start", 0)), float(seg.get("end", 0))
            except (TypeError, ValueError):
                continue
            title = str(seg.get("title") or "").strip()
            summ = str(seg.get("summary") or "").strip()
            kms = [str(k).strip() for k in (seg.get("key_moments") or []) if str(k).strip()]
            chars = [str(c).strip() for c in (seg.get("characters") or []) if str(c).strip()]
            tone = str(seg.get("emotional_tone") or "").strip()
            b = [f"[{_mmss(ss)}~{_mmss(se)}] {title}" + (f" · 톤:{tone}" if tone else "")]
            if summ:
                b.append(f"  요약: {summ}")
            if kms:
                b.append("  핵심 순간: " + " / ".join(kms))
            if chars:
                b.append("  인물: " + ", ".join(chars))
            lines.append("\n".join(b))
        parts.append("\n".join(lines))
    confs = narrative.get("key_conflicts") or []
    if confs:
        lines = ["=== 주요 갈등·핵심 사건 ==="]
        for c in confs:
            try:
                tr = c.get("time_range") or {}
                cs, ce = float(tr.get("start", 0)), float(tr.get("end", 0))
            except (TypeError, ValueError):
                continue
            title = str(c.get("title") or "").strip()
            desc = str(c.get("description") or "").strip()
            parts_p = [str(p).strip() for p in (c.get("participants") or []) if str(p).strip()]
            res = str(c.get("resolution") or "").strip()
            b = [f"[{_mmss(cs)}~{_mmss(ce)}] {title}"]
            if desc:
                b.append(f"  {desc}")
            if parts_p:
                b.append(f"  참여: {', '.join(parts_p)}")
            if res:
                b.append(f"  결과: {res}")
            lines.append("\n".join(b))
        parts.append("\n".join(lines))
    chars_ana = narrative.get("characters") or []
    if chars_ana:
        lines = ["=== 인물별 분석 ==="]
        for p in chars_ana[:10]:
            name = str(p.get("name") or "").strip()
            role = str(p.get("role") or "").strip()
            rels = [str(r).strip() for r in (p.get("key_relationships") or []) if str(r).strip()][:3]
            traits = [str(t).strip() for t in (p.get("personality_traits") or []) if str(t).strip()][:3]
            if not name:
                continue
            b = [f"- {name}" + (f" ({role})" if role else "")]
            if traits:
                b.append(f"  성격: {', '.join(traits)}")
            if rels:
                b.append(f"  관계: {' / '.join(rels)}")
            lines.append("\n".join(b))
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def _ppl_summary_context(ppl_detections: list[dict] | None) -> str:
    """전체 PPL 요약 (narrative-first 프롬프트용). 브랜드별 등장 횟수·주요 구간."""
    if not ppl_detections:
        return ""
    from collections import defaultdict
    by_brand: dict = defaultdict(list)
    for d in ppl_detections:
        brand = (d.get("brand") or "").strip()
        if not brand:
            continue
        try:
            by_brand[brand].append((float(d.get("start", 0)), float(d.get("end", 0))))
        except (TypeError, ValueError):
            continue
    if not by_brand:
        return ""
    lines = ["=== 등장 브랜드·제품 ==="]
    for brand, spans in sorted(by_brand.items(), key=lambda x: -len(x[1]))[:15]:
        first = spans[0]
        lines.append(f"- {brand}: {len(spans)}회 (최초 {_mmss(first[0])})")
    return "\n".join(lines)


def _faces_summary_context(faces: dict | None, mapping: dict | None = None) -> str:
    """faces.clusters 요약 (익명 M1/F1/... + 사용자 mapping 있으면 실명)."""
    if not isinstance(faces, dict):
        return ""
    clusters = faces.get("clusters") or {}
    if not clusters:
        return ""
    lines = ["=== 화면 등장 인물 (얼굴 클러스터) ==="]
    mapping = mapping or faces.get("mapping") or {}
    sorted_cs = sorted(clusters.items(), key=lambda x: -(x[1].get("count", 0) or 0))
    for cid, c in sorted_cs[:10]:
        name = mapping.get(cid, "").strip() or cid
        cnt = c.get("count", 0)
        g = c.get("gender_hint", "?")
        lines.append(f"- {name} [{g}]: {cnt} 프레임 등장")
    return "\n".join(lines)


# Phase A · propose_scenarios ───────────────────────────────────────────────
# 회차 전체를 이해한 뒤 "완결된 하이라이트 스토리 N개 주제"만 정의 (시간은 대략). 다음 단계에서
# 각 시나리오마다 여러 컷 변형을 뽑고 best를 고른다 (트리 구조).

_SCENARIOS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "scenarios": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "INTEGER"},
                    "story_title": {"type": "STRING"},
                    "story_synopsis": {"type": "STRING"},
                    "core_moment_sec": {"type": "NUMBER"},
                    "approx_start_sec": {"type": "NUMBER"},
                    "approx_end_sec": {"type": "NUMBER"},
                    "characters": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "hook": {"type": "STRING"},
                    "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
                "required": ["id", "story_title", "story_synopsis",
                             "core_moment_sec", "approx_start_sec", "approx_end_sec", "hook"],
            },
        },
    },
    "required": ["scenarios"],
}


def propose_scenarios(
    client, narrative: dict | None, transcript: list[dict],
    profile: dict | None, genre: str, n: int, duration: float,
    cast_registry: list[dict] | None = None,
    faces: dict | None = None, ppl_detections: list[dict] | None = None,
) -> list[dict]:
    """Phase A: 이 회차의 완결된 하이라이트 시나리오 N개 정의 (주제 레벨, 시간 대략)."""
    pack = _pack(genre)
    system = f"""너는 {pack['label']} 콘텐츠의 숏폼(쇼츠) 편집 팀장이다. 이 회차 전체 서사·자막·인물·
브랜드 정보를 다 봤다. **이 회차에서 만들 만한 완결된 하이라이트 시나리오 {n}개를 정의**하라.

이 장르의 터지는 기준:
{pack['guidance']}

**시나리오는 "쇼츠 하나의 주제 아이디어"다** — 다음 단계에서 각 시나리오마다 여러 컷 변형을
뽑고 best를 고른다. 지금은 주제를 뽑아라, 정확한 컷 시간은 대략.

**시나리오 조건**:
1. 각 시나리오는 서로 다른 주제·순간·감정을 담아야 한다 (다양성 강제). 비슷한 주제 두 번 금지.
2. 완결된 스토리 단위: setup → payoff → closure가 성립할 수 있는 지점.
3. **길이 원칙**: 완결성이 최우선. 이상적으로 30~90초, 완결에 필요하면 120초까지. 스토리가
   잘리는 것보다 조금 긴 게 낫다. 하드 실링 180초는 넘지 마라.
4. 근거는 서사 요약·key_moments·자막이 있는 순간만.

**⚠️ 시간(초) 산정 규칙 — 반드시 준수**:
- **core_moment_sec, approx_start_sec, approx_end_sec은 자막의 실제 [MM:SS]를 초로 환산한 값**
  이다. 예: [01:43]이면 103.0. 절대 0이나 임의 값 넣지 마라.
- 아래 서사 컨텍스트의 key_moments가 [MM:SS] 형식으로 붙어있다 — 그 시각을 직접 참조.
- approx_start는 setup(맥락 시작) 시각, approx_end는 payoff+closure 끝 시각.
- 두 시나리오의 approx 시각이 겹치지 않게 (다양성 강제와 연결).
- **🚨 절대 영상 총 길이를 넘는 시간을 반환하지 마라.** 아래 컨텍스트 마지막에 명시된 총 길이가
  상한이다. 그 안에 자막·key_moment가 없는 시간대는 존재하지 않는 순간이니 시나리오로 뽑지 마라.

**필드**:
- id: 시나리오 번호 (0..{n-1})
- story_title: 이 시나리오의 제목 (아래 title 규칙 준수)
- story_synopsis: 무슨 이야기인지 1~2문장
- core_moment_sec: 클라이맥스·터짐 순간 초 (자막 [MM:SS] 근거)
- approx_start_sec: setup 시작 초 (자막 [MM:SS] 근거)
- approx_end_sec: payoff+closure 끝 초 (자막 [MM:SS] 근거 · approx_start보다 반드시 큼)
- characters: 이 시나리오 주역 (등록 명단만 실명, 나머지는 익명)
- hook: 반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타 중 하나
- tags: 3-5개 짧은 태그

**⚠️ title 작성 규칙 (매우 중요)**:
- **한국인이 실제 쓰는 자연스러운 한국어**로. 번역체·문법 어긋난 문장 금지.
- 12~30자, 방송·편집실에서 쓰는 실전 어투. 조사·어미가 자연스럽게.
- 클릭 유도하되 억지 낚시 금지 — 물음표·느낌표 남용 X (1개까지).
- "이거는 절대로", "잘 못 알았네요", "정말 신뢰가 그녀" 같은 어색한 문장 절대 금지.
- **좋은 예**: "은규가 한의사였다니, 반전에 웅성" · "결혼식 앞두고 밝힌 X" · "모두 감탄한 지연의 스타일"
- **나쁜 예**: "잘 못 알았네요! 이거는 절대로 7년차?" · "결혼 앞두 있음?" · "정말 신뢰가 그녀"
"""
    if profile:
        system += _profile_block(profile)
    if cast_registry:
        system += _cast_block(cast_registry)

    contents_parts = []
    narr_ctx = _narr_full_context(narrative)
    if narr_ctx:
        contents_parts.append(narr_ctx)
    ppl_ctx = _ppl_summary_context(ppl_detections)
    if ppl_ctx:
        contents_parts.append(ppl_ctx)
    faces_ctx = _faces_summary_context(faces)
    if faces_ctx:
        contents_parts.append(faces_ctx)
    tx_sample = _narr_transcript_sample(transcript)
    if tx_sample:
        contents_parts.append("=== 자막 균등 샘플 (전체 이해용) ===\n" + tx_sample)
    contents_parts.append(f"\n영상 총 길이: {_mmss(duration)} ({duration:.0f}s)")
    contents_parts.append(f"뽑을 시나리오 수: {n}")

    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents="다음 정보를 근거로 하이라이트 시나리오를 정의하라.\n\n" + "\n\n".join(contents_parts),
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                response_schema=_SCENARIOS_SCHEMA,
                max_output_tokens=8192,
            ),
        ))
        scenarios = json.loads(resp.text or "{}").get("scenarios", [])
    except Exception as e:
        print(f"   (Phase A 시나리오 실패: {str(e)[:120]})")
        return []

    # Post-validation: duration 초과 시나리오는 core_moment 중심으로 clamp (모델이 종종
    # 자막 [MM:SS] 마지막 이후 시간을 hallucinate — 환승연애 case에서 747·834·931s 관찰).
    # 완전 밖(core_moment > duration + margin)이면 시나리오 제외.
    cleaned = []
    dropped = 0
    for s in scenarios:
        try:
            core = float(s.get("core_moment_sec", 0))
            ast = float(s.get("approx_start_sec", 0))
            aen = float(s.get("approx_end_sec", 0))
        except (TypeError, ValueError):
            dropped += 1
            continue
        if duration > 0 and core > duration + 5:
            # 완전 duration 밖 · hallucination · 제외
            print(f"   (Phase A 시나리오 {s.get('id','?')} 제외 · core={core}s > duration {duration}s: {s.get('story_title','')[:24]})")
            dropped += 1
            continue
        # duration 안으로 clamp (core 유지, setup/end만 조정)
        if duration > 0:
            aen = min(aen, duration - 0.5)
            ast = max(0.0, min(ast, aen - 5.0))  # 최소 5초 창 보장
            if aen <= ast:
                # core 중심 재산정 (setup=core-30, end=core+30, 창 60s)
                ast = max(0.0, core - 30.0)
                aen = min(duration - 0.5, core + 30.0)
                if aen <= ast:
                    dropped += 1
                    continue
            s["approx_start_sec"] = round(ast, 1)
            s["approx_end_sec"] = round(aen, 1)
            s["core_moment_sec"] = round(min(core, duration - 0.5), 1)
        cleaned.append(s)
    print(f"   Phase A: 시나리오 {len(cleaned)}개 정의 (요청 {n}, 반환 {len(scenarios)}, 검증 탈락 {dropped})")
    return cleaned


# Phase B · expand_variations_and_pick_best ─────────────────────────────────
# 각 시나리오마다 K개 컷 변형을 제안하고, 시나리오별 best 1개를 함께 선정 (하나의 콜).

_VARIATIONS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "scenarios": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "scenario_id": {"type": "INTEGER"},
                    "variations": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "variation_index": {"type": "INTEGER"},
                                "setup_start_sec": {"type": "NUMBER"},
                                "payoff_moment_sec": {"type": "NUMBER"},
                                "payoff_end_sec": {"type": "NUMBER"},
                                "hook_strength": {"type": "INTEGER"},
                                "payoff": {"type": "INTEGER"},
                                "completeness": {"type": "INTEGER"},
                                "why_this_cut": {"type": "STRING"},
                            },
                            "required": ["variation_index", "setup_start_sec",
                                         "payoff_moment_sec", "payoff_end_sec",
                                         "hook_strength", "payoff", "completeness"],
                        },
                    },
                    "best_variation_index": {"type": "INTEGER"},
                    "best_reason": {"type": "STRING"},
                },
                "required": ["scenario_id", "variations", "best_variation_index"],
            },
        },
    },
    "required": ["scenarios"],
}


def _expand_single_scenario(
    client, scenario: dict, transcript: list[dict], genre: str, k: int,
    profile: dict | None, cast_registry: list[dict] | None,
) -> dict | None:
    """한 시나리오에 대해 [숏폼(40~60s) + 클립(60~300s)] 2개 컷 명시적 반환 (단일 콜, 병렬 안전).
    K 인자는 하위 호환용 · 무시. 2026-07-23 방송 실무 3-type 분화."""
    try:
        sid = int(scenario.get("id", -1))
        core = float(scenario.get("core_moment_sec", 0))
        ast = float(scenario.get("approx_start_sec", 0))
        aen = float(scenario.get("approx_end_sec", 0))
    except (TypeError, ValueError):
        return None
    pack = _pack(genre)
    system = f"""너는 {pack['label']} SNS 숏폼(YouTube Shorts/IG Reels/TikTok) 편집자다. 아래 **한
시나리오**에 대해 최적의 숏폼 컷 1개를 만든다.

**숏폼(shortform) 정의**:
- **40~60초** · SNS 배포. 훅은 첫 2~3초 (스와이프 방지가 목표).
- 단일 순간에 집중 · setup + payoff + closure 최소 압축. 감정·펀치라인·반전이 명확.
- **⚠️ 시나리오 title이 promise한 내용이 setup~end 창 안에 실제로 있어야 함**. 예: title이
  "원규의 한의사 반전"이면 창 안에 원규 직업 공개 순간(자막에서 "저는 한의사입니다" 등)이
  실제로 담겨야. 없으면 setup을 앞으로 확장해서 그 순간 포함시켜라.

**⚠️ 시간 필드 형식**: setup_start_sec / payoff_moment_sec / payoff_end_sec 는 **초 단위 숫자**만.
자막 [08:43]이면 523.0으로 환산. "8:43" 같은 콜론 포함 문자열 절대 금지.

**3축 스코어** (0-10 정수, 서로 독립):
- hook_strength: 첫 2~3초 시선강탈 강도 (0=평범, 8=강함, 10=꺾이는 오프닝)
- payoff: 결정타 임팩트 (0=평이, 5=제대로 터짐, 10=바이럴 확실)
- completeness: 앞뒤 맥락·완결성
세 축 다 8+ 몰아주지 마라.

**반환 형식** (JSON, 다른 문장 없이):
{{"shortform":{{"setup_start_sec":100.0,"payoff_moment_sec":140.0,"payoff_end_sec":150.0,"hook_strength":8,"payoff":8,"completeness":7,"why_this_cut":"..."}}}}
"""
    if profile:
        system += _profile_block(profile)
    if cast_registry:
        system += _cast_block(cast_registry)

    # 시나리오 지역 자막 (앞뒤 20s 여유)
    lo = max(0.0, ast - 20)
    hi = aen + 20
    segs = []
    for t in transcript or []:
        try:
            tst, ten = float(t.get("start", 0)), float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if ten <= lo or tst >= hi:
            continue
        txt = (t.get("text") or "").strip()
        if not txt:
            continue
        sp = (t.get("speaker") or "").strip()
        prefix = f"[{_mmss(tst)}]" + (f" [{sp}]" if sp else "")
        segs.append(f"{prefix} {txt[:120]}")
    block = [
        f"=== 시나리오 {sid}: {scenario.get('story_title', '')} ===",
        f"주제: {scenario.get('story_synopsis', '')}",
        f"대략: {_mmss(ast)}~{_mmss(aen)} · 클라이맥스 {_mmss(core)}",
        f"hook: {scenario.get('hook', '-')} · 인물: {','.join(scenario.get('characters') or [])[:40]}",
        f"이 시나리오 지역 자막 ({_mmss(lo)}~{_mmss(hi)}):",
    ]
    block.extend(f"  {s}" for s in segs)
    prompt = "\n".join(block)

    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=f"이 시나리오에 대해 {k}개 컷 변형을 제안하고 best 1개를 선정하라.\n\n" + prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                # 8192로 재상향 (4096에서 시나리오별 K=3 variation 담기에 부족 · MAX_TOKENS 관찰됨).
                max_output_tokens=8192,
                # thinking 비활성으로 output budget 확보 (내부 reasoning이 output token 잡아먹음).
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        raw = resp.text or ""
        # finish_reason 진단
        try:
            fr = resp.candidates[0].finish_reason if resp.candidates else "unknown"
        except (AttributeError, IndexError):
            fr = "unknown"
        if not raw.strip():
            print(f"   (시나리오 {sid} raw 비어있음 · finish_reason={fr})")
            return None
        # partial JSON 복구
        data = None
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # 마지막 } 뒤에 ]} 붙여 복구
            lc = raw.rfind("}")
            if lc > 0:
                for suffix in ("]}", "}]}"):
                    try:
                        data = json.loads(raw[: lc + 1] + suffix)
                        break
                    except json.JSONDecodeError:
                        continue
        # 모델이 shortform_variations 배열로 반환하는 케이스 대응 (관찰됨)
        shortform_data = None
        if isinstance(data, dict):
            if isinstance(data.get("shortform"), dict):
                shortform_data = data["shortform"]
            elif isinstance(data.get("shortform_variations"), list) and data["shortform_variations"]:
                # 배열이면 첫 element 사용
                first = data["shortform_variations"][0]
                if isinstance(first, dict):
                    # 중첩된 {shortform: {...}} 형태도 지원
                    shortform_data = first.get("shortform") if isinstance(first.get("shortform"), dict) else first
            elif isinstance(data.get("best_cut"), dict) and isinstance(data["best_cut"].get("shortform"), dict):
                shortform_data = data["best_cut"]["shortform"]
        if not isinstance(shortform_data, dict):
            print(f"   (시나리오 {sid} 파싱 실패 · finish_reason={fr} · raw앞: {raw[:100]!r})")
            return None
        return {
            "scenario_id": sid,
            "shortform": shortform_data,
        }
    except Exception as e:
        print(f"   (시나리오 {sid} 콜 실패: {str(e)[:120]})")
        return None


def propose_clips(
    client, narrative: dict | None, transcript: list[dict],
    profile: dict | None, genre: str, n: int, duration: float,
    cast_registry: list[dict] | None = None,
) -> list[dict]:
    """방송용 클립(코너·주제 단위 60~300s) 정의. 시나리오와 독립적으로 편집.
    예: '자기소개 코너 전체', '게임 하이라이트', '데이트 신 모음', '감정 리액션 모음'.
    2026-07-23 신규 · 사용자 방향: 클립은 숏폼과 성격 다름 (코너/주제 편집)."""
    pack = _pack(genre)
    system = f"""너는 {pack['label']} 방송용 클립 편집자다 (SMR·YT 재생목록·재편집 배포).
**이 회차의 코너·주제 단위 클립 {n}개**를 정의하라. 숏폼과 다른 성격:
- 숏폼은 단일 순간의 압축이지만, 클립은 **하나의 코너·주제·화제 장면 전체**를 담는다.
- 예: 자기소개 코너 전체 (여러 사람 순차) · 게임 코너 전체 · 데이트 신 모음 · 리액션 모음
- 시나리오 하나로 국한하지 마라 — 같은 주제의 여러 순간을 이어붙일 수 있음.

**클립 조건**:
1. **완결이 최우선**. 실제 코너·주제가 1분이면 1분, 8분이면 8분. 원 스토리 길이 존중.
2. 각 클립은 서로 다른 코너·주제 (중복 금지).
3. 훅은 시작 30초 안 (넘길 유혹 방지).
4. **⚠️ title이 promise한 모든 요소가 setup~end 안에 실제로 있어야 함**. 예: title이
   "지연과 원규의 직업 공개"면 setup~end 사이에 두 사람 공개 순간이 다 담겨야. 하나만
   담기면 title에서 다른 사람 이름 빼거나, 시간 창 확장해서 둘 다 담기.
5. **범위 60초~10분** · 하드 실링 10분 (600초). 60초 미만 절대 금지 — 그건 코너 아님, 숏폼.
   1~5분급 코너 클립, 5~10분급 큰 세션 (여러 코너 묶임)도 OK.
6. setup_start_sec / payoff_end_sec 사이 **최소 60초** · 그 미만이면 시나리오 재검토 or 제외.

**⚠️ 시간 필드 형식**: setup_start_sec / payoff_end_sec 는 **초 단위 숫자**만. "8:43" 금지.
영상 총 길이 밖 시간 절대 반환 금지.

**3축 스코어** (0-10):
- hook_strength: 시작 30초 안 시선 잡는 힘
- payoff: 코너의 결정타·클라이맥스 강도
- completeness: 코너 완결성 (시작~마무리)

**hook 필드는 반드시 다음 카테고리 중 **한 단어**만**: 반전 / 감정고조 / 돌직구 / 질문 / 정보성 / 웃음 / 갈등 / 공감 / 기타.
서술·문장·복수 카테고리·그 외 값 금지. 애매하면 "기타".

**반환 형식** (JSON):
{{"clips":[{{"title":"...","synopsis":"...","setup_start_sec":100.0,"payoff_moment_sec":200.0,"payoff_end_sec":280.0,"hook":"웃음","tags":["..."],"hook_strength":7,"payoff":8,"completeness":9,"why_this_clip":"..."}}]}}
"""
    if profile:
        system += _profile_block(profile)
    if cast_registry:
        system += _cast_block(cast_registry)

    contents_parts = []
    narr_ctx = _narr_full_context(narrative)
    if narr_ctx:
        contents_parts.append(narr_ctx)
    tx_sample = _narr_transcript_sample(transcript)
    if tx_sample:
        contents_parts.append("=== 자막 균등 샘플 ===\n" + tx_sample)
    contents_parts.append(f"\n영상 총 길이: {_mmss(duration)} ({duration:.0f}s) — 이 안에서만 시간 사용")
    contents_parts.append(f"뽑을 클립 수: {n}")

    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents="회차의 코너·주제 단위 클립을 정의하라.\n\n" + "\n\n".join(contents_parts),
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                max_output_tokens=8192,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        raw = resp.text or ""
        data = None  # 파서 실패해도 정의된 상태 유지 (버그 fix)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            lc = raw.rfind("}")
            if lc > 0:
                for suffix in ("]}", "}]}"):
                    try:
                        data = json.loads(raw[: lc + 1] + suffix)
                        break
                    except json.JSONDecodeError:
                        continue
        clips = data.get("clips", []) if isinstance(data, dict) else []
    except Exception as e:
        print(f"   (클립 정의 실패: {str(e)[:120]})")
        return []

    # duration 밖 필터
    cleaned = []
    for c in clips:
        try:
            se = float(c.get("payoff_end_sec", 0))
        except (TypeError, ValueError):
            continue
        if duration > 0 and se > duration + 5:
            print(f"   (클립 제외 · end={se}s > duration: {c.get('title','')[:24]})")
            continue
        cleaned.append(c)
    print(f"   클립 {len(cleaned)}개 정의 (요청 {n}, 반환 {len(clips)})")
    return cleaned


def curate_highlight(
    client, scenarios: list[dict], narrative: dict | None, transcript: list[dict],
    profile: dict | None, genre: str, duration: float,
    cast_registry: list[dict] | None = None,
) -> dict | None:
    """회차 전체 관통 대주제 잡고 편집 큐레이션. 단순 concat 아니라 오프닝→클라이맥스→마무리 구조.
    2026-07-23 신규 · 사용자 방향: 하이라이트는 영상 전체의 큰 주제."""
    pack = _pack(genre)
    system = f"""너는 {pack['label']} 방송의 회차 하이라이트 편집자다. TV 재방송·홈페이지·YouTube 정규
업로드용 **5~10분 하이라이트 1편**을 큐레이션하라.

**하이라이트 조건**:
1. **회차 전체를 관통하는 대주제(overarching_theme) 하나 정의** — 예: "환승연애 1회 · 새로운
   시작과 반전들", "무한도전 5회 · 예상치 못한 팀 대결".
2. **편집 세그먼트 리스트** — 오프닝 훅(강한 순간 티저 30~60s) → 전개(시나리오 순서대로 컷) →
   마무리(감정 여운 or 다음 티저). 단순 concat 아니라 **큐레이션**.
3. 총 길이 5~10분 (300~600s). 각 세그먼트 setup/end 실제 자막 시각 기준.
4. 시나리오는 이미 정의됨 — 그중 어떤 걸 어떤 순서로 편집할지 결정.

**⚠️ 시간 필드**: 초 단위 숫자만. "8:43" 금지. duration 밖 금지.

**반환 형식** (JSON):
{{"overarching_theme":"...","title":"...","synopsis":"...","segments":[{{"role":"opening_hook","scenario_id":0,"start_sec":100.0,"end_sec":130.0,"note":"..."}}],"total_length_sec":420,"editor_note":"..."}}
role은 "opening_hook" | "development" | "climax" | "closing" 중 하나.
"""
    if profile:
        system += _profile_block(profile)
    if cast_registry:
        system += _cast_block(cast_registry)

    # 시나리오 요약 + narrative
    scenario_lines = []
    for s in scenarios:
        sid = s.get("id", "?")
        title = str(s.get("story_title") or "").strip()
        core = s.get("core_moment_sec", 0)
        ast = s.get("approx_start_sec", 0)
        aen = s.get("approx_end_sec", 0)
        scenario_lines.append(f"- 시나리오 {sid} [{_mmss(ast)}~{_mmss(aen)}] {title}")

    contents_parts = ["=== 시나리오 목록 ===\n" + "\n".join(scenario_lines)]
    narr_ctx = _narr_full_context(narrative)
    if narr_ctx:
        contents_parts.append(narr_ctx)
    contents_parts.append(f"\n영상 총 길이: {_mmss(duration)} · 하이라이트 목표 5~10분")

    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents="이 회차의 하이라이트를 큐레이션하라.\n\n" + "\n\n".join(contents_parts),
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                max_output_tokens=8192,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        raw = resp.text or ""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            lc = raw.rfind("}")
            data = None
            if lc > 0:
                for suffix in ("}",):
                    try:
                        data = json.loads(raw[: lc + 1])
                        break
                    except json.JSONDecodeError:
                        continue
        if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
            print(f"   (하이라이트 큐레이션 실패 · raw앞: {raw[:100]!r})")
            return None
        segs = data.get("segments", [])
        # duration 밖 필터
        clean_segs = []
        for seg in segs:
            try:
                ss = float(seg.get("start_sec", 0))
                se = float(seg.get("end_sec", 0))
            except (TypeError, ValueError):
                continue
            if duration > 0:
                se = min(se, duration - 0.5)
            if se <= ss or (duration > 0 and ss > duration):
                continue
            clean_segs.append({
                "role": seg.get("role", "development"),
                "scenario_id": seg.get("scenario_id"),
                "start": round(ss, 1),
                "end": round(se, 1),
                "note": seg.get("note", ""),
            })
        if not clean_segs:
            print(f"   (하이라이트 세그먼트 모두 필터링됨)")
            return None
        total = round(sum(s["end"] - s["start"] for s in clean_segs), 1)
        print(f"   하이라이트 큐레이션: {len(clean_segs)} 세그먼트, 총 {total}s, 대주제='{data.get('overarching_theme','')[:30]}'")
        return {
            "overarching_theme": data.get("overarching_theme", ""),
            "title": data.get("title", ""),
            "synopsis": data.get("synopsis", ""),
            "segments": clean_segs,
            "total_length_sec": total,
            "editor_note": data.get("editor_note", ""),
        }
    except Exception as e:
        print(f"   (하이라이트 큐레이션 콜 실패: {str(e)[:120]})")
        return None


def expand_and_pick_variations(
    client, scenarios: list[dict], narrative: dict | None, transcript: list[dict],
    genre: str, k: int = 2,
    profile: dict | None = None, cast_registry: list[dict] | None = None,
) -> list[dict]:
    """Phase B: 각 시나리오별 병렬 콜로 K개 변형 + best 선정. 개별 콜이 빈 응답이어도 다른 시나리오
    영향 없음. 병렬 워커 = min(시나리오 수, 4). 2026-07-23: 단일 통합 콜이 빈 응답 반환하는 이슈로
    시나리오별 분해."""
    if not scenarios:
        return []
    # 병렬 실행
    from concurrent.futures import ThreadPoolExecutor
    workers = min(len(scenarios), 4)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_expand_single_scenario, client, s, transcript, genre, k,
                             profile, cast_registry) for s in scenarios]
        results = [f.result() for f in futures]
    result = [r for r in results if r is not None]
    total_var = sum(len(r.get("variations", [])) for r in result)
    ok_ratio = f"{len(result)}/{len(scenarios)}"
    print(f"   Phase B: 시나리오 성공 {ok_ratio} · 총 변형 {total_var}")
    return result


def _expand_and_pick_variations_UNUSED_(
    client, scenarios: list[dict], narrative: dict | None, transcript: list[dict],
    genre: str, k: int = 2,
    profile: dict | None = None, cast_registry: list[dict] | None = None,
) -> list[dict]:
    """[DEPRECATED · 2026-07-23] 단일 통합 콜 버전. 빈 응답 이슈로 시나리오별 분해로 교체.
    폴백/디버그용으로만 남김. 사용 금지."""
    if not scenarios:
        return []
    pack = _pack(genre)
    system = f"""너는 {pack['label']} 콘텐츠의 숏폼 편집자다. 앞 단계에서 정의된 시나리오 목록을 받았다.
**각 시나리오마다 서로 다른 {k}개의 컷 변형을 제안**하고, 그중 **best 1개를 선정**하라.

**변형(variation)이란**: 같은 스토리를 다르게 자르는 방식들.
- 예: variation 0 = 짧게 핵심만 (30~45s), variation 1 = setup 포함 (45~75s), variation 2 = 완결·여운까지 (75~120s)
- 각자 setup_start_sec / payoff_moment_sec / payoff_end_sec 다르게.
- 실제 자막 타임스탬프를 근거로. 시나리오 approx_start/end는 참고만.
- **완결성 우선**: 스토리가 잘리면 실패. 60초 넘어도 완결이 우선. 180초는 넘지 마라.

**3축 스코어** (각 변형마다):
- hook_strength: 첫 2~3초 시선강탈 강도 (0=평범, 5=명확, 8=강함, 10=꺾이는 오프닝)
- payoff: 결정타 임팩트 (0=평이, 5=제대로 터짐, 8=예상 초과, 10=바이럴 확실)
- completeness: 앞뒤 맥락·완결성 (0=문맥 없음, 5=완결된 장면, 8=편집자 컷, 10=그대로 발행 가능)
세 축 다 8+ 몰아주지 마라 — 대부분 축마다 편차가 있다.

**best_variation_index**: 그 시나리오의 {k}개 변형 중 최고. 근거는 완결성·훅·payoff 균형.

**필드 (per scenario)**:
- scenario_id: 원 시나리오 id
- variations: {k}개 변형 리스트 (각각 variation_index 0..{k-1}, setup/payoff/end, 3축, why_this_cut)
- best_variation_index: 이 시나리오의 best 컷 (0..{k-1})
- best_reason: 왜 이걸 best로 골랐는지 한 문장
"""
    if profile:
        system += _profile_block(profile)
    if cast_registry:
        system += _cast_block(cast_registry)

    # 시나리오 목록 + 서사 근거 (각 시나리오 지역만) 컨텍스트
    contents_parts = []
    for s in scenarios:
        try:
            sid = int(s.get("id", -1))
            core = float(s.get("core_moment_sec", 0))
            ast = float(s.get("approx_start_sec", 0))
            aen = float(s.get("approx_end_sec", 0))
        except (TypeError, ValueError):
            continue
        # 시나리오 지역 자막 발췌 (setup~end 앞뒤 20s 여유)
        lo = max(0.0, ast - 20)
        hi = aen + 20
        segs = []
        for t in transcript or []:
            try:
                tst, ten = float(t.get("start", 0)), float(t.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ten <= lo or tst >= hi:
                continue
            txt = (t.get("text") or "").strip()
            if not txt:
                continue
            sp = (t.get("speaker") or "").strip()
            prefix = f"[{_mmss(tst)}]" + (f" [{sp}]" if sp else "")
            segs.append(f"{prefix} {txt[:120]}")
        block = [
            f"\n=== 시나리오 {sid}: {s.get('story_title', '')} ===",
            f"  주제: {s.get('story_synopsis', '')}",
            f"  대략: {_mmss(ast)}~{_mmss(aen)} · 클라이맥스 {_mmss(core)}",
            f"  hook: {s.get('hook', '-')} · 인물: {','.join(s.get('characters') or [])[:40]}",
            f"  이 시나리오 지역 자막 ({_mmss(lo)}~{_mmss(hi)}):",
        ]
        block.extend(f"    {s}" for s in segs)
        contents_parts.append("\n".join(block))

    # AENA 원칙 (2026-07-23): nested array + required 조합이 Vertex Gemini에서 빈 응답 유발
    # 관찰됨 (Phase B 시나리오 0개 반환). response_schema 제거, 프롬프트 예시 + 파서로 복구.
    example_hint = (
        '\n\n반환 형식 (JSON, 다른 문장 없이):\n'
        '{"scenarios":[{"scenario_id":0,"variations":[' +
        ','.join(
            '{"variation_index":' + str(i) +
            ',"setup_start_sec":100.0,"payoff_moment_sec":140.0,"payoff_end_sec":170.0,' +
            '"hook_strength":7,"payoff":8,"completeness":7,"why_this_cut":"..."}'
            for i in range(k)
        ) +
        '],"best_variation_index":1,"best_reason":"..."}]}'
    )
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=f"각 시나리오마다 {k}개 컷 변형을 제안하고 best 1개를 선정하라.\n"
                    + "\n".join(contents_parts) + example_hint,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                # response_schema 제거 (nested required가 빈 응답 유발)
                max_output_tokens=8192,
            ),
        ))
        raw = resp.text or ""
        # 진단용 앞부분 로그
        if not raw.strip() or raw.strip() == "{}":
            print(f"   (Phase B raw 응답 이상: '{raw[:200]}')")
        result = _parse_variations_json(raw)
    except Exception as e:
        print(f"   (Phase B 변형 실패: {str(e)[:120]})")
        return []
    total_var = sum(len(r.get("variations", [])) for r in result)
    print(f"   Phase B: 시나리오 {len(result)} · 총 변형 {total_var} · best 선정 완료")
    return result


def _parse_variations_json(raw: str) -> list[dict]:
    """Phase B raw JSON 응답 → scenarios 리스트. partial 잘림 복구."""
    if not raw:
        return []
    s = raw.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        if nl >= 0:
            s = s[nl + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3].rstrip()
    # 시도 1: 그대로
    try:
        v = json.loads(s)
        if isinstance(v, dict) and isinstance(v.get("scenarios"), list):
            return v["scenarios"]
    except json.JSONDecodeError:
        pass
    # 시도 2: 잘림 복구 — 마지막 완전 `}` 뒤에서 `]}` 로 닫기
    last_close = s.rfind("}")
    if last_close > 0:
        for suffix in ("]}", "}]}"):
            try:
                v = json.loads(s[: last_close + 1] + suffix)
                if isinstance(v, dict) and isinstance(v.get("scenarios"), list):
                    return v["scenarios"]
            except json.JSONDecodeError:
                continue
    return []


# refine_boundaries · 룰 기반 경계 정렬 ─────────────────────────────────────

def _refine_story_boundary(
    story: dict, transcript: list[dict] | None, scenes: list[dict] | None, duration: float,
    vtype: str = "shortform", shots: list[float] | None = None,
) -> tuple[float, float]:
    """스토리의 setup_start / payoff_end 를 문장·발화·장면 경계로 정렬. 타입별 길이 창 적용.
    vtype: 'shortform' (40~60s) | 'clip' (60~300s) | 'highlight' (300~600s).
    shots: 프레임 diff 기반 shot boundary 시각(sec) 리스트. 있으면 end 스냅 후 가장 가까운
    shot boundary(±3s)로 한 번 더 맞춰 시각적 컷과 일치시킴. 없으면 STT 기반 스냅만 사용."""
    if vtype == "clip":
        vmin, vmax, vaim = CLIP_MIN_SEC, CLIP_MAX_SEC, 120.0
    elif vtype == "highlight":
        vmin, vmax, vaim = HIGHLIGHT_MIN_SEC, HIGHLIGHT_MAX_SEC, 480.0
    else:  # shortform
        vmin, vmax, vaim = SHORTFORM_MIN_SEC, SHORTFORM_MAX_SEC, 50.0
    try:
        start = max(0.0, float(story.get("setup_start_sec", 0)))
        end = float(story.get("payoff_end_sec", start))
        peak = float(story.get("payoff_moment_sec", (start + end) / 2))
    except (TypeError, ValueError):
        return 0.0, 0.0
    if end <= start:
        return start, start
    if duration > 0:
        end = min(end, duration)
    # 시작 발화 스냅 (문장 첫 발화로 정렬)
    if transcript:
        start, end = _snap_to_speech(start, end, transcript)
        # 종결어미 스냅 (문장 완결까지)
        new_end = _snap_to_sentence_end(end, transcript)
        if duration > 0:
            new_end = min(new_end, duration)
        end = new_end
    # 타입별 길이 정합 (2026-07-23 3-type · 사용자 피드백 반영):
    #   - 숏폼: 하한 미달 시 payoff 중심 확장 (aim까지). SNS 컨텍스트 특성상 최소 필요.
    #   - 클립·하이라이트: **하한 확장 금지** · 원 시간 그대로. 완결이 최소 길이보다 우선.
    #     (기존 CLIP_MIN_SEC=60 강제 확장이 다음 신 유입·억지 편집 유발 관찰됨)
    #   - 공통: 상한 초과 시 payoff 기준 trim.
    length = end - start
    # 절대 하한(안전망) — 극단 잘림 방지. 클립은 최소 1분 (60s) — 그 미만은 코너가 아니라
    # 숏폼임. 2026-07-24 사용자 지적: 클립 49~56초로 나옴 → ABS_MIN 30→60 상향.
    ABS_MIN = {"shortform": 15.0, "clip": 60.0, "highlight": 120.0}.get(vtype, 15.0)
    if length < ABS_MIN:
        # payoff_moment 중심으로 aim 근처 확장 (완결이 우선 · 하지만 최소 크기는 보장)
        wanted = max(ABS_MIN, min(vaim, duration if duration > 0 else vaim))
        start = max(0.0, peak - wanted * 0.6)
        end = min(duration if duration > 0 else peak + wanted * 0.4, peak + wanted * 0.4)
        if scenes:
            start, end = _extend_to_min(start, end, scenes, aim=wanted, hard_max=vmax)
            if duration > 0:
                end = min(end, duration)
    elif length < vmin and vtype == "shortform":
        # 숏폼만 aim까지 추가 확장 (SNS 컨텍스트 특성)
        if scenes:
            start, end = _extend_to_min(start, end, scenes, aim=vaim, hard_max=vmax)
            if duration > 0:
                end = min(end, duration)
    elif length > vmax:
        # 타입 상한 초과 → payoff_moment 중심 앞 2/3, 뒤 1/3 trim
        before = vmax * 2 / 3
        after = vmax * 1 / 3
        start = max(0.0, peak - before)
        end = min(duration if duration > 0 else peak + after, peak + after)
        if transcript:
            start, end = _snap_to_speech(start, end, transcript)
            end = _snap_to_sentence_end(end, transcript)
            if duration > 0:
                end = min(end, duration)
    # 클립·하이라이트: end 이후 침묵 구간 trim (다음 신 유입 방지). 2026-07-23 사용자 피드백.
    if vtype in ("clip", "highlight") and transcript:
        end = _snap_to_content_end(end, transcript)
        if duration > 0:
            end = min(end, duration)
    # Shot boundary 스냅 (있으면). STT 스냅으로 대사 경계는 맞췄지만 시각적 컷이 어긋나면
    # 다음 신이 스치듯 들어옴. ±3s 안에 shot boundary 있으면 그리로 맞춰 시각적으로도 딱 잘림.
    # 없으면(ffmpeg 없음/윈도 스캔 실패) 아무것도 안 함. 2026-07-24 사용자 지적: "장면전환점을
    # 데이터화 해야 함, STT만으론 못 잡음".
    if shots:
        start = nearest_shot(start, shots, max_shift=3.0)
        end = nearest_shot(end, shots, max_shift=3.0)
        if duration > 0:
            end = min(end, duration)
        start = max(0.0, start)
    return round(start, 1), round(end, 1)


# 엔트리 · recommend_narrative_first ────────────────────────────────────────

def recommend_narrative_first(
    scenes: list[dict],
    n: int = 5,
    genre: str = "auto",
    on_progress: Optional[Callable[[int, int], None]] = None,
    profile: dict | None = None,
    channels: list[str] | None = None,
    transcript: list[dict] | None = None,
    cast_registry: list[dict] | None = None,
    narrative: dict | None = None,
    faces: dict | None = None,
    ppl_detections: list[dict] | None = None,
    video_path: str | None = None,
    program_context: dict | None = None,
    beats: list[dict] | None = None,
) -> dict:
    """narrative-first 파이프라인. Phase A(pool) → Phase B(select) → refine_boundaries → 반환.
    beats(선택): AI-정돈 편집 최소 완결 단위 리스트. 있으면 Phase B가 자유 시각 뽑기 대신
    beat 조합 방식으로 동작(2026-07-24 · 클립이 60초 미만으로 나오는 문제 근본 fix)."""
    if not transcript:
        return {"genre": DEFAULT_GENRE, "shorts": [], "mode": "narrative_first",
                "error": "transcript empty"}
    # 프로그램 컨텍스트 활성화 (RNF 스코프 동안만).
    global _CURRENT_PROGRAM_CTX
    _prev_ctx = _CURRENT_PROGRAM_CTX
    _CURRENT_PROGRAM_CTX = program_context
    try:
        return _recommend_narrative_first_impl(
            scenes, n, genre, on_progress, profile, channels, transcript,
            cast_registry, narrative, faces, ppl_detections, video_path,
            beats or [],
        )
    finally:
        _CURRENT_PROGRAM_CTX = _prev_ctx


def _best_beat_for_scenario(sc: dict, beats: list[dict]) -> dict | None:
    """시나리오와 가장 겹치는 beat 반환. core_moment 포함하는 beat 최우선 · 없으면
    approx 창과 오버랩 큰 beat. 매칭 실패 시 None."""
    if not beats:
        return None
    try:
        sc_start = float(sc.get("approx_start_sec", 0))
        sc_end = float(sc.get("approx_end_sec", 0))
        sc_core = float(sc.get("core_moment_sec", (sc_start + sc_end) / 2))
    except (TypeError, ValueError):
        return None
    # core_moment 포함 beat 우선
    for b in beats:
        if b["start"] <= sc_core <= b["end"]:
            return b
    # 오버랩 큰 beat
    best, best_ov = None, 0.0
    for b in beats:
        ov = max(0.0, min(b["end"], sc_end) - max(b["start"], sc_start))
        if ov > best_ov:
            best, best_ov = b, ov
    return best


def _cut_shortform_from_beat(beat: dict, sc_core: float,
                             sf_min: float = 40.0, sf_max: float = 60.0) -> tuple[float, float]:
    """beat 안에서 shortform 컷 결정 (규칙 기반).
    - beat 길이 <= sf_max: beat 그대로 사용 (짧아도 완결).
    - beat 길이 > sf_max: core_moment 중심 앞뒤 균형 컷 (setup 2/3, 여운 1/3).
      core가 beat 밖이면 beat 앞부분 sf_max초.
    """
    b_start, b_end = float(beat["start"]), float(beat["end"])
    length = b_end - b_start
    if length <= sf_max:
        return b_start, b_end
    # 큰 beat → core 기준 컷
    if b_start <= sc_core <= b_end:
        before = sf_max * 0.6
        after = sf_max * 0.4
        start = max(b_start, sc_core - before)
        end = min(b_end, start + sf_max)
        # 뒤 여유가 부족하면 앞을 당김
        if end - start < sf_max:
            start = max(b_start, end - sf_max)
        return round(start, 1), round(end, 1)
    # core가 밖 → beat 앞부분
    return round(b_start, 1), round(min(b_end, b_start + sf_max), 1)


def _build_from_beats(
    scenarios: list[dict], beats: list[dict], transcript: list[dict] | None,
    duration: float, genre: str, profile: dict | None,
    faces: dict | None, ppl_detections: list[dict] | None,
    cast_registry: list[dict] | None,
) -> list[dict]:
    """beats 기반 shortform + clip 조립 (자유 시각 뽑기 제거).
    각 시나리오 → 매칭 beat 하나 → shortform 컷 + clip(beat 그대로).
    2026-07-24: 클립이 60초 미만·대사 중간 잘림 문제 근본 fix — beat 경계가 이미
    편집자가 그대로 쓸 수 있는 완결 단위라 refine 불필요."""
    shorts: list[dict] = []
    used_beat_ids: set = set()
    for sc in scenarios:
        try:
            sid = int(sc.get("id", -1))
        except (TypeError, ValueError):
            continue
        beat = _best_beat_for_scenario(sc, beats)
        if not beat:
            print(f"   (시나리오 {sid} 매칭 beat 없음 · 제외: {sc.get('story_title','')[:24]})")
            continue
        try:
            sc_core = float(sc.get("core_moment_sec", (beat["start"] + beat["end"]) / 2))
        except (TypeError, ValueError):
            sc_core = (beat["start"] + beat["end"]) / 2

        # A) 숏폼: beat 안에서 40~60초 컷
        sf_start, sf_end = _cut_shortform_from_beat(beat, sc_core)
        if sf_end > sf_start:
            derived = {"hook_strength": 7, "payoff": 7, "completeness": 8}
            shorts.append({
                "type": "shortform",
                "start": sf_start, "end": sf_end,
                "title": (sc.get("story_title") or "").strip() or "무제",
                "reason": (sc.get("story_synopsis") or beat.get("summary") or "").strip(),
                "story_synopsis": (sc.get("story_synopsis") or "").strip(),
                "hook_strength": 7, "payoff": 7, "completeness": 8,
                "appeal": _appeal_from_axes(derived) or 3,
                "score100": _axes_score(derived),
                "hook": (sc.get("hook") or beat.get("hook") or "기타").strip(),
                "tags": [str(t).strip() for t in (sc.get("tags") or []) if str(t).strip()],
                "characters": [str(c).strip() for c in (sc.get("characters") or beat.get("characters") or []) if str(c).strip()],
                "scenario_id": sid, "beat_id": beat.get("id"),
                "source": "narrative_first_beats",
            })

        # B) 클립: beat 하나 그대로 (같은 beat 중복 금지)
        if beat.get("id") in used_beat_ids:
            continue
        used_beat_ids.add(beat.get("id"))
        clip_length = beat["end"] - beat["start"]
        if clip_length < 60.0:
            # beat이 60초 미만이면 clip으로는 부적합 (숏폼만 만들고 clip 스킵)
            continue
        derived = {"hook_strength": 7, "payoff": 7, "completeness": 8}
        shorts.append({
            "type": "clip",
            "start": beat["start"], "end": beat["end"],
            "title": (beat.get("title") or sc.get("story_title") or "").strip() or "무제",
            "reason": (beat.get("summary") or sc.get("story_synopsis") or "").strip(),
            "story_synopsis": (beat.get("summary") or "").strip(),
            "hook_strength": 7, "payoff": 7, "completeness": 8,
            "appeal": _appeal_from_axes(derived) or 3,
            "score100": _axes_score(derived),
            "hook": (beat.get("hook") or "기타").strip(),
            "tags": [str(t).strip() for t in (sc.get("tags") or []) if str(t).strip()],
            "characters": [str(c).strip() for c in (beat.get("characters") or []) if str(c).strip()],
            "scenario_id": sid, "beat_id": beat.get("id"),
            "source": "narrative_first_beats",
        })

    # 시나리오에 매칭 안 된 beat 중 60초+인 것도 clip 후보로 추가 (최대 n_extra개)
    extra_clips = 0
    for b in beats:
        if extra_clips >= 3:
            break
        if b.get("id") in used_beat_ids:
            continue
        if (b["end"] - b["start"]) < 60.0:
            continue
        derived = {"hook_strength": 6, "payoff": 6, "completeness": 7}
        shorts.append({
            "type": "clip",
            "start": b["start"], "end": b["end"],
            "title": (b.get("title") or "").strip() or "무제",
            "reason": (b.get("summary") or "").strip(),
            "story_synopsis": (b.get("summary") or "").strip(),
            "hook_strength": 6, "payoff": 6, "completeness": 7,
            "appeal": _appeal_from_axes(derived) or 3,
            "score100": _axes_score(derived),
            "hook": (b.get("hook") or "기타").strip(),
            "tags": [], "characters": [str(c).strip() for c in (b.get("characters") or []) if str(c).strip()],
            "scenario_id": None, "beat_id": b.get("id"),
            "source": "narrative_first_beats",
        })
        used_beat_ids.add(b.get("id"))
        extra_clips += 1
    return shorts


def _recommend_narrative_first_impl(
    scenes: list[dict],
    n: int,
    genre: str,
    on_progress: Optional[Callable[[int, int], None]],
    profile: dict | None,
    channels: list[str] | None,
    transcript: list[dict] | None,
    cast_registry: list[dict] | None,
    narrative: dict | None,
    faces: dict | None,
    ppl_detections: list[dict] | None,
    video_path: str | None,
    beats: list[dict],
) -> dict:
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    # 영상 길이 · n 산정 (기존 로직 재사용)
    if scenes:
        duration = float(scenes[-1]["end"])
    elif transcript:
        duration = float(transcript[-1].get("end", 0))
    else:
        duration = 0.0
    vid_min = duration / 60.0
    n = max(n, min(20, round(vid_min / 10.0 * 3) or n))

    if genre == "auto" or genre not in GENRE_PACKS:
        genre = detect_genre(client, scenes or []) if scenes else DEFAULT_GENRE
        print(f"   장르 감지: {genre} ({_pack(genre)['label']})")

    if on_progress:
        on_progress(1, 3)
    # Phase A: 시나리오 정의 (N개, 주제 레벨)
    scenarios = propose_scenarios(
        client, narrative, transcript, profile, genre, n, duration,
        cast_registry=cast_registry, faces=faces, ppl_detections=ppl_detections,
    )
    if on_progress:
        on_progress(2, 3)
    if not scenarios:
        print("   (narrative-first 시나리오 실패 · chunk_scan 폴백)")
        return recommend(
            scenes=scenes or [], n=n, genre=genre, profile=profile, channels=channels,
            transcript=transcript, cast_registry=cast_registry,
            narrative_segments=(narrative or {}).get("segments"),
            key_conflicts=(narrative or {}).get("key_conflicts"),
            ppl_detections=ppl_detections,
        )

    # === Phase B (신규 · 2026-07-24): beats가 있으면 beat 조합 방식으로 우선 처리 ===
    # 자유 시각 뽑기가 클립 60초 미만·대사 중간 잘림을 유발한 근본 원인. beat는 이미
    # 완결 단위로 정돈돼 있어 그대로 사용하면 됨.
    if beats:
        print(f"   Phase B: beat 조합 방식 (beats {len(beats)}개 사용)")
        if on_progress:
            on_progress(3, 3)
        shorts = _build_from_beats(
            scenarios, beats, transcript, duration, genre, profile,
            faces, ppl_detections, cast_registry,
        )
        # rank + fit (아래 공통 로직 재사용을 위해 mid-return 대신 shorts만 채우고 진행)
        def type_order_new(s: dict) -> int:
            return {"shortform": 0, "clip": 1, "highlight": 2}.get(s.get("type", ""), 9)
        shorts.sort(key=lambda s: (type_order_new(s), -s.get("score100", 0), -s.get("hook_strength", 0)))
        type_rank_counter: dict = {}
        for s in shorts:
            t = s.get("type", "unknown")
            type_rank_counter[t] = type_rank_counter.get(t, 0) + 1
            s["rank"] = type_rank_counter[t]
        if shorts:
            shorts = apply_profile_fit(shorts, profile, duration)
            try:
                from .channels import apply_channel_fit
                shorts = apply_channel_fit(shorts, scenes or [], channels)
            except Exception as e:
                print(f"   (채널 적합 건너뜀: {str(e)[:80]})")
        return {"genre": genre, "shorts": shorts, "mode": "narrative_first_beats",
                "scenarios_count": len(scenarios), "beats_count": len(beats)}

    # === 기존 Phase B (beats 없을 때 fallback) ===
    # Phase B: 시나리오별 숏폼만 · propose_clips (코너/주제) 병렬.
    # 하이라이트는 60분+ 영상에서만 (짧은 영상은 회차 요약이 무의미 · 사용자 방향 2026-07-23).
    from concurrent.futures import ThreadPoolExecutor as _TPE
    generate_highlight = duration >= 3600.0  # 60분+
    workers = 3 if generate_highlight else 2
    with _TPE(max_workers=workers) as _ex:
        f_shortforms = _ex.submit(
            expand_and_pick_variations,
            client, scenarios, narrative, transcript, genre, 2, profile, cast_registry,
        )
        f_clips = _ex.submit(
            propose_clips,
            client, narrative, transcript, profile, genre, n, duration, cast_registry,
        )
        f_highlight = _ex.submit(
            curate_highlight,
            client, scenarios, narrative, transcript, profile, genre, duration, cast_registry,
        ) if generate_highlight else None
        variations = f_shortforms.result()
        clip_defs = f_clips.result()
        highlight = f_highlight.result() if f_highlight else None

    if on_progress:
        on_progress(3, 3)

    # 시나리오 id → scenario dict 매핑
    by_id = {int(s.get("id", -1)): s for s in scenarios if isinstance(s.get("id"), (int, float))}

    # Shot boundary 감지 — 시나리오 approx 창 + clip_defs 창 union만 스캔 (전체 60분 스캔 X).
    # ffmpeg fps=1, threshold 0.55로 큰 컷만. video_path 없거나 ffmpeg 실패 시 빈 리스트로 조용히
    # 폴백해 refine 로직이 STT 스냅만으로 계속 동작. 2026-07-24.
    shots: list[float] = []
    if video_path:
        windows: list[tuple[float, float]] = []
        for s in scenarios:
            try:
                ast = float(s.get("approx_start_sec", 0))
                aen = float(s.get("approx_end_sec", 0))
                if aen > ast:
                    windows.append((ast, aen))
            except (TypeError, ValueError):
                continue
        for c in (clip_defs or []):
            try:
                cst = float(c.get("setup_start_sec", 0) or 0)
                cen = float(c.get("payoff_end_sec", 0) or 0)
                if cen > cst:
                    windows.append((cst, cen))
            except (TypeError, ValueError):
                continue
        if windows:
            try:
                shots = detect_shots(video_path, windows, threshold=0.55, fps=1)
                print(f"   shot boundary {len(shots)}개 감지 (창 {len(windows)}개)")
            except Exception as e:
                print(f"   (shot detect 실패 · 스킵: {str(e)[:60]})")
                shots = []

    # Phase B 폴백: 변형 없으면 시나리오의 approx_start/end로 단일 변형 만들어 진행
    if not variations:
        print(f"   (Phase B 변형 0 · 시나리오 approx_start/end로 폴백)")
        variations = []
        for s in scenarios:
            try:
                sid = int(s.get("id", -1))
                ast = float(s.get("approx_start_sec", 0))
                aen = float(s.get("approx_end_sec", 0))
                core = float(s.get("core_moment_sec", (ast + aen) / 2))
            except (TypeError, ValueError):
                continue
            if aen <= ast:
                continue
            variations.append({
                "scenario_id": sid,
                "variations": [{
                    "variation_index": 0,
                    "setup_start_sec": ast,
                    "payoff_moment_sec": core,
                    "payoff_end_sec": aen,
                    "hook_strength": 6, "payoff": 6, "completeness": 6,
                    "why_this_cut": "Phase B 실패 · 시나리오 approx 사용",
                }],
                "best_variation_index": 0,
                "best_reason": "Phase B 실패 · 시나리오 단일 컷 폴백",
            })

    shorts = []
    # A) 숏폼: variations에서 (시나리오당 1 shortform)
    for r in variations:
        try:
            sid = int(r.get("scenario_id", -1))
        except (TypeError, ValueError):
            continue
        scenario = by_id.get(sid)
        if not scenario:
            continue
        vdata = r.get("shortform")
        if not isinstance(vdata, dict):
            continue
        try:
            hs = int(vdata.get("hook_strength", 5))
            pf = int(vdata.get("payoff", 5))
            cp = int(vdata.get("completeness", 5))
        except (TypeError, ValueError):
            hs, pf, cp = 5, 5, 5
        story_wrap = {
            "setup_start_sec": vdata.get("setup_start_sec"),
            "payoff_moment_sec": vdata.get("payoff_moment_sec"),
            "payoff_end_sec": vdata.get("payoff_end_sec"),
        }
        start, end = _refine_story_boundary(story_wrap, transcript, scenes, duration, vtype="shortform", shots=shots)
        if end <= start or (end - start) < 1.0:
            print(f"   (숏폼 경계 실패 · 시나리오 {sid} 제외: {scenario.get('story_title','')[:24]})")
            continue
        derived = {"hook_strength": hs, "payoff": pf, "completeness": cp}
        shorts.append({
            "type": "shortform",
            "start": start, "end": end,
            "title": (scenario.get("story_title") or "").strip() or "무제",
            "reason": (vdata.get("why_this_cut") or scenario.get("story_synopsis") or "").strip(),
            "story_synopsis": (scenario.get("story_synopsis") or "").strip(),
            "hook_strength": hs, "payoff": pf, "completeness": cp,
            "appeal": _appeal_from_axes(derived) or 3,
            "score100": _axes_score(derived),
            "hook": (scenario.get("hook") or "기타").strip(),
            "tags": [str(t).strip() for t in (scenario.get("tags") or []) if str(t).strip()],
            "characters": [str(c).strip() for c in (scenario.get("characters") or []) if str(c).strip()],
            "scenario_id": sid,
            "source": "narrative_first",
        })

    # B) 클립: propose_clips 결과 (코너/주제 단위)
    for c in (clip_defs or []):
        try:
            hs = int(c.get("hook_strength", 5))
            pf = int(c.get("payoff", 5))
            cp = int(c.get("completeness", 5))
        except (TypeError, ValueError):
            hs, pf, cp = 5, 5, 5
        clip_wrap = {
            "setup_start_sec": c.get("setup_start_sec"),
            "payoff_moment_sec": c.get("payoff_moment_sec", (float(c.get("setup_start_sec") or 0) + float(c.get("payoff_end_sec") or 0)) / 2),
            "payoff_end_sec": c.get("payoff_end_sec"),
        }
        start, end = _refine_story_boundary(clip_wrap, transcript, scenes, duration, vtype="clip", shots=shots)
        if end <= start or (end - start) < 1.0:
            print(f"   (클립 경계 실패 · 제외: {c.get('title','')[:24]})")
            continue
        derived = {"hook_strength": hs, "payoff": pf, "completeness": cp}
        shorts.append({
            "type": "clip",
            "start": start, "end": end,
            "title": (c.get("title") or "").strip() or "무제",
            "reason": (c.get("why_this_clip") or c.get("synopsis") or "").strip(),
            "story_synopsis": (c.get("synopsis") or "").strip(),
            "hook_strength": hs, "payoff": pf, "completeness": cp,
            "appeal": _appeal_from_axes(derived) or 3,
            "score100": _axes_score(derived),
            # LLM이 자유 서술을 넣는 회귀가 있어 카테고리 외 값은 "기타"로 정규화(HOOK_KEYS + "기타").
            "hook": (lambda h: h if h in HOOK_KEYS or h == "기타" else "기타")(
                (c.get("hook") or "기타").strip()
            ),
            "tags": [str(t).strip() for t in (c.get("tags") or []) if str(t).strip()],
            "characters": [],
            "scenario_id": None,
            "source": "narrative_first",
        })

    # C) 하이라이트: curate_highlight 결과 (회차 대주제 큐레이션)
    if highlight and highlight.get("segments"):
        segs = highlight["segments"]
        total = highlight.get("total_length_sec") or sum(s["end"] - s["start"] for s in segs)
        first_start = min((s["start"] for s in segs), default=0.0)
        last_end = max((s["end"] for s in segs), default=first_start)
        shorts.append({
            "type": "highlight",
            "start": first_start,
            "end": last_end,
            "title": (highlight.get("title") or "").strip() or "회차 하이라이트",
            "reason": (highlight.get("editor_note") or highlight.get("synopsis") or "").strip(),
            "story_synopsis": (highlight.get("synopsis") or "").strip(),
            "hook_strength": 8, "payoff": 8, "completeness": 8,
            "appeal": 4, "score100": 80.0,
            "hook": "정보성",
            "tags": ["하이라이트", "회차요약"],
            "characters": [],
            "scenario_id": None,
            "overarching_theme": highlight.get("overarching_theme", ""),
            "segments": segs,  # [{role, scenario_id, start, end, note}]
            "total_length_sec": total,
            "source": "narrative_first",
        })

    # (구 · 시나리오 단순 concat 하이라이트 로직 삭제됨 · 2026-07-23 curate_highlight로 대체)

    # rank 부여: 타입별 내림차순 그룹핑 (숏폼 rank 1~N, 클립 rank 1~N, 하이라이트 rank 1)
    def type_order(s: dict) -> int:
        return {"shortform": 0, "clip": 1, "highlight": 2}.get(s.get("type", ""), 9)
    shorts.sort(key=lambda s: (type_order(s), -s.get("score100", 0), -s.get("hook_strength", 0)))
    # 타입별 rank
    type_rank_counter: dict = {}
    for s in shorts:
        t = s.get("type", "unknown")
        type_rank_counter[t] = type_rank_counter.get(t, 0) + 1
        s["rank"] = type_rank_counter[t]

    # program-fit + channel-fit (기존 로직 재사용)
    if shorts:
        shorts = apply_profile_fit(shorts, profile, duration)
        try:
            from .channels import apply_channel_fit
            shorts = apply_channel_fit(shorts, scenes or [], channels)
        except Exception as e:
            print(f"   (채널 적합 건너뜀: {str(e)[:80]})")

    return {"genre": genre, "shorts": shorts, "mode": "narrative_first",
            "scenarios_count": len(scenarios),
            "total_variations": sum(len(r.get("variations", [])) for r in variations)}


if __name__ == "__main__":
    main()

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
from difflib import SequenceMatcher
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

from core.common.retry import call_with_retry
from core.scenes.shots import detect_shots, nearest_shot

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
from core.common.models import RECOMMEND as MODEL

WORKERS = 4          # parallel Phase-1 chunk calls
CHUNK_SCENES = 80    # max scenes per Phase-1 chunk (keeps the prompt fully attended)
CHUNK_MAX_SEC = 600  # …or max 10 minutes of footage, whichever comes first
CHUNK_OVERLAP = 6    # scenes repeated from the previous chunk so a bit spanning the cut isn't lost
PER_CHUNK = 6        # candidate cap per chunk (Phase 2 prunes)
MIN_SHORT_SEC = 3    # anything shorter is a glitch, not a short
# 운영 기준: 쇼츠는 완결성을 보존하되 1분 30초를 넘기지 않는다.
MAX_SHORT_SEC = 90


def _target_shorts_count(duration: float) -> int:
    """영상 길이에 비례한 목표 쇼츠 수. **10분당 3개(≈18/시간), 상한 20.**
    짧으면 자연히 작아진다 — 개수를 강제하지 않는다(프롬프트가 소프트하게 처리).

    ⚠️ 예전엔 `n = max(들어온 n, …)` 라 워커 기본값 5가 **바닥**이 돼서 2분짜리도 5개를
    요구했고(억지 픽 유발), 거기에 beat 밀도(len//4)까지 더해 6초 beat 이 촘촘한 짧은 영상을
    더 부풀렸다. 이제 **길이만** 본다 — 커버리지(자기소개 통째 누락 방지 등)는 개수 뻥튀기가
    아니라 recommend 프롬프트가 "전체를 훑어라"로 맡는다.
    사용자 방향 2026-08-24: "짧으면 줄이거나 요구 말라 · 억지가 아니라 자연스럽게."
    """
    vid_min = max(0.0, float(duration or 0.0)) / 60.0
    return max(1, min(20, round(vid_min / 10.0 * 3)))

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


def _cast_block(cast_registry: list[dict] | None, transcript: list[dict] | None = None) -> str:
    """출연진 명단 블록 — 등록 캐스트 이름을 제목·설명에 정확히 반영하도록. STT 오인식 정규화
    지시 포함. transcript 있으면 각 화자의 자기소개 대사도 힌트로 추출 (speaker table 강화)."""
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

    # 각 화자의 자기소개 · 직업 언급 · 주요 대사 (프롬프트 상단 speaker table)
    intro_lines: list[str] = []
    if transcript:
        from collections import defaultdict
        by_sp: dict[str, list[tuple[float, str]]] = defaultdict(list)
        name_set = set(names)
        for s in transcript:
            sp = (s.get("speaker") or "").strip()
            if sp not in name_set:
                continue
            txt = (s.get("text") or "").strip()
            if not txt:
                continue
            # 자기소개·직업·호칭 힌트 (max 3개/화자)
            if any(k in txt for k in ("저는 ", "제가 ", "제 이름", "제 직업", "저의 ", "년차", "직업입니다", "회사")):
                if len(by_sp[sp]) < 3:
                    try:
                        by_sp[sp].append((float(s.get("start", 0)), txt[:70]))
                    except (TypeError, ValueError):
                        continue
        if by_sp:
            intro_lines.append("\n[화자별 자기소개·직업 힌트 · 이 정보로 대사·제목 정확 매칭]")
            for sp in sorted(by_sp.keys()):
                items = by_sp[sp]
                fmt = " · ".join(f"[{int(t)//60}:{int(t)%60:02d}] \"{tx}\"" for t, tx in items)
                intro_lines.append(f"- {sp}: {fmt}")

    return (
        "\n\n등록된 출연진:\n"
        f"- 이 명단만 실명으로 사용: {', '.join(names)}\n"
        "- STT 오인식은 이 명단 기준으로 정규화 (예: 옥수→옥순, 정선→정순).\n"
        "- 대사에서 서로 부르는 호칭(XX 님/OO아)이 명단에 있으면 실명으로.\n"
        "- 명단에 없는 이름은 만들지 마라 — 잘 모르는 인물은 '한 출연자', '진행자' 같은 역할 지칭."
        + ("\n" + "\n".join(intro_lines) if intro_lines else "")
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


def _operator_prompt_block(ctx: dict | None, key: str, usage: str) -> str:
    """운영자 커스텀 프롬프트(program_context.json 의 titlePrompt·recommendPrompt)를
    "## 프로그램별 운영자 지시" 블록으로 렌더. 프로그램 상세에서 운영자가 직접 입력한 지시라
    기본 프롬프트 위에 얹는다 — 단 점수·순위·선별은 결정론 유지(리포 원칙)라서
    서술·후보 생성 프롬프트에만 넣는다. 값 없으면 블록 자체 생략(no-op)."""
    if not isinstance(ctx, dict):
        return ""
    v = str(ctx.get(key) or "").strip()
    if not v:
        return ""
    # 1000자 컷 — 운영자 입력이라 길이 통제가 없다. 프롬프트 낭비 방지.
    return (
        f"\n\n## 프로그램별 운영자 지시 — {usage}\n"
        + v[:1000]
        + "\n(위 지시는 이 프로그램 운영자가 직접 입력했다. 기본 톤·금지 규칙은 유지한 채 추가로 반영하라.)"
    )


# recommend()·recommend_narrative_first() 호출 스코프 동안만 활성 — _base_system에서 참조.
# 매 콜마다 recommend/RNF 진입시 세팅, 종료시 초기화. threading 없어 안전.
_CURRENT_PROGRAM_CTX: dict | None = None


def _base_system(genre: str, profile: dict | None = None, cast_registry: list[dict] | None = None,
                 transcript: list[dict] | None = None) -> str:
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
- **길이는 완결성이 최우선.** 30~90초 안에서, 60초 안에 못 담으면 60초를 넘어 완결시켜라.
  단, 숏폼 하드 실링은 90초다. 20초 미만은
  정말 그 한 컷으로 완결될 때만. start/end는 장면·문장 경계에서 깔끔히 끊어라.
- appeal은 바이럴 잠재력의 절대평가다: 5=확실히 터진다, 4=강함, 3=쓸만함, 2=약함, 1=비추천.{_profile_block(profile)}{_cast_block(cast_registry, transcript)}{_program_context_block(_CURRENT_PROGRAM_CTX)}{_operator_prompt_block(_CURRENT_PROGRAM_CTX, "recommendPrompt", "추천 구간 선택")}"""


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

    This is the seat the feasibility study (docs/archive/highlight-model-feasibility.md §5-1)
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
    # 2026-07-31 · 쇼츠 첫 3초 hook intro (docs/plans/shorts-hook-intro-3sec.md).
    # 목적: retention · 스크롤 정지 · 이탈 방지. Phase 1/2 · _SHORTS_FROM_BEATS_SCHEMA 다 공통.
    "hook_quote": {"type": "STRING"},       # 실 대사 원문 인용 (STT 그대로 · 30자 이내)
    "hook_time_sec": {"type": "NUMBER"},    # hook 대사 시각 (쇼츠 시작 상대 · 첫 5초 이내 권장)
    "hook_intro_caption": {"type": "STRING"},  # 어그로 편집자막 (20자 · "충격 고백!" 톤)
}


# 3축 가중합 → 0-100 원점수, 1-5 압축은 UI 호환용
_AXIS_WEIGHTS = {"hook_strength": 0.40, "payoff": 0.35, "completeness": 0.25}


# ── 결정론 스코어 (2026-08-06) ────────────────────────────────────────────────
# **LLM 에게 점수를 묻지 않는다.** 같은 입력이면 항상 같은 값이 나와야 A/B·회귀 판정이
# 성립한다(사용자 2026-08-06: "llm에게 선택의영역을주면안돼 / 맨날결과가바뀌어그러면").
# 재료는 전부 결정론적이다:
#   signals   core.signals 산출 (오디오 백분위·순간상승·대사밀도·컷속도) — LLM 무관
#   hook      beat_annot 의 **카테고리 라벨** (0-10 점수가 아니라 분류라 상대적으로 안정)
#   길이      쇼츠 적정 길이 곡선
#   완결성    beat 의 is_complete
#
# ⚠️ **길이는 점수축이 아니다** (사용자 확정 2026-08-16). 길이는 품질이 아니라 **제약**이다 —
# 40초짜리가 70초짜리보다 '좋은' 게 아니라, 배포처가 받아주느냐 마느냐의 문제다. 그건 이미
# 세 군데가 따로 본다: core/common/channels.py 의 배포처별 min/maxSec(usable 판정),
# channel-rules.ts 의 채널 규칙 maxSec, 그리고 클립의 미드롤 기준(8분). 점수에까지 넣으면
# 같은 축을 네 번 세는 셈이고, 무엇보다 **적정 길이 창(25~90초)이 쇼츠 전제**라 롱폼이
# 구조적으로 깎였다(그래서 클립은 별도 점수식을 써야 했다).
# 빠진 0.20 은 남은 축에 비례 배분한다.
#
# ── Opus Clip 벤치마킹 (사용자 방향 2026-08-16) ────────────────────────────────
# Opus 의 Virality Score 축은 **Hook · Flow · Value · Trend** 로 전부 의미축이고, 그걸
# LLM 이 매긴다. 우리는 그 구조를 빌리되 **점수는 결정론으로 낸다**(LLM 점수 금지 원칙 —
# 매번 값이 바뀌면 A/B·회귀 판정이 성립하지 않는다). 대응은 이렇게 잡았다:
#   Hook  → hook 축   (beat_annot 이 붙인 9종 카테고리 라벨. 아래에서 LLM 응답 의존을 끊었다)
#   Flow  → closure 축(끝맺음 여유 — 말허리에서 끊겼는가)
#   Value → signal 축 (대사 밀도·오디오 — 내용이 실제로 벌어지는가)
#   Trend → viewer 보너스(실제 시청자가 댓글 타임스탬프로 지목한 구간. 아래 _VIEWER_BONUS)
_SCORE_W = {"signal": 0.45, "hook": 0.35, "closure": 0.20}
#: 시청자 지목 보너스(0~이 값). Opus 의 Trend 축 대응 — **우리 것이 더 강한 신호다**(추정
#: 트렌드가 아니라 그 영상의 실제 시청자 반응이다). 다만 댓글이 없는 회차가 많아 축으로
#: 넣으면 대부분 중립 0.5 로 희석되므로, **있을 때만 얹는 가산점**으로 둔다.
_VIEWER_BONUS = 10.0

# 끝맺음 여유 — 쇼츠 끝 뒤에 침묵이 얼마나 있나. 이 값이 0이면 다음 발화가 곧바로 이어지는
# 지점에서 끊긴 것이라 "말허리 자른" 느낌이 난다.
#
# ⚠️ 원래 이 자리는 `complete`(beat.is_complete) 였는데 **beats.py:1082 가 True 를 하드코딩**해서
# 두 회차 239/239·241/241 전부 1.00 — 가중치 0.15 가 통째로 상수였다(죽은 축).
# 대체 후보를 구현 **전에** 실측해서 골랐다 (2026-08-06):
#   · 발화 중간 자름(straddle): 드라마 0/19 · 예능 0/20 → **죽은 신호**. beat 이 이미 STT 단어
#     경계에 스냅돼 있어 자를 수가 없다
#   · 끝 문장 종결형: 드라마 19/19(변별 0) · 예능 17/20 → 약함
#   · **끝 뒤 침묵: 0.00~32.70초로 실제 변동** ← 유일하게 살아있음
# 이름도 `complete` 가 아니라 `closure` 로 바꾼다 — 재는 게 "완결성"이 아니라 "끝맺음 여유"다.
_CLOSURE_FULL_SEC = 0.8  # 이만큼 침묵이면 만점


def _closure_fit(transcript: list[dict] | None, end: float) -> float:
    """끝 뒤 침묵 기반 끝맺음 점수 0..1. transcript 없으면 중립 0.5."""
    if not transcript:
        return 0.5
    gaps = []
    for u in transcript:
        try:
            us = float(u.get("start"))
        except (TypeError, ValueError):
            continue
        if us >= end - 0.05:
            gaps.append(us - end)
    if not gaps:
        return 1.0  # 뒤에 발화가 없다 = 영상 끝 = 끊길 게 없다
    return round(max(0.0, min(1.0, min(gaps) / _CLOSURE_FULL_SEC)), 4)

# hook 카테고리 가중 — index_segments._HOOK_BASE 와 같은 서열을 쓴다(두 곳이 어긋나면
# 검색 점수와 추천 점수가 다른 말을 하게 된다).
_HOOK_W = {
    "반전": 1.00, "감정고조": 0.92, "돌직구": 0.92, "갈등": 0.92,
    "웃음": 0.84, "질문": 0.67, "공감": 0.67, "정보성": 0.50, "정보": 0.50,
    "기타": 0.34, "": 0.34,
}

# 쇼츠 적정 길이 — **점수축에서 뺐다**(사용자 확정 2026-08-16 · _SCORE_W 주석 참고).
# 함수는 남긴다: 배포처 적합(core/common/channels.py)·채널 규칙이 길이를 여전히 보고,
# 화면이 "이 길이가 적정한가" 를 정보로 보여줄 근거가 필요하다. 다만 **점수에는 안 들어간다**.
_LEN_OK = (25.0, 90.0)
_LEN_FLOOR = 0.35


def _length_fit(sec: float) -> float:
    """길이 적합도 0..1 (정보용 — score100 에는 반영하지 않는다).

    ⚠️ **현재 호출부가 없다.** 그리고 앞으로도 점수축으로 되살리지 말 것 — 길이는 취향이
    아니라 물건의 정의라 **하드 상한**(MAX_SHORT_SEC)으로 지킨다. 2026-08-25 사고가 정확히
    "길이가 점수에도 필터에도 없어서 3분짜리가 숏폼으로 떴다" 였는데, 그 처방으로 소프트
    가중치를 넣으면 순위만 내려갈 뿐 **여전히 뜬다.** 상한은 propose_shorts_beat_only 산출부
    (1차)와 _enforce_shortform_length(최종 관문)에 있다.
    """
    lo, hi = _LEN_OK
    if lo <= sec <= hi:
        return 1.0
    if sec < lo:
        return max(_LEN_FLOOR, sec / lo)
    return max(_LEN_FLOOR, hi / sec)


#: 신호축 안에서의 가중치. **오디오가 절반 이상**이다(사용자 방향 2026-08-16 "데시벨 점수").
#:
#: 실측 근거 (나는 SOLO 회차 · beat 298개 · 2026-08-16):
#:   audio_pct         0인 비율  0.3% · 고유값 298 · 표준편차 0.290  ← 가장 잘 갈린다
#:   audio_delta       0인 비율  0.0% · 고유값 210 · 표준편차 0.118  ← 웃음·환호의 대리 지표
#:   dialogue_density  0인 비율  0.7% · 고유값 283 · 표준편차 2.536
#:   cut_rate          0인 비율 73.8% · 고유값  67                  ← 대부분 0, 사실상 죽은 축
#: 예전엔 넷을 **단순 평균**해서, 74% 가 0 인 cut_rate 가 신호축의 1/4(총점의 10%)을 먹고
#: 살아 있는 오디오 신호를 희석했다.
#
# ⚠️ **오디오를 더 올리지 않는다.** 음량이 곧 하이라이트라는 가설은 이 리포에서 이미 한 번
# 실측으로 반박됐다 — index_segments.py:179-186 "쇼츠 채택/미채택의 audio_pct 중앙값이
# 0.525/0.475 로 거의 안 갈렸다", :258-261 "드라마 상위에 **엔딩 크레딧**(음악 큼)이 0.859 로
# 올라왔다". 즉 음량만 올리면 BGM·크레딧이 먼저 올라온다. 그래서 대사 밀도를 같은 급으로
# 두고(말이 오가야 내용이다), 아래 _music_guard 로 "큰 소리인데 말이 없는" 구간을 눌러 둔다.
_SIGNAL_W = {"audio_pct": 0.30, "audio_delta": 0.30, "dialogue_density": 0.30, "cut_rate": 0.10}
#: 대사 밀도가 이 백분위 미만이면 '말 없는 큰 소리'(음악·크레딧·환경음)로 보고 오디오 기여를 깎는다.
_MUSIC_GUARD_PCT = 0.20
_MUSIC_GUARD_DAMP = 0.35
#: 한 값이 이 비율 이상을 차지하면 그 회차에서는 변별력이 없는 축으로 보고 뺀다.
#: 프로그램마다 다르다 — 컷이 잦은 예능은 cut_rate 가 살아 있고, 인터뷰 위주는 죽는다.
#: 하드코딩으로 축을 지우지 않고 **회차 데이터가 스스로 정하게** 한다.
_SIGNAL_DEAD_RATIO = 0.70


def beat_signal_percentiles(beats: list[dict]) -> dict:
    """beat id → 신호 백분위(0..1). 회차 내 상대값이라 회차 간 마스터링 차이를 흡수한다.

    반환이 결정론적이려면 입력 순서에 의존하면 안 되므로 (값, id) 로 정렬한다.
    """
    keys = tuple(_SIGNAL_W)
    # ⚠️ 동점 tie-break 를 **리스트 인덱스로 하면 안 된다** — 같은 beat 집합이라도 순서가
    # 다르면 백분위가 달라져 점수가 흔들린다(실측: 셔플 후 score100 불일치). beat id 로
    # 깨야 입력 순서와 무관하게 같은 값이 나온다. 결정론이 이 함수의 존재 이유다.
    def _bid(b: dict):
        v = b.get("id")
        return (0, int(v)) if isinstance(v, (int, float)) else (1, str(v))

    per_key: dict[str, dict] = {}
    live: dict[str, float] = {}
    for k in keys:
        pairs = [(b, (b.get("signals") or {}).get(k)) for b in beats]
        have = [(b, float(v)) for b, v in pairs if isinstance(v, (int, float))]
        ranks: dict = {}
        if have:
            # 한 값이 압도적이면(예: cut_rate 가 74% 0) 이 회차에서는 변별력이 없다 —
            # 넣어 봐야 나머지 축을 희석하기만 한다.
            vals = [v for _b, v in have]
            top = max(vals.count(v) for v in set(vals))
            if top / len(vals) < _SIGNAL_DEAD_RATIO:
                live[k] = _SIGNAL_W[k]
                order = sorted(have, key=lambda bv: (bv[1], _bid(bv[0])))
                n = len(order)
                for r, (b, _v) in enumerate(order):
                    ranks[b.get("id")] = (r / max(1, n - 1)) if n > 1 else 0.5
        per_key[k] = ranks
    out: dict = {}
    for b in beats:
        i = b.get("id")
        got = [(k, per_key[k][i], live[k]) for k in keys if k in live and i in per_key[k]]
        if not got:
            out[i] = None
            continue
        # 음악 방어 — 대사가 거의 없는데 소리만 큰 구간(엔딩 크레딧·BGM)은 오디오 축을 깎는다.
        # 이 방어가 없으면 "음량 상위 = 하이라이트"가 되어 크레딧이 1등으로 올라온다(실측).
        talk = per_key.get("dialogue_density", {}).get(i)
        quiet_talk = isinstance(talk, (int, float)) and talk < _MUSIC_GUARD_PCT
        adj = []
        for k, v, w in got:
            if quiet_talk and k in ("audio_pct", "audio_delta"):
                v = v * _MUSIC_GUARD_DAMP
            adj.append((v, w))
        wsum = sum(w for _v, w in adj)
        out[i] = round(sum(v * w for v, w in adj) / wsum, 4) if wsum > 0 else None
    return out


#: 첫 3초 훅 — 쇼츠 맨 앞에 붙일 '가장 튀는 3초'.
#:
#: 왜 필요한가: 숏폼은 첫 1~2초에 넘긴다. 본편이 잔잔하게 시작하면 그 뒤가 아무리 좋아도
#: 안 본다. 그래서 **쇼츠 안에서** 가장 자극적인 구간을 3초 잘라 앞에 붙인다(사용자 방향
#: 2026-08-16). 밖에서 가져오지 않는다 — 없는 장면을 예고하면 낚시가 된다.
#:
#: 고르는 법은 **결정론**이다. 예전엔 이 값(hook_quote·hook_time_sec)을 LLM 응답에서 받으려
#: 했는데 모델이 채우지 않아 **실측 산출물에서 5개 중 0개**였다 — 에디터의 "첫 3초 훅"
#: 토글이 항상 비활성이었던 이유다(hookAvailable = hookTimeSec 존재 여부).
#: 데시벨 순간 상승(audio_delta)이 웃음·함성·고성의 대리 지표라 그걸 1순위로 쓴다.
_HOOK_MIN_OFFSET_SEC = 1.5   # 쇼츠 맨 앞과 겹치면 같은 장면이 두 번 나온다
_HOOK_TAIL_MARGIN_SEC = 1.0  # 끝에 너무 붙으면 3초를 못 채운다


def _pick_hook_window(picked_beats: list[dict], sf_start: float, sf_end: float,
                      transcript: list[dict] | None) -> dict:
    """쇼츠 안에서 첫 3초 훅으로 쓸 지점 — {hook_time_sec, hook_quote}.

    반환의 `hook_time_sec` 은 **쇼츠 시작 기준 상대 초**다(서버 /export 가 그렇게 읽는다:
    `hookAbs = clip.startTime + hookTimeSec`).
    """
    span = sf_end - sf_start
    if span <= _HOOK_MIN_OFFSET_SEC + _HOOK_TAIL_MARGIN_SEC:
        return {}
    lo = sf_start + _HOOK_MIN_OFFSET_SEC
    hi = sf_end - _HOOK_TAIL_MARGIN_SEC

    # ⚠️ beat 시작을 lo 로 **클램프하면 안 된다** — 앞쪽 beat 이 전부 1.5초로 몰려서
    # 훅이 본편 시작과 같은 장면이 되고, 결국 같은 그림이 두 번 나온다(실측에서 5개 중
    # 3개가 그랬다). 클램프가 아니라 **필터**로 잡는다: 구간 안에서 시작하는 beat 만 후보.
    cands = []
    for b in picked_beats:
        try:
            bs = float(b["start"])
        except (TypeError, ValueError, KeyError):
            continue
        if lo <= bs <= hi:
            cands.append((b, bs))
    if not cands:
        # 쇼츠가 beat 하나로만 이뤄진 경우 등 — 그때는 앞머리를 살짝 비켜 잡는다.
        cands = [(b, min(max(float(b.get("start", lo)), lo), hi)) for b in picked_beats[:1]
                 if isinstance(b.get("start"), (int, float))]
    if not cands:
        return {}

    def _key(item):
        b, _at = item
        s = b.get("signals") or {}
        delta = s.get("audio_delta")
        loud = s.get("audio_pct")
        return (
            float(delta) if isinstance(delta, (int, float)) else -1.0,
            float(loud) if isinstance(loud, (int, float)) else -1.0,
        )

    best = max(cands, key=_key)
    at = best[1]

    # 훅 자막은 **그 시점의 실제 대사**를 그대로 쓴다 — 지어내면 영상에 없는 말이 자막으로 나간다.
    quote = ""
    for u in (transcript or []):
        try:
            us, ue = float(u.get("start")), float(u.get("end"))
        except (TypeError, ValueError):
            continue
        if ue >= at and us <= at + 3.0:
            quote = str(u.get("text") or "").strip()
            if quote:
                break
    return {
        "hook_time_sec": round(at - sf_start, 2),
        **({"hook_quote": quote[:60]} if quote else {}),
    }


def _norm_quote(s: str) -> str:
    """인용 비교용 정규화 — 공백·문장부호를 털어 낸다(모델이 조사·마침표를 자주 바꾼다)."""
    return re.sub(r"[^0-9A-Za-z가-힣]", "", str(s or ""))


def _locate_quote(quote: str, sf_start: float, sf_end: float,
                  transcript: list[dict] | None) -> dict:
    """LLM 이 고른 훅 대사가 **전사 어디에 있는지** 찾아 {hook_time_sec, hook_quote} 로 준다.

    역할 분담이 핵심이다. "어느 대사가 자극적인가" 는 의미 판단이라 LLM 이 잘하고(추출),
    "그게 몇 초인가" 는 전사에 이미 있는 사실이라 **찾으면 되는 것**이다.

    ⚠️ 모델이 준 `hook_time_sec` 숫자는 쓰지 않는다. 실측(m_981d7c08 · 20개)에서 20개 중
    17개가 똑같이 `2.0` 이었고, 그 시각의 실제 대사와 대조하면 12개가 딴 말이었다 —
    즉 훅 자막으로 **그 순간 나오지 않는 말**이 3초간 박힌다. 모델은 구간 안 상대 초를
    셈하지 못한다(전사에 절대 시각만 있다). 셈은 우리가 한다.

    못 찾으면 `{}` — caller 가 데시벨 픽(`_pick_hook_window`)으로 넘어간다.
    """
    nq = _norm_quote(quote)
    if len(nq) < 6:
        return {}
    lo = sf_start + _HOOK_MIN_OFFSET_SEC
    hi = sf_end - _HOOK_TAIL_MARGIN_SEC
    if hi <= lo:
        return {}
    # 완전일치를 요구하면 안 된다 — 모델은 인용을 다듬는다(조사 탈락 "저 사실은"→"저 사실",
    # 긴 발화 앞부분만 인용, 두 발화 이어 붙이기). 그래서 **부분 일치량**으로 본다:
    #   공통 블록 총합 / 짧은 쪽 길이 ≥ 0.7  그리고  가장 긴 공통 블록 ≥ 4글자
    # 뒤 조건이 없으면 한국어 흔한 음절("니다"·"그래서")만 겹쳐도 통과해 엉뚱한 줄을 잡는다.
    best: tuple[float, str, float] | None = None
    for u in (transcript or []):
        try:
            us = float(u.get("start"))
        except (TypeError, ValueError):
            continue
        if not (lo <= us <= hi):
            continue
        nu = _norm_quote(u.get("text"))
        if not nu:
            continue
        blocks = SequenceMatcher(None, nq, nu, autojunk=False).get_matching_blocks()
        total = sum(b.size for b in blocks)
        longest = max((b.size for b in blocks), default=0)
        score = total / max(1, min(len(nq), len(nu)))
        if longest >= 4 and score >= 0.7 and (best is None or score > best[2]):
            best = (us, str(u.get("text") or "").strip(), score)
    if not best:
        return {}
    return {"hook_time_sec": round(best[0] - sf_start, 2), "hook_quote": best[1][:60]}


def _deterministic_score(picked_beats: list[dict], sec: float, hook: str,
                         sig_pct: dict, transcript: list[dict] | None = None,
                         end: float | None = None,
                         starred_ids: set | None = None) -> tuple[float, dict]:
    """쇼츠 하나의 score100(0-100)과 근거 내역. **LLM 응답을 일절 쓰지 않는다.**"""
    sigs = [sig_pct.get(b.get("id")) for b in picked_beats]
    sigs = [s for s in sigs if isinstance(s, (int, float))]
    signal = sum(sigs) / len(sigs) if sigs else 0.5  # 신호 없으면 중립
    # ⚠️ hook 은 **beat_annot 이 붙인 라벨이 정본**이다. 예전엔 호출부가 LLM 응답의 hook
    # 문자열을 우선 넘겨서, "점수는 결정론" 이라는 전제가 이 축(지분 최대)에서 깨져 있었다
    # (temperature 0.3 · enum 제약 없음 → 실행마다 달라진다). 아래 호출부에서 순서를 뒤집었고,
    # 여기서도 beat 라벨을 다시 확인해 LLM 값이 새어 들어오면 무시한다.
    beat_hook = next((str(b.get("hook") or "").strip() for b in picked_beats
                      if str(b.get("hook") or "").strip() in _HOOK_W), "")
    hook_key = beat_hook or (hook or "").strip()
    hook_w = _HOOK_W.get(hook_key, _HOOK_W["기타"])
    closure = _closure_fit(transcript, end) if end is not None else 0.5

    raw = (_SCORE_W["signal"] * signal + _SCORE_W["hook"] * hook_w
           + _SCORE_W["closure"] * closure)
    # Trend 대응 — 실제 시청자가 댓글에서 지목한 beat 이 들어 있으면 가산(있을 때만).
    starred = bool(starred_ids) and any(b.get("id") in starred_ids for b in picked_beats)
    score = max(0.0, min(1.0, raw)) * 100.0 + (_VIEWER_BONUS if starred else 0.0)
    parts = {"signal": round(signal, 4), "hook": hook_w,
             "closure": round(closure, 4),
             "viewer": _VIEWER_BONUS if starred else 0.0,
             "has_signals": bool(sigs),
             # 화면이 가중치를 하드코딩하지 않게 같이 내려보낸다(지금 shorts-card 는 박아 뒀다).
             "weights": dict(_SCORE_W)}
    return round(min(100.0, score), 1), parts


def _appeal_from_score100(score100: float) -> int:
    """0-100 → 1-5 (UI 호환). 결정론."""
    return max(1, min(5, int(score100 // 20) + 1))


def _axis_val(src: dict, key: str, default: int) -> int:
    """LLM 응답에서 3축 값 하나를 안전하게 꺼낸다. 없거나 0-10 밖이면 default.

    default 는 **하드코딩 복귀가 아니라 방어값**이다 — 2026-08-06 이전에는 응답을 아예
    안 받고 7/7/8 을 박아서 모든 후보의 score100 이 동일했고 _AXIS_WEIGHTS 가 죽어 있었다.
    """
    v = src.get(key)
    if isinstance(v, (int, float)) and 0 <= float(v) <= 10:
        return int(round(float(v)))
    return default


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
    system = _base_system(genre, profile, cast_registry, transcript) + f"""

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
    system = _base_system(genre, profile, cast_registry, transcript) + f"""

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

**⭐ 첫 3초 Hook Intro (필수 · retention · docs/plans/shorts-hook-intro-3sec.md) ⭐**
쇼츠에 들어와서 시청자가 바로 이탈하지 않게 · 3필드:
- hook_quote: 이 쇼츠 안 대사 중 · 첫 3초 attention 사로잡을 원문 한 문장 (STT 그대로 · 30자 이내 · 지어내지 마)
  · 우선: 인용문·폭로·직업공개·반전 > 질문·리액션 > 웃음·감정 폭발
- hook_time_sec: 그 대사가 나오는 시각 (초 · 쇼츠 start 기준 상대 · 첫 5초 이내 권장)
- hook_intro_caption: 그 대사를 · 스크롤 멈추게 만들 어그로 편집자막으로 다듬음 (20자 이내)
  · 톤: 어그로·궁금증·충격 · 예 "충격 고백!" "이거 진짜야?" "설마?"
  · 금지: 담백한 요약 · 이유 안 주는 텍스트

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
# 완결성 우선: 60초 하드 트림은 스토리 잘림을 유발한다.
# 단, 운영자가 정한 90초를 절대 넘기지 않는다.
VALIDATE_MAX_SEC = 90.0


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
        # ⚠️ 모든 확장(발화·종결어미·서사비트) 뒤 **최종 90초 상한 재적용**. 위 1403 의 클램프는
        #    서사비트 완결 스냅(_snap_to_beat_closure)이 다음 비트까지 end 를 다시 늘려 무력화됐다 —
        #    그래서 90초로 자른 게 293초짜리 "숏폼" 으로 다시 커졌다(사용자 2026-08-20 실측).
        #    운영 상한(MAX_SHORT_SEC=90)은 절대선이라, 완결 스냅도 이 안에서만 허용한다.
        if end - start > MAX_SHORT_SEC:
            end = start + MAX_SHORT_SEC
            if transcript:
                # 90초 지점을 발화 경계로만 스냅하되 90초를 넘기지 않게 cap — 대사 중간 절단 방지.
                end = min(_snap_to_speech(start, end, transcript)[1], start + MAX_SHORT_SEC)
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
HEUR_MAX_SEC = 90.0      # 운영 상한: 1분 30초


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
    cast_block = _cast_block(cast_registry, transcript)
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
        f"{_program_context_block(_CURRENT_PROGRAM_CTX)}"
        # 운영자 커스텀 제목 지시(program.titlePrompt) — 기본 톤 위에 얹는 프로그램별 추가 규칙.
        f"{_operator_prompt_block(_CURRENT_PROGRAM_CTX, 'titlePrompt', '제목 작성')}\n"
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

    # 영상 길이에 비례한 목표 개수(10분당 3개·상한 20). 짧으면 자연히 작아진다 —
    # 들어온 기본값을 바닥으로 쓰지 않는다(_target_shorts_count 주석 참조).
    n = _target_shorts_count(scenes[-1]["end"])

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
        from core.common.channels import apply_channel_fit
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
SHORTFORM_MAX_SEC = 90.0
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
        system += _cast_block(cast_registry, transcript)

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
        system += _cast_block(cast_registry, transcript)

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
        system += _cast_block(cast_registry, transcript)

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
        system += _cast_block(cast_registry, transcript)

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
    vtype: 'shortform' (40~90s) | 'clip' (60~300s) | 'highlight' (300~600s).
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


# semantic closure QA · 맥락 완결 판정 ─────────────────────────────────────────

_SEMANTIC_CLOSURE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "complete": {"type": "BOOLEAN"},
        "extend_to_sec": {"type": "NUMBER"},
        "should_discard": {"type": "BOOLEAN"},
        "extend_confidence": {"type": "INTEGER"},  # 0-10 · extend 필요성 확신도 (7↑만 실행)
        "extend_payoff_quote": {"type": "STRING"},  # extend 시 새로 담기는 payoff 실제 인용
        "reason": {"type": "STRING"},
    },
    "required": ["complete"],
}


def _dialogue_slice(transcript: list[dict] | None, lo: float, hi: float,
                    max_chars: int = 500) -> str:
    """transcript 에서 [lo, hi] 범위 대사만 speaker 포함 텍스트."""
    if not transcript:
        return ""
    out = []
    used = 0
    for t in transcript:
        try:
            ts = float(t.get("start", 0)); te = float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if te <= lo or ts >= hi:
            continue
        speaker = (t.get("speaker") or "").strip() or "?"
        text = (t.get("text") or "").strip()
        if not text:
            continue
        line = f"[{int(ts//60)}:{int(ts%60):02d}] {speaker}: {text}"
        if used + len(line) > max_chars:
            break
        out.append(line)
        used += len(line)
    return "\n".join(out)


def _extract_frame_jpeg(video_path: str, t_sec: float, max_side: int = 640) -> bytes | None:
    """t 시점 프레임 1장을 JPEG bytes 로. cv2 사용. 실패 시 None.
    max_side 로 최대 변 리사이즈 (기본 640) · 이미지 토큰 아낌 · closure 판정엔 저해상 충분.
    """
    try:
        import cv2
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            return None
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(t_sec)) * 1000.0)
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            return None
        h, w = frame.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / float(max(h, w))
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
        if not ok:
            return None
        return bytes(buf)
    except Exception:
        return None


def _semantic_closure_one(client, short: dict, transcript: list[dict] | None,
                          duration: float, video_path: str | None = None) -> tuple[dict, str]:
    """단일 shorts 의 end 지점 semantic closure 판정. Gemini 1 콜 (multimodal).
    텍스트: 마지막 15s 대사 + 뒤 15s 컨텍스트. 이미지: end · +3s · +10s 3장.
    프레임을 봐야 리액션·표정·씬 전환을 판단 가능 (텍스트만으론 부족).
    반환: (수정된 shorts, action_log). action: 'keep'·'extend +Xs'·'discard'·'err'.
    """
    start = float(short.get("start", 0))
    end = float(short.get("end", 0))
    if end <= start:
        return short, "invalid"
    tail_lo = max(start, end - 15)
    next_hi = end + 15
    if duration > 0:
        next_hi = min(next_hi, duration)
    tail_dialogue = _dialogue_slice(transcript, tail_lo, end, max_chars=500)
    next_dialogue = _dialogue_slice(transcript, end, next_hi, max_chars=500)
    if not tail_dialogue.strip():
        return short, "no-tail"

    system = (
        "너는 한국 예능·방송 편집 전문가다. shorts clip 이 지정 시점에 끝난다.\n"
        "**기본 편향: 유지 (conservative)**. 확장은 확실한 근거 있을 때만.\n\n"
        "**입력**: 대사 (마지막 15s + 뒤 15s 컨텍스트) + 프레임 3장 (end · +3s · +10s).\n\n"
        "**⭐ 한국 예능 문법 (매우 중요) ⭐**:\n"
        "한국 예능은 [현장 씬] + [인터뷰룸 반응/코멘트] 가 세트로 편집된다.\n"
        "- 현장에서 사건 발생 → 다른 씬(인터뷰룸)에서 출연자·패널이 그 사건에 대해 리액션·해설·뒷얘기.\n"
        "- 프레임에 인터뷰룸(배경 바뀜 · 정면 카메라 · 자막 하단 위치) 이 뒤 15초에 있으면 · 그 인터뷰까지 담아야 완결.\n"
        "- 인터뷰의 첫 대사가 '아 그때…' · '진짜 웃긴 게…' · '저는 그때 이런 생각을…' 등 회고·해설 시작이면 강한 확장 신호.\n"
        "- 인터뷰 대사가 짧게 (5-10s) 완결되면 그 utterance.end 까지 확장. 인터뷰가 길게 다른 topic 로 이어지면 첫 완결 문장까지만.\n\n"
        "**판정 순서**:\n"
        "1. 먼저 '이미 완결됐나?' 판단. Clip 마지막 대사에 punchline·결론·감정 표현·정답·반전 있으면 → complete=true, extend X.\n"
        "   예시 완결 신호: 반전 직업 공개('한의사예요' '강사예요'), 갈등 해소 대사, 감정 절정, 카타르시스 대사, 결정적 폭로.\n"
        "   ✅ '반전 직업 공개' 자체가 clip 의 주제라면 · 뒤 리액션 필요 없음. 시청자는 정보 얻고 끝.\n"
        "   ⚠️ 단, 예능이면 위 완결 신호 뒤 인터뷰 리액션 (다른 씬 · 정면 카메라) 이 오면 그것까지 포함이 표준.\n\n"
        "2. 미완결이라 판단되면 · 뒤 15초에 진짜 payoff (**대사로 인용 가능한** 새 정보·새 감정·새 반전·인터뷰 리액션) 있나?\n"
        "   있으면: extend_to_sec = 그 지점, extend_payoff_quote = 실제 대사 인용, extend_confidence 8-10\n"
        "   없으면 (뒤 대사 = 그냥 이어지는 대화·중복 리액션·다른 topic 시작): 확장 X, complete=false·should_discard=true 이거나 그냥 유지\n\n"
        "**엄격 룰**:\n"
        "- '리액션 지속' · '분위기 이어짐' 은 확장 사유 아님 (단, 다른 씬의 명시 인터뷰 코멘트는 예외 · 위 예능 문법 참조).\n"
        "- End 프레임에 인물이 웃거나 정색하거나 '아하' 표정 = 이미 감정 완결. **뒤 인터뷰 없으면** 확장 X.\n"
        "- Title 이 담은 정보가 이미 clip 내에서 나왔으면 · 완결. 확장 X (인터뷰 리액션 예외).\n"
        "- +10s 프레임에 새 씬·새 인물·다른 topic → 확장 절대 X (단, 뒤 프레임이 인터뷰룸 = 확장 OK).\n"
        "- extend_confidence < 7 이면 실제 실행 안 됨 (파이프라인 필터). 확실할 때만 8-10 부여."
    )
    text_body = (
        f"## Clip 마지막 15초 대사 (t={tail_lo:.0f}s ~ {end:.0f}s)\n{tail_dialogue}\n\n"
        f"## 뒤 15초 대사 (t={end:.0f}s ~ {next_hi:.0f}s)\n{next_dialogue or '(없음 또는 영상 끝)'}\n\n"
        f"## Clip 제목 (참고): {short.get('title','')}\n\n"
        f"위 대사 + 아래 프레임 3장 (end · +3s · +10s) 종합해 판정하라."
    )
    # 이미지 3장 추출 (video 있으면). 실패해도 텍스트로 진행.
    parts: list = [types.Part.from_text(text=text_body)]
    if video_path:
        for label, t in (("end", end), ("+3s", end + 3), ("+10s", end + 10)):
            if duration > 0 and t > duration:
                continue
            img = _extract_frame_jpeg(video_path, t)
            if img:
                parts.append(types.Part.from_text(text=f"[프레임 {label} @ t={t:.1f}s]"))
                parts.append(types.Part.from_bytes(data=img, mime_type="image/jpeg"))
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.2,
                response_mime_type="application/json",
                response_schema=_SEMANTIC_CLOSURE_SCHEMA,
                max_output_tokens=512,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        data = json.loads(resp.text or "{}")
    except Exception as e:
        return short, f"err: {str(e)[:60]}"

    if data.get("should_discard"):
        short = dict(short)
        short["_discard_reason"] = f"semantic incomplete: {(data.get('reason') or '')[:60]}"
        return short, "discard"
    ext = data.get("extend_to_sec")
    conf = data.get("extend_confidence") or 0
    payoff_quote = (data.get("extend_payoff_quote") or "").strip()
    # 기본 게이트: conf≥7 · payoff_quote 있음 · extend 범위 내
    if not (isinstance(ext, (int, float)) and ext > end and ext <= end + 20 and conf >= 7 and payoff_quote):
        return short, "keep"
    llm_proposed_end = round(float(ext), 1)
    if llm_proposed_end <= end:
        return short, "keep"

    # GUARD A + timestamp snap: payoff_quote 를 STT 에서 실 위치 찾아 그 utterance.end 로 스냅.
    # LLM 의 extend_to_sec 은 대략 값 · STT sentence boundary 무시하고 임의 시각 (예: 문장 도중)
    # 반환하는 관찰. 실 대사 위치로 스냅하면 sentence 완결 지점에 정확히 컷.
    import re as _re
    def _norm(s: str) -> str:
        return _re.sub(r'[\s.,?!…"\'()\[\]!?~-]+', '', s.strip())
    quote_norm = _norm(payoff_quote)
    quote_key = quote_norm[:min(10, max(3, len(quote_norm) // 2))] if quote_norm else ""
    if not quote_key:
        return short, "keep (guard-A · quote empty)"
    # LLM 제안 시각 + 3s tolerance 안에서 quote 매칭되는 utterance 찾기 (마지막 매칭)
    tolerance = 3.0
    search_hi = min(llm_proposed_end + tolerance, end + 20)
    if duration > 0:
        search_hi = min(search_hi, duration)
    match_utt_end = None
    for t in (transcript or []):
        try:
            ts = float(t.get("start", 0)); te = float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if te <= end or ts >= search_hi:
            continue
        txt_norm = _norm(t.get("text", ""))
        if quote_key in txt_norm:
            match_utt_end = te  # 마지막 매칭 계속 갱신 (multi-utterance quote 대응)
    if match_utt_end is None:
        return short, f"keep (guard-A · quote '{payoff_quote[:20]}' STT 에 실 존재 X)"
    # 연속 발화 확장: 같은 화자가 이어서 같은 맥락으로 얘기하면 그 utterance 까지 포함.
    # gap <= 1.5s = 실질적 continuous speech. 화자 바뀌거나 긴 침묵이면 stop.
    # 사용자 요구 (2026-07-29): "한 사람 동일 맥락 발화 이어지면 그 다음 대사까지".
    matched_utt = None
    for u in (transcript or []):
        try:
            te = float(u.get("end", 0))
        except (TypeError, ValueError):
            continue
        if abs(te - match_utt_end) < 0.5:
            matched_utt = u
            break
    if matched_utt is not None:
        matched_speaker = (matched_utt.get("speaker") or "").strip()
        current_end = match_utt_end
        hard_cap = min(end + 20, (duration or 0) or end + 20)
        for u in (transcript or []):
            try:
                us = float(u.get("start", 0)); ue = float(u.get("end", 0))
            except (TypeError, ValueError):
                continue
            if ue <= current_end + 0.3:
                continue
            if us > hard_cap:
                break
            sp = (u.get("speaker") or "").strip()
            gap = us - current_end
            # 같은 화자 + 짧은 gap = continuous speech · 계속 확장
            if matched_speaker and sp == matched_speaker and gap <= 1.5 and ue <= hard_cap:
                current_end = ue
            else:
                break
        match_utt_end = current_end
    # 스냅된 new_end 사용 (LLM 값 아닌 실 utterance boundary + 연속발화 확장)
    new_end = round(match_utt_end, 1)
    if duration > 0:
        new_end = min(new_end, duration)
    if new_end <= end:
        return short, "keep"

    # GUARD B: 확장이 speaker 전환 지점을 크게 넘어가면 거부 (새 topic 위험).
    # 화자 바뀐 뒤 2초 이상 새 화자 turn 이 이어지면 다음 인물 소개·다른 주제로 볼 확률 높음.
    # 짧은 reaction (질문→답변, 셋업→리액션) 은 <2s 이므로 허용.
    last_speaker_before_end = None
    for t in (transcript or []):
        try:
            te = float(t.get("end", 0))
        except (TypeError, ValueError):
            continue
        if te <= end:
            sp = (t.get("speaker") or "").strip()
            if sp:
                last_speaker_before_end = sp
        elif te > end + 0.5:
            break
    first_switch_ts = None
    for t in (transcript or []):
        try:
            ts = float(t.get("start", 0))
        except (TypeError, ValueError):
            continue
        if ts <= end:
            continue
        if ts > new_end + 2.0:
            break
        sp = (t.get("speaker") or "").strip()
        if sp and last_speaker_before_end and sp != last_speaker_before_end:
            first_switch_ts = ts
            break
    # guard-B 임계 4s: Q→A · 짧은 답변·리액션은 허용 (예: "정답! 미대." 3.5s).
    # 새 speaker turn 이 4s+ 이어지면 다음 인물 소개·다른 주제로 간주 · 거부.
    if first_switch_ts is not None and (new_end - first_switch_ts) > 4.0:
        return short, f"keep (guard-B · speaker switch @ {first_switch_ts:.1f}s · 확장 {new_end - first_switch_ts:.1f}s 새 turn 침범)"

    # 길이 상한을 넘기는 확장은 승인하지 않는다 (2026-08-25). 여기서 부분만 늘리면 payoff
    # 에 못 닿은 채 길이만 먹으므로, 늘릴 수 없으면 **원래 끝을 유지**한다.
    # (이 확장이 상한을 무력화하던 경로다: 88s 짜리가 +20s 로 108s 가 돼도 아무도 안 봤다.)
    if new_end - start > MAX_SHORT_SEC:
        return short, (f"keep (길이 상한 · {new_end - start:.0f}s > {MAX_SHORT_SEC}s "
                       f"이라 확장 거부)")

    # 모두 통과 · 확장 승인. 확장 metadata 를 shorts dict 에 저장 (HTML 리뷰·감사용).
    short = dict(short)
    orig_end = end
    short["end"] = new_end
    short["_semantic_extend"] = {
        "delta_sec": round(new_end - orig_end, 1),
        "original_end": round(orig_end, 1),
        "confidence": conf,
        "payoff_quote": payoff_quote,
    }
    return short, f"extend +{new_end - end:.1f}s (conf={conf} · '{payoff_quote[:25]}')"


def refine_boundaries_semantic(
    client, shorts: list[dict], transcript: list[dict] | None, duration: float,
    video_path: str | None = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[dict]:
    """각 shorts end 가 서사 완결됐는지 Gemini 로 판정 · end 조정 or 폐기.
    기존 boundary snap 4단계 (문장·발화·shot·침묵) 뒤 semantic closure QA 로 추가.
    2026-07-29 사용자 지적: '문장 시작·끝보다 맥락 완결이 핵심 · 음성뿐 아니라 프레임 봐야'.
    video_path 있으면 end · +3s · +10s 프레임 3장을 Gemini 에 첨부 (multimodal).
    미완결은 최대 +20s 확장 · 확장해도 안 되면 폐기.
    """
    if not shorts or not transcript:
        return shorts
    total = len(shorts)
    if on_progress:
        on_progress(0, total)
    results: list[dict | None] = [None] * total
    logs: list[str] = [""] * total
    from concurrent.futures import as_completed
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {
            ex.submit(_semantic_closure_one, client, s, transcript, duration, video_path): i
            for i, s in enumerate(shorts)
        }
        done_count = 0
        for fu in as_completed(futures):
            i = futures[fu]
            try:
                r, log = fu.result()
                results[i] = r
                logs[i] = log
            except Exception as e:
                results[i] = shorts[i]
                logs[i] = f"err: {str(e)[:60]}"
            done_count += 1
            if on_progress:
                on_progress(done_count, total)
    kept: list[dict] = []
    n_extend = n_keep = n_discard = 0
    for i, s in enumerate(results):
        if s is None:
            kept.append(shorts[i]); n_keep += 1; continue
        if s.get("_discard_reason"):
            n_discard += 1
            print(f"   (semantic 폐기 #{i}: {s.get('_discard_reason','')[:80]})")
            continue
        if logs[i].startswith("extend"):
            n_extend += 1
            print(f"   (semantic {logs[i]} #{i}: {str(s.get('title',''))[:30]})")
        elif logs[i] == "keep":
            n_keep += 1
        kept.append(s)
    print(f"   semantic closure QA: 유지 {n_keep} · 확장 {n_extend} · 폐기 {n_discard}")
    return kept


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


_SHORTS_FROM_BEATS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "shorts": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "beat_ids": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "title": {"type": "STRING"},  # 폴백 · 한 줄 전체
                    "title_line1": {"type": "STRING"},  # 상단 · 상황·주어 (기본 톤 · 흰색/검정)
                    "title_line2": {"type": "STRING"},  # 하단 · 핵심 폭로·반전 (컬러 강조)
                    "title_line2_color": {"type": "STRING"},  # blue|red|yellow|green (기본 blue)
                    "hook": {"type": "STRING"},
                    # 2026-07-31 · 쇼츠 첫 3초 hook intro (docs/plans/shorts-hook-intro-3sec.md).
                    # 목적: retention · 스크롤 정지 · 시청자 이탈 방지. 3필드:
                    "hook_quote": {"type": "STRING"},  # 실 대사 인용 (STT 원문 · 30자 이내 · 검증 가능)
                    "hook_time_sec": {"type": "NUMBER"},  # hook 대사 시각 (초 · 쇼츠 시작 상대)
                    "hook_intro_caption": {"type": "STRING"},  # 어그로 편집자막 (20자 · '충격 고백!' '이거 진짜?' 톤)
                    "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "why": {"type": "STRING"},
                    # ⚠️ 3축 점수(hook_strength/payoff/completeness)를 **여기 넣지 말 것.**
                    # 2026-08-06 당일 추가했다가 같은 날 철회 — LLM 점수는 같은 입력에도 실행마다
                    # 달라져서 A/B·회귀 판정이 불가능해진다("맨날 결과가 바뀌어").
                    # score100·순위는 _deterministic_score 가 signals·hook·길이·완결성으로 계산한다.
                    # LLM 은 조합 제안·제목·훅자막 생성까지만.
                },
                "required": ["beat_ids", "title", "hook"],
            },
        },
    },
    "required": ["shorts"],
}


def propose_shorts_beat_only(
    client, beats: list[dict], transcript: list[dict] | None,
    genre: str, n: int, cast_registry: list[dict] | None,
    profile: dict | None = None,
) -> list[dict]:
    """오로지 beat 목록만 입력으로 shorts N개 생성 (2026-07-27).

    사용자 방향: "오로지 추천하는애는 비트만주고 그 비트를 붙여서 쇼츠를 만들음."
    이전 Phase A(propose_scenarios)는 서사·자막·인물을 다 봐서 시나리오 5개를 지어냈고,
    그 과정에서 실제 대사에 없는 사건(예: "골프 회사원→배우 전향")을 지어 hallucination
    유발. 이제 recommender는 편집자가 정돈한 beat 목록만 보고 조합만 결정한다.

    각 short = 인접·관련 beat 1~3개 조합 (beat_ids 지정).
    - 제목·hook·tags는 선택한 beats의 summary에서만 유도 (grounded).
    - 시각 = 조합된 beats의 first.start ~ last.end.
    - 같은 beat_ids 조합 중복 금지.
    """
    if not beats:
        return []
    pack = _pack(genre)

    # beat 목록 + 각 beat 구간의 실제 대사 (grounding — summary만으론 hallucination 방지 부족)
    def _beat_dialogue(b: dict, max_chars: int = 300) -> str:
        try:
            bs = float(b.get("start", 0)); be = float(b.get("end", 0))
        except (TypeError, ValueError):
            return ""
        acc: list[str] = []
        used = 0
        for t in (transcript or []):
            try:
                ts = float(t.get("start", 0)); te = float(t.get("end", 0))
            except (TypeError, ValueError):
                continue
            if te <= bs or ts >= be:
                continue
            txt = (t.get("text") or "").strip()
            if not txt:
                continue
            acc.append(txt)
            used += len(txt)
            if used >= max_chars:
                break
        return " ".join(acc)[:max_chars]

    # 시청자 지목 timestamp → 겹치는 beat 마킹 (2026-07-28).
    # profile.viewer_signals.explicit_timestamps (comment_signal 이 정규식 파싱) 의 각 초 값이
    # beat [start, end] 안에 있으면 그 beat 를 ⭐VIEWER 로 표시한다. Gemini 프롬프트에서
    # "starred 최소 1개 반드시 포함" 규칙과 함께 시청자 반응이 강한 구간을 shorts 에 강제한다.
    # timestamps 없거나 겹치는 beat 없으면 starred_map 이 비어 규칙 블록 자체가 생략됨.
    starred_map: dict[int, list[tuple[str, int]]] = {}
    vs = (profile or {}).get("viewer_signals") if isinstance(profile, dict) else None
    if isinstance(vs, dict):
        ets = vs.get("explicit_timestamps") or []
        parsed_ts: list[tuple[str, int, int]] = []  # (mmss, seconds, likes)
        for t in ets:
            if not isinstance(t, dict):
                continue
            mmss = str(t.get("mmss") or "").strip()
            try:
                likes = int(t.get("likes") or 0)
            except (TypeError, ValueError):
                likes = 0
            # "H:MM:SS" 또는 "M:SS" 모두 지원. 콜론으로 분리 후 초 환산.
            parts = mmss.split(":")
            try:
                if len(parts) == 3:
                    secs = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    secs = int(parts[0]) * 60 + int(parts[1])
                else:
                    continue
            except ValueError:
                continue
            if secs > 0:
                parsed_ts.append((mmss, secs, likes))
        if parsed_ts:
            for i, b in enumerate(beats):
                try:
                    bs = float(b.get("start", 0)); be = float(b.get("end", 0))
                except (TypeError, ValueError):
                    continue
                hits = [(m, l) for (m, s, l) in parsed_ts if bs <= s <= be]
                if hits:
                    starred_map[i] = hits

    lines = ["=== 사용 가능 beat (id, 시각, hook, 인물, 제목 / 요약 / 실제 대사) ==="]
    for i, b in enumerate(beats):
        st = float(b.get("start", 0)); en = float(b.get("end", 0))
        dur = en - st
        hook = (b.get("hook") or "-").strip()
        chars = ",".join(str(c).strip() for c in (b.get("characters") or []))[:40]
        title = (b.get("title") or "").strip()[:60]
        summary = (b.get("summary") or "").strip()[:200]
        dialogue = _beat_dialogue(b)
        star_tag = ""
        if i in starred_map:
            hits = starred_map[i]
            total_likes = sum(l for _, l in hits)
            times = " ".join(m for m, _ in hits)
            star_tag = f"⭐VIEWER({times} · {total_likes}❤) "
        lines.append(f"[b{i}] {star_tag}{_mmss(st)}~{_mmss(en)} ({dur:.0f}s) · {hook} · {chars or '-'} · \"{title}\"")
        if summary:
            lines.append(f"      요약: {summary}")
        if dialogue:
            lines.append(f"      대사: {dialogue}")

    system = f"""너는 {pack['label']} SNS 쇼츠(YouTube Shorts/IG Reels/TikTok) 편집자다.
편집자가 이미 정돈한 **beat 목록**만 보고 쇼츠 {n}개를 선정한다.

**⭐ 한국 예능·방송의 편집 표준 문법 (매우 중요) ⭐**:
한국 예능·방송 편집의 정석은 [**현장 씬 (사건 발생)**] + [**인터뷰룸/자막 리액션 (해설·감상·뒷얘기)**]
이 반드시 **한 세트**로 묶이는 구조다. 이건 시청자 몰입·이해·감정 완결의 핵심.

- 자기소개·폭로·리액션 shorts 는 절대 **현장만** 또는 **인터뷰만** 으로 뽑지 마.
- 반드시 (a) 현장 발화·사건 beat + (b) 그 뒤 인터뷰룸(다른 씬·정면 카메라·상단 자막) 에서 출연자가
  그 사건에 대해 회고·해설·감정 표현하는 beat 을 **함께** 묶어라.
- 인터뷰 beat 판별 힌트: shot_types 에 'interview' 표시, 다른 화자 등장하지 않고 정면 카메라 단독,
  대사가 "저는 그때…" · "진짜 웃긴 게…" · "저 지금도 생각해도…" 등 회고형.
- 인터뷰 없이 현장만이면 · 시청자는 "그래서?" 하고 이탈. 인터뷰 없이 인터뷰만이면 · 문맥 이해 불가.
- 예능 shorts 이상적 구조: [30-40s 현장] + [10-20s 인터뷰 리액션] = 40-60s 완결.

이 장르 터지는 기준:
{pack['guidance']}

**🚨 절대 규칙 — 지어내기 금지**:
1. 각 쇼츠는 **정확히 아래 beat 목록의 beat_id들만 조합**해서 만든다. 새 시각·대사를 지어내지 마라.
2. 제목·hook·tags는 반드시 **선택한 beat들의 "대사" 필드에 실제 나온 단어·인물·사건**만 참조.
3. summary는 참고용이고 **대사 필드가 진실**이다. 대사에 없는 사건·직업·감정·이름을 제목에 넣지 마.
4. 예: 대사에 "골프 회사"만 있고 "배우"는 없으면 title에 "배우" 넣지 마. 대사에 "지연" 없으면
   title에 "지연" 쓰지 마. 대사 근거로만 재구성해라.

**🚨 시제·부정 왜곡 금지 (매우 중요)**:
- 대사에 "**지금은 X를 그만두고 Y이다**" 있으면 title에 X를 현재 직업처럼 쓰지 마. Y가 현재.
  예: 대사 "10년 연기했고요. 지금은 배우를 그만두고 연기 선생님입니다" → **title은 "연기 선생님"**,
      "10년차 배우"는 오답. 과거·전직 사실을 현재로 왜곡 금지.
- 대사에 "~아니다", "~못했다", "~없다" 있으면 title에서도 부정 유지. 긍정으로 뒤집지 마.
- 인용 시 대사 원문 어투 존중.

**🚨 다인 커버 규칙**:
- 조합한 beat들에 **2명 이상 서로 다른 인물의 자기소개·핵심 순간**이 있으면 title에서 두 명 다
  언급하거나 "두 사람의 반전 직업"처럼 복수형 사용. 한 명만 뽑고 다른 사람 무시 금지.
- 예: b5=지아, b6=지아 리액션, b7=유진 자기소개까지 담겼으면 title이 "지아·유진의 반전 직업" 같이
  둘 다 잡아라. "지아만" 언급하는 title은 반쪽 정보.

**🚨 익명 라벨 규칙**:
- 입력에 "발화자 1", "발화자 3" 같은 라벨이 나오면 그건 STT 화자분리 임시 ID일 뿐.
- **title·tags·why에 "발화자 N"을 절대로 노출 금지**. 사용자가 볼 문구다.
- 대사에 실제 이름이 있으면 그 이름 사용 (예: "지연", "원균"). 없으면 "한 출연자", "누군가",
  "그녀", "첫 참가자" 같은 자연스러운 표현.

**조합 규칙**:
- 각 쇼츠는 필요한 beat 수만큼 조합 (보통 3~5개, 리액션까지 담으려면 4~6개도 OK).
- **총 span 목표는 40초~1분30초, 최대 2분(120s)까지 허용**. 자기소개+리액션+인터뷰룸 다 담으면
  자연히 60~120s. 파편(30초대) 지양.
- beat_ids는 **시각순 인접**(index 연속) 또는 같은 인물·화제로 관련된 beat만 묶어라.

**🚨 자기소개 + 리액션 필수 결합 (매우 중요)**:
- 자기소개·핵심 발표 beat을 뽑을 때는 **그 뒤에 나오는 다른 출연자 리액션·감상 beat들도 반드시
  같은 쇼츠에 함께** 담아라. 리액션 없이 자기소개만 뽑으면 반쪽 스토리.
- 리액션 beat 판별: hook=감정고조·공감·질문·웃음, title에 "리액션", "놀란", "반응", "감상", "회상",
  "인터뷰룸", "느낌" 등 포함. 또는 같은 시각대에서 다른 화자가 그 인물에 대해 말하는 beat.
- 예: b5=원균 자기소개(정보성) + b6=놀란 리액션(감정고조) + b7=긍정 인상(공감) + b8=인터뷰룸 회상
  → 모두 하나의 쇼츠 [b5,b6,b7,b8]. b7,b8을 빼면 반쪽.
- **자기소개 shorts의 마지막 beat은 반드시 리액션·감상 beat이어야 함** — 자기소개 발화 beat에서 끝나면 여운 없음.

- **완결성 우선**: 원 신(setup) → 리액션 → 인터뷰룸(payoff·이유·회상)이 있으면 반드시 **인터뷰룸까지
  포함**해서 이유·감정 완결. 원 신만 뽑고 인터뷰룸을 별도 쇼츠로 쪼개면 스토리가 반쪽.
- 완전히 동일한 beat_ids 조합 금지 (다양성).
- 결과 쇼츠들이 서로 다른 시간대·주제·인물을 다루도록 다양성 확보.

**🚨 커버리지 규칙**:
- 각 자기소개(정보성 hook이면서 새 인물 등장) beat은 최소 하나의 쇼츠에 포함되어야 한다.
  자기소개 통째 누락 금지. 요청 n개 안에 다 못 담으면 우선순위 낮은 쇼츠 대신 자기소개 shorts 확보.

**인물 이름 사용 규칙 (필수)**:
- 위 beat들의 characters·summary에 **실제로 언급된 이름만** 사용.
- summary에 "지연"이 등장하지 않으면 title에 "지연" 넣지 마라. 인물명 지어내기 금지.
- 이름이 불확실하면 title에서 인물명 생략 ("한 출연자가...", "그의..." 등으로 표현).

**title 규칙 (2026-07-28 사용자 방향: 어그로·클릭베이트)**:
- 12~30자 · SNS 피드에서 스크롤 멈출 자극적 어투. 담백·감상 톤은 지양.
- **호기심·긴장·감정 극대화**: 반전 예고("반전에 소름", "충격 정체"), 상반된 정보 병치("전직 X → 지금은 Y"),
  미완결 여운("...", "정체는?"), 리액션 노출("모두 얼음", "웅성", "충격").
- 물음표·느낌표 · 문장 부호 자유롭게 활용. "?!", "…" 조합도 OK.
- 대사·인물 인용을 활용해 훅 만들기 ("**'저 한의사예요'**", **"쥐약 먹었구나 반전"**).
- 다만 **없는 사실 지어내지 마** — 어그로는 진짜 있는 사실을 자극적으로 표현하는 것이지,
  없는 사건·발언을 낚시로 만들어내는 게 아니다.
- 좋은 예: "'저 한의사예요' 한마디에 얼어붙은 스튜디오",
  "1등 공무원 접고 요식업? 데이트 요리의 정체",
  "X 앞에서 무용 감춘 진짜 이유, 결국 폭로",
  "10년 연기 접은 그녀, 지금은…"

**hook**: 반전 / 감정고조 / 돌직구 / 질문 / 정보성 / 웃음 / 갈등 / 공감 / 기타 중 하나.

**⭐ 두 줄 제목 (요즘 쇼츠 표준 스타일) ⭐**:
title 은 폴백용 한 줄 · **title_line1 + title_line2** 를 필수로 뽑는다. 렌더 시 2줄 표시 · line2 는
컬러 (노랑·파랑·빨강) 로 강조된다.

**🚨 길이 제한 (엄격 · 반드시 준수) 🚨**:
- **title_line1: 최대 12자 (한글 기준)** · 짧을수록 좋음. 목표 8-10자.
- **title_line2: 최대 12자** · 목표 8-11자.
- **shorts 화면 좁아서 15자 넘어가면 잘림.** 20자 절대 X.
- 인용문·조사·군더더기 삭제. 짧고 강한 단어만.

**title_line1** (상단 · 흰색 톤다운): **오해·질문·기대** — 짧게
    예: "헬스장 사장인 줄?" (9자) · "개그맨인 줄 알았지" (10자) · "10년차 배우?" (7자)
**title_line2** (하단 · 컬러 강조): **반전·정답·핵심**
    예: "7년차 한의사의 반전" (10자) · "삐끼 최홍만도 홀렸다" (11자) · "예술고 강사로 리셋" (10자)
**title_line2_color**: 기본 "yellow" · "red" (충격·폭로) · "blue" (진지 정보) · "green" (긍정)

**두 줄 title 좋은 예 (짧고 강함)**:
- "헬스장 사장인 줄?" (9자) / "7년차 한의사의 반전" (10자) - yellow
- "개그맨인 줄 알았지" (10자) / "삐끼 최홍만도 홀렸다" (11자) - yellow
- "10년 연기 끝" (7자) / "예술고 강사 인생 2막" (11자) - blue
- "저 지금도 못 잊어" (9자) / "믿기 힘든 실화" (8자) - red

**나쁜 예 (너무 김 · 절대 X)**:
- "예술고에서 친구들을 가르치는 그녀의 정체는?" (21자 ❌)
- "모두를 놀라게 한 그녀의 직업은 현대무용수!" (20자 ❌)
- "패션 브랜드 직원, 그녀의 패션 센스 비결은?" (22자 ❌)

title (폴백) 은 두 줄 합쳐 한 줄로 자연스럽게.

**⭐ 첫 3초 Hook Intro (docs/plans/shorts-hook-intro-3sec.md) ⭐**:
쇼츠에 들어와서 시청자가 바로 이탈하지 않게 · 첫 3초 attention 을 사로잡을 hook 3필드:

- **hook_quote**: 이 쇼츠 안 대사 중 · 가장 임팩트 있는 한 문장 원문 그대로 (STT 그대로 · 30자 이내)
    · 반드시 실제로 쇼츠 시간 범위 안 대사 중에서 · 지어내지 마
    · 우선순위: 인용문·폭로·직업공개·반전 > 질문·리액션 > 웃음·감정 폭발
- **hook_time_sec**: 그 대사가 나오는 시각 (초 · 쇼츠 시작 기준 상대 시각 · 첫 5초 이내 권장)
- **hook_intro_caption**: 그 대사를 · 시청자가 스크롤 멈추게 만들 어그로 편집자막으로 다듬은 것 (20자 이내)
    · 톤: 어그로·궁금증·충격 · 예 "충격 고백!" "이거 진짜야?" "설마?" "잠깐만!"
    · 금지: 담백한 요약 · 시청자에게 이유를 안 주는 텍스트

**반환 형식** (JSON):
{{"shorts":[
  {{"beat_ids":[3,4], "title":"헬스장 사장인 줄? 7년 차 한의사의 반전",
    "title_line1":"헬스장 사장인 줄?", "title_line2":"7년 차 한의사의 반전", "title_line2_color":"yellow",
    "hook":"반전",
    "hook_quote":"저 사실 한의사예요", "hook_time_sec":2.4, "hook_intro_caption":"충격 고백!",
    "tags":["직업공개","한의사"],
    "why":"b3에서 원균이 한의사 자기소개, b4에서 다른 출연자 놀란 리액션. 완결 흐름."}}
]}}

※ 점수·순위는 매기지 마라. 그건 파이프라인이 신호로 계산한다. 너는 **어떤 beat 를 묶을지와
  제목·훅 자막**만 정하면 된다.
"""
    if profile:
        system += _profile_block(profile)
    # ⭐VIEWER starred beat 강제 규칙 (2026-07-28). 위에서 explicit_timestamps 와 beat 겹침을
    # 판정해 starred_map 을 채워둠. 표시된 beat 가 하나라도 있을 때만 규칙 블록을 붙여
    # 시나리오 시뮬레이션이 왜곡되지 않게 (viewer_signals 없는 케이스 = 기존 동작 유지).
    if starred_map:
        starred_ids = sorted(starred_map.keys())
        ranked = sorted(
            starred_map.items(),
            key=lambda kv: sum(l for _, l in kv[1]),
            reverse=True,
        )
        ranked_hint = ", ".join(
            f"b{i}({sum(l for _, l in hits)}❤)" for i, hits in ranked[:5]
        )
        system += (
            "\n\n**🚨 시청자 지목 beat 규칙 (⭐VIEWER 표시 · 매우 중요)**:\n"
            "- 위 beat 목록에서 ⭐VIEWER 표시된 것은 이 영상의 실제 시청자가 원본 유튜브 댓글에서\n"
            "  좋아요 상위로 지목한 시간대다. 편집자가 놓치기 쉬운 시청자 반응 신호.\n"
            "- **starred beat 중 최소 1개는 반드시 shorts 중 하나의 조합에 포함되어야 한다.**\n"
            f"- 여러 개면 좋아요 총합 높은 순으로 우선 반영: {ranked_hint}.\n"
            "- 규칙과 위 자기소개 커버리지 규칙이 충돌하면 자기소개를 먼저 확보하고, 남는 n에서\n"
            "  starred 를 채워라. 다만 shorts 중 하나에는 반드시 포함되어야 한다는 조건은 유지.\n"
            f"- 감지된 starred beat 총 {len(starred_ids)}개 · id: {starred_ids}\n"
        )
    if cast_registry:
        system += _cast_block(cast_registry, transcript)
    # 프로그램 컨텍스트(시놉시스·톤·분위기)를 힌트로 주입 — title이 그 프로그램 결에 맞게 나오도록.
    # _CURRENT_PROGRAM_CTX는 recommend()가 활성화. 없으면 no-op.
    # 특정 프로그램 이름·예시 하드코드 금지 — 아래 힌트는 section/moods 필드에 따라
    # 모델이 스스로 적용. 프로그램 정보 없으면 이 블록 자체가 안 들어감.
    ctx_block = _program_context_block(_CURRENT_PROGRAM_CTX)
    if ctx_block:
        system += (
            "\n\n**🚨 프로그램 톤 반영 (title 어투에 필수) 🚨**:\n" + ctx_block +
            "\n\n위 프로그램 정보(section·synopsis·moods)를 근거로 title 어투 결정. "
            "**형식적·설명적 title 절대 금지**('직업 공개', '~한 사연' 등). "
            "시청자가 SNS 피드에서 스크롤 멈출 담백한 여운·긴장·감정 포함.\n"
            "\n"
            "**어느 프로그램이든 공통 원칙**:\n"
            "1. 프로그램 핵심 갈등축(예: 연애 리얼리티=관계·감정, 서바이벌=경쟁·탈락,\n"
            "   토크쇼=폭로·리액션, 다큐=진실·발견)을 title 앞에 세워 어그로 극대화.\n"
            "2. moods에 나열된 감정·분위기 태그를 title 어휘 결정에 반영.\n"
            "3. synopsis에 등장하는 인물 관계·상황 어휘(예: X·이별·재회·미션·경쟁·인터뷰룸)를\n"
            "   최대한 활용. 시놉시스 밖 사건은 지어내지 마.\n"
            "4. 인용·여운(...)·'?!' 등 자극 문장부호 자유롭게. 담백·감상 톤은 스크롤 유발 못함.\n"
        )

    # 운영자 커스텀 프롬프트 — recommendPrompt 는 beat 조합(어떤 구간을 묶어 쇼츠로 만들지),
    # titlePrompt 는 제목·훅 자막 어투에 얹는다. 점수·순위는 아래 _deterministic_score 가
    # 신호로 계산하므로 여기 지시가 순위 결정론을 깨지 않는다(리포 원칙 유지).
    system += _operator_prompt_block(_CURRENT_PROGRAM_CTX, "recommendPrompt", "추천 구간(beat 조합) 선택")
    system += _operator_prompt_block(_CURRENT_PROGRAM_CTX, "titlePrompt", "제목 작성")

    # 개수는 **커버리지**로 자연스럽게 채운다 — 억지 백필(약한 구간 끼워넣기)이 아니라
    # "좋은 구간을 놓치지 마라"로 유도(사용자 방향 2026-08-24 "억지가 아니라 자연스럽게").
    # n 은 길이 비례(_target_shorts_count) — 짧으면 작다. n<=2(약 7분 이하)면 개수를 아예
    # 강제하지 않는다: "완결되는 것만, 없으면 0". 그 이상이면 전체를 훑게 해 조기중단(앞부분만
    # 뽑고 끝내 뒤쪽을 흘리는 실패 모드)을 막되, 질 미달은 빼도 된다고 명시해 padding 을 막는다.
    if n <= 2:
        prompt = "\n".join(lines) + (
            f"\n\n=== 목표 쇼츠 수: 최대 {n}개 (강제 아님) ===\n"
            "- **짧은 영상이다.** 완결되는 좋은 구간만 골라라. 무리하게 개수를 맞추지 마라 —\n"
            "  쓸 구간이 적으면 적게, 아예 없으면 0개여도 된다.\n"
            "- 셋업 없이 결정타만 있거나 완결이 안 되는 약한 구간은 절대 넣지 마라."
        )
    else:
        prompt = "\n".join(lines) + (
            f"\n\n=== 목표 쇼츠 수: {n}개 ===\n"
            "- 위 beat 목록을 **처음부터 끝까지** 훑어라. 앞부분만 보고 멈추지 마라 — 뒤쪽에도\n"
            "  완결되는 구간이 있다. 흔한 실수가 초반 몇 개만 뽑고 끝내는 것이다.\n"
            f"- 이 길이 영상이면 보통 {n}개 안팎이 **자연스럽게** 나온다. 완결·비중복 구간이면 적극 포함하라.\n"
            "- 다만 **억지로 채우지는 마라**: 셋업 없이 결정타만 있거나, 이미 뽑은 구간과 겹치거나,\n"
            "  완결이 안 되는 약한 구간은 넣지 마라. 좋은 게 적으면 적게 나와도 된다 — 질이 먼저다."
        )

    # 사용자 지시 (2026-07-31 · "AI에게 어떻게 정보를 주는지 나한테 주라"):
    # RECOMMEND_DEBUG_DUMP=<path> env 있으면 system + user prompt 를 파일에 저장.
    _dump_path = os.environ.get("RECOMMEND_DEBUG_DUMP")
    if _dump_path:
        try:
            from pathlib import Path as _P
            _P(_dump_path).parent.mkdir(parents=True, exist_ok=True)
            _dump = (
                f"# recommend LLM · propose_shorts_beat_only\n"
                f"# model={MODEL} · beats={len(beats)} · n={n} · genre={genre}\n\n"
                f"=" * 80 + "\n[SYSTEM INSTRUCTION]\n" + "=" * 80 + "\n"
                + system
                + "\n\n" + "=" * 80 + "\n[USER PROMPT]\n" + "=" * 80 + "\n"
                + prompt
            )
            _P(_dump_path).write_text(_dump, encoding="utf-8")
            print(f"   [debug] recommend prompt dump → {_dump_path}")
        except Exception as _e:
            print(f"   [debug] prompt dump 실패: {_e}")

    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.3,
                response_mime_type="application/json",
                response_schema=_SHORTS_FROM_BEATS_SCHEMA,
                # ⚠️ 8192 는 잘림 위험대였다. 60분 회차는 n≈18~20 을 요구하는데(위 n 산정),
                # 각 short 가 beat_ids·2줄 제목·훅 3필드·why·tags 를 채우면 ~400토큰 → 20개면
                # ~8000토큰이라 8192 에서 배열이 중간에 끊긴다. 잘리면 json.loads 가 실패해
                # except 로 **빈 리스트**를 반환(:아래) → 쇼츠가 0~몇 개로 폭락(개수 들쑥날쑥의
                # 큰 축). 상한만 올린다(모델 상한 65536, thinking 0). 실제 생성분만 과금이라
                # 회차 원가 영향은 사실상 0 — 안 잘리게 하는 안전 여유일 뿐.
                max_output_tokens=24576,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        data = json.loads(resp.text or "{}")
    except Exception as e:
        print(f"   (beat-only shorts 실패: {str(e)[:120]})")
        return []

    picked = data.get("shorts") or []
    print(f"   beat-only: {len(picked)}개 쇼츠 (요청 {n}, beats {len(beats)}개)")

    # 검증 + 조립
    # 신호 백분위는 **회차 전체 beat 기준**이라 루프 밖에서 한 번만 계산한다.
    _sig_pct = beat_signal_percentiles(beats)
    if not any(v is not None for v in _sig_pct.values()):
        print("   (경고: beats 에 signals 없음 — score100 의 신호 축이 중립 0.5 로 고정된다. "
              "run_beat_signals 가 beats.json 에 병합했는지 확인)")
    shorts: list[dict] = []
    seen_combos: set = set()
    for idx, s in enumerate(picked):
        raw_ids = s.get("beat_ids") or []
        try:
            ids = sorted(int(x) for x in raw_ids)
        except (TypeError, ValueError):
            print(f"   (shorts #{idx} beat_ids 파싱 실패, 스킵)")
            continue
        ids = [i for i in ids if 0 <= i < len(beats)]
        if not ids:
            continue
        combo_key = tuple(ids)
        if combo_key in seen_combos:
            print(f"   (shorts #{idx} 중복 조합 {combo_key}, 스킵)")
            continue
        seen_combos.add(combo_key)

        picked_beats = [beats[i] for i in ids]
        sf_start = float(picked_beats[0]["start"])
        sf_end = float(picked_beats[-1]["end"])
        if sf_end <= sf_start:
            continue
        # ── 길이 하드 상한 (2026-08-25) ────────────────────────────────────────────
        #
        # ⚠️ 예전 이 자리엔 "서버측 duration 상·하한 없음 · 결정은 AI에 맡김" 이라고 적혀
        # 있었다(2026-07-27). 그 결과 **3분이 넘는 구간이 그대로 "숏폼" 추천으로 떴다** —
        # 상한은 프롬프트 문구뿐이었고, 아래 _deterministic_score 에는 길이 축이 아예 없어서
        # (_SCORE_W = signal·hook·closure) 과길이 후보가 **디랭크조차 되지 않았다.**
        # 길이는 취향이 아니라 물건의 정의다. 리포 원칙대로 결정론 코드가 지킨다.
        #
        # 자르는 방식이 중요하다. 임의 시각에서 하드컷하면 대사 중간이 잘리므로, **뽑힌 beat
        # 의 앞쪽 접두사**만 남긴다 — beat 은 편집자가 그대로 쓸 수 있는 완결 단위라 경계가
        # 이미 맞다. 첫 beat 하나가 이미 상한을 넘으면 그건 숏폼이 아니라 롱폼이다:
        # 후보에서 **제외**한다(가로형 클립은 build_clips_from_beats 가 따로 만든다).
        if sf_end - sf_start > MAX_SHORT_SEC:
            over = sf_end - sf_start
            fitted: list[int] = []
            for i in ids:                       # ids 는 오름차순 · beat 는 시간순 = 접두사
                if float(beats[i]["end"]) - sf_start > MAX_SHORT_SEC:
                    break
                fitted.append(i)
            if not fitted:
                print(f"   (shorts #{idx} 제외 — 첫 beat 하나가 이미 "
                      f"{float(beats[ids[0]]['end']) - sf_start:.0f}s > {MAX_SHORT_SEC}s "
                      f"· 숏폼이 아니라 롱폼이다: {str(s.get('title', ''))[:24]})")
                continue
            dropped = len(ids) - len(fitted)
            ids = fitted
            picked_beats = [beats[i] for i in ids]
            sf_end = float(picked_beats[-1]["end"])
            print(f"   (shorts #{idx} 길이 초과 {over:.0f}s → 뒷 beat {dropped}개 제외 · "
                  f"{sf_end - sf_start:.0f}s: {str(s.get('title', ''))[:24]})")
        title = (s.get("title") or "").strip() or (picked_beats[0].get("title") or "무제")
        # 두 줄 제목 (2026-07-29 사용자 요구): 라인1=setup 라인2=payoff · 라인2 컬러 강조.
        # 예: "헬스장 사장인 줄?" / "7년 차 한의사의 반전" (yellow)
        # 하드 컷: 라인당 최대 15자 · 넘으면 잘라냄 (LLM 이 프롬프트 무시하고 길게 뽑을 때 안전망).
        _MAX_LINE_LEN = 15
        title_line1 = (s.get("title_line1") or "").strip()
        title_line2 = (s.get("title_line2") or "").strip()
        if len(title_line1) > _MAX_LINE_LEN:
            title_line1 = title_line1[:_MAX_LINE_LEN].rstrip(" ,·.-") + "…"
        if len(title_line2) > _MAX_LINE_LEN:
            title_line2 = title_line2[:_MAX_LINE_LEN].rstrip(" ,·.-") + "…"
        # 컬러 고정: 파란색 (2026-07-29 사용자 요구 · AI 판단 불필요)
        title_line2_color = "blue"
        # 폴백: line1/2 없으면 title 로 자동 분할 (·|?|! 기준)
        if not (title_line1 and title_line2) and title:
            import re as _re_t
            m = _re_t.match(r"^(.+?[?!])\s+(.+)$", title)
            if m:
                title_line1 = title_line1 or m.group(1).strip()
                title_line2 = title_line2 or m.group(2).strip()
        # ⚠️ **beat 라벨이 먼저다.** 예전엔 LLM 응답(s["hook"])을 우선해서, 점수 지분이 가장
        # 큰 축이 실행마다 달라졌다(temperature 0.3 · enum 제약 없음) — "score100 은 결정론"
        # 이라는 전제가 거기서 깨져 있었다. LLM 값은 beat 에 라벨이 없을 때만 쓴다(표시용).
        hook = (picked_beats[0].get("hook") or s.get("hook") or "기타").strip()
        tags = [str(t).strip() for t in (s.get("tags") or []) if str(t).strip()]
        # characters: 조합된 beats의 union
        chars_set: list[str] = []
        for pb in picked_beats:
            for c in (pb.get("characters") or []):
                c = str(c).strip()
                if c and c not in chars_set:
                    chars_set.append(c)
        # summary: 각 beat summary를 이어붙여 근거로 명시 (grounded)
        reason = " · ".join((pb.get("summary") or "").strip() for pb in picked_beats if pb.get("summary"))

        # score100 은 **결정론**으로 계산한다 (2026-08-06). LLM 에게 점수를 물으면 같은
        # 입력에도 실행마다 달라져 A/B·회귀 판정이 불가능해진다. 예전 7/7/8 하드코딩은
        # 모든 쇼츠가 72.5 로 동일해 변별력이 아예 없었고, 그 사이 단계인 LLM 3축은
        # 재현성을 잃는다 — 둘 다 답이 아니라서 신호 기반으로 간다.
        # 첫 3초 훅 — 2단이다.
        #  1) LLM 이 "자극적인 대사" 로 고른 인용을 **전사에서 찾아** 그 시각을 쓴다.
        #  2) 못 찾으면(지어냈거나 심하게 의역) 쇼츠 안에서 데시벨이 가장 튀는 지점.
        # 사용자 의도가 "자극적이거나 데시벨 크거나 어그로 끌 만한 곳" 이라 둘 다 살린다.
        _hook_pick = _locate_quote(s.get("hook_quote") or "", sf_start, sf_end, transcript) \
            or _pick_hook_window(picked_beats, sf_start, sf_end, transcript)
        # starred_map 은 beat **인덱스** 키라 id 로 바꿔 넘긴다(점수는 id 로 판정한다).
        _starred_bids = {beats[i].get("id") for i in starred_map if 0 <= i < len(beats)}
        _score100, _score_parts = _deterministic_score(
            picked_beats, sf_end - sf_start, hook, _sig_pct, transcript, sf_end,
            starred_ids=_starred_bids)
        shorts.append({
            "type": "shortform",
            "start": sf_start,
            "end": sf_end,
            "title": title,
            "title_line1": title_line1,
            "title_line2": title_line2,
            "title_line2_color": title_line2_color,
            "reason": reason[:400],
            "story_synopsis": reason[:400],
            "why": (s.get("why") or "").strip()[:200],
            "appeal": _appeal_from_score100(_score100),
            "score100": _score100,
            "score_parts": _score_parts,  # 근거 — 점수만 있으면 왜 그런지 못 따진다
            "hook": hook,
            # 쇼츠 첫 3초 hook intro (2026-07-31 · docs/plans/shorts-hook-intro-3sec.md).
            # ⚠️ 예전엔 **Gemini 응답을 그대로 흘려보냈는데 모델이 안 채웠다** — 실측 산출물
            # 5개 중 hook_time_sec 이 0개라, 에디터의 "첫 3초 훅" 토글이 늘 비활성이었고
            # 렌더도 프리롤을 붙일 수 없었다(hookAvailable = hookTimeSec 존재 여부).
            # 이제 **시각은 항상 우리가 정한다**(_locate_quote → _pick_hook_window).
            # ⚠️ 여기에 모델의 `hook_time_sec` 를 다시 끼워 넣지 말 것 — 예전엔 LLM 값이
            # 뒤에 와서 우리 픽을 덮었고, 실측에서 20개 중 17개가 일률적으로 2.0 이었다
            # (= 훅이 본편 시작과 같은 그림 + 자막은 그 시각에 없는 말). 어디를 쓸지 고르는
            # 건 선별이라 LLM 몫이 아니다.
            **_hook_pick,
            "hook_intro_caption": (s.get("hook_intro_caption") or "").strip()[:40],
            "tags": tags,
            "characters": chars_set,
            "beat_ids": ids,
            "source": "beat_only",
        })
    return shorts


# ── 클립(롱폼) ────────────────────────────────────────────────────────────────
#
# 쇼츠와 클립은 **다른 물건**이다. 쇼츠는 한 장면의 펀치라인이고, 클립은 코너·주제 하나가
# 통째로 들어간 가로형 본편이다. 그래서 클립은 쇼츠를 길게 늘린 게 아니라 **beat 를 이어
# 붙여** 만든다 — beat 는 편집자가 그대로 쓸 수 있는 완결 단위라, 이어 붙이면 경계가 이미 맞다.
#
# 길이 기준 (사용자 확정 2026-08-16):
#   · 최소 3분 — 이보다 짧으면 '클립'이라 부를 물건이 아니다.
#   · 8분 이상이면 **유튜브 미드롤 광고**를 붙일 수 있다(2020-07 이후 기준. 그 전이 10분이라
#     10분으로 기억하는 경우가 많다). 수익화가 목적이면 여기를 노린다.
#   · 상한 15분 — 더 길면 회차 통짜에 가까워져 '클립'의 의미가 없다.
CLIP_MIN_SEC = 180.0
CLIP_MONETIZE_SEC = 480.0
CLIP_MAX_SEC = 900.0
#: beat 사이가 이보다 벌어지면 다른 코너로 본다(이어 붙이지 않는다).
CLIP_GAP_SEC = 45.0


def build_clips_from_beats(beats: list[dict], max_clips: int = 3,
                           sig_pct: dict | None = None) -> list[dict]:
    """인접 beat 를 이어 붙여 가로형 클립 후보를 만든다.

    **결정론**이다 — LLM 에 점수·순위를 맡기지 않는다(리포 원칙). 제목·요약은 이미
    beat annotate 가 붙여 둔 것을 쓰므로 새로 지어내는 hallucination 도 없다.

    쇼츠와 구간이 겹쳐도 괜찮다 — 8분짜리 코너 안에 30초 펀치라인이 들어 있는 것은
    정상이고, 둘은 서로 다른 배포처로 나간다.
    """
    ordered = sorted(
        [b for b in (beats or []) if isinstance(b, dict)
         and isinstance(b.get("start"), (int, float)) and isinstance(b.get("end"), (int, float))
         and float(b["end"]) > float(b["start"])],
        key=lambda b: float(b["start"]),
    )
    if not ordered:
        return []

    # 1) 끊기지 않고 이어지는 beat 묶음(런)으로 자른다.
    #
    # ⚠️ **길이 상한으로만 끊으면 클립이 아니라 '회차를 N등분한 것'이 된다.**
    # 실측(나는 SOLO · beat 298개 · 평균 6초): beat 이 촘촘해 45초 넘게 벌어지는 지점이
    # 거의 없어, 상한(15분)에 닿을 때까지 계속 붙어 14.7분·15.0분 두 덩어리가 나왔다.
    # 그래서 **조용한 지점에서 끊는다** — 오디오 신호가 낮은 beat 경계가 대개 장면 전환이다.
    # 데시벨을 점수뿐 아니라 **경계 결정**에도 쓰는 셈이다.
    runs: list[list[dict]] = []
    cur: list[dict] = []

    def _quiet_cut(run: list[dict]) -> int:
        """이 런을 어디서 끊을까 — 목표 길이 구간에서 가장 조용한 경계의 인덱스."""
        start = float(run[0]["start"])
        lo, hi = CLIP_MONETIZE_SEC, CLIP_MAX_SEC
        cands = [
            (sig_pct.get(b.get("id")) if sig_pct else None, i)
            for i, b in enumerate(run)
            if lo <= (float(b["end"]) - start) <= hi
        ]
        if not cands:
            return len(run)          # 목표 구간에 경계가 없다 — 통째로 둔다
        scored = [(v, i) for v, i in cands if isinstance(v, (int, float))]
        if not scored:
            return cands[len(cands) // 2][1] + 1   # 신호가 없으면 가운데에서 끊는다
        scored.sort(key=lambda x: (x[0], x[1]))    # 가장 조용한 곳 · 동점이면 앞쪽
        return scored[0][1] + 1

    for b in ordered:
        if not cur:
            cur = [b]
            continue
        gap = float(b["start"]) - float(cur[-1]["end"])
        span = float(b["end"]) - float(cur[0]["start"])
        if gap > CLIP_GAP_SEC:
            runs.append(cur)
            cur = [b]
        elif span > CLIP_MAX_SEC:
            at = _quiet_cut(cur)
            runs.append(cur[:at])
            cur = cur[at:] + [b]
        else:
            cur.append(b)
    if cur:
        runs.append(cur)

    # 2) 런에서 클립을 만든다. 최소 길이를 못 채우는 런은 버린다(억지로 늘리지 않는다).
    out: list[dict] = []
    for run in runs:
        start = float(run[0]["start"])
        end = float(run[-1]["end"])
        length = end - start
        if length < CLIP_MIN_SEC:
            continue
        titles = [str(b.get("title") or "").strip() for b in run]
        titles = [t for t in titles if t]
        summaries = [str(b.get("summary") or "").strip() for b in run]
        summaries = [s for s in summaries if s]
        chars: list[str] = []
        for b in run:
            for c in (b.get("characters") or []):
                c = str(c).strip()
                if c and c not in chars:
                    chars.append(c)
        hooks = [str(b.get("hook") or "").strip() for b in run if str(b.get("hook") or "").strip()]
        # 점수는 관측값만으로 만든다(LLM 점수 금지 · 리포 원칙). 축은 셋 — 미드롤 가능
        # 여부·구성 beat 수·등장 인물 수.
        #
        # 점수는 관측값만으로 만든다(LLM 점수 금지 · 리포 원칙).
        #
        # 신호(오디오 백분위 등)도 본다 — 안 보면 "조용한 8분"과 "웃음이 터지는 8분"이 같은
        # 점수를 받는다. 쇼츠가 쓰는 것과 **같은 축**이라 두 물건의 근거가 갈라지지 않는다.
        # 신호가 없는 회차(옛 분석·ffmpeg 실패)는 중립 0.5 로 둔다.
        sigs = [sig_pct.get(b.get("id")) for b in run] if sig_pct else []
        sigs = [s for s in sigs if isinstance(s, (int, float))]
        signal = sum(sigs) / len(sigs) if sigs else 0.5
        # ⚠️ 눈금은 **쇼츠와 같아야 한다.** 실측 분포는 드라마 69.8~85.6 · 예능 62.7~84.3 으로
        # **90점대가 나온 적이 없다**(search-highlight-replan-2026-08-06.md). 앞서 "쇼츠는
        # 90점대가 흔하다"를 전제로 클립을 70에서 시작시켰는데 전제가 실측과 반대였고, 그러면
        # 8분+ 클립이 95~100 이 되어 **top3 규칙에서 클립만 뽑힌다.** 같은 구간에 놓는다.
        # score80 = "미드롤 가능한 클립" 이라는 뜻은 유지된다(3분대 최대 75 · 8분+ 최소 82).
        monetizable = length >= CLIP_MONETIZE_SEC
        score = min(100, int(
            55
            + (15 if monetizable else 0)
            + round(15 * signal)          # 신호 — 조용한 구간과 터지는 구간을 가른다
            + min(5, len(run))
        ))
        out.append({
            "type": "clip",
            # 클립은 **가로형**이 기본이다(사용자 확정 2026-08-16) — 본편 화면비를 유지한다.
            "aspect": "16:9",
            "start": start,
            "end": end,
            "title": (titles[0] if titles else "무제 클립"),
            "reason": " / ".join(summaries[:3])[:400],
            "story_synopsis": " ".join(summaries[:5])[:600],
            "appeal": _appeal_from_score100(score),
            "score100": score,
            "hook": (hooks[0] if hooks else "기타"),
            "tags": [],
            "characters": chars,
            "beat_ids": [b.get("id") for b in run if b.get("id") is not None],
            "monetizable": monetizable,
            # 점수 근거 — 점수만 있으면 "왜 이게 1등인지" 를 못 따진다(쇼츠 score_parts 와 같은 이유).
            "score_parts": {"signal": round(signal, 4), "monetizable": monetizable,
                            "beats": len(run), "has_signals": bool(sigs)},
            "source": "beat_merge",
        })

    # 3) 긴 것·인물 많은 것 우선. 같은 구간이 여러 번 나가지 않게 겹치면 앞선 것만 남긴다.
    out.sort(key=lambda c: (-int(c["monetizable"]), -c["score100"], -(c["end"] - c["start"])))
    picked: list[dict] = []
    for c in out:
        if any(min(c["end"], p["end"]) - max(c["start"], p["start"]) > 0 for p in picked):
            continue
        picked.append(c)
        if len(picked) >= max_clips:
            break
    picked.sort(key=lambda c: c["start"])
    return picked


def _dedup_beat_overlap(shorts: list[dict], beats: list[dict]) -> list[dict]:
    """같은 beat 를 여러 shorts 에서 재사용 금지 (사용자 방향 2026-07-31: "beat 잘 못 합침").

    앞선 shorts 가 이미 쓴 beat_id 는 뒤 shorts 에서 제거 → 남은 beat 로 재구성.
    남은 beat 가 0개면 그 short drop. beat_ids 정리 후 start/end 도 재계산.
    """
    if not shorts or not beats:
        return shorts
    beat_by_id = {b.get("id"): b for b in beats}
    used: set = set()
    out: list[dict] = []
    for s in shorts:
        ids = list(s.get("beat_ids") or [])
        kept = [bid for bid in ids if bid not in used and bid in beat_by_id]
        if not kept:
            continue
        used.update(kept)
        # start/end 재계산 (kept 첫/마지막 beat)
        sorted_kept = sorted(kept, key=lambda bid: float(beat_by_id[bid].get("start", 0)))
        first = beat_by_id[sorted_kept[0]]
        last = beat_by_id[sorted_kept[-1]]
        s["beat_ids"] = sorted_kept
        s["start"] = float(first.get("start", 0))
        s["end"] = float(last.get("end", 0))
        s["_beat_dedup"] = True
        out.append(s)
    return out


def _enforce_shortform_length(shorts: list[dict], beats: list[dict],
                              max_sec: float = MAX_SHORT_SEC) -> list[dict]:
    """shortform 은 **무조건** duration <= max_sec. 뒷 beat 를 덜어 맞추고, 못 맞추면 **제외**.

    clip · highlight 는 스킵 (롱폼은 build_clips_from_beats 의 별도 길이 정책).

    ⚠️ 2026-08-25 사고: 이 함수는 **정의만 되고 아무도 부르지 않았다.** 그래서 프로덕션
    기본 경로인 beat-only 추천에는 길이 상한이 프롬프트 문구("총 span … 최대 2분")밖에
    없었고, 모델이 beat 을 많이 묶은 뒤 semantic closure(end +20s)·beat 경계 재스냅이
    더 늘리면서 **3분 넘는 "숏폼"** 이 추천 → 자동배포 → 게시까지 갔다.
    길이 같은 하드 제약은 프롬프트가 아니라 결정론 코드가 지킨다(리포 원칙).

    옛 구현의 구멍 두 개도 같이 막았다:
      · beat_ids 가 없는 short 는 그대로 통과했다 → 이제 start/end 로 하드컷한다.
      · **첫 beat 하나가 이미 max_sec 을 넘으면** 그 beat 을 통째로 남겼다(뒷 beat 만
        드롭하는 루프라 첫 beat 은 검사 대상이 아니었다) → 이제 후보에서 제외한다.

    이 함수는 **최종 관문**이다 — 1차 방어는 propose_shorts_beat_only 의 산출부에 있다.
    여기까지 상한 초과가 내려오면 그건 중간 단계(경계 스냅·확장) 어딘가가 늘린 것이므로,
    조용히 자르지 않고 로그를 남기고 뺀다.
    """
    if not shorts:
        return shorts
    beat_by_id = {b.get("id"): b for b in (beats or []) if isinstance(b, dict)}
    out: list[dict] = []
    for s in shorts:
        if s.get("type") != "shortform":
            out.append(s)
            continue
        try:
            st = float(s.get("start"))
            en = float(s.get("end"))
        except (TypeError, ValueError):
            continue
        if en <= st:
            continue
        if en - st <= max_sec:
            out.append(s)
            continue

        # 1) beat 단위로 뒤에서부터 덜어낸다 — 컷이 beat 경계에 남아야 대사 중간이 안 잘린다.
        ids = [bid for bid in (s.get("beat_ids") or []) if bid in beat_by_id]
        if ids:
            ids.sort(key=lambda bid: float(beat_by_id[bid].get("start", 0)))
            first = beat_by_id[ids[0]]
            st = float(first.get("start", st))
            kept = [ids[0]]
            cur_end = float(first.get("end", st))
            for bid in ids[1:]:
                nb_end = float(beat_by_id[bid].get("end", 0))
                if nb_end - st <= max_sec:
                    kept.append(bid)
                    cur_end = nb_end
                else:
                    break
            if cur_end > st:
                s["beat_ids"] = kept
                en = cur_end
        # 2) 그래도 넘으면(첫 beat 하나가 이미 max_sec 초과) **후보에서 제외**한다.
        #    임의 시각 하드컷은 "머리만 남은 롱폼" 을 만든다 — 숏폼이 아니다. 그런 구간은
        #    가로형 클립(build_clips_from_beats)의 몫이고, 쇼츠 보드에는 뜨면 안 된다.
        if en - st > max_sec:
            print(f"   (길이 상한 제외 {en - st:.0f}s > {max_sec:.0f}s: "
                  f"{str(s.get('title', ''))[:30]})")
            continue
        s["start"] = round(st, 3)
        s["end"] = round(en, 3)
        s["_length_capped"] = True
        out.append(s)
    return out


def _enforce_beat_alignment(shorts: list[dict], beats: list[dict],
                             tol_sec: float = 0.5) -> list[dict]:
    """계획서 5번 · beat 밖 자유 timestamp 금지.

    각 short 의 start/end 를 가장 가까운 beat 경계로 스냅 (tol_sec 이내).
    beat_ids 재계산 · short 이 span 하는 beat id 리스트. beat 하나에도 걸치지 않는
    short 는 drop (경계 완전 밖).
    """
    if not beats:
        return shorts
    edges = sorted({round(float(b["start"]), 3) for b in beats} |
                    {round(float(b["end"]), 3) for b in beats})
    id_by_start = {round(float(b["start"]), 3): b.get("id") for b in beats}
    id_by_end = {round(float(b["end"]), 3): b.get("id") for b in beats}

    def _snap(t: float) -> float:
        best = min(edges, key=lambda e: abs(e - t)) if edges else t
        return best if abs(best - t) <= tol_sec else t

    out: list[dict] = []
    for s in shorts:
        try:
            st = float(s.get("start")); en = float(s.get("end"))
        except (TypeError, ValueError):
            continue
        st2 = _snap(st); en2 = _snap(en)
        if en2 <= st2:
            continue
        # 이 span 이 걸치는 beats
        covered = [b for b in beats if float(b["end"]) > st2 and float(b["start"]) < en2]
        if not covered:
            continue  # beat 밖 · drop
        s["start"] = round(st2, 3)
        s["end"] = round(en2, 3)
        s["beat_ids"] = [b.get("id") for b in covered]
        s["beat_aligned"] = True
        out.append(s)
    return out


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
        # A) 숏폼: beat는 편집자가 정돈한 완결 퍼즐 조각이라 경계를 그대로 보존한다.
        # 다만 **길이 상한만은 예외**다 (2026-08-25). beat 은 45초에서 강제 분할되지만
        # (beats.py _force_split_large_beats) 화자 전환점이 없으면 원본이 유지되므로 3분
        # 넘는 beat 이 존재할 수 있고, 그게 그대로 "숏폼" 이 되던 게 이번 사고의 뿌리다.
        # ⚠️ 이 경로는 현재 호출부가 없다(_build_from_beats 미사용) — 되살릴 때를 위한 가드다.
        sf_start, sf_end = float(beat["start"]), float(beat["end"])
        if sf_end - sf_start > MAX_SHORT_SEC:
            print(f"   (시나리오 {sid} 숏폼 제외 — beat 이 {sf_end - sf_start:.0f}s "
                  f"> {MAX_SHORT_SEC}s · 롱폼이다)")
            sf_end = sf_start  # 아래 숏폼 생성 스킵 (클립 분기는 그대로 탄다)
        if sf_end > sf_start:
            # ⚠️ 이 경로(narrative_first 시나리오→beat 매칭)는 **3축 소스가 없다** —
            # _SCENARIOS_SCHEMA 에 축이 없어서다. 그래서 여기 score100 은 여전히 변별력이 없다.
            # 기본 경로는 propose_shorts_beat_only(축 있음)이므로 우선순위를 낮춰 둔다.
            # _axis_val 로 읽어두니 나중에 스키마에 축을 추가하면 코드 변경 없이 살아난다.
            derived = {
                "hook_strength": _axis_val(sc, "hook_strength", 7),
                "payoff": _axis_val(sc, "payoff", 7),
                "completeness": _axis_val(sc, "completeness", 8),
            }
            shorts.append({
                "type": "shortform",
                "start": sf_start, "end": sf_end,
                "title": (sc.get("story_title") or "").strip() or "무제",
                "reason": (sc.get("story_synopsis") or beat.get("summary") or "").strip(),
                "story_synopsis": (sc.get("story_synopsis") or "").strip(),
                **derived,
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
        # 위와 같음 — 이 경로는 3축 소스 없음(중립값). _axis_val 로 전방호환만 걸어둔다.
        derived = {
            "hook_strength": _axis_val(sc, "hook_strength", 7),
            "payoff": _axis_val(sc, "payoff", 7),
            "completeness": _axis_val(sc, "completeness", 8),
        }
        shorts.append({
            "type": "clip",
            "start": beat["start"], "end": beat["end"],
            "title": (beat.get("title") or sc.get("story_title") or "").strip() or "무제",
            "reason": (beat.get("summary") or sc.get("story_synopsis") or "").strip(),
            "story_synopsis": (beat.get("summary") or "").strip(),
            **derived,
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
    # 영상 길이에 비례한 목표 개수(10분당 3개·상한 20). 짧으면 자연히 작아지고, 아주 짧으면
    # 강제하지 않는다(아래 propose 프롬프트가 n<=2 이면 "완결되는 것만, 없으면 0" 으로 소프트).
    # 예전의 beat 밀도 뻥튀기(len//4)는 뺐다 — 6초 beat 이 촘촘한 짧은 영상을 부풀렸다.
    # 자기소개 누락 방지 커버리지는 개수가 아니라 프롬프트("전체를 훑어라")가 맡는다.
    n = _target_shorts_count(duration)

    if genre == "auto" or genre not in GENRE_PACKS:
        genre = detect_genre(client, scenes or []) if scenes else DEFAULT_GENRE
        print(f"   장르 감지: {genre} ({_pack(genre)['label']})")

    # === beats가 있으면 beat-only 경로 (2026-07-27 · 사용자 방향) ===
    # 오로지 beat 목록만 입력으로 shorts 생성. Phase A(scenarios) 완전 스킵으로
    # 시나리오 hallucination 원천 차단 (실측: "골프 회사원→배우 전향" 같은 없는 이야기 지어냄).
    if beats:
        print(f"   beat-only 모드: {len(beats)}개 beat만 입력, scenarios 스킵")
        if on_progress:
            on_progress(2, 3)
        shorts = propose_shorts_beat_only(
            client, beats, transcript, genre, n, cast_registry, profile,
        )
        # 계획서 5번 · beat 밖 자유 timestamp 금지. propose 산출을 강제 스냅.
        before = len(shorts)
        shorts = _enforce_beat_alignment(shorts, beats, tol_sec=0.5)
        if before != len(shorts):
            print(f"   beat alignment: {before}→{len(shorts)} (beat 밖 drop)")
        # semantic closure QA (2026-07-29 · 사용자 지적).
        # 기존 룰 기반 boundary snap 은 문장·발화·shot·침묵 4가지만 봄. 진짜 필요한 것은
        # "여기서 끊어도 안 어색한가" · 프레임까지 봐야 리액션·표정·씬전환 판단 가능.
        # 각 shorts 병렬 · Gemini multimodal 1콜 · end 조정 or 폐기.
        if shorts and transcript:
            print("   semantic closure QA (프레임+대사 · 병렬)...")
            shorts = refine_boundaries_semantic(
                client, shorts, transcript, duration,
                video_path=video_path,
            )
            # QA 가 end 조정한 뒤 다시 beat 경계로 재스냅 (자유 timestamp 방지)
            shorts = _enforce_beat_alignment(shorts, beats, tol_sec=1.0)
        # ⚠️ **길이 하드 상한 — 여기가 마지막 관문이다.** 위 semantic closure 는 end 를 최대
        # +20s 늘리고 _enforce_beat_alignment 는 그 끝을 beat 경계로 다시 벌린다. 그래서 상한은
        # 모든 확장이 끝난 뒤 한 번 더 걸어야 무력화되지 않는다 — chunk_scan 경로가 2026-08-20
        # 에 같은 이유로 "모든 확장 뒤 90초 재적용"(위 validate_shorts) 을 넣었는데,
        # beat-only 경로(프로덕션 기본)에는 그 짝이 없어서 3분 넘는 "숏폼" 이 그대로 나갔다.
        # transcript 가 없어 QA 를 건너뛴 회차에도 걸리도록 if 블록 **밖**에 둔다.
        before_cap = len(shorts)
        shorts = _enforce_shortform_length(shorts, beats)
        n_fitted = sum(1 for s in shorts if s.get("_length_capped"))
        n_dropped = before_cap - len(shorts)
        if n_fitted or n_dropped:
            print(f"   길이 상한({MAX_SHORT_SEC:.0f}s) 최종 관문: "
                  f"{n_fitted}개 beat 축소 · {n_dropped}개 제외")
        # 사후 조건 — 여기를 지난 쇼츠에 상한 초과는 **하나도 없다**. 스테이지가 늘어나도
        # 이 줄이 깨지면 바로 보인다(조용히 통과하던 게 이 사고의 본질이었다).
        _over = [x for x in shorts
                 if x.get("type") == "shortform"
                 and float(x.get("end", 0)) - float(x.get("start", 0)) > MAX_SHORT_SEC + 1e-6]
        assert not _over, (
            f"숏폼 길이 상한 위반이 최종 관문을 통과했다: "
            f"{[(round(float(x['end']) - float(x['start']), 1), str(x.get('title', ''))[:20]) for x in _over]}")
        if on_progress:
            on_progress(3, 3)
        def type_order_new(s: dict) -> int:
            return {"shortform": 0, "clip": 1, "highlight": 2}.get(s.get("type", ""), 9)
        shorts.sort(key=lambda s: (type_order_new(s), -s.get("score100", 0), float(s.get("start", 0))))
        type_rank_counter: dict = {}
        for s in shorts:
            t = s.get("type", "unknown")
            type_rank_counter[t] = type_rank_counter.get(t, 0) + 1
            s["rank"] = type_rank_counter[t]
        if shorts:
            shorts = apply_profile_fit(shorts, profile, duration)
            try:
                from core.common.channels import apply_channel_fit
                shorts = apply_channel_fit(shorts, scenes or [], channels)
            except Exception as e:
                print(f"   (채널 적합 건너뜀: {str(e)[:80]})")
        # 클립(롱폼·가로형)은 **쇼츠 파이프라인을 태우지 않는다** — 위 정렬·프로파일 적합은
        # 전부 쇼츠 길이를 전제로 한 손잡이라, 8분짜리를 거기 넣으면 길이 페널티로 죽는다.
        # beat 를 이어 붙여 따로 만들고 뒤에 붙인다.
        # 쇼츠와 **같은 신호축**을 넘긴다 — 두 물건이 다른 근거로 뽑히면 비교가 성립하지 않는다.
        clips = build_clips_from_beats(beats, sig_pct=beat_signal_percentiles(beats))
        for i, c in enumerate(clips, 1):
            c["rank"] = i
        if clips:
            mon = sum(1 for c in clips if c.get("monetizable"))
            print(f"   클립 {len(clips)}개 (가로형 · 미드롤 가능 {mon}개)")
        return {"genre": genre, "shorts": shorts + clips, "mode": "beat_only",
                "beats_count": len(beats)}

    # === Fallback (beats 없을 때): 기존 Phase A→B 경로 ===
    if on_progress:
        on_progress(1, 3)
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
    shorts.sort(key=lambda s: (type_order(s), -s.get("score100", 0), float(s.get("start", 0))))
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
            from core.common.channels import apply_channel_fit
            shorts = apply_channel_fit(shorts, scenes or [], channels)
        except Exception as e:
            print(f"   (채널 적합 건너뜀: {str(e)[:80]})")

    return {"genre": genre, "shorts": shorts, "mode": "narrative_first",
            "scenarios_count": len(scenarios),
            "total_variations": sum(len(r.get("variations", [])) for r in variations)}


if __name__ == "__main__":
    main()

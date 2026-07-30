"""
STEP D Core — 시청자 댓글 → viewer_signals 추출 (2026-07-28)

원본 롱폼 유튜브 영상의 상위 좋아요 댓글에서 "어느 순간이 반응이 좋았는지·시청자가
어떤 감정이었는지·무엇을 더 원하는지"를 뽑아 recommend 프롬프트에 컨텍스트로 주입한다.
recommend.py `_profile_block`이 이미 `profile.get("viewer_signals")`를 읽어 프롬프트에
녹이게 돼 있어, 이 모듈은 그 dict를 만들어 profile에 병합하는 역할만 한다.

입력: content-pipeline이 work/comments.json으로 뽑아 놓은 원본 댓글 리스트
      ({author,text,likeCount,publishedAt} 형태, likeCount DESC 정렬 · 상위 100개)
출력 스키마 (recommend.py _profile_block과 정합):
  {
    "top_moments":         [[text, likes], ...],       # 시청자가 지목한 대표 순간
    "explicit_timestamps": [{"mmss":"1:23","likes":45}, ...],  # 댓글에 박힌 시간 언급
    "dominant_emotion":    "…",                        # 지배 감정 (한 단어~짧은 구)
    "top_demands":         [[text, likes], ...],       # 시청자 상위 요청
  }

전략: 정규식 룰(타임스탬프·상위 좋아요)로 결정론적 신호를 먼저 뽑고, Gemini 한 번으로
top_moments/dominant_emotion/top_demands를 요약. Gemini 실패해도 룰 신호만으로 fallback.
"""
import json
import os
import re
import sys
from pathlib import Path

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
from .models import COMMENT_SIGNAL as MODEL

MAX_COMMENTS = 100        # Gemini 프롬프트에 담는 상한 (likeCount DESC 기준 상위)
MAX_TS_PER_COMMENT = 3    # 한 댓글에서 뽑는 타임스탬프 최대 개수
MAX_EXPLICIT_TS = 8       # 최종 explicit_timestamps 상한 (좋아요 순)

# "3:24", "1:03:45", "3분 24초" — 세 형태만 인정. 잘못 매칭되는 걸 줄이려 좁게.
_TS_COLON_RE = re.compile(r"(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])")
_TS_KOR_RE = re.compile(r"(\d{1,3})\s*분\s*(\d{1,2})\s*초")


def _to_seconds(h_or_m: int, m_or_s: int, s: int | None) -> int:
    """1:23 → 83s, 1:02:03 → 3723s. s가 None이면 앞 두 값을 (분,초)로 해석."""
    if s is None:
        return h_or_m * 60 + m_or_s
    return h_or_m * 3600 + m_or_s * 60 + s


def _extract_timestamps(text: str) -> list[tuple[str, int]]:
    """댓글 텍스트에서 (mmss_display, seconds) 페어 추출. 한 댓글에 여러 개면 상한까지만."""
    out: list[tuple[str, int]] = []
    seen: set[int] = set()
    for m in _TS_COLON_RE.finditer(text):
        a, b, c = int(m.group(1)), int(m.group(2)), (int(m.group(3)) if m.group(3) else None)
        secs = _to_seconds(a, b, c)
        if secs in seen or secs <= 0:
            continue
        seen.add(secs)
        out.append((m.group(0), secs))
        if len(out) >= MAX_TS_PER_COMMENT:
            return out
    for m in _TS_KOR_RE.finditer(text):
        secs = int(m.group(1)) * 60 + int(m.group(2))
        if secs in seen or secs <= 0:
            continue
        seen.add(secs)
        # "3분 24초"는 그대로 담아두면 프롬프트에서 길어져 mmss 표기로 통일.
        out.append((f"{secs // 60}:{secs % 60:02d}", secs))
        if len(out) >= MAX_TS_PER_COMMENT:
            return out
    return out


def _rule_signals(comments: list[dict], duration_sec: float | None) -> dict:
    """룰만으로 만드는 신호 — Gemini 실패해도 이 정도는 무조건 나온다."""
    # likeCount 정렬은 이미 상위 우선으로 들어온다고 가정하되, 방어적으로 재정렬.
    ordered = sorted(comments, key=lambda c: int(c.get("likeCount") or 0), reverse=True)

    # explicit_timestamps: 좋아요 순으로 훑어 상한까지 담고, 영상 길이 넘어가면 폐기.
    dur_cap = int(duration_sec) if duration_sec and duration_sec > 0 else None
    ts_out: list[dict] = []
    ts_seen: set[int] = set()
    for c in ordered:
        text = str(c.get("text") or "")
        if not text:
            continue
        likes = int(c.get("likeCount") or 0)
        for mmss, secs in _extract_timestamps(text):
            if secs in ts_seen:
                continue
            if dur_cap and secs > dur_cap + 60:  # +60s 여유 (엔딩 크레딧 등 언급 관용)
                continue
            ts_seen.add(secs)
            ts_out.append({"mmss": mmss, "likes": likes})
            if len(ts_out) >= MAX_EXPLICIT_TS:
                break
        if len(ts_out) >= MAX_EXPLICIT_TS:
            break

    # top_moments 폴백: 상위 5개 좋아요 댓글 원문 (길이 제한).
    top_moments: list[list] = []
    for c in ordered[:5]:
        text = str(c.get("text") or "").strip().replace("\n", " ")
        if not text:
            continue
        top_moments.append([text[:80], int(c.get("likeCount") or 0)])

    return {
        "top_moments": top_moments,
        "explicit_timestamps": ts_out,
        "dominant_emotion": "",
        "top_demands": [],
    }


SYSTEM = """너는 유튜브 영상의 상위 댓글들을 분석해서 시청자 반응을 요약하는 분석가다.
입력은 좋아요 순으로 정렬된 댓글 목록. 이걸 보고 다음 3가지를 뽑는다:

1. top_moments: 시청자가 특히 지목한 순간·장면·발언 3~5개. 각 원문 인용은 짧게(50자 이내).
   여러 댓글이 같은 순간을 언급하면 하나로 합쳐라. likes는 대표 댓글의 좋아요 수.
2. dominant_emotion: 댓글 톤 전체를 한 단어~짧은 구로 (예: "폭소", "감동", "몰입", "논쟁", "실망").
   여러 감정이 섞이면 가장 지배적인 것 하나만.
3. top_demands: 시청자가 명시적으로 원하는 것 (더 보고 싶다·다음 편·특정 인물 등장 등) 0~3개.
   요청이 없으면 빈 배열. 각 원문은 40자 이내.

원본에 없는 걸 지어내지 마라. 원문 인용은 오탈자 있어도 그대로 두되 이모지·연속 자모는 정리해라.
Return ONLY a valid JSON object. No prose, no code fences."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "top_moments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "text": {"type": "STRING"},
                    "likes": {"type": "INTEGER"},
                },
                "required": ["text", "likes"],
            },
        },
        "dominant_emotion": {"type": "STRING"},
        "top_demands": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "text": {"type": "STRING"},
                    "likes": {"type": "INTEGER"},
                },
                "required": ["text", "likes"],
            },
        },
    },
    "required": ["top_moments", "dominant_emotion", "top_demands"],
}


def _gemini_summarize(comments: list[dict]) -> dict | None:
    """상위 댓글을 Gemini에게 한 번 던져 top_moments/dominant_emotion/top_demands 를 뽑는다.
    실패 시 None (호출부는 룰 폴백 사용)."""
    if not comments:
        return None
    # 좋아요 순 상위 N만 사용. author는 신호 아님 → 프롬프트에서 제거해 토큰 절약.
    ordered = sorted(comments, key=lambda c: int(c.get("likeCount") or 0), reverse=True)[:MAX_COMMENTS]
    lines: list[str] = []
    for i, c in enumerate(ordered, 1):
        text = str(c.get("text") or "").strip().replace("\n", " ")
        if not text:
            continue
        likes = int(c.get("likeCount") or 0)
        lines.append(f"[{i}] ({likes}❤) {text[:220]}")
    if not lines:
        return None
    prompt = "다음은 이 영상의 상위 좋아요 댓글이다. 위 지시대로 JSON을 반환하라.\n\n" + "\n".join(lines)

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    def _call():
        return client.models.generate_content(
            model=MODEL,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM,
                temperature=0,
                response_mime_type="application/json",
                response_schema=SCHEMA,
            ),
        )

    try:
        resp = call_with_retry(_call, attempts=3, base_delay=2.0, timeout=90.0)
        raw = (resp.text or "").strip()
        if not raw:
            return None
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"   (comment_signal Gemini JSON 파싱 실패, 룰만 사용: {str(e)[:80]})", flush=True)
        return None
    except Exception as e:
        print(f"   (comment_signal Gemini 호출 실패, 룰만 사용: {str(e)[:80]})", flush=True)
        return None


def build_viewer_signals(
    comments: list[dict] | None,
    duration_sec: float | None = None,
) -> dict:
    """댓글 리스트 → viewer_signals dict. 항상 dict를 돌려주되 신호 없으면 빈 값들.

    duration_sec을 주면 영상 길이를 초과하는 타임스탬프(예: 다른 영상 시간 언급)를 걸러낸다.
    Gemini 실패해도 룰 기반 signal은 유지된다 (부분 성공 원칙).
    """
    if not comments:
        return {"top_moments": [], "explicit_timestamps": [], "dominant_emotion": "", "top_demands": []}

    rule = _rule_signals(comments, duration_sec)
    llm = _gemini_summarize(comments)

    if not llm:
        return rule  # 룰만으로도 explicit_timestamps + 상위 좋아요 top_moments 폴백은 있음

    # Gemini가 준 top_moments/top_demands를 (text,likes) 페어 리스트로 변환.
    def _to_pairs(items) -> list[list]:
        out: list[list] = []
        if not isinstance(items, list):
            return out
        for it in items:
            if not isinstance(it, dict):
                continue
            text = str(it.get("text") or "").strip()
            if not text:
                continue
            try:
                likes = int(it.get("likes") or 0)
            except (TypeError, ValueError):
                likes = 0
            out.append([text[:80], likes])
        return out

    return {
        "top_moments": _to_pairs(llm.get("top_moments")) or rule["top_moments"],
        "explicit_timestamps": rule["explicit_timestamps"],  # 룰이 정답 — Gemini에게 맡기지 않음
        "dominant_emotion": str(llm.get("dominant_emotion") or "").strip(),
        "top_demands": _to_pairs(llm.get("top_demands")),
    }


def main() -> None:
    """단독 실행: python -m core.comment_signal <comments.json> [--out viewer_signals.json] [--duration N]"""
    if len(sys.argv) < 2:
        print("Usage: python -m core.comment_signal <comments.json> [--out <viewer_signals.json>] [--duration <sec>]")
        sys.exit(1)
    src = Path(sys.argv[1])
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else src.with_name("viewer_signals.json")
    duration = float(sys.argv[sys.argv.index("--duration") + 1]) if "--duration" in sys.argv else None

    comments = json.loads(src.read_text(encoding="utf-8"))
    signals = build_viewer_signals(comments, duration_sec=duration)
    out.write_text(json.dumps(signals, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ {len(comments)} 댓글 → {out}")
    print(f"  moments {len(signals['top_moments'])} · timestamps {len(signals['explicit_timestamps'])}"
          f" · emotion '{signals['dominant_emotion']}' · demands {len(signals['top_demands'])}")


if __name__ == "__main__":
    main()

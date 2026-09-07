"""
STEP D Core — 한국어 자막 → 대상 언어 번역 (다국어 배포용)

`translate.py` 와 **방향이 반대**다. 저쪽은 외국인 출연자의 외국어 발화를 한국어로 끌어와
본편 자막을 한국어로 통일하는 것이고(2026-08-25), 이쪽은 완성된 한국어 자막을 해외 배포용
언어로 내보내는 것이다(2026-09-07 · 1차 대상 베트남어).

두 가지가 결정적으로 다르다:

1. **원본을 치환하지 않는다.** 한국어 자막은 계속 나가야 하므로 `refined.json` 은 그대로 두고
   `refined.{lang}.json` 을 따로 낳는다. 소비처(번인·캡션트랙·검색)가 언어를 골라 읽는다.
2. **길이가 품질을 좌우한다.** 자막 번역은 문서 번역과 달리 노출 시간이 고정돼 있다.
   한국어→베트남어는 같은 뜻이 표시폭 1.75배가 되는 게 실측이라(문서 §3.5-4), 줄마다
   허용 글자수를 계산해 프롬프트에 박는다. 이걸 안 하면 9:16 화면에서 2줄이 3줄로 넘친다.

공통점은 유지한다 — 배치 번호 매김, 잘린 JSON 복구, 실패 시 원문 유지, 재실행 안전.
`words`(카라오케 토큰)는 원문 타이밍이라 번역문과 안 맞으므로 넣지 않는다.
렌더는 words 가 없으면 synthesizeWords 로 텍스트에서 합성한다(index.ts:4973).
"""
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

# Windows consoles default to cp949 and crash on non-Latin/emoji output.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from core.common.retry import call_with_retry
from core.common.models import TRANSLATE as MODEL

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
# Seoul — 자막에 개인정보가 실릴 수 있어 국내에서 처리한다 (translate.py 와 같은 이유).
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
BATCH = int(os.environ.get("TRANSLATE_OUT_BATCH") or 60)
WORKERS = int(os.environ.get("TRANSLATE_OUT_WORKERS") or 2)


class Lang:
    """대상 언어 하나의 규격.

    `width_em` 은 그 언어 글자 하나의 평균 표시폭(em)이다 — 폰트에서 실측한 값을 쓴다.
    베트남어 0.585 는 Pretendard-ExtraBold hmtx 실측(성조 소문자 45자 평균).
    이 값으로 "한국어 원문과 같은 폭에 들어가는 글자수"를 계산해 번역 길이를 묶는다.
    """

    def __init__(self, code: str, name_ko: str, name_en: str, width_em: float, screen_chars: int):
        self.code = code
        self.name_ko = name_ko
        self.name_en = name_en
        self.width_em = width_em
        # 한 화면에 들어가는 글자수 — 서버 caption-lang.ts 의 captionMaxChars 와 같은 값.
        self.screen_chars = screen_chars


# 지원 언어. 추가할 때 width_em 은 **폰트에서 실측**할 것 — 짐작하면 자막이 넘치거나 짧아진다.
LANGS: dict[str, Lang] = {
    "vi": Lang("vi", "베트남어", "Tiếng Việt", 0.585, 16),
}

_HANGUL_SYL = re.compile(r"[가-힣]")


def _width_em(text: str) -> float:
    """한국어 원문의 표시폭(em) 근사 — 서버 charWidthEm(index.ts:4779)의 축약판.

    목표는 픽셀 정확도가 아니라 "번역문이 원문과 비슷한 폭인가" 이므로 클래스 평균으로 뭉갠다.
    """
    w = 0.0
    for ch in text:
        c = ord(ch)
        if ch == " ":
            w += 0.224
        elif 0xAC00 <= c <= 0xD7A3 or 0x3131 <= c <= 0x318E:
            w += 0.864                      # 한글
        elif 0x41 <= c <= 0x5A:
            w += 0.76                       # A-Z
        elif 0x61 <= c <= 0x7A:
            w += 0.55                       # a-z
        elif 0x30 <= c <= 0x39:
            w += 0.68                       # 0-9
        elif ch in ".,·:;!'|?":
            w += 0.3
        elif c < 0x80:
            w += 0.5
        else:
            w += 0.9
    return w


def _max_chars(text: str, lang: Lang) -> int:
    """원문과 같은 표시폭에 들어가는 대상 언어 글자수.

    하한은 **한 화면 글자수**다. 그보다 좁게 주는 건 모순이다 — 화면에 16자가 들어가는데
    12자로 조이면 모델이 뜻을 깎아내고도 초과한다(실측 2026-09-07: 초과가 짧은 줄에 몰렸다).
    짧은 자막은 어차피 화면에 여유가 있으므로 한 화면까지는 허용한다.

    반대로 원문이 이미 여러 화면이면 예산도 그만큼 커진다 — 원문이 2줄인데 번역만 1줄로
    욱여넣게 하면 정보가 사라진다. 목표는 "번역해도 **화면 수가 늘지 않는 것**" 이다.
    """
    return max(lang.screen_chars, round(_width_em(text) / lang.width_em))


def _system(lang: Lang, cast: list[str]) -> str:
    names = ", ".join(cast[:20])
    cast_rule = (
        f"- 다음 고유명사는 **번역하지 말고 원문 그대로** 둔다: {names}\n"
        if names else
        "- 인명·프로그램명 같은 고유명사는 번역하지 말고 원문 그대로 둔다.\n"
    )
    return f"""너는 한국 예능·방송 자막을 {lang.name_ko}로 옮기는 자막 번역가다.
입력은 번호 매겨진 한국어 방송 자막 줄들이며, 각 줄 앞에 [≤N자] 로 **허용 글자수**가 붙어 있다.

- 화면에 박히는 자막이다. 노출 시간이 정해져 있으므로 **[≤N자] 를 반드시 지킨다.**
  넘칠 것 같으면 수식어를 버리고 핵심만 남긴다 — 길이가 정확성보다 우선이다.
- 구어체 방송 자막답게 짧고 자연스럽게. 문어체·직역 금지.
- 예능의 말맛(놀람·과장·리액션)은 {lang.name_ko}에서 자연스러운 표현으로 **옮긴다**.
  한국어 표현을 직역해 어색해지느니 그 나라 시청자가 쓰는 말로 바꾼다.
{cast_rule}- 자막 부호(…, ?!)는 원문 느낌을 살리되 남발하지 않는다.
- 번역할 수 없는 줄(의미 불명 파편)은 빈 문자열("")로 둔다.

출력은 JSON 배열만: [{{"n": <번호>, "t": "<{lang.name_ko} 번역>"}}, ...]"""


def _client() -> "genai.Client":
    return genai.Client(vertexai=True, project=PROJECT, location=LOCATION)


def _parse_json_array_recover(s: str) -> list:
    """translate.py 와 같은 관용구 — 잘린 JSON 배열 복구."""
    s = (s or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    try:
        v = json.loads(s)
        return v if isinstance(v, list) else []
    except json.JSONDecodeError:
        pass
    last = s.rfind("}")
    if last > 0:
        try:
            v = json.loads(s[: last + 1] + "]")
            return v if isinstance(v, list) else []
        except json.JSONDecodeError:
            pass
    last_bracket = s.rfind("]")
    if last_bracket > 0:
        try:
            v = json.loads(s[: last_bracket + 1])
            return v if isinstance(v, list) else []
        except json.JSONDecodeError:
            pass
    return []


def translate_out(
    segments: list[dict],
    lang_code: str,
    cast: list[str] | None = None,
) -> tuple[list[dict], int]:
    """한국어 세그먼트를 대상 언어로 옮긴 **새 배열**을 만든다. (결과, 번역 건수).

    입력 `segments` 는 mutate 하지 않는다 — 한국어 자막은 그대로 나가야 한다.
    타임스탬프·speaker 는 원문 그대로 승계한다(렌더가 같은 구간에 얹을 수 있어야 한다).
    번역이 비거나 실패한 줄은 **한국어 원문을 남긴다** — 자막이 통째로 사라지는 것보다 낫고,
    translate.py 의 degrade 방향(실패 시 원문 유지)과 같다.
    """
    lang = LANGS.get(lang_code)
    if lang is None:
        raise ValueError(f"지원하지 않는 언어: {lang_code} (지원: {', '.join(LANGS)})")

    out: list[dict] = []
    for s in segments:
        seg = {k: v for k, v in s.items() if k != "words"}
        seg["text_ko"] = s.get("text")
        seg["lang"] = lang.code
        out.append(seg)

    targets = [i for i, s in enumerate(out) if str(s.get("text") or "").strip()]
    if not targets:
        return out, 0

    client = _client()
    system = _system(lang, cast or [])
    total_batches = (len(targets) + BATCH - 1) // BATCH
    print_lock = Lock()
    done = {"n": 0}
    ok_count = {"n": 0}

    def _do_batch(b: int) -> bool:
        idxs = targets[b * BATCH:(b + 1) * BATCH]
        # 로컬 넘버링(1..N) — 모델이 전역 오프셋을 무시하고 1부터 세는 문제 회피(translate.py 와 동일).
        lines = []
        for j, i in enumerate(idxs):
            text = str(out[i]["text"])
            lines.append(f"{j + 1}. [≤{_max_chars(text, lang)}자] {text}")
        numbered = "\n".join(lines)
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=MODEL,
                contents=numbered,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.3,
                    response_mime_type="application/json",
                ),
            ))
            rows = _parse_json_array_recover(resp.text or "")
            by_n: dict[int, str] = {}
            for r in rows:
                try:
                    by_n[int(r["n"])] = str(r.get("t") or "").strip()
                except (KeyError, TypeError, ValueError):
                    continue
            for j, i in enumerate(idxs):
                t = by_n.get(j + 1)
                if not t:
                    continue  # 빈 번역·누락 → 한국어 원문 유지
                out[i]["text"] = t
                with print_lock:
                    ok_count["n"] += 1
            with print_lock:
                done["n"] += 1
                print(f"   translate_out[{lang.code}] batch {done['n']}/{total_batches} ({len(idxs)} 줄)")
            return True
        except Exception as e:
            with print_lock:
                done["n"] += 1
                print(f"   (translate_out[{lang.code}] batch {b} failed, kept Korean: {str(e)[:120]})")
            return False

    failed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed([ex.submit(_do_batch, b) for b in range(total_batches)]):
            if not fut.result():
                failed += 1

    # translate.py 와 같은 원칙: 대부분 실패면 체크포인트에 굳히지 말고 잡 재시도로 넘긴다.
    if failed > total_batches * 0.5:
        raise RuntimeError(
            f"translate_out[{lang.code}]: {failed}/{total_batches} batches failed — "
            "failing so the job retries instead of baking Korean into the checkpoint"
        )
    return out, ok_count["n"]


def load_existing(out_dir: Path, lang_code: str, expect_n: int) -> list[dict] | None:
    """이미 만들어 둔 번역이 있고 세그먼트 수가 맞으면 그대로 쓴다 (체크포인트 재개 시 0 콜)."""
    p = Path(out_dir) / f"refined.{lang_code}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(data, list) and len(data) == expect_n:
        return data
    return None

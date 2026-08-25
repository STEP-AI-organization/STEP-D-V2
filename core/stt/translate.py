"""
STEP D Core — 외국어 자막 한국어 번역 (STT post-processing)

예능에 외국인 출연자가 나오면 STT(Soniox)가 들리는 그대로 중국어·영어·일본어로 받아
적는다. 그 텍스트가 그대로 번인 자막·훅·검색까지 흘러가므로, 트랜스크립트 확정 직전에
외국어 세그먼트만 골라 한국어로 번역해 치환한다(사용자 2026-08-25).

- 표기: 방송 관행대로 번역문을 괄호로 감싼다 — "(한 입 먹어 보세요)". 시청자가
  "출연자의 외국어 발화를 옮긴 것"임을 알 수 있는 최소 표기다.
- 원문은 `text_orig` 로 보존한다 (세그먼트 dict 는 JSONB verbatim 으로 DB 까지 통과).
- `words`(카라오케 토큰)는 외국어 원문 타이밍이라 번역문과 안 맞으므로 제거한다 —
  렌더는 words 가 없으면 synthesizeWords 로 텍스트에서 타이밍을 합성한다(index.ts:4787).
- 감지는 결정론(문자 스크립트 비율), 번역만 LLM — 어떤 줄을 건드릴지는 매번 같다.
- 이미 번역된 세그먼트(`translated` 플래그)와 한국어 줄은 건너뛰므로 재실행 안전
  (체크포인트 재개 시 refined.json 이 이미 번역돼 있어도 0 콜).
"""
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
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
# Seoul — transcripts can carry personal info; keep processing in-country (data residency).
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
BATCH = int(os.environ.get("TRANSLATE_BATCH") or 80)
TRANSLATE_WORKERS = int(os.environ.get("TRANSLATE_WORKERS") or 2)

_HANGUL = re.compile(r"[가-힣ㄱ-ㅎㅏ-ㅣ]")
_HAN = re.compile(r"[一-鿿㐀-䶿]")      # 한자 (중국어 — 한국 STT 자막에선 사실상 안 나옴)
_KANA = re.compile(r"[぀-ヿ]")                    # 히라가나·가타카나
_LATIN = re.compile(r"[A-Za-z]")


def is_foreign(text: str) -> bool:
    """이 줄이 '외국어 발화를 그대로 받아 적은 것'인가 — 결정론 판정.

    - 한자·가나가 한글보다 많으면 외국어 (혼합줄 "好, 먹읍시다" 는 한글 우세라 보존).
    - 한글이 전혀 없고 라틴 문자가 8자 이상이면 영어 문장으로 본다
      ("OK"·"MC"·브랜드명 같은 짧은 삽입은 보존).
    """
    if not text:
        return False
    hangul = len(_HANGUL.findall(text))
    cjk_foreign = len(_HAN.findall(text)) + len(_KANA.findall(text))
    if cjk_foreign >= 2 and cjk_foreign > hangul:
        return True
    if hangul == 0 and len(_LATIN.findall(text)) >= 8:
        return True
    return False


SYSTEM = """너는 한국어 방송 자막 번역가다.
입력은 예능/방송의 자동 음성 인식(STT) 결과 중 외국어(중국어·영어·일본어 등)로 받아 적힌
번호 매겨진 자막 줄들이다. 각 줄을 자연스러운 한국어 방송 자막으로 번역한다.

- 구어체로, 방송 자막답게 짧고 자연스럽게 번역한다 (문어체·직역 금지).
- 반말/존댓말은 원문 어감을 따른다.
- 줄에 한국어가 일부 섞여 있으면 그 부분은 그대로 두고 외국어 부분만 번역해 잇는다.
- 번역할 수 없는 줄(의미 불명 파편)은 빈 문자열("")로 둔다.

출력은 JSON 배열만: [{"n": <번호>, "ko": "<한국어 번역>"}, ...]"""


def _client() -> "genai.Client":
    return genai.Client(vertexai=True, project=PROJECT, location=LOCATION)


def _parse_json_array_recover(s: str) -> list:
    """refine._parse_json_array_recover 와 같은 관용구 — 잘린 JSON 배열 복구."""
    import json

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


def translate_segments(segments: list[dict]) -> tuple[list[dict], int]:
    """외국어 세그먼트의 `text` 를 "(한국어 번역)" 으로 치환해 반환. (결과 리스트, 번역 건수).

    타임스탬프·speaker 는 절대 건드리지 않는다(refine 과 같은 계약). 실패한 배치는 원문
    유지 — 지금 프로덕션 동작(외국어 그대로)과 같으므로 안전한 방향의 degrade 다.
    """
    out = [dict(s) for s in segments]
    targets = [
        i for i, s in enumerate(out)
        if not s.get("translated") and is_foreign(str(s.get("text") or ""))
    ]
    if not targets:
        return out, 0

    client = _client()
    total_batches = (len(targets) + BATCH - 1) // BATCH
    print_lock = Lock()
    done_counter = {"n": 0}
    translated_counter = {"n": 0}

    def _do_batch(b: int) -> bool:
        idxs = targets[b * BATCH:(b + 1) * BATCH]
        # 로컬 넘버링(1..N) — refine 과 같은 이유: 모델이 전역 오프셋을 무시하고 1부터 센다.
        numbered = "\n".join(f"{j + 1}. {out[i]['text']}" for j, i in enumerate(idxs))
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=MODEL,
                contents=numbered,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM,
                    temperature=0.2,
                    response_mime_type="application/json",
                ),
            ))
            rows = _parse_json_array_recover(resp.text or "")
            by_n: dict[int, str] = {}
            for r in rows:
                try:
                    by_n[int(r["n"])] = str(r.get("ko") or "").strip()
                except (KeyError, TypeError, ValueError):
                    continue
            for j, i in enumerate(idxs):
                ko = by_n.get(j + 1)
                if not ko:
                    continue  # 빈 번역·누락 → 원문 유지
                seg = out[i]
                seg["text_orig"] = seg.get("text")
                # 이미 괄호로 감싼 번역이 오면 이중 괄호를 피한다.
                seg["text"] = ko if (ko.startswith("(") and ko.endswith(")")) else f"({ko})"
                seg["translated"] = True
                seg.pop("words", None)  # 외국어 타이밍 토큰 — 렌더가 텍스트에서 합성하게 둔다
                with print_lock:
                    translated_counter["n"] += 1
            with print_lock:
                done_counter["n"] += 1
                print(f"   translate batch {done_counter['n']}/{total_batches} ({len(idxs)} 줄)")
            return True
        except Exception as e:
            with print_lock:
                done_counter["n"] += 1
                print(f"   (translate batch {b} failed, kept original: {str(e)[:120]})")
            return False

    failed = 0
    with ThreadPoolExecutor(max_workers=TRANSLATE_WORKERS) as ex:
        futures = [ex.submit(_do_batch, b) for b in range(total_batches)]
        for fut in as_completed(futures):
            if not fut.result():
                failed += 1

    # refine 과 같은 원칙: 대부분 실패면 체크포인트에 굳히지 말고 잡 재시도로 넘긴다.
    if failed > total_batches * 0.5:
        raise RuntimeError(
            f"translate: {failed}/{total_batches} batches failed — "
            "failing so the job retries instead of baking foreign text into the checkpoint"
        )
    return out, translated_counter["n"]

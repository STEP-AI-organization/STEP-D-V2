"""
STEP D Core — Vertex Gemini 일시 오류 재시도 헬퍼

429/503 스로틀·순단 같은 일시 오류는 제자리에서 재시도하면 살아난다. 파이프라인은
단계별 체크포인트로 재개되는 구조라, 일시 오류로 조용히 비운 결과가 저장되면 그
데이터 손실이 영구화된다 — 그래서 core의 Gemini 호출은 이 헬퍼로 감싼다.
비일시(스키마/안전차단/JSON 절단 등) 오류는 즉시 다시 던진다.

⚠️ **core 의 모든 Gemini 호출은 예외 없이 `call_with_retry` 로 감쌀 것.**
재시도 때문만이 아니다 — **usage 집계(`_record_usage`)가 이 함수 안에만 있어서**, 직접
`client.models.generate_content(...)` 를 부르면 그 비용이 `usage.json` 에서 통째로 빠진다.
2026-08-06 실측: `beat_annot`(회당 최대 소비처 · 58.6분 드라마 239콜)이 안 감싸여 있어
usage.json 이 35콜 ₩27 만 보고했다 — 실제의 극히 일부. 비용을 계기로 관리하려면 이 규칙이
깨지면 안 된다.
"""
import os
import random
import threading
import time

# ── Usage accounting (2026-08-06) ──────────────────────────────────────────────
# 회당 실비 관측용. 모든 Gemini 응답의 usage_metadata 를 프로세스 로컬 누적.
# analyze.py 완료 시점에 dump 하면 회당 정확한 in/out 토큰 · 콜수 · 대략 원 산출 가능.
# 임계치는 대략치 (2026-08-06 asia-northeast3 flash 기준 · 실제 청구서와 다를 수 있음).
_USAGE_LOCK = threading.Lock()
USAGE: dict = {"calls": 0, "in_tokens": 0, "out_tokens": 0, "by_model": {}}

# KRW per 1M tokens · 환율 ₩1,416/USD (2026-08-11 기준 · docs/ops/cost-and-dependencies.md §3).
#
# ⚠️ **여기 숫자가 틀리면 마진 판단이 통째로 틀어진다.** 2026-08-11 감사에서 이 표가
# **Gemini 2.0 Flash 단가($0.075/$0.30)를 2.5 Flash 라벨에 붙여 놓은 것**으로 확인됐다
# (× ₩1,333 하면 정확히 100/400 이 나온다). 결과: 입력 4.3배 · 출력 8.9배 **과소계상**.
# usage.json 의 est_krw 와 그걸 인용한 모든 문서가 같은 배수만큼 틀렸다
# (58.6분 정본 회차: 코드 보고 ₩154 → 정상단가 재계산 **₩728**).
# 공시가로 바로잡는다. **단가가 바뀌면 여기와 cost-and-dependencies.md §3 을 같이 고칠 것.**
_PRICE_KRW_PER_1M = {
    "gemini-2.5-flash": {"in": 425, "out": 3540},        # $0.30 / $2.50
    "gemini-2.5-flash-lite": {"in": 142, "out": 566},    # $0.10 / $0.40
    "gemini-2.5-pro": {"in": 1770, "out": 14160},        # $1.25 / $10.00
    "gemini-3-pro-image": {"in": 5000, "out": 20000},    # nano banana 대략 — 실측 필요
}


def _record_usage(resp):
    """genai 응답 객체에서 usage_metadata 를 뽑아 누적. resp 형태가 다양해 방어적 파싱."""
    try:
        um = getattr(resp, "usage_metadata", None)
        if um is None:
            return
        pin = int(getattr(um, "prompt_token_count", 0) or 0)
        pout = int(getattr(um, "candidates_token_count", 0) or 0)
        # 프롬프트 캐시 적중분. 이걸 안 세면 "캐시 활용" 이 검증 불가한 주장으로 남는다
        # (2026-08-07: beat_annot 맥락 누적을 넣고도 캐시가 걸렸는지 확인할 수가 없었다).
        # 캐시된 토큰은 요금이 크게 싸므로 비용 추정에도 필요하다.
        pcache = int(getattr(um, "cached_content_token_count", 0) or 0)
        model = str(getattr(resp, "model_version", "") or getattr(resp, "model", "") or "unknown")
        with _USAGE_LOCK:
            USAGE["calls"] += 1
            USAGE["in_tokens"] += pin
            USAGE["out_tokens"] += pout
            USAGE["cached_tokens"] = USAGE.get("cached_tokens", 0) + pcache
            if pcache:
                USAGE["cached_calls"] = USAGE.get("cached_calls", 0) + 1
            m = USAGE["by_model"].setdefault(model, {"calls": 0, "in": 0, "out": 0, "cached": 0})
            m["calls"] += 1; m["in"] += pin; m["out"] += pout
            m["cached"] = m.get("cached", 0) + pcache
    except Exception:
        pass


def record_batch_usage(model: str, in_tokens: int, out_tokens: int, calls: int) -> None:
    """배치 잡 응답의 토큰을 `{model}:batch` 키로 누적 (단가 50% 적용 · core/common/batch.py).

    동기와 **같은 키에 합치지 않는다.** 섞으면 usage.json 만 보고는 배치가 실제로 걸렸는지
    알 수 없고, 원가 계산도 절반인지 아닌지 구분이 안 된다. 2026-08-17 원가 감사에서
    "로그에 안 찍힌 스테이지를 0 으로 셌다" 가 세 번 반복된 게 이런 종류의 눈가림이었다.
    """
    key = f"{model}:batch"
    with _USAGE_LOCK:
        USAGE["calls"] += calls
        USAGE["in_tokens"] += in_tokens
        USAGE["out_tokens"] += out_tokens
        m = USAGE["by_model"].setdefault(key, {"calls": 0, "in": 0, "out": 0, "cached": 0})
        m["calls"] += calls
        m["in"] += in_tokens
        m["out"] += out_tokens


#: 배치 예측 단가 배수. Vertex 배치는 동기 대비 50%.
BATCH_PRICE_FACTOR = 0.5


def usage_summary() -> dict:
    """지금까지 이 프로세스 누적. analyze.py 마지막에 print 하면 회당 실비."""
    with _USAGE_LOCK:
        snap = {
            "calls": USAGE["calls"],
            "in_tokens": USAGE["in_tokens"],
            "out_tokens": USAGE["out_tokens"],
            "cached_tokens": USAGE.get("cached_tokens", 0),
            "cached_calls": USAGE.get("cached_calls", 0),
            "by_model": {k: dict(v) for k, v in USAGE["by_model"].items()},
        }
    total_krw = 0.0
    for model, v in snap["by_model"].items():
        # `{model}:batch` = 배치 예측 (단가 50%). 접미를 떼고 요율을 찾는다.
        is_batch = model.endswith(":batch")
        lookup = model[: -len(":batch")] if is_batch else model
        # 매치되는 요율 찾기 (버전 suffix 무시).
        # ⚠️ **긴 키부터** 매칭한다. startswith 라 "gemini-2.5-flash-lite" 가 "gemini-2.5-flash"
        # 에 먼저 걸리면 flash-lite 를 flash 단가(3배)로 계산해 "flash-lite 는 절감이 없다"는
        # 거짓 결론이 난다(2026-08-19 발견). 더 구체적인(긴) 키가 우선이어야 한다.
        rate = None
        for key, r in sorted(_PRICE_KRW_PER_1M.items(), key=lambda kv: -len(kv[0])):
            if lookup.startswith(key):
                rate = r; break
        if rate is None:
            continue
        factor = BATCH_PRICE_FACTOR if is_batch else 1.0
        total_krw += (v["in"] / 1_000_000 * rate["in"] + v["out"] / 1_000_000 * rate["out"]) * factor
    snap["est_krw"] = round(total_krw, 2)
    return snap

# 예외 메시지/타입명에 이 표식이 있으면 일시(transient) 오류로 본다.
_TRANSIENT_MARKERS = (
    "429", "RESOURCE_EXHAUSTED",
    "503", "UNAVAILABLE",
    "DEADLINE_EXCEEDED",
    "Connection", "connection",
    "timed out", "Timeout", "timeout",
)


def is_transient(e: BaseException) -> bool:
    """스로틀(429)/순단(503)/타임아웃/커넥션 오류 = 재시도 가치가 있는 일시 오류."""
    if isinstance(e, (ConnectionError, TimeoutError)):
        return True
    blob = f"{type(e).__name__} {e}"
    return any(m in blob for m in _TRANSIENT_MARKERS)


def _call_with_timeout(fn, timeout: float):
    """fn()을 데몬 스레드에서 실행하고 timeout초 안에 안 끝나면 TimeoutError. 행(무한대기)
    방지 — genai 클라이언트가 타임아웃 없이 멈추면 파이프라인 전체가 멈춘다. 초과 시 스레드는
    데몬이라 프로세스 종료 때 정리되고, 여기서는 재시도로 넘어간다."""
    if not timeout:
        return fn()
    box: dict = {}
    def run():
        try:
            box["v"] = fn()
        except BaseException as e:  # noqa: BLE001 — 원 예외를 그대로 전달
            box["e"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"Gemini 호출이 {timeout:.0f}s를 초과 (행 방지 차단)")
    if "e" in box:
        raise box["e"]
    return box.get("v")


def call_with_retry(fn, *, attempts: int = 4, base_delay: float = 2.0, timeout: float = 600.0):
    """fn()을 호출하되 일시 오류면 지수 백오프+지터로 재시도. 비일시 오류는 즉시 재던짐.
    각 호출은 timeout초로 제한(행 방지) — 초과하면 일시 오류로 보고 재시도한다.
    워커 스레드에서도 쓰이므로 로그는 한 번의 write로 원자적으로 낸다.

    2026-07-23: 긴 영상(90분+) 정밀 분석에서 Vision·narrative 콜이 120s를 초과하는 경우가
    관찰됨(대용량 프레임·긴 prompt) → 600s(10분)로 상향. 여전히 hang은 잘라내되 정상 처리는 살림."""
    for i in range(attempts):
        try:
            resp = _call_with_timeout(fn, timeout)
            _record_usage(resp)
            return resp
        except Exception as e:
            if not is_transient(e) or i >= attempts - 1:
                raise
            delay = base_delay * (2 ** i) + random.uniform(0, base_delay)
            # cp949 콘솔에서도 죽지 않게 ASCII+한글만 쓰고, 오류 메시지는 인코딩 실패 시 생략.
            try:
                print(f"   (일시 오류, {delay:.1f}s 후 재시도 {i + 1}/{attempts - 1}: {str(e)[:70]})\n",
                      end="", flush=True)
            except UnicodeEncodeError:
                print(f"   (transient error, retry {i + 1}/{attempts - 1} in {delay:.1f}s)\n",
                      end="", flush=True)
            time.sleep(delay)

"""
STEP D Core — Vertex Gemini 일시 오류 재시도 헬퍼

429/503 스로틀·순단 같은 일시 오류는 제자리에서 재시도하면 살아난다. 파이프라인은
단계별 체크포인트로 재개되는 구조라, 일시 오류로 조용히 비운 결과가 저장되면 그
데이터 손실이 영구화된다 — 그래서 core의 Gemini 호출은 이 헬퍼로 감싼다.
비일시(스키마/안전차단/JSON 절단 등) 오류는 즉시 다시 던진다.
"""
import random
import threading
import time

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


def call_with_retry(fn, *, attempts: int = 4, base_delay: float = 2.0, timeout: float = 120.0):
    """fn()을 호출하되 일시 오류면 지수 백오프+지터로 재시도. 비일시 오류는 즉시 재던짐.
    각 호출은 timeout초로 제한(행 방지) — 초과하면 일시 오류로 보고 재시도한다.
    워커 스레드에서도 쓰이므로 로그는 한 번의 write로 원자적으로 낸다."""
    for i in range(attempts):
        try:
            return _call_with_timeout(fn, timeout)
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

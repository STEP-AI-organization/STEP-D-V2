"""
STEP D Core — Vertex Gemini 일시 오류 재시도 헬퍼

429/503 스로틀·순단 같은 일시 오류는 제자리에서 재시도하면 살아난다. 파이프라인은
단계별 체크포인트로 재개되는 구조라, 일시 오류로 조용히 비운 결과가 저장되면 그
데이터 손실이 영구화된다 — 그래서 core의 Gemini 호출은 이 헬퍼로 감싼다.
비일시(스키마/안전차단/JSON 절단 등) 오류는 즉시 다시 던진다.
"""
import random
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


def call_with_retry(fn, *, attempts: int = 4, base_delay: float = 2.0):
    """fn()을 호출하되 일시 오류면 지수 백오프+지터로 재시도. 비일시 오류는 즉시 재던짐.
    워커 스레드에서도 쓰이므로 로그는 한 번의 write로 원자적으로 낸다."""
    for i in range(attempts):
        try:
            return fn()
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

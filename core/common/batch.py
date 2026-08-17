"""Gemini 배치 모드 — 같은 판정을 **절반 값**에 사는 경로.

## ⚠️ 먼저 읽을 것 — 지금은 기본 OFF 이고, 그 이유가 실측이다 (2026-08-17)

780건(32.4분 회차의 chyron 전량)으로 관통해 봤다.

| | 값 |
|---|---|
| 원가 | ₩329.11 — 동기 ₩657.53 의 **정확히 절반** ✅ |
| 응답 짝짓기 | 780/780 ✅ (`#REQ` 표식 방식 검증됨) |
| 제출 → 실행 시작 | 5분 19초 |
| **제출 → 종료** | **5시간 45분** 🔴 |

**그래서 이 구현을 그대로 프로덕션에 켜면 안 된다.** 아래 `batch_generate` 는 파이프라인이
폴링하며 기다리는 동기 구조라, 상한(`GEMINI_BATCH_TIMEOUT_SEC` 기본 25분)에서 잡을 취소하고
동기 경로로 되돌아간다 — **25분을 버리고 제값을 내는** 최악의 조합이 된다.

쓰려면 2단계로 바꿔야 한다: ① 제출하고 잡 이름만 체크포인트에 남기고 스테이지를 끝낸다
② 몇 시간 뒤 별도 잡이 결과를 수거해 speaker 실명·검색 인덱스를 갱신한다. 그때 이 모듈의
제출·짝짓기·원가집계는 그대로 재사용할 수 있다(그래서 지우지 않고 남겨 둔다).

## 왜 이걸 만들었나

2026-08-17 원가 실측에서 60분 회차 ₩2,385(분당 ₩39.8)가 나왔다. 판매가가 분당 ₩28 이라
**켠 채로는 편당 ₩759 적자**다. 이미지 쪽 절감은 전부 실패했고(해상도·크롭·조기종료 —
docs/ops/how-it-works.md §6), 남은 레버가 배치 모드 하나였다: Vertex 배치 예측은 같은
모델·같은 프롬프트에 **동기 대비 50% 단가**다.

## 무엇을 배치로 돌리나 — chyron 하나다

| 스테이지 | 콜 수 | 배치 가능? |
|---|---|---|
| chyron per-seg | 780 (32.4분) | ✅ 세그마다 독립. **한 잡에 전부 넣는다** |
| beat_annot | 128 | ❌ 청크마다 앞 beat 결과를 맥락으로 쌓는다(도미노). 청크 = workers 라 |
|            |     | 128/6 ≈ 21개 잡을 **순차 대기**해야 한다 — 잡 하나당 큐 대기가 붙어 더 느리다 |
| recommend | 21 | ❌ pool → 선정 → QA 가 서로의 결과에 의존 |
| narrative · scene_type | 9 | ❌ 가능하지만 9콜 아끼려고 잡 대기를 무는 건 손해 |

chyron 만으로 콜 수의 83%, 원가의 51%를 덮는다.

## 이 모듈이 지키는 것

**실패 방향.** 배치가 안 되면 분석이 멈추는 게 아니라 **동기 경로로 되돌아간다**
(`batch_generate` 가 `None` 을 던지고 caller 가 기존 코드로 진행). 버킷 미설정·권한 없음·
잡 실패·타임아웃 전부 같은 방향이다. 반값을 못 사는 건 손해지만, 회차가 안 도는 건 사고다.

**응답 짝짓기.** 출력 JSONL 의 줄 순서는 보장되지 않는다. 그래서 각 요청 프롬프트 끝에
`#REQ:{i}` 표식을 박고, 출력에 그대로 실려 오는 요청을 보고 되짚는다. 순서를 믿고 zip 하면
**엉뚱한 세그먼트에 엉뚱한 이름이 붙는다** — 조용히 틀리는 종류라 표식으로 못을 박았다.

**원가 집계.** 배치 응답의 토큰은 `record_batch_usage()` 로 `{model}:batch` 키에 쌓는다.
`usage_summary()` 가 그 키에 단가 50%를 적용한다 — 동기와 섞이지 않아 usage.json 만 보고도
"이 회차에서 배치가 실제로 걸렸는지" 를 알 수 있다.
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Callable

BATCH_ENV = "GEMINI_BATCH"

#: 폴링 간격·상한. 상한을 넘기면 동기 폴백이다.
#: Cloud Run Job 타임아웃(그리고 워커 DRAIN_MAX_MS 50분) 안에서 끝나야 하므로 기본 25분.
POLL_SEC = float(os.environ.get("GEMINI_BATCH_POLL_SEC") or 20)
TIMEOUT_SEC = float(os.environ.get("GEMINI_BATCH_TIMEOUT_SEC") or 1500)

#: **시작 대기 상한.** 잡은 제출 즉시 도는 게 아니라 큐에서 기다린다 —
#: 실측(2026-08-17 · 780건): 제출 → RUNNING 까지 **5분 19초**.
#: 여기서 오래 붙잡혀 있으면 전체 상한까지 기다릴 이유가 없다(PENDING 이 길면 대개 더 길다).
#: 이 시간 안에 RUNNING 으로 못 가면 잡을 **취소하고** 동기로 넘어간다.
START_TIMEOUT_SEC = float(os.environ.get("GEMINI_BATCH_START_TIMEOUT_SEC") or 420)

_TERMINAL_OK = {"JOB_STATE_SUCCEEDED"}
_TERMINAL_BAD = {"JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED",
                 "JOB_STATE_PARTIALLY_SUCCEEDED"}


def batch_enabled() -> bool:
    """배치 모드가 켜져 있고 쓸 버킷이 있는가.

    오타·빈값은 **꺼진 것으로 본다** — upload-gate.ts 와 같은 방향이다. 잘못된 env 의
    실패 모드가 "동기로 돈다"(비싸지만 정상)여야 하고 "안 돈다" 가 되면 안 된다.
    """
    if str(os.environ.get(BATCH_ENV) or "").strip().lower() not in ("1", "true", "on", "yes"):
        return False
    return bool(batch_bucket())


def batch_bucket() -> str:
    """배치 입출력에 쓸 GCS 버킷 이름. 전용 버킷이 없으면 미디어 버킷을 같이 쓴다."""
    for key in ("GEMINI_BATCH_BUCKET", "GCS_BUCKET"):
        v = str(os.environ.get(key) or "").strip()
        if v:
            return v.replace("gs://", "").strip("/")
    return ""


def _jsonl_line(parts: list[dict], gen_config: dict) -> str:
    return json.dumps({"request": {"contents": [{"role": "user", "parts": parts}],
                                   "generationConfig": gen_config}}, ensure_ascii=False)


def image_part(data: bytes, mime: str = "image/jpeg") -> dict:
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}}


def text_part(text: str) -> dict:
    return {"text": text}


def batch_generate(*, model: str, requests: list[list[dict]], gen_config: dict,
                   label: str, log: Callable[[str], None] = print) -> list[str | None] | None:
    """요청 묶음을 배치 잡 하나로 돌려 **입력 순서대로** 응답 텍스트를 준다.

    requests: 요청마다 parts 목록(`image_part`·`text_part` 로 만든 dict).
              마지막 text part 끝에 `#REQ:{i}` 표식을 이 함수가 붙인다.
    반환: 요청 수와 같은 길이의 리스트(실패한 건은 None) · **배치 자체가 불가하면 `None`**
          (caller 는 그때 동기 경로로 간다).
    """
    if not requests:
        return []
    bucket = batch_bucket()
    if not bucket:
        log("[batch] 버킷이 없다 (GEMINI_BATCH_BUCKET·GCS_BUCKET) — 동기 경로로 진행")
        return None

    try:
        from google import genai
        from google.cloud import storage
    except Exception as e:  # 라이브러리 미설치 등
        log(f"[batch] SDK 없음 → 동기 폴백 ({str(e)[:100]})")
        return None

    # 요청마다 표식을 박는다 (출력 줄 순서를 믿지 않는다)
    lines: list[str] = []
    for i, parts in enumerate(requests):
        marked = list(parts)
        for j in range(len(marked) - 1, -1, -1):
            if "text" in marked[j]:
                marked[j] = {"text": f"{marked[j]['text']}\n#REQ:{i}"}
                break
        else:
            marked.append({"text": f"#REQ:{i}"})
        lines.append(_jsonl_line(marked, gen_config))

    stamp = f"{label}-{len(requests)}-{int(time.time())}"
    in_blob = f"gemini-batch/{stamp}/input.jsonl"
    dest_prefix = f"gemini-batch/{stamp}/out"
    payload = ("\n".join(lines) + "\n").encode("utf-8")

    try:
        sc = storage.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None)
        bkt = sc.bucket(bucket)
        bkt.blob(in_blob).upload_from_string(payload, content_type="application/jsonl")
    except Exception as e:
        log(f"[batch] 입력 업로드 실패 → 동기 폴백 ({str(e)[:160]})")
        return None

    src_uri = f"gs://{bucket}/{in_blob}"
    dest_uri = f"gs://{bucket}/{dest_prefix}"
    log(f"[batch] {len(requests)}건 제출 · {len(payload)//1024}KB · {src_uri}")

    try:
        client = genai.Client(vertexai=True,
                              project=os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d",
                              location=os.environ.get("VERTEX_LOCATION") or "asia-northeast3")
        job = client.batches.create(model=model, src=src_uri, config={"dest": dest_uri})
    except Exception as e:
        log(f"[batch] 잡 생성 실패 → 동기 폴백 ({str(e)[:200]})")
        return None

    t0 = time.time()
    state = str(getattr(job, "state", "") or "")
    name = getattr(job, "name", "") or ""
    while True:
        if state in _TERMINAL_OK or state in _TERMINAL_BAD:
            break
        el = time.time() - t0
        # ⚠️ 폴백할 때 잡을 **취소한다.** 안 하면 우리가 안 읽을 결과를 서버가 끝까지 만들고
        # **요금은 그대로 청구된다** — 동기로 다시 돌린 값과 합쳐 이중 지불이 된다.
        if el > TIMEOUT_SEC:
            log(f"[batch] {TIMEOUT_SEC:.0f}s 초과 (state={state}) → 잡 취소하고 동기 폴백")
            _cancel(client, name, log)
            return None
        if "PENDING" in state and el > START_TIMEOUT_SEC:
            log(f"[batch] {el:.0f}s 째 큐 대기(PENDING) — 시작 상한 초과 → 잡 취소하고 동기 폴백")
            _cancel(client, name, log)
            return None
        time.sleep(POLL_SEC)
        try:
            job = client.batches.get(name=name)
            state = str(getattr(job, "state", "") or "")
        except Exception as e:
            log(f"[batch] 상태 조회 실패 → 동기 폴백 ({str(e)[:140]})")
            return None
        el = time.time() - t0
        if int(el) % 120 < POLL_SEC:
            log(f"[batch] {state} · {el:.0f}s 경과")

    if state not in _TERMINAL_OK:
        log(f"[batch] 잡 종료 상태 {state} → 동기 폴백")
        return None

    # 출력 읽기 — dest 아래에 예측 JSONL 이 하나 이상 생긴다
    out: list[str | None] = [None] * len(requests)
    in_tok = out_tok = calls = 0
    try:
        blobs = [b for b in sc.list_blobs(bucket, prefix=dest_prefix) if b.name.endswith(".jsonl")]
        if not blobs:
            log(f"[batch] 출력 JSONL 이 없다 (prefix={dest_prefix}) → 동기 폴백")
            return None
        for b in blobs:
            for raw in b.download_as_text(encoding="utf-8").splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except Exception:
                    continue
                idx = _marker_index(row.get("request"))
                resp = row.get("response") or {}
                um = resp.get("usageMetadata") or {}
                if um:
                    in_tok += int(um.get("promptTokenCount") or 0)
                    out_tok += int(um.get("candidatesTokenCount") or 0)
                    calls += 1
                text = _first_text(resp)
                if idx is not None and 0 <= idx < len(out):
                    out[idx] = text
    except Exception as e:
        log(f"[batch] 출력 파싱 실패 → 동기 폴백 ({str(e)[:160]})")
        return None

    got = sum(1 for v in out if v is not None)
    if got == 0:
        log("[batch] 짝지어진 응답이 0건 → 동기 폴백")
        return None

    from core.common.retry import record_batch_usage
    record_batch_usage(model, in_tok, out_tok, calls)
    log(f"[batch] 완료 · {got}/{len(requests)}건 · {time.time()-t0:.0f}s · "
        f"in={in_tok:,} out={out_tok:,} (단가 50%)")
    return out


def _cancel(client: Any, name: str, log: Callable[[str], None]) -> None:
    """폴백 시 잡을 취소한다 — 실패해도 진행한다(취소 실패로 회차를 멈출 이유는 없다)."""
    if not name:
        return
    try:
        client.batches.cancel(name=name)
        log(f"[batch] 잡 취소 요청 완료 ({name.rsplit('/', 1)[-1]})")
    except Exception as e:
        log(f"[batch] 잡 취소 실패 — 요금이 청구될 수 있다: {str(e)[:120]}")


def _marker_index(request: Any) -> int | None:
    """출력에 실려 온 요청에서 `#REQ:{i}` 표식을 되짚는다."""
    try:
        for content in (request or {}).get("contents") or []:
            for part in content.get("parts") or []:
                t = part.get("text")
                if not t or "#REQ:" not in t:
                    continue
                return int(t.rsplit("#REQ:", 1)[1].strip().split()[0])
    except Exception:
        return None
    return None


def _first_text(resp: Any) -> str | None:
    try:
        for cand in (resp or {}).get("candidates") or []:
            for part in ((cand.get("content") or {}).get("parts") or []):
                t = part.get("text")
                if t:
                    return t
    except Exception:
        return None
    return None

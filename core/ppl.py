"""
STEP D Core — PPL(Product Placement)·브랜드·협찬 자막 검출 (2026-07-22).

정밀 분석에서 refine 이후 실행 (faces와 병렬 가능 · 서로 독립적).
영상을 5초 간격으로 균등 샘플링해 Gemini Vision으로 각 프레임에 노출된 브랜드·제품·
협찬 자막을 뽑고, 인접한 동일 브랜드 프레임을 하나의 노출 구간(interval)으로 병합.

Output: ppl.json
{
  "detections": [
    {"start": 12.5, "end": 18.0, "brand": "CJ", "category": "음식",
     "position": "우하", "confidence": 0.85, "notes": "협찬 배너",
     "frame_refs": ["ppl_frames/f_00012.jpg", ...]}
  ],
  "brand_summary": {"CJ": 24.5, "삼성": 8.1},          # 브랜드별 총 노출초
  "total_frames_scanned": 240,
  "total_detections": 87,                              # 프레임-브랜드 페어 개수
  "detect_sec": 92.3
}

Auth: ADC. Vertex Seoul (frames가 방송 저작권물이라 in-country).

Run:
    python -m core.ppl <video.mp4> <out_dir>
    python -m core.ppl <video.mp4> <out_dir> --sample-sec 5 --limit 20
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Callable, Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import cv2

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

WORKERS = int(os.environ.get("PPL_WORKERS") or 6)
SAMPLE_SEC = float(os.environ.get("PPL_SAMPLE_SEC") or 5.0)  # 프레임 샘플 간격
MERGE_GAP_SEC = 3.0   # 연속 검출 병합 허용 간격 (샘플 간격보다 살짝 넉넉히)
MAX_FRAME_ATTEMPTS = 3
JPEG_QUALITY = 80    # 인코딩 품질 — Vision 목적엔 이 정도면 충분·트래픽 절약

PROMPT = """이 이미지는 한국어 방송의 한 프레임이다. 화면에 노출된 **브랜드·제품·PPL·협찬 자막**을 찾아라.

찾을 것:
- 브랜드 로고 (의류·음료·전자·자동차·화장품 등 명확한 로고)
- 제품 이름/라벨이 보이는 상품 (음료 캔 · 스낵 봉지 · 스마트폰 · 화장품 튜브 등)
- 화면에 박힌 협찬/제공 자막 ("제공 XX", "협찬 YY", 로고 배너)
- 무대·배경의 상표 (경기장 광고판, 스튜디오 로고 벽, 옷의 로고)

검출 규칙(중요):
- **확신할 때만** 넣어라. 흐릿하거나 로고 일부만 보여 모호하면 넣지 마라.
- 브랜드명은 정식 표기(예: "삼성", "코카콜라", "농심"). 모르면 정확히 "unknown".
- 같은 브랜드가 여러 위치에 보이면 가장 크게 잡히는 하나만.
- 정지 자막/배너의 방송사 로고(예: SBS, KBS)는 제외 — 그건 PPL이 아니다.
- category는 다음 중: 음식/음료/의류/전자/화장품/자동차/생활용품/서비스/기타.
- position: 화면 4분면 중 하나 "좌상"/"우상"/"좌하"/"우하"/"중앙"/"전체".
- confidence: 0.0~1.0 (로고 명확도 + 크기 종합).
- notes: 짧게 (예: "출연자 손에 든 캔", "무대 뒤 배너", "협찬 자막").

없으면 빈 배열. 확신 없으면 절대 넣지 마라 (false positive = PPL 신뢰도 파괴)."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "detections": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "brand": {"type": "STRING"},
                    "category": {"type": "STRING"},
                    "position": {"type": "STRING"},
                    "confidence": {"type": "NUMBER"},
                    "notes": {"type": "STRING"},
                },
                "required": ["brand", "category", "position", "confidence"],
            },
        },
    },
    "required": ["detections"],
}


def _client():
    return genai.Client(vertexai=True, project=PROJECT, location=LOCATION)


def _analyze_frame(client, jpeg_bytes: bytes) -> list[dict]:
    """One Gemini Vision call → 이 프레임의 PPL 검출 목록."""
    resp = call_with_retry(
        lambda: client.models.generate_content(
            model=MODEL,
            contents=[
                types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                PROMPT,
            ],
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=SCHEMA,
                max_output_tokens=8192,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ),
        attempts=3,
    )
    try:
        data = json.loads(resp.text or "{}")
    except json.JSONDecodeError:
        return []
    dets = data.get("detections") or []
    # confidence 하한 필터 — 모델이 임계값 지시 무시하고 낮은 걸 뱉는 경우 방어
    return [d for d in dets if float(d.get("confidence", 0)) >= 0.5]


def _sample_frame(cap: cv2.VideoCapture, ts_sec: float) -> Optional[bytes]:
    """지정 시각 프레임을 JPEG으로 인코드. cv2 seek → read → imencode."""
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, ts_sec) * 1000)
    ok, frame = cap.read()
    if not ok or frame is None:
        return None
    ok2, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok2:
        return None
    return bytes(buf.tobytes())


def _save_crop(cap: cv2.VideoCapture, ts_sec: float, path: Path) -> bool:
    """샘플 프레임을 그대로 저장(UI 카드 썸네일용). 리사이즈 없음."""
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, ts_sec) * 1000)
    ok, frame = cap.read()
    if not ok or frame is None:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    return bool(cv2.imwrite(str(path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82]))


def build_ppl_index(
    video_path: str,
    duration_sec: float,
    out_dir: Path,
    sample_sec: float = SAMPLE_SEC,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """메인 진입.

    1) `sample_sec` 간격으로 프레임 뽑아 JPEG 인코드
    2) 병렬 Gemini Vision (WORKERS)
    3) 결과 병합 → 인접 같은 브랜드는 하나의 노출 구간으로
    4) 대표 프레임(가장 confidence 높은 샘플)만 크롭 저장
    5) ppl.json dict 반환

    duration_sec은 refine이 계산해서 넘겨줌 (analyze.py에서 배선).
    """
    if duration_sec <= 0:
        return {"detections": [], "brand_summary": {}, "total_frames_scanned": 0, "note": "duration=0"}

    # 샘플 시각 계산 · 0초부터 duration까지 균등
    timestamps = []
    t = 0.0
    while t < duration_sec:
        timestamps.append(t)
        t += sample_sec
    n = len(timestamps)
    if n == 0:
        return {"detections": [], "brand_summary": {}, "total_frames_scanned": 0}

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"[ppl] cv2.VideoCapture 실패: {video_path}")
        return {"detections": [], "brand_summary": {}, "total_frames_scanned": 0, "error": "video open failed"}

    # 프레임 뽑기 (순차 — cv2 seek는 스레드 안전 X).
    # 긴 영상은 이 단계만 수 분 걸릴 수 있으므로 20 프레임마다 진행 로그 (worker의 STALL_TIMEOUT
    # 재트리거 방지 목적 · 무출력 30분+ 나가면 워커가 hang으로 오인해 kill함).
    t0 = time.time()
    frames: list[Optional[bytes]] = [None] * n
    for i, ts in enumerate(timestamps):
        frames[i] = _sample_frame(cap, ts)
        if (i + 1) % 20 == 0 or i == n - 1:
            print(f"[ppl] 샘플링 {i+1}/{n} · elapsed {time.time()-t0:.0f}s", flush=True)
    sample_sec_elapsed = time.time() - t0

    client = _client()
    per_frame: list[list[dict]] = [[] for _ in range(n)]

    lock = Lock()
    done = {"n": 0}

    def _do(i: int) -> None:
        buf = frames[i]
        if buf is None:
            with lock:
                done["n"] += 1
                if on_progress and (done["n"] % 10 == 0 or done["n"] == n):
                    on_progress(done["n"], n)
            return
        for attempt in range(MAX_FRAME_ATTEMPTS):
            try:
                per_frame[i] = _analyze_frame(client, buf)
                break
            except Exception as e:
                if attempt == MAX_FRAME_ATTEMPTS - 1:
                    print(f"[ppl] frame {i} @ {timestamps[i]:.1f}s 실패: {e}")
        with lock:
            done["n"] += 1
            if on_progress and (done["n"] % 10 == 0 or done["n"] == n):
                on_progress(done["n"], n)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(_do, range(n)))

    detect_sec = time.time() - t0
    total_dets = sum(len(x) for x in per_frame)
    print(f"[ppl] 샘플 {n} · 검출 페어 {total_dets} · 프레임뽑기 {sample_sec_elapsed:.1f}s · 총 {detect_sec:.1f}s")

    # 병합: 인접(<= MERGE_GAP_SEC) 같은 브랜드는 하나의 구간으로.
    # (frame_idx, ts, brand, cat, pos, conf, notes) 를 브랜드별로 모아 시간순 정렬 → 그룹.
    by_brand: dict[str, list[dict]] = {}
    for i, dets in enumerate(per_frame):
        for d in dets:
            brand = (d.get("brand") or "").strip()
            if not brand or brand.lower() == "unknown":
                continue
            by_brand.setdefault(brand, []).append({
                "ts": timestamps[i],
                "frame_idx": i,
                "category": d.get("category", ""),
                "position": d.get("position", ""),
                "confidence": float(d.get("confidence", 0)),
                "notes": d.get("notes", ""),
            })

    # 각 브랜드 안에서 인접 병합 → 구간 목록.
    detections: list[dict] = []
    frames_dir = out_dir / "ppl_frames"
    for brand, items in by_brand.items():
        items.sort(key=lambda x: x["ts"])
        cur: Optional[dict] = None
        for it in items:
            if cur is None:
                cur = {
                    "brand": brand,
                    "category": it["category"],
                    "position": it["position"],
                    "start": it["ts"],
                    "end": it["ts"] + sample_sec,
                    "confidence": it["confidence"],
                    "notes": it["notes"],
                    "peak_frame_idx": it["frame_idx"],
                    "peak_conf": it["confidence"],
                    "frames_hit": 1,
                }
            elif it["ts"] - cur["end"] <= MERGE_GAP_SEC:
                cur["end"] = it["ts"] + sample_sec
                cur["frames_hit"] += 1
                if it["confidence"] > cur["peak_conf"]:
                    cur["peak_conf"] = it["confidence"]
                    cur["peak_frame_idx"] = it["frame_idx"]
                    cur["category"] = it["category"] or cur["category"]
                    cur["position"] = it["position"] or cur["position"]
                    cur["notes"] = it["notes"] or cur["notes"]
                    cur["confidence"] = max(cur["confidence"], it["confidence"])
            else:
                detections.append(_finalize_detection(cur, cap, timestamps, frames_dir))
                cur = {
                    "brand": brand,
                    "category": it["category"],
                    "position": it["position"],
                    "start": it["ts"],
                    "end": it["ts"] + sample_sec,
                    "confidence": it["confidence"],
                    "notes": it["notes"],
                    "peak_frame_idx": it["frame_idx"],
                    "peak_conf": it["confidence"],
                    "frames_hit": 1,
                }
        if cur is not None:
            detections.append(_finalize_detection(cur, cap, timestamps, frames_dir))

    cap.release()

    # 시간순 정렬 · brand_summary 집계
    detections.sort(key=lambda d: d["start"])
    brand_summary: dict[str, float] = {}
    for d in detections:
        brand_summary[d["brand"]] = round(brand_summary.get(d["brand"], 0.0) + (d["end"] - d["start"]), 1)

    return {
        "detections": detections,
        "brand_summary": brand_summary,
        "total_frames_scanned": n,
        "total_detections": total_dets,
        "detect_sec": round(detect_sec, 1),
        "sample_sec": sample_sec,
    }


def _finalize_detection(cur: dict, cap: cv2.VideoCapture, timestamps: list[float], frames_dir: Path) -> dict:
    """peak 프레임을 대표 프레임으로 저장하고 최종 detection dict 반환."""
    ts = timestamps[cur["peak_frame_idx"]]
    brand_safe = "".join(ch if ch.isalnum() else "_" for ch in cur["brand"])[:16]
    fname = f"{brand_safe}_{cur['peak_frame_idx']:05d}.jpg"
    fpath = frames_dir / fname
    if not fpath.exists():
        _save_crop(cap, ts, fpath)
    return {
        "brand": cur["brand"],
        "category": cur["category"],
        "position": cur["position"],
        "start": round(cur["start"], 1),
        "end": round(cur["end"], 1),
        "confidence": round(cur["confidence"], 2),
        "notes": cur["notes"],
        "frame_ref": f"ppl_frames/{fname}",
        "frames_hit": cur["frames_hit"],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="영상 파일 경로")
    ap.add_argument("out_dir", help="산출 디렉토리")
    ap.add_argument("--sample-sec", type=float, default=SAMPLE_SEC)
    ap.add_argument("--duration", type=float, default=0.0, help="영상 길이(초). 0이면 cv2로 추정.")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    dur = args.duration
    if dur <= 0:
        cap = cv2.VideoCapture(args.video)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        frames_n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        dur = frames_n / fps if fps > 0 else 0.0
        cap.release()
        print(f"[ppl] duration 추정: {dur:.1f}s")

    result = build_ppl_index(
        args.video,
        dur,
        out,
        sample_sec=args.sample_sec,
        on_progress=lambda i, n: print(f"@@PROGRESS ppl {i}/{n}"),
    )

    ppl_path = out / "ppl.json"
    ppl_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ppl] 저장: {ppl_path} · 검출 구간 {len(result['detections'])} · 브랜드 {len(result['brand_summary'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

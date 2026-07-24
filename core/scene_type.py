"""
STEP D Core — Shot scene type classification (interview / on_scene / other)

한국 예능은 현장 원 신 + 인서트 인터뷰룸 컷이 교차 편집됨. STT만으로는 두 컷을
구별하기 어려워(대사만 봐서는 인터뷰인지 원 신 리액션인지 모호), 프레임을 실제로 봐야 함.

각 shot 구간(shot boundary 사이)의 대표 프레임 1장을 뽑아 Gemini Vision batch로 분류:
- interview: 스튜디오·인터뷰룸 (단독 정면 컷, 정적 배경)
- on_scene: 현장 원 신 (다중 인물, 상호작용, 동적)
- other: 인서트 그래픽·자막 카드·외경 등

결과는 beats.py 프롬프트에 shot type 블록으로 주입 → LLM이 "원 신 + 인서트 인터뷰"
하나의 beat로 묶기 가능.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
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
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

MIN_SHOT_SEC = 2.0        # 이 미만 shot은 대표 프레임 뽑을 만한 정보 X · 병합
BATCH_SIZE = 20           # Vision 콜당 shot 이미지 수
FRAME_SCALE = "640:360"   # 저해상도로 cost 절감
FRAME_QUALITY = 5         # JPEG quality (2=best, 31=worst)

SYSTEM = """너는 한국 예능·드라마 편집 분석가다. 주어진 프레임 각각이 어떤 유형의 컷인지 분류한다.

**유형 정의**:
- **interview**: 스튜디오 or 별도 인터뷰룸에서 인물 1명이 정면 카메라 보고 얘기하는 컷.
  단독 medium shot, 정적 배경(단색·심플), 하단에 인물 이름 자막 붙어있을 가능성 높음.
  회상·해설·감정 표현 목적. 다른 출연자 없음.
- **on_scene**: 현장·촬영 원 신. 여러 인물이 상호작용하는 실제 사건 진행 컷.
  동적 배경(자연스러운 환경), 다중 인물, 리액션·대화·행동.
- **other**: 인서트 그래픽, CG, 자막 카드, 외경 컷, 로고, 예고 등 위 두 유형 아닌 것.

**분류 원칙**:
- 인터뷰룸이라고 항상 정면·단독은 아님. 인물 1~2명이 정적 배경에서 카메라를 향해 말하면 interview.
- 원 신 안에서 한 명이 카메라 봤어도 배경·상황이 현장이면 on_scene.
- 애매하면 on_scene (예능 대부분이 원 신).

**반환 형식** (JSON, 다른 문장 없이):
{"labels":[{"shot_id":0,"type":"interview","confidence":0.9},{"shot_id":1,"type":"on_scene","confidence":0.85}]}

confidence는 0.0~1.0. type은 interview/on_scene/other 중 하나."""


def _shots_to_ranges(shots: list[float], duration: float) -> list[dict]:
    """shot boundary 시각 리스트 → shot 구간 [{id, start, end, mid}] 리스트.
    MIN_SHOT_SEC 미만 shot은 인접 shot과 병합."""
    if not shots and duration <= 0:
        return []
    # 0과 duration을 boundary에 포함해 구간 생성
    bounds = sorted(set([0.0] + [s for s in shots if 0 < s < duration] + [duration]))
    ranges: list[dict] = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        if e - s < MIN_SHOT_SEC and ranges:
            ranges[-1]["end"] = e
            ranges[-1]["mid"] = (ranges[-1]["start"] + e) / 2
        else:
            ranges.append({"start": s, "end": e, "mid": (s + e) / 2})
    for i, r in enumerate(ranges):
        r["id"] = i
    return ranges


def _extract_frame(video_path: str, at_sec: float, out_path: str) -> bool:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{at_sec:.3f}", "-i", str(video_path),
        "-vframes", "1", "-vf", f"scale={FRAME_SCALE}",
        "-q:v", str(FRAME_QUALITY), out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        return proc.returncode == 0 and Path(out_path).exists()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _classify_batch(client, batch: list[dict], out_dir: Path) -> dict[int, dict]:
    """batch of shot ranges → {shot_id: {type, confidence}}."""
    parts: list = []
    valid_ids: list[int] = []
    for r in batch:
        frame_path = out_dir / f"shot_{r['id']:04d}.jpg"
        if not frame_path.exists():
            continue
        try:
            data = frame_path.read_bytes()
        except OSError:
            continue
        parts.append(f"shot #{r['id']} ({r['mid']:.1f}s):")
        parts.append(types.Part.from_bytes(data=data, mime_type="image/jpeg"))
        valid_ids.append(r["id"])
    if not valid_ids:
        return {}
    parts.append(f"위 {len(valid_ids)}개 프레임 각각 분류하라. shot_id는 위에 명시된 번호.")
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM,
                temperature=0,
                response_mime_type="application/json",
                max_output_tokens=2048,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        raw = resp.text or "{}"
        data = json.loads(raw)
    except Exception as e:
        print(f"   (scene_type batch 실패 · shot {valid_ids[0]}~{valid_ids[-1]}: {str(e)[:80]})")
        return {}
    out: dict[int, dict] = {}
    for lb in (data.get("labels") or []):
        try:
            sid = int(lb.get("shot_id", -1))
            t = str(lb.get("type", "other")).strip().lower()
            if t not in ("interview", "on_scene", "other"):
                t = "other"
            conf = float(lb.get("confidence", 0.5))
        except (TypeError, ValueError):
            continue
        if sid in valid_ids:
            out[sid] = {"type": t, "confidence": round(conf, 2)}
    return out


def classify_shot_types(
    video_path: str, shots: list[float], duration: float, out_dir: Path,
    workers: int = 4,
) -> list[dict]:
    """shot 구간별 대표 프레임 뽑아 Gemini Vision batch로 interview/on_scene/other 분류.
    반환: [{shot_id, start, end, mid, type, confidence}]"""
    if not video_path or not Path(video_path).exists():
        return []
    ranges = _shots_to_ranges(shots, duration)
    if not ranges:
        return []
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 프레임 추출 (병렬)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(_extract_frame, video_path, r["mid"], str(out_dir / f"shot_{r['id']:04d}.jpg")): r
            for r in ranges
        }
        extracted = sum(1 for f in futures if f.result())
    print(f"   scene_type: {extracted}/{len(ranges)} shot 프레임 추출")
    if extracted == 0:
        return []

    # Vision batch 분류
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    batches = [ranges[i:i + BATCH_SIZE] for i in range(0, len(ranges), BATCH_SIZE)]
    labels: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(batches), 4)) as ex:
        results = list(ex.map(lambda b: _classify_batch(client, b, out_dir), batches))
    for r in results:
        labels.update(r)

    out: list[dict] = []
    for r in ranges:
        lb = labels.get(r["id"], {"type": "other", "confidence": 0.0})
        out.append({
            "shot_id": r["id"],
            "start": round(r["start"], 1),
            "end": round(r["end"], 1),
            "mid": round(r["mid"], 1),
            "type": lb["type"],
            "confidence": lb["confidence"],
        })

    # 요약 로그
    counts = {"interview": 0, "on_scene": 0, "other": 0}
    for o in out:
        counts[o["type"]] = counts.get(o["type"], 0) + 1
    print(f"   scene_type: interview {counts['interview']} · on_scene {counts['on_scene']} · other {counts['other']} (총 {len(out)} shot)")
    return out

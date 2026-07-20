"""
STEP D Core — 시간대 단위 구간 분석 (timeline blocks)

scenes.json → timeline.json: 장면들을 N분 단위 블록으로 묶고, 블록마다 Gemini가
라벨·요약·키 모멘트를 뽑는다. 등장인물/씬 목록은 로컬 집계(모델 호출 없음)이고,
모델에는 블록당 압축된 장면 라인만 보내 비용을 아낀다 (여러 블록을 한 호출에 배칭).

블록 크기는 영상 길이에 따라 자동: ~25분 → 3분 · ~75분 → 5분 · 그 이상 → 10분.

GCS: 워커 경로에서는 content-pipeline.ts(persistArtifacts)가 timeline.json을
analysis/{mediaId}/로 올린다. 단독 실행 시 --gcs-media-id를 주면 여기서 직접 올린다.

Run:
    python -m core.timeline core/scenes.json [--block-minutes N] [--out <timeline.json>]
                                             [--gcs-media-id m_xxxx]
"""
import json
import math
import os
import sys
from pathlib import Path
from typing import Callable, Optional

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

BLOCKS_PER_CALL = 8      # 블록 여러 개를 한 Gemini 호출에 배칭
MAX_SCENE_LINES = 40     # 블록당 모델에 보내는 장면 라인 상한 (초과 시 균등 샘플링)
DIALOGUE_CHARS = 70      # 장면당 대사 발췌 길이

SYSTEM = """당신은 동영상 분석 전문가입니다. 주어진 장면 목록을 분석하여 시간대별 구간을 요약해주세요.
각 구간의 주요 내용, 등장인물, 키 포인트를 추출하세요.

규칙:
- label: 구간의 성격을 드러내는 짧은 제목 (예: "오프닝: 출연진 소개"). 한국어.
- summary: 구간에서 실제로 벌어진 일을 2~3문장으로. 장면 목록에 근거한 내용만 쓰고 지어내지 마라.
- key_points: 구간의 주요 순간 2~5개, 각각 짧은 구 (예: "영숙 등장", "분위기 전환").
- index는 입력한 블록 번호를 그대로 돌려준다."""

SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "index": {"type": "INTEGER"},
            "label": {"type": "STRING"},
            "summary": {"type": "STRING"},
            "key_points": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["index", "label", "summary", "key_points"],
    },
}


def _fmt(sec: float) -> str:
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def pick_block_minutes(duration_sec: float, requested: Optional[int] = None) -> int:
    """영상 길이에 따라 블록 크기 자동 조정 (요청값이 있으면 그대로)."""
    if requested and requested > 0:
        return int(requested)
    minutes = duration_sec / 60
    if minutes <= 25:
        return 3
    if minutes <= 75:
        return 5
    return 10


def _group_scenes(scenes: list[dict], block_minutes: int) -> list[dict]:
    """장면들을 시간순 정렬 후 블록에 배정 (장면 중앙 시각 기준). 빈 블록은 버린다."""
    scenes = sorted(scenes, key=lambda s: float(s.get("start", 0)))
    duration = max((float(s.get("end", 0)) for s in scenes), default=0.0)
    size = block_minutes * 60
    n = max(1, math.ceil(duration / size)) if duration else 0
    blocks = []
    for i in range(n):
        b_start, b_end = i * size, min((i + 1) * size, duration)
        members = [s for s in scenes if b_start <= (float(s.get("start", 0)) + float(s.get("end", 0))) / 2 < b_end
                   or (i == n - 1 and (float(s.get("start", 0)) + float(s.get("end", 0))) / 2 >= b_end)]
        if not members:
            continue
        names: list[str] = []
        for s in members:
            for nm in (s.get("on_screen_names") or []):
                nm = str(nm).strip()
                if nm and nm not in names:
                    names.append(nm)
        blocks.append({
            "start": round(b_start, 1),
            "end": round(b_end, 1),
            "label": f"{_fmt(b_start)}~{_fmt(b_end)} 구간",
            "summary": "",
            "key_points": [],
            "on_screen_names": names,
            "scene_count": len(members),
            "scene_indices": [s.get("index", j) for j, s in enumerate(members)],
            "_scenes": members,  # 내부용 — 저장 전에 제거
        })
    return blocks


def _scene_line(s: dict) -> str:
    """모델에 보내는 압축된 한 줄: 시각 + 이름자막 + 시각태그 + 대사/시각설명."""
    parts = [f"[{_fmt(float(s.get('start', 0)))}]"]
    names = [str(n).strip() for n in (s.get("on_screen_names") or []) if str(n).strip()]
    if names:
        parts.append("👤" + ",".join(names[:4]))
    tags = s.get("vision_tags") or []
    if tags:
        parts.append("#" + "/".join(tags[:3]))
    text = (s.get("text") or "").strip()
    if text:
        parts.append(f"“{text[:DIALOGUE_CHARS]}”")
    else:
        reason = (s.get("vision_reason") or "").strip()
        if reason:
            parts.append(f"(무대사: {reason[:DIALOGUE_CHARS]})")
    return " ".join(parts)


def _sample(items: list, limit: int) -> list:
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _summarize_chunk(client, chunk: list[tuple[int, dict]]) -> None:
    """블록 묶음 하나를 Gemini 한 호출로 요약. 실패 시 기본 라벨 유지 (파이프라인은 계속)."""
    lines = []
    for idx, b in chunk:
        lines.append(f"\n## 블록 {idx} — {_fmt(b['start'])} ~ {_fmt(b['end'])} (장면 {b['scene_count']}개)")
        for s in _sample(b["_scenes"], MAX_SCENE_LINES):
            lines.append(_scene_line(s))
    prompt = ("다음은 한국어 방송 영상의 시간대별 블록과 각 블록의 장면 목록이다. "
              "블록마다 label / summary / key_points를 생성하라.\n" + "\n".join(lines))
    # 429/503 일시 오류는 제자리 백오프 재시도 (실패 시 기본 라벨 폴백은 그대로).
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            temperature=0,
            response_mime_type="application/json",
            response_schema=SCHEMA,
            max_output_tokens=4096,
        ),
    ))
    by_index = {int(r["index"]): r for r in json.loads(resp.text or "[]") if isinstance(r, dict) and "index" in r}
    for idx, b in chunk:
        r = by_index.get(idx)
        if not r:
            continue
        if str(r.get("label", "")).strip():
            b["label"] = str(r["label"]).strip()
        b["summary"] = str(r.get("summary", "")).strip()
        b["key_points"] = [str(k).strip() for k in (r.get("key_points") or []) if str(k).strip()][:5]


def build_timeline(
    scenes: list[dict],
    block_minutes: Optional[int] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """scenes[] → {"block_minutes": N, "blocks": [...]}. Gemini 실패 블록은 기본 라벨로 남는다."""
    if not scenes:
        return {"block_minutes": block_minutes or 5, "blocks": []}
    duration = max(float(s.get("end", 0)) for s in scenes)
    bm = pick_block_minutes(duration, block_minutes)
    blocks = _group_scenes(scenes, bm)

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    indexed = list(enumerate(blocks))
    chunks = [indexed[i:i + BLOCKS_PER_CALL] for i in range(0, len(indexed), BLOCKS_PER_CALL)]
    for ci, chunk in enumerate(chunks):
        try:
            _summarize_chunk(client, chunk)
        except Exception as e:
            print(f"   (블록 요약 실패, 기본 라벨 유지: {str(e)[:80]})")
        if on_progress:
            on_progress(ci + 1, len(chunks))

    for b in blocks:
        b.pop("_scenes", None)
    return {"block_minutes": bm, "blocks": blocks}


def upload_to_gcs(local_path: Path, media_id: str, bucket: Optional[str] = None) -> bool:
    """analysis/{media_id}/timeline.json 으로 업로드. 버킷/라이브러리 없으면 조용히 스킵."""
    bucket = bucket or os.environ.get("GCS_BUCKET")
    if not bucket or not media_id:
        return False
    try:
        from google.cloud import storage  # optional dep: google-cloud-storage
        storage.Client().bucket(bucket).blob(f"analysis/{media_id}/{local_path.name}").upload_from_filename(str(local_path))
        print(f"   GCS 업로드 → gs://{bucket}/analysis/{media_id}/{local_path.name}")
        return True
    except Exception as e:
        print(f"   (GCS 업로드 스킵: {str(e)[:80]})")
        return False


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.timeline <scenes.json> [--block-minutes N] [--out <path>] [--gcs-media-id <id>]")
        sys.exit(1)
    src = Path(sys.argv[1])
    bm = int(sys.argv[sys.argv.index("--block-minutes") + 1]) if "--block-minutes" in sys.argv else None
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else src.parent / "timeline.json"

    scenes = json.loads(src.read_text(encoding="utf-8"))
    print(f"타임라인 분석: {len(scenes)} 장면 · 모델 {MODEL} (Vertex AI {PROJECT}/{LOCATION})")
    result = build_timeline(scenes, block_minutes=bm,
                            on_progress=lambda d, t: print(f"   요약 배치 {d}/{t}"))
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== 타임라인 ({result['block_minutes']}분 단위 · {len(result['blocks'])} 블록) ===")
    for b in result["blocks"]:
        who = ", ".join(b["on_screen_names"][:5]) or "—"
        print(f"  [{_fmt(b['start'])}~{_fmt(b['end'])}] {b['label']} · 씬 {b['scene_count']} · {who}")
        if b["summary"]:
            print(f"      {b['summary'][:100]}")
    print(f"  → {out}")

    if "--gcs-media-id" in sys.argv:
        upload_to_gcs(out, sys.argv[sys.argv.index("--gcs-media-id") + 1])


if __name__ == "__main__":
    main()

"""
STEP D Core — 출연진 포트레이트 + 인물 설명

cast.json(cast.py 출력: {people:[...]}) + scenes.json + scene_frames/ 를 받아:
  1. 인물별 대표 씬(이름자막이 찍힌 씬 중 vision_score 최고, 동률이면 최초)을 골라
     그 프레임을 scene_frames/portrait_{이름}.jpg 로 복사 (얼굴 크롭 없음 — 씬 프레임 그대로)
  2. Gemini Vision으로 프레임 + 이름 + 대화 맥락 기반 인물 설명 생성
  3. cast.json의 people[]에 thumbnail / description / total_appearances /
     first_seen / last_seen 을 채워 다시 저장 (portraitsGenerated 마커 포함)

비용: 인물당 Gemini 1호출, 상한 PORTRAITS_MAX(기본 12)명 — matched 우선(cast.py가
이미 그 순서로 정렬함). cast가 없거나 비면 no-op.

GCS: 워커 경로에서는 content-pipeline.ts(persistArtifacts)가 scene_frames/*.jpg와
cast.json을 analysis/{mediaId}/로 올린다. 단독 실행 시 --gcs-media-id로 직접 업로드.

Run:
    python -m core.portraits core/cast.json core/scenes.json [--limit N] [--gcs-media-id m_xxxx]
"""
import json
import os
import re
import shutil
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

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
from core.common.models import PORTRAITS as MODEL
from core.common.retry import call_with_retry
MAX_PORTRAITS = int(os.environ.get("PORTRAITS_MAX") or 12)

PROMPT = """이 이미지는 한국어 방송의 한 장면이고, 화면 속 인물 중 "{name}"{role_hint}이(가) 등장한다.
아래 정보를 참고해 이 인물을 소개하는 설명을 한국어 2~3문장으로 작성하라.

- 화면에서 관찰되는 모습(표정·행동·분위기)과 대화 맥락에서 드러나는 성격/역할을 담아라.
- 장면과 대사에 근거한 내용만 쓰고, 확인할 수 없는 사실(본명·나이·경력 등)은 지어내지 마라.

이 인물이 등장한 장면들의 대사 발췌:
{dialogues}"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {"description": {"type": "STRING"}},
    "required": ["description"],
}

_UNSAFE = re.compile(r"[\\/:*?\"<>|\s]+")


def _safe_name(name: str) -> str:
    return _UNSAFE.sub("_", str(name or "").strip()) or "unknown"


def _fmt(sec: float) -> str:
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def _people(cast) -> list[dict]:
    """cast.py 출력({people:[...]})과 bare list 둘 다 허용. 없으면 []."""
    if isinstance(cast, dict):
        return cast.get("people") or []
    if isinstance(cast, list):
        return cast
    return []


def _person_scene_ids(person: dict) -> list:
    ids = []
    for a in person.get("appearances") or []:
        ids.extend(a.get("scenes") or [])
    return ids


def _pick_scene(person: dict, by_index: dict) -> Optional[dict]:
    """대표 씬: 인물의 등장 씬 중 프레임이 있는 것에서 vision_score 최고, 동률이면 최초."""
    candidates = [by_index[i] for i in _person_scene_ids(person) if i in by_index and by_index[i].get("frame")]
    if not candidates:
        return None
    return max(candidates, key=lambda s: (s.get("vision_score") or 0, -float(s.get("start", 0))))


def _dialogue_context(person: dict, by_index: dict, max_lines: int = 8) -> str:
    lines = []
    for i in _person_scene_ids(person):
        s = by_index.get(i)
        if not s:
            continue
        text = (s.get("text") or "").strip()
        if text:
            lines.append(f"[{_fmt(float(s.get('start', 0)))}] {text[:80]}")
        if len(lines) >= max_lines:
            break
    return "\n".join(lines) or "(대사 없음 — 화면만으로 판단)"


def _describe(client, frame_path: Path, person: dict, dialogues: str) -> str:
    role = person.get("role") or ""
    prompt = PROMPT.format(name=person.get("name", ""), role_hint=f"({role})" if role else "", dialogues=dialogues)
    # call_with_retry 로 감싼다 — usage 집계가 그 안에만 있다(직접 호출 시 비용 누락).
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=frame_path.read_bytes(), mime_type="image/jpeg"),
            prompt,
        ],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=SCHEMA,
            max_output_tokens=1024,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    ))
    return str(json.loads(resp.text or "{}").get("description", "")).strip()


def build_portraits(
    cast,
    scenes: list[dict],
    base_dir: Path,
    limit: int = MAX_PORTRAITS,
    on_progress: Optional[Callable[[int, int], None]] = None,
):
    """cast를 in-place 보강해 반환. 포트레이트는 base_dir/scene_frames/에 쓴다.
    scene["frame"] 경로는 base_dir 기준 상대경로(scenes.py 규약)."""
    people = _people(cast)
    if not people:
        print("   (출연진 없음 — 포트레이트 스킵)")
        return cast

    by_index = {s.get("index"): s for s in scenes if s.get("index") is not None}
    frames_dir = base_dir / "scene_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    # 모든 인물에 등장 통계는 채운다 (모델 호출 없음, 공짜)
    for p in people:
        spans = p.get("appearances") or []
        p["total_appearances"] = len(spans)
        p["first_seen"] = min((float(a["start"]) for a in spans), default=None)
        p["last_seen"] = max((float(a["end"]) for a in spans), default=None)

    # 포트레이트+설명은 상위 limit명만 (cast.py가 matched 우선·화면시간순으로 정렬해 둠)
    targets = [p for p in people if p.get("appearances")][:limit]
    done = 0
    for p in targets:
        scene = _pick_scene(p, by_index)
        if scene is None:
            done += 1
            if on_progress:
                on_progress(done, len(targets))
            continue
        src = base_dir / scene["frame"]
        fname = f"portrait_{_safe_name(p.get('name', ''))}.jpg"
        try:
            if src.exists():
                shutil.copyfile(src, frames_dir / fname)
                p["thumbnail"] = fname
        except OSError as e:
            print(f"   (포트레이트 복사 실패 {p.get('name')}: {str(e)[:60]})")
        if p.get("thumbnail") and not p.get("description"):
            try:
                p["description"] = _describe(client, frames_dir / fname, p, _dialogue_context(p, by_index))
            except Exception as e:
                print(f"   (설명 생성 실패 {p.get('name')}: {str(e)[:60]})")
        done += 1
        if on_progress:
            on_progress(done, len(targets))

    if isinstance(cast, dict):
        cast["portraitsGenerated"] = True
    return cast


def upload_to_gcs(base_dir: Path, cast_path: Path, media_id: str, bucket: Optional[str] = None) -> bool:
    """portrait_*.jpg + cast.json 을 analysis/{media_id}/ 로 업로드. 불가하면 조용히 스킵."""
    bucket = bucket or os.environ.get("GCS_BUCKET")
    if not bucket or not media_id:
        return False
    try:
        from google.cloud import storage  # optional dep: google-cloud-storage
        b = storage.Client().bucket(bucket)
        n = 0
        for f in sorted((base_dir / "scene_frames").glob("portrait_*.jpg")):
            b.blob(f"analysis/{media_id}/scene_frames/{f.name}").upload_from_filename(str(f))
            n += 1
        b.blob(f"analysis/{media_id}/cast.json").upload_from_filename(str(cast_path))
        print(f"   GCS 업로드 → gs://{bucket}/analysis/{media_id}/ (포트레이트 {n}장 + cast.json)")
        return True
    except Exception as e:
        print(f"   (GCS 업로드 스킵: {str(e)[:80]})")
        return False


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: python -m core.portraits <cast.json> <scenes.json> [--limit N] [--gcs-media-id <id>]")
        sys.exit(1)
    cast_path, scenes_path = Path(sys.argv[1]), Path(sys.argv[2])
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else MAX_PORTRAITS

    try:
        cast = json.loads(cast_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"cast.json 없음/손상 — 종료: {str(e)[:80]}")
        return
    scenes = json.loads(scenes_path.read_text(encoding="utf-8"))

    people = _people(cast)
    print(f"포트레이트 생성: 출연진 {len(people)}명 (상한 {limit}) · 모델 {MODEL}")
    cast = build_portraits(cast, scenes, scenes_path.parent, limit=limit,
                           on_progress=lambda d, t: print(f"   인물 {d}/{t}"))
    cast_path.write_text(json.dumps(cast, ensure_ascii=False, indent=2), encoding="utf-8")

    for p in _people(cast):
        thumb = p.get("thumbnail") or "—"
        desc = (p.get("description") or "")[:60]
        print(f"  {p.get('name'):<10} {thumb:<24} {desc}")
    print(f"  → {cast_path}")

    if "--gcs-media-id" in sys.argv:
        upload_to_gcs(scenes_path.parent, cast_path, sys.argv[sys.argv.index("--gcs-media-id") + 1])


if __name__ == "__main__":
    main()

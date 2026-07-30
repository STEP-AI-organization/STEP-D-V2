"""Batch swap · 각 shorts 마다 reference 템플릿 하나 골라서 swap.

사용자 지시 (2026-07-28):
"각각 추천 쇼츠에서 썸네일을 템플릿 중 하나를 골라서 그거 기반 EDIT 로 썸네일 생성 ·
 기존 제목·기존 얼굴 사용 금지 · 모두 바꿈"

흐름:
1. narrative.json 모든 segment 로드
2. assets/thumbnail-reference/*.png|*.jpg 모든 reference 로드 · Vision 으로 각 reference 의 인물 수·톤 프로파일
3. Planner 1회 호출:
   - 입력: shorts 목록 + reference 목록 + 등록 인물
   - 출력: 각 shorts 별 {reference_id, featured_cast, caption}
4. 각 항목마다 swap.py 호출 → segment 별 썸네일 저장
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from google import genai
from google.genai import types

from . import swap as SW
from . import person_compositor as PC
from .planner import load_shorts_slice

REF_DIR = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-reference"
from ..models import TEXT as MODEL
LOCATION = "asia-northeast3"


PLANNER_SYSTEM = """너는 한국 방송사 유튜브 썸네일 배분 기획자다.

주어진 것:
- 여러 shorts segment (각각 이 영상의 하이라이트 구간)
- 여러 reference 썸네일 (실제 방송사 완성작)
- 등록된 인물 목록 (썸네일 사용 가능)

너의 일: 각 shorts 마다 최적의 reference 템플릿 하나를 고르고, 그 템플릿에 얹을
- featured_cast: 인물 이름 배열 (**등록 목록 안에서만** · reference 의 인물 수와 근접)
- caption: 이 shorts 를 대표할 **하단 메인 카피 한 문장** · reference 원본 자막은 통째 교체됨
  · 핵심 + 어그로 · 감상형 X · 이모지 X
  · 10~18자 · 정보 충분 (너무 짧으면 안 됨 · "웹디? 한의사?" 같은 5자 이하 X)
  · 실제 shorts 대사·순간에서 근거 · 원본 reference 문장 재사용 절대 X

reference 선택 원칙:
- reference 인물 수와 shorts 화자 수 비슷하게 (2인 대화면 2인 reference, 리액션이면 3인 reference)
- 이미 사용한 reference 는 가능하면 다음 shorts 에서 다른 것 선택 (다양성)

출력 JSON:
{
  "assignments": [
    {"shorts_index": 0, "reference_id": "ref_001", "featured_cast": ["민경","백현"], "caption": "..."},
    {"shorts_index": 1, "reference_id": "ref_002", "featured_cast": ["윤녕"], "caption": "..."}
  ]
}
"""


def _gemini_client(project: str | None = None) -> genai.Client:
    return genai.Client(vertexai=True,
                         project=project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d"),
                         location=LOCATION)


def _plan_assignments(shorts: list[dict], references: list[dict],
                       available_cast: list[str], project: str | None) -> list[dict]:
    """Planner 1회 호출 · 각 shorts 별 assignment 결정."""
    if not shorts or not references:
        return []
    lines = ["[shorts 목록]"]
    for i, s in enumerate(shorts):
        lines.append(f"  {i}. [{s.get('start',0):.0f}-{s.get('end',0):.0f}s] title={s.get('title','')}")
        lines.append(f"     summary: {(s.get('summary') or '')[:200]}")
        if s.get("key_moments"):
            for k in s["key_moments"][:3]:
                lines.append(f"       · {k}")
        if s.get("transcript_sample"):
            for t in s["transcript_sample"][:6]:
                lines.append(f"       · {t}")
    lines.append("")
    lines.append("[reference 템플릿 목록]")
    for r in references:
        lines.append(f"  - {r['id']}: {r.get('description','(설명 없음)')}")
    lines.append("")
    lines.append(f"[등록 인물]  {', '.join(available_cast) if available_cast else '(없음)'}")
    lines.append("")
    lines.append("각 shorts_index 별로 assignment 를 결정해 JSON 만 출력.")

    schema = {
        "type": "OBJECT",
        "properties": {
            "assignments": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "shorts_index": {"type": "INTEGER"},
                        "reference_id": {"type": "STRING", "enum": [r["id"] for r in references]},
                        "featured_cast": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "caption": {"type": "STRING"},
                    },
                    "required": ["shorts_index", "reference_id", "featured_cast", "caption"],
                },
            },
        },
        "required": ["assignments"],
    }
    client = _gemini_client(project)
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user",
                                parts=[types.Part.from_text(text="\n".join(lines))])],
        config=types.GenerateContentConfig(
            system_instruction=PLANNER_SYSTEM,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.9,
            max_output_tokens=4096,
        ),
    )
    if not resp.text:
        return []
    try:
        return (json.loads(resp.text).get("assignments") or [])
    except Exception:
        return []


def _load_shorts(media_dir: pathlib.Path) -> list[dict]:
    """narrative.json 의 segments 를 shorts 로 사용 (transcript sample 포함)."""
    nar_p = media_dir / "narrative.json"
    if not nar_p.exists():
        return []
    nar = json.loads(nar_p.read_text(encoding="utf-8"))
    if not isinstance(nar, dict):
        return []
    out: list[dict] = []
    for seg in nar.get("segments", []) or []:
        start = seg.get("start", 0); end = seg.get("end", 0)
        sl = load_shorts_slice(media_dir, {"start": start, "end": end}) or {}
        out.append({
            "start": start, "end": end,
            "title": seg.get("title", ""),
            "summary": seg.get("summary", ""),
            "characters": seg.get("characters", []) or [],
            "key_moments": sl.get("key_moments") or seg.get("key_moments") or [],
            "transcript_sample": (sl.get("transcript_lines") or [])[:10],
        })
    return out


def _load_references() -> list[dict]:
    """assets/thumbnail-reference/*.png|jpg + style_profile.json 조합."""
    if not REF_DIR.exists():
        return []
    refs: list[dict] = []
    style_p = REF_DIR / "style_profile.json"
    style = {}
    if style_p.exists():
        try:
            style = json.loads(style_p.read_text(encoding="utf-8"))
        except Exception:
            pass
    for p in sorted(REF_DIR.glob("*")):
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        refs.append({
            "id": p.stem,
            "path": p,
            "description": style.get(p.stem, ""),
        })
    return refs


def batch_swap(media_dir: pathlib.Path, out_dir: pathlib.Path, project: str | None = None):
    out_dir.mkdir(parents=True, exist_ok=True)
    shorts = _load_shorts(media_dir)
    references = _load_references()
    if not shorts:
        print("[FAIL] narrative.json 없음 or empty", file=sys.stderr); return 2
    if not references:
        print(f"[FAIL] {REF_DIR} 에 reference 없음", file=sys.stderr); return 2

    # 등록 인물
    cast_dir = media_dir / "cast_photos"
    available_cast: list[str] = []
    if cast_dir.exists():
        exts = {".jpg", ".jpeg", ".png", ".webp"}
        available_cast = sorted({p.stem for p in cast_dir.iterdir() if p.suffix.lower() in exts})

    print(f"[batch_swap] shorts={len(shorts)} · references={len(references)} · cast={available_cast}")

    # Planner: 각 shorts 별 assignment
    assignments = _plan_assignments(shorts, references, available_cast, project)
    print(f"[batch_swap] Planner assignments: {len(assignments)}")
    for a in assignments:
        print(f"  · shorts#{a['shorts_index']} → {a['reference_id']} · cast={a.get('featured_cast')} · caption={a.get('caption')}")

    # ref_id → path
    ref_by_id = {r["id"]: r for r in references}
    # 각 assignment 병렬 실행
    def _do(a):
        idx = a.get("shorts_index", 0)
        ref = ref_by_id.get(a.get("reference_id"))
        if not ref:
            return {"idx": idx, "status": "no_ref"}
        # 인물 사진 조회
        names = a.get("featured_cast") or []
        photos: list[pathlib.Path] = []
        resolved: list[str] = []
        for nm in names:
            d = PC.derive_person_source(nm, media_dir)
            if d and d.exists():
                photos.append(d); resolved.append(nm); continue
            if cast_dir.exists():
                for ext in ("jpg","jpeg","png","webp"):
                    p = cast_dir / f"{nm}.{ext}"
                    if p.exists():
                        photos.append(p); resolved.append(nm); break
        if not photos:
            return {"idx": idx, "status": "no_photos"}
        try:
            img = SW.swap_thumbnail(reference=ref["path"], cast_photos=photos,
                                     cast_names=resolved, caption=a.get("caption",""))
        except Exception as e:
            return {"idx": idx, "status": "swap_fail", "err": str(e)[:200]}
        if not img:
            return {"idx": idx, "status": "no_image"}
        dest = out_dir / f"shorts_{idx:02d}_{ref['id']}.png"
        dest.write_bytes(img)
        return {"idx": idx, "status": "ok", "path": str(dest)}

    if not assignments:
        # 폴백: 각 shorts × 첫 reference · 등록 cast 앞 2명
        print("[batch_swap] fallback · round-robin references + first 2 cast", file=sys.stderr)
        fallback_cast = available_cast[:2]
        for i, s in enumerate(shorts):
            assignments.append({
                "shorts_index": i,
                "reference_id": references[i % len(references)]["id"],
                "featured_cast": fallback_cast,
                "caption": (s.get("title") or f"shorts {i+1}")[:18],
            })

    max_w = max(1, min(3, len(assignments)))
    with ThreadPoolExecutor(max_workers=max_w) as ex:
        futs = [ex.submit(_do, a) for a in assignments]
        results = [f.result() for f in as_completed(futs)]

    print("\n=== 결과 ===")
    for r in sorted(results, key=lambda x: x.get("idx", 999)):
        print(f"  shorts#{r.get('idx')} · {r.get('status')} · {r.get('path','')} {r.get('err','')}")
    (out_dir / "batch_log.json").write_text(json.dumps({
        "shorts": shorts, "assignments": assignments, "results": results,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return 0 if any(r.get("status") == "ok" for r in results) else 2


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-dir", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    media = pathlib.Path(args.media_dir).resolve()
    out = pathlib.Path(args.out).resolve() if args.out else \
          pathlib.Path("logs/thumbnail-batch-swap") / time.strftime("%Y%m%d-%H%M%S")
    sys.exit(batch_swap(media, out))

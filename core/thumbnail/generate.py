"""회차 1건 → 썸네일 후보 (서비스 경로).

scripts/thumbnail_engine_run.py 와 같은 4단계지만, 워커가 부를 수 있도록
경로·프로그램 ID 를 인자로 받고 결과를 dict 로 돌려준다.

    1) 기획   영상 내용 → 제목·인물·장면        (Gemini 1회)
    2) 인물   등록부에서 사진 꺼내기            (사람이 등록 · 없으면 중단)
    3) 배경   검색 구간 → 프레임 1장            (검색 실패 시 기획 시점으로 폴백)
    4) 생성   사진 3~5장 + 한국어 한 줄
"""
from __future__ import annotations

import json
import pathlib
import subprocess
from typing import Any, Optional


def _extract_frame(video: pathlib.Path, sec: float, dest: pathlib.Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["ffmpeg", "-y", "-ss", str(sec), "-i", str(video),
         "-frames:v", "1", "-q:v", "2", str(dest)],
        capture_output=True,
    )
    return r.returncode == 0 and dest.exists()


def _frame_meta(path: pathlib.Path, sec: float,
                logo_windows: list[tuple[float, float]]) -> dict:
    import numpy as np
    from PIL import Image

    im = Image.open(path)
    w, h = im.size
    a = np.asarray(im.convert("L")).astype(float)
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1]
           + a[1:-1, :-2] + a[1:-1, 2:])
    return {
        "path": str(path), "sec": sec,
        "sharpness": round(float(min(lap.var() / 2000.0, 1.0)), 3),
        "hasLogo": any(s <= sec <= e for s, e in logo_windows),
        "width": w, "height": h, "faces": [],
    }


def run(
    media_id: str,
    program_id: str,
    analysis_dir: pathlib.Path,
    out_dir: pathlib.Path,
    program_title: str = "",
    video_path: Optional[pathlib.Path] = None,
    candidates: int = 3,
    api_base: Optional[str] = None,
) -> dict[str, Any]:
    from core.thumbnail.cast_registry import how_to_register, resolve_plan_people
    from core.thumbnail.paths import program_title as stored_title
    from core.thumbnail.plan import build_plan
    from core.thumbnail.simple_gen import build_prompt, generate, load_style
    from core.thumbnail.sourcing import find_background, sample_secs, search_windows

    out_dir.mkdir(parents=True, exist_ok=True)
    title = program_title or stored_title(program_id)

    # ── 1) 기획 ───────────────────────────────────────────────────────────
    narrative = json.loads((analysis_dir / "narrative.json").read_text(encoding="utf-8"))
    characters = narrative.get("characters") or []
    plan = build_plan(
        summary=(narrative.get("full_summary") or "")[:6000],
        cast_names=[c.get("name") for c in characters
                    if isinstance(c, dict) and c.get("name")],
    )
    (out_dir / "plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── 2) 인물 (등록부) ──────────────────────────────────────────────────
    briefs = plan.get("people") or []
    person_paths, missing = resolve_plan_people(program_id, briefs)
    if missing:
        # 없는 인물을 넣으면 모델이 지어낸다 — 생성하지 않고 등록을 요구한다.
        return {"ok": False, "mediaId": media_id, "plan": plan,
                "error": "cast_not_registered", "missing": missing,
                "hint": how_to_register(program_id)}

    # ── 3) 배경 프레임 ────────────────────────────────────────────────────
    bg_brief = plan.get("background") or {}
    bg_path: Optional[pathlib.Path] = None
    bg_picks: list[dict] = []
    if video_path and video_path.exists():
        ppl_p = analysis_dir / "ppl.json"
        logo_windows = []
        if ppl_p.exists():
            ppl = json.loads(ppl_p.read_text(encoding="utf-8"))
            logo_windows = [(d.get("start", 0.0), d.get("end", 0.0))
                            for d in (ppl.get("detections") or [])]

        query = bg_brief.get("scene") or plan.get("concept") or ""
        try:
            windows = search_windows(query, media_id=media_id, limit=8, api_base=api_base)
        except Exception:
            windows = []          # 검색이 죽어도 파이프라인 전체가 멈추면 안 된다
        if not windows:
            at = float(bg_brief.get("atSec") or 0.0)
            windows = [{"start": max(0.0, at - 4), "end": at + 4}]

        frames = []
        for i, sec in enumerate(sample_secs(windows, per_window=2)[:14]):
            dest = out_dir / "frames" / f"f_{i:02d}_{sec:.1f}.jpg"
            if _extract_frame(video_path, sec, dest):
                frames.append(_frame_meta(dest, sec, logo_windows))
        bg_picks = find_background(frames, bg_brief, top=3)
        if bg_picks:
            bg_path = pathlib.Path(bg_picks[0]["path"])

    # ── 4) 생성 ───────────────────────────────────────────────────────────
    style_block, style_refs = load_style(program_id)
    prompt = build_prompt(plan, title, bg_path is not None, style_block, len(style_refs))

    imgs = generate(person_paths, plan, background_path=bg_path,
                    program_title=title, n=candidates)
    if not imgs:
        return {"ok": False, "mediaId": media_id, "error": "generation_failed",
                "prompt": prompt}

    files = []
    for k, img in enumerate(imgs, 1):
        dest = out_dir / f"thumb_{k}.png"
        dest.write_bytes(img)
        files.append(str(dest))

    return {
        "ok": True, "mediaId": media_id, "programId": program_id,
        "title1": plan.get("title1"), "title2": plan.get("title2"),
        "people": [str(p) for p in person_paths],
        "background": str(bg_path) if bg_path else None,
        "backgroundCandidates": bg_picks[:3],
        "styleApplied": bool(style_block),
        "prompt": prompt,
        "files": files,
    }

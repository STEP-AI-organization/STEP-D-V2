"""
STEP D Core — Scene frame analysis (Gemini Vision on Vertex AI)

ONE call per representative frame answers BOTH questions that used to be two
separate passes (vision scoring + names.py OCR):

  1. 숏폼 가치 (시각): vision_score / vision_reason / vision_tags — dialogue-blind
     scoring that catches reaction shots, sight gags, and inserts.
  2. 번인 텍스트: on_screen_names (인물 이름 자막) / on_screen_text (기타 화면 텍스트)
     — the identity anchor broadcast editors already burned in.

Merging them halves the Gemini image traffic (N frames = N calls, not 2N): the
model reads each frame once and answers both.

Resume-aware: scenes that already carry BOTH results are skipped, so a re-run
after a crash only pays for what's missing. Pass save_cb to checkpoint scenes.json
periodically while scoring.

Reads/writes scenes.json in place (same as before) so the admin Lab picks it up.
Auth: ADC. Vertex Seoul (frames carry identifiable people — keep in-country).

Run:
    python -m core.vision core/scenes.json
    python -m core.vision core/scenes.json --limit 10   # 처음 10개만 (테스트)
"""
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
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
# Seoul: frames carry identifiable Korean people (biometric/sensitive data), so keep
# them in-country to avoid a cross-border transfer with no PIPA basis. Vertex serves
# gemini-2.5-flash here.
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
WORKERS = 6  # concurrent Vertex calls — enough to be quick, gentle on quota
SAVE_EVERY = 20  # scenes between checkpoint saves (bounds re-work after a crash)

PROMPT = """이 이미지는 한국어 방송의 한 장면(대표 프레임)이다. 아래 두 가지를 한 번에 수행하라.

[1] 숏폼 가치 평가 — 이 장면을 숏폼 클립으로 쓸 가치를 '시각적으로만' 평가하라.
대사가 없어도 화면만으로 의미가 크면 높게 준다.
- 표정·리액션 (놀람·폭소·정색·오열 등 강한 감정)
- 움직임·액션·몸개그
- 화면에 박힌 방송 자막(편집자가 이미 중요하다고 표시한 신호 → 가점)
- 구도(클로즈업/강조)와 상황의 흥미도
- 단순 인트로/전환/평범한 대화 화면이면 낮게
→ score(0-100), reason(한국어 한 문장), tags(리액션/표정/액션/자막/구도/정적/전환/기타 중 1~3개)

[2] 화면에 박힌(번인된) 텍스트 추출 — 말로 하는 대사는 제외, 화면에 글자로 있는 것만.
- on_screen_names: 인물 이름 자막으로 보이는 것만 (하단 이름표/로워서드, 순위표의 이름 등).
  사람 이름이 아니면 넣지 마라.
- other_text: 그 외 화면 텍스트 (프로그램 제목, 상황 자막, 순위 숫자, 예능 밈 자막 등).
없으면 빈 배열."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "score": {"type": "INTEGER"},
        "reason": {"type": "STRING"},
        "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
        "on_screen_names": {"type": "ARRAY", "items": {"type": "STRING"}},
        "other_text": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["score", "reason", "tags", "on_screen_names", "other_text"],
}


def analyze_frame(client, frame_path: Path, dialogue: str) -> dict:
    img = frame_path.read_bytes()
    context = f"\n\n참고 — 이 장면에서 들리는 대사: \"{dialogue}\"" if dialogue else "\n\n(이 장면은 대사가 없다. 화면만으로 판단하라.)"
    resp = client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=img, mime_type="image/jpeg"),
            PROMPT + context,
        ],
        config=types.GenerateContentConfig(
            temperature=0,  # deterministic: a re-run scores the same frame the same way
            response_mime_type="application/json",
            response_schema=SCHEMA,
        ),
    )
    return json.loads(resp.text)


def _frame_done(scene: dict) -> bool:
    """Both halves present = this scene survived a previous run — skip on resume.
    A failed scene (vision_score=None) is retried."""
    return scene.get("vision_score") is not None and "on_screen_names" in scene


def analyze_frames(
    scenes: list[dict],
    base_dir: Path,
    limit: int | None = None,
    save_cb: Optional[Callable[[], None]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[dict]:
    """Score + extract burned-in text for every scene frame not yet analyzed.

    save_cb: called (under the internal lock) every SAVE_EVERY completions and at the
    end — the caller persists scenes.json so a crash loses at most SAVE_EVERY calls.
    """
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    targets = [s for s in scenes if s.get("frame") and not _frame_done(s)]
    if limit:
        targets = targets[:limit]
    total = len(targets)
    skipped = sum(1 for s in scenes if s.get("frame") and _frame_done(s))
    if skipped:
        print(f"   (재개: 이미 분석된 {skipped} 장면 스킵)")
    if not total:
        return scenes

    done = [0]
    lock = threading.Lock()  # guards scene-dict writes + counter + save_cb snapshots

    def work(scene: dict) -> None:
        frame = base_dir / scene["frame"]
        try:
            r = analyze_frame(client, frame, scene.get("text", ""))
            with lock:
                scene["vision_score"] = int(r.get("score", 0))
                scene["vision_reason"] = (r.get("reason") or "").strip()
                scene["vision_tags"] = r.get("tags", [])[:3]
                scene["on_screen_names"] = [n.strip() for n in r.get("on_screen_names", []) if n.strip()]
                scene["on_screen_text"] = [t.strip() for t in r.get("other_text", []) if t.strip()]
                scene.pop("_frame_error", None)
        except Exception as e:
            with lock:
                scene["vision_score"] = None
                scene["vision_reason"] = f"(평가 실패: {str(e)[:80]})"
                scene["vision_tags"] = []
                scene["on_screen_names"] = []
                scene["on_screen_text"] = []
                scene["_frame_error"] = str(e)[:80]
        with lock:
            done[0] += 1
            n = done[0]
            if save_cb and (n % SAVE_EVERY == 0 or n == total):
                try:
                    save_cb()
                except Exception as e:
                    print(f"   (체크포인트 저장 실패: {str(e)[:80]})")
        if n % 10 == 0 or n == total:
            print(f"   analyzed {n}/{total}")
        if on_progress:
            on_progress(n, total)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(work, targets))

    # Every single call failing means Vertex itself is down, not a bad frame — raise so
    # the job retries (failed scenes keep vision_score=None and are redone on resume)
    # instead of completing with an unscored timeline.
    failures = sum(1 for s in targets if s.get("_frame_error"))
    if total and failures == total:
        raise RuntimeError(f"frame analysis: all {total} Gemini calls failed (Vertex outage?)")

    return scenes


# Back-compat alias: analyze.py < 2026-07 imported score_scenes (scoring-only pass).
score_scenes = analyze_frames


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.vision <scenes.json> [--limit N]")
        sys.exit(1)

    src = Path(sys.argv[1])
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    scenes = json.loads(src.read_text(encoding="utf-8"))
    n = min(len(scenes), limit) if limit else len(scenes)
    print(f"프레임 분석(시각채점+이름자막): {n} 장면 · 모델 {MODEL} (Vertex AI {PROJECT}/{LOCATION})")

    def save() -> None:
        src.write_text(json.dumps(scenes, ensure_ascii=False, indent=2), encoding="utf-8")

    # frame paths in scenes.json are relative to the video's folder (scenes.py wrote them there)
    scenes_out = analyze_frames(scenes, src.parent, limit=limit, save_cb=save)
    save()

    scored = [s for s in scenes_out if s.get("vision_score") is not None]
    if scored:
        top = sorted(scored, key=lambda s: s["vision_score"], reverse=True)[:5]
        print(f"\n완료: {len(scored)} 장면 분석")
        print("상위 5 장면 (시각 점수):")
        for s in top:
            tm = f"{int(s['start']//60)}:{int(s['start']%60):02d}"
            tags = "/".join(s.get("vision_tags", []))
            dlg = "무음" if not s.get("text") else "대사"
            print(f"  [{tm}] {s['vision_score']:3d}점 · {dlg} · {tags} — {s['vision_reason'][:45]}")

    with_name = [s for s in scenes_out if s.get("on_screen_names")]
    if with_name:
        from collections import Counter
        names = Counter(nm for s in with_name for nm in s["on_screen_names"])
        print(f"이름자막 있는 프레임: {len(with_name)}/{len(scored) or 1}")
        print(f"발견된 이름 (빈도순): {', '.join(f'{n}×{c}' for n, c in names.most_common(10))}")
    print(f"  → {src}")


if __name__ == "__main__":
    main()

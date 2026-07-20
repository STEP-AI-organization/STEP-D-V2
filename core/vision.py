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

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
# Seoul: frames carry identifiable Korean people (biometric/sensitive data), so keep
# them in-country to avoid a cross-border transfer with no PIPA basis. Vertex serves
# gemini-2.5-flash here.
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
WORKERS = 6  # concurrent Vertex calls — enough to be quick, gentle on quota
SAVE_EVERY = 20  # scenes between checkpoint saves (bounds re-work after a crash)
# A frame that fails this many times is treated as deterministically un-analyzable
# (safety block, persistent truncation) and permanently skipped, not retried forever.
MAX_FRAME_ATTEMPTS = 3

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
    # 429/503 일시 오류는 제자리 백오프 재시도 — 프레임별 MAX_FRAME_ATTEMPTS가 이미
    # 있으므로 attempts=3이면 충분하다.
    resp = call_with_retry(lambda: client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=img, mime_type="image/jpeg"),
            PROMPT + context,
        ],
        config=types.GenerateContentConfig(
            temperature=0,  # deterministic: a re-run scores the same frame the same way
            response_mime_type="application/json",
            response_schema=SCHEMA,
            max_output_tokens=2048,
            # No reasoning needed for a single-frame score + OCR — free the whole output
            # budget for JSON. Default dynamic thinking tokens were eating into it and
            # truncating text-heavy frames' on_screen_text arrays (→ json.loads crash).
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    ), attempts=3)
    # A blocked/empty response returns text=None; json.loads(None) would raise a confusing
    # TypeError. Treat it as an empty result so the caller marks the frame failed cleanly.
    return json.loads(resp.text or "{}")


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
    # Prior REAL Gemini successes — excludes prefilter's heuristic pre-fill (_prefiltered),
    # which sets vision_score/on_screen_names without ever calling Vertex. Only a genuine
    # prior success proves Vertex was reachable, so only this count may suppress the
    # cold-outage guard below.
    prior_success = sum(
        1 for s in scenes if s.get("frame") and _frame_done(s) and not s.get("_prefiltered")
    )
    if skipped:
        print(f"   (재개: 이미 분석된 {skipped} 장면 스킵)")
    if not total:
        return scenes

    done = [0]
    # 이번 실행의 성패 카운터 — _frame_error만 세면 MAX_FRAME_ATTEMPTS에 도달해 영구
    # 스킵된 프레임이 빠져나가, 지속 아웃티지가 3번째 재시도에서 전량 0점으로 통과한다.
    run_success = [0]
    run_fail = [0]
    lock = threading.Lock()  # guards scene-dict writes + counter + save_cb snapshots

    def work(scene: dict) -> None:
        frame = base_dir / scene["frame"]
        try:
            r = analyze_frame(client, frame, scene.get("text", ""))
            with lock:
                run_success[0] += 1
                scene["vision_score"] = int(r.get("score", 0))
                scene["vision_reason"] = (r.get("reason") or "").strip()
                scene["vision_tags"] = r.get("tags", [])[:3]
                scene["on_screen_names"] = [n.strip() for n in r.get("on_screen_names", []) if n.strip()]
                scene["on_screen_text"] = [t.strip() for t in r.get("other_text", []) if t.strip()]
                scene.pop("_frame_error", None)
        except Exception as e:
            with lock:
                run_fail[0] += 1
                attempts = int(scene.get("_frame_attempts", 0)) + 1
                scene["_frame_attempts"] = attempts
                scene["vision_tags"] = []
                scene["on_screen_names"] = []
                scene["on_screen_text"] = []
                if attempts >= MAX_FRAME_ATTEMPTS:
                    # Deterministically un-analyzable (safety block, persistent truncation).
                    # Mark it permanently skipped (score 0, both halves present) so it
                    # satisfies _frame_done and stops being retried forever — one bad frame
                    # must never dead-letter a 200-frame analysis.
                    scene["vision_score"] = 0
                    scene["vision_reason"] = f"(분석 불가 · {attempts}회 실패: {str(e)[:60]})"
                    scene.pop("_frame_error", None)
                else:
                    scene["vision_score"] = None
                    scene["vision_reason"] = f"(평가 실패: {str(e)[:80]})"
                    scene["_frame_error"] = str(e)[:80]
        with lock:
            done[0] += 1
            n = done[0]
            if save_cb and (n % SAVE_EVERY == 0 or n == total):
                try:
                    save_cb()
                except Exception as e:
                    print(f"   (체크포인트 저장 실패: {str(e)[:80]})\n", end="", flush=True)
        if n % 10 == 0 or n == total:
            # 워커 스레드 출력 — 페이로드에 \n을 포함한 단일 write여야 @@PROGRESS 줄과 안 섞인다.
            print(f"   analyzed {n}/{total}\n", end="", flush=True)
        if on_progress:
            on_progress(n, total)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(work, targets))

    # Distinguish a real Vertex outage from a poison frame. Only a COLD start where every
    # call failed and Gemini had never once succeeded (prior_success == 0) is treated as an
    # outage worth failing the job for. If earlier frames already scored (prior_success > 0),
    # a remaining all-fail is a handful of un-analyzable frames — they exhaust
    # MAX_FRAME_ATTEMPTS and get permanently skipped above, so we must NOT raise (that would
    # dead-letter the whole run). Prefiltered heuristic scores don't count as successes:
    # with VISION_PREFILTER=on they always exist, so gating on `skipped` here would silently
    # disable outage retry on the common path. run_success 카운터 기준: _frame_error만 세면
    # 이번 실행에 MAX_FRAME_ATTEMPTS를 소진해 영구 스킵된 프레임이 빠져, 지속 아웃티지의
    # 3번째 잡 재시도가 전량 0점으로 조용히 통과해 버린다.
    if total and run_success[0] == 0 and prior_success == 0:
        # 콜드 아웃티지: 이번 실행에서 영구 스킵으로 굳힌 프레임을 재시도 가능 상태로
        # 되돌린다 — 아웃티지 중 소진한 시도는 프레임 탓이 아니므로 카운트도 되돌린다.
        for s in targets:
            if str(s.get("vision_reason") or "").startswith("(분석 불가"):
                s["_frame_error"] = str(s.get("vision_reason"))[:80]
                s["vision_score"] = None
                s["_frame_attempts"] = max(0, int(s.get("_frame_attempts", 1)) - 1)
        if save_cb:
            try:
                save_cb()  # 복원을 체크포인트에 반영한 뒤에 실패시킨다
            except Exception as e:
                print(f"   (체크포인트 저장 실패: {str(e)[:80]})")
        raise RuntimeError(
            f"frame analysis: all {run_fail[0]}/{total} Gemini calls failed this run (Vertex outage?)"
        )

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

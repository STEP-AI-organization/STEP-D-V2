"""
STEP D Core — On-screen name-caption extraction (OCR anchor experiment)

Pulls burned-in text from each scene frame — especially person name captions
(lower-thirds). Broadcast variety shows brand each cast member with a name caption
on entry/interview cuts, which the CX plan calls the single strongest identity
anchor. This measures whether that's actually true here: how many scenes carry a
name caption (coverage), and which names show up.

This is a cheap validation of the plan's OCR-anchor claim, NOT the full identity
stack. Reuses the Gemini/Vertex setup (Seoul region, ADC).

Run:
    python -m core.names core/scenes.json
    python -m core.names core/scenes.json --limit 15
"""
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
WORKERS = 6

PROMPT = """이 예능/방송 프레임에 '화면에 박힌(번인된)' 텍스트를 추출하라. 자막 방송의 편집 텍스트다.
- on_screen_names: 인물 이름 자막으로 보이는 것만 (하단 이름표/로워서드, 순위표의 이름 등). 사람 이름이 아니면 넣지 마라.
- other_text: 그 외 화면 텍스트 (프로그램 제목, 상황 자막, 순위 숫자, 예능 밈 자막 등).
말로 하는 대사는 제외(화면에 글자로 있는 것만). 없으면 빈 배열."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "on_screen_names": {"type": "ARRAY", "items": {"type": "STRING"}},
        "other_text": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["on_screen_names", "other_text"],
}


def extract_frame(client, frame_path: Path) -> dict:
    img = frame_path.read_bytes()
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Part.from_bytes(data=img, mime_type="image/jpeg"), PROMPT],
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
            response_schema=SCHEMA,
        ),
    )
    return json.loads(resp.text)


def run(scenes: list[dict], base_dir: Path, limit: int | None = None) -> list[dict]:
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    targets = [s for s in scenes if s.get("frame")]
    if limit:
        targets = targets[:limit]
    total = len(targets)
    done = [0]

    def work(scene: dict) -> None:
        try:
            r = extract_frame(client, base_dir / scene["frame"])
            scene["on_screen_names"] = [n.strip() for n in r.get("on_screen_names", []) if n.strip()]
            scene["on_screen_text"] = [t.strip() for t in r.get("other_text", []) if t.strip()]
        except Exception as e:
            scene["on_screen_names"] = []
            scene["on_screen_text"] = []
            scene["_names_error"] = str(e)[:80]
        done[0] += 1
        if done[0] % 10 == 0 or done[0] == total:
            # 워커 스레드 출력 — \n 포함 단일 write로 원자화 (진행 로그 줄 섞임 방지)
            print(f"   {done[0]}/{total}\n", end="", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(work, targets))
    return scenes


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.names <scenes.json> [--limit N]")
        sys.exit(1)

    src = Path(sys.argv[1])
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None

    scenes = json.loads(src.read_text(encoding="utf-8"))
    n = min(len(scenes), limit) if limit else len(scenes)
    print(f"이름자막 추출: {n} 프레임 · {MODEL} (Vertex AI {PROJECT}/{LOCATION})")

    scenes = run(scenes, src.parent, limit=limit)
    src.write_text(json.dumps(scenes, ensure_ascii=False, indent=2), encoding="utf-8")

    checked = [s for s in scenes if "on_screen_names" in s]
    with_name = [s for s in checked if s["on_screen_names"]]
    names = Counter(nm for s in with_name for nm in s["on_screen_names"])

    print(f"\n=== OCR 앵커 검증 결과 ===")
    print(f"이름자막 있는 프레임: {len(with_name)}/{len(checked)} ({100*len(with_name)//max(1,len(checked))}%)")
    print(f"발견된 이름 (빈도순): {', '.join(f'{n}×{c}' for n, c in names.most_common(15))}")
    print(f"  → {src}")


if __name__ == "__main__":
    main()

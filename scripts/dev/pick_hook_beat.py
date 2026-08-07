"""각 shorts 의 hook_beat_id 를 Gemini 별도 콜로 선택.

- 각 shorts 는 beat_ids 여러 개로 구성
- 첫 beat 는 hook 후보에서 제외 (그게 body 시작이라 반복 느낌)
- 남은 beat 중 여성 시청자를 잡아둘 강한 훅 beat 하나를 AI 가 선택
- 그 beat 의 처음 3초를 render 시 preroll 로 사용

사용:
  python tmp/gebd/scripts/pick_hook_beat.py --workdir tmp/gebd/prod_out
"""
from __future__ import annotations
import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# core 를 import 하기 위해 repo root 를 path 에 추가
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from google import genai
from google.genai import types
from core.retry import call_with_retry
from core.models import RECOMMEND as MODEL

PROJECT = "step-d"
LOCATION = "asia-northeast3"

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "hook_beat_id": {"type": "INTEGER"},
        "why": {"type": "STRING"},
    },
    "required": ["hook_beat_id"],
}


def _fmt_beat_line(b: dict) -> str:
    tx = (b.get("transcript") or "").replace("\n", " ")[:160]
    chars = ", ".join(b.get("characters") or [])
    dur = float(b.get("end", 0)) - float(b.get("start", 0))
    return f"  beat #{b.get('id')} ({dur:.1f}s · {chars or '?'}): {tx}"


def pick_hook_for_short(client, s: dict, beats_by_id: dict[int, dict]) -> int | None:
    beat_ids = s.get("beat_ids") or []
    if len(beat_ids) < 2:
        return None
    # 첫 beat 제외
    candidates = [beats_by_id[bid] for bid in beat_ids[1:] if bid in beats_by_id]
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0].get("id")

    title = s.get("title", "")
    lines = "\n".join(_fmt_beat_line(b) for b in candidates)
    prompt = (
        f"쇼츠 제목: {title}\n"
        f"쇼츠 구간: {s.get('start',0):.1f}s ~ {s.get('end',0):.1f}s\n"
        f"쇼츠는 여러 beat 로 구성. 아래 beat 후보 중 · **여성 시청자가 스크롤을 멈추게 만들** \n"
        f"가장 강한 hook beat 하나를 골라라. 이 beat 의 처음 3초가 · 쇼츠 앞에 preroll 로 붙어 · \n"
        f"시청자 첫 3초 이탈을 잡는다.\n\n"
        f"판단 기준:\n"
        f"- 폭로·반전·인용문·직업공개·감정폭발·리액션 → 강한 hook\n"
        f"- 인트로·평범한 자기소개·설명 → 약한 hook (피하라)\n"
        f"- 대사 한 줄이 임팩트 있어야 함 (텍스트만 봐도 궁금해지는지)\n\n"
        f"beat 후보 (id · 길이 · 인물 · 대사):\n{lines}\n\n"
        f"고른 beat 의 id 를 hook_beat_id 로 반환. 짧게 why 도."
    )
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
                response_schema=_SCHEMA,
                max_output_tokens=256,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        obj = json.loads(resp.text or "{}")
        hbid = obj.get("hook_beat_id")
        if isinstance(hbid, int):
            valid_ids = {b.get("id") for b in candidates}
            if hbid in valid_ids:
                return hbid
        # 폴백: 후보 중 첫 번째
        return candidates[0].get("id")
    except Exception as e:
        print(f"  [warn] short '{title[:20]}': {str(e)[:80]}")
        return candidates[0].get("id")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    args = ap.parse_args()
    wd = Path(args.workdir)

    shorts_data = json.loads((wd / "shorts.json").read_text(encoding="utf-8"))
    beats_data = json.loads((wd / "beats.json").read_text(encoding="utf-8"))
    beats_by_id = {b["id"]: b for b in beats_data.get("beats", []) if "id" in b}

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    shorts = shorts_data.get("shorts", [])
    print(f"hook beat 선택 · {len(shorts)}개 shorts · Gemini {MODEL}")

    def process(idx_short):
        i, s = idx_short
        hbid = pick_hook_for_short(client, s, beats_by_id)
        return i, hbid

    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, hbid in ex.map(process, enumerate(shorts)):
            s = shorts[i]
            if hbid is not None and hbid in beats_by_id:
                s["hook_beat_id"] = hbid
                b = beats_by_id[hbid]
                # hook_time_sec 도 갱신 · beat.start - shorts.start (상대 시각)
                rel = float(b["start"]) - float(s.get("start", 0))
                s["hook_time_sec"] = max(0.0, rel)
                tx = (b.get("transcript") or "").split("] ", 1)[-1][:40]
                print(f"  #{i+1} '{s.get('title','')[:24]}' → beat #{hbid} @ +{rel:.1f}s · \"{tx}\"")
            else:
                print(f"  #{i+1} '{s.get('title','')[:24]}' → skip (후보 부족)")

    (wd / "shorts.json").write_text(
        json.dumps(shorts_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n[ok] shorts.json 업데이트 · hook_beat_id 추가")


if __name__ == "__main__":
    main()

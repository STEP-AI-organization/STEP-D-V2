"""수집한 채널 썸네일 → 프로그램 스타일 프로파일.

사용자 지시 (2026-08-07): "나는솔로에 맞게 학습."

Vision 이 하는 일은 **장별 서술**뿐이다. 집계는 빈도 계산으로 한다 —
LLM 에 "요약해줘"라고 시키면 실행마다 프로파일이 달라져서, 같은 회차인데
어제와 오늘 썸네일 톤이 바뀐다. 스타일은 흔들리면 스타일이 아니다.

산출:
  style_profile.json  집계 결과 (빈도·중앙값)
  style_prompt.txt    생성 프롬프트에 심을 3~5줄 한국어 블록
  refs.json           참고 이미지로 첨부할 대표 썸네일 2장

사용:
  python scripts/thumbnail_style_profile.py --program "나는솔로" --sample 20
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STYLE_ROOT = ROOT / "assets" / "thumbnail-style"

SYSTEM = """너는 한국 방송사 유튜브 썸네일 아트디렉터다.
첨부된 썸네일 1장을 보고 아래 JSON 스키마로만 답한다. 설명 문장을 덧붙이지 않는다.

{
  "person_count": 0,                     // 썸네일에 크게 나온 인물 수
  "caption_lines": 0,                    // 메인 자막 줄 수
  "caption_position": "bottom-left",     // top-left|top-center|bottom-left|bottom-center|center
  "caption_max_chars": 0,                // 한 줄 최대 글자 수 (공백 포함)
  "caption_colors": ["white"],           // 자막에 쓰인 색 (강조색 포함)
  "highlight_style": "키워드만 다른 색",   // 강조 방식 한 줄
  "has_border": true,                    // 바깥 테두리/프레임 유무
  "border_desc": "파스텔 그라디언트 프레임",  // 없으면 ""
  "has_logo": true,                      // 프로그램 로고 유무
  "logo_position": "top-left",           // 없으면 ""
  "background": "실내 스튜디오",           // 배경 성격 한 줄
  "tone": "밝고 화사함",                   // 전체 톤 한 줄
  "person_layout": "가로로 나란히"          // 인물 배치 한 줄
}"""


def analyze_one(client, model, img_bytes: bytes) -> dict | None:
    from google.genai import types

    from core.common.retry import call_with_retry
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=model,
            contents=[types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"),
                      "이 썸네일을 분석해."],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM, temperature=0,
                response_mime_type="application/json",
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=1024,
            ),
        ))
        return json.loads(resp.text or "{}")
    except Exception as e:
        print(f"   ! 분석 실패: {str(e)[:120]}")
        return None


def _top(values: list, k: int = 3) -> list[tuple[str, int]]:
    vals = [str(v).strip() for v in values if str(v or "").strip()]
    return collections.Counter(vals).most_common(k)


def aggregate(rows: list[dict]) -> dict:
    """빈도·중앙값으로 압축. 여기엔 LLM 이 개입하지 않는다."""
    n = len(rows)
    def med(key):
        xs = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        return round(statistics.median(xs), 1) if xs else None

    colors = [c for r in rows for c in (r.get("caption_colors") or [])]
    return {
        "sampleSize": n,
        "personCount": _top([r.get("person_count") for r in rows]),
        "captionLines": _top([r.get("caption_lines") for r in rows]),
        "captionPosition": _top([r.get("caption_position") for r in rows]),
        "captionMaxChars": med("caption_max_chars"),
        "captionColors": _top(colors, 5),
        "highlightStyle": _top([r.get("highlight_style") for r in rows], 2),
        "borderRate": round(sum(1 for r in rows if r.get("has_border")) / max(n, 1), 2),
        "borderDesc": _top([r.get("border_desc") for r in rows], 2),
        "logoRate": round(sum(1 for r in rows if r.get("has_logo")) / max(n, 1), 2),
        "logoPosition": _top([r.get("logo_position") for r in rows], 2),
        "background": _top([r.get("background") for r in rows], 3),
        "tone": _top([r.get("tone") for r in rows], 3),
        "personLayout": _top([r.get("person_layout") for r in rows], 3),
    }


def to_prompt_block(program: str, agg: dict) -> str:
    """생성 프롬프트에 심을 한국어 블록. 길게 쓰지 않는다 — 길수록 결과가 나빠졌다."""
    def first(key, default=""):
        top = agg.get(key) or []
        return top[0][0] if top else default

    parts = [f"{program} 채널의 썸네일 스타일을 따라줘."]
    if agg.get("borderRate", 0) >= 0.5 and first("borderDesc"):
        parts.append(f"바깥에 {first('borderDesc')}를 두르고,")
    if agg.get("logoRate", 0) >= 0.5:
        parts.append(f"{first('logoPosition', 'top-left')} 에 프로그램 로고를 작게 넣어줘.")
    lines = first("captionLines", "2")
    pos = first("captionPosition", "bottom-left")
    parts.append(f"자막은 {pos} 에 {lines}줄로, {first('highlightStyle', '키워드만 다른 색')}.")
    if first("tone"):
        parts.append(f"전체 톤은 {first('tone')}.")
    return " ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--program", required=True)
    ap.add_argument("--sample", type=int, default=20, help="분석할 장수 (Vision 호출 수)")
    args = ap.parse_args()

    from scripts.thumbnail_engine_run import load_env
    load_env(ROOT / "apps" / "server" / ".env")

    import os

    from google import genai

    from core.common.models import VISION

    out_dir = STYLE_ROOT / args.program
    thumbs = sorted((out_dir / "thumbs").glob("*.jpg"))
    if not thumbs:
        print(f"썸네일 없음: {out_dir/'thumbs'} — 먼저 thumbnail_style_collect.py 실행")
        return 1
    thumbs = thumbs[: args.sample]

    client = genai.Client(
        vertexai=True,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d",
        location=os.environ.get("VERTEX_LOCATION") or "asia-northeast3",
    )

    print(f"분석 {len(thumbs)}장 (Vision {len(thumbs)}회)")
    rows = []
    for i, p in enumerate(thumbs, 1):
        r = analyze_one(client, VISION, p.read_bytes())
        if r:
            r["_file"] = p.name
            rows.append(r)
        if i % 5 == 0:
            print(f"   {i}/{len(thumbs)} · 성공 {len(rows)}")

    if not rows:
        print("분석 결과 없음 — 중단")
        return 1

    agg = aggregate(rows)
    (out_dir / "style_profile.json").write_text(
        json.dumps({"program": args.program, "aggregate": agg, "rows": rows},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    block = to_prompt_block(args.program, agg)
    (out_dir / "style_prompt.txt").write_text(block, encoding="utf-8")

    # 참고 이미지: 가장 흔한 인물 수를 가진 것 2장 (스타일의 전형)
    common_n = agg["personCount"][0][0] if agg["personCount"] else None
    typical = [r["_file"] for r in rows if str(r.get("person_count")) == str(common_n)][:2]
    (out_dir / "refs.json").write_text(
        json.dumps({"refs": typical}, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n── 집계 ──")
    for k, v in agg.items():
        print(f"  {k}: {v}")
    print(f"\n── 프롬프트 블록 ──\n  {block}")
    print(f"\n대표 참고 이미지: {typical}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

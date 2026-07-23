"""단일 롱폼 처리 (per-long json 저장). 사용법: python exp11_single.py <videoid>"""
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

if len(sys.argv) < 2:
    print("Usage: python exp11_single.py <videoid>")
    sys.exit(1)
lid = sys.argv[1]

BASE = Path("D:/STEPD-experiments")
EXP_DIR = BASE / "exp11"
RES = BASE / "results"
PER_LONG_DIR = RES / "exp11_per_long"
PER_LONG_DIR.mkdir(exist_ok=True, parents=True)

out_path = PER_LONG_DIR / f"{lid}.json"
if out_path.exists():
    print(f"[SKIP] {lid} 이미 있음")
    sys.exit(0)

info = EXP_DIR / f"{lid}.info.json"
if not info.exists():
    print(f"[MISS] {lid} info.json 없음")
    sys.exit(1)

d = json.load(open(info, encoding="utf-8"))
comments = d.get("comments", []) or []
comments.sort(key=lambda c: -(c.get("like_count") or 0))
top = comments[:50]  # 소량으로 (안정성 우선)
title = d.get("title", "")

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"

from google import genai
from google.genai import types

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "results": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "idx": {"type": "INTEGER"},
            "moment_ref": {"type": "BOOLEAN"},
            "moment_type": {"type": "STRING", "enum": ["인물반응", "대사인용", "상황설정", "게임/도전", "감정폭발", "기타", "없음"]},
            "emotion": {"type": "STRING", "enum": ["웃음", "감동", "짜증", "놀람", "기대", "공감", "혐오", "없음"]},
            "quote_ref": {"type": "BOOLEAN"},
            "demand": {"type": "BOOLEAN"},
            "demand_category": {"type": "STRING", "enum": ["재출연/게스트", "후속편/시즌", "특정형식", "기타", "없음"]},
            "sentiment": {"type": "STRING", "enum": ["긍정", "부정", "중립"]},
        }, "required": ["idx","moment_ref","moment_type","emotion","quote_ref","demand","demand_category","sentiment"]}},
    }, "required": ["results"],
}

lines = [f"{i}: {c.get('text','')}" for i, c in enumerate(top)]
prompt = f"""롱폼 "{title}"의 댓글 {len(top)}개 분류:

{chr(10).join(lines)}"""

client = genai.Client(vertexai=True, project="step-d", location="asia-northeast3")
print(f"[RUN] {lid} ({len(top)} comments) …", flush=True)
try:
    r = client.models.generate_content(
        model="gemini-2.5-flash", contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=SCHEMA, temperature=0.0),
    )
    data = json.loads(r.text)
    results = data.get("results", [])
    for item in results:
        i = item.get("idx")
        if isinstance(i, int) and 0 <= i < len(top):
            item["likes"] = top[i].get("like_count", 0)
            item["text"] = top[i].get("text","")[:200]
    json.dump({"lid": lid, "title": title, "dur": d.get("duration", 0), "extracted": results},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"[OK] {lid} → {len(results)}개 저장", flush=True)
except Exception as e:
    print(f"[FAIL] {lid}: {str(e)[:200]}", flush=True)

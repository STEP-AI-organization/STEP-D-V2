"""Exp 10 파일럿: 하하 3롱폼 댓글 수집 → Gemini 정보추출 → 리텐션·v2 winners 대조.

파이프라인:
  1) yt-dlp로 댓글 다운로드 (상위 ~100/롱폼)
  2) Gemini로 각 댓글 분류: {moment_ref, emotion, quote_ref, demand, sentiment}
  3) 롱폼별 시간축 언급 히트맵 만들기
  4) 리텐션 커브·v2 winners와 대조 (Spearman + IoU 유사)

산출:
  D:/STEPD-experiments/results/exp10_haha_comments.json — 원본 댓글
  D:/STEPD-experiments/results/exp10_haha_extracted.json — Gemini 추출 결과
  D:/STEPD-experiments/results/exp10_haha_analysis.json — 히트맵·상관·요약
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
EXP_DIR = BASE / "exp10"
EXP_DIR.mkdir(exist_ok=True, parents=True)
RES = BASE / "results"

# Exp 8 하하 3 홀드아웃 롱폼
LONGS = {
    "LcMolKaPcrw": {"title": "경주PC방", "dur": 3660},  # 실제 dur 아래에서 확정
    "NtXLj7xOeE8": {"title": "원정대4", "dur": 3660},
    "JppILjNTCok": {"title": "원정대5", "dur": 3660},
}

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"


# === STAGE 1: yt-dlp로 댓글 수집 ===
print("=== STAGE 1: 댓글 수집 (yt-dlp) ===\n")
comments_by_long = {}
for lid, meta in LONGS.items():
    info_path = EXP_DIR / f"{lid}.info.json"
    if not info_path.exists():
        print(f"[{lid}] 다운로드 중…", flush=True)
        subprocess.run(
            ["yt-dlp", "--skip-download", "--write-comments", "--no-warnings", "-q",
             "--extractor-args", "youtube:max_comments=200,50,30,0",
             "-o", str(EXP_DIR / f"{lid}.%(ext)s"),
             f"https://www.youtube.com/watch?v={lid}"],
            check=True, timeout=180,
        )
    d = json.load(open(info_path, encoding="utf-8"))
    comments = d.get("comments", []) or []
    LONGS[lid]["dur"] = d.get("duration", 0) or 0
    LONGS[lid]["title"] = d.get("title", "") or LONGS[lid]["title"]
    # 좋아요 순 상위 100개만
    comments.sort(key=lambda c: -(c.get("like_count") or 0))
    top = comments[:100]
    comments_by_long[lid] = [
        {"id": c.get("id"), "text": c.get("text", ""), "likes": c.get("like_count", 0),
         "is_pinned": c.get("is_pinned", False)}
        for c in top
    ]
    print(f"  {lid} ({meta.get('title','')}): {len(comments)} → 상위 {len(top)} · dur={LONGS[lid]['dur']}s", flush=True)

json.dump(comments_by_long, open(RES / "exp10_haha_comments.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n저장: {RES / 'exp10_haha_comments.json'}")


# === STAGE 2: Gemini로 각 댓글 정보 추출 ===
print("\n=== STAGE 2: Gemini 정보 추출 ===\n")
from google import genai
from google.genai import types

client = genai.Client(vertexai=True, project="step-d", location="asia-northeast3")

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "results": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "idx": {"type": "INTEGER"},
                    "moment_ref": {"type": "BOOLEAN", "description": "특정 순간·타임스탬프·상황을 지목했는가"},
                    "moment_hint": {"type": "STRING", "description": "댓글에서 지목한 순간 요약 (예: '경주 마스터 눈물', 'PC방 스피커 이슈', '없음')"},
                    "emotion": {"type": "STRING", "enum": ["웃음", "감동", "짜증", "놀람", "기대", "공감", "혐오", "없음"]},
                    "quote_ref": {"type": "BOOLEAN", "description": "롱폼 대사·자막을 인용했는가"},
                    "demand": {"type": "BOOLEAN", "description": "재출연·후속·요청·기대 표현했는가"},
                    "demand_text": {"type": "STRING", "description": "요청·기대 요약 (없으면 '없음')"},
                    "sentiment": {"type": "STRING", "enum": ["긍정", "부정", "중립"]},
                },
                "required": ["idx", "moment_ref", "moment_hint", "emotion", "quote_ref", "demand", "demand_text", "sentiment"],
            }
        }
    },
    "required": ["results"],
}

extracted_by_long = {}
for lid, comments in comments_by_long.items():
    print(f"[{lid}] {len(comments)}개 댓글 추출 중…", flush=True)
    if not comments:
        extracted_by_long[lid] = []
        continue
    lines = [f"{i}: {c['text']}" for i, c in enumerate(comments)]
    prompt = f"""아래는 유튜브 롱폼 영상 "{LONGS[lid]['title']}"의 댓글 {len(comments)}개다.
각 댓글에 대해 아래 정보를 추출하라. **댓글 텍스트는 그대로 두고 판정만 하라.**

- moment_ref: 롱폼의 특정 순간·장면·상황을 지목했는가 (예: "3분에 하하가 롤 하는 장면", "경주 마스터가 눈물 흘릴 때"). 두루뭉술한 감상평은 false.
- moment_hint: moment_ref가 true면 어느 순간인지 3~10자 요약. false면 "없음".
- emotion: 웃음/감동/짜증/놀람/기대/공감/혐오/없음 중 하나.
- quote_ref: 롱폼의 대사나 자막을 인용했는가 ("~라고 한 거 미쳤음"처럼).
- demand: 재출연·후속·다른 편·특정 게스트·특정 형식을 요구했는가 (미래 요구).
- demand_text: demand true면 요구 내용 요약, false면 "없음".
- sentiment: 긍정/부정/중립.

댓글:
{chr(10).join(lines)}
"""
    r = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SCHEMA,
            temperature=0.0,
        ),
    )
    try:
        data = json.loads(r.text)
        results = data.get("results", [])
    except Exception as e:
        print(f"  파싱 실패: {e}")
        results = []
    # 댓글 원본과 병합
    for item in results:
        i = item["idx"]
        if 0 <= i < len(comments):
            item.update({"text": comments[i]["text"], "likes": comments[i]["likes"]})
    extracted_by_long[lid] = results
    print(f"  → 추출 {len(results)}개", flush=True)

json.dump(extracted_by_long, open(RES / "exp10_haha_extracted.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n저장: {RES / 'exp10_haha_extracted.json'}")


# === STAGE 3: 요약 통계 ===
print("\n=== STAGE 3: 요약 통계 ===\n")
summary = {}
for lid, items in extracted_by_long.items():
    n = len(items)
    moment_ref = sum(1 for x in items if x.get("moment_ref"))
    quote_ref = sum(1 for x in items if x.get("quote_ref"))
    demand = sum(1 for x in items if x.get("demand"))
    emotions = {}
    for x in items:
        e = x.get("emotion", "없음")
        emotions[e] = emotions.get(e, 0) + 1
    sentiments = {}
    for x in items:
        s = x.get("sentiment", "중립")
        sentiments[s] = sentiments.get(s, 0) + 1
    # moments·demands 목록
    moments = [(x.get("moment_hint"), x.get("likes", 0)) for x in items if x.get("moment_ref")]
    demands = [(x.get("demand_text"), x.get("likes", 0)) for x in items if x.get("demand")]
    moments.sort(key=lambda t: -t[1])
    demands.sort(key=lambda t: -t[1])
    summary[lid] = {
        "title": LONGS[lid]["title"],
        "dur": LONGS[lid]["dur"],
        "n_comments": n,
        "moment_ref_pct": round(100 * moment_ref / max(1, n), 1),
        "quote_ref_pct": round(100 * quote_ref / max(1, n), 1),
        "demand_pct": round(100 * demand / max(1, n), 1),
        "emotion_dist": emotions,
        "sentiment_dist": sentiments,
        "top_moments": moments[:10],
        "top_demands": demands[:10],
    }

    print(f"\n[{lid}] {LONGS[lid]['title']}")
    print(f"  moment_ref: {moment_ref}/{n} ({round(100*moment_ref/max(1,n))}%)")
    print(f"  quote_ref: {quote_ref}/{n} ({round(100*quote_ref/max(1,n))}%)")
    print(f"  demand: {demand}/{n} ({round(100*demand/max(1,n))}%)")
    print(f"  감정: {emotions}")
    print(f"  sent: {sentiments}")
    if moments[:5]:
        print(f"  상위 순간 언급:")
        for m, l in moments[:5]:
            print(f"    [{l}❤] {m}")
    if demands[:5]:
        print(f"  상위 요청:")
        for d, l in demands[:5]:
            print(f"    [{l}❤] {d}")

json.dump(summary, open(RES / "exp10_haha_analysis.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n저장: {RES / 'exp10_haha_analysis.json'}")
print("\n=== 파일럿 완료 ===")

"""Exp 10 확장: ENA 5 + 드나드나 7 롱폼 댓글 파일럿.

동일한 파이프라인 (yt-dlp → Gemini → 요약). 하하와 동일 스키마.
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

TARGETS = {
    "ENA": [
        ("dnIaj6L3t1E", "ENA 나는솔로"),
        ("DPclbGO1F9g", "ENA 나는솔로"),
        ("Lj_tFgRqqEI", "ENA 나는솔로"),
        ("MjWwq8bBwJE", "ENA 나는솔로"),
        ("QNtoQ4zI8mc", "ENA 나는솔로"),
    ],
    "드나드나": [
        ("rhX9po-DBZI", "드나드나 허수아비"),
        ("NUM1zfQujWY", "드나드나 허수아비"),
        ("OuvpspSaAUQ", "드나드나 허수아비"),
        ("k8BHuiKF0rk", "드나드나 허수아비"),
        ("ALuFb_TqHPU", "드나드나 허수아비"),
        ("a9O8d0zLfTg", "드나드나 허수아비"),
        ("sT9KQTLg2Cs", "드나드나 허수아비"),
    ],
}

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"


# === STAGE 1: yt-dlp 댓글 다운로드 ===
print("=== STAGE 1: 댓글 수집 (yt-dlp) ===\n")
long_meta = {}  # lid -> {title, dur}
comments_by_long = {}
for channel, longs in TARGETS.items():
    for lid, ch_label in longs:
        info_path = EXP_DIR / f"{lid}.info.json"
        if not info_path.exists():
            print(f"[{channel}/{lid}] 다운로드 중…", flush=True)
            try:
                subprocess.run(
                    ["yt-dlp", "--skip-download", "--write-comments", "--no-warnings", "-q",
                     "--extractor-args", "youtube:max_comments=200,50,30,0",
                     "-o", str(EXP_DIR / f"{lid}.%(ext)s"),
                     f"https://www.youtube.com/watch?v={lid}"],
                    check=True, timeout=180,
                )
            except Exception as e:
                print(f"  실패: {e}")
                continue
        if not info_path.exists():
            print(f"  info 없음")
            continue
        d = json.load(open(info_path, encoding="utf-8"))
        comments = d.get("comments", []) or []
        title = d.get("title", "") or ch_label
        dur = d.get("duration", 0) or 0
        comments.sort(key=lambda c: -(c.get("like_count") or 0))
        top = comments[:100]
        long_meta[lid] = {"title": title, "dur": dur, "channel": channel}
        comments_by_long[lid] = [
            {"id": c.get("id"), "text": c.get("text", ""), "likes": c.get("like_count", 0),
             "is_pinned": c.get("is_pinned", False)}
            for c in top
        ]
        print(f"  {lid} ({channel}): {len(comments)}→상위 {len(top)} · dur={dur}s", flush=True)

# 병합해서 저장
existing = {}
haha_file = RES / "exp10_haha_comments.json"
if haha_file.exists():
    existing = json.load(open(haha_file, encoding="utf-8"))
merged_comments = {**existing, **comments_by_long}
json.dump(merged_comments, open(RES / "exp10_all_comments.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n저장: {RES / 'exp10_all_comments.json'} ({len(merged_comments)}개 롱폼)")


# === STAGE 2: Gemini 정보 추출 ===
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
                    "moment_ref": {"type": "BOOLEAN"},
                    "moment_hint": {"type": "STRING"},
                    "emotion": {"type": "STRING", "enum": ["웃음", "감동", "짜증", "놀람", "기대", "공감", "혐오", "없음"]},
                    "quote_ref": {"type": "BOOLEAN"},
                    "demand": {"type": "BOOLEAN"},
                    "demand_text": {"type": "STRING"},
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
    print(f"[{lid}] {len(comments)}개 추출 중…", flush=True)
    if not comments:
        extracted_by_long[lid] = []
        continue
    title = long_meta[lid]["title"]
    lines = [f"{i}: {c['text']}" for i, c in enumerate(comments)]
    prompt = f"""아래는 유튜브 롱폼 영상 "{title}"의 댓글 {len(comments)}개다.
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
    try:
        r = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=SCHEMA,
                temperature=0.0,
            ),
        )
        data = json.loads(r.text)
        results = data.get("results", [])
    except Exception as e:
        print(f"  실패: {str(e)[:100]}")
        results = []
    for item in results:
        i = item.get("idx")
        if isinstance(i, int) and 0 <= i < len(comments):
            item.update({"text": comments[i]["text"], "likes": comments[i]["likes"]})
    extracted_by_long[lid] = results
    print(f"  → 추출 {len(results)}개", flush=True)

# 병합 저장
haha_ext_file = RES / "exp10_haha_extracted.json"
existing_ext = {}
if haha_ext_file.exists():
    existing_ext = json.load(open(haha_ext_file, encoding="utf-8"))
merged_ext = {**existing_ext, **extracted_by_long}
json.dump(merged_ext, open(RES / "exp10_all_extracted.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)


# === STAGE 3: 3채널 요약 통계 ===
print("\n=== STAGE 3: 3채널 요약 통계 ===\n")

# 하하 메타
HAHA_LONGS = {
    "LcMolKaPcrw": "하하 경주PC방",
    "NtXLj7xOeE8": "하하 원정대4",
    "JppILjNTCok": "하하 원정대5",
}

all_summary = {}
by_channel = {"하하": [], "ENA": [], "드나드나": []}

for lid, items in merged_ext.items():
    channel = long_meta.get(lid, {}).get("channel")
    if not channel:
        if lid in HAHA_LONGS:
            channel = "하하"
    if not channel:
        continue

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
    moments = [(x.get("moment_hint"), x.get("likes", 0)) for x in items if x.get("moment_ref")]
    demands = [(x.get("demand_text"), x.get("likes", 0)) for x in items if x.get("demand")]
    moments.sort(key=lambda t: -t[1])
    demands.sort(key=lambda t: -t[1])
    entry = {
        "channel": channel,
        "n": n,
        "moment_ref_pct": round(100 * moment_ref / max(1, n), 1),
        "quote_ref_pct": round(100 * quote_ref / max(1, n), 1),
        "demand_pct": round(100 * demand / max(1, n), 1),
        "emotions": emotions, "sentiments": sentiments,
        "top_moments": moments[:10], "top_demands": demands[:10],
    }
    all_summary[lid] = entry
    by_channel[channel].append(entry)

json.dump(all_summary, open(RES / "exp10_all_analysis.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)

print(f"{'채널':<10} | {'평균 moment_ref':>15} | {'평균 quote_ref':>15} | {'평균 demand':>13}")
for ch in ["하하", "ENA", "드나드나"]:
    entries = by_channel[ch]
    if not entries:
        continue
    n = len(entries)
    m = sum(e["moment_ref_pct"] for e in entries) / n
    q = sum(e["quote_ref_pct"] for e in entries) / n
    d = sum(e["demand_pct"] for e in entries) / n
    print(f"{ch:<10} | {m:>13.1f}% | {q:>13.1f}% | {d:>11.1f}% ({n}편)")

# 채널별 상위 순간·요청 종합
print("\n=== 채널별 상위 순간 언급 ===")
for ch, entries in by_channel.items():
    if not entries:
        continue
    all_moments = []
    all_demands = []
    for e in entries:
        all_moments.extend(e["top_moments"])
        all_demands.extend(e["top_demands"])
    all_moments.sort(key=lambda t: -t[1])
    all_demands.sort(key=lambda t: -t[1])
    print(f"\n[{ch}] 상위 순간 언급 (좋아요순):")
    for m, l in all_moments[:8]:
        print(f"  [{l}❤] {m}")
    if all_demands:
        print(f"[{ch}] 상위 요청:")
        for d, l in all_demands[:5]:
            print(f"  [{l}❤] {d}")

print("\n=== 확장 파일럿 완료 ===")

"""Exp 11 재개판 — per-long 결과 즉시 저장 · 재실행 시 이어서."""
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
EXP_DIR = BASE / "exp11"
RES = BASE / "results"
REPORT_DIR = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"

past_longs = json.load(open(RES / "exp11_past_longs.json", encoding="utf-8"))
TRAIN_LIDS = [r["videoid"] for r in past_longs[:8]]

# per-long 결과 폴더
PER_LONG_DIR = RES / "exp11_per_long"
PER_LONG_DIR.mkdir(exist_ok=True, parents=True)

# 댓글 로드
def load_comments(lid):
    info = EXP_DIR / f"{lid}.info.json"
    if not info.exists():
        return None, None, None
    d = json.load(open(info, encoding="utf-8"))
    comments = d.get("comments", []) or []
    comments.sort(key=lambda c: -(c.get("like_count") or 0))
    top = comments[:100]
    return d.get("title", ""), d.get("duration", 0), [
        {"text": c.get("text",""), "likes": c.get("like_count",0)} for c in top
    ]


from google import genai
from google.genai import types
client = genai.Client(vertexai=True, project="step-d", location="asia-northeast3")

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


def extract_one(lid, title, comments):
    """1롱폼 Gemini 추출."""
    if not comments:
        return []
    lines = [f"{i}: {c['text']}" for i, c in enumerate(comments)]
    prompt = f"""아래 유튜브 롱폼 "{title}"의 댓글 {len(comments)}개를 각각 분류하라.
- moment_ref: 특정 순간·장면·상황 지목 (bool)
- moment_type: 인물반응/대사인용/상황설정/게임/도전/감정폭발/기타/없음
- emotion: 웃음/감동/짜증/놀람/기대/공감/혐오/없음
- quote_ref: 대사 인용 여부
- demand: 재출연·후속·요청 (bool)
- demand_category: 재출연/게스트·후속편/시즌·특정형식·기타·없음
- sentiment: 긍정/부정/중립

댓글:
{chr(10).join(lines)}"""
    r = client.models.generate_content(
        model="gemini-2.5-flash", contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=SCHEMA, temperature=0.0),
    )
    data = json.loads(r.text)
    results = data.get("results", [])
    for item in results:
        i = item.get("idx")
        if isinstance(i, int) and 0 <= i < len(comments):
            item["likes"] = comments[i]["likes"]
            item["text"] = comments[i]["text"][:200]
    return results


# 각 롱폼 처리 (per-long json 있으면 skip)
for lid in TRAIN_LIDS:
    out_path = PER_LONG_DIR / f"{lid}.json"
    if out_path.exists():
        print(f"[SKIP] {lid} (이미 있음)", flush=True)
        continue
    title, dur, comments = load_comments(lid)
    if not comments:
        print(f"[MISS] {lid} 댓글 없음", flush=True)
        continue
    print(f"[RUN] {lid} ({len(comments)} comments)", flush=True)
    try:
        results = extract_one(lid, title, comments)
        json.dump({"lid": lid, "title": title, "dur": dur, "extracted": results},
                  open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"  → 저장 {len(results)}개", flush=True)
    except Exception as e:
        print(f"  실패: {str(e)[:200]}", flush=True)

# 병합 및 프로파일 생성
print("\n=== 병합 + 프로파일 생성 ===", flush=True)
from collections import Counter

all_items = []
long_titles = {}
for lid in TRAIN_LIDS:
    p = PER_LONG_DIR / f"{lid}.json"
    if not p.exists(): continue
    d = json.load(open(p, encoding="utf-8"))
    long_titles[lid] = d.get("title", "")
    for x in d.get("extracted", []):
        x["long"] = lid
        all_items.append(x)

n = len(all_items)
total_likes = sum(x.get("likes",0) for x in all_items)
print(f"학습 표본: {len(long_titles)}롱폼 · {n}댓글 · {total_likes} 총 좋아요\n")

def dist(field, weighted=False):
    c = Counter()
    for x in all_items:
        w = (x.get("likes",0) + 1) if weighted else 1
        c[x.get(field, "없음")] += w
    total = sum(c.values())
    return {k: round(100*v/max(1,total),1) for k, v in c.most_common()}

moment_ref_pct = 100 * sum(x.get("likes",0)+1 for x in all_items if x.get("moment_ref")) / max(1, sum(x.get("likes",0)+1 for x in all_items))
quote_ref_pct = 100 * sum(x.get("likes",0)+1 for x in all_items if x.get("quote_ref")) / max(1, sum(x.get("likes",0)+1 for x in all_items))
demand_pct = 100 * sum(x.get("likes",0)+1 for x in all_items if x.get("demand")) / max(1, sum(x.get("likes",0)+1 for x in all_items))

top_demands = sorted(
    [(x.get("text",""), x.get("likes",0)) for x in all_items if x.get("demand")],
    key=lambda t: -t[1],
)[:15]

profile = {
    "channelId": "UCK3p1wDoQYOkxi414EvBlLw",
    "channelName": "하하 PD HAHA PD",
    "learned_from": {"n_longs": len(long_titles), "long_ids": list(long_titles.keys()), "n_comments": n, "total_likes": total_likes},
    "moment_type_dist": dist("moment_type", True),
    "emotion_dist": dist("emotion", True),
    "sentiment_dist": dist("sentiment", False),
    "demand_category_dist": dist("demand_category", True),
    "moment_ref_pct": round(moment_ref_pct, 1),
    "quote_ref_pct": round(quote_ref_pct, 1),
    "demand_pct": round(demand_pct, 1),
    "top_demand_examples": [(t[:100], l) for t, l in top_demands[:10]],
}

json.dump(profile, open(RES / "exp11_viewer_profile.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
import shutil
shutil.copy2(RES / "exp11_viewer_profile.json", REPORT_DIR / "exp11_viewer_profile.json")

# 출력
print(f"moment_ref: {moment_ref_pct:.1f}% · quote: {quote_ref_pct:.1f}% · demand: {demand_pct:.1f}%\n")
print("moment_type (좋아요 가중):")
for k, v in profile["moment_type_dist"].items():
    print(f"  {k}: {v}%")
print("\nemotion (좋아요 가중):")
for k, v in profile["emotion_dist"].items():
    print(f"  {k}: {v}%")
print("\ndemand_category (없음 제외):")
for k, v in profile["demand_category_dist"].items():
    if k != "없음":
        print(f"  {k}: {v}%")
print("\n상위 요청 (좋아요순):")
for t, l in top_demands[:10]:
    print(f"  [{l}❤] {t[:80]}")

# 오너용 자연어
top_moment = list(profile["moment_type_dist"].keys())[0] if profile["moment_type_dist"] else "없음"
top_emotion = list(profile["emotion_dist"].keys())[0] if profile["emotion_dist"] else "없음"
top_demand = top_demands[0][0][:80] if top_demands else "없음"

voice_md = f"""# 하하 PD HAHA PD · 시청자 목소리 요약

> 자동 학습 · {len(long_titles)}편 과거 롱폼 · {n}개 상위 댓글 기반

## 이 채널 시청자가 반응하는 순간

- **가장 자주 지목하는 순간 타입**: **{top_moment}** ({profile["moment_type_dist"].get(top_moment, 0)}%)
- 지배적 감정: **{top_emotion}** ({profile["emotion_dist"].get(top_emotion, 0)}%)
- 시청자가 특정 순간을 지목하는 빈도: **{moment_ref_pct:.1f}%**
- 롱폼 대사·자막 인용 비율: {quote_ref_pct:.1f}%
- **재출연·후속 요구 강도**: **{demand_pct:.1f}%**

## 시청자 최상위 요청·기대 (좋아요순)

"""
for i, (t, l) in enumerate(top_demands[:5], 1):
    voice_md += f"{i}. **[{l}❤]** {t[:120]}\n"

voice_md += f"""
## 픽 파이프라인 활용

이 프로파일이 다음 롱폼 클립 픽 생성에 자동 반영됩니다:
- **{top_moment}** 성격의 순간이 있는 구간을 우대
- **{top_emotion}** 감정을 담는 구간을 우대
"""

(RES / "exp11_viewer_voice.md").write_text(voice_md, encoding="utf-8")
shutil.copy2(RES / "exp11_viewer_voice.md", REPORT_DIR / "exp11_viewer_voice.md")

print(f"\n저장:")
print(f"  {RES / 'exp11_viewer_profile.json'}")
print(f"  {RES / 'exp11_viewer_voice.md'}")

# 홀드아웃 예측 실측
print("\n\n=== 홀드아웃 예측 실측 (실서비스 실증) ===")
HAHA_V2_WINNERS = [
    {"long": "LcMolKaPcrw", "title": "경주 마스터의 꽐라 진실게임 개망신 썰", "hook": "반전", "rel": 1.75},
    {"long": "NtXLj7xOeE8", "title": "부산 사나이들의 기싸움", "hook": "갈등", "rel": 1.42},
    {"long": "NtXLj7xOeE8", "title": "삼성 vs 롯데 신경전", "hook": "갈등", "rel": 1.30},
    {"long": "NtXLj7xOeE8", "title": "밥 먹자더니 영화 홍보 폭발", "hook": "반전", "rel": 1.25},
    {"long": "JppILjNTCok", "title": "사장님은 양상국만", "hook": "웃음", "rel": 1.18},
    {"long": "JppILjNTCok", "title": "냄비 수육 감탄", "hook": "반전", "rel": 1.11},
    {"long": "NtXLj7xOeE8", "title": "영화 바람 정우 해명", "hook": "웃음", "rel": 1.07},
    {"long": "JppILjNTCok", "title": "김치 좆됐다 연발", "hook": "감정고조", "rel": 1.06},
]

hook_to_type = {
    "반전": ["감정폭발", "인물반응"],
    "갈등": ["감정폭발", "인물반응"],
    "웃음": ["인물반응", "대사인용"],
    "감정고조": ["감정폭발"],
}
hook_to_emo = {
    "반전": ["놀람", "웃음"],
    "갈등": ["짜증", "놀람"],
    "웃음": ["웃음"],
    "감정고조": ["감동"],
}

print(f"{'winner':<30} | 훅 | rel | 프로파일 fit")
for w in HAHA_V2_WINNERS:
    types_f = hook_to_type.get(w["hook"], [])
    emos_f = hook_to_emo.get(w["hook"], [])
    type_s = sum(profile["moment_type_dist"].get(t, 0) for t in types_f) / 100
    emo_s = sum(profile["emotion_dist"].get(e, 0) for e in emos_f) / 100
    fit = round((type_s + emo_s) / 2, 3)
    print(f"{w['title'][:28]:<28} | {w['hook']:<5} | {w['rel']:.2f} | {fit}")

print("\n실서비스 개념: 프로파일은 과거 8편에서만 학습됨. 홀드아웃 3편의 댓글은 절대 미사용.")

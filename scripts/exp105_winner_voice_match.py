"""Exp 10.5 — v2 winners × 시청자 목소리 정량 상관.

핵심 질문: 우리 파이프라인(Exp 8/9)이 뽑은 히든젬 26개가 시청자 상위 목소리와 얼마나 겹치는가?

방법:
  1. Exp 8 v2 winners (하하 8) + Exp 9 winners (ENA 9 + 드나드나 9) = 26개 로드
  2. Exp 10 채널별 상위 좋아요 moment_hint 로드
  3. Gemini에 "이 winner가 시청자 언급 목록의 어떤 순간과 매칭되는가?" 결정론 판정
  4. 롱폼별로 wnner ∈ {top viewer moments} 여부 실측

산출:
  D:/STEPD-experiments/results/exp105_winner_voice_match.json
"""
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path("D:/STEPD-experiments")
RES = BASE / "results"
REPORT_DIR = Path(r"C:\Users\STEPAI05\STEPD-repo\바우처_결과보고_2026\증빙_데이터셋\실험자료")

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\Users\STEPAI05\STEPD-repo\gcp-keys\stepd-service-account-key.json"
os.environ["GOOGLE_CLOUD_PROJECT"] = "step-d"

# === 1. v2 winners 로드 ===
# 하하: 08_히든젬_확정8 (증빙 폴더) → JSON 없음, MANIFEST에서 발췌
HAHA_WINNERS = [
    {"long": "LcMolKaPcrw", "title": "경주 마스터의 꽐라 진실게임 개망신 썰", "hook": "반전", "start": 0, "end": 57, "rel": 1.75},
    {"long": "NtXLj7xOeE8", "title": "부산 사나이들의 기싸움", "hook": "갈등", "start": 90, "end": 126, "rel": 1.42},
    {"long": "NtXLj7xOeE8", "title": "삼성 vs 롯데 신경전", "hook": "갈등", "start": 360, "end": 412, "rel": 1.30},
    {"long": "NtXLj7xOeE8", "title": "밥 먹자더니 영화 홍보 폭발", "hook": "반전", "start": 430, "end": 480, "rel": 1.25},
    {"long": "JppILjNTCok", "title": "김원효 굴욕? 사장님은 양상국만", "hook": "웃음", "start": 990, "end": 1026, "rel": 1.18},
    {"long": "JppILjNTCok", "title": "엄마 음식 못 한다더니 냄비 수육 감탄", "hook": "반전", "start": 1150, "end": 1206, "rel": 1.11},
    {"long": "NtXLj7xOeE8", "title": "영화 바람 여주 허구 정우 해명", "hook": "웃음", "start": 737, "end": 770, "rel": 1.07},
    {"long": "JppILjNTCok", "title": "김치 맛에 좆됐다 연발", "hook": "감정고조", "start": 1350, "end": 1404, "rel": 1.06},
]
ENA_WINNERS = json.load(open(REPORT_DIR / "exp9_ena_confirmed_gems.json", encoding="utf-8"))
DNA_WINNERS = json.load(open(REPORT_DIR / "exp9_dna_confirmed_gems.json", encoding="utf-8"))

all_winners = {"하하": HAHA_WINNERS, "ENA": ENA_WINNERS, "드나드나": DNA_WINNERS}

# === 2. Exp 10 시청자 상위 목소리 로드 ===
analysis = json.load(open(RES / "exp10_all_analysis.json", encoding="utf-8"))

HAHA_LIDS = {"LcMolKaPcrw", "NtXLj7xOeE8", "JppILjNTCok"}
ENA_LIDS = {"dnIaj6L3t1E", "DPclbGO1F9g", "Lj_tFgRqqEI", "MjWwq8bBwJE", "QNtoQ4zI8mc"}
DNA_LIDS = {"rhX9po-DBZI", "NUM1zfQujWY", "OuvpspSaAUQ", "k8BHuiKF0rk", "ALuFb_TqHPU", "a9O8d0zLfTg", "sT9KQTLg2Cs"}
CH_MAP = {**{l: "하하" for l in HAHA_LIDS}, **{l: "ENA" for l in ENA_LIDS}, **{l: "드나드나" for l in DNA_LIDS}}


def moments_for_long(lid):
    e = analysis.get(lid)
    if not e:
        return []
    return e.get("top_moments") or []


# === 3. Gemini로 winner ↔ moments 매칭 ===
from google import genai
from google.genai import types
client = genai.Client(vertexai=True, project="step-d", location="asia-northeast3")

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "matches": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "winner_idx": {"type": "INTEGER"},
                    "matched": {"type": "BOOLEAN", "description": "이 winner를 뒷받침하는 시청자 언급이 있는가"},
                    "best_hint": {"type": "STRING", "description": "매칭된 moment_hint (없으면 '없음')"},
                    "best_hint_likes": {"type": "INTEGER"},
                    "reasoning": {"type": "STRING", "description": "왜 매칭/불매칭인지 20자 이내"},
                },
                "required": ["winner_idx", "matched", "best_hint", "best_hint_likes", "reasoning"],
            }
        }
    },
    "required": ["matches"],
}

results = {}
for channel, winners in all_winners.items():
    # 롱폼별 그룹핑
    by_long = {}
    for i, w in enumerate(winners):
        by_long.setdefault(w["long"], []).append((i, w))

    print(f"\n=== {channel} ({len(winners)} winners) ===")
    channel_results = []

    for lid, items in by_long.items():
        moments = moments_for_long(lid)
        if not moments:
            print(f"  {lid}: 시청자 목소리 없음 — 매칭 판정 스킵 (unknown)")
            for idx, w in items:
                channel_results.append({
                    "winner_idx": idx, "long": lid, "title": w["title"], "hook": w["hook"],
                    "matched": None, "best_hint": None, "reasoning": "댓글 목소리 없음",
                })
            continue

        # Gemini 요청 구성
        winner_lines = "\n".join([f"{idx}: {w['title']} (훅: {w['hook']}, {w['start']}~{w['end']}s)" for idx, w in items])
        moment_lines = "\n".join([f"- '{m[0]}' ({m[1]}❤)" for m in moments if isinstance(m, list) and len(m) >= 2])
        prompt = f"""아래 롱폼 "{lid}"의 우리 파이프라인이 뽑은 히든젬 winner 목록과, 이 롱폼 상위 시청자 언급(moment_hint) 목록이 있다.
각 winner에 대해 시청자 언급 목록의 어느 순간과 **의미상 매칭**되는지 판정하라.
매칭 기준: winner의 title·hook이 시청자 언급의 상황·인물·순간과 같은 것을 가리키면 true.
근거가 애매하면 false (엄격).

[Winner 목록]
{winner_lines}

[시청자 언급 목록 (좋아요순)]
{moment_lines}
"""
        try:
            r = client.models.generate_content(
                model="gemini-2.5-flash", contents=prompt,
                config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=SCHEMA, temperature=0.0),
            )
            data = json.loads(r.text)
            matches = data.get("matches", [])
        except Exception as e:
            print(f"  {lid} 실패: {str(e)[:100]}")
            matches = []

        # winner idx 매핑
        idx_to_w = {idx: w for idx, w in items}
        for m in matches:
            idx = m.get("winner_idx")
            if idx not in idx_to_w:
                continue
            w = idx_to_w[idx]
            channel_results.append({
                "winner_idx": idx, "long": lid, "title": w["title"], "hook": w["hook"],
                "matched": bool(m.get("matched")),
                "best_hint": m.get("best_hint"),
                "best_hint_likes": m.get("best_hint_likes"),
                "reasoning": m.get("reasoning"),
            })
        print(f"  {lid}: {sum(1 for r in matches if r.get('matched'))}/{len(items)} 매칭")

    results[channel] = channel_results

# 저장
json.dump(results, open(RES / "exp105_winner_voice_match.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
import shutil
shutil.copy2(RES / "exp105_winner_voice_match.json", REPORT_DIR / "exp105_winner_voice_match.json")

# === 4. 요약 ===
print("\n\n=== Exp 10.5 · v2 winners × 시청자 목소리 상관 ===\n")
print(f"{'채널':<10} | {'winners':>8} | {'매칭':>4} | {'미매칭':>6} | {'unknown':>7} | 매칭률")
for ch, items in results.items():
    n = len(items)
    matched = sum(1 for x in items if x["matched"] is True)
    unmatched = sum(1 for x in items if x["matched"] is False)
    unknown = sum(1 for x in items if x["matched"] is None)
    known = matched + unmatched
    rate = f"{int(100*matched/max(1,known))}%" if known > 0 else "N/A"
    print(f"{ch:<10} | {n:>8} | {matched:>4} | {unmatched:>6} | {unknown:>7} | {rate:>5} (known={known})")

# 채널별 매칭 상세
for ch, items in results.items():
    matched_items = [x for x in items if x["matched"] is True]
    if not matched_items:
        continue
    print(f"\n[{ch}] 시청자 목소리로 검증된 winner ({len(matched_items)}):")
    for x in matched_items:
        print(f"  ✅ {x['title'][:45]}")
        print(f"     → viewer: '{x['best_hint']}' ({x['best_hint_likes']}❤) · {x['reasoning']}")

# 미매칭도
for ch, items in results.items():
    unmatched_items = [x for x in items if x["matched"] is False]
    if not unmatched_items:
        continue
    print(f"\n[{ch}] 시청자 언급 없는 winner ({len(unmatched_items)}):")
    for x in unmatched_items[:5]:
        print(f"  ❌ {x['title'][:45]} · {x['reasoning']}")

print(f"\n저장: {RES / 'exp105_winner_voice_match.json'}")

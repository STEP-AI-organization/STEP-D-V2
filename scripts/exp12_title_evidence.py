"""Exp 12 · 제목 프롬프트 실데이터 실증 (NCC 보고서 자료).

발행 카탈로그 1592편 실 제목 분석 → 우리 프롬프트 원칙(예능 자막 톤·금칙어·여운·인용) 정당성 실측.

분석 축:
  1) 성과 tier별 (high/mid/low) 제목 특성 대조
  2) 금칙어 사용률 (성과와 상관?)
  3) 여운(…) 사용률
  4) 인용(""...") 사용률
  5) 길이 분포
  6) 채널별 (하하 특성)
"""
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(r"C:\Users\STEPAI05\STEPD-repo")
CATALOG = REPO / "바우처_결과보고_2026" / "증빙_데이터셋" / "01_published_catalog_labeled.csv"
REPORT_DIR = REPO / "바우처_결과보고_2026" / "증빙_데이터셋" / "실험자료"

# 금칙어 (프롬프트에 명시된 것)
BANNED_WORDS = [
    "미친", "헐", "실화", "대박", "소름", "레전드", "폭발", "폭탄",
    "어이없는", "충격", "초토화", "뒤집어졌다", "뒤집혔다", "해버렸다",
    "터졌다", "터져버렸다", "저질렀다", "스튜디오"
]
# 두루뭉술 명사
VAGUE_NOUNS = ["썰", "이야기", "모먼트", "사연"]
# 대괄호 뉴스 접두어
NEWS_PREFIXES = ["[속보]", "[단독]", "[충격]", "[LIVE]", "[특보]"]
# 감탄사 문두
EXCLAMATIONS = ["오,", "와,", "헐,", "아,", "야,", "우와,"]


def has_banned(title):
    return any(b in title for b in BANNED_WORDS)


def has_vague(title):
    return any(v in title for v in VAGUE_NOUNS)


def has_news_prefix(title):
    return any(title.startswith(p) for p in NEWS_PREFIXES)


def starts_exclamation(title):
    stripped = title.strip()
    return any(stripped.startswith(e[:-1]) for e in EXCLAMATIONS) or (stripped and stripped[0] in "오와헐" and len(stripped) > 1 and stripped[1] in " ,")


def has_ellipsis(title):
    return "…" in title or "..." in title


def has_quote(title):
    # 큰따옴표·작은따옴표·『』·「」
    return bool(re.search(r'["\'"\'『』「」]', title))


def has_arrow_wave(title):
    return "→" in title or "~" in title or "→" in title


def has_emoji(title):
    # 대충 이모지·특수기호
    return bool(re.search(r'[\U0001F300-\U0001FAFF☀-➿]', title))


def has_jamo_repeat(title):
    return bool(re.search(r'ㅋㅋ|ㅎㅎ|ㅠㅠ', title))


def clean_title(title):
    """해시태그·#·|·EP 표기 등 제거해서 실제 제목 부분만."""
    # #뒤 해시태그 제거
    t = re.sub(r'\s*#\S+', '', title)
    # | 뒤 편수/포맷 제거
    t = re.split(r'\s*[|｜]\s*', t)[0]
    # EP.숫자 제거
    t = re.sub(r'\s*(EP|Ep|ep)\s*\.?\s*\d+', '', t)
    return t.strip()


rows = list(csv.DictReader(open(CATALOG, encoding="utf-8-sig")))
print(f"카탈로그: {len(rows)}편\n")

# 롱폼 제거 (short만)
shorts = [r for r in rows if r.get("format") == "short"]
print(f"shorts만: {len(shorts)}편\n")

# tier별 분류
by_tier = defaultdict(list)
for r in shorts:
    t = r.get("view_tier", "").strip() or "unknown"
    by_tier[t].append(r)

# 채널별
by_channel = defaultdict(list)
for r in shorts:
    by_channel[r["channel"]].append(r)


def analyze_group(group_name, group):
    if not group:
        return None
    n = len(group)
    stats = {
        "n": n,
        "avg_length": sum(int(r.get("title_len", 0) or 0) for r in group) / n,
        "banned_pct": 100 * sum(1 for r in group if has_banned(r["title"])) / n,
        "vague_pct": 100 * sum(1 for r in group if has_vague(r["title"])) / n,
        "news_prefix_pct": 100 * sum(1 for r in group if has_news_prefix(r["title"])) / n,
        "exclamation_pct": 100 * sum(1 for r in group if starts_exclamation(r["title"])) / n,
        "ellipsis_pct": 100 * sum(1 for r in group if has_ellipsis(r["title"])) / n,
        "quote_pct": 100 * sum(1 for r in group if has_quote(r["title"])) / n,
        "arrow_wave_pct": 100 * sum(1 for r in group if has_arrow_wave(r["title"])) / n,
        "emoji_pct": 100 * sum(1 for r in group if has_emoji(r["title"])) / n,
        "jamo_repeat_pct": 100 * sum(1 for r in group if has_jamo_repeat(r["title"])) / n,
    }
    return stats


# ── tier별 대조 ──
print("=" * 90)
print("성과 tier별 제목 특성 대조 (%)")
print("=" * 90)
tier_order = ["high", "mid", "low"]
tier_stats = {t: analyze_group(t, by_tier[t]) for t in tier_order if by_tier[t]}

print(f"\n{'축':<25} | {'high':>8} | {'mid':>8} | {'low':>8}")
metrics = [
    ("표본 수", "n"),
    ("평균 길이 (자)", "avg_length"),
    ("금칙어 (미친/헐/실화/대박 등)", "banned_pct"),
    ("두루뭉술 명사 (썰/이야기)", "vague_pct"),
    ("뉴스식 대괄호 접두어", "news_prefix_pct"),
    ("감탄사 문두", "exclamation_pct"),
    ("여운 (…) 사용", "ellipsis_pct"),
    ("인용부호 사용", "quote_pct"),
    ("화살표·~ 사용", "arrow_wave_pct"),
    ("이모지 사용", "emoji_pct"),
    ("자모 반복 (ㅋㅋ·ㅎㅎ)", "jamo_repeat_pct"),
]
for label, key in metrics:
    row = f"{label:<25}"
    for t in tier_order:
        s = tier_stats.get(t)
        if s:
            v = s[key]
            if key == "n":
                row += f" | {v:>8}"
            elif key == "avg_length":
                row += f" | {v:>7.1f}"
            else:
                row += f" | {v:>7.1f}%"
        else:
            row += f" | {'-':>8}"
    print(row)


# ── 하하 특성 (프로파일 학습 대상) ──
print("\n\n" + "=" * 90)
print("하하 PD HAHA PD 채널 상세 (Exp 11 학습 대상 채널)")
print("=" * 90)
haha = by_channel.get("하하 PD HAHA PD", [])
if haha:
    s = analyze_group("haha", haha)
    print(f"\n표본: {s['n']}편")
    print(f"평균 길이: {s['avg_length']:.1f}자 (프롬프트 목표 8~18자와 대조)")
    print(f"금칙어 사용률: {s['banned_pct']:.1f}%")
    print(f"여운(…) 사용률: {s['ellipsis_pct']:.1f}%")
    print(f"인용부호 사용률: {s['quote_pct']:.1f}%")
    print(f"이모지 사용률: {s['emoji_pct']:.1f}%")


# ── high performer 실제 title 20개 샘플 ──
print("\n\n" + "=" * 90)
print("성과 tier=high 하하 채널 실제 제목 20개 (프롬프트 톤 검증용)")
print("=" * 90)
high_haha = [r for r in haha if r.get("view_tier") == "high"][:20]
for i, r in enumerate(high_haha[:20], 1):
    t = r["title"]
    ct = clean_title(t)
    flags = []
    if has_banned(t): flags.append("금칙")
    if has_ellipsis(t): flags.append("여운")
    if has_quote(t): flags.append("인용")
    if has_emoji(t): flags.append("이모지")
    if has_arrow_wave(t): flags.append("화살표")
    flag_str = f" [{'·'.join(flags)}]" if flags else ""
    print(f"  {i}. views={r['views']} · '{ct[:60]}'{flag_str}")


# ── 채널별 비교 (전체) ──
print("\n\n" + "=" * 90)
print("채널별 톤 대조 (모두 short 발행분)")
print("=" * 90)
print(f"\n{'채널':<25} | {'n':>4} | {'평균길이':>8} | {'금칙%':>6} | {'여운%':>6} | {'인용%':>6} | {'이모지%':>7}")
for ch, group in sorted(by_channel.items(), key=lambda x: -len(x[1]))[:10]:
    if len(group) < 30:
        continue
    s = analyze_group(ch, group)
    print(f"{ch:<25} | {s['n']:>4} | {s['avg_length']:>7.1f} | {s['banned_pct']:>5.1f}% | {s['ellipsis_pct']:>5.1f}% | {s['quote_pct']:>5.1f}% | {s['emoji_pct']:>6.1f}%")

# 저장
output = {
    "n_total_shorts": len(shorts),
    "tier_stats": tier_stats,
    "haha_stats": analyze_group("haha", haha) if haha else None,
    "high_performer_samples": [
        {"title": clean_title(r["title"]), "views": r["views"], "channel": r["channel"]}
        for r in [r for r in shorts if r.get("view_tier") == "high"][:30]
    ],
    "channel_comparison": {
        ch: analyze_group(ch, g) for ch, g in by_channel.items() if len(g) >= 30
    },
}
out_json = REPORT_DIR / "exp12_title_evidence.json"
json.dump(output, open(out_json, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n\n저장: {out_json}")

# -*- coding: utf-8 -*-
"""chyron canonicalizer 회귀 방지 — 등록 인물 유사 가명(나는SOLO 영수/영호/영철)이
서로를 잡아먹지 않아야 한다 (실측 2026-08-19 · flash-lite recall 이 드러낸 선재 버그)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from core.scenes.chyron_scan import _canonicalize_name_votes


def _mk(freqs):
    """{name: count} → cleaned_results 형태 [(idx, [name]), ...]."""
    out, i = [], 0
    for name, cnt in freqs.items():
        for _ in range(cnt):
            out.append((i, [name])); i += 1
    return out


def test_roster_names_never_merged():
    # 나는SOLO: 영수·영호·영철·영식 은 서로 다른 사람 · 전부 편집거리 1. roster 에 있으면 병합 금지.
    roster = ["영자", "영수", "영호", "영철", "영식"]
    canon = _canonicalize_name_votes(_mk({"영자": 20, "영수": 5, "영호": 4, "영철": 3, "영식": 2}), roster)
    for nm in roster:
        assert canon.get(nm) == nm, f"{nm} 이 {canon.get(nm)} 로 병합됨 (등록 인물은 보호돼야 함)"


def test_ocr_typo_merges_into_roster_name():
    # roster 인 '영자' 의 OCR 오탐 '영좌'(1회) 는 영자로 흡수돼야 한다(교정).
    canon = _canonicalize_name_votes(_mk({"영자": 20, "영좌": 1}), ["영자"])
    assert canon.get("영좌") == "영자", f"OCR 오탐이 교정 안 됨: {canon}"


def test_no_roster_minority_merges():
    # roster 없을 때: 명백한 소수(현기 2회)는 다수(현지 30회)로 흡수.
    canon = _canonicalize_name_votes(_mk({"현지": 30, "현기": 2}), None)
    assert canon.get("현기") == "현지", f"소수 오탐 병합 실패: {canon}"


def test_no_roster_two_frequent_not_merged():
    # roster 없어도 둘 다 자주 뜨면 별개 실명으로 본다(영수 10 vs 영자 12 → 10*4>12 → 미병합).
    canon = _canonicalize_name_votes(_mk({"영자": 12, "영수": 10}), None)
    assert canon.get("영수") == "영수", f"별개 실명이 병합됨: {canon}"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"  PASS {name}")
            except AssertionError as e:
                fails += 1; print(f"  FAIL {name}: {e}")
    print("OK" if not fails else f"{fails} FAILED")
    sys.exit(1 if fails else 0)

"""원본 자막 블러 검출의 병합 불변식 — 로컬 실측(2026-09-15)에서 밟은 함정을 고정한다.

여기서 고정하는 것 세 가지:
 1. **자막 존 필터** — 존 위(배경 간판·소품 글자)는 이벤트가 되면 안 된다. 존 없이 돌리면
    화면 곳곳에 블러 조각이 생긴다(실측).
 2. **줄 교체는 이벤트를 끊는다** — 중앙정렬 자막은 줄이 바뀌어도 IoU 가 높게 나와서,
    폭 유사도 게이트가 없으면 13초짜리 거대 이벤트로 연쇄된다(실측: 919→1677 폭 교체).
 3. **시간 패딩은 클립 경계를 넘지 않는다** — 넘으면 렌더 enable 창이 음수/초과 시각을 받는다.
"""
from __future__ import annotations

import unittest

from core.vision.subtitle_blur import (
    PAD_T_IN,
    PAD_T_OUT,
    filter_zone,
    merge_events,
    merge_frame_rects,
)


class 존필터(unittest.TestCase):
    def test_존_위_박스는_버린다(self):
        rects = [
            [100, 100, 400, 160],    # 상단 간판 — 중심 y=130
            [500, 830, 1400, 990],   # 하단 자막 — 중심 y=910
        ]
        kept = filter_zone(rects, height=1080, zone_top=0.72)
        self.assertEqual(kept, [[500, 830, 1400, 990]])

    def test_노이즈_크기는_버린다(self):
        rects = [[500, 900, 520, 990], [500, 900, 1400, 910]]  # 폭 20 · 높이 10
        self.assertEqual(filter_zone(rects, height=1080, zone_top=0.72), [])


class 프레임내병합(unittest.TestCase):
    def test_라벨줄과_대사줄은_한_덩어리(self):
        # 세로로 10px 떨어진 두 줄 — TOUCH_GAP_PX(24) 안이라 붙는다.
        merged = merge_frame_rects([[700, 850, 1200, 900], [500, 910, 1400, 1000]])
        self.assertEqual(merged, [[500, 850, 1400, 1000]])

    def test_멀리_떨어진_박스는_따로(self):
        merged = merge_frame_rects([[100, 850, 300, 950], [1500, 850, 1800, 950]])
        self.assertEqual(len(merged), 2)


class 시간축병합(unittest.TestCase):
    def test_같은_줄_연속은_한_이벤트_그리고_패딩(self):
        rect = [500, 830, 1400, 990]
        frames = [(10.0, [rect]), (10.5, [rect]), (11.0, [rect])]
        evs = merge_events(frames, step=0.5, clip_start=0.0, clip_end=100.0)
        self.assertEqual(len(evs), 1)
        self.assertAlmostEqual(evs[0].start, 10.0 - PAD_T_IN, places=3)
        self.assertAlmostEqual(evs[0].end, 11.0 + PAD_T_OUT, places=3)

    def test_줄_교체는_폭_게이트가_끊는다(self):
        # 실측 회귀: 같은 자리 중앙정렬로 폭 1000 → 1700 교체. IoU 만 보면 이어져
        # 첫 이벤트 사각형이 1700 폭까지 자란다 — 폭 비(0.59 < 0.6)가 끊어야 한다.
        narrow = [460, 830, 1460, 990]
        wide = [110, 830, 1810, 990]
        frames = [(10.0, [narrow]), (10.5, [narrow]), (11.0, [wide]), (11.5, [wide])]
        evs = merge_events(frames, step=0.5, clip_start=0.0, clip_end=100.0)
        self.assertEqual(len(evs), 2)
        self.assertEqual(evs[0].w, 1000)   # 좁은 줄 이벤트가 넓은 줄을 삼키지 않았다
        self.assertEqual(evs[1].w, 1700)

    def test_갭이_크면_따로(self):
        rect = [500, 830, 1400, 990]
        frames = [(10.0, [rect]), (13.0, [rect])]  # 3초 갭 > step*1.5
        evs = merge_events(frames, step=0.5, clip_start=0.0, clip_end=100.0)
        self.assertEqual(len(evs), 2)

    def test_패딩은_클립_경계를_안_넘는다(self):
        rect = [500, 830, 1400, 990]
        frames = [(0.0, [rect]), (19.9, [rect])]
        evs = merge_events(frames, step=0.5, clip_start=0.0, clip_end=20.0)
        self.assertGreaterEqual(min(e.start for e in evs), 0.0)
        self.assertLessEqual(max(e.end for e in evs), 20.0)


if __name__ == "__main__":
    unittest.main()

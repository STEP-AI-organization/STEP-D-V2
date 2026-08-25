"""숏폼 길이 하드 상한 고정 (MAX_SHORT_SEC).

2026-08-25 프로덕션 사고: **3분(180초)이 넘는 구간이 "숏폼" 으로 렌더·게시**됐다.
원인은 `_enforce_shortform_length` 가 **정의만 되고 아무도 부르지 않은 것**이었다 —
프로덕션 기본 경로(beat-only)에서 길이 상한은 프롬프트 문구("최대 2분")뿐이었고,
모델이 beat 을 많이 묶으면 그대로 통과했다. 길이는 LLM 이 아니라 결정론 코드가 지킨다.

여기서 고정하는 것: 상한을 넘는 shortform 은 **어떤 입력에서도** 상한 이내로 나온다.
"""
from __future__ import annotations

import unittest

from core.recommend.recommend import MAX_SHORT_SEC, _enforce_shortform_length


def beats(spans) -> list[dict]:
    return [{"id": i + 1, "start": float(s), "end": float(e)} for i, (s, e) in enumerate(spans)]


def short(start, end, beat_ids=None, type_="shortform") -> dict:
    s = {"type": type_, "start": float(start), "end": float(end)}
    if beat_ids is not None:
        s["beat_ids"] = list(beat_ids)
    return s


def only(shorts):
    assert len(shorts) == 1, shorts
    return shorts[0]


class ShortformLengthCap(unittest.TestCase):
    def test_상한_이내는_손대지_않는다(self):
        bs = beats([(0, 30), (30, 60)])
        out = only(_enforce_shortform_length([short(0, 60, [1, 2])], bs))
        self.assertEqual((out["start"], out["end"]), (0.0, 60.0))
        self.assertNotIn("_length_capped", out)

    def test_초과분은_뒷_beat_을_덜어_beat_경계에서_끝난다(self):
        # 0~40 / 40~80 / 80~200 → 200s. 세 번째 beat 를 덜면 80s 로 상한 이내.
        bs = beats([(0, 40), (40, 80), (80, 200)])
        out = only(_enforce_shortform_length([short(0, 200, [1, 2, 3])], bs))
        self.assertEqual(out["end"], 80.0)
        self.assertEqual(out["beat_ids"], [1, 2])
        self.assertTrue(out["_length_capped"])
        self.assertLessEqual(out["end"] - out["start"], MAX_SHORT_SEC)

    def test_첫_beat_하나가_이미_상한을_넘으면_하드컷한다(self):
        # 옛 구현의 구멍: 뒷 beat 만 드롭하는 루프라 첫 beat 은 검사 대상이 아니었고,
        # 293초짜리 beat 하나가 통째로 "숏폼" 으로 남았다.
        bs = beats([(10, 303)])
        out = only(_enforce_shortform_length([short(10, 303, [1])], bs))
        self.assertEqual(out["end"] - out["start"], MAX_SHORT_SEC)
        self.assertTrue(out["_length_capped"])

    def test_beat_ids_가_없어도_하드컷한다(self):
        # 옛 구현은 beat_ids 가 비면 그대로 통과시켰다 — 상한이 조건부면 상한이 아니다.
        out = only(_enforce_shortform_length([short(0, 240)], beats([(0, 240)])))
        self.assertEqual(out["end"] - out["start"], MAX_SHORT_SEC)

    def test_beats_목록이_비어도_하드컷한다(self):
        out = only(_enforce_shortform_length([short(0, 240, [1])], []))
        self.assertEqual(out["end"] - out["start"], MAX_SHORT_SEC)

    def test_clip_highlight_는_건드리지_않는다(self):
        bs = beats([(0, 900)])
        out = _enforce_shortform_length(
            [short(0, 900, [1], "clip"), short(0, 900, [1], "highlight")], bs)
        self.assertEqual([(s["start"], s["end"]) for s in out], [(0.0, 900.0), (0.0, 900.0)])

    def test_어떤_조합에서도_상한을_넘지_않는다(self):
        bs = beats([(0, 7), (7, 130), (130, 140), (140, 400)])
        cases = [
            short(0, 400, [1, 2, 3, 4]),
            short(7, 400, [2, 3, 4]),
            short(130, 400, [3, 4]),
            short(0, 400, []),
            short(0, 400, [99]),          # 모르는 beat id
            short(0, 400, None),
        ]
        for s in cases:
            with self.subTest(s=s):
                out = only(_enforce_shortform_length([dict(s)], bs))
                self.assertLessEqual(round(out["end"] - out["start"], 3), MAX_SHORT_SEC)
                self.assertGreater(out["end"], out["start"])

    def test_역전_구간은_버린다(self):
        self.assertEqual(_enforce_shortform_length([short(50, 50, [1])], beats([(0, 60)])), [])


if __name__ == "__main__":
    unittest.main()

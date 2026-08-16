"""클립(롱폼) 조립 규칙 고정.

클립은 쇼츠를 늘린 게 아니라 **beat 를 이어 붙인** 물건이다. 길이 기준은 사용자 확정값이고
(최소 3분 · 8분부터 유튜브 미드롤 광고 가능 · 상한 15분), 여기가 흔들리면 "자동배포로 나가는
롱폼" 이 통째로 성립하지 않는다. 결정론이라 LLM 없이 그대로 검증된다.
"""
from __future__ import annotations

import unittest

from core.recommend.recommend import (
    CLIP_GAP_SEC,
    CLIP_MAX_SEC,
    CLIP_MIN_SEC,
    CLIP_MONETIZE_SEC,
    build_clips_from_beats,
)


def beats(spans) -> list[dict]:
    """(start, end) 목록 → beat dict 목록."""
    return [
        {
            "id": i + 1, "start": float(s), "end": float(e),
            "title": f"beat{i + 1}", "summary": f"요약{i + 1}",
            "characters": ["김한나"], "hook": "웃음",
        }
        for i, (s, e) in enumerate(spans)
    ]


class ClipLengthRules(unittest.TestCase):
    def test_기준값(self):
        self.assertEqual(CLIP_MIN_SEC, 180.0)        # 최소 3분
        self.assertEqual(CLIP_MONETIZE_SEC, 480.0)   # 8분 = 미드롤 광고 가능
        self.assertEqual(CLIP_MAX_SEC, 900.0)        # 상한 15분

    def test_3분_미만은_클립이_아니다(self):
        # 이어 붙여도 최소 길이를 못 채우면 만들지 않는다 — 억지로 늘리지 않는다.
        self.assertEqual(build_clips_from_beats(beats([(0, 60), (60, 120)])), [])

    def test_8분_이상은_수익화_가능으로_표시(self):
        clips = build_clips_from_beats(beats([(0, 300), (300, 600)]))
        self.assertEqual(len(clips), 1)
        self.assertTrue(clips[0]["monetizable"])

    def test_점수가_자동배포_기준과_맞물린다(self):
        """`score80` 을 건 클립 규칙 = '미드롤 가능한 클립만' 이어야 한다.

        쇼츠 분포에 맞춘 기준(80)을 클립에 그대로 적용하면서 점수를 낮게 주면,
        규칙은 켜져 있는데 한 건도 안 나가는 상태가 된다(이 리포 최빈 실패모드).
        """
        long_clip = build_clips_from_beats(beats([(0, 300), (300, 600)]))[0]
        short_clip = build_clips_from_beats(beats([(0, 100), (100, 200)]))[0]
        self.assertGreaterEqual(long_clip["score100"], 80, "8분+ 클립이 score80 을 못 넘는다")
        self.assertLess(short_clip["score100"], 80, "3분대 클립까지 score80 을 넘으면 기준이 무의미해진다")

    def test_상한을_넘기지_않는다(self):
        spans = [(i * 120, (i + 1) * 120) for i in range(10)]   # 2분 × 10 = 20분
        clips = build_clips_from_beats(beats(spans))
        self.assertGreaterEqual(len(clips), 1)
        for c in clips:
            length = c["end"] - c["start"]
            self.assertLessEqual(length, CLIP_MAX_SEC + 0.001)
            self.assertGreaterEqual(length, CLIP_MIN_SEC)


class ClipAssembly(unittest.TestCase):
    def test_인접_beat_를_이어_붙인다(self):
        clips = build_clips_from_beats(beats([(0, 120), (120, 240), (240, 300)]))
        self.assertEqual(len(clips), 1)
        c = clips[0]
        self.assertEqual((c["start"], c["end"]), (0.0, 300.0))
        self.assertEqual(c["type"], "clip")
        self.assertEqual(c["aspect"], "16:9", "클립은 가로형이어야 한다")
        self.assertEqual(c["beat_ids"], [1, 2, 3])
        self.assertFalse(c["monetizable"])   # 5분 — 미드롤 기준(8분) 미달

    def test_멀리_떨어진_beat_는_다른_코너로_본다(self):
        gap = CLIP_GAP_SEC + 60
        clips = build_clips_from_beats(beats([(0, 120), (120 + gap, 240 + gap)]))
        self.assertEqual(clips, [], "끊긴 구간을 이어 붙이면 중간에 없는 내용이 들어간다")

    def test_겹치는_클립은_하나만_남는다(self):
        clips = build_clips_from_beats(beats([(0, 200), (200, 400), (400, 600)]))
        for a, b in zip(clips, clips[1:]):
            self.assertLessEqual(a["end"], b["start"],
                                 "겹치는 클립이 둘 다 나가면 같은 구간이 두 번 배포된다")

    def test_제목_요약은_beat_에서만_가져온다(self):
        # 지어내지 않는다 — 클립 제목·설명의 출처는 beat annotate 결과뿐이다.
        clips = build_clips_from_beats(beats([(0, 200), (200, 400)]))
        self.assertEqual(clips[0]["title"], "beat1")
        self.assertIn("요약1", clips[0]["reason"])

    def test_깨진_beat_는_조용히_건너뛴다(self):
        bad = [
            {"id": 1, "start": 0, "end": 0},        # 영길이
            {"id": 2, "start": 100, "end": 50},     # 역전
            {"id": 3},                               # 시간 없음
        ]
        self.assertEqual(build_clips_from_beats(bad), [])



class SignalAwareClips(unittest.TestCase):
    """오디오 신호가 **점수**와 **경계** 둘 다에 쓰이는가.

    사용자 방향(2026-08-16): "STT 데시벨 점수 좀 넣고 싶어."
    이미 신호축(audio_pct·audio_delta)은 쇼츠 점수에 있었지만 클립은 길이·beat 수만 봤다.
    """

    def test_조용한_클립보다_터지는_클립이_앞선다(self):
        spans = [(i * 120, (i + 1) * 120) for i in range(5)]   # 10분
        loud = build_clips_from_beats(beats(spans), sig_pct={i + 1: 1.0 for i in range(5)})
        quiet = build_clips_from_beats(beats(spans), sig_pct={i + 1: 0.0 for i in range(5)})
        self.assertGreater(loud[0]["score100"], quiet[0]["score100"],
                           "신호가 점수에 반영되지 않으면 조용한 8분과 터지는 8분이 같은 값을 받는다")
        self.assertTrue(loud[0]["score_parts"]["has_signals"])

    def test_신호가_없으면_중립으로_진행한다(self):
        # 옛 회차·ffmpeg 실패로 신호가 없어도 클립은 나와야 한다(막으면 회귀).
        clips = build_clips_from_beats(beats([(0, 300), (300, 600)]))
        self.assertEqual(len(clips), 1)
        self.assertFalse(clips[0]["score_parts"]["has_signals"])
        self.assertEqual(clips[0]["score_parts"]["signal"], 0.5)

    def test_상한을_넘기면_가장_조용한_지점에서_끊는다(self):
        # 길이 상한만으로 끊으면 '회차를 N등분한 것'이 된다(실측). 조용한 경계 = 장면 전환.
        spans = [(i * 60, (i + 1) * 60) for i in range(20)]     # 1분 × 20 = 20분
        sig = {i + 1: 1.0 for i in range(20)}
        sig[10] = 0.0                                           # 10분 지점이 가장 조용하다
        clips = build_clips_from_beats(beats(spans), max_clips=5, sig_pct=sig)
        self.assertTrue(clips, "클립이 하나도 안 나왔다")
        self.assertAlmostEqual(clips[0]["end"], 600.0, delta=1.0,
                               msg="가장 조용한 경계에서 끊지 않았다")


if __name__ == "__main__":
    unittest.main()

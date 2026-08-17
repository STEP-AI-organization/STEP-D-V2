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



class HookWindow(unittest.TestCase):
    """쇼츠 첫 3초 훅 — 쇼츠 **안에서** 가장 튀는 지점을 결정론으로 고른다.

    사용자 방향(2026-08-16): "숏폼은 금방 넘기니깐, 만든 숏폼 안 소스 중에서 자극적이거나
    데시벨 큰 곳 찾아서 3초 넣는 것."
    예전엔 이 값을 LLM 응답에서 받으려 했는데 모델이 안 채워 **실측 5개 중 0개**였고,
    그래서 에디터 토글이 늘 비활성이었다(hookAvailable = hookTimeSec 존재 여부).
    """

    @staticmethod
    def _beats(spans, deltas):
        return [
            {"id": i + 1, "start": float(s), "end": float(e),
             "signals": {"audio_delta": d, "audio_pct": d}}
            for i, ((s, e), d) in enumerate(zip(spans, deltas))
        ]

    def test_데시벨이_가장_튀는_beat_을_고른다(self):
        from core.recommend.recommend import _pick_hook_window
        spans = [(0, 10), (10, 20), (20, 30)]
        picked = self._beats(spans, [0.1, 0.9, 0.3])   # 두 번째가 가장 튄다
        r = _pick_hook_window(picked, 0.0, 30.0, None)
        self.assertAlmostEqual(r["hook_time_sec"], 10.0, delta=0.01)

    def test_쇼츠_맨_앞은_피한다(self):
        # 훅이 본편 시작과 같으면 같은 장면이 두 번 나온다(실측에서 5개 중 3개가 그랬다).
        from core.recommend.recommend import _HOOK_MIN_OFFSET_SEC, _pick_hook_window
        picked = self._beats([(0, 5), (5, 10)], [0.9, 0.2])   # 맨 앞이 가장 튄다
        r = _pick_hook_window(picked, 0.0, 10.0, None)
        self.assertGreaterEqual(r["hook_time_sec"], _HOOK_MIN_OFFSET_SEC)

    def test_자막은_그_시점_실제_대사를_쓴다(self):
        # 지어내면 영상에 없는 말이 자막으로 나간다.
        from core.recommend.recommend import _pick_hook_window
        picked = self._beats([(0, 10), (10, 20)], [0.1, 0.9])
        tr = [{"start": 10.5, "end": 12.0, "text": "진짜 몰랐어요?"}]
        r = _pick_hook_window(picked, 0.0, 20.0, tr)
        self.assertEqual(r["hook_quote"], "진짜 몰랐어요?")

    def test_너무_짧은_쇼츠는_훅을_만들지_않는다(self):
        from core.recommend.recommend import _pick_hook_window
        self.assertEqual(_pick_hook_window(self._beats([(0, 2)], [0.9]), 0.0, 2.0, None), {})


class HookQuoteLocate(unittest.TestCase):
    """LLM 이 고른 훅 대사의 **시각은 전사에서 찾는다.**

    실측(m_981d7c08 · 32.4분 회차 · 2026-08-17): 모델이 준 `hook_time_sec` 은 20개 중 17개가
    똑같이 `2.0` 이었고, 그 시각의 실제 대사와 대조하니 **12개가 딴 말**이었다. 그대로 렌더하면
    훅 3초 동안 그 순간 나오지 않는 말이 자막으로 박힌다. 의미 판단(어느 대사가 자극적인가)은
    LLM 이 하고, 셈(몇 초인가)은 전사에서 우리가 한다.
    """

    TR = [
        {"start": 0.4, "end": 3.0, "text": "자, 다음 순서 갈게요."},
        {"start": 12.2, "end": 15.4, "text": "저 사실은 한의사예요."},
        {"start": 40.0, "end": 42.0, "text": "끝인사 하겠습니다."},
    ]

    def test_인용을_찾아_그_시각을_쓴다(self):
        from core.recommend.recommend import _locate_quote
        r = _locate_quote("저 사실은 한의사예요", 0.0, 45.0, self.TR)
        self.assertAlmostEqual(r["hook_time_sec"], 12.2, delta=0.01)
        self.assertEqual(r["hook_quote"], "저 사실은 한의사예요.")

    def test_조사_마침표가_달라도_찾는다(self):
        # 모델은 인용을 다듬는다 — 공백·문장부호로 매칭이 깨지면 매번 폴백으로 떨어진다.
        from core.recommend.recommend import _locate_quote
        r = _locate_quote("저 사실 한의사 예요!!", 0.0, 45.0, self.TR)
        self.assertAlmostEqual(r["hook_time_sec"], 12.2, delta=0.01)

    def test_지어낸_인용은_폴백으로_넘긴다(self):
        from core.recommend.recommend import _locate_quote
        self.assertEqual(_locate_quote("영상에 없는 말입니다", 0.0, 45.0, self.TR), {})

    def test_쇼츠_맨앞_대사는_훅으로_안_쓴다(self):
        # 본편 시작과 같은 그림이 두 번 나오는 것을 막는 하한(_HOOK_MIN_OFFSET_SEC)은
        # 인용 경로에도 똑같이 걸려야 한다.
        from core.recommend.recommend import _locate_quote
        self.assertEqual(_locate_quote("자, 다음 순서 갈게요", 0.0, 45.0, self.TR), {})

    def test_모델_시각은_쓰지_않는다(self):
        # 응답에 hook_time_sec 이 있어도 산출물엔 전사에서 찾은 값이 들어가야 한다.
        # (구조상 보증: _locate_quote·_pick_hook_window 만 이 키를 만든다)
        import inspect

        from core.recommend import recommend as R
        src = inspect.getsource(R.propose_shorts_beat_only)
        self.assertNotIn('s["hook_time_sec"]', src,
                         "모델이 준 hook_time_sec 을 산출물에 다시 끼워 넣었다")
        self.assertNotIn('s.get("hook_time_sec")', src,
                         "모델이 준 hook_time_sec 을 산출물에 다시 끼워 넣었다")


if __name__ == "__main__":
    unittest.main()

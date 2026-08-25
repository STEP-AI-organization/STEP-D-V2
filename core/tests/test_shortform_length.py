"""숏폼 길이 하드 상한 — **추천 목록에 상한 초과가 애초에 안 뜬다.**

2026-08-25 프로덕션 사고: 3분(180초)이 넘는 구간이 "숏폼" 으로 추천 → 자동배포 → 게시됐다.
뿌리는 렌더가 아니라 **추천/선정 단계**였다:

  · `propose_shorts_beat_only` 산출부에 "서버측 duration 상·하한 없음 · 결정은 AI에 맡김"
    이라고 **명시적으로** 적혀 있었다 (2026-07-27). 상한은 프롬프트 문구뿐이었다.
  · `_deterministic_score` 의 축은 signal·hook·closure 셋뿐 — **길이 축이 없다.** 즉 과길이
    후보는 걸러지지도, 디랭크되지도 않았다.
  · `_length_fit`(_LEN_OK=25~90s)은 정의만 되고 아무도 안 부른다(docstring 이 "score100 에는
    반영하지 않는다" 라고 스스로 밝힌다).
  · `apply_profile_fit` 의 길이 인자는 profile.targetLength 가 있을 때만 · 하한 0.55 의
    **소프트 배수**다. `apply_channel_fit` 도 하한 0.25 의 디랭크로 "절대 드롭 안 함" 이 설계다.

상한은 취향이 아니라 물건의 정의다. 이 파일이 그 정의를 고정한다.
값은 **MAX_SHORT_SEC(90s)** — 리포가 이미 선언한 운영 상한이고(`recommend.py:58` "쇼츠는
완결성을 보존하되 1분 30초를 넘기지 않는다"), 나머지 두 산출 경로(`validate_shorts`·
`heuristic_shorts`)가 이미 같은 값을 쓴다.
"""
from __future__ import annotations

import json
import unittest

from core.recommend.recommend import (
    MAX_SHORT_SEC,
    _enforce_shortform_length,
    propose_shorts_beat_only,
)


def beats(spans) -> list[dict]:
    return [{"id": i + 1, "start": float(s), "end": float(e)} for i, (s, e) in enumerate(spans)]


def even_beats(n: int, sec: float) -> list[dict]:
    return beats([(i * sec, (i + 1) * sec) for i in range(n)])


def short(start, end, beat_ids=None, type_="shortform") -> dict:
    s = {"type": type_, "start": float(start), "end": float(end)}
    if beat_ids is not None:
        s["beat_ids"] = list(beat_ids)
    return s


def only(shorts):
    assert len(shorts) == 1, shorts
    return shorts[0]


def lengths(shorts) -> list[float]:
    return [round(float(s["end"]) - float(s["start"]), 1) for s in shorts]


# ── 1차 방어: 후보 산출부 ────────────────────────────────────────────────────────

class _FakeResp:
    """genai 응답 스텁 — call_with_retry 는 usage_metadata 가 없으면 조용히 넘어간다."""
    def __init__(self, payload: dict):
        self.text = json.dumps(payload, ensure_ascii=False)


class _FakeModels:
    def __init__(self, payload: dict):
        self._payload = payload

    def generate_content(self, **_kwargs):
        return _FakeResp(self._payload)


class _FakeClient:
    """LLM 을 그대로 흉내낸다 — 모델이 '3분짜리 조합'을 골라 보내는 상황을 재현한다."""
    def __init__(self, payload: dict):
        self.models = _FakeModels(payload)


def propose(beats_: list[dict], shorts_payload: list[dict]) -> list[dict]:
    return propose_shorts_beat_only(
        _FakeClient({"shorts": shorts_payload}),
        beats_, transcript=None, genre="예능", n=5, cast_registry=None,
    )


class ProducerHardBound(unittest.TestCase):
    """모델이 무엇을 고르든 산출부를 나온 숏폼은 상한 이내다."""

    def test_모델이_회차_전체를_묶어도_상한_이내로만_나온다(self):
        # 10초 beat 30개(=300초) 전부를 하나의 "숏폼" 으로 묶어 보낸 경우.
        out = propose(even_beats(30, 10.0), [{"beat_ids": list(range(30)), "title": "통짜"}])
        self.assertEqual(len(out), 1)
        self.assertLessEqual(lengths(out)[0], MAX_SHORT_SEC)
        # 컷은 beat 경계에 남는다 — 임의 시각 하드컷이면 대사 중간이 잘린다.
        self.assertEqual(out[0]["end"], 90.0)
        self.assertEqual(out[0]["beat_ids"], list(range(9)))

    def test_첫_beat_하나가_이미_상한_초과면_후보에서_제외된다(self):
        # beats.py _force_split_large_beats 는 화자 전환점이 없으면 원본을 유지한다 →
        # 3분 넘는 beat 이 실제로 존재할 수 있고, 그게 그대로 "숏폼" 이 되던 게 뿌리다.
        bs = beats([(0, 200), (200, 230)])
        self.assertEqual(propose(bs, [{"beat_ids": [0], "title": "3분 20초"}]), [])
        self.assertEqual(propose(bs, [{"beat_ids": [0, 1], "title": "더 긴 조합"}]), [])

    def test_상한_이내_조합은_그대로_통과한다(self):
        out = propose(even_beats(30, 10.0), [{"beat_ids": [3, 4, 5, 6], "title": "정상"}])
        self.assertEqual(lengths(out), [40.0])
        self.assertEqual(out[0]["beat_ids"], [3, 4, 5, 6])

    def test_어떤_조합에서도_산출물은_상한을_넘지_않는다(self):
        bs = even_beats(40, 7.5)                       # 300초 회차
        payload = [{"beat_ids": list(range(i, min(40, i + k))), "title": f"c{i}-{k}"}
                   for i in range(0, 40, 3) for k in (1, 4, 13, 40)]
        for s in propose(bs, payload):
            self.assertLessEqual(round(float(s["end"]) - float(s["start"]), 3), MAX_SHORT_SEC)
            self.assertGreater(float(s["end"]), float(s["start"]))

    def test_상한_초과가_다른_후보를_죽이지_않는다(self):
        # 과길이 하나 때문에 보드가 통째로 비면 안 된다 — 제외는 그 후보에만 적용된다.
        bs = beats([(0, 200)] + [(200 + i * 10, 210 + i * 10) for i in range(10)])
        out = propose(bs, [{"beat_ids": [0], "title": "롱폼"},
                           {"beat_ids": [1, 2, 3], "title": "정상"}])
        self.assertEqual([s["title"] for s in out], ["정상"])


# ── 최종 관문: 모든 경계 조정 뒤 ────────────────────────────────────────────────

class FinalGate(unittest.TestCase):
    def test_상한_이내는_손대지_않는다(self):
        out = only(_enforce_shortform_length([short(0, 60, [1, 2])], beats([(0, 30), (30, 60)])))
        self.assertEqual((out["start"], out["end"]), (0.0, 60.0))
        self.assertNotIn("_length_capped", out)

    def test_초과분은_뒷_beat_을_덜어_beat_경계에서_끝난다(self):
        bs = beats([(0, 40), (40, 80), (80, 200)])
        out = only(_enforce_shortform_length([short(0, 200, [1, 2, 3])], bs))
        self.assertEqual(out["end"], 80.0)
        self.assertEqual(out["beat_ids"], [1, 2])
        self.assertTrue(out["_length_capped"])

    def test_beat_을_덜어도_못_맞추면_제외한다_하드컷_아님(self):
        # 임의 시각 하드컷은 "머리만 남은 롱폼" 을 만든다 — 숏폼이 아니다.
        self.assertEqual(_enforce_shortform_length([short(10, 303, [1])], beats([(10, 303)])), [])
        self.assertEqual(_enforce_shortform_length([short(0, 240)], beats([(0, 240)])), [])
        self.assertEqual(_enforce_shortform_length([short(0, 240, [1])], []), [])

    def test_clip_highlight_는_건드리지_않는다(self):
        bs = beats([(0, 900)])
        out = _enforce_shortform_length(
            [short(0, 900, [1], "clip"), short(0, 900, [1], "highlight")], bs)
        self.assertEqual(lengths(out), [900.0, 900.0])

    def test_통과한_것은_모두_상한_이내다(self):
        bs = beats([(0, 7), (7, 130), (130, 140), (140, 400)])
        cases = [short(0, 400, [1, 2, 3, 4]), short(7, 400, [2, 3, 4]),
                 short(130, 400, [3, 4]), short(0, 400, []), short(0, 400, [99]),
                 short(0, 400, None), short(0, 45, [1])]
        for s in cases:
            with self.subTest(s=s):
                for out in _enforce_shortform_length([dict(s)], bs):
                    self.assertLessEqual(round(out["end"] - out["start"], 3), MAX_SHORT_SEC)
                    self.assertGreater(out["end"], out["start"])

    def test_역전_구간은_버린다(self):
        self.assertEqual(_enforce_shortform_length([short(50, 50, [1])], beats([(0, 60)])), [])


if __name__ == "__main__":
    unittest.main()

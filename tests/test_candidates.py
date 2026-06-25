import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.candidates import Candidate, detect_candidates, refine_candidates  # noqa: E402


def _candidate(start: float, end: float) -> Candidate:
    return Candidate(
        id="cand_001",
        start=start,
        end=end,
        anchor_time=start,
        transcript="rough transcript",
        local_score=50.0,
        hook_terms=["반전"],
    )


def _refine(candidate: Candidate, transcript: dict, *, min_seconds: int = 20, max_seconds: float = 70) -> Candidate:
    return refine_candidates(
        candidates=[candidate],
        transcript=transcript,
        video_duration=120.0,
        min_seconds=min_seconds,
        max_seconds=max_seconds,
        start_lookback_seconds=6.0,
        end_lookahead_seconds=8.0,
        pre_padding_seconds=0.4,
        post_padding_seconds=0.8,
    )[0]


class CandidateDetectionTest(unittest.TestCase):
    def test_korean_shorts_hook_terms_rank_reversal_segment_first(self):
        transcript = {
            "segments": [
                {"start": 0.0, "end": 8.0, "text": "오늘은 평범하게 하루를 시작했습니다."},
                {"start": 10.0, "end": 18.0, "text": "그런데 갑자기 분위기가 완전히 뒤집혔어요."},
                {"start": 20.0, "end": 28.0, "text": "진짜 소름 돋는 반전이 여기서 나옵니다."},
                {"start": 30.0, "end": 38.0, "text": "마지막에는 모두가 댓글로 인정할 장면이에요."},
            ],
        }

        candidates = detect_candidates(
            transcript=transcript,
            video_duration=60.0,
            min_seconds=20,
            max_seconds=45,
            target_seconds=30,
            max_candidates=5,
        )

        self.assertGreaterEqual(len(candidates), 1)
        self.assertIn("반전", candidates[0].hook_terms)
        self.assertGreaterEqual(candidates[0].local_score, 60)

    def test_anchor_window_keeps_hook_near_the_opening(self):
        transcript = {
            "segments": [
                {"start": 0.0, "end": 8.0, "text": "평범한 설명이 조금 이어집니다."},
                {"start": 20.0, "end": 26.0, "text": "그런데 여기서 진짜 소름 돋는 반전이 나옵니다."},
                {"start": 27.0, "end": 42.0, "text": "댓글 반응이 갈릴 만큼 분위기가 완전히 바뀌었어요."},
            ],
        }

        candidates = detect_candidates(
            transcript=transcript,
            video_duration=70.0,
            min_seconds=20,
            max_seconds=45,
            target_seconds=30,
            max_candidates=3,
        )

        self.assertGreaterEqual(len(candidates), 1)
        self.assertLessEqual(20.0 - candidates[0].start, 2.0)
        self.assertIn("반전", candidates[0].hook_terms)

    def test_plain_korean_segments_use_low_weight_fallback_windows(self):
        transcript = {
            "segments": [
                {"start": 0.0, "end": 12.0, "text": "오늘은 자료를 정리하고 다음 일정을 설명했습니다."},
                {"start": 15.0, "end": 27.0, "text": "이어서 평범한 안내와 배경 설명이 계속됩니다."},
                {"start": 30.0, "end": 42.0, "text": "마무리로 전체 내용을 다시 한번 정리했습니다."},
            ],
        }

        candidates = detect_candidates(
            transcript=transcript,
            video_duration=60.0,
            min_seconds=20,
            max_seconds=45,
            target_seconds=30,
            max_candidates=5,
        )

        self.assertGreaterEqual(len(candidates), 1)
        self.assertTrue(all(candidate.local_score < 32 for candidate in candidates))


class CandidateBoundaryRefinementTest(unittest.TestCase):
    def test_expands_mid_segment_start_to_first_word_padding(self):
        transcript = {
            "segments": [{"start": 10.0, "end": 30.0, "text": "hello world complete"}],
            "words": [
                {"start": 10.2, "end": 10.7, "word": "hello"},
                {"start": 29.0, "end": 29.1, "word": "complete"},
            ],
        }

        refined = _refine(_candidate(12.0, 22.0), transcript)

        self.assertAlmostEqual(refined.original_start, 12.0)
        self.assertAlmostEqual(refined.start, 9.8)
        self.assertIn("word-start", refined.boundary_reason)

    def test_extends_mid_segment_end_to_last_word_padding(self):
        transcript = {
            "segments": [{"start": 10.0, "end": 30.0, "text": "hello world complete"}],
            "words": [
                {"start": 10.2, "end": 10.7, "word": "hello"},
                {"start": 29.0, "end": 29.1, "word": "complete"},
            ],
        }

        refined = _refine(_candidate(12.0, 22.0), transcript)

        self.assertAlmostEqual(refined.original_end, 22.0)
        self.assertAlmostEqual(refined.end, 29.9)
        self.assertIn("word-end", refined.boundary_reason)

    def test_short_refinement_expands_to_nearby_segment_boundary(self):
        transcript = {
            "segments": [
                {"start": 10.0, "end": 15.0, "text": "short start"},
                {"start": 16.0, "end": 33.0, "text": "nearby complete sentence"},
            ],
            "words": [],
        }

        refined = _refine(_candidate(11.0, 13.0), transcript)

        self.assertGreaterEqual(refined.duration, 20.0)
        self.assertAlmostEqual(refined.end, 33.8)
        self.assertIn("min-duration", refined.boundary_reason)

    def test_long_refinement_trims_to_complete_segment_before_max_duration(self):
        segments = [{"start": float(i), "end": float(i + 10), "text": f"segment {i}"} for i in range(0, 100, 10)]
        words = [{"start": float(i), "end": float(i + 9.6), "word": f"word{i}"} for i in range(0, 100, 10)]
        transcript = {"segments": segments, "words": words}

        refined = _refine(_candidate(0.0, 90.0), transcript)

        self.assertLessEqual(refined.duration, 70.0)
        self.assertAlmostEqual(refined.end, 70.0)
        self.assertIn("max-duration", refined.boundary_reason)

    def test_uses_segment_boundaries_when_words_are_missing(self):
        transcript = {
            "segments": [{"start": 5.0, "end": 18.0, "text": "segment only"}],
            "words": [],
        }

        refined = _refine(_candidate(8.0, 12.0), transcript, min_seconds=5)

        self.assertAlmostEqual(refined.start, 4.6)
        self.assertAlmostEqual(refined.end, 18.8)
        self.assertIn("segment-start", refined.boundary_reason)
        self.assertIn("segment-end", refined.boundary_reason)

    def test_falls_back_to_conservative_padding_without_stt_boundaries(self):
        refined = _refine(_candidate(10.0, 20.0), {"segments": [], "words": []}, min_seconds=5)

        self.assertAlmostEqual(refined.start, 9.6)
        self.assertAlmostEqual(refined.end, 20.8)
        self.assertIn("fallback-start-padding", refined.boundary_reason)
        self.assertIn("fallback-end-padding", refined.boundary_reason)


if __name__ == "__main__":
    unittest.main()

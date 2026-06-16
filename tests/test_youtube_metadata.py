import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

try:
    from app.services.youtube_metadata import build_youtube_metadata  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name in {"sqlalchemy", "pydantic", "pydantic_settings"}:
        build_youtube_metadata = None
    else:
        raise


@unittest.skipIf(build_youtube_metadata is None, "API dependencies are not installed in this Python environment")
class YouTubeMetadataTest(unittest.TestCase):
    def test_metadata_limits_description_and_tags_for_youtube(self):
        clip = SimpleNamespace(
            title="반전 있는 한국 쇼츠 제목",
            reason="처음엔 평범하지만 마지막에 소름 돋는 반전이 있습니다.",
            transcript=" ".join(["그런데 갑자기 분위기가 뒤집히는 장면입니다."] * 120),
            thumbnail_text="반전 있습니다",
            thumbnail_description="실제 프레임 기반 썸네일",
            score=96,
            start_time=12.0,
            end_time=52.0,
            evaluation_json={
                "metadata_overrides": {
                    "description": "설명" * 4000,
                    "tags": [f"tag-{index:03d}" for index in range(200)],
                }
            },
        )

        metadata = build_youtube_metadata(clip)

        self.assertLessEqual(len(metadata["description"]), 5000)
        self.assertLessEqual(len(",".join(metadata["tags"])), 500)
        self.assertEqual("반전 있는 한국 쇼츠 제목", metadata["youtube_title"])

    def test_metadata_adds_korean_shorts_labels_and_hashtags(self):
        clip = SimpleNamespace(
            title="진짜 소름 돋는 반전 장면",
            reason="한국 쇼츠 시청자가 끝까지 보게 만드는 반전과 감정이 있습니다.",
            transcript="그런데 알고 보니 완전히 다른 이야기였고 댓글 반응이 갈렸습니다.",
            thumbnail_text="소름 반전",
            thumbnail_description="인물 반응이 잘 보이는 프레임",
            score=91,
            start_time=3.0,
            end_time=43.0,
            evaluation_json={"hook_terms": ["소름", "반전"]},
        )

        metadata = build_youtube_metadata(clip)

        self.assertIn("한국쇼츠", metadata["labels"])
        self.assertIn("반전", metadata["labels"])
        self.assertIn("#한국쇼츠", metadata["hashtags"])
        self.assertIn("유튜브쇼츠", metadata["tags"])


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.youtube_metadata import normalize_shorts_publish_metadata  # noqa: E402


class YouTubePublishTest(unittest.TestCase):
    def test_publish_metadata_adds_shorts_hashtag_to_description(self):
        title, description, tags = normalize_shorts_publish_metadata("제목", "설명", ["뉴스"])

        self.assertEqual("제목 #short", title)
        self.assertEqual("설명 #Shorts", description)
        self.assertEqual("Shorts", tags[0])
        self.assertEqual(1, sum(1 for tag in tags if tag.lower() == "shorts"))

    def test_publish_metadata_does_not_duplicate_existing_title_hashtag(self):
        title, description, tags = normalize_shorts_publish_metadata("제목 #Shorts", "설명", ["Shorts", "뉴스"])

        self.assertEqual("제목 #Shorts", title)
        self.assertEqual("설명 #Shorts", description)
        self.assertEqual(["Shorts", "뉴스"], tags)

    def test_publish_metadata_accepts_singular_short_hashtag(self):
        title, description, tags = normalize_shorts_publish_metadata("제목 #short", "설명 #short", [])

        self.assertEqual("제목 #short", title)
        self.assertEqual("설명 #short", description)
        self.assertEqual(["Shorts"], tags)

    def test_publish_metadata_keeps_shorts_hashtag_after_description_limit(self):
        long_description = ("설명" * 3000) + " #Shorts"
        _title, description, _tags = normalize_shorts_publish_metadata("제목", long_description, [])

        self.assertLessEqual(len(description), 5000)
        self.assertIn("#Shorts", description)

    def test_publish_metadata_keeps_title_hashtag_after_title_limit(self):
        long_title = "제목" * 80
        title, _description, _tags = normalize_shorts_publish_metadata(long_title, "설명", [])

        self.assertLessEqual(len(title), 100)
        self.assertTrue(title.endswith(" #short"))


if __name__ == "__main__":
    unittest.main()

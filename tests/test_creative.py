import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

try:
    from app.services.creative import generate_title_options  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name in {"httpx", "sqlalchemy", "pydantic", "pydantic_settings"}:
        generate_title_options = None
    else:
        raise


@unittest.skipIf(generate_title_options is None, "API dependencies are not installed in this Python environment")
class CreativeTitleOptionsTest(unittest.TestCase):
    def test_fallback_generates_korean_shorts_title_options(self):
        clip = SimpleNamespace(
            title="첫 문장에서 바로 끌리는 강한 순간",
            reason="반전 키워드와 감정 표현이 함께 있습니다.",
            transcript=(
                "처음에는 다들 그냥 웃고 있었어요. "
                "그런데 갑자기 분위기가 완전히 뒤집혔습니다. "
                "마지막 한마디 때문에 댓글 반응이 갈릴 장면이에요."
            ),
            thumbnail_text="이건 봐야죠",
            evaluation_json={"hook_terms": ["반전", "소름"]},
        )
        settings = SimpleNamespace(gemini_api_key="")

        options = generate_title_options(clip, settings)

        self.assertEqual(5, len(options))
        self.assertIn("hook", {option["style"] for option in options})
        self.assertIn("comment", {option["style"] for option in options})
        for option in options:
            self.assertLessEqual(len(option["title"]), 70)
            self.assertLessEqual(len(option["overlay_text"]), 24)
            self.assertTrue(option["id"].startswith("opt_"))


if __name__ == "__main__":
    unittest.main()

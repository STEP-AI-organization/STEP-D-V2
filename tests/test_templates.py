import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.templates import ALLOWED_OVERLAY_POSITIONS, get_render_template, list_render_templates  # noqa: E402


class RenderTemplateTest(unittest.TestCase):
    def test_expected_template_ids_are_available(self):
        ids = {template["id"] for template in list_render_templates()}

        self.assertEqual(
            {"clean", "youtube_shorts_badge", "meta_reels_badge", "soop_badge", "minimal_corner", "top_banner"},
            ids,
        )

    def test_unknown_template_falls_back_to_clean(self):
        template = get_render_template("missing")

        self.assertEqual("clean", template["id"])

    def test_template_positions_are_supported(self):
        for template in list_render_templates():
            self.assertIn(template["position"], ALLOWED_OVERLAY_POSITIONS)


if __name__ == "__main__":
    unittest.main()

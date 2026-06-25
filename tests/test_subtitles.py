import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.services.subtitles import build_ass_subtitles, normalize_style_preset, normalize_subtitle_mode  # noqa: E402


def _settings(**overrides):
    values = {
        "shorts_subtitles_enabled": True,
        "shorts_style_preset_default": "korean_pop",
        "shorts_width": 1080,
        "shorts_height": 1920,
        "shorts_subtitle_font_name": "G마켓 산스 TTF Bold",
        "shorts_subtitle_fonts_dir": "",
        "shorts_subtitle_font_size": 70,
        "shorts_subtitle_margin_v": 220,
        "shorts_subtitle_max_chars_per_line": 12,
        "shorts_subtitle_max_lines": 2,
        "shorts_subtitle_primary_color": "&H00FFFFFF",
        "shorts_subtitle_highlight_enabled": True,
        "shorts_subtitle_highlight_color": "&H0000E6FF",
        "shorts_subtitle_outline": 5,
        "shorts_subtitle_shadow": 2,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class SubtitleRenderTest(unittest.TestCase):
    def test_build_ass_subtitles_uses_clip_relative_times_and_wraps_text(self):
        transcript = {
            "segments": [
                {"start": 4.0, "end": 5.0, "text": "before"},
                {"start": 5.5, "end": 7.25, "text": "one two three four five six"},
                {"start": 20.0, "end": 21.0, "text": "after"},
            ]
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.ass"
            result = build_ass_subtitles(transcript, 5.0, 10.0, _settings(), output)

            self.assertEqual(result, output)
            content = output.read_text(encoding="utf-8")

        self.assertIn("[Events]", content)
        self.assertIn("0:00:00.50", content)
        self.assertIn("0:00:02.25", content)
        self.assertIn("\\N", content)
        self.assertIn("G마켓 산스 TTF Bold", content)

        self.assertIn(",1,5,2,2,80,80,220,1", content)

    def test_build_ass_subtitles_highlights_hook_terms(self):
        transcript = {"segments": [{"start": 0.0, "end": 2.0, "text": "this is jackpot moment"}]}
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.ass"
            result = build_ass_subtitles(transcript, 0.0, 3.0, _settings(), output, hook_terms=["jackpot"])

            self.assertEqual(result, output)
            content = output.read_text(encoding="utf-8")

        self.assertIn("{\\c&H00E6FF&}jackpot{\\c&HFFFFFF&}", content)

    def test_build_ass_subtitles_applies_clean_style_preset(self):
        transcript = {"segments": [{"start": 0.0, "end": 2.0, "text": "this is jackpot moment"}]}
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.ass"
            result = build_ass_subtitles(
                transcript,
                0.0,
                3.0,
                _settings(),
                output,
                hook_terms=["jackpot"],
                style_preset="clean",
            )

            self.assertEqual(result, output)
            content = output.read_text(encoding="utf-8")

        self.assertIn(",64,", content)
        self.assertIn(",1,4,1,2,80,80,190,1", content)
        self.assertNotIn("{\\c&H00E6FF&}jackpot", content)

    def test_build_ass_subtitles_uses_highlight_color_override(self):
        # The editor's emphasis-color picker (#FF4A1C) should drive the baked
        # highlight so it matches the preview captions: #RRGGBB -> &H00BBGGRR.
        transcript = {"segments": [{"start": 0.0, "end": 2.0, "text": "this is jackpot moment"}]}
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.ass"
            build_ass_subtitles(
                transcript,
                0.0,
                3.0,
                _settings(),
                output,
                hook_terms=["jackpot"],
                highlight_color_override="#FF4A1C",
            )
            content = output.read_text(encoding="utf-8")

        self.assertIn("{\\c&H1C4AFF&}jackpot{\\c&HFFFFFF&}", content)

    def test_build_ass_subtitles_returns_none_when_disabled(self):
        transcript = {"segments": [{"start": 0.0, "end": 1.0, "text": "hello"}]}
        with tempfile.TemporaryDirectory() as temp_dir:
            result = build_ass_subtitles(transcript, 0.0, 2.0, _settings(shorts_subtitles_enabled=False), Path(temp_dir) / "clip.ass")

        self.assertIsNone(result)

    def test_normalize_subtitle_mode(self):
        self.assertEqual(normalize_subtitle_mode("on"), "on")
        self.assertEqual(normalize_subtitle_mode("OFF"), "off")
        self.assertEqual(normalize_subtitle_mode("bad-value"), "auto")
        self.assertEqual(normalize_subtitle_mode("", "off"), "off")

    def test_normalize_style_preset(self):
        self.assertEqual(normalize_style_preset("k-shorts"), "korean_pop")
        self.assertEqual(normalize_style_preset("NEWS"), "news")
        self.assertEqual(normalize_style_preset("custom"), "custom")
        self.assertEqual(normalize_style_preset("bad-value", "clean"), "clean")


if __name__ == "__main__":
    unittest.main()

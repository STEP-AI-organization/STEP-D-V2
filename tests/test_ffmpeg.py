import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

try:
    from app.services import ffmpeg  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name in {"pydantic", "pydantic_settings"}:
        ffmpeg = None
    else:
        raise


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        ffmpeg_binary="ffmpeg",
        ffprobe_binary="ffprobe",
        render_vertical_shorts=False,
        shorts_reframe_mode="fit",
        shorts_width=1080,
        shorts_height=1920,
        shorts_background_color="black",
        shorts_blur_background_strength=24,
        shorts_title_overlay=False,
        shorts_title_font_file="",
        shorts_title_font_size=58,
        shorts_title_y_ratio=0.095,
        shorts_title_line_spacing=12,
        shorts_title_box_border=24,
        shorts_title_max_chars_per_line=18,
        shorts_title_max_lines=2,
        shorts_video_fade_seconds=0.15,
        shorts_audio_fade_seconds=0.12,
        shorts_subtitles_enabled=True,
        shorts_subtitle_mode_default="auto",
        shorts_subtitle_font_name="G마켓 산스 TTF Bold",
        shorts_subtitle_fonts_dir="",
        shorts_subtitle_font_size=70,
        shorts_subtitle_margin_v=220,
        shorts_subtitle_max_chars_per_line=16,
        shorts_subtitle_max_lines=2,
    )


@unittest.skipIf(ffmpeg is None, "API dependencies are not installed in this Python environment")
class FFmpegFadeCommandTest(unittest.TestCase):
    def test_cut_clip_adds_video_and_audio_fade_filters_when_audio_exists(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=True),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, _settings())

        self.assertIn("-vf", captured)
        self.assertIn("fade=t=in:st=0:d=0.150", captured[captured.index("-vf") + 1])
        self.assertIn("-af", captured)
        self.assertIn("afade=t=in:st=0:d=0.120", captured[captured.index("-af") + 1])

    def test_cut_clip_omits_audio_fade_when_audio_stream_is_missing(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, _settings())

        self.assertIn("-vf", captured)
        self.assertNotIn("-af", captured)

    def test_text_badge_template_adds_drawtext_filter(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            creative = {"badge_text": "SHORTS", "overlay_position": "top_right", "overlay_scale": 0.12}
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, _settings(), creative_settings=creative)

        self.assertIn("-vf", captured)
        self.assertIn("drawtext=", captured[captured.index("-vf") + 1])
        self.assertIn("badge.txt", captured[captured.index("-vf") + 1])

    def test_image_overlay_uses_second_input_and_filter_complex(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            creative = {"overlay_position": "top_right", "overlay_scale": 0.12}
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(
                    Path("input.mp4"),
                    output,
                    5.0,
                    15.0,
                    _settings(),
                    creative_settings=creative,
                    overlay_asset_path=Path("logo.png"),
                )

        self.assertIn("-i", captured)
        self.assertIn("logo.png", captured)
        self.assertIn("-filter_complex", captured)
        self.assertIn("overlay=", captured[captured.index("-filter_complex") + 1])
        self.assertIn("[v]", captured)

    def test_cut_clip_adds_ass_subtitle_filter(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            subtitle_path = Path(temp_dir) / "clip.ass"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(
                    Path("input.mp4"),
                    output,
                    5.0,
                    15.0,
                    _settings(),
                    subtitle_path=subtitle_path,
                )

        self.assertIn("-vf", captured)
        self.assertIn("ass=", captured[captured.index("-vf") + 1])
        self.assertIn("clip.ass", captured[captured.index("-vf") + 1])
        self.assertIn("fontsdir=", captured[captured.index("-vf") + 1])

    def test_image_overlay_can_include_ass_subtitle_filter(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            subtitle_path = Path(temp_dir) / "clip.ass"
            creative = {"overlay_position": "top_right", "overlay_scale": 0.12}
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(
                    Path("input.mp4"),
                    output,
                    5.0,
                    15.0,
                    _settings(),
                    creative_settings=creative,
                    overlay_asset_path=Path("logo.png"),
                    subtitle_path=subtitle_path,
                )

        self.assertIn("-filter_complex", captured)
        self.assertIn("ass=", captured[captured.index("-filter_complex") + 1])
        self.assertIn("fontsdir=", captured[captured.index("-filter_complex") + 1])
        self.assertIn("overlay=", captured[captured.index("-filter_complex") + 1])

    def test_probe_has_subtitle_stream_reads_ffprobe_streams(self):
        proc = SimpleNamespace(stdout='{"streams":[{"index":0}]}')
        with patch.object(ffmpeg, "_run", return_value=proc):
            self.assertTrue(ffmpeg.probe_has_subtitle_stream(Path("input.mp4"), _settings()))

        proc = SimpleNamespace(stdout='{"streams":[]}')
        with patch.object(ffmpeg, "_run", return_value=proc):
            self.assertFalse(ffmpeg.probe_has_subtitle_stream(Path("input.mp4"), _settings()))

    def test_blur_reframe_uses_filter_complex_background(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        settings = _settings()
        settings.render_vertical_shorts = True
        settings.shorts_reframe_mode = "blur"

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, settings)

        self.assertIn("-filter_complex", captured)
        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("split=2", filter_complex)
        self.assertIn("boxblur=24:2", filter_complex)
        self.assertIn("overlay=(W-w)/2:(H-h)/2", filter_complex)
        self.assertIn("[v]", captured)

    def test_blur_reframe_with_overlay_keeps_asset_overlay(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        settings = _settings()
        settings.render_vertical_shorts = True
        settings.shorts_reframe_mode = "blur"

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(
                    Path("input.mp4"),
                    output,
                    5.0,
                    15.0,
                    settings,
                    creative_settings={"overlay_position": "top_right", "overlay_scale": 0.12},
                    overlay_asset_path=Path("logo.png"),
                )

        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("boxblur=24:2", filter_complex)
        self.assertIn("[overlay_asset]", filter_complex)
        self.assertIn("overlay=x=", filter_complex)


if __name__ == "__main__":
    unittest.main()

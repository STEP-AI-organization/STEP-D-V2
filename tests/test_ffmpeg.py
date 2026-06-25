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

    def test_editor_text_overlay_uses_filter_complex_drawtext(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            creative = {
                "burn_overlays": [
                    {
                        "kind": "text",
                        "text": "지금 확인",
                        "x": 34,
                        "y": 44,
                        "fontSize": 14,
                        "color": "#FFFFFF",
                        "boxColor": "#FF4A1C",
                        "boxAlpha": 1,
                    }
                ]
            }
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, _settings(), creative_settings=creative)

        self.assertIn("-filter_complex", captured)
        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("drawtext=", filter_complex)
        self.assertIn("overlay_00.txt", filter_complex)
        self.assertIn("boxcolor=0xFF4A1C@1.000", filter_complex)
        self.assertIn("[v]", captured)

    def test_editor_image_overlay_adds_image_input(self):
        captured: list[str] = []

        def fake_run(args, settings, title_file, subtitle_path, duration):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            image = Path(temp_dir) / "overlay.png"
            image.write_bytes(b"fake image bytes")
            creative = {
                "burn_overlays": [
                    {"kind": "image", "path": str(image), "x": 30, "y": 40, "width": 120}
                ]
            }
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run_with_fallbacks", side_effect=fake_run),
            ):
                ffmpeg.cut_clip(Path("input.mp4"), output, 5.0, 15.0, _settings(), creative_settings=creative)

        self.assertIn("-i", captured)
        self.assertIn(str(image), captured)
        self.assertIn("-filter_complex", captured)
        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("format=rgba", filter_complex)
        self.assertIn("overlay=x=main_w*0.300000", filter_complex)
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

    def test_render_highlight_segments_concats_selected_ranges(self):
        captured: list[str] = []

        def fake_run(args, timeout=None):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "highlight.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=True),
                patch.object(ffmpeg, "_run", side_effect=fake_run),
            ):
                ffmpeg.render_highlight_segments(
                    Path("input.mp4"),
                    output,
                    [{"start": 10.0, "end": 20.0}, {"start": 35.0, "end": 48.0}],
                    _settings(),
                    title_text="방송 하이라이트",
                )

        self.assertEqual(captured.count("-i"), 2)
        self.assertIn("-filter_complex", captured)
        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=1:a=1", filter_complex)
        self.assertIn("highlight_title.txt", filter_complex)
        self.assertIn("-map", captured)
        self.assertIn("[v]", captured)
        self.assertIn("[a]", captured)
        self.assertEqual(captured[-1], str(output))

    def test_render_highlight_segments_handles_source_without_audio(self):
        captured: list[str] = []

        def fake_run(args, timeout=None):
            captured.extend(args)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "highlight.mp4"
            with (
                patch.object(ffmpeg, "probe_has_audio", return_value=False),
                patch.object(ffmpeg, "_run", side_effect=fake_run),
            ):
                ffmpeg.render_highlight_segments(
                    Path("input.mp4"),
                    output,
                    [{"start": 10.0, "end": 20.0}, {"start": 35.0, "end": 48.0}],
                    _settings(),
                )

        filter_complex = captured[captured.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=1:a=0", filter_complex)
        self.assertIn("[v]", captured)
        self.assertNotIn("[a]", captured)

    def test_editor_reframe_default_is_cover_fill(self):
        chain = ffmpeg._editor_reframe_filter(_settings(), {"aspect": "9:16", "videoY": 0, "zoom": 100, "bg": "#ffffff"})
        self.assertIn("force_original_aspect_ratio=increase", chain)
        self.assertIn("crop=1080:1920", chain)
        self.assertNotIn("pad=", chain)  # a 9:16 band fills the frame, no background bars

    def test_editor_reframe_band_offset_and_zoom(self):
        chain = ffmpeg._editor_reframe_filter(_settings(), {"aspect": "16:9", "videoY": 40, "zoom": 130, "bg": "#10162B"})
        self.assertIn("crop=1080:608", chain)  # 16:9 band height for a 1080-wide frame
        self.assertIn("scale=iw*1.3000", chain)  # zoom in
        self.assertIn("pad=1080:1920:0:768:0x10162B", chain)  # placed 40% down on the bg color

    def test_editor_reframe_absent_without_state(self):
        self.assertIsNone(ffmpeg._editor_reframe_filter(_settings(), None))

    def test_editor_text_overlay_preserves_line_breaks_and_alignment(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            overlays = ffmpeg._editor_overlays(
                {"burn_overlays": [{"kind": "text", "text": "첫째 줄\n둘째 줄", "x": 6, "y": 7, "align": "center", "fontSize": 28}]}
            )
            self.assertEqual(overlays[0]["text"], "첫째 줄\n둘째 줄")
            prepared = ffmpeg._write_editor_overlay_texts(output, overlays)
            raw = prepared[0]["_text_file"].read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertEqual(raw, "첫째 줄\n둘째 줄".encode("utf-8"))
            drawtext = ffmpeg._editor_drawtext_filter(prepared[0], _settings())
            self.assertIn("text_align=T+C", drawtext)
            self.assertIn("line_spacing=", drawtext)

    def test_title_file_has_no_carriage_returns(self):
        # Regression: on Windows, write_text translates "\n" to "\r\n" and ffmpeg
        # drawtext renders the stray "\r" as a tofu box (□) at each line break.
        settings = _settings()
        settings.shorts_title_overlay = True
        settings.shorts_title_max_chars_per_line = 8
        settings.shorts_title_max_lines = 3
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.mp4"
            title_path = ffmpeg._write_title_file(output, "도레미월드에 갑자기 찾아온 소음의 정체", settings)
            self.assertIsNotNone(title_path)
            raw = title_path.read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertIn(b"\n", raw)


if __name__ == "__main__":
    unittest.main()

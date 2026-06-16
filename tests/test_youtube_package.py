import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

try:
    from app.services.youtube_package import build_youtube_package  # noqa: E402
except ModuleNotFoundError as exc:
    if exc.name in {"sqlalchemy", "pydantic", "pydantic_settings"}:
        build_youtube_package = None
    else:
        raise


@unittest.skipIf(build_youtube_package is None, "API dependencies are not installed in this Python environment")
class YouTubePackageTest(unittest.TestCase):
    def test_package_contains_upload_ready_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            storage_dir = Path(temp_dir)
            job_dir = storage_dir / "jobs" / "job-1"
            clips_dir = job_dir / "clips"
            thumbs_dir = job_dir / "thumbnails"
            clips_dir.mkdir(parents=True)
            thumbs_dir.mkdir(parents=True)
            (clips_dir / "short_001.mp4").write_bytes(b"mp4")
            (thumbs_dir / "short_001.jpg").write_bytes(b"jpg")

            settings = SimpleNamespace(storage_dir=storage_dir)
            clip = SimpleNamespace(
                job_id="job-1",
                rank=1,
                title="업로드 패키지 테스트",
                reason="패키지 구성을 검증합니다.",
                transcript="지금 이 클립 설명입니다.",
                thumbnail_text="핵심 문구",
                thumbnail_description="썸네일 설명",
                score=91,
                start_time=3.0,
                end_time=43.0,
                evaluation_json={},
            )

            zip_path = build_youtube_package(settings, clip)

            with zipfile.ZipFile(zip_path) as archive:
                names = set(archive.namelist())

        self.assertEqual(
            {
                "short.mp4",
                "thumbnail.jpg",
                "metadata.json",
                "clip-briefing.json",
                "clip-briefing.txt",
                "description.txt",
                "tags.csv",
                "upload-checklist.txt",
            },
            names,
        )


if __name__ == "__main__":
    unittest.main()

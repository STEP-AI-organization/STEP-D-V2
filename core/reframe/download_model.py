"""Download the pinned official BlazeFace full-range model with SHA-256 verification."""
from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path

from core.reframe.video import DEFAULT_MODEL_PATH

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_full_range/float16/1/blaze_face_full_range.tflite"
)
MODEL_SHA256 = "3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(destination: Path, url: str = MODEL_URL, expected: str = MODEL_SHA256) -> Path:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256(destination) == expected:
        return destination
    fd, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".download", dir=destination.parent
    )
    os.close(fd)
    temporary_path = Path(temporary)
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary_path.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        actual = sha256(temporary_path)
        if actual != expected:
            raise RuntimeError(f"model checksum mismatch: expected {expected}, got {actual}")
        os.replace(temporary_path, destination)
        return destination
    finally:
        try:
            temporary_path.unlink()
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="core.reframe.download_model")
    parser.add_argument("--output", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument("--url", default=MODEL_URL)
    parser.add_argument("--sha256", default=MODEL_SHA256)
    args = parser.parse_args(argv)
    print(download(Path(args.output), args.url, args.sha256))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

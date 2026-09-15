"""PP-OCRv4 det ONNX(원본 자막 블러 검출)를 핀 고정 SHA-256 검증과 함께 내려받는다.

이 모델의 단독 정본 배포처가 없다 — PaddleOCR 공식 릴리스는 paddle inference 포맷이고,
ONNX 변환본은 rapidocr-onnxruntime **휠 안에** 들어 있다. 그래서 PyPI 의 그 휠(불변 URL)을
받아 모델 파일 하나만 꺼낸다. rapidocr 를 pip 로 **설치하지 않는** 이유: opencv-python 을
끌고 와 이 리포의 opencv-contrib 를 덮는다(core/requirements.txt 선택 ⑤ 주석). 휠은 zip 이라
설치 없이 꺼내진다.

이중 검증(휠 + 모델 각각 SHA-256) · 실패 방향은 reframe download_model 과 같다 —
빠졌거나 깨졌으면 잡마다 죽는 게 아니라 **이미지 빌드가 죽는다**(Dockerfile.worker 스모크).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import urllib.request
import zipfile
from pathlib import Path

WHEEL_URL = (
    "https://files.pythonhosted.org/packages/ba/12/"
    "1e5497183bdbe782dbb91bad1d0d2297dba4d2831b2652657f7517bfc6df/"
    "rapidocr_onnxruntime-1.4.4-py3-none-any.whl"
)
WHEEL_SHA256 = "971d7d5f223a7a808662229df1ef69893809d8457d834e6373d3854bc1782cbf"
MEMBER = "rapidocr_onnxruntime/models/ch_PP-OCRv4_det_infer.onnx"
MODEL_SHA256 = "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(destination: Path) -> Path:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == MODEL_SHA256:
        return destination

    fd, temporary = tempfile.mkstemp(prefix=".subblur-wheel.", suffix=".whl", dir=destination.parent)
    os.close(fd)
    wheel_path = Path(temporary)
    try:
        with urllib.request.urlopen(WHEEL_URL, timeout=120) as response, wheel_path.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        actual = sha256_file(wheel_path)
        if actual != WHEEL_SHA256:
            raise RuntimeError(f"wheel checksum mismatch: expected {WHEEL_SHA256}, got {actual}")
        with zipfile.ZipFile(wheel_path) as wheel:
            data = wheel.read(MEMBER)
        model_actual = hashlib.sha256(data).hexdigest()
        if model_actual != MODEL_SHA256:
            raise RuntimeError(f"model checksum mismatch: expected {MODEL_SHA256}, got {model_actual}")
        fd, tmp_model = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".download", dir=destination.parent)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.replace(tmp_model, destination)
        return destination
    finally:
        try:
            wheel_path.unlink()
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="core.vision.download_subblur_model")
    parser.add_argument("--output", default="core/.models/ch_PP-OCRv4_det_infer.onnx")
    args = parser.parse_args(argv)
    print(download(Path(args.output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

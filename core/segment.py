"""매칭된 롱폼 구간 하나를 LEARN 입력으로 만든다 (자막 + 장면·감정 요약).

왜 이 모듈이 따로 있나: LEARN 프롬프트는 구간별 `transcript_slice`와 `scene_summary`를
요구하는데, 그걸 얻자고 롱폼 전체(20~60분)를 파이프라인에 태우는 건 낭비다. 필요한 건
매칭된 40~60초뿐이라, **그 구간만** 받아서 처리한다. 회차 전체 분석 대비 1/20 수준.

비용 설계: 오디오와 대표 프레임을 **한 번의 Gemini 호출**에 함께 넣는다. STT 한 번 +
비전 한 번으로 나누면 호출이 2배가 되는데, 어차피 같은 구간을 보는 것이라 나눌 이유가 없다.

출력: {"transcript": str, "scene_summary": str, "emotion": str, "hook": str}
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
# 프레임·음성은 개인정보(생체 포함)라 서울 리전 고정 — vision.py와 같은 이유.
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("SEGMENT_MODEL") or "gemini-2.5-flash"
N_FRAMES = 3

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "transcript": {"type": "STRING", "description": "구간에서 들리는 대사를 순서대로. 없으면 빈 문자열."},
        "scene_summary": {"type": "STRING", "description": "무슨 상황인지 2~3문장. 인물의 행동·표정·화면 텍스트 포함."},
        "emotion": {"type": "STRING", "description": "구간을 지배하는 감정/분위기 한 단어 (예: 폭소, 긴장, 감동, 당황, 사이다)."},
        "hook": {"type": "STRING", "description": "이 구간이 시선을 잡는 장치 하나 (예: 반전, 돌직구, 갈등고조, 질문, 정보, 웃음, 공감)."},
    },
    "required": ["transcript", "scene_summary", "emotion", "hook"],
}

_PROMPT = """이 영상 구간은 롱폼에서 잘려 숏폼으로 발행된 부분이다.
왜 이 순간이 숏폼 소재로 뽑혔는지 판단할 수 있도록 정리하라.

- transcript: 들리는 대사를 순서대로. 화자 구분이 명확하면 "이름: 대사" 형식.
- scene_summary: 무슨 상황인지 2~3문장. 인물의 행동·표정 변화와 화면에 박힌 자막을 포함하라.
- emotion: 이 구간을 지배하는 감정/분위기 한 단어.
- hook: 시선을 잡는 장치 하나.

없는 것을 지어내지 마라. 대사가 없으면 transcript는 빈 문자열로 두고 화면만으로 설명하라."""


def _run(cmd: list[str]) -> None:
    """실패 시 stderr를 예외 메시지에 담는다 — 안 그러면 원인이 통째로 사라진다.

    yt-dlp 호출이면 YTDLP_COOKIES(파일 존재 시)를 --cookies로 붙인다 — 지역제한·봇차단·
    레이트리밋을 계정 인증으로 우회한다. worker.ts와 같은 규약.
    """
    cookies = os.environ.get("YTDLP_COOKIES") or ""
    if cmd and cmd[0] == "yt-dlp" and cookies and os.path.exists(cookies):
        cmd = [cmd[0], "--cookies", cookies, *cmd[1:]]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} exited {p.returncode}: {(p.stderr or '')[-400:]}")


def fetch_longform(url: str, out_path: str, max_height: int = 360) -> str:
    """롱폼 1편을 저해상도로 받고, 실제로 저장된 경로를 돌려준다.

    ⚠️ yt-dlp는 `-o long.mp4`를 줘도 원본 컨테이너를 붙여 `long.mp4.webm`으로 저장한다
    (실제로 여기서 ffmpeg가 "No such file"로 죽었다). `--merge-output-format mp4`로
    컨테이너를 고정하되, 그래도 다른 확장자가 나오면 glob으로 찾아 반환한다.
    """
    _run([
        "yt-dlp", "-q", "--no-playlist",
        "-f", f"bv*[height<={max_height}]+ba/b[height<={max_height}]/b",
        "--merge-output-format", "mp4",
        "-o", out_path, url,
    ])
    if os.path.exists(out_path):
        return out_path
    base = Path(out_path)
    for cand in sorted(base.parent.glob(base.name + ".*")) + sorted(base.parent.glob(base.stem + ".*")):
        if cand.is_file() and cand.stat().st_size > 0:
            return str(cand)
    raise FileNotFoundError(f"다운로드 결과를 찾지 못했습니다: {out_path}")


def cut_segment(src_path: str, start: float, end: float, out_path: str) -> None:
    """받아둔 롱폼에서 구간을 잘라 낸다.

    ⚠️ yt-dlp `--download-sections`를 쓰지 않는 이유: 정확한 경계를 맞추려면
    `--force-keyframes-at-cuts`가 필요한데, 그러면 사실상 전체를 받아 재인코딩한다
    (61분 영상에서 10분 넘게 안 끝났다). 롱폼 한 편에 매칭 구간이 여러 개이므로
    **한 번 받아 여러 번 자르는** 편이 압도적으로 싸다 — match.align과 같은 구조다.
    """
    dur = max(0.5, end - start)
    # -ss를 -i 앞에 둬 빠르게 탐색하고, 경계 정확도를 위해 재인코딩한다(구간이 짧아 저렴).
    _run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(dur),
          "-i", src_path, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
          "-c:a", "aac", out_path])


def _frames(video: str, out_dir: Path, n: int = N_FRAMES) -> list[Path]:
    """구간 안에서 균등 간격 프레임 n장 (앞뒤 10%는 전환 프레임이라 피한다)."""
    out = []
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
        capture_output=True, text=True,
    )
    try:
        dur = float((probe.stdout or "0").strip())
    except ValueError:
        dur = 0.0
    if dur <= 0:
        return out
    for i in range(n):
        t = dur * (0.15 + 0.7 * (i / max(1, n - 1)))
        p = out_dir / f"f{i}.jpg"
        try:
            _run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", video,
                  "-frames:v", "1", "-vf", "scale=640:-2", str(p)])
            if p.exists():
                out.append(p)
        except subprocess.CalledProcessError:
            continue
    return out


def _audio(video: str, out_path: str) -> str | None:
    """16kHz 모노 WAV. 무음/오디오 없음이면 None."""
    try:
        _run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vn",
              "-ac", "1", "-ar", "16000", out_path])
        return out_path if os.path.getsize(out_path) > 1024 else None
    except (subprocess.CalledProcessError, OSError):
        return None


def describe(video_path: str) -> dict:
    """구간 영상 → {transcript, scene_summary, emotion, hook} (Gemini 1회)."""
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        parts: list[types.Part] = []
        wav = _audio(video_path, str(tdp / "a.wav"))
        if wav:
            parts.append(types.Part.from_bytes(data=Path(wav).read_bytes(), mime_type="audio/wav"))
        for f in _frames(video_path, tdp):
            parts.append(types.Part.from_bytes(data=f.read_bytes(), mime_type="image/jpeg"))
        if not parts:
            return {"transcript": "", "scene_summary": "", "emotion": "", "hook": "",
                    "error": "오디오·프레임을 추출하지 못했습니다"}
        parts.append(types.Part.from_text(text=_PROMPT))

        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=_SCHEMA,
            ),
        ))
    return json.loads(resp.text or "{}")


def describe_many(url: str, spans: list[dict]) -> list[dict]:
    """롱폼 URL 1편 + 구간 여러 개 → 구간별 설명. 다운로드는 단 한 번.

    spans: [{"id": str, "start": float, "end": float}, ...]
    반환은 입력 순서와 1:1. 한 구간이 실패해도 나머지는 계속한다(부분 성공 허용).
    """
    out: list[dict] = []
    with tempfile.TemporaryDirectory() as td:
        long_path = fetch_longform(url, str(Path(td) / "long.mp4"))
        for sp in spans:
            seg = str(Path(td) / f"seg_{len(out)}.mp4")
            try:
                cut_segment(long_path, float(sp["start"]), float(sp["end"]), seg)
                r = describe(seg)
            except Exception as e:  # noqa: BLE001 — 구간 하나의 실패가 배치를 죽이면 안 된다
                r = {"transcript": "", "scene_summary": "", "emotion": "", "hook": "",
                     "error": str(e)[:200]}
            r["id"] = sp.get("id")
            out.append(r)
            try:
                os.remove(seg)
            except OSError:
                pass
    return out


if __name__ == "__main__":
    if len(sys.argv) == 2:
        # 로컬 영상 파일 하나
        print(json.dumps(describe(sys.argv[1]), ensure_ascii=False))
    elif len(sys.argv) == 4:
        # URL + 구간 하나 (수동 확인용)
        print(json.dumps(describe_many(sys.argv[1], [{"id": "one", "start": float(sys.argv[2]),
                                                      "end": float(sys.argv[3])}])[0], ensure_ascii=False))
    elif len(sys.argv) == 3 and sys.argv[2] == "-":
        # URL + stdin JSON spans (워커 경로) → 구간별 JSON 한 줄씩
        for r in describe_many(sys.argv[1], json.load(sys.stdin)):
            print(json.dumps(r, ensure_ascii=False), flush=True)
    else:
        print("usage: python -m core.segment <video> | <url> <start> <end> | <url> - < spans.json",
              file=sys.stderr)
        raise SystemExit(2)

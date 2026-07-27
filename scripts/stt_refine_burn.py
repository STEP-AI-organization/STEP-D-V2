"""
stt.json → refine.py → refined.json → sync burn.
프로덕션 자막 품질(맞춤법·오인식 정정)을 실제 파이프라인 그대로 재현.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.refine import refine_segments  # noqa: E402


def main(stt_path: str, video: str, out_mp4: str) -> None:
    data = json.loads(Path(stt_path).read_text(encoding="utf-8"))
    segs = data["segments"]
    print(f"[refine] input segs={len(segs)}")

    # refine_segments는 각 seg의 text만 polish, timestamp·words는 그대로 보존
    refined = refine_segments(segs, cast_registry=None, program_context=None)

    # 결과 저장 (원본 fps 포함, sync_burn 재활용)
    refined_path = "C:/tmp/refined_result.json"
    Path(refined_path).write_text(
        json.dumps({"fps": data.get("fps", 30), "segments": refined}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[refine] saved → {refined_path}")

    # sync_burn 재실행 — refined seg text 사용, whisper words도 그대로 karaoke
    print(f"[refine] burning subs …")
    subprocess.run(
        ["node", "C:/Users/STEPAI05/STEPD-repo/scripts/stt_sync_burn.mjs",
         video, refined_path, out_mp4],
        check=True,
    )


if __name__ == "__main__":
    stt = sys.argv[1] if len(sys.argv) > 1 else "C:/tmp/stt_probe_result.json"
    video = sys.argv[2] if len(sys.argv) > 2 else "C:/Users/STEPAI05/STEPD-repo/core/TpQgkCs0TzE.mp4"
    out = sys.argv[3] if len(sys.argv) > 3 else "C:/tmp/stt_sync_refined.mp4"
    main(stt, video, out)

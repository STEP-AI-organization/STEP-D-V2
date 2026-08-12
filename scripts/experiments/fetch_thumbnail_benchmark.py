"""실 유튜브 채널 썸네일 벤치마크 수집 (§13.4 Phase A · docs/plans/thumbnail-engine-plan.md).

목적: 프로그램별 실 유튜브 톤 학습용 참고 이미지. Planner few-shot 첨부.

사용:
  python scripts/fetch_thumbnail_benchmark.py --channel-url <url> --out assets/thumbnail-benchmark/<name>/ --limit 20
  또는 alias로:
  python scripts/fetch_thumbnail_benchmark.py --preset variety-korean --limit 30

기본 프리셋 (수집 후 assets/thumbnail-benchmark/<preset>/에 저장):
  - envouno: 환승연애 공식 (티빙)
  - tvn_offical: tvN 예능
  - jtbc_ent: JTBC 예능
  - issue_reaction: 렉카/이슈 채널 (하나 선정)

의존성: yt-dlp (이미 설치됨). 이미지만 다운 · 영상 X.
"""
from __future__ import annotations
import argparse
import pathlib
import subprocess
import sys

CHANNEL_PRESETS: dict[str, str] = {
    # 실제 URL은 사용자가 결정 · 여기 defaults 는 후보 예시
    "envouno":         "https://www.youtube.com/@tvingsuper",       # 티빙 공식 (환승연애 등)
    "tvn_official":    "https://www.youtube.com/@tvNDenlightenment", # tvN 예능
    "jtbc_ent":        "https://www.youtube.com/@JTBCentertainment",
    "issue_reaction":  "https://www.youtube.com/@YCARDIO",           # 예시 · 실 채널로 교체
}

def fetch(channel_url: str, out_dir: pathlib.Path, limit: int) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "yt-dlp",
        "--playlist-items", f"1-{limit}",
        "--write-thumbnail",
        "--skip-download",
        "--no-download",
        "--convert-thumbnails", "jpg",
        "-o", str(out_dir / "%(playlist_index)03d_%(id)s.%(ext)s"),
        channel_url,
    ]
    print(f"[fetch] {channel_url} → {out_dir}")
    print(f"[cmd] {' '.join(cmd)}")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        print("[FAIL] yt-dlp not on PATH. pip install yt-dlp", file=sys.stderr)
        return 1
    if r.returncode != 0:
        print(f"[FAIL] yt-dlp exit {r.returncode}")
        print(r.stderr[-1500:])
        return 1
    count = len(list(out_dir.glob("*.jpg"))) + len(list(out_dir.glob("*.webp")))
    print(f"[ok] {count} thumbnails in {out_dir}")
    return 0

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel-url", help="유튜브 채널/재생목록 URL")
    ap.add_argument("--preset", choices=list(CHANNEL_PRESETS), help="사전 정의 채널 프리셋")
    ap.add_argument("--out", default="", help="출력 폴더 (기본: assets/thumbnail-benchmark/<preset|custom>/)")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--list-presets", action="store_true")
    args = ap.parse_args()

    if args.list_presets:
        for k, v in CHANNEL_PRESETS.items():
            print(f"  {k}: {v}")
        return 0

    if args.preset:
        url = CHANNEL_PRESETS[args.preset]
        default_out = pathlib.Path("assets/thumbnail-benchmark") / args.preset
    elif args.channel_url:
        url = args.channel_url
        default_out = pathlib.Path("assets/thumbnail-benchmark/custom")
    else:
        print("--preset 또는 --channel-url 필요. --list-presets 로 목록", file=sys.stderr)
        return 1

    out = pathlib.Path(args.out).resolve() if args.out else default_out.resolve()
    return fetch(url, out, args.limit)

if __name__ == "__main__":
    sys.exit(main())

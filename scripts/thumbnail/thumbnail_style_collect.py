"""채널 썸네일 수집 — 스타일 학습용 레퍼런스 확보.

사용자 지시 (2026-08-07): "@chonjang 에 있는 게 나는솔로 스타일이니까 이걸 학습."

가중치를 바꾸는 학습이 아니다 (gpt-image-2 는 파인튜닝이 없다). 채널의 실제
썸네일을 모아 → 규칙으로 압축하고 → 생성 프롬프트에 심는 것이 여기서의 '학습'이다.

수집은 yt-dlp 로 한다. YOUTUBE_API_KEY 가 없어도 공개 채널이면 되고,
쿼터도 안 쓴다. 이미지는 maxresdefault 우선 (썸네일 원본 해상도).

사용:
  python scripts/thumbnail_style_collect.py https://www.youtube.com/@chonjang/videos \\
      --program "나는솔로" --limit 50
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STYLE_ROOT = ROOT / "assets" / "thumbnail-style"


def list_videos(url: str, limit: int) -> list[dict]:
    """채널 → 영상 목록 (id·title·업로드일). 재생목록 메타만 읽어 빠르다."""
    r = subprocess.run(
        ["yt-dlp", "--flat-playlist", "--playlist-end", str(limit), "-J", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 실패: {r.stderr[-300:]}")
    data = json.loads(r.stdout)
    out = []
    for e in data.get("entries") or []:
        if not e.get("id"):
            continue
        out.append({
            "videoId": e["id"],
            "title": e.get("title") or "",
            "duration": e.get("duration"),
            "viewCount": e.get("view_count"),
        })
    return out[:limit]


def fetch_thumb(video_id: str, dest: pathlib.Path) -> bool:
    """maxres → hq 순으로 시도. maxres 가 없는 영상이 있다."""
    for name in ("maxresdefault", "hqdefault"):
        url = f"https://i.ytimg.com/vi/{video_id}/{name}.jpg"
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                if r.status != 200:
                    continue
                body = r.read()
            if len(body) < 5000:      # 회색 플레이스홀더
                continue
            dest.write_bytes(body)
            return True
        except Exception:
            continue
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("channel_url")
    ap.add_argument("--program", required=True, help="프로그램명 (프로파일 키)")
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()

    out_dir = STYLE_ROOT / args.program
    img_dir = out_dir / "thumbs"
    img_dir.mkdir(parents=True, exist_ok=True)

    print(f"채널 조회: {args.channel_url}")
    videos = list_videos(args.channel_url, args.limit)
    print(f"영상 {len(videos)}개")

    saved = []
    for i, v in enumerate(videos, 1):
        dest = img_dir / f"{v['videoId']}.jpg"
        if dest.exists() or fetch_thumb(v["videoId"], dest):
            saved.append({**v, "path": str(dest.relative_to(ROOT))})
        if i % 10 == 0:
            print(f"  {i}/{len(videos)} · 저장 {len(saved)}")

    (out_dir / "videos.json").write_text(
        json.dumps({"program": args.program, "channel": args.channel_url,
                    "videos": saved}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"썸네일 {len(saved)}장 → {img_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""썸네일 엔진 워커 진입점.

사용자 지시 (2026-08-07): "실서비스에 배선."

worker.ts 가 `python -m core.thumbnail.cli ...` 로 스폰한다. content.analyze 와
같은 방식 — 서버는 잡을 큐잉만 하고, 무거운 일(수집·Vision·이미지 생성)은 워커에서 돈다.

  playlists 채널의 재생목록 목록 (프로그램별로 어느 재생목록인지 고르기 위함)
  style     재생목록/채널 썸네일 수집 → 스타일 프로파일 (프로그램 1회성)
  generate  회차 1건 → 썸네일 후보 N장

결과는 stdout 마지막 줄에 `@@RESULT {json}` 으로 낸다. 워커가 그 줄만 파싱한다.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys


def _emit(payload: dict) -> None:
    print("@@RESULT " + json.dumps(payload, ensure_ascii=False))


def cmd_playlists(args) -> int:
    """채널 → 재생목록 목록. 큰 채널은 프로그램·기수를 재생목록으로 나눠 담는다."""
    from core.thumbnail.style import list_playlists

    items = list_playlists(args.channel_url, limit=args.limit)
    _emit({"ok": True, "playlists": items})
    return 0


def cmd_style(args) -> int:
    """재생목록(권장)/채널 URL → 썸네일 수집 → 프로파일. 프로그램마다 1회."""
    from core.thumbnail.paths import style_dir, write_program_meta
    from core.thumbnail.style import build_profile, collect_thumbnails

    write_program_meta(args.program_id, args.title or "", args.source_url)
    d = style_dir(args.program_id)

    n_saved = collect_thumbnails(args.source_url, d, limit=args.limit)
    if not n_saved:
        _emit({"ok": False, "error": "썸네일을 한 장도 못 받았다 (채널 URL 확인)"})
        return 1

    profile = build_profile(d, title=args.title or args.program_id, sample=args.sample)
    _emit({
        "ok": True, "programId": args.program_id,
        "collected": n_saved, "analyzed": profile.get("sampleSize"),
        "prompt": profile.get("prompt", ""),
    })
    return 0


def cmd_generate(args) -> int:
    """회차 1건 → 썸네일 후보. 인물은 등록부에서, 배경은 검색 구간에서."""
    from core.thumbnail.generate import run

    result = run(
        media_id=args.media_id,
        program_id=args.program_id,
        program_title=args.title or "",
        analysis_dir=pathlib.Path(args.analysis_dir),
        video_path=pathlib.Path(args.video) if args.video else None,
        out_dir=pathlib.Path(args.out),
        candidates=args.candidates,
        api_base=args.api_base or None,
    )
    _emit(result)
    return 0 if result.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="core.thumbnail.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("playlists", help="채널의 재생목록 목록")
    pl.add_argument("--channel-url", required=True)
    pl.add_argument("--limit", type=int, default=50)
    pl.set_defaults(func=cmd_playlists)

    s = sub.add_parser("style", help="재생목록/채널 썸네일 수집 + 스타일 프로파일")
    s.add_argument("--program-id", required=True)
    s.add_argument("--source-url", required=True, help="재생목록 URL 권장 (채널도 가능)")
    s.add_argument("--title", default="")
    s.add_argument("--limit", type=int, default=50, help="수집 장수")
    s.add_argument("--sample", type=int, default=20, help="Vision 분석 장수")
    s.set_defaults(func=cmd_style)

    g = sub.add_parser("generate", help="회차 → 썸네일 후보")
    g.add_argument("--media-id", required=True)
    g.add_argument("--program-id", required=True)
    g.add_argument("--title", default="")
    g.add_argument("--analysis-dir", required=True, help="analysis.json·narrative.json 위치")
    g.add_argument("--video", default="", help="배경 프레임 추출용 원본. 없으면 배경 없이 생성")
    g.add_argument("--out", required=True)
    g.add_argument("--candidates", type=int, default=3)
    g.add_argument("--api-base", default="", help="구간 검색 API (기본 STEPD_API_BASE)")
    g.set_defaults(func=cmd_generate)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except Exception as e:
        import traceback
        traceback.print_exc()
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

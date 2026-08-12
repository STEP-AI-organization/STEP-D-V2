"""CLI 인자 파싱 · `python -m core.analyze <video> ...` 진입 로직.

analyze.py 의 main() 을 뽑아냄 (2026-08-06). 파일 자체는 __main__ 이 아니므로 실행되지 않음 —
core/analyze.py 의 `if __name__ == "__main__":` 가 여기 `main` 을 호출한다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    from core.analyze import analyze  # 지연 import 로 순환 방지

    if len(sys.argv) < 2:
        print("Usage: python -m core.analyze <video> [--out <dir>] [--shorts N] "
              "[--genre auto|variety|talk|drama|sports|news|music|documentary] "
              "[--profile <profile.json>] [--cast <registry.json>] "
              "[--channels youtube_shorts,instagram_reels,smr] [--no-resume] [--fast]")
        sys.exit(1)

    video = sys.argv[1]
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(video).parent
    n = int(sys.argv[sys.argv.index("--shorts") + 1]) if "--shorts" in sys.argv else 5
    genre = sys.argv[sys.argv.index("--genre") + 1] if "--genre" in sys.argv else "auto"
    resume = "--no-resume" not in sys.argv
    fast = "--fast" in sys.argv  # 자막만으로 빠른 추천 (시각 분석 스킵, ~10배 빠름)
    media_id = sys.argv[sys.argv.index("--media") + 1] if "--media" in sys.argv else out_dir.name

    # Optional program understanding profile (--profile <path.json>) → program-fit prior.
    profile = None
    if "--profile" in sys.argv:
        try:
            profile = json.loads(Path(sys.argv[sys.argv.index("--profile") + 1]).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"   (프로파일 로드 실패, 무시: {str(e)[:80]})")

    # Optional cast registry (--cast <registry.json>) → on-screen name captions get
    # normalized onto registered people; without it every name stays a candidate.
    # 2026-07-31: --cast 명시 없어도 workdir/cast_registry.json 자동 로드 (speaker_rename 이 필요).
    cast_registry = None
    if "--cast" in sys.argv:
        from core.vision.cast import load_registry
        cast_registry = load_registry(sys.argv[sys.argv.index("--cast") + 1])
    else:
        _auto_cast = out_dir / "cast_registry.json"
        if _auto_cast.exists():
            try:
                from core.vision.cast import load_registry
                cast_registry = load_registry(str(_auto_cast))
                print(f"[cast] workdir cast_registry.json 자동 로드 · {len(cast_registry or [])}명")
            except Exception as e:
                print(f"[cast] 자동 로드 실패, 무시: {str(e)[:80]}")

    # Optional destination filter (--channels a,b) → per-channel fit matrix. Default: all.
    channels = None
    if "--channels" in sys.argv:
        channels = [c.strip() for c in sys.argv[sys.argv.index("--channels") + 1].split(",") if c.strip()]

    # Optional program context (--program-context <path.json>) — 사용자가 프로그램 상세 페이지
    # 에서 입력한 시놉시스·태그·크레딧·방영정보 등. recommend/retitle 프롬프트에 배경으로 주입.
    program_context = None
    if "--program-context" in sys.argv:
        try:
            program_context = json.loads(
                Path(sys.argv[sys.argv.index("--program-context") + 1]).read_text(encoding="utf-8")
            )
        except Exception as e:
            print(f"   (프로그램 컨텍스트 로드 실패, 무시: {str(e)[:80]})")

    result = analyze(video, out_dir, shorts_n=n, genre=genre, resume=resume, profile=profile,
                     cast_registry=cast_registry, channels=channels, fast=fast,
                     program_context=program_context, media_id=media_id)
    cast = result.get("cast") or {}
    print(f"\n=== 요약 ===")
    print(f"  {len(result['transcript'])} 자막 · {len(result['scenes'])} 장면 · {len(result['shorts'])} 쇼츠 · "
          f"출연자 {cast.get('matchedCount', 0)}확정/{cast.get('candidateCount', 0)}후보 · "
          f"장르 {result['genre']} · {result['took_sec']}초")
    for s in sorted(result["shorts"], key=lambda x: x.get("rank", 99))[:5]:
        print(f"  #{s.get('rank')} [{int(s['start']//60)}:{int(s['start']%60):02d}] appeal {s.get('appeal')} 『{s.get('title','')}』")

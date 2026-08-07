"""쇼츠 실제 렌더링 (ffmpeg 로 trim + 첫 3초 hook_intro drawtext overlay).

각 쇼츠:
  source.mp4 [start~end] trim → hook_intro_caption 자막 첫 3초 overlay → rendered/s{i}.mp4

사용:
  python render_shorts.py --workdir <m_*/> --out <rendered_dir>

Windows 한글 폰트: c:/Windows/Fonts/malgun.ttf (기본).
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path


def render_short(video: Path, start: float, end: float, hook_intro: str,
                  out: Path, font: str, hook_dur: float = 3.0,
                  hook_time_sec: float = 0.0,
                  title_line1: str = "", title_line2: str = "",
                  title_line2_color: str = "yellow") -> bool:
    """쇼츠 하나 렌더. 프리롤(3초 hook clip) + 본문(원본 shorts) concat.

    - 자막(hook_intro) 은 붙이지 않음 (사용자 지시 2026-07-31)
    - 제목(title_line1 흰색 · title_line2 컬러) 은 상단에 프리롤+본문 내내 표시
    - 부드러운 fade in/out 전환 · 툭 하는 느낌 없이
    hook_time_sec: shorts.start 기준 상대 시각. 원본 절대 시각 = start + hook_time_sec.
    """
    if end <= start:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    hook_abs = start + max(0.0, hook_time_sec)
    # 프리롤 hook 이 본문 안에 들어있어도 · 이후 본문에서도 다시 재생됨 (시청자 궁금증 유지 효과)

    # 실제 Shorts/Reels 배포 스펙 · 9:16 세로 1080x1920.
    # 프리롤 (hook 3초) + 본문 concat · 부드러운 fade transition.
    # 사용자 지시 (2026-07-31):
    #  - 자막(hook_intro) X · 순수 hook clip
    #  - 툭 하는 느낌 없이 부드러운 fade 전환
    #  - 제목(title_line1 흰색 · title_line2 컬러) 위쪽 pad 영역 (영상 letterbox 위 공간) 에 표시
    #
    # 레이아웃 (1080 x 1920 · 원본 16:9 → 1080 x 607 letterbox · y=(1920-607)/2 ≈ 656):
    #   [ 0~656 위쪽 pad (blur bg) + 제목 두 줄 ]
    #   [ 656~1263 원본 영상 ]
    #   [ 1263~1920 아래 pad (blur bg) ]
    preroll_start = hook_abs
    preroll_end = hook_abs + hook_dur
    body_start = start
    body_end = end
    trans = 0.5

    font_esc = font.replace("\\", "/").replace(":", "\\:")

    # 제목 두 줄 · 각 line 별개 파일 (한글 escape 안전)
    tl1_file = out.with_suffix(".t1.txt")
    tl2_file = out.with_suffix(".t2.txt")
    tl1_text = title_line1.strip() or ""
    tl2_text = title_line2.strip() or ""
    tl1_file.write_text(tl1_text, encoding="utf-8")
    tl2_file.write_text(tl2_text, encoding="utf-8")
    tl1_esc = str(tl1_file).replace("\\", "/").replace(":", "\\:")
    tl2_esc = str(tl2_file).replace("\\", "/").replace(":", "\\:")

    # title_line2 색상 매핑
    color_map = {"yellow": "#ffd93a", "red": "#ff6b6b", "blue": "#6ea8ff",
                  "green": "#4bd0a0", "orange": "#ff9770", "white": "#ffffff"}
    tl2_color = color_map.get(title_line2_color.lower(), "#ffd93a")

    # 9:16 blur pad + 위쪽 제목 두 줄 drawtext (지속 표시)
    # preroll=True 이면 · zoom 1.12x + saturation/contrast 강조 · body 첫 3초와 시각 차별화
    #   (hook_time_sec=0 이라 preroll≈body 첫3초인 경우에도 · "훅→본편" 느낌 유지)
    def pad916_with_title(inp: str, out_label: str, preroll: bool = False) -> str:
        if preroll:
            fg_pre = (
                "scale=1210:-2,crop=1080:ih-40:(iw-1080)/2:20,"
                "eq=saturation=1.30:contrast=1.06:brightness=0.02,"
            )
        else:
            fg_pre = ""
        base = (
            f"[{inp}]split=2[{inp}_bg_src][{inp}_fg_src];"
            f"[{inp}_bg_src]scale=1080:1920:force_original_aspect_ratio=increase,"
            f"crop=1080:1920,gblur=sigma=25,setsar=1[{inp}_bg];"
            f"[{inp}_fg_src]{fg_pre}scale=1080:-2[{inp}_fg];"
            f"[{inp}_bg][{inp}_fg]overlay=(W-w)/2:(H-h)/2[{inp}_canvas]"
        )
        # 상단 pad 영역 (y=0~600) · 제목 두 줄
        # line1 (흰색 톤다운) · y ≈ 250 · line2 (컬러 강조) · y ≈ 400
        t1 = ""
        if tl1_text:
            t1 = (
                f";[{inp}_canvas]drawtext=fontfile='{font_esc}':textfile='{tl1_esc}'"
                f":fontcolor=white:fontsize=72:borderw=3:bordercolor=black@0.7"
                f":x=(w-text_w)/2:y=220[{inp}_c1]"
            )
        else:
            t1 = f";[{inp}_canvas]copy[{inp}_c1]"
        t2 = ""
        if tl2_text:
            t2 = (
                f";[{inp}_c1]drawtext=fontfile='{font_esc}':textfile='{tl2_esc}'"
                f":fontcolor={tl2_color}:fontsize=88:borderw=4:bordercolor=black@0.85"
                f":x=(w-text_w)/2:y=340[{out_label}]"
            )
        else:
            t2 = f";[{inp}_c1]copy[{out_label}]"
        return base + t1 + t2

    # preroll → body 전환 · xfade cross-dissolve (0.25s · flash·dip 없이 매끄럽게)
    #   xfade offset = preroll_dur - transition
    xfade_dur = 0.25
    xfade_offset = max(0.0, hook_dur - xfade_dur)
    filter_complex = (
        pad916_with_title("0:v", "preroll_v", preroll=True) + ";"
        + pad916_with_title("1:v", "body_v", preroll=False) + ";"
        f"[preroll_v][body_v]xfade=transition=fade:duration={xfade_dur}:offset={xfade_offset}[v];"
        f"[0:a][1:a]acrossfade=d={xfade_dur}[a]"
    )

    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{preroll_start:.3f}", "-to", f"{preroll_end:.3f}", "-i", str(video),
        "-ss", f"{body_start:.3f}", "-to", f"{body_end:.3f}", "-i", str(video),
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(out),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            print(f"[err] {out.name}: {r.stderr[:400]}")
            return False
    finally:
        for f in (tl1_file, tl2_file):
            try: f.unlink()
            except Exception: pass
    return out.exists() and out.stat().st_size > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--out", required=True, help="rendered/ 폴더")
    ap.add_argument("--font", default="c:/Windows/Fonts/malgun.ttf")
    ap.add_argument("--hook-sec", type=float, default=3.0)
    args = ap.parse_args()

    wd = Path(args.workdir); out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    video = wd / "source.mp4"
    if not video.exists():
        print(f"!! {video} 없음"); sys.exit(1)
    data = json.loads((wd / "shorts.json").read_text(encoding="utf-8"))
    shorts = data.get("shorts") or []
    # hook_beat_id 있으면 beats.json 에서 그 beat 의 절대 start 를 preroll 시작으로 (첫 3초)
    beats_by_id: dict = {}
    beats_path = wd / "beats.json"
    if beats_path.exists():
        beats_data = json.loads(beats_path.read_text(encoding="utf-8"))
        beats_by_id = {b["id"]: b for b in beats_data.get("beats", []) if "id" in b}
    ok = 0
    for i, s in enumerate(shorts, 1):
        st = float(s.get("start", 0)); en = float(s.get("end", 0))
        hook = (s.get("hook_intro_caption") or "").strip()
        # 우선 순위: hook_beat_id (별도 콜로 뽑힌 강한 hook beat) → hook_time_sec (Gemini 원래 필드)
        hook_beat_id = s.get("hook_beat_id")
        if isinstance(hook_beat_id, int) and hook_beat_id in beats_by_id:
            b = beats_by_id[hook_beat_id]
            hook_time = max(0.0, float(b["start"]) - st)
        else:
            hook_time = float(s.get("hook_time_sec") or 0.0)
        tl1 = (s.get("title_line1") or "").strip()
        tl2 = (s.get("title_line2") or "").strip()
        tl2_color = (s.get("title_line2_color") or "yellow").strip()
        target = out / f"s{i:02d}.mp4"
        if render_short(video, st, en, hook, target, args.font, args.hook_sec,
                          hook_time_sec=hook_time,
                          title_line1=tl1, title_line2=tl2,
                          title_line2_color=tl2_color):
            print(f"[ok] #{i} {st:.1f}-{en:.1f}s · '{tl1} / {tl2}' → {target.name}")
            ok += 1
        else:
            print(f"[fail] #{i}")
    print(f"\n렌더 완료: {ok}/{len(shorts)} → {out}")


if __name__ == "__main__":
    main()

"""쇼츠 템플릿 합성 — 캔바에서 받은 PNG 프레임 + 우리 텍스트.

템플릿은 `assets/shorts-template/<name>/` 안에 두 파일로 저장한다:

  overlay.png   캔바 export (1080x1920). 프레임·띠·로고 등 그래픽
  meta.json     띠(bands)·영상 영역(video)·텍스트 슬롯(text) 좌표

**캔바 텍스트는 쓰지 않는다.** overlay.png 에 픽셀로 구워진 글자는 `bands` 로 덮고,
그 자리에 우리 텍스트를 drawtext 로 그린다. 그래야 회차마다 제목이 바뀌는 걸 감당한다.
(캔바 autofill 로 텍스트를 채우는 경로도 있으나 쇼츠마다 API 왕복이 생겨서 안 쓴다.)

사용:
  python render_with_template.py --template mz-routine \
      --video clip.mp4 --start 2 --end 12 \
      --text title1="나는솔로 16기 영수" --text title2="고백 직전 3초" \
      --text cta="구독 ▶ 좋아요" --out out.mp4
"""
from __future__ import annotations
import argparse, json, subprocess, sys, tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_DIR = REPO_ROOT / "assets" / "shorts-template"
DEFAULT_FONT = "c:/Windows/Fonts/malgunbd.ttf"


def _esc(p: str | Path) -> str:
    """ffmpeg filter 인자용 경로 이스케이프 (Windows 드라이브 콜론 포함)."""
    return str(p).replace("\\", "/").replace(":", "\\:")


class Template:
    def __init__(self, name: str):
        self.dir = TEMPLATE_DIR / name
        meta_path = self.dir / "meta.json"
        if not meta_path.exists():
            raise SystemExit(f"템플릿 없음: {meta_path}")
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.overlay = self.dir / "overlay.png"
        if not self.overlay.exists():
            raise SystemExit(f"overlay.png 없음: {self.overlay}")
        self.w, self.h = self.meta.get("size", [1080, 1920])

    @property
    def slots(self) -> list[str]:
        return [t["slot"] for t in self.meta.get("text", [])]


def build_filter(tpl: Template, texts: dict[str, str], tmpdir: Path,
                 font: str) -> str:
    """영상 → 9:16 캔버스 → 템플릿 오버레이 → 띠 덮기 → 텍스트."""
    v = tpl.meta["video"]
    # 영상은 영역을 **꽉 채운다** (cover) — 키워서 넘치는 부분을 잘라낸다.
    # letterbox + blur 배경은 쓰지 않는다: 여백이 생기면 템플릿 디자인이 깨져 보인다.
    # 대신 영역 비율이 소스와 많이 다르면 좌우가 크게 잘리므로, meta.json 의 video 는
    # 소스 비율(보통 16:9)에 가깝게 잡고 남는 자리는 bands 로 메우는 게 맞다.
    fit = v.get("fit", "cover")
    if fit == "contain":
        scale = (f"scale={v['w']}:{v['h']}:force_original_aspect_ratio=decrease,"
                 f"pad={v['w']}:{v['h']}:(ow-iw)/2:(oh-ih)/2:black")
    else:
        scale = (f"scale={v['w']}:{v['h']}:force_original_aspect_ratio=increase,"
                 f"crop={v['w']}:{v['h']}")
    chain = [
        # 바탕은 검정. 영상·bands·overlay 가 안 덮는 자리는 검정으로 남는다.
        f"[2:v]scale={tpl.w}:{tpl.h},setsar=1[base]",
        f"[0:v]{scale},setsar=1[fg]",
        f"[base][fg]overlay={v['x']}:{v['y']}[mid]",
    ]

    # 순서가 중요하다: 영상 → bands → overlay_regions → text.
    # bands 를 overlay 뒤에 칠하면 템플릿 그래픽(로고 등)을 지워버린다.
    # bands 는 "영상/blur 가 비치면 안 되는 자리를 단색으로 막는 것",
    # overlay_regions 는 "PNG 에서 살릴 그래픽" — 둘은 겹치지 않게 잡는다.
    bands = "".join(
        f"drawbox=x={b['x']}:y={b['y']}:w={b['w']}:h={b['h']}"
        f":color={b.get('color', 'black')}:t=fill,"
        for b in tpl.meta.get("bands", []) if not b.get("over")
    )
    chain.append(f"[mid]{bands}copy[banded]")

    # overlay.png 를 통째로 얹으면 템플릿의 자체 배경사진이 영상을 덮는다.
    # 쓸 영역만 잘라서 올린다. 비어 있으면 PNG 는 픽셀을 기여하지 않고
    # meta.json 의 좌표만 쓰는 셈이다 — 띠가 단색인 템플릿이 그렇다.
    last = "banded"
    for i, r in enumerate(tpl.meta.get("overlay_regions", [])):
        chain.append(f"[1:v]crop={r['w']}:{r['h']}:{r['x']}:{r['y']}[tpl{i}]")
        nxt = f"ov{i}"
        chain.append(f"[{last}][tpl{i}]overlay={r['x']}:{r['y']}[{nxt}]")
        last = nxt
    # `"over": true` 인 band 는 overlay 뒤에 칠한다 — 템플릿 그래픽 **안에** 박힌 글자를
    # 지울 때 쓴다 (예: 헤더 바 안의 브랜드명). 그 자리에 우리 텍스트를 다시 그린다.
    over = "".join(
        f"drawbox=x={b['x']}:y={b['y']}:w={b['w']}:h={b['h']}"
        f":color={b.get('color', 'black')}:t=fill,"
        for b in tpl.meta.get("bands", []) if b.get("over")
    )
    chain.append(f"[{last}]{over}copy[framed]")

    post = []
    for slot in tpl.meta.get("text", []):
        value = (texts.get(slot["slot"]) or "").strip()
        if not value:
            continue
        # 한글은 filter 인자에 직접 넣으면 이스케이프가 깨진다 — 항상 textfile 로.
        f = tmpdir / f"{slot['slot']}.txt"
        f.write_text(value, encoding="utf-8")
        x = slot.get("x")
        x_expr = "(w-text_w)/2" if x in (None, "center") else str(x)
        # 띠 없이 영상 위에 바로 얹는 템플릿은 테두리가 없으면 글자가 묻힌다.
        bw = slot.get("borderw", 0)
        border = (f":borderw={bw}:bordercolor={slot.get('bordercolor', 'black')}"
                  if bw else "")
        shadow = (f":shadowx={slot['shadowx']}:shadowy={slot.get('shadowy', slot.get('shadowx'))}"
                  f":shadowcolor={slot.get('shadowcolor', 'black@0.6')}"
                  if slot.get("shadowx") else "")
        post.append(
            f"drawtext=fontfile='{_esc(font)}':textfile='{_esc(f)}'"
            f":fontcolor={slot.get('color', 'white')}:fontsize={slot['size']}"
            f":x={x_expr}:y={slot['y']}{border}{shadow}"
        )

    if post:
        chain.append("[framed]" + ",".join(post) + "[v]")
    else:
        chain.append("[framed]copy[v]")
    return ";".join(chain)


def render(tpl: Template, video: Path, start: float, end: float,
           texts: dict[str, str], out: Path, font: str) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        fc = build_filter(tpl, texts, Path(td), font)
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            # -ss 는 반드시 -i 앞에. 뒤에 두면 전량 디코드로 수백 배 느려진다.
            "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(video),
            "-i", str(tpl.overlay),
            # 검정 바탕 — 영상·bands·overlay 가 안 덮는 자리를 채운다 (blur 대체).
            # ⚠️ d= 를 빼면 무한 길이 입력이라 인코딩이 영원히 안 끝난다.
            "-f", "lavfi", "-i", f"color=black:s={tpl.w}x{tpl.h}:d={end - start:.3f}",
            "-filter_complex", fc,
            "-map", "[v]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(out),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            sys.stderr.write(r.stderr[-2000:])
            raise SystemExit(f"ffmpeg 실패 (exit {r.returncode})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True, help="assets/shorts-template/<name>")
    ap.add_argument("--video", type=Path)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--font", default=DEFAULT_FONT)
    ap.add_argument("--text", action="append", default=[],
                    metavar="SLOT=값", help="예: --text title1=\"제목\"")
    ap.add_argument("--list-slots", action="store_true")
    a = ap.parse_args()

    tpl = Template(a.template)
    if a.list_slots:
        print(" ".join(tpl.slots))
        return

    missing = [n for n in ("video", "end", "out") if getattr(a, n) is None]
    if missing:
        raise SystemExit(f"필수 인자 누락: {['--' + m for m in missing]}")

    texts: dict[str, str] = {}
    for pair in a.text:
        k, _, val = pair.partition("=")
        texts[k.strip()] = val
    unknown = set(texts) - set(tpl.slots)
    if unknown:
        raise SystemExit(f"템플릿 '{a.template}' 에 없는 슬롯: {sorted(unknown)}\n"
                         f"사용 가능: {tpl.slots}")

    render(tpl, a.video, a.start, a.end, texts, a.out, a.font)
    print(f"OK {a.out}")


if __name__ == "__main__":
    main()

"""Shorts 결과 브라우저 뷰어 (video + 카드 · click to seek/play range).

python shorts_viewer.py --workdir <m_*/> --out <dir>
"""
from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
from pathlib import Path


def fmt_ts(sec: float) -> str:
    m = int(sec // 60)
    s = sec - m * 60
    return f"{m:02d}:{s:05.2f}"


def ffmpeg_thumb(video: Path, t: float, out: Path, w: int = 480) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video),
           "-frames:v", "1", "-vf", f"scale={w}:-2", str(out)]
    try:
        subprocess.run(cmd, capture_output=True, timeout=30)
        return out.exists()
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True, help="m_*/ path (source.mp4 + shorts.json + beats.json)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    wd = Path(args.workdir)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    thumbs = out / "thumbs"; thumbs.mkdir(exist_ok=True)

    video = wd / "source.mp4"
    shorts = json.loads((wd / "shorts.json").read_text(encoding="utf-8")).get("shorts", [])
    beats = json.loads((wd / "beats.json").read_text(encoding="utf-8")).get("beats", [])
    ctx = json.loads((wd / "program_context.json").read_text(encoding="utf-8")) if (wd / "program_context.json").exists() else {}

    # video relpath
    rel = os.path.relpath(video.resolve(), out.resolve()).replace("\\", "/")

    # 각 short 대표 프레임 (중앙)
    short_thumbs = []
    for i, s in enumerate(shorts):
        t = (float(s["start"]) + float(s["end"])) / 2
        p = thumbs / f"s{i}.jpg"
        ffmpeg_thumb(video, t, p, w=480)
        short_thumbs.append(p.name if p.exists() else None)

    beat_by_id = {b.get("id"): b for b in beats}

    def hook_color(h: str) -> str:
        m = {"반전":"#ff6b6b", "웃음":"#ffe86e", "감정고조":"#ff9770",
             "돌직구":"#6ea8ff", "질문":"#a78bfa", "정보성":"#4bd0a0",
             "갈등":"#f078b4", "공감":"#7ee8fa", "기타":"#8a919d"}
        return m.get(h, "#8a919d")

    def esc(x: str) -> str: return html.escape(str(x or ""))

    cards = []
    for i, s in enumerate(shorts):
        st = float(s["start"]); en = float(s["end"])
        title = esc(s.get("title", ""))
        hook = s.get("hook", "기타")
        beat_ids = s.get("beat_ids", [])
        chip_parts = []
        for bid in beat_ids:
            bttl = esc((beat_by_id.get(bid) or {}).get("title") or f"beat #{bid}")
            chip_parts.append(f'<span class="chip" title="{bttl}">beat #{bid}</span>')
        beat_chips = "".join(chip_parts)
        # beat별 대사 (transcript) 첫 줄만
        beat_lines = []
        for bid in beat_ids:
            b = beat_by_id.get(bid, {})
            tx = (b.get("transcript") or "").split("\n")[0] if b.get("transcript") else ""
            if tx:
                beat_lines.append(f'<div class="beat-line">#{bid}: {esc(tx[:120])}</div>')
        # 렌더된 9:16 mp4 있으면 embed (rendered/s{i:02d}.mp4) · 없으면 thumb 대체
        rendered_mp4 = wd / "rendered" / f"s{i+1:02d}.mp4"
        if rendered_mp4.exists():
            rel_rendered = os.path.relpath(rendered_mp4.resolve(), out.resolve()).replace("\\", "/")
            thumb_html = f'<video src="{esc(rel_rendered)}" controls preload="metadata" playsinline muted style="width:100%;height:100%;object-fit:contain;background:#000;"></video>'
        else:
            thumb_html = f'<img src="thumbs/{esc(short_thumbs[i])}" loading="lazy">' if short_thumbs[i] else ''
        # 첫 3초 hook intro (docs/plans/shorts-hook-intro-3sec.md · 어그로 편집자막 + 원 대사)
        hook_intro = esc(s.get("hook_intro_caption", ""))
        hook_quote = esc(s.get("hook_quote", ""))
        hook_time = s.get("hook_time_sec")
        hook_html = ""
        if hook_intro or hook_quote:
            time_str = f"{float(hook_time):.1f}s" if isinstance(hook_time, (int, float)) else "?"
            intro_html = f'<div class="hook-intro">🔥 {hook_intro}</div>' if hook_intro else ""
            quote_html = f'<div class="hook-quote">"{hook_quote}" <span class="hook-time">@ +{time_str}</span></div>' if hook_quote else ""
            hook_html = f'<div class="hook-block">{intro_html}{quote_html}</div>'
        cards.append(f"""
        <div class="card" data-start="{st:.3f}" data-end="{en:.3f}">
          <div class="thumb">{thumb_html}
            <span class="rank">#{s.get("rank", i+1)}</span>
            <span class="dur">{fmt_ts(en-st)}</span>
            <span class="hook" style="background:{hook_color(hook)}22;color:{hook_color(hook)}">{esc(hook)}</span>
          </div>
          <div class="body">
            <div class="title">{title}</div>
            <div class="range">{fmt_ts(st)} → {fmt_ts(en)}</div>
            {hook_html}
            <div class="chips">{beat_chips}</div>
            <div class="lines">{"".join(beat_lines)}</div>
          </div>
        </div>
        """)

    doc = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Shorts 결과 · {esc(ctx.get("title", "STEPD"))}</title>
<style>
  :root {{ --bg:#0f1114; --panel:#1a1d22; --border:#2a2e35; --muted:#8a919d; --fg:#e6e9ee; --brand:#6ea8ff; }}
  *{{box-sizing:border-box}}
  body {{ margin:0; padding:20px; font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif; background:var(--bg); color:var(--fg); }}
  h1 {{ font-size:18px; margin:0 0 4px; }}
  .meta {{ color:var(--muted); font-size:12px; margin-bottom:14px; }}
  .player-wrap {{ position:sticky; top:0; z-index:50; background:var(--bg); padding:10px 0; border-bottom:1px solid var(--border); margin:-20px -20px 16px; padding:12px 20px; }}
  .player-row {{ display:grid; grid-template-columns:520px 1fr; gap:14px; align-items:start; }}
  #player {{ width:100%; max-height:290px; background:#000; border-radius:6px; }}
  .info {{ font-size:12px; color:var(--muted); }}
  .info b {{ color:var(--fg); font-size:14px; }}
  #now {{ display:inline-block; margin-top:6px; padding:2px 8px; border-radius:999px; background:rgba(110,168,255,.15); color:var(--brand); font-size:11px; }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(360px,1fr)); gap:12px; }}
  .card {{ background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; cursor:pointer; transition:border-color .1s; }}
  .card:hover {{ border-color:var(--brand); }}
  .thumb {{ position:relative; aspect-ratio:9/16; background:#000; max-height:480px; }}
  .thumb img {{ width:100%; height:100%; object-fit:cover; display:block; }}
  .thumb .rank {{ position:absolute; top:8px; left:8px; background:rgba(0,0,0,.75); color:#fff; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px; }}
  .thumb .dur {{ position:absolute; bottom:8px; right:8px; background:rgba(0,0,0,.75); color:#fff; padding:2px 8px; border-radius:4px; font-size:11px; }}
  .thumb .hook {{ position:absolute; top:8px; right:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; border:1px solid currentColor; }}
  .body {{ padding:12px; }}
  .title {{ font-size:15px; font-weight:600; line-height:1.35; margin-bottom:6px; }}
  .range {{ color:var(--muted); font-size:11px; margin-bottom:8px; }}
  .chips {{ display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; }}
  .chip {{ font-size:10px; padding:2px 8px; border-radius:999px; background:rgba(139,125,252,.15); color:#a78bfa; }}
  .lines {{ font-size:11px; color:var(--muted); line-height:1.5; }}
  .beat-line {{ margin-bottom:3px; }}
  .hook-block {{ background:rgba(255,107,107,.08); border-left:3px solid #ff6b6b; padding:8px 10px; border-radius:4px; margin-bottom:8px; }}
  .hook-intro {{ font-size:14px; font-weight:700; color:#ff9770; letter-spacing:-0.3px; margin-bottom:4px; }}
  .hook-quote {{ font-size:11px; color:#c9d0d9; font-style:italic; line-height:1.4; }}
  .hook-time {{ color:var(--muted); font-style:normal; font-size:10px; margin-left:4px; }}
</style></head><body>
<div class="player-wrap">
  <div class="player-row">
    <video id="player" controls preload="metadata" src="{esc(rel)}"></video>
    <div class="info">
      <b>Shorts 결과 · {esc(ctx.get("title", ""))}</b><br>
      {esc(ctx.get("section","") + " · " + ctx.get("synopsis","")[:100])}<br>
      Shorts <b>{len(shorts)}</b>개 · Beats <b>{len(beats)}</b>개<br>
      <span id="now">카드 클릭 → 그 shorts 구간 재생</span>
    </div>
  </div>
</div>
<div class="cards">{"".join(cards)}</div>
<script>
  const p = document.getElementById('player');
  const now = document.getElementById('now');
  let stopAt = null;
  p.addEventListener('timeupdate', () => {{
    if (stopAt !== null && p.currentTime >= stopAt) {{ p.pause(); stopAt = null; }}
  }});
  document.querySelectorAll('.card').forEach(el => {{
    el.addEventListener('click', () => {{
      const st = parseFloat(el.dataset.start), en = parseFloat(el.dataset.end);
      p.currentTime = st; stopAt = en;
      p.play().catch(()=>{{}});
      const title = el.querySelector('.title').textContent.trim();
      now.textContent = `▶ ${{title}}`;
    }});
  }});
</script></body></html>
"""
    (out / "viewer.html").write_text(doc, encoding="utf-8")
    print(f"[ok] shorts viewer → {out}/viewer.html · {len(shorts)} shorts")


if __name__ == "__main__":
    main()

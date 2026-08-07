"""Diarization 확인 뷰어 · refined.json 각 utterance 를 speaker 별 색상 · click 시 재생.

python diarization_viewer.py --workdir <m_*/> --out <dir>
"""
from __future__ import annotations
import argparse, html, json, os
from pathlib import Path
from collections import Counter


def fmt_ts(sec: float) -> str:
    m = int(sec // 60); s = sec - m * 60
    return f"{m:02d}:{s:05.2f}"


PALETTE = ["#6ea8ff","#ffb84d","#4bd0a0","#ff6b6b","#a78bfa","#f078b4",
            "#7ee8fa","#ffe86e","#ff9770","#c084fc","#fb7185","#22d3ee"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    wd = Path(args.workdir); out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    video = wd / "source.mp4"
    refined = json.loads((wd / "refined.json").read_text(encoding="utf-8"))
    ctx = json.loads((wd / "program_context.json").read_text(encoding="utf-8")) if (wd / "program_context.json").exists() else {}
    rel = os.path.relpath(video.resolve(), out.resolve()).replace("\\", "/")

    # speaker → color
    speakers = [s for s, _ in Counter((u.get("speaker") or "(empty)") for u in refined).most_common()]
    color = {sp: PALETTE[i % len(PALETTE)] for i, sp in enumerate(speakers)}
    counts = Counter((u.get("speaker") or "(empty)") for u in refined)

    def esc(x): return html.escape(str(x or ""))

    legend = "".join(
        f'<span class="chip" data-sp="{esc(sp)}" style="background:{color[sp]}22;color:{color[sp]};border-color:{color[sp]}55;">{esc(sp)} · {counts[sp]}</span>'
        for sp in speakers
    )

    utters = []
    for u in refined:
        st = float(u.get("start", 0)); en = float(u.get("end", 0))
        sp = u.get("speaker") or "(empty)"
        text = esc(u.get("text", ""))
        utters.append(
            f'<div class="u" data-start="{st:.3f}" data-end="{en:.3f}" data-sp="{esc(sp)}" '
            f'style="border-left-color:{color[sp]}">'
            f'<div class="head"><span class="sp" style="background:{color[sp]}22;color:{color[sp]};">{esc(sp)}</span>'
            f'<span class="ts">{fmt_ts(st)} → {fmt_ts(en)} ({en-st:.1f}s)</span></div>'
            f'<div class="txt">{text}</div></div>'
        )

    doc = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Diarization · {esc(ctx.get("title","STEPD"))}</title>
<style>
  :root {{ --bg:#0f1114; --panel:#1a1d22; --border:#2a2e35; --muted:#8a919d; --fg:#e6e9ee; --brand:#6ea8ff; }}
  *{{box-sizing:border-box}}
  body{{margin:0;padding:0;font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif;background:var(--bg);color:var(--fg);}}
  header{{position:sticky;top:0;z-index:50;background:var(--panel);border-bottom:1px solid var(--border);padding:12px 20px;}}
  .prow{{display:grid;grid-template-columns:520px 1fr;gap:14px;align-items:start;}}
  #player{{width:100%;max-height:280px;background:#000;border-radius:6px;}}
  .info{{font-size:12px;color:var(--muted);}}
  .info b{{color:var(--fg);font-size:14px;}}
  .legend{{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}}
  .chip{{padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid; cursor:pointer;}}
  .chip.dim{{opacity:0.25;}}
  main{{max-width:900px;margin:0 auto;padding:20px;}}
  .u{{background:var(--panel);border:1px solid var(--border);border-left:4px solid;border-radius:6px;padding:8px 12px;margin-bottom:6px;cursor:pointer;transition:background .05s;}}
  .u:hover{{background:#22262d;}}
  .u.hidden{{display:none;}}
  .head{{display:flex;align-items:center;gap:8px;margin-bottom:2px;}}
  .sp{{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;}}
  .ts{{font-size:11px;color:var(--muted);font-family:Consolas,monospace;}}
  .txt{{font-size:13px;line-height:1.5;color:var(--fg);}}
  #now{{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:999px;background:rgba(110,168,255,.15);color:var(--brand);font-size:11px;}}
</style></head><body>
<header><div class="prow">
  <video id="player" controls preload="metadata" src="{esc(rel)}"></video>
  <div class="info"><b>Diarization 확인 · {esc(ctx.get("title",""))}</b><br>
    총 <b>{len(refined)}</b> utterance · <b>{len(speakers)}</b> speaker<br>
    <span id="now">chip 클릭 = 필터 · utterance 클릭 = 그 발화 재생</span>
    <div class="legend">{legend}</div>
  </div>
</div></header>
<main>{"".join(utters)}</main>
<script>
  const p=document.getElementById('player'), now=document.getElementById('now');
  let stopAt=null;
  p.addEventListener('timeupdate',()=>{{if(stopAt!==null&&p.currentTime>=stopAt){{p.pause();stopAt=null;}}}});
  document.querySelectorAll('.u').forEach(el=>el.addEventListener('click',()=>{{
    const st=parseFloat(el.dataset.start), en=parseFloat(el.dataset.end);
    p.currentTime=st; stopAt=en; p.play().catch(()=>{{}});
    now.textContent=`▶ ${{el.dataset.sp}} · ${{el.querySelector('.txt').textContent.slice(0,40)}}`;
  }}));
  const active=new Set();
  document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{{
    const sp=c.dataset.sp;
    if(active.has(sp)){{active.delete(sp);c.classList.add('dim');}} else {{active.add(sp);c.classList.remove('dim');}}
    if(active.size===0){{ document.querySelectorAll('.chip').forEach(x=>x.classList.remove('dim'));
      document.querySelectorAll('.u').forEach(x=>x.classList.remove('hidden')); return; }}
    document.querySelectorAll('.u').forEach(x=>{{x.classList.toggle('hidden', !active.has(x.dataset.sp));}});
  }}));
</script></body></html>
"""
    (out / "viewer.html").write_text(doc, encoding="utf-8")
    print(f"[ok] diarization viewer → {out}/viewer.html · {len(refined)} utterances · {len(speakers)} speakers")


if __name__ == "__main__":
    main()

r"""분석 결과 검토 뷰어 생성 — 영상 + beat + 쇼츠 + 검색을 한 화면에서 본다.

사용:
    python scripts/make_review_viewer.py <workdir> <video_path> [out.html]

왜 로컬 HTML 인가: 원본 영상이 로컬 파일이라 게시형 아티팩트로는 재생이 안 된다.
브라우저에서 바로 열어 **경계가 맞는지 눈으로** 확인하는 게 목적이다 — 숫자로는 판단이 안 된다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def load(p: Path, key: str | None = None, default=None):
    if not p.exists():
        return default if default is not None else []
    d = json.loads(p.read_text(encoding="utf-8"))
    if key is None:
        return d
    return d.get(key, default if default is not None else [])


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    wd = Path(sys.argv[1]).resolve()
    video = Path(sys.argv[2]).resolve()
    out = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else wd / "review.html"

    beats = load(wd / "beats.json", "beats")
    shorts = load(wd / "shorts.json", "shorts")
    segs = load(wd / "segments.json", "segments")
    bnd = load(wd / "boundaries.json", "boundaries")
    dur = max([float(b.get("end") or 0) for b in beats] or [0])

    seg_by_beat = {s.get("source_beat"): s for s in segs}
    slim = []
    for b in beats:
        s = seg_by_beat.get(b.get("id"), {})
        slim.append({
            "id": b.get("id"),
            "start": round(float(b.get("start") or 0), 2),
            "end": round(float(b.get("end") or 0), 2),
            "title": b.get("title") or "",
            "summary": b.get("summary") or "",
            "hook": b.get("hook") or "",
            "scene": b.get("scene_summary") or "",
            "chars": b.get("characters") or [],
            "caps": b.get("on_screen_captions") or [],
            "src": (b.get("boundary") or {}).get("start_source") or "",
            "frame": (b.get("boundary") or {}).get("mid_frame") or "",
            "hs": round(float(s.get("highlight_score") or 0), 3),
            "ss": round(float(s.get("signal_score") or 0), 3),
            "st": s.get("scene_type") or "",
            "dia": (s.get("dialogue") or "")[:600],
            "sig": {k: round(float(v), 3) for k, v in (b.get("signals") or {}).items()},
        })

    slim_shorts = [{
        "rank": h.get("rank"), "start": round(float(h.get("start") or 0), 2),
        "end": round(float(h.get("end") or 0), 2),
        "title": h.get("title") or "", "hook": h.get("hook_quote") or h.get("hook") or "",
        "score": h.get("score100"), "parts": h.get("score_parts") or {},
        "beats": h.get("beat_ids") or [], "why": h.get("why") or h.get("reason") or "",
        "tags": h.get("tags") or [],
    } for h in shorts]

    data = {
        "video": str(video).replace("\\", "/"),
        "wd": str(wd).replace("\\", "/"),
        "dur": dur,
        "beats": slim,
        "shorts": slim_shorts,
        "bnd": [{"t": round(float(x.get("t") or 0), 2), "s": x.get("score")} for x in bnd],
    }

    out.write_text(HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False)),
                   encoding="utf-8")
    print(f"[viewer] {out}")
    print(f"  beat {len(slim)} · 쇼츠 {len(slim_shorts)} · 경계 {len(data['bnd'])} · {dur/60:.1f}분")
    return 0


HTML = r"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>STEP D · 분석 결과 검토</title>
<style>
:root{--bg:#0e0f13;--pan:#16181f;--ln:#252833;--fg:#e6e8ef;--dim:#8b90a0;--act:#5b9dff;--warn:#ffb454;--ok:#4ade80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--ln);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
.tab{padding:5px 13px;border:1px solid var(--ln);border-radius:99px;cursor:pointer;color:var(--dim);font-size:13px}
.tab.on{background:var(--act);border-color:var(--act);color:#fff}
.meta{color:var(--dim);font-size:12px;margin-left:auto}
main{display:grid;grid-template-columns:minmax(400px,44%) 1fr;gap:14px;padding:14px;align-items:start}
@media(max-width:1000px){main{grid-template-columns:1fr}}
.stick{position:sticky;top:14px}
video{width:100%;background:#000;border-radius:8px;display:block}
.bar{margin-top:8px;height:38px;background:var(--pan);border-radius:6px;position:relative;overflow:hidden;cursor:pointer;border:1px solid var(--ln)}
.bar i{position:absolute;top:0;bottom:0;border-left:1px solid rgba(255,255,255,.06)}
.bar .pos{position:absolute;top:0;bottom:0;width:2px;background:#fff;z-index:3;pointer-events:none}
.now{margin-top:8px;padding:10px 12px;background:var(--pan);border:1px solid var(--ln);border-radius:8px;min-height:70px}
.now b{color:var(--act)}
.row{display:flex;gap:10px;padding:9px;border:1px solid var(--ln);border-radius:8px;margin-bottom:7px;cursor:pointer;background:var(--pan)}
.row:hover{border-color:var(--act)}
.row.on{border-color:var(--act);background:#1b2030}
.row img{width:112px;height:63px;object-fit:cover;border-radius:4px;background:#000;flex:none}
.row .b{flex:1;min-width:0}
.t{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.ttl{font-weight:600;margin:2px 0 3px}
.sm{font-size:12.5px;color:#c3c8d6;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--ln);color:var(--dim);margin:3px 4px 0 0}
.chip.a{border-color:var(--act);color:var(--act)}
.chip.w{border-color:var(--warn);color:var(--warn)}
.tools{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
input,select{background:var(--pan);border:1px solid var(--ln);color:var(--fg);padding:6px 10px;border-radius:6px;font-size:13px}
input{flex:1;min-width:180px}
.hide{display:none}
.det{font-size:12.5px;color:#aeb4c6;margin-top:6px;white-space:pre-wrap;max-height:190px;overflow:auto}
.sc{font-variant-numeric:tabular-nums;font-weight:600}
</style></head><body>
<header>
  <h1>STEP D · 분석 결과 검토</h1>
  <span class="tab on" data-v="beats">beat</span>
  <span class="tab" data-v="shorts">쇼츠</span>
  <span class="tab" data-v="search">검색</span>
  <span class="meta" id="meta"></span>
</header>
<main>
  <div class="stick">
    <video id="v" controls preload="metadata"></video>
    <div class="bar" id="bar"><div class="pos" id="pos"></div></div>
    <div class="now" id="now">타임라인이나 목록을 클릭하세요.</div>
  </div>
  <div>
    <div class="tools" id="tools"></div>
    <div id="list"></div>
  </div>
</main>
<script>
const D = __DATA__;
const v = document.getElementById('v'), bar = document.getElementById('bar'),
      pos = document.getElementById('pos'), now = document.getElementById('now'),
      list = document.getElementById('list'), tools = document.getElementById('tools');
v.src = 'file:///' + D.video;
const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const img = f => f ? 'file:///' + D.wd + '/' + f : '';
document.getElementById('meta').textContent =
  `beat ${D.beats.length} · 쇼츠 ${D.shorts.length} · GEBD 경계 ${D.bnd.length} · ${(D.dur/60).toFixed(1)}분`;

/* 타임라인 — beat 를 highlight_score 로 색칠 */
const hs = D.beats.map(b=>b.hs), lo = Math.min(...hs), hi = Math.max(...hs);
bar.insertAdjacentHTML('beforeend', D.beats.map(b=>{
  const l = b.start/D.dur*100, w = Math.max(0.08,(b.end-b.start)/D.dur*100);
  const k = hi>lo ? (b.hs-lo)/(hi-lo) : .5;
  return `<i style="left:${l}%;width:${w}%;background:hsl(${210+k*130} 70% ${18+k*32}%)"
           title="b${b.id} ${fmt(b.start)} ${b.title}" onclick="seek(${b.start},${b.id})"></i>`;
}).join(''));
bar.addEventListener('click', e=>{ if(e.target===bar) v.currentTime = (e.offsetX/bar.clientWidth)*D.dur; });
v.addEventListener('timeupdate', ()=>{
  pos.style.left = (v.currentTime/D.dur*100)+'%';
  const b = D.beats.find(x=>v.currentTime>=x.start && v.currentTime<x.end);
  if(b && b.id!==cur) show(b.id);
});

let cur = -1, view = 'beats';
function seek(t,id){ v.currentTime = t; v.play(); if(id!=null) show(id); }
function show(id){
  cur = id; const b = D.beats.find(x=>x.id===id); if(!b) return;
  const sg = Object.entries(b.sig).map(([k,x])=>`${k} ${x}`).join(' · ');
  now.innerHTML = `<b>b${b.id}</b> ${fmt(b.start)}–${fmt(b.end)} (${(b.end-b.start).toFixed(1)}s)
    · <span class="chip a">${b.st||'-'}</span><span class="chip">${b.hook||'-'}</span>
    <span class="chip">경계 ${b.src||'-'}</span>
    <div class="ttl">${b.title||'(제목 없음)'}</div>
    <div class="sm" style="-webkit-line-clamp:4">${b.summary||''}</div>
    <div class="t" style="margin-top:5px">highlight ${b.hs} · signal ${b.ss} · ${sg}</div>`;
  document.querySelectorAll('.row').forEach(r=>r.classList.toggle('on', r.dataset.id==String(id)));
}

const TOOLS = {
  beats: `<input id="q" placeholder="제목·요약·대사 검색"><select id="sort">
      <option value="t">시간순</option><option value="h">highlight 높은순</option>
      <option value="s">signal 높은순</option><option value="d">긴 beat 순</option></select>
      <select id="flt"><option value="">전체</option><option value="short">짧은 것(&lt;6s)</option>
      <option value="long">긴 것(&gt;30s)</option></select>`,
  shorts: `<input id="q" placeholder="제목 검색">`,
  search: `<input id="q" placeholder="자연어로 검색 (대사·요약 키워드)"><select id="stf">
      <option value="">전체 장면</option><option value="on_scene">on_scene</option>
      <option value="interview">interview</option><option value="other">other</option></select>`,
};

function render(){
  tools.innerHTML = TOOLS[view];
  const q = ()=> (document.getElementById('q')?.value||'').trim().toLowerCase();
  const draw = ()=>{
    const s = q();
    if(view==='shorts'){
      list.innerHTML = D.shorts.filter(h=>!s||h.title.toLowerCase().includes(s)).map(h=>{
        const p = Object.entries(h.parts||{}).map(([k,x])=>`<span class="chip">${k} ${(+x).toFixed(2)}</span>`).join('');
        return `<div class="row" onclick="seek(${h.start})">
          <div class="b"><div class="t">#${h.rank} · ${fmt(h.start)}–${fmt(h.end)} (${(h.end-h.start).toFixed(0)}s)
            · <span class="sc" style="color:var(--ok)">${h.score}</span> · beat ${h.beats.join(',')}</div>
          <div class="ttl">${h.title}</div>
          <div class="sm">${h.hook||''}</div><div>${p}</div>
          <div class="det">${h.why}</div></div></div>`;
      }).join('') || '<div class="t">결과 없음</div>';
      return;
    }
    let rows = D.beats.slice();
    if(view==='search'){
      const st = document.getElementById('stf')?.value;
      if(st) rows = rows.filter(b=>b.st===st);
      if(s) rows = rows.filter(b=>(b.dia+b.summary+b.title).toLowerCase().includes(s));
      rows.sort((a,b)=>b.hs-a.hs);
    }else{
      if(s) rows = rows.filter(b=>(b.title+b.summary+b.dia).toLowerCase().includes(s));
      const f = document.getElementById('flt')?.value;
      if(f==='short') rows = rows.filter(b=>b.end-b.start<6);
      if(f==='long') rows = rows.filter(b=>b.end-b.start>30);
      const so = document.getElementById('sort')?.value;
      if(so==='h') rows.sort((a,b)=>b.hs-a.hs);
      if(so==='s') rows.sort((a,b)=>b.ss-a.ss);
      if(so==='d') rows.sort((a,b)=>(b.end-b.start)-(a.end-a.start));
    }
    list.innerHTML = rows.slice(0,400).map(b=>`
      <div class="row" data-id="${b.id}" onclick="seek(${b.start},${b.id})">
        <img loading="lazy" src="${img(b.frame)}">
        <div class="b"><div class="t">b${b.id} · ${fmt(b.start)} · ${(b.end-b.start).toFixed(1)}s
          · h ${b.hs} · s ${b.ss}</div>
        <div class="ttl">${b.title||'(제목 없음)'}</div>
        <div class="sm">${view==='search'? (b.dia||b.summary) : b.summary}</div>
        <div><span class="chip a">${b.st||'-'}</span>${b.hook?`<span class="chip">${b.hook}</span>`:''}
        ${(b.chars||[]).slice(0,3).map(c=>`<span class="chip w">${c}</span>`).join('')}
        ${(b.caps||[]).slice(0,2).map(c=>`<span class="chip">자막 ${c}</span>`).join('')}</div>
      </div></div>`).join('') || '<div class="t">결과 없음</div>';
    if(rows.length>400) list.insertAdjacentHTML('beforeend',`<div class="t">…상위 400개만 표시 (전체 ${rows.length})</div>`);
  };
  tools.oninput = draw; tools.onchange = draw; draw();
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  t.classList.add('on'); view = t.dataset.v; render();
});
render();
</script></body></html>"""


if __name__ == "__main__":
    raise SystemExit(main())

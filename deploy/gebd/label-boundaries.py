"""GEBD 경계 검수·라벨링 UI — 학습데이터 생성용.

모델이 뽑은 경계를 사람이 판정해 NIA 학습 스키마(`trigger_info`)로 내보낸다.
빈 영상을 처음부터 훑는 것보다 훨씬 빠르고, **모델이 틀리는 지점이 곧 학습 신호**다.

판단에 필요한 것을 다 붙였다 (2026-08-06 · "고치면서 튜닝해야 하니 판단할 수 있는 UI"):
  · 필름스트립 7장 — 경계가 정확히 **어디**인지 보이게 (±2s)
  · 대사 — refined.json 자막을 ±6초 창으로. **행동전환 판정의 핵심 근거**
  · 구간 반복재생 — 경계 앞뒤 6초를 루프
  · 경계 미세조정 — ±0.1/±0.5초. 맞는데 어긋난 경계를 버리지 않고 고쳐 쓴다
  · 오탐 사유 태그 — 왜 틀렸는지가 다음 학습의 신호다

라벨 (키보드):
  1 컷        Change due to cut   — 카메라/샷 전환
  2 행동전환   Change of action    — 샷은 유지, 상황·행동이 바뀜  ← 모델의 고유 가치
  3 오탐      경계 아님
  4 보류

사용:
  python deploy/gebd/label-boundaries.py --video <mp4> --boundaries <boundaries.json> \
      --out <dir> [--refined <refined.json>] [--pad 2.0]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 필름스트립 오프셋(초). 가운데(0.0)가 경계. 앞뒤 비대칭이 아니라 대칭이어야
# "경계가 왼쪽/오른쪽으로 밀렸다"를 눈으로 판단할 수 있다.
OFFSETS = [-2.0, -1.0, -0.4, 0.0, 0.4, 1.0, 2.0]


def probe(video: str) -> tuple[float, float]:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "format=duration:stream=r_frame_rate",
                            "-of", "default=noprint_wrappers=1:nokey=1", video],
                           capture_output=True, text=True, check=True)
        lines = [x for x in r.stdout.split() if x]
        fps = 29.97
        dur = 0.0
        for x in lines:
            if "/" in x:
                a, b = x.split("/"); fps = float(a) / float(b or 1)
            else:
                dur = float(x)
        return dur, round(fps, 3)
    except Exception:
        return 0.0, 29.97


def grab(video: str, t: float, out: Path, width: int = 320) -> bool:
    """프레임 1장. ⚠️ `-ss` 는 `-i` **앞** (fast seek) — 뒤에 두면 0초부터 전부 디코드해
    558배 느려진다(2026-08-06 실측)."""
    if out.exists():
        return True
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, t):.3f}",
                        "-i", video, "-frames:v", "1", "-vf", f"scale={width}:-2", str(out)],
                       check=True, timeout=30)
        return out.exists()
    except Exception:
        return False


def load_refined(p: str | None) -> list[dict]:
    if not p:
        return []
    try:
        d = json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(d, dict):
        d = d.get("segments") or d.get("refined") or []
    out = []
    for s in d if isinstance(d, list) else []:
        try:
            out.append({"s": round(float(s.get("start", 0)), 2),
                        "e": round(float(s.get("end", 0)), 2),
                        "t": (s.get("text") or "").strip()[:120],
                        "sp": (s.get("speaker") or "").strip()[:20]})
        except (TypeError, ValueError):
            continue
    return out


HTML = r"""<!doctype html><meta charset="utf-8"><title>GEBD 검수 — __NAME__</title>
<style>
:root{--bg:#0f1114;--panel:#171a1f;--bd:#2a2e35;--fg:#e6e9ee;--mut:#8a919d;
      --cut:#4bd0a0;--act:#ffb84d;--no:#ff6b6b;--hold:#6ea8ff;--sam:#c39bd3}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,'Malgun Gothic',sans-serif}
header{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--bd);
       padding:9px 14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.prog{flex:1;min-width:160px;height:7px;background:#0a0c0f;border-radius:4px;overflow:hidden}
.prog i{display:block;height:100%;background:var(--cut);width:0;transition:width .2s}
.cnt span{margin-right:9px;font-size:12px;white-space:nowrap}
button{background:#232830;color:var(--fg);border:1px solid var(--bd);border-radius:7px;
       padding:6px 11px;cursor:pointer;font-size:13px}
button:hover{border-color:var(--mut)}
button:disabled{opacity:.35;cursor:default}
.main{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:16px;padding:14px;align-items:start}
@media(max-width:900px){.main{grid-template-columns:1fr}}
.sticky{position:sticky;top:56px}
video{width:100%;border-radius:10px;background:#000;display:block}
.pbar{display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:14px}
.hd{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px}
.t{font-size:20px;font-weight:700}
.meta{font-size:12px;color:var(--mut)}
.strip{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.strip figure{margin:0;position:relative}
.strip img{width:100%;border-radius:5px;display:block;background:#000;cursor:pointer}
.strip figcaption{font-size:10px;color:var(--mut);text-align:center;margin-top:3px}
.strip .mid img{outline:2px solid var(--act);outline-offset:1px}
.strip .mid figcaption{color:var(--act);font-weight:700}
.subs{margin-top:12px;background:#0c0e11;border:1px solid var(--bd);border-radius:8px;
      padding:10px;max-height:160px;overflow:auto;font-size:13px}
.subs .ln{display:flex;gap:8px;padding:2px 0}
.subs .ln.at{background:rgba(255,184,77,.13);border-radius:4px}
.subs .tm{color:var(--mut);font-size:11px;min-width:52px;font-variant-numeric:tabular-nums}
.subs .sp{color:var(--hold);min-width:64px;font-size:12px}
.subs .none{color:var(--mut)}
.nudge{display:flex;gap:5px;align-items:center;margin-top:12px;flex-wrap:wrap}
.nudge .val{font-variant-numeric:tabular-nums;font-weight:700;min-width:74px;text-align:center}
.nudge .moved{color:var(--act)}
.btns{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap}
.btns button{font-weight:600;padding:9px 14px}
.btns button.on[data-v=cut]{background:var(--cut);color:#04120c;border-color:var(--cut)}
.btns button.on[data-v=action]{background:var(--act);color:#221600;border-color:var(--act)}
.btns button.on[data-v=samescene]{background:var(--sam);color:#1a0d20;border-color:var(--sam)}
.btns button.on[data-v=no]{background:var(--no);color:#2a0808;border-color:var(--no)}
.btns button.on[data-v=hold]{background:var(--hold);color:#04121f;border-color:var(--hold)}
.why{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.why button{font-size:12px;padding:4px 9px}
.why button.on{background:var(--no);color:#2a0808;border-color:var(--no)}
.nav{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.mini{display:flex;flex-wrap:wrap;gap:3px;margin-top:12px}
.mini i{width:12px;height:12px;border-radius:3px;background:#252a31;cursor:pointer;display:block}
.mini i.cut{background:var(--cut)} .mini i.action{background:var(--act)}
.mini i.samescene{background:var(--sam)}
.mini i.no{background:var(--no)} .mini i.hold{background:var(--hold)}
.mini i.cur{outline:2px solid #fff;outline-offset:1px}
.hint{color:var(--mut);font-size:12px;padding:0 14px 10px}
kbd{background:#0a0c0f;border:1px solid var(--bd);border-radius:4px;padding:1px 6px;font-size:11px}
.add{margin-top:12px;padding-top:12px;border-top:1px solid var(--bd)}
.add input{background:#0a0c0f;border:1px solid var(--bd);color:var(--fg);border-radius:6px;
           padding:5px 9px;width:96px;font-variant-numeric:tabular-nums}
</style>
<header>
  <b>GEBD 검수</b>
  <div class="prog"><i id="bar"></i></div>
  <div class="cnt" id="cnt"></div>
  <button onclick="exportJSON()">Export JSON</button>
  <button onclick="if(confirm('판정을 모두 지웁니다'))reset()">초기화</button>
</header>
<div class="hint">
  <kbd>1</kbd>씬전환컷 <kbd>2</kbd>행동전환 <kbd>3</kbd>같은씬컷 <kbd>4</kbd>오탐 <kbd>5</kbd>보류 ·
  <kbd>←</kbd><kbd>→</kbd>카드 이동 · <kbd>Space</kbd>구간 반복/정지 ·
  <kbd>,</kbd><kbd>.</kbd>프레임 이동(<kbd>Shift</kbd>=5프레임) · <kbd>Enter</kbd>현재 위치를 경계로 ·
  <kbd>[</kbd><kbd>]</kbd>경계 ∓0.1s(<kbd>Shift</kbd>=∓0.5s)
</div>
<div class="main">
  <div class="sticky">
    <video id="v" controls preload="metadata" src="__VIDEO__"></video>
    <div class="pbar">
      <button onclick="loop()">▶ 구간 반복 (Space)</button>
      <button onclick="stopLoop()">⏸ 정지</button>
      <span class="meta" id="ptime"></span>
    </div>
    <!-- 프레임 단위 조정 — 필름스트립은 원 경계 기준으로 미리 뽑혀 있어 nudge 해도
         안 따라온다. 정밀 위치는 **영상에서** 잡는 게 맞다. -->
    <div class="pbar" style="border-top:1px solid var(--bd);padding-top:8px;margin-top:8px">
      <button onclick="step(-5)" title=",,">◀◀5f</button>
      <button onclick="step(-1)" title=",">◀1f</button>
      <span class="meta" id="fdelta" style="min-width:96px;text-align:center"></span>
      <button onclick="step(1)" title=".">1f▶</button>
      <button onclick="step(5)" title="..">5f▶▶</button>
    </div>
    <div class="pbar">
      <button onclick="setHere()" style="background:#2b3a2f;border-color:var(--cut)">
        ⤓ 현재 재생 위치를 경계로</button>
    </div>
    <div class="add">
      <b style="font-size:13px">놓친 경계 추가</b><br>
      <span class="meta">영상에서 지점을 찾고 →</span>
      <div class="pbar">
        <button onclick="curT()">현재 시각</button>
        <input id="mt" placeholder="초">
        <button onclick="addMissed('cut')">＋컷</button>
        <button onclick="addMissed('action')">＋행동</button>
      </div>
      <div class="meta" id="missed"></div>
    </div>
    <div class="mini" id="mini"></div>
  </div>
  <div class="card" id="card"></div>
</div>
<script>
const B=__BOUNDARIES__, SUBS=__SUBS__, NAME=__NAMEJSON__, DUR=__DUR__, FPS=__FPS__, OFF=__OFFSETS__;
const KEY='gebd-label:'+NAME;
let S=JSON.parse(localStorage.getItem(KEY)||'{}');
let ADJ=JSON.parse(localStorage.getItem(KEY+':adj')||'{}');
let WHY=JSON.parse(localStorage.getItem(KEY+':why')||'{}');
let MISS=JSON.parse(localStorage.getItem(KEY+':missed')||'[]');
let i=0;
const v=document.getElementById('v');
const save=()=>{localStorage.setItem(KEY,JSON.stringify(S));
  localStorage.setItem(KEY+':adj',JSON.stringify(ADJ));
  localStorage.setItem(KEY+':why',JSON.stringify(WHY));
  localStorage.setItem(KEY+':missed',JSON.stringify(MISS));};
const fmt=s=>`${Math.floor(s/60)}:${(s%60).toFixed(1).padStart(4,'0')}`;
const T=k=>B[k].t+(ADJ[k]||0);
const WHYS=['카메라 움직임(액션)','고지/자막화면','크레딧','정지화면','같은 앵글','페이드/디졸브','기타'];

function subsAround(t){
  const w=SUBS.filter(s=>s.e>=t-6&&s.s<=t+6);
  if(!w.length) return '<div class="none">이 구간에 대사 없음 — 무음 전환일 수 있습니다</div>';
  return w.map(s=>`<div class="ln ${s.s<=t&&s.e>=t?'at':''}">
    <span class="tm">${fmt(s.s)}</span><span class="sp">${s.sp||''}</span><span>${s.t||''}</span></div>`).join('');
}
function render(){
  const b=B[i], t=T(i), moved=(ADJ[i]||0)!==0;
  document.getElementById('card').innerHTML=`
   <div class="hd"><span class="t">#${i+1} / ${B.length}</span>
     <span class="t" style="color:var(--act)">${fmt(t)}</span>
     <span class="meta">score ${b.score==null?'-':b.score.toFixed(3)} · grade ${b.grade||'-'} · kind ${b.kind||'-'}</span></div>
   <div class="strip">${OFF.map((o,j)=>`
     <figure class="${o===0?'mid':''}"><img loading="lazy" src="frames/b${i}_${j}.jpg" onclick="seek(${t+o})">
     <figcaption>${o===0?'경계':(o>0?'+':'')+o+'s'}</figcaption></figure>`).join('')}</div>
   <div class="subs">${subsAround(t)}</div>
   <div class="nudge"><span class="meta">경계 조정</span>
     <button onclick="nudge(-0.5)">◀0.5</button><button onclick="nudge(-0.1)">◀0.1</button>
     <button onclick="nudge(-FR)">◀1f</button>
     <span class="val ${moved?'moved':''}">${moved?((ADJ[i]>0?'+':'')+ADJ[i].toFixed(3)+'s'):'원위치'}</span>
     <button onclick="nudge(FR)">1f▶</button>
     <button onclick="nudge(0.1)">0.1▶</button><button onclick="nudge(0.5)">0.5▶</button>
     ${moved?'<button onclick="nudge(null)">되돌리기</button>':''}</div>
   <div class="meta" style="margin-top:5px">
     정밀 조정은 왼쪽 영상에서 — <kbd>,</kbd><kbd>.</kbd> 프레임 이동 후
     <b>⤓ 현재 위치를 경계로</b>. 필름스트립은 원 경계 기준이라 조정해도 안 움직입니다.</div>
   <div class="btns">
     ${[['cut','1 씬전환 컷'],['action','2 행동전환'],['samescene','3 같은 씬 컷'],
        ['no','4 오탐'],['hold','5 보류']].map(([k,l])=>
       `<button data-v="${k}" class="${S[i]===k?'on':''}" onclick="mark('${k}')">${l}</button>`).join('')}
   </div>
   ${S[i]==='samescene'?`<div class="meta" style="margin-top:6px;color:var(--sam)">
      리버스샷 등 — <b>컷은 맞지만</b> 같은 씬입니다. 학습엔 change_shot 으로만 들어가고
      change_event 에서는 빠집니다(beat 을 여기서 끊으면 대화가 조각납니다).</div>`:''}
   ${S[i]==='no'?`<div class="why">${WHYS.map(w=>
       `<button class="${WHY[i]===w?'on':''}" onclick="setWhy('${w}')">${w}</button>`).join('')}</div>`:''}
   <div class="nav"><button onclick="go(-1)" ${i===0?'disabled':''}>← 이전</button>
     <button onclick="go(1)" ${i===B.length-1?'disabled':''}>다음 →</button>
     <button onclick="nextUndone()">미판정으로 ⏭</button></div>`;
  stats(); mini();
}
function mini(){
  document.getElementById('mini').innerHTML=B.map((_,k)=>
    `<i class="${S[k]||''} ${k===i?'cur':''}" title="#${k+1} ${fmt(T(k))}" onclick="jump(${k})"></i>`).join('');
}
function stats(){
  const n=Object.keys(S).length,c={cut:0,action:0,samescene:0,no:0,hold:0};
  Object.values(S).forEach(x=>c[x]++);
  document.getElementById('bar').style.width=(n/B.length*100)+'%';
  document.getElementById('cnt').innerHTML=
    `<span>${n}/${B.length}</span><span style="color:var(--cut)">컷 ${c.cut}</span>`+
    `<span style="color:var(--act)">행동 ${c.action}</span>`+
    `<span style="color:var(--sam)">같은씬 ${c.samescene}</span>`+
    `<span style="color:var(--no)">오탐 ${c.no}</span>`+
    `<span style="color:var(--hold)">보류 ${c.hold}</span>`;
  document.getElementById('missed').textContent=MISS.length?`추가한 경계 ${MISS.length}개`:'';
}
function mark(k){S[i]=k;save();if(k!=='no'){delete WHY[i];go(1);}else render();}
function setWhy(w){WHY[i]=w;save();render();}
function nudge(d){ if(d===null)delete ADJ[i]; else ADJ[i]=Math.round(((ADJ[i]||0)+d)*10)/10; save(); render(); loop(); }
function go(d){const n=i+d;if(n>=0&&n<B.length){i=n;render();loop();}}
function jump(k){i=k;render();loop();}
function nextUndone(){for(let k=0;k<B.length;k++)if(!S[k]){i=k;render();loop();return;}alert('전부 판정했습니다');}
function seek(t){stopLoop();v.currentTime=Math.max(0,t);v.play();}
let lt=null;
function loop(){
  const t=T(i), a=Math.max(0,t-3), b=Math.min(DUR,t+3);
  stopLoop(); v.currentTime=a; v.play();
  lt=setInterval(()=>{ if(v.currentTime>=b) v.currentTime=a; },120);
}
function stopLoop(){ if(lt){clearInterval(lt);lt=null;} v.pause(); }

/* 프레임 단위 이동. 반드시 **일시정지 상태**여야 정확히 멈춘다 —
   재생 중에 currentTime 을 건드리면 곧바로 흘러가 버린다. */
const FR = 1/FPS;
function step(n){ stopLoop(); v.currentTime = Math.max(0, Math.min(DUR, v.currentTime + n*FR)); }

/* 지금 보고 있는 프레임을 경계로 확정. 필름스트립을 못 따라오게 하는 대신
   **영상이 근거**가 된다 — 이게 정밀 조정의 정답 경로다. */
function setHere(){
  const d = Math.round((v.currentTime - B[i].t)*1000)/1000;
  if (Math.abs(d) > 10 && !confirm(`원 경계에서 ${d.toFixed(2)}초 떨어져 있습니다. 맞습니까?`)) return;
  ADJ[i]=d; save(); render();
}
v.addEventListener('timeupdate',()=>{
  document.getElementById('ptime').textContent=fmt(v.currentTime);
  const fd=document.getElementById('fdelta');
  if(fd){ const d=v.currentTime-T(i);
    fd.innerHTML = `<span style="color:${Math.abs(d)<FR*1.5?'var(--cut)':'var(--mut)'}">`
      + `${d>=0?'+':''}${d.toFixed(3)}s (${(d/FR>=0?'+':'')}${Math.round(d/FR)}f)</span>`; }
});
function curT(){document.getElementById('mt').value=v.currentTime.toFixed(2);}
function addMissed(k){const t=parseFloat(document.getElementById('mt').value);
  if(isNaN(t)){alert('초를 입력하세요');return;} MISS.push({t:t,kind:k});save();stats();}
function reset(){S={};ADJ={};WHY={};MISS=[];save();i=0;render();}
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  const m={'1':'cut','2':'action','3':'samescene','4':'no','5':'hold'};
  if(m[e.key]){e.preventDefault();mark(m[e.key]);return;}
  if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}
  if(e.key==='ArrowRight'){e.preventDefault();go(1);}
  if(e.key===' '){e.preventDefault();lt?stopLoop():loop();}
  if(e.key==='['){e.preventDefault();nudge(e.shiftKey?-0.5:-0.1);}
  if(e.key===']'){e.preventDefault();nudge(e.shiftKey?0.5:0.1);}
  // 영상 편집기 관례 — , . 프레임 이동, Enter 로 현재 위치를 경계로 확정
  if(e.key===','){e.preventDefault();step(e.shiftKey?-5:-1);}
  if(e.key==='.'){e.preventDefault();step(e.shiftKey?5:1);}
  if(e.key==='Enter'){e.preventDefault();setHere();}
});
/* NIA 학습 스키마(trigger_info) — prepare_dataset.py / build-dataset.py 가 그대로 읽는다.
   경계 미세조정(ADJ)이 반영된 시각으로 내보낸다. */
function exportJSON(){
  const cut=[],act=[];
  // 'samescene'(리버스샷 등)은 **change_shot 에만** 넣는다 — 컷은 맞지만 씬/이벤트
  // 경계는 아니라서다. 오탐으로 버리면 "컷이 아니다"라는 틀린 라벨을 가르치게 된다.
  B.forEach((b,k)=>{const t=T(k);
    if(S[k]==='cut'){cut.push(t);act.push(t);}      // 씬전환 컷 = shot O · event O
    else if(S[k]==='action'){act.push(t);}          // 무컷 행동전환 = event 만
    else if(S[k]==='samescene'){cut.push(t);}       // 리버스샷 = shot 만
  });
  MISS.forEach(m=>(m.kind==='cut'?cut:act).push(m.t));
  const ts=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${(s%60).toFixed(3).padStart(6,'0')}`;
  const whyCount={}; Object.values(WHY).forEach(w=>whyCount[w]=(whyCount[w]||0)+1);
  const doc={video_name:NAME,duration:DUR,frame_rate:FPS,total_frame:Math.round(DUR*FPS),
    f1_consis:1.0,f1_consis_avg:1.0,
    trigger_info:[{trigger:'Change due to cut',timestamps:cut.sort((a,b)=>a-b).map(ts)},
                  {trigger:'Change of action',timestamps:act.sort((a,b)=>a-b).map(ts)}],
    _review:{labeled:Object.keys(S).length,total:B.length,
             rejected:Object.values(S).filter(x=>x==='no').length,
             same_scene:Object.values(S).filter(x=>x==='samescene').length,
             held:Object.values(S).filter(x=>x==='hold').length,
             nudged:Object.keys(ADJ).length,missed_added:MISS.length,
             reject_reasons:whyCount}};
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}));
  a.download=NAME.replace(/\.[^.]+$/,'')+'.labeled.json'; a.click();
}
render(); nextUndone();
</script>
"""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="GEBD 경계 검수·라벨링 UI")
    ap.add_argument("--video", required=True)
    ap.add_argument("--boundaries", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--refined", help="refined.json — 대사를 같이 보여준다(행동전환 판정의 핵심)")
    a = ap.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    from core.boundaries import load_boundaries, dedup_boundaries

    dur, fps = probe(a.video)
    bs = dedup_boundaries(load_boundaries(a.boundaries), duration=dur or 1e9)
    if not bs:
        print("경계가 없습니다", file=sys.stderr)
        return 2
    subs = load_refined(a.refined)

    out = Path(a.out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    total = len(bs) * len(OFFSETS)
    print(f"[label] {len(bs)} 경계 × {len(OFFSETS)}장 = {total}장 추출 · 자막 {len(subs)}줄")
    done = 0
    for k, b in enumerate(bs):
        t = float(b["t"])
        for j, o in enumerate(OFFSETS):
            if grab(a.video, t + o, out / "frames" / f"b{k}_{j}.jpg"):
                done += 1
        if (k + 1) % 25 == 0:
            print(f"  {k+1}/{len(bs)}")

    try:
        src = Path(a.video).resolve().as_uri()
    except Exception:
        src = a.video
    html = (HTML
            .replace("__NAME__", Path(a.video).name)
            .replace("__VIDEO__", src)
            .replace("__NAMEJSON__", json.dumps(Path(a.video).name, ensure_ascii=False))
            .replace("__DUR__", str(round(dur, 3)))
            .replace("__FPS__", str(fps))
            .replace("__OFFSETS__", json.dumps(OFFSETS))
            .replace("__SUBS__", json.dumps(subs, ensure_ascii=False))
            .replace("__BOUNDARIES__", json.dumps(
                [{"t": round(float(b["t"]), 3), "score": b.get("score"),
                  "grade": b.get("grade"), "kind": b.get("kind")} for b in bs],
                ensure_ascii=False)))
    (out / "label.html").write_text(html, encoding="utf-8")
    print(f"[label] → {out/'label.html'}  (프레임 {done}/{total})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

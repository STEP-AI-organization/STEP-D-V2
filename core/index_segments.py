"""
STEP D Core — 검색 세그먼트 인덱서 (search segment indexer)

자연어 검색엔진의 **인덱스 단위**를 만든다. 새 파이프라인이 아니라, content.analyze가
이미 뱉어 놓은 체크포인트들을 읽어 "잘라서 바로 쓸 수 있는 구간" 레코드로 재조립할 뿐이다.
(설계 원칙: 검색을 별도 시스템으로 만들지 않고 파이프라인 부산물로 나오게 한다.)

검색 단위 = **beat** (core.beats 산출물). 영상 전체를 덮는 최소 완결 편집 단위라,
쇼츠(터지는 구간)만 인덱싱할 때 생기는 편향이 없다. 쇼츠 클립은 beat 중 일부에
`is_short` 플래그가 붙은 것으로 취급한다.

입력 (media workdir 안의 체크포인트, 없는 건 건너뜀):
  beats.json       검색 단위 (id·start·end·title·summary·characters·hook·is_complete)
  refined.json     화자 붙은 대사 (start·end·text·speaker) → dialogue 슬라이스
  narrative.json   블록별 서사 요약 → beat 요약 비면 보충
  scene_type.json  shot별 장면유형 (interview/on_scene/other) → scene_type 필터
  cast.json        인물 등장 구간 → characters 보강 (얼굴/화자 근거)
  chyron.json      화면 이름 태그 감지 [{time, names}] → characters·chyron 텍스트
                   (chyron per-seg 스테이지가 씀 · RUN_CHYRON_PER_SEG=0 이면 없음)
  shorts.json      쇼츠 추천 → is_short 플래그 · highlight_score 보정

출력: segments.json = { media_id, genre, count, segments: [ <세그먼트 레코드> ] }
  임베딩(emb_dialogue·emb_summary)과 pgvector 적재는 다음 단계에서 채운다 — 여기선 null.
  권리/스포일러(rights)와 스코프(scope)는 아직 파이프라인에 신호가 없어 placeholder.

Run:
    python -m core.index_segments <workdir> [--media <id>] [--genre variety] [--out segments.json]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


# ── 로딩 헬퍼 ────────────────────────────────────────────────────────────────
def _load(path: Path) -> Optional[object]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _as_list(obj: object, *keys: str) -> list:
    """list면 그대로, dict면 keys 중 첫 리스트를 반환. 아니면 빈 리스트."""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in keys:
            v = obj.get(k)
            if isinstance(v, list):
                return v
    return []


# ── 구간 계산 ────────────────────────────────────────────────────────────────
def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    """두 구간 [a0,a1]·[b0,b1] 겹침 길이(초). 안 겹치면 0."""
    return max(0.0, min(a1, b1) - max(a0, b0))


def _f(x: object, default: float = 0.0) -> float:
    try:
        return float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


# ── 필드 추출기 ──────────────────────────────────────────────────────────────
def _dialogue_slice(refined: list, start: float, end: float) -> tuple[str, list[str]]:
    """구간에 겹치는 대사를 순서대로 이어붙인다. 화자가 있으면 '이름: 대사'.
    반환: (대사 텍스트, 등장 화자 리스트)."""
    lines: list[str] = []
    speakers: list[str] = []
    for s in refined:
        st, en = _f(s.get("start")), _f(s.get("end"))
        if _overlap(st, en, start, end) <= 0:
            continue
        text = (s.get("text") or "").strip()
        if not text:
            continue
        spk = (s.get("speaker") or "").strip()
        if spk:
            if spk not in speakers:
                speakers.append(spk)
            lines.append(f"{spk}: {text}")
        else:
            lines.append(text)
    return " ".join(lines).strip(), speakers


def _scene_type_at(labels: list, start: float, end: float) -> Optional[str]:
    """구간과 가장 많이 겹치는 shot의 장면유형. 겹치는 게 없으면 None."""
    best_type: Optional[str] = None
    best_ov = 0.0
    for lb in labels:
        ov = _overlap(_f(lb.get("start")), _f(lb.get("end")), start, end)
        if ov > best_ov:
            best_ov, best_type = ov, (lb.get("type") or None)
    return best_type


def _cast_in_window(cast: list, start: float, end: float) -> list[str]:
    """등장 구간이 이 구간과 겹치는 인물 이름 (얼굴/화자 근거). 순서 유지."""
    names: list[str] = []
    for p in cast:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        for ap in (p.get("appearances") or []):
            if _overlap(_f(ap.get("start")), _f(ap.get("end")), start, end) > 0:
                if name not in names:
                    names.append(name)
                break
    return names


def _chyron_in_window(chyron: list, start: float, end: float) -> list[str]:
    """구간 안에서 자막 CG로 감지된 이름들 (중복 제거)."""
    names: list[str] = []
    for hit in chyron:
        t = _f(hit.get("time"))
        if start <= t <= end:
            for n in (hit.get("names") or []):
                n = str(n).strip()
                if n and n not in names:
                    names.append(n)
    return names


def _narrative_summary_at(nsegs: list, start: float, end: float) -> str:
    """구간과 가장 많이 겹치는 서사 블록의 요약. beat.summary가 빌 때 보충용."""
    best_sum, best_ov = "", 0.0
    for b in nsegs:
        ov = _overlap(_f(b.get("start")), _f(b.get("end")), start, end)
        if ov > best_ov:
            best_ov, best_sum = ov, (b.get("summary") or "")
    return best_sum.strip()


def _short_overlap(shorts: list, start: float, end: float) -> tuple[bool, float]:
    """쇼츠 추천 구간과 겹치면 (True, 최고 appeal 0..5). 안 겹치면 (False, 0)."""
    is_short, best_appeal = False, 0.0
    for sh in shorts:
        if _overlap(_f(sh.get("start")), _f(sh.get("end")), start, end) > 0:
            is_short = True
            best_appeal = max(best_appeal, _f(sh.get("appeal")))
    return is_short, best_appeal


# hook → 기본 하이라이트 점수 proxy. 쇼츠에 안 걸린 구간의 하한값.
_HOOK_BASE = {
    "반전": 0.6, "감정고조": 0.55, "돌직구": 0.55, "갈등": 0.55,
    "웃음": 0.5, "질문": 0.4, "공감": 0.4, "정보성": 0.3, "정보": 0.3,
    "기타": 0.2, "": 0.2,
}


def _highlight_score(beat: dict, is_short: bool, appeal: float) -> float:
    """하이라이트 스코어 proxy (0..1). 쇼츠에 걸렸으면 appeal(0..5)을 우선,
    아니면 hook 기반 하한. 진짜 학습 스코어는 검색·선택 로그가 쌓인 뒤에 대체한다."""
    if is_short and appeal > 0:
        return round(min(1.0, appeal / 5.0), 3)
    hook = (beat.get("hook") or "").strip()
    base = _HOOK_BASE.get(hook, 0.25)
    if not beat.get("is_complete", True):
        base *= 0.7  # 완결 안 된 파편은 감점
    return round(base, 3)


def _dedup(*lists: list[str]) -> list[str]:
    out: list[str] = []
    for lst in lists:
        for x in (lst or []):
            x = str(x).strip()
            if x and x not in out:
                out.append(x)
    return out


# 익명 화자 라벨 — 인물 필터에 들어가면 안 된다 (S1, SPEAKER_00, 발화자 3, 화자2 …).
_ANON_LABEL = re.compile(r"^(?:S\d+|SPEAKER[_\s]?\d+|발화자\s*\d*|화자\s*\d*|Speaker\s*\d*)$", re.I)
# 실명 후보 — 한글 2자 이상(공백·가운뎃점 허용). analyze_stages 의 _KOREAN_NAME 과 같은 기준.
_REAL_NAME = re.compile(r"^[가-힯][가-힯\s·]{1,}$")


def _real_names(labels: list[str]) -> list[str]:
    """화자 라벨 중 실명으로 볼 수 있는 것만. 익명 라벨(S1·SPEAKER_00·발화자 N)은 버린다.

    chyron per-seg 가 화면 이름 태그로 speaker 를 실명 rewrite 하는데, 그 결과가 speakers
    에만 남고 characters 에 못 오르면 검색 인물 필터(characters @> [...])와 쿼리 파서
    roster 가 그 이름을 영영 못 본다. 여기서 끌어올린다.
    """
    out: list[str] = []
    for lb in (labels or []):
        n = str(lb).strip()
        if not n or _ANON_LABEL.match(n) or not _REAL_NAME.match(n):
            continue
        if n not in out:
            out.append(n)
    return out


# ── 메인 ─────────────────────────────────────────────────────────────────────
def _fill_embeddings(segments: list[dict]) -> None:
    """emb_dialogue·emb_summary를 채운다 (core.embed 백엔드). 대사·요약을 각각
    별도 벡터로 — 한 세그먼트에 벡터 하나만 두면 대사·장소·감정이 뭉개진다(설계 §2.1)."""
    from .embed import embed_texts
    dia = embed_texts([s.get("dialogue") or "" for s in segments])
    summ = embed_texts([s.get("summary") or "" for s in segments])
    for s, d, m in zip(segments, dia, summ):
        s["emb_dialogue"] = d
        s["emb_summary"] = m


def build_segments(workdir: str | Path, media_id: str = "",
                   genre: str = "", embed: bool = False) -> dict:
    wd = Path(workdir)
    beats = _as_list(_load(wd / "beats.json"), "beats")
    if not beats:
        return {"media_id": media_id, "genre": genre, "count": 0, "segments": [],
                "note": "beats.json 없음 — 검색 세그먼트를 만들 수 없다 (beat이 검색 단위)"}

    refined = _as_list(_load(wd / "refined.json"), "segments", "refined")
    narrative = _load(wd / "narrative.json")
    nsegs = _as_list(narrative, "segments") if narrative else []
    scene_labels = _as_list(_load(wd / "scene_type.json"), "labels", "segments")
    cast = _as_list(_load(wd / "cast.json"), "people")
    chyron = _as_list(_load(wd / "chyron.json"), "hits")
    shorts_obj = _load(wd / "shorts.json")
    shorts = _as_list(shorts_obj, "shorts")
    if not genre and isinstance(shorts_obj, dict):
        genre = str(shorts_obj.get("genre") or "")

    segments: list[dict] = []
    for beat in beats:
        start, end = _f(beat.get("start")), _f(beat.get("end"))
        if end <= start:
            continue
        bid = beat.get("id")

        dialogue, speakers = _dialogue_slice(refined, start, end)
        chyron_names = _chyron_in_window(chyron, start, end)
        # 인물 = beat 판정 + cast 등장구간 + 화면자막 이름 + 실명 화자.
        # 마지막 항이 없으면 chyron 이 실명을 찾아도 인물 필터가 못 쓴다(speakers 는 필터 대상 아님).
        characters = _dedup(beat.get("characters"),
                            _cast_in_window(cast, start, end),
                            chyron_names,
                            _real_names(speakers))
        summary = (beat.get("summary") or "").strip() or _narrative_summary_at(nsegs, start, end)
        is_short, appeal = _short_overlap(shorts, start, end)

        segments.append({
            "segment_id": f"{media_id}#b{bid}" if media_id else f"b{bid}",
            "media_id": media_id,
            "genre": genre,
            "source_beat": bid,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            # 인물 (구조 필터 — 벡터에 녹이지 않는다)
            "characters": characters,
            "speakers": speakers,
            # 분류
            "scene_type": _scene_type_at(scene_labels, start, end),
            "hook": (beat.get("hook") or "").strip(),
            "highlight_score": _highlight_score(beat, is_short, appeal),
            "is_short": is_short,
            # 권리·스포일러 (아직 파이프라인 신호 없음 — 검색 결과에 상태를 달려면 채워야 함)
            "rights": {"cast_ok": None, "music_cleared": None, "ppl": None, "spoiler": None},
            # 스코프 (기수/시즌 — 온보딩 설정에서 주입 예정)
            "scope": {"scope_type": None, "scope_id": None, "episode": None, "aired_at": None},
            # 텍스트 레이어 (검색의 실질 8할)
            "dialogue": dialogue,
            "chyron": " ".join(chyron_names),
            "summary": summary,
            # 벡터 (다음 슬라이스에서 채움)
            "emb_dialogue": None,
            "emb_summary": None,
        })

    if embed and segments:
        _fill_embeddings(segments)

    return {"media_id": media_id, "genre": genre, "count": len(segments),
            "segments": segments}


def _main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    workdir = argv[0]
    media_id, genre, out = "", "", ""
    embed = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--media" and i + 1 < len(argv):
            media_id = argv[i + 1]; i += 2
        elif a == "--genre" and i + 1 < len(argv):
            genre = argv[i + 1]; i += 2
        elif a == "--out" and i + 1 < len(argv):
            out = argv[i + 1]; i += 2
        elif a == "--embed":
            embed = True; i += 1
        else:
            i += 1

    result = build_segments(workdir, media_id=media_id, genre=genre, embed=embed)
    out_path = Path(out) if out else Path(workdir) / "segments.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[index_segments] {result['count']} 세그먼트 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))

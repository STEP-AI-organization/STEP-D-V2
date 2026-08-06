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


def _llm_prior(beat: dict, is_short: bool, appeal: float) -> float:
    """LLM 판단에서 온 사전확률 (0..1). 쇼츠에 걸렸으면 appeal, 아니면 hook 상수."""
    if is_short and appeal > 0:
        return round(min(1.0, appeal / 5.0), 3)
    hook = (beat.get("hook") or "").strip()
    base = _HOOK_BASE.get(hook, 0.25)
    if not beat.get("is_complete", True):
        base *= 0.7  # 완결 안 된 파편은 감점
    return round(base, 3)


# 저수준 신호 보정 계수. **작게 시작한다** — LLM 판단을 신호로 덮는 게 아니라 보정만 한다.
# 실측(m_981d7c08): 쇼츠 채택/미채택의 audio_pct 중앙값이 0.525/0.475 로 거의 안 갈렸다.
# 즉 단독 예측력은 약하고 정보축으로는 새롭다 → 큰 계수를 줄 근거가 없다.
_W_AUDIO = 0.12      # 구간 에너지 (회차 내 백분위)
_W_DELTA = 0.08      # 순간 상승폭 — 웃음·환호·고성
_W_DENSITY = 0.06    # 대사 밀도
_W_CUT = 0.06        # 컷 속도


def _pct_ranks(values: list[float | None]) -> list[float | None]:
    """회차 내 백분위(0..1). None 은 None 유지. 절대값은 회차마다 스케일이 달라 못 쓴다."""
    idx = [i for i, v in enumerate(values) if isinstance(v, (int, float))]
    out: list[float | None] = [None] * len(values)
    if not idx:
        return out
    order = sorted(idx, key=lambda i: float(values[i]))  # type: ignore[arg-type]
    n = len(order)
    for rank, i in enumerate(order):
        out[i] = round(rank / max(1, n - 1), 4) if n > 1 else 0.5
    return out


def _apply_highlight_scores(segments: list[dict]) -> None:
    """`highlight_score` 를 **LLM 독립 신호로 보정**해 채운다 (in-place).

    왜 필요한가: 원래 점수는 순환 정의였다 — 쇼츠에 걸렸으면 `appeal/5`, 아니면 `hook`
    문자열 상수 lookup. 즉 **LLM 이 이미 쇼츠로 고른 구간만 점수가 높다.** 그러면
    "쇼츠 후보가 아닌데 좋은 구간"을 이 점수로는 영원히 못 찾는다 — 아카이브 재활용·
    다회차 하이라이트가 정확히 그 질의인데도.

    `core.signals` 는 LLM 이 뭘 골랐든 무관하게 계산되므로 그 순환을 깰 수 있는 유일한
    재료다. 다만 **덮지 않고 보정만** 한다(계수 0.06~0.12):

        score = clamp( llm_prior × (1 + Σ w·(signal_pct - 0.5)×2) )

    signal_pct 를 0.5 중심으로 대칭 이동해서, 평균적인 구간은 보정 0 · 상위는 가점 ·
    하위는 감점이 된다. 최대 보정폭은 ±32%.

    `highlight_parts` 로 근거를 남긴다 — 점수만 있으면 왜 그렇게 나왔는지 못 따진다.
    """
    if not segments:
        return
    # cut_rate·dialogue_density 는 절대값이라 회차 내 백분위로 바꾼다.
    # audio_pct 는 core.signals 가 이미 백분위로 준다.
    cut = _pct_ranks([(s.get("signals") or {}).get("cut_rate") for s in segments])
    den = _pct_ranks([(s.get("signals") or {}).get("dialogue_density") for s in segments])
    dlt = _pct_ranks([(s.get("signals") or {}).get("audio_delta") for s in segments])

    for i, s in enumerate(segments):
        prior = float(s.get("highlight_score") or 0.0)
        sig = s.get("signals") or {}
        terms: dict[str, float] = {}
        def _add(name: str, pct, w: float) -> None:
            if isinstance(pct, (int, float)):
                terms[name] = round(w * (float(pct) - 0.5) * 2.0, 4)
        _add("audio", sig.get("audio_pct"), _W_AUDIO)
        _add("delta", dlt[i], _W_DELTA)
        _add("density", den[i], _W_DENSITY)
        _add("cut", cut[i], _W_CUT)

        if not terms:
            s["highlight_parts"] = {"llm_prior": prior, "signal_adj": 0.0, "note": "signals 없음"}
            s["signal_score"] = None
            continue
        adj = sum(terms.values())
        s["highlight_score"] = round(max(0.0, min(1.0, prior * (1.0 + adj))), 4)
        s["highlight_parts"] = {"llm_prior": prior, "signal_adj": round(adj, 4), **terms}

        # ── signal_score — **LLM 을 전혀 안 쓴 독립 점수** (0..1) ────────────────
        # highlight_score 의 보정만으로는 순환이 안 깨진다(실측: 상위 20 이 전부 쇼츠 채택분).
        # 순환은 보정이 아니라 **prior** 에 있기 때문이다 — 채택은 appeal/5(≤0.8), 미채택은
        # hook 상수(≤0.6)라 ±32% 곱셈으로는 순위가 안 뒤집힌다. 계수를 키우면 뒤집히지만
        # audio_pct 의 단독 예측력이 약하다는 실측(채택/미채택 중앙값 0.525/0.475)이 그걸
        # 정당화하지 않는다 — 근거 없이 키우면 노이즈로 순위를 흔드는 것뿐이다.
        #
        # 그래서 덮어쓰는 대신 **축을 하나 더 낸다.** "쇼츠 후보가 아닌데 좋은 구간"을 찾는
        # 질의(아카이브 재활용·다회차 하이라이트)는 이 축으로 정렬하면 된다.
        # 가중치는 highlight 보정과 같은 비율을 쓰되 0.5 중심 이동 없이 그대로 합산한다.
        # ⚠️ 한계 (실측 2026-08-06): 이 축은 "오디오가 큰 구간"을 올린다. 드라마 상위에
        # **엔딩 크레딧**(음악 큼)이 0.859 로 올라왔다. 즉 **발견용 보조축**이지 그 자체로
        # 하이라이트 랭킹이 아니다. 정렬 기본값으로 쓰지 말고, highlight_score 로 못 찾는
        # 후보를 캐내는 용도로만 쓸 것. 음악·크레딧 구간 배제는 별도 신호가 필요하다.
        pcts = [(sig.get("audio_pct"), _W_AUDIO), (dlt[i], _W_DELTA),
                (den[i], _W_DENSITY), (cut[i], _W_CUT)]
        num = sum(w * float(p) for p, w in pcts if isinstance(p, (int, float)))
        wsum = sum(w for p, w in pcts if isinstance(p, (int, float)))
        s["signal_score"] = round(num / wsum, 4) if wsum else None


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
    """실명으로 볼 수 있는 라벨만. 익명 화자 라벨(S1·SPEAKER_00·발화자 N)은 버린다.

    **characters 로 들어가는 모든 소스에 적용한다** — beat.characters·cast·chyron·speakers.
    실측(m_981d7c08, 2026-08-06): beat_annot 이 characters 에 화자 라벨을 그대로 넣어서
    63개 인물이 전부 `발화자 N` 이었다. 그 상태의 characters 는
      · 인물 필터(`characters @> '["영철"]'`)를 쓸모없게 만들고
      · listKnownCharacters() 로 뽑는 쿼리 파서 roster 에 `발화자 6` 을 인물 후보로 올린다
    익명 라벨은 speakers 컬럼에 그대로 남으니 정보가 사라지는 게 아니라, **인물 필터축에서만
    빠진다.** 비어 있는 편이 노이즈로 차 있는 것보다 낫다("모른다"가 정직한 상태).
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
    # ⚠️ writer(analyze_stages.run_scene_type)가 쓰는 키는 "shot_types" 다. 이걸 빼먹으면
    # 파일이 있어도 항상 [] 라서 scene_type 이 전부 None 이 되고, /api/search 의 장면유형
    # 필터(인터뷰·현장)가 늘 0건이 된다 — Vision 비용만 쓰고 버리는 상태. (2026-08-06)
    scene_labels = _as_list(_load(wd / "scene_type.json"), "shot_types", "labels", "segments")
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
        # 인물 = beat 판정 + cast 등장구간 + 화면자막 이름 + 화자 라벨. 단 **전부 실명 필터를
        # 통과한 것만** — 익명 라벨이 섞이면 인물 필터도 쿼리파서 roster 도 무의미해진다.
        # 익명 라벨은 바로 아래 speakers 컬럼에 그대로 남는다.
        characters = _real_names(_dedup(beat.get("characters"),
                                        _cast_in_window(cast, start, end),
                                        chyron_names,
                                        speakers))
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
            # LLM 사전확률만 먼저 넣고, 전 세그먼트가 모인 뒤 _apply_highlight_scores 가
            # 회차 내 백분위로 신호 보정한다(백분위는 전체를 봐야 계산된다).
            "highlight_score": _llm_prior(beat, is_short, appeal),
            "highlight_parts": None,
            # LLM 을 전혀 안 쓴 독립 점수 — "쇼츠 후보가 아닌데 좋은 구간" 찾기용
            "signal_score": None,
            "is_short": is_short,
            # 저수준 신호 (core.signals · run_beat_signals 가 beats.json 에 병합해 둔 것).
            # **LLM 의 쇼츠 선택과 독립으로 계산된 유일한 축** — highlight_score 의 순환
            # 정의를 깨는 재료다. 없으면 None(구버전 beats.json 하위호환).
            "signals": beat.get("signals") or None,
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

    # 신호 보정은 전 세그먼트가 모인 뒤에 (회차 내 백분위라 전체가 필요)
    _apply_highlight_scores(segments)

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

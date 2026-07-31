"""화면 자막(chyron) → STT speaker 전역 rename.

원칙 (사용자 2026-07-31):
- 화자N (STT diarization 익명 라벨) 을 화면에 노출된 실명(고유명사) 으로 rewrite
- rewrite 결과 refined.json·narrative.json·beats.json 다 update → 다음 분석·프론트/편집기 자동 반영
- program.cast 등록 인물 우선 매칭 · 등록 밖 이름은 flag (변경 X, 사용자 검토용)

동작:
1. `build_speaker_mapping(beats, cast_registry)`
   - 각 beat 의 `characters` (dominant STT speaker) ↔ `characters_visible` (Vision 감지 실명) 짝 수집
   - vote count · 최빈 매핑 확정 (여러 beat 에서 같은 화자N 이 다른 이름으로 잡히면 최빈)
   - program.cast (등록 인물) 안 이름만 확정 · 밖은 신중히 flag 만
2. `apply_speaker_mapping(mapping, refined, narrative, beats)`
   - 세 dict/list 를 in-place 로 rewrite

호출: analyze.py 의 beat_annot stage 뒤 · refined.json/narrative.json/beats.json 저장 후.
"""
from __future__ import annotations

from collections import Counter, defaultdict


ANON_PREFIX = ("화자", "발화자", "SPK", "SPEAKER", "Unknown", "?", "M", "F")


def _is_anon(name: str) -> bool:
    """화자N/SPK1/M1/F2 등 익명 라벨 여부."""
    if not name or not isinstance(name, str):
        return False
    n = name.strip()
    if not n:
        return False
    return any(n.startswith(p) for p in ANON_PREFIX)


def _in_registry(name: str, cast_registry: list[dict] | list[str] | None) -> bool:
    if not cast_registry:
        return False
    for c in cast_registry:
        if isinstance(c, dict):
            names = [c.get("name"), *(c.get("aliases") or [])]
        else:
            names = [c]
        for n in names:
            if n and str(n).strip() == name.strip():
                return True
    return False


def build_speaker_mapping(
    beats: list[dict],
    cast_registry: list[dict] | list[str] | None = None,
) -> tuple[dict[str, str], list[str]]:
    """각 beat 에서 (dominant STT speaker → visible 실명) 후보 수집 · 최빈 확정.

    반환:
      mapping: {anon_speaker → real_name}  · 확정된 것만 (등록 인물 매칭)
      flagged: [unregistered_name, ...]     · 자막에는 있으나 cast_registry 미등록 (사용자 검토용)
    """
    votes: dict[str, Counter] = defaultdict(Counter)
    all_visible: set[str] = set()

    for b in beats or []:
        chars = b.get("characters") or []
        visible = b.get("characters_visible") or []
        # dominant STT speaker (가장 비중 큰 것 하나 = characters[0])
        dominant = None
        for c in chars:
            if isinstance(c, str) and _is_anon(c):
                dominant = c.strip(); break
        if not dominant:
            continue
        # visible 안 이름 후보: 익명 라벨 (화자·SPK·M1) 아니고 · 실명 형태
        for v in visible:
            if not isinstance(v, str):
                continue
            name = v.strip()
            if not name or _is_anon(name):
                continue
            # 직업·부가 표기 제거 (예: "한의사 원규" → "원규" 만 남기려면 별도 로직 · 여기선 원문 그대로)
            all_visible.add(name)
            votes[dominant][name] += 1

    mapping: dict[str, str] = {}
    for anon, cnt in votes.items():
        # 최빈 후보 (동률이면 첫 번째)
        best_name, best_count = cnt.most_common(1)[0]
        if best_count < 1:
            continue
        # 등록 인물이면 확정 · 아니면 flag 만 (rewrite X)
        if _in_registry(best_name, cast_registry):
            mapping[anon] = best_name

    flagged = sorted([n for n in all_visible if not _in_registry(n, cast_registry)])
    return mapping, flagged


def _rewrite_speaker_field(items: list[dict], mapping: dict[str, str],
                             key: str = "speaker") -> int:
    """items (list of dict) 안 key 값을 mapping 으로 in-place rewrite. 변경 개수 반환."""
    n = 0
    for it in items or []:
        if not isinstance(it, dict):
            continue
        v = it.get(key)
        if isinstance(v, str) and v in mapping:
            it[key] = mapping[v]
            n += 1
    return n


def assign_speakers_from_captions(
    beats: list[dict],
    refined: list[dict],
    cast_registry: list[dict] | list[str] | None,
) -> int:
    """STT diarization 이 speaker 안 붙였을 때 (모두 빈값) · 화면 자막 실명으로 강제 부여.

    beat 안 characters_visible 에서 cast_registry 매칭 첫 번째 이름 →
    beat.start ~ end 안 refined segments 의 speaker 로 in-place set.
    반환: 부여한 segment 개수.
    """
    if not beats or not refined:
        return 0
    n = 0
    for b in beats:
        st = float(b.get("start", 0)); en = float(b.get("end", 0))
        if en <= st:
            continue
        visible = b.get("characters_visible") or []
        # cast_registry 매칭 첫 번째
        name = None
        for v in visible:
            if isinstance(v, str) and _in_registry(v.strip(), cast_registry):
                name = v.strip(); break
        if not name:
            continue
        # 이 beat 구간 안 refined utterance 에 speaker 부여
        for seg in refined:
            try:
                sst = float(seg.get("start", 0)); sen = float(seg.get("end", 0))
            except (TypeError, ValueError):
                continue
            if sen <= st or sst >= en:
                continue
            # 이미 실명 붙어있으면 유지 (덮어쓰지 X)
            existing = (seg.get("speaker") or "").strip()
            if existing and _in_registry(existing, cast_registry):
                continue
            seg["speaker"] = name; n += 1
    return n


def apply_speaker_mapping(
    mapping: dict[str, str],
    refined: list[dict] | None,
    narrative: dict | None,
    beats: list[dict] | None,
) -> dict[str, int]:
    """세 산출물에 매핑 in-place 적용. 반환: 각 파일 변경 개수."""
    counts = {"refined": 0, "narrative_chars": 0, "beats_chars": 0}

    # 1) refined.json (STT segments) speaker rewrite
    if isinstance(refined, list):
        counts["refined"] = _rewrite_speaker_field(refined, mapping, "speaker")

    # 2) narrative.json · segments[].characters · characters (top-level) rewrite
    if isinstance(narrative, dict):
        n_chars = 0
        # top-level characters
        for c in narrative.get("characters", []) or []:
            if isinstance(c, dict) and c.get("name") in mapping:
                c["name"] = mapping[c["name"]]; n_chars += 1
        for seg in narrative.get("segments", []) or []:
            if isinstance(seg, dict) and isinstance(seg.get("characters"), list):
                new_list = [mapping.get(x, x) if isinstance(x, str) else x for x in seg["characters"]]
                if new_list != seg["characters"]:
                    seg["characters"] = new_list; n_chars += 1
        for conf in narrative.get("key_conflicts", []) or []:
            if isinstance(conf, dict) and isinstance(conf.get("participants"), list):
                conf["participants"] = [mapping.get(x, x) if isinstance(x, str) else x
                                          for x in conf["participants"]]
        counts["narrative_chars"] = n_chars

    # 3) beats.json · beat.characters (dominant speaker list) rewrite
    if isinstance(beats, list):
        b_chars = 0
        for b in beats:
            if isinstance(b, dict) and isinstance(b.get("characters"), list):
                new_list = [mapping.get(x, x) if isinstance(x, str) else x for x in b["characters"]]
                if new_list != b["characters"]:
                    b["characters"] = new_list; b_chars += 1
        counts["beats_chars"] = b_chars

    return counts

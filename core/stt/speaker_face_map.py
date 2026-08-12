"""
STEP D Core — Speaker (audio) ↔ Face cluster (visual) cross-mapping

PyAnnote 3.1 diarization은 오디오 화자를 SPEAKER_00·01·... 로 나눔.
faces.py 얼굴 클러스터는 F1·F2·M1·... 로 나눔.
두 개는 같은 사람인데 다른 소스 · 같은 시간대에 겹치면 같은 인물.

이 모듈: 두 시간대 매트릭스 → speaker ↔ face cluster 매핑 반환.
refine.py가 실명 라벨링 시 두 소스 결합 (오디오+시각) → 정확도↑.

입력:
- diarization_turns: [{start, end, speaker}]  ← asr._diarize_audio 결과
- faces_json: faces.py 결과 (clusters.{lbl}.full_frame_segs 시각 인덱스)
- refined_segments: refined.json (seg index → start/end 시각 룩업)

출력:
- speaker_face_map: {"SPEAKER_00": "F6", "SPEAKER_01": "M1", ...}
- confidence: 매칭별 겹침 초 통계
"""
from __future__ import annotations


def _cluster_appearance_times(cluster_meta: dict, refined: list[dict]) -> list[tuple[float, float]]:
    """클러스터의 얼굴 등장 시각 구간 리스트 (초).
    faces.py는 full_frame_segs (seg index)만 저장 · seg index → refined[i].start/end 룩업.
    각 프레임 시각은 seg의 mid time 근처로 근사."""
    segs_i = cluster_meta.get("full_frame_segs") or []
    if not segs_i or not refined:
        return []
    times = []
    for i in segs_i:
        try:
            idx = int(i)
            if 0 <= idx < len(refined):
                st = float(refined[idx].get("start", 0))
                en = float(refined[idx].get("end", st + 1))
                times.append((st, en))
        except (TypeError, ValueError):
            continue
    return times


def _overlap_seconds(a: tuple[float, float], b: tuple[float, float]) -> float:
    """두 시각 구간의 겹침 초. 안 겹치면 0."""
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    return max(0.0, hi - lo)


def map_speakers_to_face_clusters(
    faces_json: dict,
    refined: list[dict],
    diarization_turns: list[dict],
) -> dict:
    """시각-오디오 매트릭스 계산 · 각 speaker에 가장 겹치는 face cluster 매핑.

    반환:
      {
        "map": {"SPEAKER_00": "F6", ...},           # 확정 매칭
        "overlap_sec": {"SPEAKER_00-F6": 45.2, ...}, # 겹침 초
        "ambiguous": ["SPEAKER_02", ...],            # 2등과 차이 작아 애매
        "unmapped_speakers": [...], "unmapped_clusters": [...]
      }
    """
    if not diarization_turns or not faces_json:
        return {"map": {}, "overlap_sec": {}, "ambiguous": [], "unmapped_speakers": [], "unmapped_clusters": []}

    clusters = (faces_json.get("clusters") or {})
    if not clusters:
        return {"map": {}, "overlap_sec": {}, "ambiguous": [], "unmapped_speakers": [], "unmapped_clusters": []}

    # 1) speaker → turn 구간 집계
    speaker_turns: dict[str, list[tuple[float, float]]] = {}
    for t in diarization_turns:
        sp = str(t.get("speaker", ""))
        if not sp:
            continue
        try:
            speaker_turns.setdefault(sp, []).append((float(t["start"]), float(t["end"])))
        except (TypeError, ValueError, KeyError):
            continue

    # 2) 각 클러스터의 등장 시각 구간
    cluster_times: dict[str, list[tuple[float, float]]] = {}
    for lbl, meta in clusters.items():
        times = _cluster_appearance_times(meta, refined)
        if times:
            cluster_times[lbl] = times

    if not speaker_turns or not cluster_times:
        return {"map": {}, "overlap_sec": {}, "ambiguous": [],
                "unmapped_speakers": list(speaker_turns.keys()),
                "unmapped_clusters": list(cluster_times.keys())}

    # 3) overlap matrix: speaker × cluster
    matrix: dict[tuple[str, str], float] = {}
    for sp, turns in speaker_turns.items():
        for lbl, times in cluster_times.items():
            total = 0.0
            for t in turns:
                for ct in times:
                    total += _overlap_seconds(t, ct)
            if total > 0:
                matrix[(sp, lbl)] = round(total, 2)

    # 4) 각 speaker에 대해 best cluster · 2등과 margin 검증
    speaker_face_map: dict[str, str] = {}
    overlap_sec: dict[str, float] = {}
    ambiguous: list[str] = []
    used_clusters: set = set()
    for sp in speaker_turns.keys():
        candidates = [(lbl, matrix.get((sp, lbl), 0.0)) for lbl in cluster_times.keys()]
        candidates.sort(key=lambda x: -x[1])
        if not candidates or candidates[0][1] <= 0:
            continue
        best_lbl, best_ov = candidates[0]
        second_ov = candidates[1][1] if len(candidates) > 1 else 0.0
        # 매칭 조건: 최소 1s 겹침 · 2등과 margin >= 30% (혼동 방지)
        if best_ov < 1.0:
            continue
        if second_ov > 0 and (best_ov - second_ov) / best_ov < 0.3:
            ambiguous.append(sp)
            continue
        # 같은 cluster에 여러 speaker 매칭되면 overlap 큰 쪽 우선
        if best_lbl in used_clusters:
            # 기존 매칭 speaker와 비교
            prev_sp = next((s for s, l in speaker_face_map.items() if l == best_lbl), None)
            if prev_sp and overlap_sec.get(f"{prev_sp}-{best_lbl}", 0) >= best_ov:
                continue
            # 새로 승리 · 이전 speaker unmapped 처리
            if prev_sp:
                del speaker_face_map[prev_sp]
                overlap_sec.pop(f"{prev_sp}-{best_lbl}", None)
        speaker_face_map[sp] = best_lbl
        overlap_sec[f"{sp}-{best_lbl}"] = best_ov
        used_clusters.add(best_lbl)

    return {
        "map": speaker_face_map,
        "overlap_sec": overlap_sec,
        "ambiguous": ambiguous,
        "unmapped_speakers": [s for s in speaker_turns.keys() if s not in speaker_face_map and s not in ambiguous],
        "unmapped_clusters": [c for c in cluster_times.keys() if c not in used_clusters],
    }

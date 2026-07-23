"""
STEP D Core — Face detection · embedding · unsupervised clustering (2026-07-22).

정밀 분석에서 refine 이후 실행. 각 자막 세그먼트 중간 시각의 프레임을 뽑아
InsightFace(SCRFD 검출 + ArcFace 임베딩)로 얼굴을 잡고, HDBSCAN으로 얼굴 임베딩을
무감독 클러스터링. 각 클러스터를 성별 기반 M1/M2/F1/F2 라벨로 부여하고,
세그먼트마다 가장 큰 얼굴(=화면 중앙, 발화자 후보)의 클러스터를 speaker로 덮어씀.

사용자가 나중에 UI(faces.json → 인물 매핑 화면)에서 "M2 = 정숙" 한 번 매핑해두면
refined[].speaker 전체가 rename. 배치 독립성 문제도 자동 해결 — 클러스터링은 전역.

Output: faces.json + face_clusters/{label}_{i}.jpg (대표 프레임 크롭 3장씩)

Model: buffalo_l ONNX (SCRFD_10G + w600k_r50). 첫 실행 시 ~200MB 자동 다운로드.
CPU 추론 기준 프레임당 ~50ms.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable, Optional

# refine.py가 M1/M2/F1/F2/MC/MC1... 익명 폴백을 붙임. 이 외 값은 실명(등록 cast 매칭 or
# Gemini가 공인·아이돌·연예인을 이미 인식한 경우) 취급 → 얼굴 클러스터로 덮어쓰지 않음.
_FALLBACK_SPEAKER = re.compile(r"^(M\d+|F\d+|MC\d*)$")


def _is_fallback_speaker(sp: str | None) -> bool:
    return bool(_FALLBACK_SPEAKER.match(sp or ""))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import cv2
import numpy as np

# insightface warm import — 첫 로드가 무거우므로 lazy singleton.
_APP = None


def _get_app():
    """FaceAnalysis 싱글턴. 첫 호출 시 모델 로드 + (없으면) 다운로드.

    GPU(CUDA) 사용 가능하면 우선 · 없으면 CPU 폴백. RTX급 GPU에서 프레임당 ~5-10ms로
    CPU 대비 100배 빠름. onnxruntime-gpu가 없거나 CUDA 초기화 실패하면 자동 CPU."""
    global _APP
    if _APP is not None:
        return _APP
    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    available = set(ort.get_available_providers())
    # 우선순위: DirectML(Windows GPU · CUDA 툴킷 불필요) > CUDA(리눅스/CUDA 설치돼있으면) > CPU.
    # 첫 실행 로그에 실제 사용 provider 남겨서 GPU 붙었는지 눈으로 확인.
    providers = []
    ctx_id = -1
    if "DmlExecutionProvider" in available:
        providers.append("DmlExecutionProvider")
        ctx_id = 0
    elif "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
        ctx_id = 0
    providers.append("CPUExecutionProvider")
    app = FaceAnalysis(name="buffalo_l", providers=providers)
    # det_size는 감지 정확도 vs 속도 tradeoff. 640x640이 안정적. GPU면 320도 고려 가능.
    app.prepare(ctx_id=ctx_id, det_size=(640, 640))
    print(f"[faces] providers={providers} ctx_id={ctx_id}")
    _APP = app
    return app


# 저품질 검출을 클러스터링 이전에 걸러야 서로 다른 사람이 한 클러스터로 붕괴되는 것을 막을 수 있다.
# - det_score: SCRFD 검출 신뢰도. 0.5 미만은 종종 로고·패턴·프로필 실루엣 오검(m_789b0e6b M6_0 붉은 로고).
# - min area: 60×60 이하 얼굴은 임베딩이 노이즈 지배적이라 centroid를 다른 사람 쪽으로 끌어당김.
# - frontal 검사: SCRFD가 뒤통수·심한 옆모습에도 종종 낮은 신뢰로 반응함(F2_1 뒤통수+"양세X" 명찰
#   케이스). 뒤/옆모습 임베딩은 앞모습과 다른 사람처럼 벡터가 나와서 같은 사람이 두 클러스터로
#   갈라지는 주범. 5-키포인트(양눈·코·양입꼬리)로 정면성만 통과시켜서 원천 차단.
_MIN_DET_SCORE = 0.5
_MIN_FACE_AREA = 60 * 60


def _is_frontal(kps: "np.ndarray | None", bbox: list[float]) -> bool:
    """SCRFD 5-키포인트 배치가 정면 얼굴 구성인지.
    kps 순서: [left_eye, right_eye, nose, left_mouth, right_mouth].

    체크:
    1) 5개 키포인트 모두 유효.
    2) 눈이 입보다 위(y_eye < y_mouth) — 뒤집힌/왜곡 검출 배제.
    3) 코가 두 눈 사이 세로선상 (좌우 눈 사이 x축 안) — 심한 옆모습 배제.
    4) 좌·우 대칭 — 코 기준 왼눈까지 거리와 오른눈까지 거리 비가 0.5~2.0.
    5) 눈 간격이 bbox 폭의 20% 이상 — 뒤통수/멀리서 잡힌 뒷모습에서 흔한 붕괴 배제."""
    if kps is None:
        return False
    arr = np.asarray(kps).reshape(-1, 2)
    if arr.shape[0] < 5 or not np.isfinite(arr).all():
        return False
    le, re, ns, lm, rm = arr[0], arr[1], arr[2], arr[3], arr[4]
    if not (le[1] < ns[1] < lm[1] and re[1] < ns[1] < rm[1]):
        return False
    x_lo = min(le[0], re[0])
    x_hi = max(le[0], re[0])
    if not (x_lo - 3 <= ns[0] <= x_hi + 3):
        return False
    d_left = float(np.hypot(ns[0] - le[0], ns[1] - le[1]))
    d_right = float(np.hypot(ns[0] - re[0], ns[1] - re[1]))
    if d_left <= 1 or d_right <= 1:
        return False
    ratio = d_left / d_right if d_right > d_left else d_right / d_left
    if ratio < 0.5:
        return False
    eye_dist = float(np.hypot(re[0] - le[0], re[1] - le[1]))
    bbox_w = max(1.0, float(bbox[2] - bbox[0]))
    if eye_dist < bbox_w * 0.20:
        return False
    return True


def _detect(frame_bgr: np.ndarray) -> list[dict]:
    """프레임 → 얼굴 목록. 각 얼굴 {bbox, embedding(L2 정규화), gender, area, det_score}.
    저품질(_MIN_DET_SCORE·_MIN_FACE_AREA 미달)과 비-정면(뒤통수·측면)은 여기서 폐기."""
    app = _get_app()
    faces = app.get(frame_bgr)
    out: list[dict] = []
    for f in faces:
        det_score = float(getattr(f, "det_score", 0.0) or 0.0)
        if det_score < _MIN_DET_SCORE:
            continue
        bbox = f.bbox.tolist()  # [x1,y1,x2,y2]
        area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        if area < _MIN_FACE_AREA:
            continue
        if not _is_frontal(getattr(f, "kps", None), bbox):
            continue
        emb = f.normed_embedding  # already L2-normalized
        # gender: insightface returns 0=female, 1=male
        gender = "M" if int(getattr(f, "gender", 0)) == 1 else "F"
        out.append({"bbox": bbox, "embedding": emb, "gender": gender, "area": area, "det_score": det_score})
    return out


def _seek_frame(cap: cv2.VideoCapture, ts_sec: float) -> Optional[np.ndarray]:
    """지정 시각 프레임 하나 읽기. 실패 시 None."""
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, ts_sec) * 1000)
    ok, frame = cap.read()
    return frame if ok else None


def _save_crop(frame: np.ndarray, bbox: list[float], path: Path, pad: int = 24) -> bool:
    """얼굴 크롭 + padding → JPG 저장. bbox 유효성 체크 포함."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in bbox]
    x1 = max(0, x1 - pad); y1 = max(0, y1 - pad)
    x2 = min(w, x2 + pad); y2 = min(h, y2 + pad)
    if x2 <= x1 or y2 <= y1:
        return False
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    return bool(cv2.imwrite(str(path), crop))


def build_face_index(
    video_path: str,
    refined: list[dict],
    out_dir: Path,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> tuple[list[dict], dict]:
    """메인 진입.

    1) 각 refined 세그먼트마다 시작+0.5s 프레임 추출
    2) 얼굴 검출 + 임베딩
    3) HDBSCAN 전역 클러스터링
    4) 클러스터→(M1|F1|...) 라벨 부여 (성별 majority + 크기순)
    5) 각 세그먼트에 majority 얼굴(bbox 큰 것)의 라벨을 speaker로 덮어씀
    6) 클러스터별 대표 크롭 3장 저장 · faces.json 반환

    Returns (updated_refined, faces_json). faces_json:
    {
      "clusters": {
        "M1": {"count": 172, "gender_hint": "M",
               "representative_frames": ["face_clusters/M1_0.jpg", ...]},
        ...
      },
      "mapping": {},          # 사용자가 나중에 채움 {"M1": "정숙", ...}
      "labeled_segments": 391 # speaker 필드가 M/F 라벨로 채워진 세그먼트 수
    }
    """
    if not refined:
        return refined, {"clusters": {}, "mapping": {}, "labeled_segments": 0}

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"[faces] cv2.VideoCapture 실패: {video_path}")
        return refined, {"clusters": {}, "mapping": {}, "labeled_segments": 0, "error": "video open failed"}

    n = len(refined)
    per_seg_faces: list[list[dict]] = [[] for _ in range(n)]
    flat_embs: list[np.ndarray] = []
    flat_ref: list[tuple[int, int]] = []  # (seg_i, face_j_in_seg)

    t0 = time.time()
    for i, seg in enumerate(refined):
        try:
            start = float(seg.get("start", 0))
        except (TypeError, ValueError):
            continue
        # segment 중간에 살짝 안쪽으로 (fade-in 회피)
        end = start
        try:
            end = float(seg.get("end", start))
        except (TypeError, ValueError):
            pass
        ts = start + min(0.5, max(0.0, (end - start) / 2))
        frame = _seek_frame(cap, ts)
        if frame is None:
            if on_progress and (i % 20 == 0 or i == n - 1):
                on_progress(i + 1, n)
            continue
        faces = _detect(frame)
        per_seg_faces[i] = faces
        for j, f in enumerate(faces):
            flat_embs.append(f["embedding"])
            flat_ref.append((i, j))
        if on_progress and (i % 20 == 0 or i == n - 1):
            on_progress(i + 1, n)
    cap.release()

    detect_sec = time.time() - t0
    total_faces = len(flat_embs)
    print(f"[faces] 프레임 {n}개 처리 · 얼굴 총 {total_faces}개 검출 · {detect_sec:.1f}s")

    if total_faces < 5:
        # 클러스터링에 최소 샘플 필요 — 너무 적으면 스킵
        return refined, {
            "clusters": {}, "mapping": {}, "labeled_segments": 0,
            "note": f"얼굴 {total_faces}개만 검출되어 클러스터링 스킵",
        }

    # HDBSCAN 클러스터링. L2 정규화된 512차원 임베딩이라 euclidean이 cosine과 monotone.
    # 파라미터 이력:
    #   초기(min_cluster_size=5, eps=0.6) → 같은 사람이 여러 클러스터로 잘게 갈라짐(m_bca62c9f 26개).
    #   완화(eps=0.9, sim_thresh=0.55) → 서로 다른 사람이 한 클러스터로 붕괴(m_789b0e6b M1=1032에
    #     유재석·안경남 혼재, m_84c95ff0 M1=3598 단일 클러스터).
    # 현재: 저품질 검출을 사전에 걸렀으므로 다시 조여도 노이즈 폭발 위험 낮음. eps 0.5·sim_thresh 0.70
    #   조합은 "서로 다른 사람 병합"을 우선 차단. 같은 사람이 두 클러스터로 남아도 UI에서
    #   두 라벨에 같은 이름 매핑하면 refined.speaker rename으로 자연스럽게 붙음(과병합의 반대는
    #   사용자가 되돌릴 방법 없음).
    import hdbscan
    embs_np = np.vstack(flat_embs).astype(np.float32)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=8,
        min_samples=3,
        metric="euclidean",
        cluster_selection_epsilon=0.5,
    )
    cluster_labels = np.array(clusterer.fit_predict(embs_np))
    n_before_merge = len(set(int(l) for l in cluster_labels if l >= 0))

    # 후처리: 클러스터 centroid끼리 코사인 유사도가 임계값 이상이면 병합.
    # sim_thresh 0.70 — ArcFace 정규화 centroid에서 같은 사람이 다른 각도·조명으로 갈라진 경우 여전히
    # 잡을 수 있는 수준(같은 사람 centroid는 대개 0.7+). 0.55는 다른 사람도 곧잘 합쳐 무너뜨렸음.
    def _merge_close_clusters(labels: np.ndarray, embs: np.ndarray, sim_thresh: float = 0.70) -> np.ndarray:
        while True:
            uniq = sorted(set(int(l) for l in labels if l >= 0))
            if len(uniq) < 2:
                break
            centroids = {}
            for c in uniq:
                idx = labels == c
                m = embs[idx].mean(axis=0)
                nrm = np.linalg.norm(m)
                if nrm > 0:
                    m = m / nrm
                centroids[c] = m
            # 페어 코사인 유사도 계산 → 임계값 초과 페어 중 가장 유사한 것부터 병합
            best = None
            for i, a in enumerate(uniq):
                for b in uniq[i+1:]:
                    sim = float(centroids[a] @ centroids[b])
                    if sim > sim_thresh and (best is None or sim > best[2]):
                        best = (a, b, sim)
            if best is None:
                break
            keep, drop, sim = best
            labels = np.where(labels == drop, keep, labels)
        return labels

    cluster_labels = _merge_close_clusters(cluster_labels, embs_np, sim_thresh=0.70)

    n_clusters = len(set(int(l) for l in cluster_labels if l >= 0))
    n_noise = int((cluster_labels < 0).sum())
    print(f"[faces] HDBSCAN → {n_before_merge} 클러스터 · centroid 병합 후 {n_clusters} · noise {n_noise}")

    # 클러스터별 메타 집계 (성별 · 개수 · face_j 인덱스)
    per_cluster: dict[int, dict] = {}
    for k, lbl in enumerate(cluster_labels):
        lbl = int(lbl)
        if lbl < 0:
            continue
        seg_i, face_j = flat_ref[k]
        f = per_seg_faces[seg_i][face_j]
        rec = per_cluster.setdefault(lbl, {"count": 0, "genders": [], "members": []})
        rec["count"] += 1
        rec["genders"].append(f["gender"])
        rec["members"].append((seg_i, face_j))

    # 클러스터 → M1/F1 라벨. 크기순 정렬 + 성별 majority.
    sorted_clusters = sorted(per_cluster.items(), key=lambda x: -x[1]["count"])
    m_cnt = 0
    f_cnt = 0
    cluster_to_label: dict[int, str] = {}
    for c_id, rec in sorted_clusters:
        gm = rec["genders"]
        majority = max(set(gm), key=gm.count)
        if majority == "M":
            m_cnt += 1
            cluster_to_label[c_id] = f"M{m_cnt}"
        else:
            f_cnt += 1
            cluster_to_label[c_id] = f"F{f_cnt}"

    # 세그먼트 → speaker 라벨 덮어쓰기. 여러 얼굴 있으면 bbox area 큰 쪽 채택.
    # refine.py가 이미 실명을 붙인 세그(공인·아이돌·등록 cast) 은 절대 덮어쓰지 않고,
    # 그 실명을 클러스터→이름 auto-mapping seed로만 씀.
    labeled = 0
    auto_map_votes: dict[str, dict[str, int]] = {}  # {"M2": {"김수현": 4, "정숙": 1}}
    for i in range(n):
        faces = per_seg_faces[i]
        if not faces:
            continue
        candidates: list[tuple[str, float]] = []
        for j, f in enumerate(faces):
            # 해당 face의 클러스터 라벨 조회 — flat_ref/labels로 역참조
            for k, (si, fj) in enumerate(flat_ref):
                if si == i and fj == j:
                    lbl = int(cluster_labels[k])
                    if lbl in cluster_to_label:
                        candidates.append((cluster_to_label[lbl], f["area"]))
                    break
        if not candidates:
            continue
        # area 합산해서 가장 크게 나온 클러스터 라벨 채택 (얼굴 관점의 speaker 후보)
        score: dict[str, float] = {}
        for lb, ar in candidates:
            score[lb] = score.get(lb, 0.0) + ar
        best_cluster = max(score.items(), key=lambda x: x[1])[0]

        existing = refined[i].get("speaker") or ""
        if existing and not _is_fallback_speaker(existing):
            # 실명 세그 — refine이 이미 확신한 이름이라 유지. 대신 클러스터→이름 vote 기록.
            votes = auto_map_votes.setdefault(best_cluster, {})
            votes[existing] = votes.get(existing, 0) + 1
        else:
            refined[i]["speaker"] = best_cluster
            labeled += 1

    # 다수결 auto-mapping: 각 클러스터가 세그 3회+ 60%+ 우세로 특정 실명과 붙었다면 확정.
    # 확정된 매핑은 (a) faces.json.mapping 초깃값으로 (b) 다른 폴백 세그에 확산 적용.
    auto_mapping: dict[str, str] = {}
    for cluster_lbl, votes in auto_map_votes.items():
        total = sum(votes.values())
        top_name, top_count = max(votes.items(), key=lambda x: x[1])
        if top_count >= 3 and top_count / total >= 0.6:
            auto_mapping[cluster_lbl] = top_name

    if auto_mapping:
        propagated = 0
        for i in range(n):
            sp = refined[i].get("speaker") or ""
            if sp in auto_mapping:
                refined[i]["speaker"] = auto_mapping[sp]
                propagated += 1
        print(f"[faces] auto-mapping 확정 {len(auto_mapping)}개 · 폴백 세그 {propagated}개에 실명 확산")

    # 대표 프레임 저장. 각 클러스터당 (a) 얼굴 크롭 상위 3장 + (b) 전체 프레임(캡션 감지용) 10장.
    # 2026-07-23 사용자 방향: 방송 자막 "이름 : 대사" 캡션을 Vision이 잡으려면 full frame 필요.
    # 얼굴 크롭은 얼굴만이라 캡션 안 담김.
    frames_dir = out_dir / "face_clusters"
    clusters_meta: dict[str, dict] = {}
    for c_id, rec in per_cluster.items():
        label = cluster_to_label[c_id]
        # members = [(seg_i, face_j)]. area 큰 순 상위 3 (얼굴 크롭용).
        members_with_area = []
        for seg_i, face_j in rec["members"]:
            members_with_area.append((seg_i, face_j, per_seg_faces[seg_i][face_j]["area"]))
        members_with_area.sort(key=lambda x: -x[2])
        reps = []
        full_reps = []
        cap = cv2.VideoCapture(str(video_path))
        # (a) 얼굴 크롭 3장
        for r_i, (seg_i, face_j, _) in enumerate(members_with_area[:3]):
            try:
                start = float(refined[seg_i].get("start", 0))
            except (TypeError, ValueError):
                continue
            frame = _seek_frame(cap, start + 0.5)
            if frame is None:
                continue
            fname = f"{label}_{r_i}.jpg"
            fpath = frames_dir / fname
            if _save_crop(frame, per_seg_faces[seg_i][face_j]["bbox"], fpath):
                reps.append(f"face_clusters/{fname}")
        # (b) 전체 프레임 10장 (캡션 감지용) — 클러스터 멤버 시점에서 균등 샘플링
        import random as _rnd
        picks = list(members_with_area)
        if len(picks) > 10:
            step = len(picks) / 10
            picks = [picks[int(i * step)] for i in range(10)]
        for r_i, (seg_i, _face_j, _area) in enumerate(picks):
            try:
                start = float(refined[seg_i].get("start", 0))
            except (TypeError, ValueError):
                continue
            frame = _seek_frame(cap, start + 0.5)
            if frame is None:
                continue
            fname_full = f"{label}_full_{r_i}.jpg"
            fpath_full = frames_dir / fname_full
            try:
                cv2.imwrite(str(fpath_full), frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                full_reps.append(f"face_clusters/{fname_full}")
            except Exception:
                pass
        cap.release()
        clusters_meta[label] = {
            "cluster_id": int(c_id),
            "count": rec["count"],
            "gender_hint": max(set(rec["genders"]), key=rec["genders"].count),
            "representative_frames": reps,       # 얼굴 크롭 (사용자 UI · 매핑 확인용)
            "full_frames": full_reps,             # 전체 프레임 (Vision auto-map 캡션 감지용)
        }

    faces_json = {
        "clusters": clusters_meta,
        # mapping 초깃값 = auto-mapping (공인/등록 cast는 refine이 이미 확신했고, 그걸 클러스터에
        # 다수결로 붙였음). 사용자 UI에서 확인·수정 가능.
        "mapping": dict(auto_mapping),
        "labeled_segments": labeled,
        "auto_mapped_clusters": len(auto_mapping),
        "total_frames_scanned": n,
        "total_faces_detected": total_faces,
        "detect_sec": round(detect_sec, 1),
    }
    return refined, faces_json


def apply_mapping(refined: list[dict], mapping: dict) -> list[dict]:
    """사용자가 UI에서 채운 mapping({M1:정숙, F2:영자, ...})을 refined에 적용.
    매핑 없는 라벨은 그대로 유지 (M1/F1 등)."""
    if not mapping:
        return refined
    for s in refined:
        sp = s.get("speaker")
        if sp and sp in mapping and mapping[sp]:
            s["speaker"] = mapping[sp]
    return refined


def vision_auto_map_clusters(
    faces_json: dict,
    out_dir: Path,
    cast_registry: list[dict] | None = None,
    workers: int = 5,
) -> dict:
    """얼굴 클러스터 자동 매핑 (2026-07-23 · 사용자 방향).

    각 클러스터의 대표 프레임(2~3장 · 이미 face_clusters/에 저장됨)을 Gemini Vision 콜에 함께
    넣어 매칭:
      1) cast_registry (프로그램 사전등록 명단) 있으면 그 안에서 매칭 우선
      2) 화면 자막에 "이름 : 대사" 형태 캡션 있으면 그 이름 추출
      3) 유명 공인이면 세계 지식으로 인식
      4) 셋 다 아니면 null (M1/F1 유지)

    각 클러스터별 병렬 Gemini 콜. 클러스터 20개 · 5워커 병렬 · 콜당 3초 = ~15초 총.
    반환: cluster_label → detected_name (기존 mapping과 병합해서 사용).
    """
    clusters = faces_json.get("clusters") or {}
    if not clusters:
        return {}
    # cast_registry 이름 리스트
    cast_names: list[str] = []
    if cast_registry:
        for m in cast_registry:
            n = (m.get("name") or "").strip() if isinstance(m, dict) else ""
            if n:
                cast_names.append(n)
            for a in (m.get("aliases") or []) if isinstance(m, dict) else []:
                a = str(a).strip()
                if a:
                    cast_names.append(a)
    cast_block = (
        f"\n등록된 출연자 명단 (이 안에서 매칭 우선): {', '.join(cast_names)}"
        if cast_names else ""
    )

    # Vision 임포트 (지연)
    from google import genai
    from google.genai import types
    from .retry import call_with_retry

    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
    location = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
    model = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
    client = genai.Client(vertexai=True, project=project, location=location)

    system = f"""너는 방송 클립에서 얼굴 인물 식별 전문가다. 아래 이미지들은 같은 인물의 여러 프레임이다.

**우선순위로 이름 판정**:
1. **화면 자막 캡션**: 이미지에 "이름 : 대사" or "이름 (설명)" 같은 방송 자막이 보이면 그 이름을
   가장 신뢰. 프레임 하단·상단·측면 자막 확인.
2. **등록 명단 매칭**: 위 명단에 있는 사람과 얼굴이 매칭되면 그 이름.
3. **유명 공인**: 위 두 개 없으면 얼굴이 유명한 공인(연예인·아이돌·MC·정치인·스포츠 선수)인지
   판단. 확신 시 실명.
4. **모르는 인물**: 셋 다 아니면 null.
{cast_block}

**반환 형식** (JSON): {{"name": "홍길동", "source": "caption|registry|celebrity|unknown", "confidence": 0.9}}
name=null이면 매칭 실패."""

    def _read_bytes(rel_path: str) -> bytes | None:
        p = out_dir / rel_path
        try:
            return p.read_bytes()
        except OSError:
            return None

    def _one_cluster(label: str, meta: dict) -> tuple[str, str | None, str, float]:
        """(label, name, source, confidence) 반환.
        full_frames (전체 프레임 · 캡션 감지용) 우선 · 없으면 representative_frames(얼굴 크롭) 폴백."""
        full_frames = meta.get("full_frames") or []
        reps = meta.get("representative_frames") or []
        # 최대 8장 (full 5 + crop 3 = 8). caption 감지 확률 up.
        images: list[types.Part] = []
        for rel in full_frames[:5]:
            b = _read_bytes(rel)
            if b:
                images.append(types.Part.from_bytes(data=b, mime_type="image/jpeg"))
        for rel in reps[:3]:
            b = _read_bytes(rel)
            if b:
                images.append(types.Part.from_bytes(data=b, mime_type="image/jpeg"))
        if not images:
            return label, None, "no_image", 0.0
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=model,
                contents=images + [f"이 인물의 이름을 판정하라 (클러스터 {label} · {meta.get('gender_hint','?')})."],
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0,
                    response_mime_type="application/json",
                    max_output_tokens=256,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            ))
            raw = resp.text or "{}"
            data = json.loads(raw)
            name = data.get("name")
            if isinstance(name, str):
                name = name.strip()
                if name and name.lower() != "null":
                    return label, name, str(data.get("source", "")), float(data.get("confidence") or 0)
            return label, None, str(data.get("source", "")), 0.0
        except Exception as e:
            return label, None, f"err: {str(e)[:60]}", 0.0

    from concurrent.futures import ThreadPoolExecutor, as_completed
    result: dict[str, str] = {}
    skipped_celebrity = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_one_cluster, lbl, meta) for lbl, meta in clusters.items()]
        for fut in as_completed(futures):
            lbl, name, source, conf = fut.result()
            if not name or conf < 0.5:
                continue
            # 2026-07-23 hallucination 방지: cast_registry 없이 celebrity source 결과는 신뢰 X.
            # 일반인 리얼리티(환승연애 등)에서 무명 참가자를 얼굴 비슷한 유명 연예인으로 잘못
            # 매칭한 사례 관찰 (F2→장기용, F1→나나 등 모두 오탐).
            # caption(화면 자막) or registry(사전등록) source 만 신뢰.
            if source == "celebrity" and not cast_names:
                skipped_celebrity += 1
                print(f"[faces] skip {lbl} → {name} ({source} · conf {conf:.2f}) · cast_registry 없이 celebrity 판정은 hallucination 위험", flush=True)
                continue
            result[lbl] = name
            print(f"[faces] auto-map {lbl} → {name} ({source} · conf {conf:.2f})", flush=True)
    print(f"[faces] Vision auto-map: {len(result)}/{len(clusters)} 확정 · skip {skipped_celebrity} · {time.time()-t0:.1f}s")
    return result

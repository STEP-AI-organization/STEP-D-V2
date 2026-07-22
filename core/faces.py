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
import sys
import time
from pathlib import Path
from typing import Callable, Optional

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
    """FaceAnalysis 싱글턴. 첫 호출 시 모델 로드 + (없으면) 다운로드."""
    global _APP
    if _APP is not None:
        return _APP
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    # ctx_id=-1 → CPU, det_size는 감지 정확도 vs 속도 tradeoff. 640x640이 안정적.
    app.prepare(ctx_id=-1, det_size=(640, 640))
    _APP = app
    return app


def _detect(frame_bgr: np.ndarray) -> list[dict]:
    """프레임 → 얼굴 목록. 각 얼굴 {bbox, embedding(L2 정규화), gender, area}."""
    app = _get_app()
    faces = app.get(frame_bgr)
    out: list[dict] = []
    for f in faces:
        emb = f.normed_embedding  # already L2-normalized
        bbox = f.bbox.tolist()  # [x1,y1,x2,y2]
        area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        # gender: insightface returns 0=female, 1=male
        gender = "M" if int(getattr(f, "gender", 0)) == 1 else "F"
        out.append({"bbox": bbox, "embedding": emb, "gender": gender, "area": area})
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
    # 조명·각도·표정 변화가 심한 예능 방송에서 초기 세팅(min_cluster_size=5, eps=0.6)이 같은
    # 사람을 여러 클러스터로 잘게 나누는 문제(m_bca62c9f 26개 관찰). 파라미터 완화 + centroid
    # 후처리 병합으로 실제 인물 수에 가깝게.
    import hdbscan
    embs_np = np.vstack(flat_embs).astype(np.float32)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=8,
        min_samples=3,
        metric="euclidean",
        cluster_selection_epsilon=0.9,
    )
    cluster_labels = np.array(clusterer.fit_predict(embs_np))
    n_before_merge = len(set(int(l) for l in cluster_labels if l >= 0))

    # 후처리: 클러스터 centroid끼리 코사인 유사도가 임계값 이상이면 병합.
    # 임계값 0.55 = 두 centroid의 정규화 유클리드 거리 약 0.95 (cos_sim > 0.55).
    # 반복(iterative)해서 더 이상 병합 안 될 때까지.
    def _merge_close_clusters(labels: np.ndarray, embs: np.ndarray, sim_thresh: float = 0.55) -> np.ndarray:
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

    cluster_labels = _merge_close_clusters(cluster_labels, embs_np, sim_thresh=0.55)

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
    labeled = 0
    for i in range(n):
        faces = per_seg_faces[i]
        if not faces:
            continue
        # 이 세그먼트의 각 얼굴에 대한 (label, area) 수집
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
        # area 합산해서 가장 크게 나온 라벨 채택
        score: dict[str, float] = {}
        for lb, ar in candidates:
            score[lb] = score.get(lb, 0.0) + ar
        best = max(score.items(), key=lambda x: x[1])[0]
        refined[i]["speaker"] = best
        labeled += 1

    # 대표 프레임 저장. 각 클러스터당 상위 3개(가장 area 큰 순).
    frames_dir = out_dir / "face_clusters"
    clusters_meta: dict[str, dict] = {}
    for c_id, rec in per_cluster.items():
        label = cluster_to_label[c_id]
        # members = [(seg_i, face_j)]. area 큰 순 상위 3.
        members_with_area = []
        for seg_i, face_j in rec["members"]:
            members_with_area.append((seg_i, face_j, per_seg_faces[seg_i][face_j]["area"]))
        members_with_area.sort(key=lambda x: -x[2])
        reps = []
        cap = cv2.VideoCapture(str(video_path))
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
        cap.release()
        clusters_meta[label] = {
            "cluster_id": int(c_id),
            "count": rec["count"],
            "gender_hint": max(set(rec["genders"]), key=rec["genders"].count),
            "representative_frames": reps,
        }

    faces_json = {
        "clusters": clusters_meta,
        "mapping": {},  # 사용자 UI에서 채움: {"M1": "정숙", ...}
        "labeled_segments": labeled,
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

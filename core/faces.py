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

    GPU 강제(2026-07-24) — CPU 폴백은 명시 opt-in만.
    이유: 실측 CPU는 얼굴당 ~50ms, GPU는 ~5ms. 108분 영상에서 faces가 346s vs 4192s로
    12배 편차 관찰됨(m_153d4e79 vs m_84c95ff0). CPU 폴백 허용은 총 처리시간을 60분 밖으로
    밀어내 서비스 사용 불가로 만듦. providers 리스트에 CPU를 아예 안 넣어서 GPU 초기화 실패 시
    onnxruntime이 세션 생성 단계에서 raise → 워커가 명확한 에러를 로그로 남김.

    폴백이 정말 필요한 로컬 디버깅에선 `FACES_ALLOW_CPU=1` 환경변수로 opt-in."""
    global _APP
    if _APP is not None:
        return _APP
    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    available = set(ort.get_available_providers())

    allow_cpu = os.environ.get("FACES_ALLOW_CPU", "").strip().lower() in ("1", "true", "yes")

    # DirectML(Windows · CUDA 툴킷 불필요) 우선, 그다음 CUDA(Linux).
    gpu_provider: str | None = None
    if "DmlExecutionProvider" in available:
        gpu_provider = "DmlExecutionProvider"
    elif "CUDAExecutionProvider" in available:
        gpu_provider = "CUDAExecutionProvider"

    if gpu_provider is None:
        if not allow_cpu:
            raise RuntimeError(
                "[faces] GPU provider unavailable. "
                f"installed onnxruntime providers: {sorted(available)}. "
                "faces stage requires GPU (CPU is ~10× slower per face; can push 60min video "
                "past 60min processing, making the pipeline unusable in production). "
                "Fix: install onnxruntime-directml (Windows) or onnxruntime-gpu (Linux/CUDA). "
                "Debug override: set env FACES_ALLOW_CPU=1 to allow CPU fallback (slow)."
            )
        providers = ["CPUExecutionProvider"]
        ctx_id = -1
        print("[faces] ⚠️ FACES_ALLOW_CPU=1 → CPU 강제 폴백 (예상 처리시간 10× 증가)")
    else:
        # CPU 폴백을 리스트에 안 넣음 = GPU 초기화 실패 시 세션 생성 자체가 raise (silent CPU 폴백 차단).
        providers = [gpu_provider]
        ctx_id = 0

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
    cast_photos_dir: Path | None = None,
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

    # 최소 샘플 간격 — 짧은 대사 세그가 몰리면(예능 리액션 컷) 프레임 수 폭증.
    # 같은 사람이 같은 컷에서 여러 프레임 잡혀도 클러스터링은 centroid로 수렴 → 결과 거의 동일.
    # 3s 하한이면 대사 세그가 1-2s 몰려도 최대 절반은 스킵되어 총 프레임 수 30-50% 절감.
    # 스킵된 세그는 speaker 라벨링에 못 참여하지만, refined는 이후에 인접 세그의 speaker를 상속.
    _MIN_SAMPLE_INTERVAL_SEC = 3.0
    last_sampled_ts: float = -1.0e9
    sampled = 0
    skipped_interval = 0

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
        # 하한 간격 미달이면 이 세그는 스킵 (per_seg_faces[i]는 빈 리스트로 유지 → speaker 상속으로 커버)
        if ts - last_sampled_ts < _MIN_SAMPLE_INTERVAL_SEC:
            skipped_interval += 1
            if on_progress and (i % 20 == 0 or i == n - 1):
                on_progress(i + 1, n)
            continue
        frame = _seek_frame(cap, ts)
        if frame is None:
            if on_progress and (i % 20 == 0 or i == n - 1):
                on_progress(i + 1, n)
            continue
        last_sampled_ts = ts
        sampled += 1
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
    print(
        f"[faces] 세그 {n}개 중 {sampled}개 샘플 · {skipped_interval}개 간격 스킵 · "
        f"얼굴 총 {total_faces}개 검출 · {detect_sec:.1f}s"
    )

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
        # full_frames와 짝지어 시점 seg_i 저장 (Vision auto-map이 STT 컨텍스트 뽑기용)
        full_seg_ids = [seg_i for seg_i, _face_j, _area in picks]
        clusters_meta[label] = {
            "cluster_id": int(c_id),
            "count": rec["count"],
            "gender_hint": max(set(rec["genders"]), key=rec["genders"].count),
            "representative_frames": reps,       # 얼굴 크롭 (사용자 UI · 매핑 확인용)
            "full_frames": full_reps,             # 전체 프레임 (Vision auto-map 캡션 감지용)
            "full_frame_segs": full_seg_ids,      # 각 full_frame의 seg_i (STT 컨텍스트용)
        }

    # ── 사용자 등록 캐스트 사진 → 클러스터 매칭 (2026-07-24) ─────────────────────
    # 사용자가 프로그램 상세 페이지에서 인물 사진을 올렸으면 그 사진 embedding으로 클러스터에
    # 직접 이름을 붙인다. 다수결 auto-mapping / Vision LLM 매칭보다 근거가 강력해서 우선순위 top —
    # 겹치는 클러스터는 사진 매칭이 override. 사진 없거나 얼굴 검출 실패면 no-op.
    photo_mapping: dict[str, str] = {}
    if cast_photos_dir:
        try:
            cast_embs = load_cast_photo_embeddings(cast_photos_dir)
            if cast_embs:
                photo_mapping = match_clusters_by_photos(
                    faces_json={},  # 이 시점엔 아직 안 만들어짐 — dummy
                    per_seg_faces=per_seg_faces,
                    flat_ref=flat_ref,
                    cluster_labels=cluster_labels,
                    cluster_to_label=cluster_to_label,
                    cast_photo_embs=cast_embs,
                )
                if photo_mapping:
                    # 사진 매칭이 우세: 다수결과 병합하되 사진 매칭 결과가 이깁니다.
                    for lbl, nm in photo_mapping.items():
                        auto_mapping[lbl] = nm
                    # 사진 매칭이 확정한 라벨은 refined에서도 다시 확산 (다수결 자리에 없었을 수 있음).
                    propagated_photo = 0
                    for i in range(n):
                        sp = refined[i].get("speaker") or ""
                        if sp in photo_mapping:
                            refined[i]["speaker"] = photo_mapping[sp]
                            propagated_photo += 1
                    print(f"[faces·photo] 확산 {propagated_photo}개 세그먼트")
        except Exception as e:
            print(f"[faces·photo] 사진 매칭 실패 (스킵): {str(e)[:120]}")
            import traceback
            traceback.print_exc()

    faces_json = {
        "clusters": clusters_meta,
        # mapping 초깃값 = auto-mapping (공인/등록 cast는 refine이 이미 확신했고, 그걸 클러스터에
        # 다수결로 붙였음) + 사진 매칭(사용자 등록 인물 사진). 사용자 UI에서 확인·수정 가능.
        "mapping": dict(auto_mapping),
        "labeled_segments": labeled,
        "auto_mapped_clusters": len(auto_mapping),
        "photo_mapped_clusters": len(photo_mapping),
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


# ── 사용자 등록 캐스트 사진 → 클러스터 자동 매칭 ──────────────────────────────
# 사용자가 프로그램 상세 페이지에서 인물별 사진을 업로드하면 server가 work/cast_photos/*.{jpg,png}로
# 풀어놓는다. faces.py는 이 폴더를 스캔해서 각 사진의 face embedding을 뽑고, 이미 만들어진
# 클러스터 centroid와 코사인 유사도로 매칭 → faces.mapping에 병합. Vision LLM(vision_auto_map)이나
# refine 다수결(auto_mapping)보다 **직접 근거**라 우선순위 최상. 사진이 없거나 얼굴 검출 실패면 no-op.
_PHOTO_MATCH_MIN_SIM = 0.35  # cosine similarity 임계값. buffalo_l ArcFace embedding 기준 경험값.
_PHOTO_MATCH_MARGIN = 0.05   # 1등과 2등의 차이가 이 이상이어야 확정 (혼동 방지).
_PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def _photo_embedding(app, img_path: Path) -> "np.ndarray | None":
    """캐스트 사진 1장 → L2 정규화된 embedding. 검출 실패/다중 얼굴 시 None.
    다중 얼굴이면 가장 큰 얼굴 선택 (프로필 사진에서 배경 얼굴 노이즈 회피)."""
    try:
        img = cv2.imread(str(img_path))
        if img is None:
            return None
        faces = app.get(img)
        if not faces:
            return None
        faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
        return faces[0].normed_embedding
    except Exception as e:
        print(f"[faces·photo] embedding 실패 {img_path.name}: {str(e)[:80]}")
        return None


def load_cast_photo_embeddings(cast_photos_dir: Path) -> dict[str, "np.ndarray"]:
    """cast_photos_dir 안의 이미지 파일들을 이름(파일명 stem)→embedding 로 매핑.
    이름은 원본 캐스트 이름 그대로(예: '정우성.jpg' → '정우성'). 파일 없으면 빈 dict."""
    if not cast_photos_dir or not cast_photos_dir.exists() or not cast_photos_dir.is_dir():
        return {}
    files = [p for p in sorted(cast_photos_dir.iterdir()) if p.suffix.lower() in _PHOTO_EXTS]
    if not files:
        return {}
    app = _get_app()
    if app is None:
        print(f"[faces·photo] insightface 초기화 실패 — 사진 매칭 스킵")
        return {}
    out: dict[str, np.ndarray] = {}
    for p in files:
        emb = _photo_embedding(app, p)
        if emb is None:
            print(f"[faces·photo] 얼굴 검출 실패 (스킵): {p.name}")
            continue
        # 파일 stem을 이름으로. server가 '/', '\', NUL만 치환하고 한글은 그대로 저장.
        out[p.stem] = emb
    if out:
        print(f"[faces·photo] 캐스트 사진 임베딩 {len(out)}/{len(files)}장 확보")
    return out


def match_clusters_by_photos(
    faces_json: dict,
    per_seg_faces: list[list[dict]] | None,
    flat_ref: list[tuple[int, int]] | None,
    cluster_labels: "np.ndarray | None",
    cluster_to_label: dict[int, str] | None,
    cast_photo_embs: dict[str, "np.ndarray"],
) -> dict[str, str]:
    """캐스트 사진 embedding ↔ 클러스터 centroid embedding 매칭.

    반환: {cluster_label: cast_name} — 확정된 것만 (임계값·margin 만족).
    각 사진 별로 가장 유사도가 높은 클러스터를 골라, 그 유사도가 임계 & 2등과의 margin 조건을
    만족하면 확정. 한 클러스터에 여러 사진이 몰리면 가장 유사도 높은 하나만 채택 (합리적 tie-break).
    사진이 없으면 no-op.
    """
    if not cast_photo_embs or per_seg_faces is None or flat_ref is None or cluster_to_label is None:
        return {}
    if cluster_labels is None or len(cluster_labels) == 0:
        return {}

    # 1) 클러스터 → 멤버 embedding 리스트 → centroid (L2 정규화)
    cluster_members: dict[int, list[np.ndarray]] = {}
    for k, lbl in enumerate(cluster_labels):
        lbl = int(lbl)
        if lbl < 0:
            continue
        seg_i, face_j = flat_ref[k]
        try:
            emb = per_seg_faces[seg_i][face_j]["embedding"]
        except (IndexError, KeyError):
            continue
        cluster_members.setdefault(lbl, []).append(emb)
    if not cluster_members:
        return {}
    centroids: dict[str, np.ndarray] = {}
    for cid, embs in cluster_members.items():
        lbl = cluster_to_label.get(cid)
        if not lbl:
            continue
        arr = np.asarray(embs, dtype=np.float32)
        c = arr.mean(axis=0)
        norm = np.linalg.norm(c)
        if norm > 1e-8:
            c = c / norm
        centroids[lbl] = c

    # 2) 각 사진에 대해 가장 유사도 높은 클러스터 후보 계산
    #    similarity = 코사인 = normed dot product (embedding들이 이미 L2 정규화됨)
    photo_top: dict[str, tuple[str, float, float]] = {}  # name → (best_label, best_sim, second_sim)
    for name, pemb in cast_photo_embs.items():
        sims = [(lbl, float(np.dot(pemb, c))) for lbl, c in centroids.items()]
        if not sims:
            continue
        sims.sort(key=lambda x: -x[1])
        best_lbl, best_sim = sims[0]
        second_sim = sims[1][1] if len(sims) > 1 else -1.0
        photo_top[name] = (best_lbl, best_sim, second_sim)

    # 3) 임계·margin 만족한 매칭만 확정. 같은 클러스터에 여러 사진이 겨루면 유사도 최고 하나만.
    confirmed: dict[str, tuple[str, float]] = {}  # cluster_label → (name, sim)
    for name, (lbl, sim, second) in photo_top.items():
        if sim < _PHOTO_MATCH_MIN_SIM:
            continue
        if (sim - second) < _PHOTO_MATCH_MARGIN:
            continue
        prev = confirmed.get(lbl)
        if not prev or sim > prev[1]:
            confirmed[lbl] = (name, sim)
    mapping = {lbl: nm for lbl, (nm, _) in confirmed.items()}
    if mapping:
        detail = ", ".join(f"{lbl}↔{nm}({confirmed[lbl][1]:.2f})" for lbl, nm in mapping.items())
        print(f"[faces·photo] 사진→클러스터 매칭 확정 {len(mapping)}개: {detail}")
    return mapping


def vision_auto_map_clusters(
    faces_json: dict,
    out_dir: Path,
    cast_registry: list[dict] | None = None,
    workers: int = 5,
    refined: list[dict] | None = None,
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
    has_cast = bool(cast_names)
    cast_block = (
        f"\n\n**등록된 명단 ({len(cast_names)}명 · 반드시 이 중 하나 선택 · 명단 밖 이름 금지)**:\n"
        f"{', '.join(cast_names)}"
        if has_cast else ""
    )

    # Vision 임포트 (지연)
    from google import genai
    from google.genai import types
    from .retry import call_with_retry

    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
    location = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
    model = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
    client = genai.Client(vertexai=True, project=project, location=location)

    # cast 있으면 "반드시 명단 중 하나" 강제 · 없으면 caption/celebrity 자유 판정
    if has_cast:
        system = f"""너는 방송 얼굴 식별 전문가다. 아래 이미지들은 같은 인물이다.
{cast_block}

**판정 규칙**:
1. **화면 자막 캡션 우선**: 프레임에 "이름 : 대사" 형태 자막이 있으면 그 이름 (등록 명단과 매칭).
2. **STT 대사 컨텍스트 활용**: 프레임 시점 대사에 호칭("XX아", "XX씨", "XX님")이나 자기소개
   ("저는 XX입니다") 있으면 강한 힌트. 예: "지연아 어떻게 생각해?" 다음 대답 얼굴 = 지연.
3. **명단 강제 선택**: 위 명단 {len(cast_names)}명 중 얼굴 특징(성별·나이대·헤어·복장 등)이 가장
   맞는 사람 **1명**을 골라라. 완전 확신 없어도 가장 유사한 후보 선택.
4. **정말 명단 아무도 아니다** 싶으면 (예: 스태프·나레이터·엑스트라) name=null · source=unknown.
5. celebrity source 금지 · 반드시 위 명단 안에서만.

**반환 형식** (JSON): {{"name":"민경","source":"caption|stt|registry","confidence":0.85,"reason":"장발 20대 여성"}}
confidence: 0.9+ = 확신 · 0.7-0.9 = 유력 · 0.5-0.7 = 후보 · <0.5 = null 로."""
    else:
        system = """너는 방송 얼굴 식별 전문가다. 아래 이미지들은 같은 인물이다.

**판정 규칙**:
1. 프레임에 "이름 : 대사" 형태 화면 자막이 있으면 그 이름 (source=caption).
2. 자막 없고 얼굴이 유명 공인(연예인·아이돌·MC·정치인·스포츠 선수)이면 실명 (source=celebrity).
3. 둘 다 아니면 name=null.

**반환 형식** (JSON): {"name":"홍길동","source":"caption|celebrity|unknown","confidence":0.9}"""

    def _read_bytes(rel_path: str) -> bytes | None:
        p = out_dir / rel_path
        try:
            return p.read_bytes()
        except OSError:
            return None

    def _stt_context(seg_ids: list[int], window: int = 3) -> str:
        """각 seg_i 앞뒤 window개 대사 뽑기 · '호칭·자기소개' 컨텍스트로 얼굴 매칭 강화."""
        if not refined or not seg_ids:
            return ""
        picked_lines: list[str] = []
        seen_i: set[int] = set()
        for si in seg_ids[:5]:  # 프레임 5개까지 컨텍스트
            for i in range(max(0, si - window), min(len(refined), si + window + 1)):
                if i in seen_i:
                    continue
                seen_i.add(i)
                s = refined[i]
                txt = (s.get("text") or "").strip()
                if not txt:
                    continue
                mark = " ← 이 프레임" if i == si else ""
                picked_lines.append(f"  [{i}] {txt[:100]}{mark}")
        if not picked_lines:
            return ""
        return "\n\n**이 인물이 등장한 프레임 시점의 대사 컨텍스트** (호칭·자기소개로 매칭 강화):\n" + "\n".join(picked_lines[:20])

    def _one_cluster(label: str, meta: dict) -> tuple[str, str | None, str, float]:
        """(label, name, source, confidence) 반환.
        full_frames (전체 프레임 · 캡션 감지용) 우선 · 없으면 representative_frames(얼굴 크롭) 폴백.
        각 프레임 시점의 STT 대사 컨텍스트 함께 (호칭·자기소개로 매칭 강화)."""
        full_frames = meta.get("full_frames") or []
        full_segs = meta.get("full_frame_segs") or []
        reps = meta.get("representative_frames") or []
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
        stt_ctx = _stt_context(full_segs)
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=model,
                contents=images + [
                    f"이 인물(클러스터 {label} · 성별 {meta.get('gender_hint','?')})의 이름을 판정하라." + stt_ctx
                ],
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
    skipped_offlist = 0
    t0 = time.time()
    # cast 있으면 명단 밖 이름 필터링 (Vision이 강제 선택 지시 어겼을 수도)
    cast_set = set(cast_names) if has_cast else None
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_one_cluster, lbl, meta) for lbl, meta in clusters.items()]
        for fut in as_completed(futures):
            lbl, name, source, conf = fut.result()
            if not name or conf < 0.4:
                continue
            # celebrity source는 cast 없을 때만 (hallucination 위험). cast 있으면 명단 밖은 배제.
            if source == "celebrity" and not has_cast:
                skipped_celebrity += 1
                print(f"[faces] skip {lbl} → {name} (celebrity · conf {conf:.2f}) · cast 없어 hallucination 위험", flush=True)
                continue
            # cast 있는데 명단 밖 이름 반환 시 배제 (프롬프트 지시 어긴 케이스)
            if cast_set is not None and name not in cast_set and source != "caption":
                skipped_offlist += 1
                print(f"[faces] skip {lbl} → {name} ({source} · conf {conf:.2f}) · 명단 밖 이름", flush=True)
                continue
            result[lbl] = name
            print(f"[faces] auto-map {lbl} → {name} ({source} · conf {conf:.2f})", flush=True)
    print(f"[faces] Vision auto-map: {len(result)}/{len(clusters)} 확정 · skip celebrity={skipped_celebrity} · offlist={skipped_offlist} · {time.time()-t0:.1f}s")
    return result

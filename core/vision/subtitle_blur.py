"""원본에 구운(burned-in) 자막의 위치·구간 검출 — 해외 배포용 "원본 자막 블러"의 눈.

해외 채널로 나가는 클립은 번역 자막을 새로 굽는데, 원본에 이미 한글 자막이 박혀 있으면
두 자막이 겹친다. 이 모듈이 클립 구간에서 샘플 프레임을 읽어 **글자가 뜬 사각형+시간 구간**
목록(이벤트)을 만들고, 렌더(ffmpeg.ts sourceBlur)가 그 자리·그 시간에만 블러를 건다.

검출기는 PaddleOCR v4 det(DB) ONNX 를 onnxruntime 으로 직접 돌린다. rapidocr 패키지를 쓰지
않는 이유: 그 패키지는 `opencv-python` 을 끌고 들어와 이 리포의 `opencv-contrib-python` 을
덮는다(requirements.txt 의 "opencv 가 두 개" 주석 참조). onnxruntime 하나만 추가하고
전·후처리는 cv2(이미 있음)로 직접 한다.

로컬 시험(2026-09-15 · 유튜브 실영상 20초)에서 굳힌 규칙 셋 — 지우면 같은 문제를 다시 밟는다:
  1. **자막 존(zone) 필터 필수.** 존 없이 돌리면 배경 간판·소품 글자가 오검출로 블러된다.
  2. **시간축 매칭은 직전 프레임 박스와.** 누적 union 과 비교하면 다른 자막 줄이 연쇄로
     붙어 사각형이 무한정 자란다(실측: 12초짜리 1681×325 거대 이벤트).
  3. 전폭 자막은 과검출이 아니다 — 실제로 화면 끝까지 가는 큰 자막이 있다(원본 확인).

이벤트 시간은 **마스터 절대 초**다(clip.reframe 의 timeBase=master_absolute 와 같은 축) —
에디터 트림·목적지 길이 캡으로 렌더 창이 달라져도 좌표가 흔들리지 않는다.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from dataclasses import dataclass

# ── 병합 파라미터 (로컬 실측으로 굳힌 기본값) ────────────────────────────────
PAD_XY = 14            # 박스 여유(px) — 글리프 안티앨리어싱 가장자리까지 덮는다
PAD_T_IN = 0.3         # 구간 앞 여유(s) — 샘플 사이에 등장한 자막을 덮는다
PAD_T_OUT = 0.4        # 구간 뒤 여유(s)
IOU_MATCH = 0.45       # 같은 자막 줄로 볼 IoU 하한 (직전 프레임 박스와 비교)
WIDTH_SIM = 0.6        # 같은 줄로 볼 폭 비(min/max) 하한 — IoU 만으로는 중앙정렬 자막의
                       # 줄 교체를 못 끊는다(실측: 폭 919→1677 교체가 IoU 0.45 를 넘어 13초 연쇄)
TOUCH_GAP_PX = 24      # 이 안으로 근접한 박스는 한 덩어리(라벨 줄+대사 줄)
MIN_W, MIN_H = 30, 18  # 노이즈 컷

Rect = list  # [x0, y0, x1, y1]


def _union(a: Rect, b: Rect) -> Rect:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _iou(a: Rect, b: Rect) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    aa = (a[2] - a[0]) * (a[3] - a[1])
    bb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (aa + bb - inter)


def _touches(a: Rect, b: Rect, gap: float = TOUCH_GAP_PX) -> bool:
    return not (a[2] + gap < b[0] or b[2] + gap < a[0]
                or a[3] + gap < b[1] or b[3] + gap < a[1])


def merge_frame_rects(rects: list[Rect]) -> list[Rect]:
    """한 프레임 안에서 근접 박스를 한 덩어리로(연결 요소 union).

    자막은 보통 라벨 줄([ ... ])과 대사 줄이 붙어 있다 — 따로 블러하면 사이 띠가 남는다.
    """
    merged: list[Rect] = []
    for r in rects:
        acc = list(r)
        rest = []
        for m in merged:
            if _touches(acc, m):
                acc = _union(acc, m)
            else:
                rest.append(m)
        merged = rest + [acc]
    return merged


@dataclass
class BlurEvent:
    x: int
    y: int
    w: int
    h: int
    start: float  # 마스터 절대 초
    end: float


def merge_events(
    frames: list[tuple[float, list[Rect]]],
    step: float,
    clip_start: float,
    clip_end: float,
) -> list[BlurEvent]:
    """프레임별 박스를 시간축으로 묶어 이벤트로.

    frames: [(마스터 절대 초, [rect, ...]), ...] 시간 오름차순.
    매칭은 이벤트의 **직전 프레임 박스**(match_rect)와 IoU 로 한다 — 누적 union 과 비교하면
    자막 줄이 바뀌어도 계속 이어져 사각형이 자란다(모듈 docstring 실측 2번).
    """
    events: list[dict] = []
    active: list[dict] = []
    for t, rects in frames:
        still = []
        for ev in active:
            if t - ev["last"] > step * 1.5:
                events.append(ev)
            else:
                still.append(ev)
        active = still
        for r in rects:
            best, best_iou = None, 0.0
            rw = max(1.0, r[2] - r[0])
            for ev in active:
                mw = max(1.0, ev["match_rect"][2] - ev["match_rect"][0])
                if min(rw, mw) / max(rw, mw) < WIDTH_SIM:
                    continue  # 폭이 크게 다르면 다른 줄 — 새 이벤트로
                v = _iou(r, ev["match_rect"])
                if v > best_iou:
                    best, best_iou = ev, v
            if best is not None and best_iou >= IOU_MATCH:
                best["rect"] = _union(best["rect"], r)
                best["match_rect"] = list(r)
                best["t1"] = t
                best["last"] = t
            else:
                active.append({"rect": list(r), "match_rect": list(r),
                               "t0": t, "t1": t, "last": t})
    events += active

    out: list[BlurEvent] = []
    for ev in events:
        x0, y0, x1, y1 = (int(round(v)) for v in ev["rect"])
        s = max(clip_start, ev["t0"] - PAD_T_IN)
        e = min(clip_end, ev["t1"] + PAD_T_OUT)
        if e <= s or x1 <= x0 or y1 <= y0:
            continue
        out.append(BlurEvent(x=x0, y=y0, w=x1 - x0, h=y1 - y0,
                             start=round(s, 3), end=round(e, 3)))
    out.sort(key=lambda v: v.start)
    return out


def filter_zone(rects: list[Rect], height: int, zone_top: float) -> list[Rect]:
    """자막 존 필터 — 박스 **중심**이 zone_top×H 위면 버린다(배경 간판 오검출 컷)."""
    ymin = height * zone_top
    return [r for r in rects
            if (r[1] + r[3]) / 2 >= ymin
            and (r[2] - r[0]) >= MIN_W and (r[3] - r[1]) >= MIN_H]


def pad_rects(rects: list[Rect], width: int, height: int) -> list[Rect]:
    return [[max(0, r[0] - PAD_XY), max(0, r[1] - PAD_XY),
             min(width, r[2] + PAD_XY), min(height, r[3] + PAD_XY)] for r in rects]


# ── DB(det) ONNX 추론 — rapidocr 기본값을 그대로 미러 ────────────────────────
# limit_type=min · limit_side=736 · thresh=0.3 · box_thresh=0.5 · unclip_ratio=1.6
# unclip 은 pyclipper 다각형 오프셋 대신 사각형 확장 근사를 쓴다: d = A·r / L (DB 논문 식).
# 자막은 직사각형에 가까워 이 근사로 충분하다(로컬 대조 실측 — rapidocr 박스와 수 px 차).
class SubtitleDetector:
    def __init__(self, model_path: str):
        import onnxruntime  # lazy — 안 켜면 불러오지도 않는다 (requirements 선택 블록)

        if not model_path or not os.path.isfile(model_path):
            raise FileNotFoundError(
                f"자막 검출 ONNX 모델이 없습니다: {model_path or '(빈 경로)'} — "
                "SUBBLUR_DET_MODEL 로 ch_PP-OCRv4_det_infer.onnx 경로를 지정하세요.")
        self.sess = onnxruntime.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name

    def detect(self, img) -> list[Rect]:
        """BGR 이미지 → 원본 좌표 박스 목록."""
        import cv2
        import numpy as np

        h, w = img.shape[:2]
        ratio = 736 / min(h, w)
        rh = max(32, int(round(h * ratio / 32)) * 32)
        rw = max(32, int(round(w * ratio / 32)) * 32)
        resized = cv2.resize(img, (rw, rh))
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        x = (resized.astype(np.float32) / 255.0 - mean) / std
        x = x.transpose(2, 0, 1)[None]
        prob = self.sess.run(None, {self.input_name: x})[0][0, 0]  # (rh, rw)

        binary = (prob > 0.3).astype(np.uint8)
        contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        sx, sy = w / rw, h / rh
        rects: list[Rect] = []
        for c in contours:
            bx, by, bw, bh = cv2.boundingRect(c)
            if bw < 8 or bh < 8:
                continue
            score = float(prob[by:by + bh, bx:bx + bw].mean())
            if score < 0.5:
                continue
            area, perim = float(bw * bh), float(2 * (bw + bh))
            d = area * 1.6 / max(1.0, perim)  # DB unclip 거리 근사
            rects.append([
                max(0.0, (bx - d) * sx), max(0.0, (by - d) * sy),
                min(float(w), (bx + bw + d) * sx), min(float(h), (by + bh + d) * sy),
            ])
        return rects


def run(frames_dir: str, model_path: str, step: float, t0: float,
        clip_end: float, zone_top: float) -> dict:
    import cv2

    paths = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
    if not paths:
        raise FileNotFoundError(f"프레임이 없습니다: {frames_dir}")
    det = SubtitleDetector(model_path)
    width = height = 0
    frames: list[tuple[float, list[Rect]]] = []
    for i, p in enumerate(paths):
        img = cv2.imread(p)
        if img is None:
            continue
        if not width:
            height, width = img.shape[:2]
        raw = det.detect(img)
        zoned = filter_zone(raw, height, zone_top)
        rects = merge_frame_rects(pad_rects(zoned, width, height))
        frames.append((t0 + i * step, rects))
    events = merge_events(frames, step, t0, clip_end)
    return {
        "version": 1,
        "step": step,
        "zoneTop": zone_top,
        "width": width,
        "height": height,
        "sampledFrames": len(frames),
        "events": [ev.__dict__ for ev in events],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="burned-in 자막 검출 → 블러 이벤트 JSON")
    ap.add_argument("--frames", required=True, help="샘플 프레임 디렉토리(*.jpg · 시간순 이름)")
    ap.add_argument("--model", default=os.environ.get("SUBBLUR_DET_MODEL", ""),
                    help="PP-OCRv4 det ONNX 경로 (기본: env SUBBLUR_DET_MODEL)")
    ap.add_argument("--step", type=float, default=0.5, help="프레임 샘플 간격(초)")
    ap.add_argument("--t0", type=float, required=True, help="첫 프레임의 마스터 절대 초")
    ap.add_argument("--clip-end", type=float, required=True, help="클립 끝 마스터 절대 초")
    ap.add_argument("--zone-top", type=float, default=0.72,
                    help="자막 존 상단(높이 비율 0~1) — 박스 중심이 이 위면 무시")
    ap.add_argument("--out", required=True, help="이벤트 JSON 출력 경로")
    args = ap.parse_args()

    result = run(args.frames, args.model, args.step, args.t0, args.clip_end, args.zone_top)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"[subtitle_blur] frames={result['sampledFrames']} events={len(result['events'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

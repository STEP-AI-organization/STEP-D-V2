"""
STEP D Core — Scene segmentation (visual units)

Splits the whole video at shot/scene changes so EVERY moment becomes a candidate —
including silent ones the STT/VAD path misses (reaction shots, sight gags, inserts).
Each scene gets a representative frame; STT dialogue is attached where it overlaps.

    영상 ──장면전환──▶ [scene…]  →  대표 프레임  +  (겹치는 STT 대사)

A scene = { index, start, end, duration, frame, text, has_dialogue }.
Silent-but-meaningful scenes come out as has_dialogue=False (frame, no text) — those
are exactly what the dialogue-only pipeline was dropping.

Run:
    python -m core.scenes core/TpQgkCs0TzE.mp4
    python -m core.scenes core/TpQgkCs0TzE.mp4 --transcript core/refined_segments.json
"""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from scenedetect import detect, ContentDetector


# 장르별 청크 크기 — 예능은 코너 단위(3분), 드라마는 서사 아크 단위(5분).
# 이 값이 narrative segment 크기·recommend 후보 seed 밀도를 결정한다.
# 예능: 코너·미션이 보통 2-4분이라 3분 청크가 한 코너를 대략 담음. 5분이면 여러 코너가 섞여
#      요약이 뭉개짐(현재 문제).
# 드라마: 씬 하나가 40-90s, 씬 여러 개가 모여 서사 블록. 5분이 자연스러움. 3분이면 한 블록이
#        여러 청크로 갈라져 감정 흐름이 끊긴다.
_CHUNK_SEC_BY_GENRE = {
    "variety": 180.0,
    "drama": 300.0,
}
_DEFAULT_CHUNK_SEC = 300.0


def scenes_from_duration_chunks(
    segments: list[dict],
    chunk_sec: float | None = None,
    pad_sec: float = 5.0,
    genre: str | None = None,
) -> list[dict]:
    """전체 길이를 장르별 청크로 자른다 — AI-driven 씬 분할 대체.

    청크 단위는 (1) 병렬 분석 유닛(각 청크가 독립 Gemini 호출 대상), (2) 요약·상세 unit.
    ±pad_sec 겹치기로 발화 중간에서 잘려 문맥이 끊기는 걸 완화 — merge 단계에서 중복 dedupe.
    쇼츠 recommend는 이 청크 경계를 무시하고 자유 start/end로 뽑으므로, 청크가 30초짜리 하이라
    이트를 갈라도 문제없다(청크는 요약 단위일 뿐 후보 seed 아님).

    반환 shape은 scenes_from_transcript와 동일해서 downstream(recommend·cast·narrative)이 그대로
    동작한다. text는 청크 시간창에 겹치는 세그먼트를 concat, has_dialogue는 그 존재 여부.

    genre — "variety"(180s) · "drama"(300s). None/알 수 없으면 300s 폴백.
    chunk_sec — 명시 값 있으면 최우선(테스트 용도). None이면 genre에서 결정."""
    if chunk_sec is None:
        chunk_sec = _CHUNK_SEC_BY_GENRE.get(genre or "", _DEFAULT_CHUNK_SEC)
    # 전체 길이 산정 — 마지막 세그먼트 end. 세그먼트 없으면 빈 리스트.
    if not segments:
        return []
    try:
        total = max(float(s.get("end", 0)) for s in segments)
    except (TypeError, ValueError):
        return []
    if total <= 0:
        return []

    chunks: list[dict] = []
    idx = 0
    t = 0.0
    while t < total:
        # 경계 pad — 첫/끝 청크는 안쪽으로만 넉넉히
        raw_end = min(t + chunk_sec, total)
        st_pad = max(0.0, t - pad_sec) if idx > 0 else 0.0
        en_pad = min(total, raw_end + pad_sec) if raw_end < total else total
        # 이 창에 겹치는 세그먼트 텍스트 모으기 (겹침 판정: seg.start < en_pad AND seg.end > st_pad)
        texts: list[str] = []
        for s in segments:
            try:
                sst, sen = float(s.get("start", 0)), float(s.get("end", 0))
            except (TypeError, ValueError):
                continue
            if sen <= st_pad or sst >= en_pad:
                continue
            txt = (s.get("text") or "").strip()
            if txt:
                texts.append(txt)
        chunks.append({
            "index": idx,
            "start": round(st_pad, 2),
            "end": round(en_pad, 2),
            "duration": round(en_pad - st_pad, 2),
            "frame": None,
            "text": " ".join(texts),
            "has_dialogue": bool(texts),
        })
        idx += 1
        t = raw_end
    return chunks


def scenes_from_transcript(segments: list[dict], max_sec: float = 18.0,
                           gap_sec: float = 1.5) -> list[dict]:
    """자막(STT) 세그먼트를 '장면'으로 묶는다 — 빠른 모드에서 시각 장면감지를 대체.

    시각 장면감지(detect)+프레임 추출이 긴 영상 분석 시간의 최대 74%를 먹는다(실측). 대사
    기반 콘텐츠는 '터지는 순간'이 곧 대사 순간이라, 자막 타임스탬프만으로 후보 구간을 만들면
    그 비용을 통째로 건너뛴다. 긴 침묵(gap)이나 누적 길이 초과에서 끊어 대사 덩어리를 만든다.
    frame은 없다(has_dialogue만) — recommend는 text 기반으로 동작하므로 문제없다."""
    chunks: list[dict] = []
    cur: dict | None = None
    for s in segments:
        try:
            st, en = float(s.get("start", 0)), float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if en <= st:
            continue
        txt = (s.get("text") or "").strip()
        if cur is None:
            cur = {"start": st, "end": en, "texts": [txt] if txt else []}
        elif (st - cur["end"]) > gap_sec or (en - cur["start"]) > max_sec:
            chunks.append(cur)
            cur = {"start": st, "end": en, "texts": [txt] if txt else []}
        else:
            cur["end"] = en
            if txt:
                cur["texts"].append(txt)
    if cur:
        chunks.append(cur)
    return [
        {"index": i, "start": round(c["start"], 2), "end": round(c["end"], 2),
         "duration": round(c["end"] - c["start"], 2), "frame": None,
         "text": " ".join(c["texts"]), "has_dialogue": bool(c["texts"])}
        for i, c in enumerate(chunks)
    ]


def detect_scenes(video_path: str, threshold: float = 27.0) -> list[tuple[float, float]]:
    """Shot boundaries as (start_sec, end_sec). Falls back to one whole-video scene.

    긴 영상(60분+)은 detect()가 전 프레임을 디코딩하느라 수십 분간 출력이 없다. 워커의
    stall 워치독(30분 무출력→강제 종료)이 이걸 '멈춤'으로 오판해 죽였다(원정대5 61분 실패).
    감지 중 60초마다 하트비트를 stdout에 찍어 워치독을 재무장시킨다 — 진짜 멈춤은 여전히 잡힌다."""
    stop = threading.Event()

    def _heartbeat() -> None:
        t0 = time.time()
        while not stop.wait(60):
            print(f"[core] 장면 감지 진행 중… ({int(time.time() - t0)}s 경과)", flush=True)

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()
    try:
        scene_list = detect(video_path, ContentDetector(threshold=threshold))
    finally:
        stop.set()
    scenes = [(s.get_seconds(), e.get_seconds()) for s, e in scene_list]
    if not scenes:  # no cuts detected (static/continuous) — treat the video as one scene
        dur = _video_duration(video_path)
        scenes = [(0.0, dur)] if dur else []
    return scenes


def _video_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return 0.0


def extract_frame(video_path: str, t: float, out_path: str) -> bool:
    """Grab a single JPEG at time t (seconds). -ss before -i = fast seek."""
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", video_path,
             "-frames:v", "1", "-q:v", "3", out_path],
            check=True,
        )
        return Path(out_path).exists()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def attach_transcript(scenes: list[tuple[float, float]], segments: list[dict]) -> list[dict]:
    """Attach each STT segment's text to the scene(s) whose time range it overlaps."""
    out = []
    for idx, (start, end) in enumerate(scenes, 1):
        texts = [
            (seg.get("text") or "").strip()
            for seg in segments
            if seg["end"] > start and seg["start"] < end and (seg.get("text") or "").strip()
        ]
        out.append({
            "index": idx,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "text": " ".join(texts),
            "has_dialogue": bool(texts),
        })
    return out


def build_scenes(
    video_path: str,
    segments: list[dict],
    frames_dir: Path,
    threshold: float = 27.0,
) -> list[dict]:
    print(f"장면 감지 중… (threshold={threshold})")
    boundaries = detect_scenes(video_path, threshold=threshold)
    print(f"   {len(boundaries)} 장면 감지")

    scenes = attach_transcript(boundaries, segments)

    frames_dir.mkdir(parents=True, exist_ok=True)
    print(f"대표 프레임 추출 중… → {frames_dir}")
    for sc in scenes:
        mid = (sc["start"] + sc["end"]) / 2
        fname = f"scene_{sc['index']:04d}.jpg"
        ok = extract_frame(video_path, mid, str(frames_dir / fname))
        sc["frame"] = f"{frames_dir.name}/{fname}" if ok else None

    return scenes


def _load_segments(transcript: Optional[str], video_path: str) -> list[dict]:
    """Prefer the refined transcript, then the pipeline output, else empty (frames only)."""
    candidates = []
    if transcript:
        candidates.append(Path(transcript))
    base = Path(video_path).parent
    candidates += [base / "refined_segments.json", base / "pipeline_output.json"]
    for p in candidates:
        if p and p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            segs = data["segments"] if isinstance(data, dict) else data
            print(f"자막 소스: {p.name} ({len(segs)} 세그먼트)")
            return segs
    print("자막 소스 없음 — 프레임만 (대사 미첨부)")
    return []


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.scenes <video> [--transcript <segments.json>] [--threshold 27]")
        sys.exit(1)

    video = sys.argv[1]
    transcript = None
    threshold = 27.0
    if "--transcript" in sys.argv:
        transcript = sys.argv[sys.argv.index("--transcript") + 1]
    if "--threshold" in sys.argv:
        threshold = float(sys.argv[sys.argv.index("--threshold") + 1])

    segments = _load_segments(transcript, video)
    out_dir = Path(video).parent
    frames_dir = out_dir / "scene_frames"

    scenes = build_scenes(video, segments, frames_dir, threshold=threshold)

    json_path = out_dir / "scenes.json"
    json_path.write_text(json.dumps(scenes, ensure_ascii=False, indent=2), encoding="utf-8")

    talk = sum(1 for s in scenes if s["has_dialogue"])
    silent = len(scenes) - talk
    print()
    print(f"완료: {len(scenes)} 장면 · 대사있음 {talk} · 무음 {silent}")
    print(f"  → 무음 {silent}개는 기존 STT 파이프라인이 놓치던 후보")
    print(f"  JSON: {json_path}")
    print(f"  프레임: {frames_dir}/")


if __name__ == "__main__":
    main()

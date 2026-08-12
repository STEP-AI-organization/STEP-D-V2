"""WhisperX 스모크 + HTML 뷰어. 결과를 refined.json 으로 저장하고 diarization_viewer 로 HTML.

사용법:
  $env:HF_TOKEN = "hf_..."
  core/.venv310/Scripts/python.exe tmp/gebd/scripts/run_whisperx_view.py \
      --src tmp/gebd/smoke_60s.mp4 --out tmp/gebd/whisperx_out --expected 3
"""
import argparse, os, sys, json, shutil, subprocess, time
from pathlib import Path

os.environ.setdefault("STT_PROVIDER", "whisperx")
sys.path.insert(0, os.getcwd())

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--expected", type=int, default=None)
ap.add_argument("--title", default="whisperx smoke")
ap.add_argument("--no-postproc", action="store_true", help="Layer 1 STT 후처리 스킵")
ap.add_argument("--no-chyron", action="store_true", help="Layer 2 chyron rewrite 스킵")
ap.add_argument("--chyron-every", type=float, default=3.0, help="chyron 샘플 간격(초)")
ap.add_argument("--ecapa-rediarize", action="store_true",
                 help="벤더 diarize 결과 버리고 ECAPA 파형 클러스터링으로 speaker 재라벨")
ap.add_argument("--ecapa-expected", type=int, default=None,
                 help="ECAPA rediarize expected speakers (KMeans k · 없으면 Agglomerative)")
ap.add_argument("--pyannote-rediarize", action="store_true",
                 help="벤더 diarize 결과 버리고 PyAnnote 3.1 로 speaker 재라벨 (HF_TOKEN 필요)")
ap.add_argument("--pyannote-expected", type=int, default=None,
                 help="PyAnnote min/max_speakers 힌트")
ap.add_argument("--pyannote-embedding", action="store_true",
                 help="PyAnnote wespeaker embedding + 세그별 클러스터링 (STT 세그 시각 그대로)")
ap.add_argument("--pyemb-threshold", type=float, default=0.65,
                 help="pyannote-embedding Agglomerative cosine 거리 threshold")
ap.add_argument("--name-fix", default="",
                 help="고유명사 오탈자 정정 매핑 (예 '류진:유식,수민:소민'). text·words·speaker 다 rewrite")
ap.add_argument("--chyron-per-seg", action="store_true",
                 help="세그별 프레임 Vision 으로 화자 이름 직접 판정 (sample chyron 대체)")
args = ap.parse_args()

src = Path(args.src).resolve()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)

# workdir 준비 (기존 diarization_viewer 는 workdir/source.mp4, refined.json, program_context.json 참조)
wd = out
video_dst = wd / "source.mp4"
if not video_dst.exists() or video_dst.stat().st_size != src.stat().st_size:
    shutil.copy2(src, video_dst)

print(f"[run] STT_PROVIDER={os.environ.get('STT_PROVIDER')}  HF_TOKEN={'set' if os.environ.get('HF_TOKEN') else 'MISSING'}")
print(f"[run] src={src} → out={out}  expected={args.expected}")

from core.stt.asr import transcribe

t0 = time.time()
r = transcribe(str(src), expected_speakers=args.expected)
dt = time.time() - t0

segs = r.get("segments", [])
speakers = sorted({s.get("speaker") or "(empty)" for s in segs})
print(f"\n[stt+diar] {dt:.1f}s · {len(segs)} 세그 · speakers={speakers}")

# ── PyAnnote rediarize (오픈 표준 · HF_TOKEN 필요) ──
if args.pyannote_rediarize:
    from core.stt.speaker_postproc import rediarize_pyannote
    segs, re_stats = rediarize_pyannote(str(src), segs, expected_speakers=args.pyannote_expected)
    print(f"[pyannote] rediarize {re_stats}")

# ── PyAnnote embedding + 세그별 클러스터링 (STT 세그 그대로 활용) ──
if args.pyannote_embedding:
    from core.stt.speaker_postproc import rediarize_pyannote_embedding
    segs, re_stats = rediarize_pyannote_embedding(
        str(src), segs, expected_speakers=args.pyannote_expected,
        distance_threshold=args.pyemb_threshold,
    )
    print(f"[pyemb] rediarize {re_stats}")

# ── ECAPA rediarize (벤더 결과 버리고 파형 클러스터링) ──
if args.ecapa_rediarize:
    from core.stt.speaker_postproc import rediarize_ecapa
    segs, re_stats = rediarize_ecapa(str(src), segs, expected_speakers=args.ecapa_expected)
    print(f"[ecapa] rediarize {re_stats}")

# ── Layer 1: STT 후처리 (문맥·짧은세그·empty 계승) ──
if not args.no_postproc:
    from core.stt.speaker_postproc import postprocess
    segs, pp_stats = postprocess(segs)
    print(f"[layer1] postproc {pp_stats}")

# ── 고유명사 오탈자 정정 (수동 name-fix 매핑) ──
if args.name_fix:
    from core.stt.speaker_postproc import rewrite_names
    name_map = {}
    for pair in args.name_fix.split(","):
        if ":" in pair:
            k, v = pair.split(":", 1)
            k, v = k.strip(), v.strip()
            if k and v:
                name_map[k] = v
    if name_map:
        segs, nf_stats = rewrite_names(segs, name_map)
        print(f"[name-fix] map={name_map} · {nf_stats}")

# ── Layer 2: chyron 기반 speaker→실명 매핑 ──
chyron_hits: list[dict] = []
chyron_map: dict[str, str] = {}
if args.chyron_per_seg:
    from core.scenes.chyron_scan import scan_per_seg
    print("[layer2] chyron-per-seg 시작 · 세그별 Vision 콜")
    segs, ps_stats = scan_per_seg(str(src), segs, workers=6, prefer_start=True)
    print(f"[layer2] {ps_stats}")
elif not args.no_chyron:
    from core.scenes.chyron_scan import (
        scan_chyron_over_video, map_speakers_from_chyron,
        apply_speaker_mapping, apply_names_per_seg,
    )
    print("[layer2] chyron 스캔 시작...")
    chyron_hits = scan_chyron_over_video(str(src), sample_every_sec=args.chyron_every)
    chyron_map, flagged = map_speakers_from_chyron(segs, chyron_hits, pad_sec=2.0, registry=None)
    rewritten = apply_speaker_mapping(segs, chyron_map)
    per_seg_fix = apply_names_per_seg(segs, chyron_hits, pad_sec=2.0)
    print(f"[layer2] global map={chyron_map} · rewritten={rewritten}세그 · per-seg fix={per_seg_fix}세그")

speakers = sorted({s.get("speaker") or "(empty)" for s in segs})
print(f"\n[final] {len(segs)} 세그 · speakers={speakers}")

# refined.json (diarization_viewer 계약)
refined = [{
    "start": s["start"], "end": s["end"], "text": s["text"],
    "speaker": s.get("speaker") or "",
    "words": s.get("words") or [],
    "align_source": s.get("align_source") or "whisperx",
} for s in segs]
(wd / "refined.json").write_text(json.dumps(refined, ensure_ascii=False, indent=2), encoding="utf-8")

# program_context.json (뷰어 헤더 title)
(wd / "program_context.json").write_text(
    json.dumps({"title": args.title, "duration_sec": segs[-1]["end"] if segs else 0}, ensure_ascii=False, indent=2),
    encoding="utf-8",
)

# 뷰어 HTML
viewer_out = wd / "viewer"
viewer_script = Path(__file__).parent / "diarization_viewer.py"
subprocess.run(
    [sys.executable, str(viewer_script), "--workdir", str(wd), "--out", str(viewer_out)],
    check=True,
)

viewer_html = (viewer_out / "viewer.html").resolve()
print(f"\n[html] file:///{str(viewer_html).replace(os.sep, '/')}")

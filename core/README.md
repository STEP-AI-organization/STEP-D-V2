# 🎬 STEP D Core Engine

AI-powered short-form content automation engine.
Korean-optimized speech recognition + clip recommendation pipeline.

## Architecture

```
core/
├── pipeline.py      ← Main orchestrator (ASR → Segment → Score)
├── asr.py           ← WhisperX speech recognition (word-level timestamps)
├── segment.py       ← Clip candidate detection + scoring
├── subtitles.py     ← SRT/VTT/ASS subtitle generation
├── downloader.py    ← YouTube video downloader (yt-dlp)
├── bridge.ts        ← Node.js integration bridge for Hono backend
├── requirements.txt
└── README.md
```

## Pipeline Flow

```
Video (.mp4)
    │
    ▼
┌──────────────┐
│  WhisperX    │  → Speech-to-Text with word timestamps
│  large-v3    │    Korean-optimized (68,000 hrs training)
└──────┬───────┘
       │ segments [{start, end, text, words}]
       ▼
┌──────────────┐
│  Segment     │  → Silence-based clip boundary detection
│  Engine      │    15s–90s optimal clip duration
└──────┬───────┘
       │ candidates [{start, end, duration, text}]
       ▼
┌──────────────┐
│  Scorer      │  → Duration fitness + position + text density
│              │    → λ score (0-100)
└──────┬───────┘
       │ recommendations (top 5)
       ▼
    📊 JSON output
    📝 SRT subtitle
```

## Quick Start

### 1. Install system dependencies
```bash
# Python 3.12 required (for WhisperX)
# ffmpeg & yt-dlp
pip install yt-dlp
```

### 2. Install Python deps
```bash
pip install -r core/requirements.txt
# For GPU: also install the CUDA 12 cuDNN runtime (see WHISPERX_GUIDE.md)
pip install nvidia-cudnn-cu12==8.9.7.29
```

### 3. Run pipeline
```bash
# CLI — run as a module from the repo root (pipeline.py uses package-relative imports,
# so `python core/pipeline.py` will NOT work).
python -m core.pipeline core/video.mp4

# Or from Python
from core.pipeline import run_pipeline
result = run_pipeline('video.mp4', language='ko')
print(result['recommendations'])
```

### 4. From Node.js backend
```ts
import { runPipeline } from '../core/bridge.js';
const result = await runPipeline('/path/to/video.mp4', { language: 'ko' });
// result.recommendations = [{ start, end, text, score }, ...]
```

## Tech Stack

| Layer | Technology | License |
|-------|-----------|---------|
| ASR | faster-whisper (CTranslate2 + whisper large-v3), VAD-filtered | MIT |
| Segmentation | silence-gap heuristic (`segment.py`) | — |
| Visual | Gemini API (future, not wired in) | Proprietary |
| Download | yt-dlp | Unlicense |

> Runtime is **faster-whisper on Python 3.10** (`core/.venv310`), not WhisperX/3.12.
> `WHISPERX_GUIDE.md` documents the WhisperX word-alignment path for later, but the
> live pipeline uses faster-whisper with `word_timestamps=True`.

## License

Apache 2.0 — based on VideoLingo's WhisperX pipeline reference implementation.

## Based On

- [VideoLingo](https://github.com/Huanshere/VideoLingo) — Apache 2.0, 17K+ stars
  - `_2_asr.py` — WhisperX ASR pipeline
  - `_3_1_split_nlp.py` — NLP sentence segmentation (reference)
  - `_3_2_split_meaning.py` — Meaning-based merging (reference)
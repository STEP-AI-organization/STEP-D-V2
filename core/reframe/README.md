# Beat AI reframe

`python -m core.reframe` is the content-worker entrypoint for the optional
`ai_multi` Shorts layout. It consumes a clip-only proxy and the source
analysis Beats, then atomically writes one automatic `fit`/`fill` decision per
Beat. Layout decisions are read-only product policy: `vision-safety-v1`, fixed
threshold 70.

## Model setup

The 1.1 MB model weight is deliberately not committed. Download the pinned
official MediaPipe BlazeFace full-range float16 model:

```powershell
core\.venv310\Scripts\python.exe -m core.reframe.download_model
```

The downloader verifies SHA-256
`3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b`
before the atomic install. Production may instead set `REFRAME_FACE_MODEL` to
an absolute model path or pass `--model`. A missing model is a hard,
deterministic error; the planner never silently renders Fill without vision.

## Worker contract

```text
python -m core.reframe \
  --video /tmp/clip-640.mp4 \
  --clip-start 120.5 --clip-end 176.0 \
  --beats /work/beats.json --shots /work/shots.json \
  --source-width 1920 --source-height 1080 \
  --model /opt/models/blaze_face_full_range.tflite \
  --output /work/reframe-plan.json
```

Proxy timestamp zero corresponds to `--clip-start`. All plan times are source
master absolute seconds. Tracking `cx`/`cy` values are normalized. The final
stdout record is `@@RESULT {json}`; failures return non-zero and do not replace
an existing output. `--shots` contains source-absolute boundaries; when it is
omitted, the CLI detects hard cuts from the proxy and rebases them automatically.

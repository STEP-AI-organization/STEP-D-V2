# STEP-D V2

AI Shorts Studio for turning long videos into vertical YouTube Shorts, connecting YouTube channels, publishing clips, scheduling uploads, and reviewing channel performance.

## Features

- Upload MP4 files or import from a YouTube URL
- Transcribe Korean audio with OpenAI STT
- Generate candidate highlight segments from the transcript
- Score top candidates with Gemini Vision
- Render 9:16 vertical Shorts with captions and title overlays
- Generate YouTube titles, descriptions, tags, hashtags, and labels
- Sign in with Google and connect YouTube channels
- Show connected channel profile, description, metrics, videos, and comments
- Prepare immediate publishing and scheduled publishing workflows
- Manage projects, schedules, channels, and auto-publish queues

## Repository Layout

```text
apps/
  api/   FastAPI, SQLite, FFmpeg, OpenAI STT, Gemini, YouTube OAuth
  web/   Next.js dashboard UI
scripts/
  dev.ps1
tests/
```

## Quick Start

Create a local environment file:

```powershell
Copy-Item .env.example .env
```

Required values:

```env
OPENAI_API_KEY=...
GEMINI_API_KEY=...
PUBLIC_BASE_URL=http://127.0.0.1:8010
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8010
WEB_BASE_URL=http://127.0.0.1:3000
```

Run the API:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd apps/api
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

Run the web app:

```powershell
npm install
npm --workspace apps/web run dev
```

Open:

- Web: http://127.0.0.1:3000
- API docs: http://127.0.0.1:8010/docs
- Health: http://127.0.0.1:8010/api/health

## YouTube OAuth Setup

Create an OAuth client in Google Cloud Console and enable YouTube Data API v3.

Register these redirect URIs:

```text
http://127.0.0.1:8010/api/auth/google/callback
http://127.0.0.1:8010/api/youtube/oauth/callback
```

Example `.env` values:

```env
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
AUTH_OAUTH_REDIRECT_URI=http://127.0.0.1:8010/api/auth/google/callback
YOUTUBE_OAUTH_REDIRECT_URI=http://127.0.0.1:8010/api/youtube/oauth/callback
SESSION_SECRET=change-me-to-a-long-random-string
```

App login and YouTube channel connection are separate flows. Sign in to the app first, then connect a YouTube channel from the Channel screen.

For local development, prefer `http://127.0.0.1:3000` instead of mixing `localhost` and `127.0.0.1`, because browser cookies are host-specific.

## Main API Endpoints

- `POST /api/upload`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/results`
- `GET /api/jobs/latest-completed`
- `GET /api/studio/summary`
- `GET /api/youtube/status`
- `GET /api/youtube/oauth/start`
- `GET /api/youtube/channel-drafts/{draft_id}`
- `POST /api/youtube/channel-drafts/{draft_id}/confirm`
- `POST /api/youtube/clips/{clip_id}/publish`
- `GET /api/youtube/channels/{channel_db_id}/analytics`

## Rendering Options

```env
RENDER_VERTICAL_SHORTS=true
SHORTS_REFRAME_MODE=blur
SHORTS_WIDTH=1080
SHORTS_HEIGHT=1920
SHORTS_SUBTITLES_ENABLED=true
SHORTS_STYLE_PRESET_DEFAULT=korean_pop
SHORTS_SUBTITLE_MODE_DEFAULT=auto
BURNED_IN_CAPTION_DETECTION_ENABLED=true
```

`SHORTS_REFRAME_MODE=blur` keeps the source video visible in the center and fills the 9:16 canvas with a blurred background copy. Use `fit` for plain preservation or `crop` for a center crop.

## Cost Controls

```env
GEMINI_MAX_EVAL_CANDIDATES=12
MAX_CANDIDATE_COUNT=30
FINAL_CLIP_COUNT=8
```

Lower `GEMINI_MAX_EVAL_CANDIDATES` to reduce Gemini Vision usage. The pipeline first narrows candidates with transcript-based local scoring, then sends only the top candidates to Gemini Vision.

## Docker

```powershell
Copy-Item .env.docker.example .env
docker compose -p ai-shorts up --build
```

Useful commands:

```powershell
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
```

## Storage

```text
storage/
  uploads/
  jobs/
  media files
```

Local SQLite data and generated media are stored under `storage/`. For production, use Postgres and object storage such as S3, GCS, or R2.

## Verification

```powershell
python -m compileall apps\api\app
npm --workspace apps/web run lint
npm --workspace apps/web run build
```

To run Python tests, install `pytest` first:

```powershell
pip install pytest
python -m pytest tests
```

## Notes

- Do not commit `.env` or real API keys.
- Keep `WEB_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, and OAuth redirect URIs aligned.
- Add the web origin to `CORS_ORIGINS` in production.
- Set public API URLs at build time for the Next.js web image.

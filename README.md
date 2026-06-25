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

## 실행하기 (Run the App)

### 방법 A — Docker로 한 번에 띄우기 (권장)

Docker Desktop을 켠 뒤, 프로젝트 루트에서:

```powershell
# 최초 1회: 환경 파일 생성 후 API 키 입력
Copy-Item .env.docker.example .env

# 서버(api) + 웹(web) 빌드 & 실행
npm run docker:up
# = docker compose -p ai-shorts up --build

# 백그라운드로 띄우려면
docker compose -p ai-shorts up --build -d
```

접속 주소:

- 웹: http://localhost:3000
- API Health: http://127.0.0.1:8010/api/health
- API Docs: http://127.0.0.1:8010/docs

관리 명령어:

```powershell
npm run docker:logs   # 로그 실시간 보기
npm run docker:down   # 중지 + 컨테이너 제거
npm run docker:build  # 이미지만 다시 빌드
```

> `web` 컨테이너는 `api` 헬스체크가 통과한 뒤 자동으로 시작됩니다. 최초 빌드는 몇 분 걸릴 수 있습니다.

### 방법 B — 로컬에서 직접 띄우기 (개발용)

Docker 없이 코드를 고치면서 띄울 때 사용합니다. **FFmpeg / ffprobe**가 PATH에 설치돼 있어야 합니다. 터미널 2개를 띄웁니다.

```powershell
# 터미널 1 — API 서버
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r apps/api/requirements.txt
cd apps/api
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

```powershell
# 터미널 2 — 웹
npm install
npm run dev:web
```

자세한 환경변수 설정은 아래 [Quick Start](#quick-start) 이하를 참고하세요.

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

## Deploy (Public / Production)

Full runbook: [deploy/runbook.md](deploy/runbook.md). Topology:

- **Web** → Vercel (`app.stepai.kr`), root dir `apps/web`, env `NEXT_PUBLIC_API_BASE_URL=https://api.stepai.kr`.
- **API** → GCP Compute Engine VM (Docker), `api.stepai.kr`, Caddy auto-HTTPS — see `docker-compose.prod.yml` + `Caddyfile`.
- **DB** → Cloud SQL for PostgreSQL via the cloud-sql-proxy sidecar.
- **Media** → GCS bucket (set `STORAGE_BACKEND=gcs`, `GCS_BUCKET`); durable clips/thumbnails served off-VM. Local dev keeps `STORAGE_BACKEND=local` (default).

Config template: `apps/api/.env.production.example`. On the VM: `bash deploy/setup-vm.sh`.

## Storage

```text
storage/
  uploads/
  jobs/
  media files
```

Local SQLite data and generated media are stored under `storage/`. For production, set `STORAGE_BACKEND=gcs` + `GCS_BUCKET` so durable artifacts (clips, thumbnails, highlights, assets) mirror to Google Cloud Storage; 2GB source uploads and temp files stay on the VM disk.

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

# AI Shorts Studio

OpusClip 스타일을 벤치마킹한 비용 효율형 AI 쇼츠 생성 MVP입니다. 긴 MP4를 업로드하면 OpenAI Speech-to-Text로 전체 전사를 만든 뒤, transcript 기반으로 후보 구간을 먼저 줄이고, Gemini Vision은 상위 후보의 대표 프레임만 평가합니다.

절대로 전체 영상을 Gemini에 보내지 않습니다.

## Monorepo

```text
apps/
  api/   FastAPI, SQLite, FFmpeg, OpenAI STT, Gemini Vision
  web/   Next.js dashboard UI
scripts/
  dev.ps1
```

## Pipeline

1. MP4 업로드
2. FFmpeg로 `audio.wav` 추출
3. OpenAI STT로 timestamp 포함 전체 전사
4. transcript 훅 키워드와 정보 밀도로 20-30개 후보 생성
5. 후보별 대표 프레임 3-5장 추출
6. Gemini Vision은 `GEMINI_MAX_EVAL_CANDIDATES`만 JSON 평가
7. Gemini 실패 시 STT 기반 fallback 점수로 계속 진행
8. 상위 `FINAL_CLIP_COUNT`개를 FFmpeg로 컷팅
9. 기본값으로 9:16 세로 캔버스에 원본 화면 전체를 맞추고 실제 프레임 썸네일 생성
10. YouTube 업로드용 title, description, tags, hashtags, labels 생성

## API

- `POST /api/upload`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/latest-completed`
- `GET /api/jobs/{job_id}/results`
- `GET /api/jobs/{job_id}/debug`
- `GET /api/render-templates`
- `POST /api/jobs/{job_id}/assets`
- `POST /api/clips/{clip_id}/titles/regenerate`
- `POST /api/clips/{clip_id}/creative/apply`
- `GET /api/clips/{clip_id}/youtube-package`
- `GET /api/health`

`/results`의 각 clip에는 `video_url`, `thumbnail_url`, 점수, transcript, 그리고 `youtube_metadata`가 포함됩니다.

## Setup

```powershell
cp .env.example .env
```

`.env`에 API 키를 넣습니다.

```env
OPENAI_API_KEY=...
GEMINI_API_KEY=...
PUBLIC_BASE_URL=http://127.0.0.1:8010
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8010
```

백엔드:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd apps/api
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

프론트엔드:

```powershell
cd apps/web
npm install
npm run dev
```

Open:

- Web: http://localhost:3000
- API docs: http://127.0.0.1:8010/docs
- Health: http://127.0.0.1:8010/api/health

## Docker

The project is split into two deployable containers:

- `apps/api/Dockerfile`: FastAPI + FFmpeg, storing SQLite and generated media in `/data`
- `apps/web/Dockerfile`: Next.js production server

Local compose:

```powershell
cp .env.docker.example .env
docker compose -p ai-shorts up --build
```

Docker Desktop must be running before executing compose commands on Windows.

Open:

- Web: http://localhost:3000
- API: http://127.0.0.1:8010
- API health: http://127.0.0.1:8010/api/health

Useful commands:

```powershell
npm run docker:build
npm run docker:up
npm run docker:logs
npm run docker:down
```

Cloud notes:

- API image:

```powershell
docker build -f apps/api/Dockerfile -t ai-shorts-api:latest .
```

- Web image:

```powershell
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com -t ai-shorts-web:latest .
```

- Build/push `apps/api/Dockerfile` and `apps/web/Dockerfile` as separate services.
- Mount persistent storage to `/data` for the API container, or replace SQLite/local media with Postgres plus object storage.
- Set `PUBLIC_BASE_URL` to the public API origin so generated media URLs are browser-visible.
- Set `NEXT_PUBLIC_API_BASE_URL` at web image build time. Next public env values are bundled into the browser build.
- Set `CORS_ORIGINS` to a JSON list containing the web origin, for example `["https://app.example.com"]`.
- Put `OPENAI_API_KEY` and `GEMINI_API_KEY` in the cloud secret manager, not in the image.

## Cost Controls

```env
GEMINI_MAX_EVAL_CANDIDATES=12
MAX_CANDIDATE_COUNT=30
FINAL_CLIP_COUNT=8
```

Gemini 비용을 줄이려면 `GEMINI_MAX_EVAL_CANDIDATES`를 6-8로 낮추세요. 후보 탐지는 OpenAI STT 결과와 로컬 휴리스틱으로 먼저 수행됩니다.

## Cut Boundary Refinement

```env
BOUNDARY_REFINE_ENABLED=true
BOUNDARY_MAX_SECONDS=70
BOUNDARY_START_LOOKBACK_SECONDS=6
BOUNDARY_END_LOOKAHEAD_SECONDS=8
BOUNDARY_PRE_PADDING_SECONDS=0.4
BOUNDARY_POST_PADDING_SECONDS=0.8
```

STT `segments`와 `words` timestamp를 이용해 후보 구간의 시작/끝을 문장 경계에 맞춥니다. 목표는 문장 중간 진입과 중간 종료를 줄이고, 최종 렌더가 20-70초 안에서 자연스럽게 끝나도록 보정하는 것입니다.

## Korean STT Tips

```env
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_TRANSCRIBE_LANGUAGE=ko
OPENAI_TRANSCRIBE_PROMPT=한국어 방송, 예능, 인터뷰, 토크쇼 영상입니다. 사람 이름, 지명, 고유명사, 감탄사, 반말과 존댓말을 가능한 한 원문 그대로 전사하세요.
FFMPEG_AUDIO_FILTER=loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000
```

고유명사, 출연자 이름, 프로그램명, 자주 나오는 은어를 `OPENAI_TRANSCRIBE_PROMPT`에 추가하면 한국어 인식 품질이 좋아집니다.

## Shorts Rendering

```env
RENDER_VERTICAL_SHORTS=true
SHORTS_REFRAME_MODE=blur
SHORTS_WIDTH=1080
SHORTS_HEIGHT=1920
SHORTS_BACKGROUND_COLOR=black
SHORTS_BLUR_BACKGROUND_STRENGTH=24
SHORTS_TITLE_OVERLAY=true
SHORTS_VIDEO_FADE_SECONDS=0.15
SHORTS_AUDIO_FADE_SECONDS=0.12
SHORTS_SUBTITLES_ENABLED=true
SHORTS_STYLE_PRESET_DEFAULT=korean_pop
SHORTS_SUBTITLE_MODE_DEFAULT=auto
SHORTS_SUBTITLE_FONT_NAME=G마켓 산스 TTF Bold
SHORTS_SUBTITLE_FONTS_DIR=
SHORTS_SUBTITLE_HIGHLIGHT_ENABLED=true
SHORTS_SUBTITLE_HIGHLIGHT_COLOR=&H0000E6FF
SHORTS_SUBTITLE_OUTLINE=5
SHORTS_SUBTITLE_SHADOW=2
BURNED_IN_CAPTION_DETECTION_ENABLED=true
BURNED_IN_CAPTION_DETECTION_CONFIDENCE_THRESHOLD=0.72
```

방송 영상은 원본 자막과 로고가 잘리지 않도록 `fit` 모드를 기본으로 사용합니다. 원본 화면을 9:16 캔버스 안에 축소해서 넣고, 위아래 검은 여백에 쇼츠 제목을 오버레이합니다.

강제로 화면을 꽉 채우는 중앙 크롭이 필요하면 `SHORTS_REFRAME_MODE=crop`으로 바꿀 수 있습니다. 얼굴 추적 스마트 리프레임은 다음 단계로 확장할 수 있습니다.

`SHORTS_REFRAME_MODE=blur` is the default Korean Shorts render style: the source video stays fully visible in the center while a blurred full-screen copy fills the 9:16 canvas. Use `fit` for plain preservation, or `crop` for a full-frame center crop.

Caption mode is selected per upload with `subtitle_mode=auto|on|off`.
Caption style is selected per upload with `style_preset=korean_pop|clean|news|custom`; `korean_pop` is the default bold Korean Shorts look, `clean` keeps captions minimal, and `news` uses a tighter high-contrast layout.
`auto` and `on` both skip extra ASS captions when ffprobe detects an existing subtitle stream in the source MP4.
When enabled, Gemini Vision also checks already-extracted source frames for visually burned-in dialogue captions and skips generated captions if confidence passes `BURNED_IN_CAPTION_DETECTION_CONFIDENCE_THRESHOLD`.
If the source already has visually burned-in captions and you want to force no extra captions, choose `None` in the UI or send `subtitle_mode=off`.
The default caption font is the bundled Gmarket Sans TTF Bold, selected for Korean Shorts-style bold readability and permissive video/subtitle usage. Captions use a thick black outline, light shadow, and automatic hook-term color emphasis.

## Creative Review

완료된 clip 모달에서 제목 후보 5개를 재생성하고, 선택한 제목을 위 검은 여백 텍스트로 재렌더할 수 있습니다. Overlay 탭에서는 기본 텍스트 배지 템플릿이나 사용자가 업로드한 PNG/JPG를 합성할 수 있습니다.

YouTube 탭은 직접 OAuth 업로드 대신 `short.mp4`, `thumbnail.jpg`, `metadata.json`, `description.txt`, `tags.csv`, `upload-checklist.txt`가 들어있는 클립별 ZIP 패키지를 생성합니다.

## Storage

```text
apps/api/storage/
  uploads/{job_id}/source.mp4
  jobs/{job_id}/audio.wav
  jobs/{job_id}/transcripts/transcript.json
  jobs/{job_id}/candidates.json
  jobs/{job_id}/evaluations.json
  jobs/{job_id}/assets/{asset_id}.png
  jobs/{job_id}/clips/short_001.mp4
  jobs/{job_id}/thumbnails/short_001.jpg
  jobs/{job_id}/packages/clip_001_youtube_package.zip
```

## Production Path

- BackgroundTasks를 Celery/RQ/Dramatiq로 교체
- SQLite를 Postgres로 교체
- Local File System을 S3/GCS/R2로 교체
- 얼굴 추적 기반 9:16 리프레임 추가
- 플랫폼별 제목 A/B 테스트와 업로드 자동화 추가
- 인증, quota, signed URL, moderation 추가
#   S T E P - D - V 2  
 
# AI Shorts Studio

OpusClip 스타일을 벤치마킹한 AI 쇼츠 생성 MVP입니다. 긴 MP4를 업로드하면 OpenAI Speech-to-Text로 전체 전사를 만들고, transcript 기반으로 후보 구간을 먼저 줄인 뒤, 상위 후보의 대표 프레임만 Gemini Vision으로 평가합니다.

중요 원칙: 전체 영상을 Gemini에 보내지 않습니다. 비용 절감을 위해 STT와 로컬 휴리스틱으로 1차 후보를 만들고, 제한된 후보만 Gemini로 검증합니다.

## Monorepo

```text
apps/
  api/   FastAPI, SQLite, FFmpeg, OpenAI STT, Gemini Vision, YouTube upload
  web/   Next.js dashboard, clip editor, publishing UI
scripts/
  dev.ps1
```

## Pipeline

1. MP4 업로드
2. FFmpeg로 `audio.wav` 추출
3. OpenAI STT로 timestamp 포함 전체 전사
4. transcript의 훅/반전/감정/정보 밀도 기반 후보 20-30개 생성
5. 후보별 대표 프레임 3-5장 추출
6. `GEMINI_MAX_EVAL_CANDIDATES` 수만 Gemini Vision JSON 평가
7. Gemini 실패 시 STT 기반 fallback 점수로 계속 진행
8. 상위 `FINAL_CLIP_COUNT`개를 FFmpeg로 컷팅
9. 기본값으로 9:16 캔버스에 원본 화면을 축소 배치하고, 위쪽 여백에 쇼츠 제목 오버레이
10. 실제 영상 프레임으로 썸네일 생성
11. YouTube 업로드용 title, description, tags, labels 생성

## API

- `POST /api/upload`
- `GET /api/videos`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/results`
- `GET /api/jobs/{job_id}/debug`
- `PATCH /api/clips/{clip_id}`
- `POST /api/clips/{clip_id}/rerender`
- `GET /api/youtube/config`
- `GET /api/youtube/oauth/start`
- `GET /api/youtube/oauth/callback`
- `GET /api/youtube/channels`
- `POST /api/youtube/channels/{channel_id}/default`
- `POST /api/clips/{clip_id}/youtube/publish`
- `POST /api/jobs/{job_id}/youtube/auto-publish`
- `GET /api/youtube/publishes`
- `GET /api/health`

`/results`의 각 clip에는 `video_url`, `thumbnail_url`, 점수, transcript, editor project, YouTube metadata가 포함됩니다.

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

Backend:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd apps/api
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

Frontend:

```powershell
cd apps/web
npm install
npm run dev
```

Open:

- Web: http://localhost:3000
- API docs: http://127.0.0.1:8010/docs
- Health: http://127.0.0.1:8010/api/health

## Cost Controls

```env
GEMINI_MODEL=gemini-3.5-flash
GEMINI_MAX_EVAL_CANDIDATES=12
MAX_CANDIDATE_COUNT=30
FINAL_CLIP_COUNT=8
```

Gemini 비용을 더 줄이려면 `GEMINI_MAX_EVAL_CANDIDATES`를 6-8로 낮추세요. 후보 생성은 OpenAI STT 결과와 로컬 랭킹으로 먼저 수행됩니다.

## Korean STT Tips

```env
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_TRANSCRIBE_LANGUAGE=ko
OPENAI_TRANSCRIBE_PROMPT=한국어 방송, 예능, 인터뷰, 토크쇼 영상입니다. 사람 이름, 지명, 고유명사, 감탄사, 반말과 존댓말을 가능한 한 자연스럽게 전사하세요.
FFMPEG_AUDIO_FILTER=loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=12000
```

출연자 이름, 프로그램명, 자주 나오는 고유명사를 `OPENAI_TRANSCRIBE_PROMPT`에 추가하면 한국어 인식 품질이 좋아질 수 있습니다.

## Shorts Rendering

```env
RENDER_VERTICAL_SHORTS=true
SHORTS_REFRAME_MODE=fit
SHORTS_WIDTH=1080
SHORTS_HEIGHT=1920
SHORTS_BACKGROUND_COLOR=black
SHORTS_TITLE_OVERLAY=true
SHORTS_TITLE_FONT_SIZE=72
SHORTS_TITLE_PRIMARY_COLOR=white
SHORTS_TITLE_ACCENT_COLOR=0xFFE600
SHORTS_TITLE_OUTLINE_WIDTH=5
```

방송 영상은 원본 자막과 로고가 잘리지 않도록 `fit` 모드를 기본으로 사용합니다. 원본 화면 전체를 9:16 캔버스 중앙에 축소 배치하고, 위쪽 검은 여백에 쇼츠 제목을 오버레이합니다. 제목은 최대 2줄이며 마지막 줄의 핵심 단어를 노란색으로 강조합니다.

강제로 화면을 꽉 채우는 중앙 크롭이 필요하면 `SHORTS_REFRAME_MODE=crop`으로 바꿀 수 있습니다. 얼굴 추적 기반 리프레임은 2단계 확장 항목입니다.

## YouTube Publishing

현재 흐름은 Google 로그인으로 YouTube 채널을 연결하고, SQLite에 채널 토큰을 저장한 뒤, 선택한 채널로 쇼츠를 업로드합니다.

```env
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_OAUTH_REDIRECT_URI=http://127.0.0.1:8010/api/youtube/oauth/callback
WEB_BASE_URL=http://127.0.0.1:3000
YOUTUBE_CATEGORY_ID=24
YOUTUBE_DEFAULT_PRIVACY_STATUS=private
YOUTUBE_UPLOAD_TIMEOUT_SECONDS=3600

# Legacy fallback only. Prefer Google login from the app.
YOUTUBE_REFRESH_TOKEN=
```

Google Cloud Console 설정:

1. YouTube Data API v3를 활성화합니다.
2. OAuth Client ID를 `Web application` 타입으로 생성합니다.
3. Authorized redirect URIs에 `http://127.0.0.1:8010/api/youtube/oauth/callback`을 추가합니다.
4. `.env`에 `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`을 설정합니다.
5. 앱의 YouTube channel 영역에서 `Connect Google`을 누릅니다.

연결 후 `/api/youtube/channels`는 다음 정보를 반환합니다.

- Google 프로필 이름, 이메일, 프로필 이미지
- YouTube 채널 ID, 채널명, 채널 썸네일
- 기본 채널 여부
- `upload_ready`: 서버가 업로드 가능한 access token 또는 refresh token을 가지고 있는지 여부

업로드는 선택된 채널의 refresh token으로 access token을 갱신한 뒤 YouTube resumable upload를 사용합니다. 썸네일 업로드 실패는 성공한 영상 업로드를 취소하지 않고 publish metadata에 실패 이유만 저장합니다.

Auto publish 옵션:

- 공개범위: `private`, `unlisted`, `public`
- 예약 시간: 입력 시 YouTube에는 private scheduled upload로 전송, 현재 시각보다 최소 15분 이후만 허용
- 자동 업로드 개수: 1-10
- 최소 점수: 0-100
- 중복 방지: 이미 pending/uploading/scheduled/published인 clip은 건너뜀

## Editor

clip 상세에서 `편집` 버튼을 누르면 AENA 스타일 편집 워크스페이스가 열립니다.

- 9:16 미리보기 캔버스
- IN/OUT 기반 segment 추가/삭제
- 하단 타임라인과 재생 컨트롤
- 텍스트 오버레이 추가/선택/수정
- editor project 저장
- 저장 후 FFmpeg 렌더링

편집 프로젝트는 `Clip.evaluation_json.editor_project`에 저장됩니다. 렌더러는 여러 segment를 잘라 합치고, 최종 9:16 캔버스에 상단 제목과 텍스트 오버레이를 반영합니다.

## Storage

```text
apps/api/storage/
  uploads/{job_id}/source.mp4
  jobs/{job_id}/audio.wav
  jobs/{job_id}/transcripts/transcript.json
  jobs/{job_id}/candidates.json
  jobs/{job_id}/evaluations.json
  jobs/{job_id}/clips/short_001.mp4
  jobs/{job_id}/thumbnails/short_001.jpg
```

## Production Path

- FastAPI `BackgroundTasks`를 Celery, RQ, Dramatiq 같은 외부 큐로 교체
- SQLite를 Postgres로 교체
- Local File System을 S3, GCS, R2로 교체
- 얼굴 추적 기반 9:16 자동 리프레임 추가
- 플랫폼별 제목 A/B 테스트와 예약 업로드 자동화 추가
- 인증, quota 관리, signed URL, moderation 추가

# STEP D — System Architecture

## 기술 스택 요약

| Layer | 기술 |
|-------|------|
| **Frontend** | Next.js 16.3 (App Router), React 19, TypeScript 5.7 |
| **Backend** | FastAPI (Python 3.12), SQLAlchemy ORM, Uvicorn |
| **DB** | SQLite (로컬) / PostgreSQL via Cloud SQL (프로덕션) |
| **AI** | OpenAI Whisper (STT) + Google Gemini (영상 분석/PPL/캡션 탐지) |
| **Video** | FFmpeg (컷·렌더링·자막 번인) |
| **YouTube** | yt-dlp (다운로드) + YouTube Data API v3 (업로드·분석) |
| **Storage** | 로컬 파일시스템 (개발) / GCS 버킷 (프로덕션) |
| **Infra** | Docker Compose, Caddy (HTTPS 리버스 프록시), GCP Compute Engine VM |

---

## 모노레포 구조

```
STEP-D-V2/
├── apps/
│   ├── api/              # FastAPI 백엔드
│   │   ├── app/
│   │   │   ├── api/routes.py        # 모든 HTTP 엔드포인트
│   │   │   ├── core/config.py       # 환경변수 설정
│   │   │   ├── models.py            # DB 모델 (SQLAlchemy)
│   │   │   ├── services/            # 비즈니스 로직
│   │   │   └── prompts/             # LLM 프롬프트
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   ├── web/              # Next.js 프론트엔드
│   │   ├── app/
│   │   │   ├── page.tsx             # 메인 대시보드
│   │   │   ├── components/
│   │   │   │   └── ShortcutEditor.tsx  # 클립 에디터
│   │   │   └── globals.css
│   │   ├── lib/api.ts               # API 클라이언트
│   │   └── Dockerfile
│   └── docs/             # 이 문서들
├── docker-compose.yml        # 로컬 개발
├── docker-compose.prod.yml   # GCP 프로덕션
├── Caddyfile                 # HTTPS 리버스 프록시 설정
└── deploy.ps1                # 배포 스크립트 (Windows)
```

---

## 프로덕션 인프라 (GCP)

```
인터넷
  │
  ▼
Caddy (443/HTTPS, Let's Encrypt 자동 인증)
  │  stepd-api.stepai.kr → api:8010
  │
  ▼
FastAPI (api:8010)
  ├── Cloud SQL Proxy (5432) → PostgreSQL (Cloud SQL)
  ├── /data 볼륨 (SSD 마운트, 원본/클립/썸네일 저장)
  └── GCS 버킷 (렌더링된 클립·썸네일 미러)

GCP VM (STEPAI05)
  ├── docker compose: caddy, api, cloud-sql-proxy
  └── /home/STEPAI05/app/ (소스코드 체크아웃)
```

**환경변수 위치 (VM):**
- `/home/STEPAI05/app/.env` — docker compose용 (`API_DOMAIN`, `ACME_EMAIL`, `INSTANCE_CONNECTION_NAME`, `DATA_DIR`)
- `/home/STEPAI05/app/apps/api/.env.production` — API 앱용 (API 키, `GEMINI_MODEL`, `SHORTS_SUBTITLE_FONT_NAME` 등)

---

## DB 모델

```
Job
  id (str, UUID)
  status (enum: pending/processing/completed/failed)
  original_filename
  input_path
  duration (float, seconds)
  progress (int, 0-100)
  error (str, nullable)
  metadata_json
  ├── clips → [Clip]
  └── publishes → [YouTubePublish]

Clip
  id, job_id, rank
  title, score, local_score, gemini_score
  start_time, end_time (seconds)
  reason (AI 선택 이유)
  video_url, thumbnail_url
  thumbnail_text, best_frame_time
  transcript
  evaluation_json    # Gemini 평가 상세
  ppl_analysis_json  # PPL 탐지 결과

YouTubePublish
  id, clip_id, job_id
  status (enum: draft/uploading/published/scheduled/failed)
  title, description, tags_json
  privacy_status, category_id, schedule_date
  youtube_video_id, youtube_url
  metadata_json

YouTubeChannel
  id, channel_id, title
  access_token, refresh_token, expires_at
  is_default (bool)

User
  id, google_sub, email, name, picture_url
```

---

## API 엔드포인트 목록

### 영상 처리

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health` | 헬스체크, ffmpeg 가용 여부, 설정값 확인 |
| POST | `/api/upload` | MP4 업로드 (최대 2048MB), job_id 반환 |
| POST | `/api/jobs/from-youtube` | YouTube URL로 영상 임포트 |
| POST | `/api/videos/inspect` | 업로드된 영상 검증 (duration, 자막 스트림) |
| GET | `/api/jobs/{job_id}` | 작업 상태/진행률 조회 |
| DELETE | `/api/jobs/{job_id}` | 작업 삭제 (클립·파일 전부 삭제) |
| GET | `/api/jobs/{job_id}/results` | 완료된 작업의 최종 클립 목록 |
| GET | `/api/jobs/{job_id}/debug` | 디버그 뷰 (트랜스크립트·후보·평가 데이터) |
| GET | `/api/jobs/latest-completed` | 가장 최근 완료 작업 |
| GET | `/api/studio/summary` | 대시보드: 최근 작업·클립·발행 일정 |

### 클립 편집

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/clips/{clip_id}/download` | 클립 MP4 다운로드 |
| GET | `/api/clips/{clip_id}/youtube-package` | ZIP 다운로드 (MP4+썸네일+메타데이터) |
| POST | `/api/clips/{clip_id}/retrim` | 클립 시작/끝 조정 → 재렌더링 |
| POST | `/api/clips/{clip_id}/creative/apply` | 템플릿·오버레이·제목 적용 → 재렌더링 |
| POST | `/api/clips/{clip_id}/titles/regenerate` | 제목 옵션 재생성 (Gemini) |
| POST | `/api/clips/{clip_id}/thumbnails/regenerate` | 썸네일 텍스트 재생성 |
| POST | `/api/clips/{clip_id}/ppl` | PPL 분석 실행 |
| PATCH | `/api/clips/{clip_id}/ppl/links` | PPL 제품 어필리에이트 링크 저장 |
| POST | `/api/jobs/{job_id}/assets` | 오버레이 이미지 업로드 |
| POST | `/api/jobs/{job_id}/highlights/render` | 하이라이트 편집본 렌더링 |

### PPL 리포트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/clips/{clip_id}/ppl` | PPL 분석 실행 (Gemini Vision) |
| PATCH | `/api/clips/{clip_id}/ppl/links` | 어필리에이트 링크 저장 |
| GET | `/api/jobs/{job_id}/ppl-report` | 잡 레벨 브랜드별 통합 집계 |
| GET | `/api/jobs/{job_id}/ppl-report/csv` | CSV 내보내기 (UTF-8 BOM) |

### 편집 제안

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/jobs/{job_id}/silence-report` | 원본 영상 무음 구간 탐지 (noise_db, min_duration 파라미터) |

### YouTube 연동

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/youtube/oauth/start` | OAuth 동의 URL 반환 |
| GET | `/api/youtube/oauth/callback` | OAuth 콜백 처리 |
| GET | `/api/youtube/status` | 연결된 채널·기본 채널 조회 |
| POST | `/api/youtube/clips/{clip_id}/publish` | YouTube 업로드/예약 |
| GET | `/api/youtube/channels/{channel_id}/analytics` | 채널 지표 조회 |
| GET | `/api/youtube/clips/{clip_id}/comments` | 댓글 목록 (`?summarize=true`로 AI 요약 포함) |
| GET | `/api/clips/{clip_id}/youtube-stats` | 클립 실시간 성과 (조회수·좋아요·댓글 수) |

---

## AI 파이프라인 흐름

```
1. 업로드 / YouTube 다운로드
   ↓
2. ffprobe → duration, 자막 스트림 탐지
   ↓
3. extract_audio() → OpenAI Whisper → transcript JSON (세그먼트별 timestamp)
   ↓
4. detect_candidates()
   훅 키워드(충격·반전·경고·감정 등) 기반으로 후보 구간 추출
   local_score 계산 (transcript 기반)
   ↓
5. evaluate_candidate() × N (Gemini Vision)
   - hook_score, emotion_score, retention_score, shareability_score
   - 최종 gemini_score 산출
   - 82% Gemini + 18% local = final_score
   ↓
6. refine_boundaries()
   - 정확한 발화 시작/끝으로 경계 미세 조정
   - 한국어 종결어미(다/요/죠/네 등) + 마침표 기반 문장 끝 스냅
   - max 길이 초과 시에도 동일 기준 적용
   ↓
7. 상위 N개 클립 렌더링 (ffmpeg)
   - 9:16 1080×1920 버티컬 쇼츠
   - blur background (원본 종횡비 유지)
   - ASS 자막 번인 (Noto Sans CJK KR)
   - 오디오 정규화 (loudnorm)
   - 페이드 인/아웃
   ↓
8. extract_thumbnail() → JPEG (best_frame_time 기준)
   ↓
9. DB 저장 → Job.status = completed
```

**진행률 매핑:**
- 0–10%: 다운로드/업로드
- 10–30%: STT 트랜스크립션
- 30–52%: 후보 탐지
- 52–80%: Gemini 후보 평가 (마지막 후보가 80%)
- 80–95%: 클립 렌더링
- 95–100%: 썸네일·DB 저장

---

## 스토리지 구조

```
/data (또는 로컬 ./storage)
├── uploads/{job_id}/source.mp4
├── jobs/{job_id}/
│   ├── job/
│   │   ├── candidates.json
│   │   └── evaluations.json
│   ├── clips/
│   │   ├── short_001.mp4
│   │   └── short_001.ass
│   ├── thumbnails/
│   │   └── short_001.jpg
│   ├── highlights/
│   ├── transcripts/transcript.json
│   ├── frames/ (임시)
│   └── assets/{overlay_id}.png
└── app.db (SQLite — 로컬 전용)
```

**GCS 미러 (프로덕션):**
클립·썸네일·하이라이트·에셋은 GCS 버킷에 미러됨 → VM 교체 후에도 미디어 생존

---

## 핵심 설정값 (config.py 기본값)

| 설정 | 값 | 의미 |
|------|-----|------|
| `gemini_model` | gemini-3.5-flash | PPL/후보 평가 모델 |
| `final_clip_count` | 8 | 영상당 최종 클립 수 |
| `min_clip_seconds` | 20 | 최소 클립 길이 |
| `max_clip_seconds` | 75 | 최대 클립 길이 |
| `target_clip_seconds` | 38 | 목표 클립 길이 |
| `shorts_width/height` | 1080 × 1920 | 쇼츠 해상도 |
| `shorts_reframe_mode` | blur | 배경 처리 방식 |
| `shorts_subtitle_font_name` | G마켓 산스 TTF Bold | 자막 폰트 (Dockerfile 설치 완료, VM env override 해제 필요) |
| `ppl_max_frames` | 8 | PPL 분석 최대 프레임 수 |
| `ppl_min_confidence` | 0.35 | PPL 탐지 최소 신뢰도 |

# STEP D — 개발 & 배포 가이드

---

## 로컬 개발 환경

### 전제 조건

- Python 3.12
- Node.js 20+
- Docker Desktop
- ffmpeg (PATH에 등록)
- OpenAI API 키, Google Gemini API 키

### 백엔드 실행

```bash
cd apps/api
python -m venv .venv
.venv/Scripts/activate      # Windows
pip install -r requirements.txt

# 환경변수 (.env 파일 생성)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash

uvicorn app.main:app --reload --port 8010
```

API 문서: http://127.0.0.1:8010/docs

### 프론트엔드 실행

```bash
cd apps/web
npm install
npm run dev   # http://localhost:3000
```

### Docker로 통합 실행 (로컬)

```bash
# 루트에서
docker compose up --build
```

docker-compose.yml: API(8010) + Web(3000)  
Storage는 `./storage/` 로컬 볼륨 마운트

---

## 프로덕션 배포 (GCP VM)

### 배포 흐름

```
개발자 머신                     GCP VM (STEPAI05)
─────────────────────────────────────────────────
git commit + git push
    ↓
gcloud ssh → VM에서:
    git pull origin main
    docker compose --env-file apps/api/.env.production \
        -f docker-compose.prod.yml up -d --build
```

> **주의:** SCP 방식은 `/home/STEPAI05/` 권한 문제로 동작하지 않음.  
> 반드시 VM에서 직접 `git pull` + `docker compose up --build` 순서를 따를 것.

### 배포 명령 (로컬에서 한 줄로)

```powershell
gcloud compute ssh shorts-api --project=step-d --zone=asia-northeast3-a `
  --command="sudo bash -c 'cd /home/STEPAI05/app && git pull origin main && docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build 2>&1'"
```

### 배포 스크립트 위치

| 파일 | 역할 |
|------|------|
| `deploy.ps1` | 개발자 머신에서 실행하는 Windows 스크립트 (SCP 방식 — 현재 권한 문제로 미사용) |
| `deploy/deploy.sh` | VM-side 빌드/재시작/헬스체크 스크립트 |
| `deploy/runbook.md` | 최초 VM 세팅 전체 절차 |

---

## VM 환경 설정

### 필수 환경변수 파일

**`/home/STEPAI05/app/.env`** (docker compose용)
```
INSTANCE_CONNECTION_NAME=step-d:asia-northeast3:shorts-pg
API_DOMAIN=stepd-api.stepai.kr
ACME_EMAIL=hkj@stepai.kr
DATA_DIR=/data
```

**`/home/STEPAI05/app/apps/api/.env.production`** (FastAPI 앱용)
```
DATABASE_URL=postgresql://...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
STORAGE_BACKEND=gcs
GCS_BUCKET=...
SHORTS_SUBTITLE_FONT_NAME=Noto Sans CJK KR
PUBLIC_BASE_URL=https://stepd-api.stepai.kr
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
```

### VM 접속

```bash
gcloud compute ssh STEPAI05 --project=step-d --zone=asia-northeast3-a
```

### 컨테이너 상태 확인

```bash
# VM에서
cd /home/STEPAI05/app
docker compose ps
docker compose logs api --tail=50
docker compose logs caddy --tail=20
```

### 수동 재시작

```bash
docker compose up -d --force-recreate api
```

---

## Docker 이미지 구조

### apps/api/Dockerfile

```dockerfile
# Stage 1: Deno 바이너리 추출 (yt-dlp JS 복호화용)
FROM denoland/deno:bin AS deno-bin

# Stage 2: 런타임
FROM python:3.12-slim AS runtime
COPY --from=deno-bin /deno /usr/local/bin/deno

# 시스템 패키지
RUN apt-get install -y ffmpeg curl ca-certificates fonts-noto-cjk nodejs

# Python 의존성
COPY requirements.txt .
RUN pip install -r requirements.txt

EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
```

**중요:** `docker cp`로 추가한 파일은 컨테이너 재생성 시 사라짐.  
코드 변경은 반드시 git commit → docker compose build → up 순서를 따를 것.

---

## 주요 설정 변경 방법

### Gemini 모델 변경

`.env.production`에서:
```
GEMINI_MODEL=gemini-3.5-flash
```
컨테이너 재시작 불필요 — 환경변수 변경 후 `docker compose up -d api`

### 자막 폰트 변경

G마켓 산스 TTF는 Dockerfile에 이미 설치됨 (`apps/api/assets/fonts/GmarketSansTTF*.ttf` → `/usr/share/fonts/truetype/gmarket/`).

**VM에서 활성화하려면:**  
`/home/STEPAI05/app/apps/api/.env.production`에서 아래 줄을 **삭제** (또는 주석 처리):
```
SHORTS_SUBTITLE_FONT_NAME=Noto Sans CJK KR   ← 이 줄 제거
```
제거 후 이미지 재빌드 없이 컨테이너 재시작만으로 적용됨:
```bash
sudo docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d api
```

### 클립 설정 (클립 수·길이 등)

`apps/api/app/core/config.py`에서 기본값 변경, 또는 `.env.production`에서 오버라이드:
```
FINAL_CLIP_COUNT=8
MIN_CLIP_SECONDS=20
MAX_CLIP_SECONDS=75
TARGET_CLIP_SECONDS=38
```

---

## 도메인 구조

| 도메인 | 역할 |
|--------|------|
| `stepd-api.stepai.kr` | Caddy → FastAPI (API + 미디어 서빙) |
| (프론트엔드) | Vercel 배포 (별도 repo 또는 정적 빌드) |

Caddy가 HTTPS 인증서를 Let's Encrypt에서 자동 발급/갱신.  
`{$ACME_EMAIL}`, `{$API_DOMAIN}`은 `/home/STEPAI05/app/.env`에서 읽음.

---

## 트러블슈팅

### API가 올라오지 않을 때

```bash
docker compose logs api --tail=100
# Cloud SQL Proxy 연결 대기 중인지 확인
docker compose logs cloud-sql-proxy --tail=30
```

Cloud SQL Proxy가 준비되기 전에 API가 시작되면 DB 연결 오류 발생.  
`docker compose up -d --force-recreate api` 재실행으로 보통 해결됨.

### Caddy가 재시작 루프에 빠질 때

`/home/STEPAI05/app/.env`에 환경변수가 없으면 `{$ACME_EMAIL}` 등이 빈 값이 되어 Caddy 오류 발생.  
파일이 존재하는지, 4개 변수가 모두 있는지 확인.

### YouTube 다운로드 실패 (포맷 오류)

`youtube_download.py`에서 `remote_components`가 리스트인지 확인:
```python
remote_components=["ejs:github"]   # ✅ 리스트
remote_components="ejs:github"     # ❌ 문자열 (오류)
```

### ffprobe / ffmpeg 없음 오류

로컬: `ffmpeg -version`으로 설치 확인 후 PATH 등록  
컨테이너: `docker exec -it <container> ffmpeg -version`으로 확인

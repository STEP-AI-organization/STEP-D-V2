# STEP-D (롱퐁 쇼츠화) — 인프라 문서

> 상태: **LIVE** (2026-06-25 배포) · 작성: 운영 기준 실제 값
> ⚠️ **이 레포는 퍼블릭입니다.** 이 파일에는 시크릿 값(키/비번/토큰)이 **없지만** 인프라 좌표(프로젝트·IP·리소스명)가 들어있으니 **퍼블릭 레포에 커밋하지 말 것**(권장: Notion/사내 위키 또는 `.gitignore`).

---

## 1. 개요

긴 영상을 세로 쇼츠로 자동 변환 → 유튜브 게시까지 하는 "쇼츠 자동화 미디어 OS". 데모/운영 배포 구성:

- **웹(프론트)**: Next.js → **Vercel** (`https://stepd.stepai.kr`)
- **API(백엔드)**: FastAPI + FFmpeg → **GCP Compute Engine VM**(Docker) (`https://stepd-api.stepai.kr`)
- **DB**: Cloud SQL for PostgreSQL (cloud-sql-proxy 사이드카로 연결)
- **미디어 저장/서빙**: VM 로컬 디스크(`/data`) + Caddy (`STORAGE_BACKEND=local`)
- **연결 방식**: 웹이 `/api/*`·`/media/*`를 Vercel **rewrite로 API에 reverse proxy** → 브라우저 입장에선 전부 same-origin(`stepd.stepai.kr`) → **first-party 쿠키**

### 아키텍처

```
                    브라우저 (stepd.stepai.kr)
                            │ HTTPS (same-origin)
                            ▼
        ┌───────────────────────────────────────┐
        │ Vercel — project step-d-v2-web         │
        │  Next.js SPA  +  rewrites():           │
        │   /api/:path*  → stepd-api.stepai.kr   │
        │   /media/:path*→ stepd-api.stepai.kr   │
        └───────────────┬───────────────────────┘
                        │ (proxy)  HTTPS
                        ▼
        ┌───────────────────────────────────────┐
        │ GCP VM  shorts-api  (34.47.116.86)     │
        │  ┌─────────────────────────────────┐   │
        │  │ Caddy :80/:443 (ZeroSSL 자동)    │   │
        │  │   └ reverse_proxy → api:8010     │   │
        │  │ FastAPI (Docker, /data 마운트)    │   │
        │  │ cloud-sql-proxy :5432 ──────────┼───┼──▶ Cloud SQL shorts-pg
        │  └─────────────────────────────────┘   │   (Postgres 16)
        │  /data (100GB pd-ssd): 업로드/클립/미디어 │
        └───────────────────────────────────────┘
```

---

## 2. 도메인 & DNS (stepai.kr)

| 호스트 | 타입 | 값 | 용도 |
|---|---|---|---|
| `stepd.stepai.kr` | A (또는 CNAME) | `76.76.21.21` (Vercel) | 웹 |
| `stepd-api.stepai.kr` | A | `34.47.116.86` (GCP 고정IP) | API/백엔드 |

- TLS: 웹=Vercel 자동, API=Caddy 자동(ZeroSSL, ~90일 자동갱신).
- 변경 시 두 호스트 모두 위 값을 유지해야 함.

---

## 3. GCP 백엔드

- **프로젝트**: `step-d` (번호 `872105344568`)
- **결제계정**: `012992-EF3C8D-E1DECD`
- **리전/존**: `asia-northeast3` / `asia-northeast3-a` (서울)
- **활성 API**: compute, sqladmin, storage, iam, youtube(Data API v3)

### 3.1 Compute Engine VM
| 항목 | 값 |
|---|---|
| 이름 | `shorts-api` |
| 머신 | `e2-standard-4` (4 vCPU / 16GB) |
| OS | Ubuntu 22.04 LTS |
| 부팅 디스크 | 30GB pd-ssd |
| 데이터 디스크 | `shorts-data` 100GB pd-ssd → `/data` (auto-delete=no, fstab `nofail`) |
| 고정 IP | `shorts-api-ip` = `34.47.116.86` |
| 서비스계정 | `shorts-vm@step-d.iam.gserviceaccount.com` (scope: cloud-platform) |
| 태그 | `http-server`, `https-server` |
| 코드 위치 | `~/app` (= `/home/STEPAI05/app`, GitHub clone) |

### 3.2 Cloud SQL
| 항목 | 값 |
|---|---|
| 인스턴스 | `shorts-pg` (PostgreSQL 16, `db-g1-small`, zonal, 20GB SSD) |
| 연결명 | `step-d:asia-northeast3:shorts-pg` |
| DB / 유저 | `shorts` / `shorts_app` |
| 접속 | VM 안 `cloud-sql-proxy` 컨테이너(`:5432`) 경유, ADC 인증(서비스계정) |

### 3.3 네트워크
- 방화벽 `allow-web`: `tcp:80,443` ← `0.0.0.0/0` (태그 http-server/https-server). SSH(22)는 기본 `default-allow-ssh`.

### 3.4 IAM
- `shorts-vm` 서비스계정: `roles/cloudsql.client` (프로젝트). ADC는 VM 메타데이터 서버에서 자동 → 키 파일 없음.

### 3.5 GCS (현재 미사용)
- 버킷 `step-d-shorts-media` 생성돼 있으나 **사용 안 함**. 조직 정책(Domain Restricted Sharing)이 공개 버킷을 막아 미디어는 VM 직접 서빙으로 결정. 정리하려면 삭제 가능: `gcloud storage rm -r gs://step-d-shorts-media`.

---

## 4. 컨테이너 스택 (`docker-compose.prod.yml`)

VM `~/app`에서 실행. 단일 env 파일을 interpolation + api env_file 양쪽으로 사용:

```bash
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build
```

| 서비스 | 이미지 | 포트 | 역할 |
|---|---|---|---|
| `caddy` | `caddy:2.8-alpine` | 80,443 | TLS 종단 + `stepd-api.stepai.kr` → `api:8010` reverse proxy (`./Caddyfile`) |
| `api` | `ai-shorts-api:prod` (apps/api/Dockerfile 빌드) | 8010(내부) | FastAPI + FFmpeg + 폰트. `/data` 마운트 |
| `cloud-sql-proxy` | `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1` | 5432(내부) | Cloud SQL 연결 사이드카 |

- 전부 `restart: unless-stopped` → VM 재부팅 시 자동 복구.
- `apps/api/.env.production` (chmod 600, **gitignore**): `STORAGE_BACKEND=local`, `DATABASE_URL=postgresql+psycopg2://shorts_app:****@cloud-sql-proxy:5432/shorts`, `PUBLIC_BASE_URL`/`WEB_BASE_URL`/OAuth redirect = `https://stepd.stepai.kr` 기준, OpenAI/Gemini/YouTube/세션 시크릿 포함.

---

## 5. Vercel 웹

| 항목 | 값 |
|---|---|
| 팀 / 프로젝트 | `step-ai` / `step-d-v2-web` |
| 프로덕션 도메인 | `stepd.stepai.kr` |
| GitHub | `STEP-AI-official/STEP-D-V2` (public), **auto-deploy on `main`** |
| Root Directory | `apps/web` |
| Build Command | **`next build --webpack`** (`apps/web/vercel.json`로 고정) |
| 프로덕션 env | `NEXT_PUBLIC_API_PROXY=true`, `API_PROXY_TARGET=https://stepd-api.stepai.kr`, `NEXT_PUBLIC_API_BASE_URL=""` |

> ⚠️ **webpack 강제 필수**: Next 16은 `next build`가 Turbopack 기본 → Vercel에서 `/_next/static/immutable/*` 자산이 404남. `vercel.json`의 `next build --webpack`로 표준 `/_next/static/chunks/` 출력 고정.

---

## 6. 요청 흐름

**일반 API/미디어**: 브라우저 → `stepd.stepai.kr/api/...` → (Vercel rewrite) → `stepd-api.stepai.kr/api/...` → Caddy → FastAPI. 같은 origin이라 CORS 불필요, 쿠키 first-party.

**OAuth 로그인**: 로그인 클릭 → `/api/auth/google/start`(프록시) → API가 Google로 302(`redirect_uri=https://stepd.stepai.kr/api/auth/google/callback`) → 동의 → `/api/auth/google/callback`(프록시) → API가 세션쿠키 Set-Cookie + `stepd.stepai.kr`로 리다이렉트.

---

## 7. Google OAuth

- 클라이언트 ID: `872105344568-cg01uppnf239676l91322jo75bbefjjk.apps.googleusercontent.com` (프로젝트 step-d)
- 승인된 리디렉션 URI: `https://stepd.stepai.kr/api/auth/google/callback`, `https://stepd.stepai.kr/api/youtube/oauth/callback`
- 승인된 JS 원본: `https://stepd.stepai.kr`
- 스코프: 로그인 `openid email profile` / 유튜브 `youtube.upload`, `youtube.readonly`(**restricted**)
- 동의화면: **Testing 모드 + 테스트 사용자**(검수 전). ⚠️ Testing refresh token **7일 만료** → 데모 당일 유튜브 재연결.

---

## 8. 시크릿 위치 (값은 문서에 없음)

| 시크릿 | 위치 |
|---|---|
| OpenAI / Gemini 키, YouTube client secret, SESSION_SECRET, DB 비번 | VM `~/app/apps/api/.env.production` (chmod 600) |
| DB 비번(사본) | 로컬 scratchpad(임시) — 운영 기준은 VM env가 정본 |
| Vercel 토큰 | 로컬 임시 보관(폐기 권장) / Vercel 계정 |
| Google OAuth client secret | VM env + Google 콘솔 |

---

## 9. 운영 (Runbook)

```bash
# === API 재배포 (VM) ===
gcloud compute ssh shorts-api --zone=asia-northeast3-a
cd ~/app && git pull
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build

# 컨테이너 상태 / 로그 / 재시작
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml ps
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml logs -f api
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml restart api

# === 웹 재배포 ===
#  main에 push → Vercel auto-deploy. 또는 CLI:
vercel redeploy <prod-url> --scope step-ai --token <TOKEN>

# === DB 접속 (VM 안, 프록시 경유) ===
docker exec -it ai-shorts-prod-cloud-sql-proxy-1 true   # 프록시 떠있는지
#  psql은 api 컨테이너나 별도 psql 클라이언트로 cloud-sql-proxy:5432 접속

# === /data 정리 cron (7일 경과 업로드/잡 삭제) ===
( crontab -l 2>/dev/null; echo '0 4 * * * find /data/uploads -mindepth 1 -mtime +7 -delete; find /data/jobs -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +' ) | crontab -

# === 비용 절감: 안 쓸 때 중지 ===
gcloud compute instances stop shorts-api --zone=asia-northeast3-a
gcloud sql instances patch shorts-pg --activation-policy=NEVER
#  재가동
gcloud compute instances start shorts-api --zone=asia-northeast3-a
gcloud sql instances patch shorts-pg --activation-policy=ALWAYS
#  (디스크/IP/스토리지는 중지해도 과금)
```

---

## 10. 헬스체크 & 검증

```bash
curl https://stepd-api.stepai.kr/api/health      # API 직접 (Caddy)
curl https://stepd.stepai.kr/api/health          # 프록시 경유 (둘 다 JSON ok 면 정상)
curl -s -o /dev/null -w "%{http_code}\n" https://stepd.stepai.kr   # 웹 200
```

---

## 11. 비용 (대략, asia-northeast3, 24/7 기준)

| 리소스 | 월 대략 |
|---|---|
| VM e2-standard-4 | ~$115 |
| 디스크 30+100GB pd-ssd | ~$23 |
| 고정 IP(사용중) | 무료 |
| Cloud SQL db-g1-small | ~$25 |
| Vercel | 플랜 따라 (Hobby/Pro) |
| **합계(상시)** | **~$165/월** + Vercel |

데모 모드(유휴 중지)면 VM/SQL 컴퓨트 절감 → 월 수십 달러 수준. 디스크/스토리지는 계속 과금.

---

## 12. 알려진 제약 / 데모 주의

- **대용량 업로드/스트리밍이 Vercel 프록시 경유**: 2GB 업로드·긴 영상 스트리밍은 Vercel 한도/지연 우려 → 무대에선 **유튜브 URL import + 사전 렌더 잡** 사용 권장.
- **단일 VM(이중화 없음)**: 무거운 렌더가 프로세스(FFmpeg)에 부담 → 라이브로 새 1시간 렌더 시작 금지, 사전 렌더 활용.
- **OAuth Testing 7일 토큰**: 데모 7일 이내 유튜브 재연결.
- **DB 스키마 변경**: Alembic 없음. 첫 배포는 `create_all` 자동. 이후 컬럼 변경은 수동/마이그레이션 도구 필요.
- **GCS 미사용**: 미디어가 VM 디스크에만 존재 → VM(데이터디스크는 보존되나) 교체 시 주의. 내구성 강화하려면 추후 GCS 서명URL 도입.

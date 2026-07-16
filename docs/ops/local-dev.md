# 로컬 개발 환경

> 최종: 2026-07-16

배포가 느리니 당분간 여기서 개발한다. 배포는 [deploy.md](deploy.md) 참고.

## 사전 요구사항

- **Docker Desktop** — 로컬 Postgres 컨테이너(`stepd-pg`)용
- **Node ≥22** — 루트 `package.json`의 `engines` 요구
- **pnpm** — 모노레포 워크스페이스 (`pnpm dev` 등)

## 한 번에 켜기

```powershell
.\dev.ps1
```

이거 하나로 뜬다:

| | 주소 | |
|---|---|---|
| **웹** | http://localhost:3000 | `next dev` · 핫리로드 |
| **서버** | http://localhost:4100 | `tsx watch` · 저장 시 자동 재시작 |
| **Postgres** | localhost:5432 (db `stepd`) | Docker 컨테이너 `stepd-pg` · 데이터 유지 |

`Ctrl+C`로 웹·서버 종료. Postgres 컨테이너는 계속 떠 있다 (다음에 바로 재사용).

## 구성

```
브라우저(3000) ──직접호출──▶ 서버(4100) ──▶ 로컬 Postgres(5432)
                                   └──▶ 로컬 스토리지 (repo/storage/, GCS 아님)
```

- 웹은 `apps/web/.env.local` 의 `NEXT_PUBLIC_API_URL=http://localhost:4100/api` 로
  **로컬 서버를 직접** 부른다. 프로덕션의 GCP 프록시·Cloud Run은 안 탄다.
- 서버는 `apps/server/.env` 의 `DATABASE_URL` 로 로컬 Postgres에 붙는다.
- `GCS_BUCKET`이 없으니 업로드 파일은 `storage/` 폴더에 저장된다 (`storage-gcs.ts` 로컬 폴백).
- **DB 스키마는 자동 생성된다.** `schema.sql`을 수동 실행할 필요 없음 — 서버 기동 시
  `db-pg.ts`의 `initDb()`가 `CREATE TABLE IF NOT EXISTS`로 전부 만든다.
  `job_queue`(`queue.ts` initQueue)와 `content_analysis`(`db-pg.ts`)는 `schema.sql`에
  아예 없고 코드에서만 생성되는 테이블이다.
- **첫 기동 시 화면이 비어 있는 게 정상이다.** `seed.ts`는 의도적으로 전부 빈 배열
  (프로덕션에 데모 콘텐츠를 두지 않는 방침). 프로그램 생성 → 영상 업로드를 직접 해야 데이터가 생긴다.

### 포트를 4100으로 쓰는 이유
레거시 `aena-v2` 서버가 4000을 점유하고 있어서 충돌을 피했다. V2 서버는 4100.

## 로컬 env (git에 안 올라감)

`.env`·`.env.local` 은 gitignore 처리돼 있다. 값:

```
# apps/server/.env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stepd
PORT=4100
NODE_ENV=development
GOOGLE_CLIENT_ID=...      # (기존 값 유지 — OAuth 테스트용)
GOOGLE_CLIENT_SECRET=...
PUBLIC_URL=http://localhost:4100   # OAuth 콜백 베이스. 생략하면 http://localhost:{PORT} 기본값

# apps/web/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4100/api
```

- `apps/web/.env.local` 에 `VERCEL_OIDC_TOKEN=...` 줄이 있어도 신경 쓰지 말 것 —
  Vercel CLI가 자동 생성한 산물이며 로컬 개발과 무관하다.

## AI 콘텐츠 파이프라인(core/) 로컬 실행

업로드하면 서버가 `content.analyze` 잡을 큐에 넣을 뿐, 실행은 **워커**가 한다.
로컬에서 추천(AI 쇼츠)까지 보려면:

1. **워커 기동** — 별도 터미널에서 `pnpm --filter @stepd/server worker` (같은 로컬 DB·env 사용).
2. **파이썬 준비** — 워커의 `content-pipeline.ts`가 `python -m core.analyze`를 스폰한다.
   기본 인터프리터는 `core/.venv310/Scripts/python.exe` — 다른 경로면 `CORE_PYTHON` env로 지정.
   의존성은 `core/requirements.txt` (google-genai, scenedetect, opencv-python, yt-dlp) 를
   venv에 설치. `ffmpeg`/`ffprobe`가 PATH에 있어야 한다.
3. **Vertex AI 인증(ADC)** — STT·비전·추천이 전부 Vertex Gemini 호출이다 (API 키 아님).
   `gcloud auth application-default login` 한 번 해두면 된다.
   env 기본값: `STT_PROVIDER=gemini`, `GOOGLE_CLOUD_PROJECT=step-d`, `VERTEX_LOCATION=asia-northeast3`
   (셋 다 `content-pipeline.ts`가 기본값을 채우므로 보통 설정 불필요).
   로컬 GPU로 STT를 돌리려면 `STT_PROVIDER=whisper` + faster-whisper 별도 설치 (requirements.txt 주석 참고).
4. (참고) `CORE_DIR`는 서버의 `/api/lab*` 라우트가 읽는 core/ 산출물 경로다.
   기본값이 레포 루트 `core/` 라서 보통 지정할 필요 없다.

## 자주 쓰는 것

```powershell
.\dev.ps1 -DbOnly                              # Postgres만 (서버/웹 따로 돌릴 때)
pnpm dev                                       # 웹+서버 (DB 떠있는 상태에서)
pnpm --filter @stepd/server dev                # 서버만
pnpm --filter @stepd/server worker             # 워커만 (파이프라인 테스트 시)
pnpm --filter @stepd/web dev                   # 웹만

docker exec -it stepd-pg psql -U postgres -d stepd   # DB 접속
docker stop stepd-pg                           # DB 정지 (데이터는 볼륨에 유지)
docker rm -f stepd-pg                           # DB 컨테이너 삭제 (볼륨 stepd-pg-data는 남음)
```

DB를 완전히 초기화하려면: `docker rm -f stepd-pg; docker volume rm stepd-pg-data` 후 `.\dev.ps1`.
스키마는 다음 서버 기동 때 `initDb()`가 다시 만든다.

## 주의

- **워커는 로컬에서 기본 안 띄운다.** 채널 분석·콘텐츠 분석(content.analyze) 파이프라인을
  테스트하려면 위 섹션대로 별도 터미널에서 워커를 띄울 것. 대개 웹/서버만으로 충분하다.
- **OAuth(채널 연결)를 로컬에서 테스트**하려면 두 가지가 필요하다:
  1. `apps/server/.env` 의 `PUBLIC_URL=http://localhost:4100`
  2. Google Cloud OAuth 클라이언트에 `http://localhost:4100/api/youtube/oauth/callback` 리디렉션 URI 등록
  안 하면 로컬 OAuth는 프로덕션 도메인으로 튄다. 채널 연결 없이 UI만 볼 거면 신경 안 써도 된다.
- 서버가 안 뜨면 `docker ps` 로 `stepd-pg` 가 살아있는지, 4100 포트가 비었는지 확인.
- **로컬은 프로덕션 DB와 완전히 분리**돼 있다. 여기서 뭘 하든 프로덕션 데이터에 영향 없다.

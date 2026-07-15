# 로컬 개발 환경

배포가 느리니 당분간 여기서 개발한다. 배포는 [deploy.md](deploy.md) 참고.

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
- `GCS_BUCKET`이 없으니 업로드 파일은 `storage/` 폴더에 저장된다.
- 첫 기동 시 DB에 시드 데이터(시범 프로그램/에피소드)가 들어간다.

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
PUBLIC_URL=...            # (프로덕션 값 그대로 — 아래 OAuth 주의 참고)

# apps/web/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4100/api
```

## 자주 쓰는 것

```powershell
.\dev.ps1 -DbOnly                              # Postgres만 (서버/웹 따로 돌릴 때)
pnpm dev                                       # 웹+서버 (DB 떠있는 상태에서)
pnpm --filter @stepd/server dev                # 서버만
pnpm --filter @stepd/web dev                   # 웹만

docker exec -it stepd-pg psql -U postgres -d stepd   # DB 접속
docker stop stepd-pg                           # DB 정지 (데이터는 볼륨에 유지)
docker rm -f stepd-pg                           # DB 컨테이너 삭제 (볼륨 stepd-pg-data는 남음)
```

DB를 완전히 초기화하려면: `docker rm -f stepd-pg; docker volume rm stepd-pg-data` 후 `.\dev.ps1`.

## 주의

- **워커는 로컬에서 기본 안 띄운다.** 채널 분석 파이프라인을 로컬에서 테스트하려면 별도 터미널에서
  `pnpm --filter @stepd/server worker` (같은 로컬 DB·env 사용). 대개 웹/서버만으로 충분하다.
- **OAuth(채널 연결)를 로컬에서 테스트**하려면 두 가지가 필요하다:
  1. `apps/server/.env` 의 `PUBLIC_URL=http://localhost:4100`
  2. Google Cloud OAuth 클라이언트에 `http://localhost:4100/api/youtube/oauth/callback` 리디렉션 URI 등록
  안 하면 로컬 OAuth는 프로덕션 도메인으로 튄다. 채널 연결 없이 UI만 볼 거면 신경 안 써도 된다.
- 서버가 안 뜨면 `docker ps` 로 `stepd-pg` 가 살아있는지, 4100 포트가 비었는지 확인.
- **로컬은 프로덕션 DB와 완전히 분리**돼 있다. 여기서 뭘 하든 프로덕션 데이터에 영향 없다.
```

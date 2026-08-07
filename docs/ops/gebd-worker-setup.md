# GEBD 워커 셋업 — 여유 PC 를 실서비스에 붙이기

> 2026-08-07. GPU 쿼터 승인 전까지 GEBD(화면전환 모델)를 로컬 GPU 로 돌린다.
> 이 PC 는 **`gebd.detect` 잡 하나만** 처리한다. 나머지 잡은 이미 Cloud Run Jobs 가 맡는다.

## 이 워커가 하는 일

```
프로덕션 Cloud SQL 큐
   └─ gebd.detect 잡 claim
         ├─ gsutil 로 GCS 에서 영상 다운로드
         ├─ Docker(GPU) 로 boundaries.json 생성   ← 이 PC 의 GPU
         ├─ gsutil 로 GCS 에 업로드
         └─ content.analyze 재큐 → 클라우드가 beats 이후 재생성
```

**PC 가 꺼져 있어도 서비스는 안 멈춘다.** 그 회차는 fallback 경계로 나가고, PC 를 켜면
밀린 잡이 소진되며 자동으로 정밀 경계로 업그레이드된다.

---

## 1. 사전 준비 (새 PC)

### 1-1. GPU · 드라이버

```powershell
nvidia-smi
```

GPU 이름과 CUDA 버전이 나와야 한다. 안 나오면 NVIDIA 드라이버부터 설치.
**VRAM 8GB 이상** 권장(추론만 하므로 학습만큼은 필요 없다).

### 1-2. Docker Desktop + GPU

Docker Desktop 설치 후 **Settings → Resources → WSL Integration** 켜고, GPU 가 컨테이너에
보이는지 확인:

```bash
docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi
```

이게 실패하면 GEBD 도 못 돈다. Docker Desktop 의 WSL2 백엔드 + 최신 드라이버가 필요하다.

> 디스크 여유 **60GB 이상** 확보할 것 — 이미지만 26.9GB 다. (2026-08-06 에 디스크가 차서
> Docker 가 통째로 죽은 적이 있다.)

### 1-3. Node · pnpm

```bash
node -v      # v22 이상
npm i -g pnpm
```

### 1-4. gcloud SDK

```bash
gcloud --version    # gsutil 이 같이 깔린다
```

---

## 2. 리포에 없는 자산 3개를 옮긴다

### 2-1. GEBD Docker 이미지 (26.9GB)

**원본 tar 가 있으면 그게 제일 낫다** (다시 만들 필요 없음):

```bash
docker load -i "<원본>/비디오 전환 경계 추론 데이터/5.도커이미지/event-boundary-detection.tar"
```

원본이 없으면 지금 PC 에서 뽑아 옮긴다:

```bash
# 기존 PC 에서 (수십 분 걸린다)
docker save event-boundary-detection:latest -o gebd-image.tar
# 새 PC 에서
docker load -i gebd-image.tar
```

확인:

```bash
docker image inspect event-boundary-detection:latest --format '{{.Size}}'
```

### 2-2. 모델 가중치 (1.58GB)

```bash
mkdir -p ~/stepd-models/gebd
cp <원본>/model_cla_f_0_s_-1_7728.pt ~/stepd-models/gebd/
```

원본 위치: `비디오 전환 경계 추론 데이터/2.학습모델파일/model_cla_f_0_s_-1_7728.pt`

> **리포에 넣지 말 것.** `.gitignore` 가 `*.pt` 를 막고 있다.

### 2-3. 서비스 계정 키

GCS 다운로드/업로드와 Cloud SQL 접속에 쓴다. 기존 PC 의
`C:\Users\STEPAI05\stepd-deployer-key.json` 을 새 PC 로 복사하거나, 콘솔에서 새로 발급:

```
IAM 및 관리자 → 서비스 계정 → stepd-deployer → 키 → 키 추가 → JSON
```

새 PC 에 두고:

```bash
gcloud auth activate-service-account --key-file=<경로>/stepd-deployer-key.json
gcloud config set project step-d
gsutil ls gs://stepd-media | head      # 동작 확인
```

---

## 3. 프로덕션 DB 연결 (Cloud SQL Auth Proxy)

⚠️ **기존 PC 의 `.env` 를 그대로 복사하면 안 된다** — 거기 `DATABASE_URL` 은
`localhost:5432`(로컬 Docker Postgres)를 가리킨다. 그걸 쓰면 **프로덕션 큐가 아니라 빈 로컬 DB**
를 보게 되고 잡이 하나도 안 온다.

Cloud SQL 은 공인 IP 가 열려 있지만(`107.178.216.207`), IP 허용목록을 건드리는 대신
**Auth Proxy** 를 쓰는 게 안전하다 — 방화벽 설정 없이 SA 키로 붙는다.

### 3-1. 프록시 설치·실행

```bash
# 다운로드 (Windows)
curl -o cloud-sql-proxy.exe https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.0/cloud-sql-proxy.x64.exe

# 실행 (별도 창에서 계속 켜둔다)
./cloud-sql-proxy.exe --credentials-file=<경로>/stepd-deployer-key.json \
  step-d:us-central1:stepd-db --port 5433
```

`--port 5433` 으로 둔 이유: 로컬 Postgres(5432)와 안 겹치게.

### 3-2. DB 접속 문자열

프로덕션 값은 Secret Manager 에 있다. 사용자·비밀번호만 뽑아 쓴다:

```bash
gcloud secrets versions access latest --secret=stepd-db-url --project=step-d
```

나온 문자열에서 호스트 부분을 `localhost:5433` 으로 바꾼 것이 이 PC 의 `DATABASE_URL` 이다.
(Cloud Run 은 유닉스 소켓으로 붙어서 형식이 다를 수 있다 — 그럴 땐 사용자/비번/DB명만 가져와
`postgresql://<user>:<pw>@localhost:5433/<db>` 로 조립한다.)

---

## 4. `.env` 만들기

`apps/server/.env` 에 아래만 있으면 된다. **gebd lane 은 YouTube·STT 를 안 쓴다.**

```bash
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<pw>@localhost:5433/<db>   # 프록시 경유
GCS_BUCKET=stepd-media
GOOGLE_APPLICATION_CREDENTIALS=C:\경로\stepd-deployer-key.json

# GEBD
GEBD_MODEL=C:\Users\<사용자>\stepd-models\gebd\model_cla_f_0_s_-1_7728.pt
# GEBD_IMAGE 는 기본값이 event-boundary-detection:latest 라 생략 가능
# GEBD_CHUNK_SEC=300 · GEBD_CORES=1 도 기본값이라 생략 가능 (바꾸지 말 것)

# ⚠️ 아래 둘은 gebd lane 이 쓰지 않지만 worker main() 이 없으면 즉시 종료한다
GOOGLE_CLIENT_ID=<값>
GOOGLE_CLIENT_SECRET=<값>
```

두 값은 Secret Manager 에서:

```bash
gcloud secrets versions access latest --secret=stepd-google-client-id --project=step-d
gcloud secrets versions access latest --secret=stepd-google-client-secret --project=step-d
```

> `.env` 는 **절대 커밋하지 말 것.** (2026-07-14 개인키 유출 사고 이력)

---

## 5. 실행

```bash
cd <리포>/apps/server
pnpm install
WORKER_JOBS=gebd npx tsx src/worker.ts
```

정상 기동 로그:

```
[worker] db + queue ready
[worker] queue: {"pending":N,"running":..,"done":80xxx, ...}   ← done 이 8만대면 프로덕션 연결됨
[worker] lane=gebd · claims=gebd.detect · sweep=false — polling for jobs
```

**`done` 이 한 자리 수면 로컬 DB 에 붙은 것이다** — `DATABASE_URL` 을 다시 볼 것.

상시로 돌리려면 pm2:

```bash
npm i -g pm2
pm2 start "npx tsx src/worker.ts" --name stepd-gebd --env WORKER_JOBS=gebd
pm2 save && pm2 startup
```

Cloud SQL Proxy 도 같이 pm2 에 올려야 재부팅 후에 살아난다.

---

## 6. 클라우드 쪽 스위치 켜기

이 PC 가 준비되면 content Job 이 `gebd.detect` 를 큐잉하도록 켠다:

```bash
gcloud run jobs update stepd-worker-content --project=step-d --region=us-central1 \
  --update-env-vars=AUTO_GEBD=1
```

**이걸 켜기 전에 5번까지 확인할 것.** 안 그러면 `gebd.detect` 잡만 큐에 쌓인다
(쌓여도 해는 없다 — `content.analyze` 는 fallback 경계로 이미 완주해 있다).

---

## 7. 검증 (₩0)

클라우드 잡을 기다리지 말고 먼저 단독으로 돌려본다:

```bash
bash deploy/gebd/run-local.sh <영상.mp4> tmp/gebd-test 300 1
```

기대 로그:

```
[check] 청크 길이 편차 최대 0.034s (정상 · 드리프트 없음)
[check] feature 행수 ... → 1.00 행/초
[merge] N boundaries · ...
```

- **`행/초` 가 0.8 미만이면** `prepare/module.py` 가 컨테이너에 안 실린 것이다
- **`드리프트 발생`** 이 뜨면 Stage A 정규화가 실패한 것이다

58.6분 회차 실측: 총 **10.7분** (Stage A 277초 + B 324초 + C 43초).

---

## 함정 모음 (이미 밟은 것들)

| 증상 | 원인 |
|---|---|
| `set: pipefail: invalid option name` | `.sh` 가 CRLF. `.gitattributes` 가 막지만 구 체크아웃이면 발생 → 재클론 |
| 컨테이너 경로가 `C:/Program Files/Git/gebd/...` | Git Bash 의 MSYS 경로 변환. `run-local.sh` 가 `MSYS_NO_PATHCONV=1` 로 처리함 |
| feature 0개인데 성공처럼 보임 | `CORES>1`. parmap 병렬이 산출물을 날린다 — **`CORES=1` 유지** |
| 경계가 청크 앞쪽에 몰림 | `prepare/module.py` 누락 또는 `CHUNK_SEC≠300` |
| Docker 가 갑자기 죽음 | 디스크 부족. 이미지 26.9GB + 작업 파일 |
| AV1 영상 못 읽음 | `decord` 가 AV1 미지원 → h264 로 먼저 변환 |

상세: `deploy/gebd/README.md`

---

## 관련

- `deploy/gebd/README.md` — GEBD 실행·제약·버그 이력
- `docs/ops/gpu-quota-request.md` — 쿼터 승인되면 클라우드로 이전
- `docs/plans/active/cloud-migration-model-and-worker.md` — 전체 이전 계획

# 배포 런북 — 롱퐁 쇼츠화 (Vercel + GCP VM + Cloud SQL + GCS)

웹은 Vercel(`app.stepai.kr`), 백엔드는 GCP Compute Engine 단일 VM(`api.stepai.kr`, Caddy 자동 HTTPS), DB는 Cloud SQL, 미디어는 GCS.
명령은 위에서 아래로 순서대로 실행. `<...>`만 본인 값으로 치환.

## 0. 변수 (로컬 셸 / Cloud Shell에서 export — bash 기준)

```bash
export PROJECT=<your-gcp-project-id>
export REGION=asia-northeast3            # 서울
export ZONE=asia-northeast3-a
export VM=shorts-api
export SA=shorts-vm                       # VM 서비스계정 이름
export SQL=shorts-pg                       # Cloud SQL 인스턴스 이름
export DB=shorts
export DBUSER=shorts
export DBPASS='<strong-db-password>'
export BUCKET=stepai-shorts-media
export API_DOMAIN=api.stepai.kr
export WEB_DOMAIN=app.stepai.kr

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com sqladmin.googleapis.com \
  storage.googleapis.com iam.googleapis.com
```

## 1. DNS 먼저 (Caddy 인증서 발급 전제)

VM 고정 IP를 먼저 예약하고 A 레코드를 건다(아래 5에서 VM에 붙임).

```bash
gcloud compute addresses create ${VM}-ip --region "$REGION"
gcloud compute addresses describe ${VM}-ip --region "$REGION" --format='value(address)'
```

- `api.stepai.kr` → **A** → 위 IP
- `app.stepai.kr` → **CNAME** → `cname.vercel-dns.com` (Vercel 도메인 추가 시 안내되는 값)

`nslookup api.stepai.kr`로 전파 확인 후 다음 단계.

## 2. Google OAuth (콘솔, 코드 변경 없음)

API/서비스 → OAuth 동의 화면:
- User type **External**, 게시 상태 **Testing**.
- **Test users**에 데모용 구글 계정 추가(≤100). ⚠️ Testing 모드 refresh token은 **7일 만료** → 데모 7일 이내(가능하면 당일 아침)에 유튜브 재연결.
- 앱 이름/로고/개인정보처리방침 URL(`https://app.stepai.kr/...`)·홈페이지 입력(정식 검수 대비).

사용자 인증 정보 → OAuth 2.0 클라이언트(웹):
- 승인된 JavaScript 원본: `https://app.stepai.kr` (필요시 `https://api.stepai.kr`)
- 승인된 리디렉션 URI 2개:
  - `https://api.stepai.kr/api/auth/google/callback`
  - `https://api.stepai.kr/api/youtube/oauth/callback`
- 클라이언트 ID/시크릿을 `.env.production`의 `YOUTUBE_CLIENT_ID/SECRET`에 기록.
- 요청 스코프 `youtube.upload`·`youtube.readonly`는 restricted → 정식 공개는 검수 필요(수 주). 데모는 Testing 모드로 충분.

## 3. Cloud SQL (PostgreSQL)

```bash
gcloud sql instances create "$SQL" \
  --database-version=POSTGRES_16 --tier=db-custom-1-3840 \
  --region="$REGION" --storage-type=SSD --storage-size=20GB

gcloud sql databases create "$DB" --instance="$SQL"
gcloud sql users create "$DBUSER" --instance="$SQL" --password="$DBPASS"

# 인스턴스 연결 이름(PROJECT:REGION:INSTANCE) — .env.production의 INSTANCE_CONNECTION_NAME
gcloud sql instances describe "$SQL" --format='value(connectionName)'
```

스키마는 첫 부팅 시 앱이 자동 생성(`init_db()`의 `create_all`). 마이그레이션 도구 불필요.

## 4. GCS 버킷 (공개 읽기)

```bash
gcloud storage buckets create gs://$BUCKET --location="$REGION" \
  --uniform-bucket-level-access
# 공개 읽기 (미디어 서빙용)
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=allUsers --role=roles/storage.objectViewer
```

## 5. 서비스계정 + VM

```bash
# VM이 Cloud SQL/GCS에 접근할 전용 서비스계정
gcloud iam service-accounts create "$SA" --display-name="shorts vm"
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/cloudsql.client
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin

# 미디어/원본/DB(sqlite 미사용)용 영구 SSD 데이터 디스크
gcloud compute disks create ${VM}-data --type=pd-ssd --size=200GB --zone="$ZONE"

# VM (FFmpeg 재인코딩 대비 8 vCPU). SA를 cloud-platform 스코프로 부착.
gcloud compute instances create "$VM" \
  --zone="$ZONE" --machine-type=e2-standard-8 \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-ssd \
  --disk=name=${VM}-data,device-name=data,mode=rw,boot=no,auto-delete=no \
  --service-account="$SA_EMAIL" --scopes=cloud-platform \
  --address=$(gcloud compute addresses describe ${VM}-ip --region "$REGION" --format='value(address)') \
  --tags=http-server,https-server

# 방화벽 80/443 (http-server/https-server 태그 기본 규칙이 없으면 생성)
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server \
  --source-ranges=0.0.0.0/0 || true
```

## 6. VM 안에서 — Docker + 디스크 + 기동

```bash
gcloud compute ssh "$VM" --zone="$ZONE"
```

VM 셸에서:

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 데이터 디스크 포맷(최초 1회) + /data 마운트 (영구)
sudo mkfs.ext4 -F /dev/disk/by-id/google-data    # ⚠️ 최초 1회만! 기존 데이터 있으면 건너뜀
sudo mkdir -p /data
echo '/dev/disk/by-id/google-data /data ext4 discard,defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && sudo chmod 777 /data

# 코드 가져오기 (git remote 또는 scp)
git clone <YOUR_REPO_URL> app && cd app

# 프로덕션 env 작성
cp apps/api/.env.production.example apps/api/.env.production
nano apps/api/.env.production           # INSTANCE_CONNECTION_NAME, DBPASS, 키, BUCKET 등 채우기
chmod 600 apps/api/.env.production

# 기동
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f caddy   # 인증서 발급 확인
```

검증: `curl https://api.stepai.kr/api/health` → OK. (또는 `deploy/setup-vm.sh`로 6단계 자동화)

## 7. Vercel (웹)

- New Project → 이 repo import → **Root Directory: `apps/web`**.
- Environment Variable: `NEXT_PUBLIC_API_BASE_URL = https://api.stepai.kr` (Production).
- Deploy 후 Settings → Domains에 `app.stepai.kr` 추가, 안내된 CNAME을 DNS에 반영.

## 8. E2E (클라우드)

1. `https://app.stepai.kr` 접속 → 구글 로그인(테스트 사용자) → "고급 → 계속" 통과.
2. 유튜브 채널 연결 → 채널 선택.
3. **사전 테스트해 둔 유튜브 URL** import → 렌더 완료 → 클립 인라인 재생 + 자막 확인.
4. 클립 URL이 `storage.googleapis.com/...` 인지 확인(GCS 서빙).
5. 클립 1개 게시(unlisted) → 유튜브에서 확인.

## 재배포 / 롤백 / 정리

```bash
# 재배포 (VM)
cd ~/app && git pull
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build

# 롤백
git checkout <previous-sha>
docker compose --env-file apps/api/.env.production -f docker-compose.prod.yml up -d --build

# /data 정리 cron (오래된 원본/잡 제거, 7일 경과분)
( crontab -l 2>/dev/null; echo '0 4 * * * find /data/uploads -mindepth 1 -mtime +7 -delete; find /data/jobs -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +' ) | crontab -
```

## 데모 안정성 체크리스트
- 무대에서 2GB 업로드 금지 → 사전 import 해둔 유튜브 URL 사용.
- 새 1시간 렌더 라이브 금지 → 사전 렌더된 잡 또는 ≤10분 영상.
- 완료 잡 1~2개 미리 시딩(화면 채우기).
- 유튜브 데모 7일 이내 재연결, "고급→계속" 인터스티셜 리허설.

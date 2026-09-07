# deploy/ — 어디로 나가는가

**평소 쓰는 건 두 개뿐이다.** 나머지는 머신을 처음 만들 때만 쓴다.

```bash
bash deploy/cloud.sh status     # 지금 뭐가 떠 있나 (배포 안 함 · 먼저 이걸로)
bash deploy/cloud.sh all        # server + worker + migrate
.\deploy\deploy-web.ps1         # 웹(Vercel)
```

배포 런북·함정은 [docs/ops/deploy.md](../docs/ops/deploy.md), 인프라 정본은
[docs/ops/infra.md](../docs/ops/infra.md), `/deploy` 스킬이 `cloud.sh` 를 감싼다.

---

## 워커가 네 군데서 돈다 — 그래서 폴더가 넷이다

잡 레인 7개가 **서로 다른 머신**에서 돈다. 파일이 평평하게 있으면 어느 스크립트가 어느
머신 건지 이름만으로 알 수 없어서(2026-09-07 정리) 실행 위치별로 묶었다.

| 폴더 | 머신 | 도는 잡(레인) | 왜 거기서 |
|---|---|---|---|
| (없음 · `cloudbuild-worker.yaml`) | **Cloud Run Jobs** | `content` · `youtube` | 파이썬·ffmpeg 무거운 잡 · API 쿼터 잡 |
| [`gebd/`](gebd/) | **GPU L4 spot VM** | `gebd` | mmaction2 가 GPU 를 요구 |
| [`worker-vm/`](worker-vm/) | **GCE CPU VM** (구 상시 워커) | — | ⚠️ 아래 참조 |
| [`naver-pc/`](naver-pc/) | **윈도우2** (사무실 PC) | `naver` · `download` · `commerce` · `render` | 한국 IP · 화면 있는 크롬 필요 |

**왜 사무실 PC 인가**: 네이버는 공개 업로드 API 가 없어 Playwright 자동화인데 해외 IP 로
로그인하면 캡차에 막힌다. 유튜브 다운로드도 데이터센터 IP 를 봇으로 판정한다. 쿠팡 파트너스
콘솔은 headless 를 차단한다(실측 2026-08-27). 전부 **그 PC 여야만 되는 이유**가 있다.

⚠️ **CPU 가 공짜라고 아무 잡이나 사무실 PC 로 보내면 안 된다.** GCS 에서 원본을 받아오는
잡은 인터넷 egress(≈₩165/GB)가 새로 생긴다 — 같은 리전 Cloud Run 은 0원이다.
실측(270MB 원본): WIN2 ₩45 vs Cloud Run ₩14. **바이트를 옮기는 잡은 클라우드, CPU 만 쓰는 잡은 PC.**

---

## 파일

| | 무엇 | 언제 |
|---|---|---|
| `cloud.sh` | **표준 배포 진입점** — `status`\|`server`\|`worker`\|`gebd`\|`migrate`\|`all` | 늘 |
| `deploy-web.ps1` | 웹(Vercel) — author 강제 → 검증 → push → 배포 확인 | 웹 변경 시 |
| `cloudbuild-worker.yaml` | Cloud Run Jobs 워커 이미지 빌드 (`cloud.sh worker` 가 쓴다) | — |
| `setup-upload-bucket.sh` | 업로드 버킷 CORS·수명주기 (일회성) | 버킷 만들 때 |

### `gebd/` — GPU VM

| | |
|---|---|
| `vm-create.sh` | **인스턴스 생성 (한 번만).** startup-script 로 `vm-bootstrap.sh` 를 심는다 |
| `vm-bootstrap.sh` | **부팅마다 자동 실행** — git pull → `vm.sh` 재실행 → 워커·자동종료 데몬 |
| `vm.sh` | 프로비저닝 본체 (Docker · NVIDIA · systemd) · idempotent |
| `Dockerfile.slim` · `cloudbuild-gebd.yaml` | mmaction2 이미지 |
| `vm-startup.sh` | ⚠️ **아래 "정리 안 된 것" 참조** |

깨우기: `POST /api/admin/gebd-vm/wake` — 잡을 소진하면 **스스로 종료**한다(spot 비용).

### `worker-vm/` — GCE CPU VM

| | |
|---|---|
| `vm.sh` | 프로비저닝 (Node 큐 워커) |
| `env.sh` | `/etc/stepd/worker.env` 의 단일 진실 소스 |
| `startup.sh` | 부팅 시 자동 실행 |
| `pipeline-setup.sh` | core 파이썬 파이프라인 추가 설치 |

⚠️ **이 VM 이 지금 쓰이는지 확인하고 쓸 것.** 현재 배치는 Cloud Run Jobs + 윈도우2 이고,
상시 VM 전제의 구 배포 경로는 2026-08-12 에 삭제됐다. 다만 `WORKER_VM_NAME`/`_ZONE` env 와
`POST /api/admin/worker-vm/wake` 라우트는 아직 살아 있다.

### `naver-pc/` — 윈도우2

작업 스케줄러·런처. 갱신은 push 만 하면 10분 내 자가 갱신 — [docs/ops/deploy-win2.md](../docs/ops/deploy-win2.md).

---

## 정리 안 된 것 (2026-09-07 발견)

**`gebd/vm-startup.sh` 와 `gebd/vm-bootstrap.sh` 가 둘 다 "GEBD VM 부팅 스크립트" 다.**

- 실제 배선은 `vm-bootstrap.sh` 다 — `vm-create.sh` 가 startup-script 로 이걸 심는다.
- 그런데 **문서(CLAUDE.md · docs/ops/infra.md · index.ts 주석)는 `vm-startup.sh` 를 가리킨다.**
- 어느 쪽이 프로덕션 VM 에 실제로 들어가 있는지는 GCP 메타데이터를 봐야 안다:
  ```bash
  gcloud compute instances describe <VM> --zone <ZONE> --project step-d \
    --format='value(metadata.items.filter(key:startup-script).extract(value))' | head -20
  ```
- 확인 전까지 **둘 다 지우지 말 것.**

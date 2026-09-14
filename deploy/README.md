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
| `vm-startup.sh` | **프로덕션 VM 의 startup-script 본체** — 부팅마다 실행(리포 갱신 → 워커 → 유휴 종료) |
| `vm-push-startup.sh` | ⚠️ **`vm-startup.sh` 를 고쳤으면 반드시 실행.** 메타데이터는 복사본이라 리포만 고치면 VM 에 안 닿는다 |
| `vm-create.sh` | **인스턴스 생성 (한 번만).** startup-script 로 `vm-startup.sh` 를 심는다 |
| `vm.sh` | 프로비저닝 본체 (Docker · NVIDIA · systemd) · idempotent |
| `Dockerfile.slim` · `cloudbuild-gebd.yaml` | mmaction2 이미지 |
| `vm-bootstrap.sh` | ⚠️ **프로덕션에 안 쓰인다** — 아래 참조 |

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

## 정리됨 (2026-09-07 제기 → 2026-09-14 확인)

**`gebd/vm-startup.sh` 와 `gebd/vm-bootstrap.sh` 가 둘 다 "GEBD VM 부팅 스크립트" 였다.**
2026-09-07 엔 어느 쪽이 실제로 심겨 있는지 몰라 둘 다 남겨 뒀다. 메타데이터를 직접 읽어
**답을 확인했다: `vm-startup.sh` 다.**

```bash
gcloud compute instances describe stepd-gebd-vm --zone us-central1-b --project step-d \
  --format='value(metadata.items.filter("key:startup-script").extract("value"))' | head -20
```

그래서 `vm-create.sh` 도 `vm-startup.sh` 를 심도록 고쳤다 — 예전엔 `vm-bootstrap.sh` 를 심어서
**새로 만든 VM 이 프로덕션과 다르게 동작**했을 것이다. `vm-bootstrap.sh` 는 프로덕션 경로가
아니다(systemd 기반의 다른 설계). 지우지는 않았지만 **따라가지 말 것.**

### ⚠️ 이 조사에서 드러난 진짜 문제 — 메타데이터는 복사본이다

`vm-startup.sh` 는 GCE 메타데이터에 **스냅샷으로** 들어간다. 리포 파일을 고쳐도 VM 은
예전 것으로 계속 부팅하고, **그 사실이 어디에도 안 드러난다.**

실제로 갈라져 있었다 — 리포는 `pnpm install --frozen-lockfile || …` 인데 VM 메타데이터는
`--no-frozen-lockfile` 이었다. 그 상태로 VM 은 리포 갱신(git checkout)에 실패해 **낡은 코드에
고정**됐고, 워커가 1초 만에 죽어 **GEBD 가 한 달 넘게 한 건도 처리하지 못했다**
(`gebd.detect` done 0건 · pending 12건). 고칠 코드는 리포에 있었지만 VM 에 닿는 길이 없었다.

**`vm-startup.sh` 를 고쳤으면 반드시:**

```bash
bash deploy/gebd/vm-push-startup.sh     # 적용은 다음 부팅부터
```

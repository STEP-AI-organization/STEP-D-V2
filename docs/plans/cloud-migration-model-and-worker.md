# 클라우드 전면 이전 — 워커 + GEBD 모델

> 2026-08-07. 사용자: "이제 슬슬 클라우드에 워커까지 다 올릴 계획임. 모델도 올려야 할 거고."
>
> `docs/plans/worker-cloud-migration.md`(같은 날 작성)가 **워커** 이전의 비용·선택지를 다룬다.
> 이 문서는 그 위에 **(1) 실제 GCP 계정 상태 점검 (2) GEBD 모델 이전** 을 더한다.
> 실측 결과 앞 문서의 전제 몇 개가 사실과 다르다 — §1·§4 참조.

---

## 1. 먼저: 지금 클라우드에 실제로 뭐가 있나 (2026-08-07 조회)

문서에 적힌 것과 다르다. **코드를 짜기 전에 이걸 먼저 봐야 한다.**

| 항목 | 문서/코드가 말하는 것 | **실제** |
|---|---|---|
| 워커 VM | CLAUDE.md: "GCE VM (stepd-worker)" | **GCE 인스턴스 0개** — 존재하지 않는다 |
| GEBD 이미지 | `GEBD_IMAGE` 기본값 `…/step-d/stepd/gebd-mmaction2` | AR 저장소는 `stepd-api`·`stepd-server` 뿐. **`stepd` 저장소 자체가 없다** |
| Cloud Run | — | `stepd-api`·`stepd-server` · **us-central1** |
| Cloud Run Jobs | 앞 문서 권장안 | **0개** (아직 없음) |

즉 **지금 워커는 로컬 PC에만 있고, 프로덕션에서 `gebd.detect` 를 켜면 이미지를 못 찾아 즉시 실패한다.**

### ⛔ 쿼터가 막혀 있다 — 이게 critical path다

| 쿼터 | asia-northeast3 | us-central1 | 의미 |
|---|---:|---:|---|
| `GPUS_ALL_REGIONS` | **0** (전역) | **0** | **GPU 인스턴스를 아예 못 만든다** |
| `NVIDIA_T4_GPUS` (리전) | 1 | 1 | 리전 쿼터는 있으나 전역이 0이면 무의미 |
| `NVIDIA_L4_GPUS` (리전) | 1 | 1 | 동일 |
| `PREEMPTIBLE_CPUS` | **0** | **0** | **Spot VM 을 못 만든다** (CPU 조차) |
| `CPUS` (온디맨드) | 100 | 200 | 일반 VM 은 여유 |

**결론 두 가지:**
1. **GPU 쿼터 상향 신청이 최우선.** GPU 없이는 GEBD 모델을 클라우드에 못 올린다(§4).
2. **앞 문서의 "GCE Spot VM(옵션 2)" 은 지금 불가능하다.** `PREEMPTIBLE_CPUS=0` 이다.
   Spot 을 전제로 한 비용 추정(월 $30)도 그대로는 못 쓴다.

> 쿼터 신청은 콘솔 → IAM & Admin → Quotas. 승인까지 보통 수 시간~수일이고,
> 결제 이력이 적은 프로젝트는 거절되기도 한다. **코드 작업보다 먼저 넣어둘 것.**

### 리전이 흩어져 있다

| 리소스 | 리전 |
|---|---|
| Cloud Run (`stepd-server`) | us-central1 |
| GCS `stepd-media` (영상 원본) | US-CENTRAL1 |
| GCS `step-d-landing` | ASIA-NORTHEAST3 |
| Vertex Gemini (`VERTEX_LOCATION`) | asia-northeast3 |
| `GEBD_IMAGE` 기본값 | asia-northeast3 |

영상 원본이 **us-central1** 에 있다. GEBD 워커를 asia-northeast3 에 두면 회차마다 1GB 급
영상을 대륙 간으로 끌어와야 한다(egress 과금 + 시간). **GPU 워커는 us-central1 에 두는 게 맞다.**
Vertex 는 API 호출이라 리전이 달라도 데이터 이동이 작다.

---

## 2. 워크로드 재분류 (오늘 실측 반영)

앞 문서의 A/B 분류는 유효하다. 다만 **C(GPU)** 를 추가해야 한다.

| 그룹 | 잡 | 자원 | 클라우드 형태 |
|---|---|---|---|
| **A. 경량 고빈도** | `channel.analyze`·`video.*` (99.98%) | IO 대기 | Cloud Run Job + Scheduler (15분) |
| **B. 중량 CPU** | `content.analyze` (ffmpeg + API) | CPU·메모리 | Cloud Run Job (2~4 vCPU) |
| **C. GPU** | `gebd.detect` · (STT whisper 쓸 경우) | **GPU 필수** | GCE + T4/L4 (쿼터 필요) |

---

## 3. STT 결정이 먼저다 — 앞 문서와 사실이 다르다

앞 문서는 "STT → Soniox API 라서 GPU 불필요" 라고 적었다. **실제 설정은 다르다.**

`apps/server/.env` 는 **`STT_PROVIDER=hybrid`** 이고, hybrid 는 `_transcribe_whisper` 로
**whisper large-v3 를 로컬 GPU** 에서 돌린다(`core/asr.py`). 오늘 실측도 CUDA 경로였다.

| 선택 | 회차당 API | 회차당 시간 | 클라우드 요구 |
|---|---|---|---|
| `soniox` | **~₩270** | API 대기 | CPU 만으로 OK |
| `hybrid` / `whisper` | **₩0** | 351초 (실측·CUDA) | **GPU 필요** |

- **B(content.analyze)를 CPU Cloud Run Job 으로 올리려면 `STT_PROVIDER=soniox` 로 바꿔야 한다.**
  회차당 +₩270 이다. 월 12건이면 +₩3,240 — 인프라비보다 크다.
- GPU 워커를 어차피 GEBD 때문에 띄운다면, STT 도 거기서 돌려 ₩0 으로 둘 수 있다.
  **단 그러면 `content.analyze` 를 CPU/GPU 로 쪼개거나 통째로 GPU VM 에 둬야 한다.**

> **이 결정을 먼저 해야 나머지 설계가 정해진다.** 지금 답은 "GEBD 쿼터가 풀리는지" 에 달렸다.

---

## 4. GEBD 모델 이전 (이 문서의 본론)

### 4.1 GPU 는 선택이 아니다 — 실측

CPU 전용으로 돌려봤다(`docker run` 에서 `--gpus` 제거):

```
[cputest] 9.45s 만에 실패 · exit status 1
  clip_feature_extraction.py … returned non-zero exit status 1
```

mmaction2 0.x 의 `clip_feature_extraction.py` 가 CUDA 를 요구한다. 코드를 고쳐 CPU 로
내릴 수는 있겠지만, `deploy/gebd/Dockerfile` 이 경고하듯 **버전이 전부 고정**이라
(`torch==1.8.1+cu111` · `mmcv 1.x` · `mmaction2 0.x`) 손대는 비용이 크고,
3,600 클립을 CPU 로 돌리면 어차피 느리다. **GPU 로 간다.**

### 4.2 무엇을 올려야 하나

| 자산 | 크기 | 어디로 |
|---|---:|---|
| Docker 이미지 `event-boundary-detection` | **26.9 GB** | Artifact Registry (`stepd` 저장소 신설 필요) |
| 모델 가중치 `model_cla_f_0_s_-1_7728.pt` | **1.58 GB** | **GCS** (이미지에 굽지 말 것) |
| `deploy/gebd/{scripts,cla,prepare}` | 97 KB | 이미지에 포함 or 런타임 마운트 |

**26.9GB 가 이번 이전의 진짜 비용이다.**

- 레이어 구성: 10.2GB + 7.84GB + 1.61GB + … — 베이스가 `pytorch:1.8.1-cuda11.1-cudnn8-**devel**` 이다
- **`devel` → `runtime` 베이스로 바꾸면 상당히 줄어든다.** 단 `mmcv-full` 을 소스 빌드하려면
  devel 이 필요하니, **멀티스테이지**(devel 에서 빌드 → runtime 으로 복사)로 가야 한다
- 가중치를 이미지에 굽지 않는다: 굽으면 28.5GB가 되고, 모델을 바꿀 때마다 전체를 다시 밀어야 한다.
  GCS 에 두고 시작 시 `gsutil cp` 하면 1.58GB 만 받는다

**업로드 시간을 먼저 재라.** 가정용 회선 업로드 20Mbps 기준 26.9GB ≈ **3시간**이다.
슬리밍 없이 그대로 밀면 그 시간이 그대로 든다. (Cloud Build 로 클라우드에서 빌드하면
업로드는 Dockerfile+컨텍스트뿐이지만, 이 이미지는 **원본 tar 로 받은 것**이라
`deploy/gebd/Dockerfile` 로 재현 빌드가 되는지 먼저 확인해야 한다.)

### 4.3 어떤 머신이 맞나 — 오늘 실측이 답을 준다

**GPU 사용률이 9~23% 였고 CPU 가 285% 였다.** 병목은 GPU 연산이 아니라 **CPU 측 비디오 디코딩**이다.

| Stage | 시간(58.6분 회차) | 성격 |
|---|---:|---|
| A. 정규화 인코딩 + 청크 | 277초 | **CPU** (ffmpeg) |
| B. TSN feature | 324초 | GPU + **CPU 디코딩** (여기가 병목) |
| C. SJNET 추론 | 43초 | GPU (실제 추론은 3초) |
| **합계** | **371초** | |

→ **비싼 GPU(L4/A100)를 살 이유가 없다. T4 + CPU 넉넉한 머신이 맞다.**
`n1-standard-8` + T4 정도. vCPU 를 늘리면 Stage A·B 가 같이 빨라진다.

> `CORES=1` 은 유지할 것. parmap 병렬은 산출물을 통째로 날린다(실측 12청크 19분에 feature 0개).
> 클라우드에서 병렬을 원하면 **회차 단위로 인스턴스를 늘리는** 편이 안전하다.

### 4.4 비용 (T4 spot 이 안 되면 온디맨드)

`PREEMPTIBLE_CPUS=0` 이라 **spot 은 지금 불가**다. 온디맨드 기준(us-central1 리스트가 추정):

| 항목 | 단가(추정) | 회차당 6.2분 | 월 12건 |
|---|---:|---:|---:|
| T4 GPU | ~$0.35/h | $0.036 | $0.44 |
| n1-standard-8 | ~$0.38/h | $0.039 | $0.47 |
| 부팅 디스크 100GB | ~$4/월 (상시) | — | $4 |
| AR 스토리지 26.9GB | ~$0.10/GB/월 | — | $2.7 |
| **합계** | | | **~$8 (₩1.1만)/월** |

**idle STOP 이 필수다.** 상시로 켜두면 T4+n1-standard-8 이 월 ~$530 이다.
잡이 오면 부팅 → 처리 → 10분 idle 후 자동 종료 구조로 가야 한다
(`deploy/gebd-vm.sh` 에 이미 그 설계가 있다).

**부팅마다 26.9GB 이미지를 받는 비용도 계산에 넣어라.** 같은 리전이면 egress 는 무료지만
pull 시간이 회차당 수 분 붙는다. → **부트 디스크에 이미지를 구운 커스텀 이미지**를 만들거나,
디스크를 유지한 채 인스턴스만 STOP/START 하는 편이 낫다.

---

## 5. 권장 순서

| # | 할 일 | 선행조건 | 비고 |
|---|---|---|---|
| 0 | **GPU 쿼터 상향 신청** (`GPUS_ALL_REGIONS` ≥ 1, us-central1 T4) | — | **지금 바로.** 승인에 수일 |
| 0' | Spot 쿼터도 같이 (`PREEMPTIBLE_CPUS`) | — | 되면 비용이 크게 준다 |
| 1 | **STT 방침 결정** (soniox vs GPU whisper) | — | §3. 나머지 설계가 여기 달렸다 |
| 2 | 이미지 슬리밍 (멀티스테이지 devel→runtime) + 재현 빌드 검증 | — | 26.9GB 를 줄여야 push 가 현실적 |
| 3 | AR `stepd` 저장소 생성 + 이미지 push | 2 | `GEBD_IMAGE` 기본값이 이미 이 경로를 가리킴 |
| 4 | 가중치를 GCS 로 (`gs://stepd-media/models/gebd/`) | — | 이미지와 분리 |
| 5 | A(경량 잡) → Cloud Run Job + Scheduler | — | 앞 문서 §5. 폴링 제거 |
| 6 | B(`content.analyze`) → Cloud Run Job | 1 | **tmpfs 메모리 함정**(§6) |
| 7 | C(`gebd.detect`) → GPU VM + idle STOP | 0,3,4 | 쿼터 승인 후 |

**0·1 은 코드가 필요 없다. 오늘 바로 할 수 있고, 나머지의 선행조건이다.**

---

## 6. 남은 기술 리스크

- **Cloud Run Job 의 `/tmp` 는 tmpfs(메모리)다.** 60분 영상을 받으면 그만큼 메모리를 먹는다.
  `content.analyze` 의 실제 피크 메모리를 재야 Job 메모리를 정할 수 있다(앞 문서 §6에도 있음).
  ffmpeg 정규화 산출물(256p 청크 121MB)은 작지만 **원본 1GB 영상**이 문제다.
- **이미지 재현 빌드 미검증.** `deploy/gebd/Dockerfile` 은 대안으로 써둔 것이고
  원본 tar 이미지와 동일한지 확인된 적이 없다. push 전에 이걸로 빌드→실행이 되는지 봐야 한다.
- **리전 결정.** 영상이 us-central1 GCS 에 있으므로 GPU 워커도 us-central1.
  Vertex 만 asia-northeast3 로 남는다(API 호출이라 무해).
- **`GEBD_IMAGE` 기본값이 asia-northeast3 를 가리킨다** — us-central1 로 가면 코드/설정을 맞춰야 한다.
- **쿼터가 안 풀리면?** GEBD 를 로컬 GPU 에 남기고 나머지만 클라우드로 가는 하이브리드가 폴백이다.
  경계는 회차당 6.2분·₩0 이고, `boundaries.json` 을 GCS 에 얹으면 파이프라인이 알아서 소비한다
  (지문에 해시가 들어 있어 beats 이후만 재생성된다). **품질 손해 없이 뒤로 미룰 수 있는 유일한 조각이다.**

---

## 관련

- `docs/plans/worker-cloud-migration.md` — 워커 이전 비용·선택지 (§1 전제 일부 정정 필요)
- `docs/ops/pipeline-current-state.md` — 파이프라인 실제 상태
- `deploy/gebd/README.md` — GEBD 실행·제약
- `docs/ops/infra.md` — 인프라 SSOT

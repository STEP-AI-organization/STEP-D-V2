# GPU 쿼터 상향 신청 가이드 (step-d)

> 2026-08-07. GEBD 화면전환 모델을 클라우드 GPU 로 올리려면 이 신청이 **유일한 선행조건**이다.
> 코드·이미지·배선은 준비돼 있고 쿼터만 0 이다.

## 지금 상태 (실측 조회)

| 쿼터 | 현재 | 필요 | 의미 |
|---|---:|---:|---|
| **GPUs (all regions)** `GPUS_ALL_REGIONS` | **0** | **1** | ⛔ 이게 0 이면 **어느 리전에서도 GPU 를 못 만든다** |
| NVIDIA T4 GPUs · us-central1 | 1 | 1 | 이미 있음 (전역이 0이라 무의미) |
| Preemptible NVIDIA T4 GPUs · us-central1 | 1 | 1 | 이미 있음 |
| **Preemptible CPUs** · us-central1 | **0** | **8** | Spot VM 을 못 만든다 (비용 60~91% 절감분을 못 씀) |
| CPUS · us-central1 | 200 | — | 여유 |

프로젝트: `step-d` (번호 `872105344568`) · 생성 2026-04-22 · Compute API 활성됨.

**리전은 us-central1 로 신청할 것.** 영상 원본(`gs://stepd-media`)과 Cloud Run 이 거기 있어서,
다른 리전에 GPU 를 두면 회차마다 1GB 를 대륙 간으로 옮기게 된다.

---

## 화면에서 뭘 누르나

### 1. 쿼터 페이지 열기

직접 URL (가장 빠름):

```
https://console.cloud.google.com/iam-admin/quotas?project=step-d
```

메뉴로 가려면: 좌측 햄버거(☰) → **IAM 및 관리자** → **할당량 및 시스템 한도**
(영문: IAM & Admin → Quotas & System Limits)

### 2. 첫 번째 — GPUs (all regions) ⛔ 제일 중요

1. 상단 **필터** 입력칸에 `GPUs (all regions)` 입력
   - 한국어 콘솔이면 **`GPU(모든 리전)`**
   - 안 걸리면 필터를 **`할당량: gpus_all_regions`** 로 바꿔서 검색
2. 결과 행의 **왼쪽 체크박스** 클릭
3. 표 위쪽 **`할당량 수정`** (영문 **EDIT QUOTAS**) 버튼 클릭
   - 버튼이 회색이면 권한 부족 → 아래 §권한 참조
4. 오른쪽에 패널이 열린다:
   - **새 한도** 에 **`1`** 입력
   - **요청 설명** 에 아래 §신청 문구 붙여넣기
5. **`요청 제출`** (SUBMIT REQUEST) 클릭

### 3. 두 번째 — Preemptible CPUs (선택이지만 권장)

1. 필터에 `Preemptible CPUs`
2. **리전(Region) 열이 `us-central1`** 인 행을 고를 것 (여러 리전이 나온다)
3. 체크 → **할당량 수정** → 새 한도 **`8`** → 같은 설명 → 제출

이게 있으면 Spot VM 을 쓸 수 있어 GPU VM 비용이 크게 준다. 없어도 온디맨드로 굴러간다.

### 4. 확인

제출하면 이메일이 온다. 상태는 같은 페이지 상단 **`할당량 증가 요청`** 탭에서 본다.
- **자동 승인**: 작은 요청은 수 분~수 시간
- **수동 검토**: 2~3 영업일

CLI 로 확인:

```bash
gcloud compute project-info describe --project=step-d \
  --format="value(quotas[].metric,quotas[].limit)" | tr ';' '\n' | grep -i gpu
```

`GPUS_ALL_REGIONS` 가 1 이상이면 승인된 것이다.

---

## 신청 문구 (그대로 붙여넣기)

**영문으로 쓰는 게 처리가 빠르다.** 리뷰어가 "무엇을·왜·얼마나" 를 본다 — 구체적인 워크로드와
사용량을 적을수록 승인률이 올라간다. 아래는 이 프로젝트의 실측을 반영한 것이다.

```
We run a video analysis pipeline (STEP-D) that requires GPU inference for a
scene-boundary detection model (TSN feature extraction + SJNET, PyTorch/CUDA).

Requested: 1 x NVIDIA T4 in us-central1 (GPUs all regions = 1).

Workload profile:
- ~12 video episodes per month, each ~60 minutes long
- GPU time per episode: ~11 minutes (measured on local hardware)
- Total expected usage: ~2.5 GPU-hours per month
- The instance will be started per job and stopped immediately after
  (idle auto-shutdown), not run continuously

Why us-central1: our source videos are stored in a GCS bucket in us-central1
(gs://stepd-media) and our Cloud Run services run there. Placing the GPU in
another region would require cross-region transfer of ~1GB per episode.

The model cannot run on CPU (the mmaction2 feature extractor requires CUDA),
so a GPU is required.

Billing is active on this project and we already run Cloud Run and Cloud SQL
workloads here.
```

Preemptible CPUs 신청에는 아래를 덧붙인다:

```
Additionally requesting Preemptible CPUs = 8 in us-central1 so the same
workload can run on Spot VMs. The job is fully restartable (checkpointed,
max 2 retries), so preemption is acceptable and reduces our cost.
```

---

## 권한 — `할당량 수정` 버튼이 회색이면

쿼터 편집에는 아래 중 하나가 필요하다:
- `roles/servicemanagement.quotaAdmin` (할당량 관리자)
- `roles/owner` (소유자)
- `roles/editor` **로는 안 되는 경우가 있다**

본인 계정(`hkj@stepai.kr`)에 권한이 있는지:

```
https://console.cloud.google.com/iam-admin/iam?project=step-d
```

에서 본인 행의 역할을 확인. 없으면 소유자 계정으로 로그인하거나 역할을 추가해야 한다.

> ⚠️ 서비스 계정(`stepd-deployer`)으로는 못 한다 — 실제로 시도했더니
> `iam.serviceAccounts.setIamPolicy` 부터 막혔다. **사람 계정으로 콘솔에서** 해야 한다.

---

## 거절되면

프로젝트가 2026-04-22 생성으로 아직 3~4개월 차라 **거절될 수 있다**(신규 프로젝트는 GPU 쿼터를
잘 안 준다). 그 경우:

1. **결제 이력을 좀 쌓고 재신청.** 보통 한두 달 정상 결제 후엔 통과한다.
2. **금액을 줄여 재신청.** T4 1개는 이미 최소 단위다 — 대신 설명에 예상 사용량
   (월 2.5 GPU-시간)을 강조.
3. **다른 리전 시도.** us-central1 이 혼잡하면 us-west1·us-east1 이 열리기도 한다.
   단 GCS egress 를 감수해야 한다.
4. **외부 GPU 로 우회.** RunPod 등은 쿼터가 없다 (월 ~₩2,000~5,500 추정).
   `docs/plans/cloud-migration-model-and-worker.md` 참조.
5. **그냥 로컬 GPU 유지.** GEBD 는 파이프라인을 막지 않는다 — 없으면 fallback 경계로 완주하고,
   나중에 `boundaries.json` 을 GCS 에 얹으면 beats 이후만 재생성된다. **서두를 이유가 없다.**

---

## 승인된 뒤 할 일

1. AR `stepd` 저장소 생성 (us-central1) — 지금 없다
2. GEBD 이미지 슬리밍 (26.9GB · devel→runtime 멀티스테이지) 후 push
3. 가중치(1.58GB)를 `gs://stepd-media/models/gebd/` 로
4. GPU VM 생성 + idle STOP 스크립트
5. content Job 에 `AUTO_GEBD=1`, gebd 워커에 `GEBD_IMAGE`·`GEBD_MODEL_GCS` 설정

상세: `docs/plans/cloud-migration-model-and-worker.md` §5

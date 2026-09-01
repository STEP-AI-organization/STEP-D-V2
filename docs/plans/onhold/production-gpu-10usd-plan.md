# 월 $10 GPU 운영 계획 — Soniox 이관 + On-demand GEBD VM

2026-07-31 · 사용자 지시. 방송사 1곳 상시 처리 GPU 비용 월 $10 이하 목표.

## Context

- **STT** 는 [[stt-diarize-chyron-stack]] 확정 (Soniox v5 async + PyAnnote 3.1 + chyron per-seg) · 로컬 GPU 요구 대부분 사라짐
- **남은 로컬 GPU 부하** = GEBD (mmaction2) 뿐. 방송사 1곳 하루 20~80분만 사용
- 워커는 현재 pm2 로컬 (과거 GCE VM 폐기 상태). 클라우드 GEBD 미배선
- `core/asr.py` 이미 Soniox 옵션 있음 (`STT_PROVIDER=soniox`) · 2026-07-31 default 로 전환

## 전환 후 예상 비용 (GCP asia-northeast3 Spot)

| 항목 | 월 |
|---|---|
| T4 Spot GPU (30h/월) | $3.3 |
| n1-standard-4 Spot | $1.2 |
| pd-standard 20GB | $1 |
| 네트워크·GCS I/O | $1~2 |
| **합계** | **$6~10 ✅** |

## 변경 축 3개

### A. Soniox default 화 (로컬 whisper 제거)

- `core/asr.py`: `STT_PROVIDER` default `"gemini"` → `"soniox"` ✅ (이 세션 반영)
- `STT_FALLBACK` default `"whisper"` → `"off"` ✅ (이 세션 반영)
- `deploy/worker-env.sh`: `STT_PROVIDER=soniox`, `SONIOX_API_KEY` Secret Manager 로 (별도 세션)
- whisper lazy import 코드는 남김 · 호출 없으면 dead · 삭제 후속

### B. GEBD 전용 on-demand GPU VM

`deploy/worker-vm.sh` (범용 2-lane 워커) 참조 · GEBD 전용 3rd lane VM 신규.

**신규 파일**:
- `deploy/gebd-vm.sh` — worker-vm.sh 축소판. Node · CloudSQL 프록시 동일, systemd 서비스는 `WORKER_JOBS=gebd` 단일 lane
- `deploy/gebd-vm-create.sh` — gcloud 로 spot T4 인스턴스 생성

**VM 스펙**:
```
--machine-type=n1-standard-4
--accelerator=type=nvidia-tesla-t4,count=1
--provisioning-model=SPOT
--instance-termination-action=STOP     # 선점당해도 디스크 유지, 재부팅만
--boot-disk-size=20GB --boot-disk-type=pd-standard
--image-family=common-cu121-debian-11  # deep-learning-vm (드라이버 프리설치)
--metadata-from-file=startup-script=deploy/gebd-startup.sh
--zone=asia-northeast3-c
```

**startup-script (`deploy/gebd-startup.sh`)**:
1. GEBD Docker 이미지 pull (mmaction2 + CUDA 12.1) · 이미지는 GAR 에 미리 push
2. `stepd-worker-gebd.service` systemd unit 기동 (`WORKER_JOBS=gebd`)
3. 자동 종료 데몬: `pending_gebd == 0` 이 10분 지속되면 `shutdown -h now`

### C. 큐 트리거로 VM 부팅

**서버 변경 (`apps/server/src/index.ts`)**:
- 신규 잡 타입 `gebd.detect` — `content.analyze` 가 GEBD 필요 구간에 이 잡을 enqueue
- 신규 라우트 `POST /api/admin/gebd-vm/wake` — pending `gebd.detect > 0` 이면 `gcloud compute instances start stepd-gebd` (Cloud Run SA 에 `compute.instanceAdmin.v1` 부여)
- Cloud Scheduler cron 3분 주기로 위 라우트 호출 (`queue.ts::queueStats` 재사용)

**워커 변경 (`apps/server/src/worker.ts`)**:
- `WORKER_JOBS` 목록에 `gebd` lane 추가 (기존 `youtube`/`content` 와 나란히)
- `gebd.detect` 핸들러: 미디어 다운로드 (GCS→/tmp) → GEBD Docker 호출 → boundaries.json GCS 업로드 → 원 잡 (`content.analyze`) 재개 트리거

**pipeline 분리 (`apps/server/src/pipeline/content-pipeline.ts`)**:
- 현재 `core/analyze.py` 는 단일 프로세스 · GEBD 단계를 별도 잡으로 분리:
  - **Phase 1** (Cloud Run 워커): STT · refine · scenes 까지
  - **Phase 2** (GEBD VM): boundaries 만
  - **Phase 3** (Cloud Run 워커 복귀): beats · vision · recommend
- 체크포인트 재개 로직 이미 있음 ([[pipeline-chunked-parallel]]) · phase 경계에서 자연스럽게 대기

## 재사용 지점

- `apps/server/src/pipeline/queue.ts` — `FOR UPDATE SKIP LOCKED`, dedupeKey, queueStats 그대로
- `apps/server/src/worker.ts` — `WORKER_JOBS` env 로 lane 분리 이미 지원, 새 핸들러만 등록
- `deploy/worker-vm.sh` + `deploy/worker-env.sh` — CloudSQL 프록시 · secret 로딩 재사용
- `core/boundaries.py` — GEBD JSON 계약 정의됨. Docker 호출부만 새 배선
- `apps/server/src/media/storage-gcs.ts` — 미디어·산출물 GCS I/O 그대로

## Verification

1. **Soniox default 검증** (이번 세션 이후)
   - `STT_PROVIDER` env unset · `python -m core.analyze <sample>` 로그에 `provider=soniox` 확인
   - 60분 샘플 실측 원가가 [[stt-diarize-chyron-stack]] 기록(~300원) 과 일치
2. **GEBD VM 왕복 검증 (수동)**
   - `gcloud compute instances create stepd-gebd ... --provisioning-model=SPOT` 부팅
   - Cloud SQL 큐에 `gebd.detect` 잡 1건 삽입 → `journalctl` 로 lane 픽업 확인
   - boundaries.json 이 `GCS analysis/{mediaId}/boundaries.json` 에 올라오는지
   - 잡 종료 후 10분 idle → 자동 shutdown 확인
3. **트리거 자동화 검증**
   - Cloud Scheduler 강제 실행 → Cloud Run 로그에 wake 호출 확인, VM status RUNNING 전이
   - pending 큐 비어있으면 wake 는 no-op
4. **비용 검증 (배선 후 1주일)**
   - GCP Billing "Compute Engine" SKU 라인 확인
   - 예상: T4 Spot + n1-standard-4 Spot + 20GB pd-standard = 주당 $1.5~2.5
5. **회귀 검증**
   - 방송사 1편 60분 샘플 end-to-end 완주 (upload → content.analyze → gebd.detect → beats → recommend)
   - recommendation 개수·품질이 pm2 로컬 결과와 동등

## 배포 순서 (세션 로드맵)

| # | 세션 | 산출물 |
|---|---|---|
| 1 | **이 세션** | Soniox default (`asr.py`) · Vision 429 backoff · 명세 문서 |
| 2 | Secret Manager | `stepd-soniox-api-key` · `stepd-hf-token` 등록 (수동) |
| 3 | 로컬 pm2 검증 | 로컬 워커로 1주 실측 · Soniox default 안정성 확인 |
| 4 | GEBD Docker | 이미지 빌드 & GAR push |
| 5 | GEBD VM 스크립트 | `deploy/gebd-vm.sh` · `startup-script` · 수동 부팅 테스트 |
| 6 | 서버 라우트 | `/api/admin/gebd-vm/wake` + `gebd.detect` 잡 배선 |
| 7 | content-pipeline 3-phase | Phase 1/2/3 분리 · 체크포인트 재개 검증 |
| 8 | Cloud Scheduler | cron 3분 주기 등록 |
| 9 | 1주 비용 확인 | 임계값 튜닝 (idle 10분 · cron 3분 초기값) |

## Out of Scope (다음 세션들)

- STT 완전 whisper 삭제 (dead code 정리는 후속)
- 다중 방송사 (3~5곳) 확장 시 GPU 병렬 상한 조정 (지금은 1방송사 전제)
- `gebd.detect` 실패 시 Cloud Run 워커 fallback (당분간 재큐만)

## 관련 문서·메모리

- [[stt-diarize-chyron-stack]] — 이 스택 확정 배경
- [[cost-time-conscious-smoke]] — 스모크 전 사전 비용 판정
- [[pipeline-chunked-parallel]] — 체크포인트 재개 흐름
- [[gebd-model-limits]] · [[gebd-gpu-parallel]] · [[beat-pipeline-v1]] — GEBD 실측 함정
- `deploy/worker-vm.sh` · `deploy/worker-env.sh` — VM 세팅 참조

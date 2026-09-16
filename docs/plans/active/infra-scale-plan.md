# 인프라 스케일 플랜 — 트리거 기반 (2026-09-16)

> **"언제 무엇을 사는가"를 날짜가 아니라 실측 트리거로 정한다.** 물량 예측으로 미리 사면
> 고정비만 늘고(현 총액의 90%가 이미 고정비), 늦게 사면 고객이 기다린다 — 그래서 각 증설
> 항목에 **지표·임계·보는 곳**을 붙여 두고, 지표가 임계를 넘으면 그때 산다.
>
> 현황 정본은 [../../ops/infra.md](../../ops/infra.md)(단일 진실 소스) — 이 문서는 **증설 결정
> 기준**만 소유한다. 단가·고정비 숫자를 여기 복제하지 않는다(한쪽이 반드시 낡는다).

## 0. 기준선 — 2026-09-16 서지 대응 1차 적용 후

이 플랜의 출발점. 전부 **고정비 증가 ₩0** 으로 적용됐다(커밋 f3c7a86 · infra.md 갱신):

- **enqueue 즉시 킥**: content 레인 잡이 큐에 들어오는 순간 서버가 `jobs:run`(taskCount=4)으로
  워커를 깨운다(`apps/server/src/pipeline/worker-kick.ts`). 분석 착수 지연 최대 15분 → 60초 미만.
- content Job 템플릿 `tasks=1 · parallelism=4` — 스케줄 틱은 1태스크(저렴), 킥 실행만 4병렬.
- 스케줄러 안전망 `*/15 → */5`(킥이 못 닿는 윈도우2·GPU VM·youtube Job 발 enqueue 커버).
- `stepd-render` max-instances 5→10 (min0 라 고정비 0).
- Vertex 쿼터: **신청 대상 아님** — Gemini 2.x 는 DSQ(공유 쿼터) 체제라 프로젝트별 상향 경로가
  없고, 429 는 `core/common/retry.py` 백오프가 흡수한다. 서지 후 usage.json 재시도율만 본다.

**이번에 검토 후 제외한 것**(아래 트리거가 걸리면 재소환): GPU VM 2호기 · 사무실 PC 추가 ·
DB 스펙업/HA · 서버 min-instances 증설.

**기대 캐퍼시티**: 20회차 동시 유입 시 분석 적체 ~5.5h → **~1.5h**. 남은 직렬 캡은 GPU VM
1대(gebd·cast)와 윈도우2(다운로드·네이버·커머스) — 이 둘이 아래 표의 첫 트리거들이다.

## 1. 증설 트리거 표

| 항목 | 트리거 지표 (보는 곳) | 임계 | 조치 | 월 비용 | 리드타임 |
|---|---|---|---|---|---|
| **① GPU VM 2호기** (gebd·cast 병렬) | `gebd.detect`·`cast.detect` 의 createdAt→lockedAt 대기 (`/api/admin/jobs` 또는 §2 쿼리) | p95 > 30분이 서지마다 반복 | `deploy/gebd/` 스크립트로 VM 복제 · 레인은 큐 경쟁이라 코드 변경 0 (SKIP LOCKED) | 디스크 ₩13,800 + spot 가동 ~₩300/h | 반나절 |
| **② inpaint GPU 레인** (AI 자막 지우기) | 제품 결정 — LaMa(Apache 2.0) 채택 확정 | 결정 즉시 | 기존 GPU VM 에 레인 추가(고정비 0) → ①과 경합 실측되면 2호기로 | 가동시간만 | 2~4일 (배선) |
| ~~③ DB 스펙업~~ (1→2vCPU·8GB) | **2026-09-16 선제 적용됨**(사용자 지시 · 트리거 대기 없이 — 병렬 4 분석의 공유 병목 대비) | — | 완료 · 재시작 수 분으로 무사 | +₩69,800 반영 | — |
| **④ DB HA** (장애 대기 인스턴스) | 사업 신호 — 유료 고객 SLA 요구, 또는 월매출 > 고정비 3배 | 계약 조건 발생 시 | HA 활성화 | +₩69,800 | 1시간 |
| **⑤ 서버 min-instances 1→2** | `/api/state` p95 지연 · 프록시 fetch failed 재발 (Cloud Run 지표) | p95 > 1.5s 상시 | cloudbuild.yaml `--min-instances` | +₩36,000~55,000 | 배포 1회 |
| **⑥ 분석 병렬 4→8** | 서지 중 4태스크 풀가동인데 큐 대기 유지 (executions 로그 + §2 쿼리) | 반복 관측 시 | `gcloud run jobs update --parallelism=8` + worker-kick taskCount 상향 | ₩0 고정 | 10분 · ⚠️ DB 커넥션 상한 점검(태스크×5) |
| **⑦ 윈도우2 이중화** | 다운로드·네이버 발행 실패가 **고객에게 닿은 사건** | 1회 발생 | 사무실 PC 1대 추가 (이번 결정에서 제외 — SPOF 리스크로 기록) | 일회성 ₩50~80만 | 1~2일 |
| **⑧ GCS 수명주기** | 미디어 버킷 용량 (현 ~50GiB) | 200GiB 초과 | 원본 90일 후 coldline 정책 | 절감 항목 | 1시간 |

## 2. 트리거를 보는 눈 — 이게 없으면 위 표는 장식이다

트리거 지표 대부분이 지금 **아무도 안 보는 값**이다. 최소 배선 셋(전부 무료), 후속 작업으로:

1. **큐 대기 p95 쿼리** — 주간 점검용 한 방 (프로덕션 DB · [[prod-db-query-via-proxy]] 경로):
   ```sql
   select type, count(*),
          percentile_cont(0.95) within group (order by (lockedAt-createdAt)/1000) as wait_p95_s
     from job_queue where createdAt > extract(epoch from now()-interval '7 days')*1000
      and lockedAt is not null group by type order by wait_p95_s desc;
   ```
2. **Cloud Monitoring 알림 2개**: Cloud SQL CPU>70%(5분) · 서버 로그 `worker-kick] 실패` 빈발.
3. **Vertex 429 재시도율**: 서지 다음 날 `usage.json`(회차별 GCS)에서 재시도 비중 확인 —
   경로는 `.claude/skills/cost-check` 참조.

## 3. 이력

- **2026-09-16 작성.** 서지 대응 1차(킥·병렬4·틱 5분·렌더 maxScale10) 적용과 동시에.
  사용자 결정: GPU VM 2호기·사무실 PC·DB/서버 스펙업은 선구매하지 않고 트리거로 미룸.
- **2026-09-16 같은 날 갱신**: ③ DB 스펙업은 사용자 지시로 선제 적용(2vCPU·8GB · +₩69,800).
  §2 의 감시 배선 중 Monitoring 알림 2개(SQL CPU·worker-kick 실패 → hkj@stepai.kr 메일)도 생성됨.

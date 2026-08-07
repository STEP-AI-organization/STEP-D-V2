# Factory API — 소스 영상 하나로 완주·자동배포

2026-08-05 · 방향성 스케치. 아직 구현 안 함.

> "고객이 소스 영상 URL 하나만 던지면 · 분석·쇼츠·썸네일까지 만들고 · 지정 채널로 알아서
> 배포까지" — 이걸 외부 API 하나로 노출하는 그림.

---

## 왜 지금 그릴 수 있나

파편은 이미 90% 있음:

- 업로드(`upload-init/finalize`) · GCS resumable
- `content.analyze` 잡 · core AI 파이프라인 (STT→beats→shorts→썸네일)
- adopt → clip → `ffmpeg.trimEncode`
- 배포 계정 등록 · YouTube (analytics·publish) / Meta / TikTok

남은 것 = **오케스트레이터 잡 1개 + 얇은 진입 API + 웹훅**. 새 파이프라인 아님.

---

## API 표면 — 3개면 충분

### 1) `POST /api/factory/ingest`

진입 엔드포인트 하나. 소스 URL + 대상 계정 + 정책 → 즉시 202.

```json
{
  "sourceUrl": "gs://bucket/xxx.mp4  또는  https://…",
  "programId": "p_xxx",
  "targets": [
    "youtube:UCxxx",
    "meta:page_yyy",
    "tiktok:open_zzz"
  ],
  "policy": {
    "autoPublish": true,
    "maxShorts": 5,
    "minConfidence": 0.7,
    "requireCastMapped": true
  },
  "webhookUrl": "https://client.example.com/hook",
  "idempotencyKey": "customer-supplied-uuid"
}
```

응답:
```json
{ "jobId": "f_abc123", "status": "queued" }   // 202
```

- 파일 업로드 자체는 별도 resumable API 재사용. 여기는 이미 GCS/HTTPS 에 올려둔 URL 만.
- `idempotencyKey` (또는 sourceUrl 해시) 로 같은 요청은 기존 jobId 반환.

### 2) `GET /api/factory/jobs/:jobId`

폴링용. 스테이지별 진행률 + 산출물 링크.

```json
{
  "jobId": "f_abc123",
  "status": "publishing",
  "stages": [
    { "name": "analyze",    "state": "done",    "at": 1712... },
    { "name": "adopt",      "state": "done",    "at": 1712... },
    { "name": "render",     "state": "done",    "at": 1712... },
    { "name": "publish",    "state": "running", "progress": 0.5 }
  ],
  "shorts": [ { "clipId": "c_1", "duration": 47.2 }, ... ],
  "distributions": [
    { "target": "youtube:UCxxx", "state": "published", "url": "…" },
    { "target": "meta:page_yyy", "state": "failed", "error": "…", "retryAt": … }
  ]
}
```

### 3) 웹훅 (양방향)

같은 이벤트를 `webhookUrl` 로도 푸시. HMAC 서명 (`X-STEPD-Signature`).

이벤트: `factory.queued` · `analyzed` · `shorts_ready` · `rendered` · `published` · `failed`.

---

## 안쪽 오케스트레이터 — 새 잡 1개

`factory.orchestrate` (`apps/server/src/worker.ts` handle 스위치에 추가).

```
factory.orchestrate
  1. mediaId 확보 (sourceUrl → 이미 있으면 재사용, 없으면 등록)
  2. enqueue content.analyze { mediaId }
  3. 완료 감지 (polling analysis.json or completion marker)
  4. shorts 필터: policy.minConfidence · maxShorts · requireCastMapped
  5. 각 short 자동 adopt → clip
  6. 각 clip × 각 target → distribution.publish fan-out
  7. 매 스테이지 완료 시 webhook 발사
  8. 부분 실패 시 실패 target 만 재큐 (지수 백오프)
```

기존 코드는 그대로. content-pipeline · distribution 로직 재활용.

---

## 경계 조건 — 이것부터 결정

### 인증
- 테넌트 단위 API key (`Authorization: Bearer stepd_...`)
- 테넌트 = 방송사 / MCN 하나. 각자 자기 programId · 자기 targets 만 접근.
- Rate limit: 테넌트 당 시간당 N ingest.

### 멱등성
- `idempotencyKey` (없으면 `sourceUrl + programId + targets` 해시).
- 같은 키 24h 안 재요청 → 기존 jobId 반환 (재작업 X).

### 에러 정책
- 부분 실패 허용 — 3 target 중 1개 실패해도 나머지는 `published`, 실패 채널만 재큐.
- 파이프라인 자체 실패 (analyze 크래시) 는 즉시 `failed` + 웹훅 · retry X (사람 개입).
- Rate limit / 인증 실패 = 4xx, 그 외 = 5xx.

### Auto-publish gate (중요)
`policy.autoPublish=true` 이어도 아래 하나라도 걸리면 `awaiting_review` 로 hold:
- `shorts.confidence < policy.minConfidence`
- `requireCastMapped=true` 인데 매핑 안 된 얼굴 클러스터 존재
- 저작권 flag (음원·타 방송사 로고 감지)
- 프로그램별 published shorts cooldown (같은 프로그램 최근 24h N개 초과)

hold 는 웹훅 `awaiting_review` 로 알림 · 사람이 앱에서 승인 눌러야 publish. 신뢰 쌓이면 gate 완화.

---

## 왜 이 모양이 최소치인가

- **엔드포인트 1개** — SDK/문서 부담 최소, 고객 통합 코스트 낮음.
- **오케스트레이터 잡 1개** — 파이프라인·배포 로직 안 건드림. 롤백 쉬움.
- **웹훅 + 폴링 병용** — 폴링만 강제하면 고객 부담, 웹훅만 하면 미수신 시 어두워짐. 둘 다.
- **멱등성 + 부분 실패 정책** — 재시도 폭탄·이중 배포 방지.

---

## 미해결 (결정 필요)

- [ ] `sourceUrl` 인증 — 고객 GCS/S3 접근 위임? 우리가 임시 재업로드? (초기: **재업로드 (다운받아 우리 GCS 로 복사)** — 인증 위임 복잡 · 재현성 확보)
- [ ] webhook 재전송 · dead-letter — 3회 실패 시 어떻게 · 관리 UI 필요?
- [ ] 테넌트 관리 UI — API key 발급·회수·usage 대시보드
- [ ] SLA · 처리 지연 (60분 영상 기준 ingest→published 목표 시간)
- [ ] 과금 모델 — 영상 분당? 배포 채널당? shorts 개수당?

---

## 관련

- 지금 실제 채널 등록 상태 · [../ops/infra.md](../ops/infra.md) (YouTube/Meta/TikTok 계정 저장)
- 파이프라인 · [step-d-master-build-plan.md](step-d-master-build-plan.md)
- Meta App Review · [meta-app-review-submission.md](meta-app-review-submission.md) (배포 전 필수)

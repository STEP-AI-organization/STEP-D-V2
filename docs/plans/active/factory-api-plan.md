# Factory API — 소스 영상 하나로 완주·자동배포

2026-08-05 스케치 · **2026-08-10 범위 확정 (사용자 결정)** · **2026-08-12 전제 변경 (아래)**

## 2026-08-12 전제 변경 — 소비자가 유료 외부 테넌트(ENA)가 됐다

"소비자 = AENA 사내"라서 보류했던 것들이 전부 되살아났고, 구현 방식이 바뀌었다:

| 2026-08-10 결정 | 2026-08-12 현재 |
|---|---|
| 서비스 간 ID 토큰 / x-factory-key | **워크스페이스 API 키** (`Authorization: Bearer stepd_live_…`) — factory 라우트가 `API_KEY_ROUTES` 화이트리스트에 등재(`factory:write`/`factory:read`) |
| 과금 불필요 | **선불 크레딧 과금** — videos/ingest 402 게이트 + factory.ts advance() 분석 직전 정밀 게이트, 차감은 기존 recordUsage |
| 테넌트 관리 UI 불필요 | superadmin 콘솔로 회사 개설·키 발급 (기존 다회사 3·4단계 재사용) |

x-factory-key 폐기 근거: 글로벌 단일 키라 테넌트 귀속(usage_events/credit_ledger)이
불가능했고, `/api/factory/*` 가 PUBLIC_PATHS 에 없어 AUTH_REQUIRED=1 이 되는 순간
미들웨어 401 로 구조적으로 죽는 경로였다. 대신 `/api/factory/*` 에 "키 또는 세션 필수"
미들웨어를 둬 익명 폴백(단일 테넌트 자세)을 막았다.

고객 문서: [../../reference/customer-api.md](../../reference/customer-api.md) (구 factory-api.md 를 대체)

> "고객이 소스 영상 URL 하나만 던지면 · 분석·쇼츠·썸네일까지 만들고 · 지정 채널로 알아서
> 배포까지" — 이걸 외부 API 하나로 노출하는 그림.

---

## 2026-08-10 확정 사항

**소비자는 AENA다** (사외 고객이 아니라 사내 웹서비스의 서브채널 공장 자동화).
이게 원래 스케치의 전제를 바꾼다:

| 원래(외부 고객 전제) | AENA면 |
|---|---|
| 테넌트별 API key 발급·회수·usage 대시보드 | **Cloud Run 서비스 간 ID 토큰**. 웹→서버 프록시가 이미 쓰는 방식 그대로 |
| 과금 모델 (분당/채널당/개수당) | **불필요** — 정산은 나중 |
| 웹훅 + HMAC 서명 | **후순위.** 폴링(`GET /jobs/:id`)으로 시작 |
| Rate limit = 남용 방지 | **사고 방지**로 목적 변경 (같은 영상 중복 ingest·폭주) |

**배포 범위 = YouTube 전용.** 지금 실제로 송출되는 채널이 그것뿐이다:

```
YouTube   실업로드 구현됨 · upload-gate.ts 3중 방어로 기본 OFF
Meta      계정 연결만 · 송출은 상태 기록 스텁 (index.ts:2945)
TikTok    계정 연결만 · Content Posting API 미구현 · 앱 심사 미완
SMR       스텁
```

Meta·TikTok 은 각각 앱 심사가 걸려 있어 일정을 우리가 못 정한다. 공장이 실제로
도는 걸 먼저 보고 채널을 늘린다.

**사람 개입 = 없음 (전자동).** 단 전자동은 되돌릴 수 있어야 성립한다.
아래 안전장치는 승인 절차가 아니라 **사고 시 손을 뗄 수 있는 장치**다:

1. **킬 스위치** — `FACTORY_ENABLED` 가 명시적 truthy 일 때만 ingest 를 받는다.
   기존 `upload-gate.ts` 와 같은 실패 방향(잘못된 env → "안 돌아감", "실수로 배포됨" 아님).
2. **비공개 업로드 후 공개 전환** — 업로드는 `private` 로 하고, 유예(기본 10분) 뒤
   공개로 바꾼다. 그 사이엔 URL 이 있어도 남이 못 본다. 되돌리기 = 전환 취소.
3. **일일 상한** — 프로그램당 하루 N개(기본 5). 넘으면 `hold`. 파이프라인 버그로
   같은 영상이 20번 올라가는 사고를 막는다.
4. **드라이런** — `policy.dryRun=true` 면 클립까지 만들고 업로드만 안 한다.
   붙이는 쪽(AENA)이 먼저 이걸로 검증한다.

원래 스케치의 `awaiting_review` gate 는 **쓰지 않는다**(사람 개입 없음 결정).
대신 위 3번(상한)에 걸린 건만 `hold` 로 남긴다.

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

- [x] ~~`sourceUrl` 인증~~ → **우리 GCS 로 재업로드** (인증 위임 복잡 · 재현성 확보).
      기존 `youtube.download` 잡이 이미 그 일을 한다.
- [x] ~~테넌트 관리 UI~~ → AENA 하나뿐이라 불필요. 서비스 간 ID 토큰.
- [x] ~~과금 모델~~ → 사내라 보류.
- [ ] **webhook 재전송·dead-letter** — 웹훅 자체를 후순위로 미뤘으므로 같이 보류.
- [ ] **SLA** — 60분 영상 기준 ingest→published 목표 시간. 실측 964초(분석) + 클립 렌더 +
      업로드. 대략 25~35분 예상이나 **측정 후 확정**.
- [ ] **공개 전환 유예 시간** — 기본 10분으로 두되, 운영하며 조정.
- [ ] **일일 상한 기본값** — 프로그램당 5개로 시작.

---

## 구현 순서 (2026-08-10)

1. **`factory.orchestrate` 잡 + `POST /api/factory/ingest` + `GET /api/factory/jobs/:id`**
   — 기존 잡을 엮기만 한다. 새 파이프라인 없음.
2. **킬 스위치·드라이런·일일 상한** — 1번과 같은 커밋에. 나중에 붙이면 안 붙는다.
3. **비공개 업로드 → 유예 후 공개 전환** — `distribution.publish` 에 privacy 인자가 이미
   있다(`privacy?: "public"|"unlisted"|"private"`). 전환 잡 하나 추가.
4. **AENA 붙이기** — 드라이런으로 먼저 관통 확인.
5. (그 뒤) Meta·TikTok 송출 — 각 앱 심사 통과 후.

## 관련

- 지금 실제 채널 등록 상태 · [../ops/infra.md](../../ops/infra.md) (YouTube/Meta/TikTok 계정 저장)
- 파이프라인 · [step-d-master-build-plan.md](step-d-master-build-plan.md)
- Meta App Review · [meta-app-review-submission.md](meta-app-review-submission.md) (배포 전 필수)

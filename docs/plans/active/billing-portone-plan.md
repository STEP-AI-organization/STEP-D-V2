# 과금 설계 — 포트원(PortOne) 연동 · 2수익원

2026-08-10 작성 · **설계 문서 (코드 변경 없음)**

> 수익원은 둘이다.
> **(A) 자체 웹서비스** — 운영자가 stepd.stepai.kr 을 쓰는 대가. 사람·조직 단위 **구독**.
> **(B) 외부 API** — 방송사가 자기 시스템에서 우리 파이프라인을 호출하는 대가.
> **영상 분석 분(minute) 단위 종량** (2026-08-10 사용자 결정).
>
> 둘은 요금 부과 방식이 다르지만 **원장(ledger)은 하나여야 한다.** 안 그러면
> "웹에서 분석한 60분"과 "API로 분석한 60분"의 원가·매출이 따로 놀아 정산이 깨진다.

---

## 0. 지금 상태 (실측)

- 결제·구독·API키·사용량 관련 코드는 **서버에 하나도 없다.** (`apps/server/src` grep 결과 0건)
- `docs/plans/active/factory-api-plan.md` 는 소비자를 사내 AENA 로 확정하며
  "과금 모델 → 사내라 보류", "테넌트 API key → 불필요(서비스 간 ID 토큰)" 로 닫아뒀다.
  **이 문서가 그 두 항목을 다시 연다.** factory API 는 이제 사내(AENA) + 사외(방송사)
  두 소비자를 갖는다 — 인증 경로가 갈라진다(§3).
- 원가 실측 근거: 58.6분 회차 = **964초 · 약 ₩285** → **분당 원가 ≈ ₩4.9**
  (STT Soniox + Gemini beat annotate + 임베딩 + GPU GEBD + 인코딩 합산).

---

## 1. 요금 구조

### (A) 자체 웹서비스 — 구독 + 분석 쿼터

정액만 받으면 헤비 유저가 원가를 먹고, 종량만 받으면 매출이 예측 불가다. **정액 + 포함 쿼터 + 초과 종량**.

| 플랜 | 월 정액 | 포함 분석량 | 초과 분당 | 좌석 |
|---|---|---|---|---|
| Free | ₩0 | 30분 | 불가(차단) | 1 |
| Starter | (미정) | 600분 | (미정) | 3 |
| Pro | (미정) | 3,000분 | (미정) | 10 |
| Enterprise | 개별계약 | 개별 | 개별 | 무제한 |

> 금액 칸이 비어 있는 건 의도적이다. 가격은 원가(분당 ₩4.9)와 목표 마진의 함수인데
> **마진 배수는 사업 판단**이라 여기서 정하지 않는다. 구조만 고정한다.
> 참고: 배수 10x 면 분당 ₩49, 600분 포함 = 원가 ₩2,940.

포함 쿼터는 **매 결제주기에 리셋**하고 이월하지 않는다(이월은 원장 복잡도만 올리고
방송사 쪽 계절성엔 어차피 못 맞춘다).

### (B) 외부 API — 분 단위 종량

**과금 단위 = 분석에 투입된 영상 길이(초)를 올림하여 분.** 이유:

- 원가가 영상 길이에 거의 선형이다(실측). 정산 근거가 명확하고 우리가 리스크를 안 떠안는다.
- "회차당" 은 30분 회차와 90분 회차가 같은 값이 되어 우리가 편차를 떠안는다.
- 쇼츠 "개수당" 은 사용자가 개수를 못 정하므로(추천은 우리가 만듦) 예측 불가 → 분쟁 소지.

```
청구 분 = ceil(media.duration_sec / 60)
```

**같은 미디어를 재분석하면?** 재시도(우리 귀책 실패)는 **무료**, 사용자가 파라미터를 바꿔
의도적으로 재분석하면 **재과금**. 구분 기준은 job 의 실패 원인 — `job_queue` 의
attempt/에러가 우리 쪽 오류면 usage 이벤트를 기록하지 않는다.

**최소 커밋.** 방송사 계약은 월 최소 사용료(commit)를 두고, 실사용이 미달해도
commit 만큼 청구한다. 인프라(GPU VM·Cloud SQL)가 고정비라 이게 없으면 저사용 달에 역마진이다.

**단가 구간(volume tier).** 월 누적 분에 따라 단가를 낮춘다 — 구간별 소급 아님, **한계 구간 적용**:
`0–1,000분 = 단가1 · 1,000–10,000분 = 단가2 · 10,000분+ = 단가3`.

---

## 2. 데이터 모델 (신규 테이블)

기존 관례를 따른다: 이 리포는 스키마 일부를 코드가 런타임 생성한다(`queue.ts`·`db-pg.ts`).
과금은 **정산 근거**라 런타임 암묵 생성이 아니라 **`schema.sql` 에 명시**할 것을 권한다.

```sql
-- 테넌트 = 과금 주체 (방송사 하나 / 우리 웹 고객사 하나). 사내 AENA 도 테넌트로 둔다(단가 0).
CREATE TABLE tenants (
  id            text PRIMARY KEY,          -- t_xxx
  name          text NOT NULL,
  kind          text NOT NULL,             -- 'web' | 'api' | 'internal'
  status        text NOT NULL DEFAULT 'active',   -- active | suspended | closed
  billing_email text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 기존 엔티티(programs/media 등)에 tenant_id 를 붙여야 격리가 성립한다. §6 참조.

CREATE TABLE plans (
  id             text PRIMARY KEY,         -- 'free' | 'starter' | 'pro' | 'ent_kbs'
  display_name   text NOT NULL,
  monthly_krw    integer NOT NULL DEFAULT 0,
  included_min   integer NOT NULL DEFAULT 0,
  overage_krw_per_min integer,             -- NULL = 초과 시 차단
  seats          integer,
  meta           jsonb NOT NULL DEFAULT '{}'   -- volume tier, commit 등
);

CREATE TABLE subscriptions (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  plan_id       text NOT NULL REFERENCES plans(id),
  status        text NOT NULL,             -- trialing|active|past_due|canceled
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  billing_key   text,                      -- 포트원 빌링키 (§4)
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 사용량 원장. append-only. 절대 UPDATE/DELETE 하지 않는다.
CREATE TABLE usage_events (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  kind         text NOT NULL,              -- 'analyze_minutes' | 'clip_render' | 'publish'
  quantity     numeric NOT NULL,           -- 분석은 분
  media_id     text,
  job_id       text,
  cost_krw     numeric,                    -- 우리 원가(실측). 마진 감시용
  source       text NOT NULL,              -- 'web' | 'api'
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  dedupe_key   text UNIQUE                 -- 'analyze:{mediaId}:{attempt}' — 중복 과금 방지
);
CREATE INDEX ON usage_events (tenant_id, occurred_at);

CREATE TABLE invoices (
  id           text PRIMARY KEY,           -- inv_xxx
  tenant_id    text NOT NULL REFERENCES tenants(id),
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  subtotal_krw integer NOT NULL,
  vat_krw      integer NOT NULL,
  total_krw    integer NOT NULL,
  status       text NOT NULL,              -- draft|open|paid|failed|void
  lines        jsonb NOT NULL,             -- [{desc, qty, unit_krw, amount_krw}]
  payment_id   text,                       -- 포트원 paymentId
  issued_at    timestamptz, paid_at timestamptz
);

CREATE TABLE api_keys (
  id          text PRIMARY KEY,            -- ak_xxx (prefix 노출용)
  tenant_id   text NOT NULL REFERENCES tenants(id),
  name        text,
  key_hash    text NOT NULL,               -- sha256(raw). 평문은 발급 순간에만 1회 노출
  prefix      text NOT NULL,               -- 'stepd_live_ab12' — UI 식별용
  scopes      text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**`usage_events.dedupe_key` 가 이 설계의 핵심 안전장치다.** 워커 재시도·중복 큐잉이
있는 시스템이라(`job_queue` 는 dedupeKey·지수 백오프로 재시도한다) 과금 기록도
멱등이 아니면 **한 번 분석하고 세 번 청구**하는 사고가 난다.

---

## 3. 인증 — 소비자 3종

factory API 의 소비자가 늘어나면서 인증이 갈라진다:

| 소비자 | 인증 | 과금 |
|---|---|---|
| 웹 프론트(stepd.stepai.kr) | `/api/proxy` 경유 ID 토큰 (기존) | 로그인 사용자 → tenant → 구독 |
| 사내 AENA | Cloud Run 서비스 간 ID 토큰 (기존) | `kind='internal'` 테넌트, 단가 0 |
| **사외 방송사 (신규)** | `Authorization: Bearer stepd_live_…` | api_keys → tenant → 종량 |

미들웨어 하나(`requireTenant`)로 셋을 통일해 `c.set('tenant', …)` 를 채우고, 이후
모든 과금 대상 라우트는 tenant 를 전제로 동작한다.

**키 형식:** `stepd_live_<32자 랜덤>` / 테스트는 `stepd_test_…`.
DB 에는 sha256 해시만 저장. 평문은 발급 응답에서 1회만 보여준다.

**레이트리밋:** 테넌트당 시간당 ingest N건 — factory-api-plan 의 "사고 방지" 목적과 동일하되,
사외 테넌트는 **남용 방지** 목적이 추가된다. `job_queue` 앞단에서 카운트.

---

## 4. 포트원 연동 — API 실조사 (2026-08-10, 공식 문서 확인)

**V2 로 간다.** V1 은 레거시이고 신규 연동 문서가 V2 중심이다.

### 4-0. 인증 — 토큰 발급 하지 말 것

V2 인증에는 두 경로가 있는데, **우리는 API Secret 직접 헤더 방식을 쓴다.**

```
방식 A (권장) — API Secret 을 헤더에 직접
  Authorization: PortOne {V2_API_SECRET}
  → 토큰 만료·리프레시 관리가 통째로 사라진다. Cloud Run 다중 인스턴스에서
    액세스토큰을 공유·갱신하는 문제 자체가 없어진다.

방식 B — 토큰 교환
  POST /login/api-secret  { "apiSecret": "..." }  → accessToken + refreshToken
  POST /token/refresh
  Authorization: Bearer {accessToken}
```

> ⚠️ **콘솔 채널 설정에 넣는 PG사 시크릿(토스·KG이니시스 등)은 API 인증에 못 쓴다.**
> 넣으면 401. 인증용은 관리자콘솔 **결제연동 탭의 V2 API Secret** 하나뿐이다.
> 이 둘을 혼동하는 게 연동 초기 최빈 실패다.

### 4-1. SDK — `@portone/server-sdk`

```bash
npm i @portone/server-sdk    # apps/server
```

```ts
import { PortOneClient, PaymentClient, Webhook } from "@portone/server-sdk";
const client = PaymentClient({ secret: process.env.PORTONE_API_SECRET! });
await client.getPayment({ paymentId });
```

- **Node ≥ 20 필요** (Web Crypto + fetch). 이 리포는 Node ≥ 22 이므로 충족.
- 웹훅 서명 검증(`Webhook.verify`)이 SDK 에 들어 있다 — 직접 구현하지 말 것.

### 4-2. 정기결제 (웹서비스 구독) — 빌링키

```
[브라우저] 포트원 브라우저 SDK  requestIssueBillingKey()   ← 카드정보는 여기서만 다뤄진다
        ↓ billingKey (카드번호는 우리 DB·서버에 절대 안 들어온다)
[서버]  POST /api/billing/billing-key  { billingKey }
        → subscriptions.billing_key 저장
        ↓ 매 결제주기
[결제]  POST /payments/{paymentId}/billing-key
        body: { storeId, billingKey, channelKey, orderName, amount, currency, customer }
```

**`paymentId` 는 우리가 만든다** — 포트원이 발급하는 게 아니라 **가맹점 지정 고유값**이다.
이게 곧 멱등키다. `pay_{tenantId}_{YYYYMM}` 처럼 결제주기당 유일하게 만들면
워커가 같은 달에 두 번 돌아도 중복 결제가 안 난다. `invoices.payment_id` 에 이 값을 넣는다.

**결제 실행 주체 — 두 선택지.**

| | 우리 워커 잡 (`billing.charge`) | 포트원 예약결제 (`POST /payments/{id}/schedule`) |
|---|---|---|
| 제어 | 리트라이·유예·플랜변경 전부 우리 로직 | 포트원이 `timeToPay` 에 자동 실행 |
| 상태 | 우리 DB 가 진실 | `SCHEDULED→STARTED→SUCCEEDED/FAILED/REVOKED` 조회·취소 API |
| 실패 재시도 | 우리가 3·5·7일 스케줄 | 직접 재예약 필요 |
| 리스크 | 워커가 안 깨면 청구 누락 | 플랜 변경·해지 시 예약 취소를 빼먹으면 **잘못 청구** |

**권장: 우리 워커 잡.** 이 리포는 이미 `job_queue`(dedupeKey·지수 백오프·하트비트)를
갖고 있어 재시도 인프라가 중복이고, 무엇보다 사용량 기반 초과분은 **금액이 주기 말에야
확정**되므로 미리 예약해둘 금액이 없다. 예약 API 는 정액만 있는 플랜에나 맞는다.

- **레인:** `content` 레인 금지(58분 분석 잡 뒤에 줄서면 청구가 늦는다).
  짧고 API 위주이므로 `billing` 레인을 새로 파거나 `youtube` 레인에 합류.
- **drain 모드 주의:** `worker.ts` `loop()` 의 `keepAlive` 앵커를 unref 하지 말 것(CLAUDE.md).

### 4-3. ⚠️ 빌링키의 규정 제약 — 외부 API 종량과 충돌

포트원 문서가 명시한다: **빌링키 결제는 "정기적 구독" 시나리오로 제한된다.**
카드사가 빌링키를 비정기·불규칙 청구에 쓰는 것을 제한하기 때문이다.

이게 §1(B) 외부 API 종량 과금에 직접 걸린다. **매달 금액이 달라지는 사용량 청구를
빌링키로 긁는 것이 "정기결제"로 인정되는 범위인지 계약 전에 포트원에 확인해야 한다.**
안전한 설계는:

- 외부 API = **월 최소 커밋(정액)을 빌링키 정기결제**로 + **초과분은 별도 청구**
  (세금계산서·계좌이체 또는 결제창 1회성 링크)
- 이러면 §1 의 "최소 커밋" 이 매출 안정화 장치이면서 동시에 **결제수단 정합성 장치**가 된다.

### 4-4. 인보이스 납부 경로 3종

방송사 B2B 는 카드 등록을 거부하고 **세금계산서 + 계좌이체**를 원하는 경우가 실제로 많다.
`invoices` 는 청구서일 뿐이고 납부 경로는 셋 다 허용한다:

(a) 포트원 빌링키 자동결제 (b) 포트원 결제창 링크 1회 결제 (c) 오프라인 이체 후 수동 `paid` 처리.
**(c) 를 빼면 엔터프라이즈 계약을 못 받는다.**

### 4-5. 웹훅 — Standard Webhooks 규격

`POST /api/billing/portone/webhook`

- **수신 이벤트**
  - 결제: `Transaction.Ready` · `Paid` · `Failed` · `Cancelled` · `PartialCancelled` ·
    `VirtualAccountIssued` · `PayPending` · `CancelPending` · `DisputeCreated` · `DisputeResolved`
  - 빌링키: `BillingKey.Ready` · `Issued` · `Failed` · `Deleted` · `Updated`
  - 우리가 실제로 처리할 것: `Transaction.Paid` / `Failed` / `Cancelled`,
    `BillingKey.Deleted`(카드 삭제 → 다음 청구 불가 경고), `BillingKey.Updated`.
- **서명 검증:** Standard Webhooks 기반. `Webhook.verify(secret, rawBody, headers)`.
  **rawBody 를 JSON 파싱하기 전 문자열 그대로** 넘겨야 한다 — Hono 에서 `c.req.json()`
  먼저 부르면 서명이 깨진다. `await c.req.text()` 로 받고 검증 후 파싱할 것.
- **시크릿 2개 동시 보유 가능** → 무중단 로테이션.
- **재전송:** 실패 시 최대 5회, 지수 백오프(0→1→4→16→64→256분) + jitter.
  → **같은 이벤트가 반복 도착하는 게 정상.** `payment_id` 기준 멱등 처리 필수.
- **응답:** 30초 내 HTTP 200. 무거운 후처리(인보이스 갱신 등)는 잡으로 넘기고 즉시 200.
- **웹훅을 신뢰의 원천으로 삼지 않는다.** 통지를 받으면 `GET /payments/{paymentId}` 로
  실제 상태를 되물어 확인한 뒤 DB 를 갱신한다.
- `timestamp` 는 RFC 3339 이며 **재전송 시에도 동일**하다 — 최초 발생 시각 판별에 쓸 것.

### 4-6. 쓰게 될 엔드포인트 목록

```
POST   /login/api-secret                       (방식 B 쓸 때만 — 권장 안 함)
POST   /billing-keys                           빌링키 발급(서버측)
GET    /billing-keys/{billingKey}              상태 조회
DELETE /billing-keys/{billingKey}              해지 시 삭제
POST   /payments/{paymentId}/billing-key       ★ 정기결제 실행
GET    /payments/{paymentId}                   ★ 웹훅 후 검증 조회
POST   /payments/{paymentId}/cancel            환불·취소
POST   /payments/{paymentId}/schedule          예약결제 (미채택, 4-2 참조)
DELETE /payment-schedules                      예약 취소 (예약 채택 시 필수)
```

### 4-7. 환경변수 (신규)

```
PORTONE_API_SECRET      V2 API Secret — 관리자콘솔 "결제연동" 탭 (Secret Manager)
                        ※ 채널 설정의 PG사 시크릿과 다른 값. 혼동 시 401
PORTONE_STORE_ID        상점 ID (store-xxxx)
PORTONE_CHANNEL_KEY     결제채널 키 (PG사별)
PORTONE_WEBHOOK_SECRET  웹훅 서명 검증 (Secret Manager · 로테이션 위해 2개 허용)
BILLING_ENABLED         실결제 게이트 — 미설정·오타·빈값 = OFF
```

> **`BILLING_ENABLED` 는 `upload-gate.ts` 와 같은 방향으로 설계한다.**
> 잘못된 env 의 실패 모드가 "결제 안 됨"이지 "실수로 카드가 긁힘"이 아니어야 한다.
> 이 리포는 이미 그 패턴(`YOUTUBE_UPLOAD_ENABLED` 3중 방어)을 갖고 있으므로 그대로 복제한다.
> 테스트는 `stepd_test_` 계열 채널/시크릿으로 분리한다.

> **`BILLING_ENABLED` 는 `upload-gate.ts` 와 같은 방향으로 설계한다.**
> 잘못된 env 의 실패 모드가 "결제 안 됨"이지 "실수로 카드가 긁힘"이 아니어야 한다.
> 이 리포는 이미 그 패턴(`YOUTUBE_UPLOAD_ENABLED` 3중 방어)을 갖고 있으므로 그대로 복제한다.

---

## 5. 미터링 — 어디서 usage 를 기록하나

**생산→저장→소비 3단을 다 배선해야 한다** (이 리포의 최빈 실패모드가 "출력이 소비처에 미도달").

```
생산  content-pipeline.ts — 분석 성공 확정 시점에 usage_events INSERT
       (실패·재시도 attempt 는 기록 안 함 / dedupe_key = 'analyze:{mediaId}:{runId}')
       cost_krw 는 실측 원가 추정치를 같이 적어 마진을 감시한다
저장  usage_events (append-only)
소비  ① 쿼터 체크 — POST /api/media/:id/analyze 가 큐잉 전에 잔여 쿼터 확인, 초과 시 402
      ② 인보이스 — 월 1회 billing.invoice 잡이 tenant×기간 집계 → invoices.lines
      ③ 대시보드 — GET /api/billing/usage (웹) · GET /api/usage (외부 API)
```

**쿼터 체크는 큐잉 전에 한다.** 분석이 끝난 뒤 "쿼터 초과였습니다" 하면 원가는 이미 나갔다.

---

## 6. 선결 조건 — 테넌트 격리 ✅ 1차 구현 완료 (2026-08-10)

> 아래 "필요하다"는 서술은 그대로 두되, **무엇이 실제로 들어갔는지**를 먼저 적는다.
>
> | 구성 | 위치 | 상태 |
> |---|---|---|
> | `tenants` 테이블 + 23개 테이블 `tenant_id` 백필 | `migrations/0013_tenants.cjs` | 적용됨(로컬) |
> | RLS 정책 + `FORCE ROW LEVEL SECURITY` | `migrations/0014_tenant_rls.cjs` | 적용됨(로컬) |
> | 요청·잡 스코프 컨텍스트 (AsyncLocalStorage) | `src/tenant.ts` | 완료 |
> | 풀 프록시 — 커넥션마다 `app.tenant_id` 주입 | `src/db-pg.ts` | 완료 |
> | 요청 미들웨어 | `src/index.ts` (`resolveTenant`) | 완료 |
> | 워커 잡 스코프 (`job.tenantId` → 핸들러) | `src/worker.ts` · `src/queue.ts` | 완료 |
> | 불변식 테스트 | `src/tenant.test.ts` (86 tests pass) | 완료 |
>
> **실측 검증** — NOBYPASSRLS 역할로 두 테넌트를 넣고 확인:
> t_a 스코프에서 t_b 행 안 보임 · 스코프 미설정 시 0행 · 교차 INSERT 42501 거부 ·
> 교차 UPDATE 0행 · `'*'`(시스템) 스코프에서만 둘 다 보임.
>
> **아직 남은 것**
> - **Cloud SQL 접속 역할이 BYPASSRLS/SUPERUSER 면 RLS 가 무력화된다.** `db-pg.ts` 가
>   기동 시 점검해 로컬 외에서는 **기동을 거부**한다(`ALLOW_RLS_BYPASS=1` 로만 우회).
>   프로덕션 배포 전에 격리 전용 역할을 만들어야 한다.
> - ~~웹에 로그인이 없다~~ → **백엔드 완료 (2026-08-10)**: 이메일+비밀번호·초대제.
>   `migrations/0017_auth.cjs`(users·sessions·invites) · `src/auth.ts` · `/api/auth/*` 6개 라우트 ·
>   `pnpm user:create`(첫 계정 부트스트랩) · `src/auth.test.ts`.
>   비밀번호는 scrypt(node:crypto 내장 — 네이티브 의존성 없음), 세션·초대 토큰은 sha256 만 저장.
>   **로그인 화면은 apps/web 개편 후**에 붙인다.
>   인증 강제는 `AUTH_REQUIRED` 로 켠다(기본 OFF — 화면이 없어서). 테넌트가 둘 이상인데 OFF 면
>   기동 시 감지해 **모든 요청을 503** 으로 막는다(사람이 기억하는 데 기대지 않는다).
>   `Bearer stepd_*`(외부 API 키)는 여전히 **501** — 키 테이블이 아직 없다(7단계 4번).
> - `scripts/backfill_segment_embeddings.py` 등 **파이썬이 DB 에 직접 붙는 스크립트**는
>   `app.tenant_id` 를 안 심어서 이제 0행을 보거나 INSERT 가 막힌다. 쓰기 전에 세팅 필요.
>
> 아래는 원래의 설계 근거 — 왜 이걸 결제보다 먼저 했는지.



지금 데이터 모델에 **테넌트 개념이 없다.** `entities` JSONB + media/youtube 정규 테이블
어디에도 소유자 구분이 없다. 결제를 붙이기 전에 이게 먼저다 — 안 하면 방송사 A 가
방송사 B 의 회차를 본다.

1. `tenants` 테이블 + 기존 데이터 전부를 기본 테넌트 하나에 귀속시키는 마이그레이션
2. `entities`·`media`·`youtube_channels`·`search_segments` 에 `tenant_id` 컬럼 + 인덱스
3. `db-pg.ts` 의 모든 조회에 tenant 스코프 강제 (기본값이 "전체"면 언젠가 샌다 — 필수 인자로)
4. `/api/state`·`/api/search` 등 118개 라우트의 스코프 점검

**규모가 결제 자체보다 크다.** 순서를 지키지 않으면 격리 없는 채로 외부 방송사를 받게 된다.

---

## 7. 구현 순서

| # | 단계 | 산출물 | 비고 |
|---|---|---|---|
| 1 | ~~**테넌트 격리**~~ (§6) | 0013·0014 + tenant.ts + 풀 프록시 + 미들웨어 | ✅ 2026-08-10 · 남은 건 격리 전용 DB 역할 |
| 2 | 원장 스키마 | plans·subscriptions·usage_events·invoices·api_keys | `schema.sql` 명시 |
| 3 | 미터링 배선 | content-pipeline INSERT + 쿼터 게이트(402) | 결제 없이도 단독 가치(원가 가시화) |
| 4 | API 키 + 인증 미들웨어 | `requireTenant` · 키 발급/회수 라우트 · 레이트리밋 | 외부 API 상품화의 최소치 |
| 5 | 포트원 빌링키 정기결제 | billing-key 라우트 · `billing.charge` 잡 · 웹훅 | `BILLING_ENABLED` 게이트 |
| 6 | 인보이스 생성·발송 | `billing.invoice` 월간 잡 · 오프라인 납부 경로 | 엔터프라이즈 대응 |
| 7 | 청구 화면 | 사용량·인보이스·카드 관리 | **프론트 개편 완료 후** |

> 7번이 마지막인 건 apps/web 이 현재 전면 개편 중이라서다. 1~6 은 백엔드만으로 진행 가능하다.

**비용:** 1~6 은 코드 작업이라 AI 파이프라인 지출 ₩0. 검증용 재분석이 필요하면
회차당 약 ₩285(58.6분 기준) · 약 16분이 추가로 든다.

---

## 8. 미결 (사용자 결정 필요)

- [ ] **가격 수치** — 분당 단가·플랜 정액·최소 커밋. 원가 ₩4.9/분에 마진 배수를 얼마로?
- [ ] **부가세·세금계산서** — 포트원이 영수증은 주지만 세금계산서 발행은 별개다.
      국내 방송사 B2B 는 계산서가 사실상 필수 — 외부 서비스 연동할지 수동 발행할지.
- [ ] **Free 플랜 존재 여부** — 영업 전 단계라 체험이 필요하지만, 분석 1회 원가가
      ₩285 라 무제한 무료는 위험. 30분/월 제안.
- [ ] **환불·해지 정책** — 월 중 해지 시 일할 환불? (미환불 + 기간말 종료를 권함)
- [ ] **포트원에 확인할 것 (계약 전)** — ① 사용량 기반 변동금액 청구를 빌링키 정기결제로
      집행하는 것이 허용 범위인지(§4-3) ② PG사 선정(토스페이먼츠/KG이니시스 등)과 수수료율
      ③ 해외 방송사 대응 필요 시 PayPal 등 해외 채널 ④ 세금계산서 연동 옵션 유무
- [ ] **사내 AENA 처리** — `kind='internal'` 단가 0 으로 두되 usage 는 기록해
      내부 원가는 보이게 할지.

---

## 관련

- [factory-api-plan.md](factory-api-plan.md) — 외부 API 표면. 이 문서가 그 "과금 보류" 항목을 연다
- [../reference/data-model.md](../reference/data-model.md) — 현재 스키마
- [../ops/infra.md](../ops/infra.md) — 시크릿 저장 위치(Secret Manager)
- `apps/server/src/upload-gate.ts` — `BILLING_ENABLED` 가 복제할 게이트 패턴

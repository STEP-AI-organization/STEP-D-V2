# 고객사 API — 영상분석 파생컨텐츠 + 자동배포 공장

붙이는 쪽(고객사 서버 — 예: ENA 의 aena 백엔드)이 읽는 문서다.
영상을 넣으면 AI 분석 → 쇼츠 추천 → 클립 → YouTube 배포까지 API 로 완주하고,
결과(추천·클립·자막·검색·성과)를 가져간다. 과금은 워크스페이스 선불 크레딧이다.

베이스: **`https://stepd.stepai.kr/api/proxy/api`** (프로덕션)

> ⚠️ **`https://stepd.stepai.kr/api` 는 안 된다** — Vercel 404 HTML 이 돌아온다(2026-08-20 실측).
> `apps/web/next.config.ts` 에 `/api/:path*` → `/api/proxy/api/:path*` rewrite 가 있지만
> 배포된 웹에는 걸려 있지 않다. 프록시 경로를 **명시적으로** 쓸 것.
> 이 주소를 잘못 안내하면 고객사는 404 만 받고 "키가 틀렸나" 를 의심하게 된다.

> 구 문서 `factory-api.md`(x-factory-key 방식)는 폐기됐다. 인증이 워크스페이스
> API 키(Bearer)로 바뀌었고, 모든 데이터는 그 워크스페이스에 귀속된다.

---

## 인증 — 워크스페이스 API 키

모든 요청에 헤더 하나:

```
Authorization: Bearer stepd_live_...
```

- 키는 STEPAI 운영자가 발급해 보안 채널로 전달한다. **분실 시 재발급 — 평문은 다시 조회할 수 없다.**
- 키는 **서버에만** 둔다. 브라우저에 내리면 유출이고, 유출되면 남이 당신 채널에 영상을 올릴 수 있다.
- 키에는 스코프가 붙는다. 표준 고객사 키 = `media:write · media:read · search:read · factory:write · factory:read · billing:read`.
- 401 = 키가 틀렸거나 폐기됨 · 403 = 그 경로 권한이 없거나 API 에 없는 경로 · 402 = 크레딧 부족.

**모든 호출은 키가 속한 워크스페이스 안에서 실행된다.** 넣은 영상·프로그램·연결한
채널·클립·배포 기록은 전부 그 워크스페이스에 저장되고, 웹(stepd.stepai.kr) 에
로그인하면 같은 데이터를 화면에서 보고 이어서 작업할 수 있다.

## 과금 — 선불 크레딧

- **1 크레딧 = 분석 1분.** 61분 영상 분석 = 62크레딧(올림).
- 충전·카드 관리는 웹 화면에서 한다 (API 로는 조회만).
- 잔액이 부족하면 등록/분석이 `402 insufficient_credits` 로 거절된다 → 충전 후 재시도.
- `GET /api/credits` → `{ balance, ledger[] }` (최근 사용·충전 내역 50건).

---

## 라우트 전표 (키로 부를 수 있는 전부)

| 메서드·경로 | 스코프 | 설명 |
|---|---|---|
| POST `/api/media/upload-init` → `/finalize` | media:write | 브라우저/서버 → GCS resumable 직접 업로드 |
| POST `/api/media/:id/analyze` | media:write | 분석 시작 (402 게이트) |
| POST `/api/factory/videos` | factory:write | YouTube URL 로 영상 등록 |
| POST `/api/factory/ingest` | factory:write | 공장 진입 — 분석→쇼츠→클립→배포 완주 |
| POST `/api/factory/channels` · `/channels/connect-url` | factory:write | 배포 채널 연결 |
| GET `/api/factory/targets` | factory:read | 배포 가능한 채널 목록 |
| GET `/api/factory/jobs` | factory:read | 실행 **목록** — `?state=active\|terminal\|all&limit=` · 프로그램명·회차명·채널명까지 풀어서 준다 |
| GET `/api/factory/jobs/:id` (`/performance`) | factory:read | 공장 폴링 · 성과 |
| GET `/api/media/:id/analysis` | media:read | 분석 결과 전체 (자막·장면·쇼츠 원본) |
| GET `/api/media/:id/shorts` | media:read | 쇼츠 추천 목록 (점수순) |
| GET `/api/media/:id/clips` | media:read | 클립 목록 + 배포 상태 |
| GET `/api/media/:id/transcript` | media:read | 자막 |
| GET `/api/media/:id/stream-url` | media:read | 원본 재생 URL |
| GET `/api/media/:id/thumb` · `/frame` · `/analysis/frames/:name` · `/thumbnails` | media:read | 이미지 에셋 |
| GET `/api/search` | search:read | 회차 내 하이브리드 검색 (벡터+키워드) |
| GET `/api/credits` | billing:read | 잔액·사용 내역 |

여기 없는 경로는 전부 키로 못 부른다 (403). 이미지 에셋을 고객사 웹 화면에 보여줄
때는 **고객사 서버가 프록시**한다 — 키를 브라우저에 내리지 않기 위해서다.

---

## 공장 (Factory) — 소스 하나로 완주

연동 순서·요청/응답 형식·status 값·에러표는 기존과 같다:

0. `POST /api/factory/channels/connect-url` 로 채널 연결 (게시 모드)
1. `GET /api/factory/targets` 로 배포 가능한 채널 확인
2. `POST /api/factory/videos` `{ url, programId, title }` → `mediaId`
3. `POST /api/factory/ingest` `{ sourceUrl, programId, targets, policy, idempotencyKey }` → 202 `{ jobId }`
   - `policy.dryRun: true` 로 첫 연동 검증 (클립까지 만들고 업로드 안 함)
   - `policy.publishPublic` 기본 false = private 업로드 후 유예(10분) 뒤 공개 전환
   - `idempotencyKey` 같으면 기존 jobId 반환 (재작업 없음)
4. `GET /api/factory/jobs/:id` 를 60초 주기 폴링
   - status: `queued → ingesting → analyzing(실측 16분) → adopting → rendering → publishing → publicizing → done` · `hold`(일일 상한) · `failed`
5. 산출물: `GET /api/media/:id/shorts` · `/clips` · `/analysis` · `/transcript`
6. 성과: `GET /api/factory/jobs/:id/performance` (업로드 직후 `hasMetrics:false` 는 정상)

### AENA 파일 원본 업로드

YouTube URL이 아니라 AENA가 가진 영상 파일은 아래 순서로 넣는다. API 서버 바디에는 영상
바이트를 보내지 않는다.

1. `POST /api/media/upload-init` → `{ mediaId, objectPath, sessionUrl }`
2. AENA 서버가 `sessionUrl`로 GCS resumable `PUT` — API 키는 GCS 요청에 보내지 않는다.
3. `POST /api/media/finalize` → `202 { media, episode, queued:true }`
4. 곧바로 `POST /api/factory/ingest`의 `sourceUrl`에 위 `media.id`를 넣는다.

`finalize` 뒤의 서울 스테이징→운영 버킷 이동·프로브·분석은 `media.prepare` 워커가 비동기로
처리한다. AENA는 이동 완료를 기다렸다가 ingest할 필요가 없다. 공장 잡이 `ingesting` 상태에서
원본 준비 완료를 기다린 뒤 분석·쇼츠·배포를 이어간다. 같은 파일 재시도에는 같은
`idempotencyKey`를 사용한다.

### 에러

| 코드 | 뜻 | 대응 |
|---|---|---|
| 401 | 키 불일치·폐기 | 키 확인 |
| 402 `insufficient_credits` | 크레딧 부족 | 웹에서 충전 후 재시도 |
| 403 | 경로 미개방 또는 스코프 부족 | 메시지가 둘을 구분해 준다 |
| 400 `invalid_target` | 채널 미연동·권한 없음 | `problems` 배열에 채널별 사유 |
| 404 `program_not_found` | | 프로그램 먼저 생성 (웹 화면) |
| 429 `rate_limited` | 시간당 ingest 상한 | 잠시 후 재시도 |
| 503 `factory_disabled` | 킬 스위치 OFF | 운영 문의 |

---

## 서버 쪽 환경변수 (운영자용)

| env | 기본 | 설명 |
|---|---|---|
| `AUTH_REQUIRED` | off | 다테넌트면 **반드시 1** (아니면 기동 시 503) |
| `CREDIT_PRICE_KRW` | — | 크레딧 단가. 미설정이면 충전 결제창이 안 열린다 |
| `FACTORY_ENABLED` | off | 공장 킬 스위치 |
| `FACTORY_DAILY_CAP` | 5 | 프로그램당 하루 자동 배포 상한 |
| `FACTORY_HOURLY_LIMIT` | 20 | 워크스페이스당 시간당 ingest 상한 |
| `FACTORY_PUBLICIZE_DELAY_MIN` | 10 | private → public 전환 유예(분) |
| `FACTORY_RETURN_ORIGINS` | — | 채널 연결 후 복귀 오리진 allowlist |

(구 `FACTORY_API_KEY` 는 제거됐다 — 남아 있어도 아무 효과 없다.)

---

## 신규 고객사(워크스페이스) 온보딩 런북 — 운영자용

전제: 프로덕션 env 에 `AUTH_REQUIRED=1` · `CREDIT_PRICE_KRW` · `FACTORY_ENABLED=1` · PortOne 키 4종.

1. **회사 개설** — admin 콘솔(admin.stepd.stepai.kr) 또는 `POST /api/superadmin/tenants`:
   이름·owner 이메일·초기 테스트 크레딧 grant. 임시 비밀번호 전달.
2. **결제 수단** — owner 세션으로 웹 로그인 → 카드 등록(빌링키) → 크레딧 충전.
   결제 라우트는 세션 전용이라 API 키로는 못 한다 (의도).
3. **프로그램·채널 준비** — 그 워크스페이스 안에서 프로그램 생성(캐스트 등록 포함)
   + YouTube 채널 연결(게시 모드). 키 전달 전에 완료 — 공장이 `programId` 와 연결
   채널을 요구한다.
4. **키 발급** — admin 콘솔에서 스코프 6종 체크 후 발급 → 평문 키 1회 노출 →
   보안 채널로 고객사 서버 env 에 전달.
5. **스모크** — `policy.dryRun=true` ingest 1건 완주 확인 후 개시.

주의: 기존 t_default(사내) 워크스페이스의 채널·프로그램은 신규 회사와 무관하다 —
그 회사 것은 그 워크스페이스 안에 새로 만든다.

관련: [api-reference.md](api-reference.md) · [../plans/active/factory-api-plan.md](../plans/active/factory-api-plan.md)

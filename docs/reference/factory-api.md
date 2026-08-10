# Factory API — 외부 연동 문서

소스 영상 하나를 넣으면 분석·쇼츠·클립·YouTube 배포까지 자동으로 완주시키는 API.
붙이는 쪽(AENA 등 외부 서버)이 읽는 문서다.

베이스: `https://stepd.stepai.kr/api` (프로덕션)

---

## 인증

모든 Factory 라우트에 헤더가 필요하다.

```
x-factory-key: <발급받은 키>
```

- 키 미설정 서버 → `503 factory_key_unset` (열림이 아니라 **닫힘**)
- 키 불일치 → `401 unauthorized`

> ⚠️ Cloud Run 이 allow-unauthenticated 라 IAM 이 막아주지 않는다. 이 키가 유일한 방어선이고,
> 유출되면 **남이 우리 YouTube 채널에 영상을 올릴 수 있다.** Secret Manager 로만 관리할 것.

---

## 1) 배포 가능한 채널 조회

```http
GET /api/factory/targets
x-factory-key: ...
```

```json
{
  "targets": [
    { "target": "youtube:UCxxx", "channelId": "UCxxx", "name": "채널A",
      "canPublish": true,  "reason": null },
    { "target": "youtube:UCyyy", "channelId": "UCyyy", "name": "채널B",
      "canPublish": false, "reason": "업로드 권한 없음 (게시 모드로 재연결 필요)" }
  ]
}
```

`canPublish:false` 인 채널도 **이유와 함께** 내려준다. 목록에서 빼면 "왜 내 채널이
안 보이지"에서 막히기 때문이다. `targets` 에는 `canPublish:true` 인 것만 넣어야 한다.

---

## 1-2) 채널 연결 — 리프레시 토큰 확보

배포하려면 그 채널의 **refresh token** 이 우리 쪽에 있어야 한다. 두 경로가 있다.

### (권장) 연결 URL 발급 → 채널 주인이 동의

```http
POST /api/factory/channels/connect-url
x-factory-key: ...
{ "returnUrl": "https://aena.example/channels/connected" }
```
```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

이 URL 을 채널 주인에게 열어주면 → 동의 → 우리가 refresh token 을 저장 → `returnUrl` 로
`?success=1&channelId=UC...&channelName=...` 를 붙여 돌려보낸다.

`returnUrl` 은 **`FACTORY_RETURN_ORIGINS` 에 등록된 오리진만** 허용한다(오픈 리다이렉트 방지).
미등록이면 `400 return_url_not_allowed`.

### (대안) refresh token 직접 등록

```http
POST /api/factory/channels
x-factory-key: ...
{ "refreshToken": "1//0g..." }
```

> ⚠️ **우리 `GOOGLE_CLIENT_ID` 로 발급된 토큰만 동작한다.** 다른 OAuth 클라이언트로 받은
> refresh token 은 우리 client_secret 으로 갱신할 수 없다. 그래서 저장 전에 실제로 한 번
> 갱신해 보고, 실패하면 `400 refresh_token_invalid` 로 거절한다. 업로드 스코프가 없으면
> `400 scope_insufficient`.

성공하면 바로 `targets` 에 쓸 수 있다:
```json
{ "ok": true, "target": "youtube:UCxxx", "channelId": "UCxxx", "name": "채널A" }
```

---

## 2) 인제스트 (진입)

```http
POST /api/factory/ingest
x-factory-key: ...
content-type: application/json
```

```json
{
  "sourceUrl": "https://www.youtube.com/watch?v=...",
  "programId": "p_xxx",
  "targets": ["youtube:UCxxx"],
  "policy": {
    "maxShorts": 3,
    "minConfidence": 0,
    "dryRun": false,
    "publishPublic": false
  },
  "idempotencyKey": "aena-2026-08-10-ep177"
}
```

응답 `202`:
```json
{ "jobId": "f_abc123", "status": "queued" }
```

### 필드

| 필드 | 필수 | 설명 |
|---|---|---|
| `sourceUrl` | ✅ | 이미 우리 쪽에 등록된 미디어여야 한다. 미등록이면 `from-youtube` 로 먼저 등록 |
| `programId` | ✅ | 대상 프로그램. 캐스트·장르·썸네일 스타일이 여기 붙어 있다 |
| `targets` | ✅ | `youtube:<channelId>` 배열. **지정한 채널로만 나간다** (추론·폴백 없음) |
| `policy.maxShorts` | | 기본 3 |
| `policy.minConfidence` | | 기본 0 |
| `policy.dryRun` | | `true` = 클립까지만 만들고 **업로드 안 함**. 첫 연동은 이걸로 검증할 것 |
| `policy.publishPublic` | | 기본 `false` = private 업로드 후 유예(기본 10분) 뒤 공개 전환 |
| `idempotencyKey` | | 같은 키로 다시 부르면 **기존 jobId 를 그대로 돌려준다** (재작업 없음) |

### 에러

| 코드 | 뜻 | 대응 |
|---|---|---|
| `401 unauthorized` | 키 불일치 | 키 확인 |
| `503 factory_key_unset` | 서버에 키 미설정 | 운영 문의 |
| `503 factory_disabled` | `FACTORY_ENABLED` off | 운영 문의 (킬 스위치) |
| `400 invalid_target` | 채널 미연동·권한없음·미지원 | `problems` 배열에 채널별 사유 |
| `400 bad_request` | 필수 필드 누락 | |
| `404 program_not_found` | | |
| `429 rate_limited` | 시간당 상한 초과 | 잠시 후 재시도 |

`invalid_target` 예시:
```json
{ "error": "invalid_target",
  "problems": [
    "youtube:UCxxx: 업로드 권한 없음 (분석 전용으로 연결됨 — 게시 모드로 재연결 필요)",
    "meta:page_1: YouTube 만 실송출합니다"
  ] }
```

---

## 3) 상태 조회 (폴링)

```http
GET /api/factory/jobs/f_abc123
x-factory-key: ...
```

```json
{
  "jobId": "f_abc123",
  "status": "publishing",
  "programId": "p_xxx",
  "mediaId": "m_xxx",
  "dryRun": false,
  "note": null,
  "error": null,
  "clips": [
    { "clipId": "c_1", "title": "…", "durationSec": 47.2, "rendered": true,
      "distributions": [{ "channel": "youtube", "status": "published", "externalId": "abc123" }] }
  ],
  "createdAt": 1786…, "updatedAt": 1786…
}
```

### status 값

| status | 뜻 |
|---|---|
| `queued` | 접수됨 |
| `ingesting` | 소스 다운로드 대기 |
| `analyzing` | AI 분석 중 (**실측 16분**) |
| `adopting` | 쇼츠 선별·채택 |
| `rendering` | 클립 렌더 |
| `publishing` | 업로드 잡 큐잉됨 |
| `publicizing` | private 업로드 완료 · 공개 전환 대기 |
| `done` | 완료 |
| `hold` | 일일 상한 도달 — 실패가 아니라 보류. `note` 참조 |
| `failed` | 실패. `error` 참조 |

폴링 주기는 **60초** 권장. 전체 소요는 60분 영상 기준 대략 25~35분(측정 후 확정).

웹훅은 아직 없다 — 폴링으로 시작한다.

---

## 연동 순서 (권장)

1. `GET /api/factory/targets` 로 배포 가능한 채널 확인
2. `policy.dryRun=true` 로 한 편 넣고 `clips` 가 렌더까지 되는지 확인 (**업로드 안 됨**)
3. 결과가 납득되면 `dryRun` 을 빼고 실제 배포
4. `publishPublic` 은 기본값(false) 유지 권장 — private 로 올라가고 유예 뒤 공개된다.
   그 사이가 잘못 나갔을 때 되돌릴 시간이다

---

## 서버 쪽 환경변수 (운영자용)

| env | 기본 | 설명 |
|---|---|---|
| `FACTORY_API_KEY` | — | **없으면 API 가 닫힌다** |
| `FACTORY_ENABLED` | off | 킬 스위치. truthy 일 때만 ingest 수락 |
| `FACTORY_DAILY_CAP` | 5 | 프로그램당 하루 자동 배포 상한 |
| `FACTORY_HOURLY_LIMIT` | 20 | 시간당 ingest 상한 |
| `FACTORY_PUBLICIZE_DELAY_MIN` | 10 | private → public 전환 유예(분) |
| `FACTORY_ALLOWED_ORIGIN` | — | 브라우저에서 직접 부를 때만 필요 (CORS) |
| `FACTORY_RETURN_ORIGINS` | — | 채널 연결 후 돌아갈 외부 오리진 allowlist (쉼표 구분) |
| `INTERNAL_API_BASE` | `PUBLIC_URL` | 워커가 렌더 라우트를 부를 주소 |

관련: [../plans/active/factory-api-plan.md](../plans/active/factory-api-plan.md)

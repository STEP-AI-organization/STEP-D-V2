# STEP-D 서버 개선안

**대상** `apps/server/src` — 48,753줄 · 라우트 284개 · 테스트 113파일
**방법** 정적 읽기만. 서버를 띄우거나 DB에 붙지 않았고, 코드는 한 줄도 수정하지 않았다.
**날짜** 2026-09-14

---

## 총평

먼저 분명히 해둘 것 — **이 코드베이스는 잘 짜여 있다.** 아래 지적들은 "못 만들었다"가 아니라 "여기까지 왔으니 다음 한 칸"에 해당한다.

특히 세 가지가 업계 평균보다 확연히 낫다.

1. **실패 방향이 전부 안전한 쪽으로 잡혀 있다.** 테넌트 스코프가 없으면 조용히 새는 게 아니라 500으로 터지고(`db-pg.ts` 풀 프록시), `AUTH_REQUIRED`가 꺼진 채 테넌트가 둘이면 아예 서빙을 거부한다(`index.ts:672` `assertAuthPosture`). 업로드 게이트는 오타·빈값이 전부 OFF다.
2. **소스 스캔 아키텍처 테스트.** `rls-access` · `worker-lanes` · `publish-guard` · `docs-drift` — 순수 함수로 증명 못 하는 불변식을 소스를 읽어서 고정한다. 이건 아주 드문 수준이다.
3. **주석에 사고 이력이 남아 있다.** "2026-08-12에 이래서 터졌다"가 규칙 옆에 붙어 있어서 아무도 규칙을 함부로 못 지운다.

그래서 개선안도 **이 리포의 관용구에 맞춰** 적었다. 새 프레임워크를 들이는 제안은 없다.

---

## A. 지금 당장 (1주 안)

### A-1. 🔴 `channel_videos.videoId` 인덱스가 지난주에 사라졌다

**이게 이번 분석에서 가장 값어치 있는 발견이다.**

`0056` → `0057` 2단계 마이그레이션(커밋 `cc0a946`, 2026-09-07)이 전역 `UNIQUE (videoid)`를 지우고 `uq_channel_videos_tenant_video (tenant_id, videoid)`로 대체했다. 두 워크스페이스가 같은 유튜브 채널을 봐도 안 막히게 하려는 것이고, **그 목적 자체는 옳다.**

문제는 `videoId` **단독**으로 묻는 코드가 그대로 남았다는 것이다.

```
db-pg.ts:1929  SELECT ... FROM channel_videos WHERE videoId = $1
db-pg.ts:1848  UPDATE channel_videos SET isShort = $2 ... WHERE videoId = $1
db-pg.ts:1936  DELETE FROM channel_videos WHERE videoId = $1
```

남은 인덱스는 `idx_channel_videos_channel(channelId)`와 `(tenant_id, videoid)` 뿐이다. **선두 컬럼이 `tenant_id`인 복합 인덱스는 이 쿼리에 안 걸린다.**

그리고 그 근거는 **이 리포가 이미 직접 써 놓았다.** `migrations/0048_entities-join-index.cjs` 주석:

> ⚠️ **tenant_id 는 넣지 않는다** — 처음엔 넣으려 했는데 실측이 반대였다(2026-09-01).
> RLS 술어가 `tenant_id = current_setting(...) OR current_setting(...) = '*'` 라 **OR** 이고,
> OR 는 선행 컬럼 등치로 안 쓰인다.

9월 1일에 실측으로 확인한 사실이 9월 7일 마이그레이션에는 반영되지 않았다.

**하필 그 쿼리가 최악의 자리에 있다.** `getChannelVideoByVideoId`는 YouTube sync 루프 안에서 돈다(`index.ts:12916`, `pipeline/channel-pipeline.ts:189`). `youtube.ts:239`가 업로드를 최대 500개 가져오므로 — **순차 스캔 500회.**

**수정: 마이그레이션 한 줄.**

```sql
CREATE INDEX IF NOT EXISTS idx_channel_videos_video ON channel_videos(videoid);
```

난이도 매우 낮음. A-2를 하기 전에 이것만 해도 즉효가 난다.

> ⚠️ 단 이건 `EXPLAIN` 실측이 아니라 **인덱스 선두 컬럼과 쿼리 술어의 대조 + 0048 주석의 실측 기록**에 근거한 판정이다. 프로덕션에서 `EXPLAIN (ANALYZE, BUFFERS)`로 한 번 확인하고 붙이는 게 맞다.

### A-2. 🔴 YouTube sync가 요청당 최대 2,000쿼리

`index.ts:12916` 루프가 영상 하나마다 DB를 3~4번 친다.

| 줄 | 호출 |
|---|---|
| 12916 | `getChannelVideoByVideoId` |
| 12931 | `upsertChannelVideo` |
| 12933 | `getLatestVideoStat` |
| 12935 | `insertVideoStat` (조건부) |

500개 × 4 = **2,000쿼리**. 그런데 `db-pg.ts:168-182`의 스코프 풀 프록시가 쿼리마다 `set_config`를 먼저 보내므로 **실제 왕복은 4,000회**고, 커넥션은 기본 5개(`PG_POOL_MAX`)다.

**같은 루프가 워커에도 있다** — `pipeline/channel-pipeline.ts:188-220`. 이쪽이 `channel.analyze`로 주기적으로 도니 총량은 더 크다.

**수정 방향** — 4단계 전부 `= ANY($1::text[])` 배치로:

1. 기존 행 프리페치 한 번 → Map
2. `INSERT ... ON CONFLICT (tenant_id, videoId) DO UPDATE` 다중 VALUES 한 번
3. `SELECT DISTINCT ON (videoId) ... ORDER BY videoId, snapshotAt DESC` 한 번
4. `insertVideoStat` 다중 VALUES 한 번

2,000 → **4쿼리.** 난이도 중(기존 함수는 두고 배치 버전을 추가한 뒤 두 호출부를 배선).

### A-3. 🔴 로그인에 시도 제한이 없다

```
서버 전체에서 429를 내는 곳: index.ts:12441 한 곳 (factory/ingest)
bodyLimit이 걸린 라우트: index.ts:6822 한 곳 (billing/card/issue)
loginAttempt · lockout · failedAttempts 코드: 0건
```

`POST /api/auth/login`(`index.ts:776`)은 **계정 열거 방어는 훌륭하다** — 계정이 없어도 더미 해시로 같은 시간을 쓴다(`index.ts:786-790`). 그런데 **무제한 크리덴셜 스터핑은 그대로 열려 있다.**

더 나쁜 건 `POST /api/auth/accept-invite`(`index.ts:1059`)다. 초대 토큰을 무제한 추측할 수 있는데, `index.ts:1070`이 내부 예외 메시지를 그대로 400 본문에 실어 준다 — **추측에 피드백까지 준다.**

**수정**: 로그인·초대수락·비밀번호변경에 IP+계정 단위 시도 카운터. `chatbot/agent.ts:227-233`에 이미 DB 카운트 기반 레이트리밋이 있으니 그 헬퍼를 재사용하면 된다.

### A-4. 🟠 비싼 LLM 라우트에만 제한이 없다 (챗봇에는 있다)

같은 모델, 같은 액터 헬퍼(`chatbotActor`)를 쓰는 쌍둥이 기능인데 한쪽만 막혀 있다.

| 라우트 | 위치 | 비용 | 제한 |
|---|---|---|---|
| `POST /api/chatbot/message` | `chatbot/agent.ts:227` | LLM 1회 | **분 10 / 일 200** |
| `POST /api/reports` | `index.ts:13544` | **LLM 2회** (spec + narrate) | 없음 |
| `POST /api/programs/:id/autofill/chat` | `index.ts:2797` | **파이썬 자식 프로세스 90초** | 없음 |
| `POST /api/clips/:id/generate-metadata` | `index.ts:9649` | Gemini | 없음 |

그리고 `auth/api-keys.ts:208` 주석이 autofill에 대해 직접 이렇게 적어 놨다:

> 무거운 호출이다 … 배치로 돌리면 서버가 앉는다

**그렇게 써 놓고 API 키에 열어두었는데 제한은 안 걸었다.** 설계 판단이 아니라 누락으로 보인다.

---

## B. 다음 (2~4주)

### B-1. 🟠 인덱스 두 줄 더 (A-1과 같은 마이그레이션에)

```sql
-- media.episodeId — harvest 판정(db-pg.ts:4795)이 매일 새벽 조인하는 축인데 인덱스가 없다
CREATE INDEX IF NOT EXISTS idx_media_episode ON media(episodeid);

-- usage_events / credit_topup — 어드민이 "전 회사 × 기간"으로 묻는데(index.ts:2155, 2159)
-- 기존 인덱스는 선두가 tenant_id라 안 걸린다. usage_events는 회차마다 쌓이고 지우는 코드가 없다
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_topup_paid_at ON credit_topup(created_at DESC) WHERE status='paid';
```

`job_queue`는 `pruneDoneJobs`(`queue.ts:394`)로 정리하는데 `usage_events`에는 대응물이 없다. 보존 정책도 같이 정하는 게 좋다.

### B-2. 🟠 `bodyLimit`이 284개 중 1개

```
c.req.json()      93곳
parseBody()        3곳
formData()         1곳
arrayBuffer()      1곳
→ 상한이 있는 곳: 2곳 (bodyLimit 1 + PREMIERE_BASE_MAX 1)
```

특히 멀티파트 4곳이 **크기 검사 없이 파일 전체를 RAM에 버퍼링**한다 — `index.ts:4698`, `4761`, `6749`, `12261`. CLAUDE.md가 "Cloud Run `/tmp`는 RAM이라 안 지우면 OOM"이라고 경고하는 그 자원을, 업로드 경로는 `/tmp`를 안 거치고도 직접 먹는다. `cast-photos`는 2026-09-14부터 API 키로도 열려 있다(`auth/api-keys.ts:203`).

지금 실질 상한은 Cloud Run이 우연히 주는 것뿐이라, 로컬·워커·향후 이관 시 사라진다.

**수정**: 전역 `app.use("/api/*", bodyLimit({ maxSize: ... }))` 하나 + 업로드 라우트만 크게. 난이도 낮음.

### B-3. 🟠 요청 본문 키가 `new RegExp()`로 들어간다

`index.ts:3975`:
```ts
const re = new RegExp(`(^|[^A-Za-z0-9_])${lbl}(?![A-Za-z0-9_])`, "g");
```

`lbl`은 `PATCH /api/media/:id/faces/mapping`의 본문 객체 키다. 값(`v`)은 `typeof v !== "string"`으로 거르는데(`index.ts:3946`) **키는 한 번도 검증되지 않는다.**

바로 윗줄 `index.ts:3974` 주석은 *"lbl은 항상 영숫자"*라고 적혀 있다 — **그걸 강제하는 코드가 없다.** `{"mapping": {"(a+)+$": "x"}}`면 재앙적 백트래킹, `{"(" : "x"}`면 `new RegExp`가 던져 500.

**완화 요인**: `index.ts:3953`의 `if (useGCS) return ...`이 먼저 반환하므로 **GCS가 설정된 프로덕션에서는 이 블록이 안 돈다.** 로컬·폴백 전용 잠복 함정이라 우선순위는 중간이다. 수정은 `if (!/^[A-Za-z0-9_]+$/.test(lbl)) continue` 한 줄.

### B-4. 🟠 OAuth 예외 마스킹이 5곳 중 1곳만

```
index.ts:11406  console.error("[instagram/oauth]", maskIgTokens(...))   ← 마스킹함
index.ts:11239  console.error("[meta/oauth]", err)                      ← 원본
index.ts:11575  console.error("[tiktok/oauth]", err)                    ← 원본
index.ts:12012  console.error("[canva/oauth/callback]", e)              ← 원본
index.ts:11106  console.error("[oauth/callback]", err)                  ← 원본 (YouTube)
```

`maskIgTokens`(`index.ts:11321`)가 존재한다는 건 **이 위험을 이미 알고 한 곳만 고쳤다**는 뜻이다. Meta 경로는 `client_secret`과 `access_token`을 쿼리스트링에 실어 호출하므로(`index.ts:11175-11204`) 네트워크 실패 시 그 에러 객체에 URL이 실릴 수 있다.

> 실제로 토큰이 찍히는지는 undici 에러 형태에 달려 있어 **확인 못 했다.** 마스킹 누락 자체는 확정.

**같이 볼 것**: `index.ts:471`의 `app.use("*", logger())`가 hono 구현상 **쿼리스트링을 통째로 찍는다**(`hono/middleware/logger/index.js:34` — `url.slice(url.indexOf("/", 8))`). OAuth `code` 5곳과 검색어 `q`가 Cloud Logging에 남는다. 이 제품의 검색축은 인물·화자라 **사람 이름이 쌓인다.** code는 1회용·단명이라 즉시 위험은 낮지만, **로그 열람 권한이 채널 연결 권한보다 넓다면 그 차이가 곧 취약점이다.**

### B-5. 🟠 `/api/state`가 304로 끝나도 전량을 읽는다

ETag/304 처리 자체는 잘 돼 있다(`index.ts:2366-2387`). API 키 호출에 304를 안 주는 판단도 근거가 정확하다.

문제는 **ETag를 본문을 다 만든 뒤에 계산한다**는 것이다(`index.ts:2367`). 즉 304로 끝나는 요청도 DB에서 전체를 읽고 JSON 직렬화까지 한다.

그 구간이 가볍지 않다. 리포 자신의 실측:
- `0048` 주석: `entities` **415행에 31MB** (행당 평균 75KB)
- `index.ts:2335` 주석: 응답 18.9MB 중 **17.3MB(92%)가 `editorState`**

현재 `editorState`는 **API 키 호출에서만** 뺀다(`index.ts:2406`). 세션 호출은 에디터가 그걸로 그리니까 — 이유 자체는 타당하다. 결과적으로 **웹 탭이 45초마다 수 MB를 읽고 직렬화하고 대부분 버린다.**

`programs`에 이미 쓴 수법이 `clips`에도 된다: `(data - 'editorState')`로 읽고 플래그만 남긴 뒤, 에디터 열 때 그 클립만 `getEntity`. `withImageFlags`(`db-pg.ts:2513`)가 선례다. 난이도 중(프론트 `store.tsx` 동시 수정).

부수적으로 `listEntities("clip")`·`listMedia()`에 상한이 없다. `job`에는 `STATE_JOB_LIMIT`을 걸어뒀고 그 주석이 *"11MB였고 Vercel 청구서를 태웠다"*고 적고 있다 — 같은 논리가 clip/media에는 아직 적용되지 않았다.

### B-6. 🟠 에러 코드 절반이 기계가 못 읽는 문장

`index.ts`의 `error: "..."` 리터럴 **481건 / 고유 232종** 집계:

| 구분 | 건수 |
|---|---|
| `snake_case` 기계 코드 | 255 (53%) |
| 영문 산문 (`program not found`) | 202 (42%) |
| **한국어 문장이 `error` 필드에** | 24 (5%) |

**가장 흔한 4가지 에러가 전부 두 가지 철자로 나간다:**

| 기계 코드 | 산문 |
|---|---|
| `media_not_found` (6) | `media not found` (15) |
| `program_not_found` (5) | `program not found` (16) |
| `clip_not_found` (9) | `clip not found` (14) |
| `not_found` (39) | `not found` (8) |

프론트가 `if (err.error === "media_not_found")`라고 쓰면 라우트에 따라 맞기도 하고 틀리기도 한다.

문서도 규약이 아니라 관찰을 적고 있다 — `api-reference.md:413`: *"오류는 JSON `{ error: string }` (**때로** `message` 동반)"*.

**정답은 이미 리포 안에 있다.** `index.ts:580` `keyError(status, code, message)`와 그 주석:

> 예전엔 전부 `request_failed` 라, 호출자가 "키를 새로 발급받아야 함"과 "이 라우트는 원래 안 열림"과 "일시 오류"를 구분할 수 없어 재시도할지 멈출지를 코드로 판단하지 못했다.

API 키 경로에서 배운 교훈이 나머지 470여 곳에 전파되지 않았다. **전부 고칠 필요는 없다** — B-7의 ⑤로 현 상태를 동결하고 새 것만 막는 쪽이 현실적이다.

---

## C. 구조 — 새 규칙이 아니라 기존 무기를 늘리기

> CLAUDE.md의 **"서버 라우트는 `index.ts` 한 파일에 유지 — 분리하지 말 것"** 은 그대로 둔다. 아래 제안은 전부 그 규칙과 양립한다.

이 리포의 진짜 방어선은 폴더 구조가 아니라 **소스 스캔 아키텍처 테스트**다. 13,657줄 한 파일이 버티는 이유가 그거다. 그러니 개선도 그쪽에 붙이는 게 맞다.

`tests/sources.ts`의 `sourceFiles()`/`routeSource()`를 입력으로 쓰고, 실패 메시지에 **빠진 것을 이름으로** 보고하는 기존 형식을 따르는 6개를 제안한다. 우선순위 순.

### ① `api-key-routes.test.ts` — 화이트리스트 ↔ 실물 라우트 1:1 **(가장 값어치 큼)**

`API_KEY_ROUTES` 63개 규칙 각각에 대해:
- 매칭되는 등록 라우트가 **0개면 실패** → 죽은 항목. 고객사는 403이 아니라 **404**를 받는데, 증상이 권한 문제로 안 보여서 진단이 어렵다
- 매칭이 **2개 이상이면 실패** → 정규식이 넓어 형제 라우트까지 열렸다

> 이 검사를 수동으로 돌려봤고 **지금 초록이다** — 죽은 항목 0개, 과대 매칭 0개. 즉 현재 결함은 없고, 넣어도 CI가 안 빨개진다. 지키는 장치만 없는 상태다.
>
> `rls-access.test.ts`가 표 목록을 마이그레이션에서 걷어오는 사상(목록을 손으로 안 적는다)과 `worker-lanes.test.ts`의 "선언 ↔ 배선 차집합" 관용구를 그대로 재사용한다.
>
> 참고로 `tests/api-keys.test.ts:205-210`이 `DELETE /api/programs/p_1`을 손으로 막아둔 것 자체가 "이 위험을 알고 있는데 샘플로만 막는 중"이라는 증거다.

### ② `body-limit.test.ts` — 본문을 읽는 라우트는 상한을 통과한다

`c.req.json(`/`parseBody(`/`formData(`/`arrayBuffer(`를 쓰는 라우트를 걷고, `bodyLimit` 미들웨어나 명시적 크기 검사가 있는지 확인. **허용 목록으로 현 상태를 동결**하고 새 라우트만 요구하면 지금 안 빨개진다.

### ③ `rate-limit.test.ts` — 비싼 라우트는 관문을 통과한다

"비싼 것"을 소스에서 정의: 핸들러 안에 `spawn(`이 있거나 `ai/gemini.ts` 헬퍼를 부르는 라우트. 각각 레이트리밋 호출 또는 **명시적 면제 주석**을 요구.

지금 그대로면 `autofill`·`generate-metadata`·`reports`가 빨개지므로 면제 목록으로 동결하고 **목록에 이유를 적게** 한다. 그 면제 목록 자체가 부채의 대차대조표가 된다.

### ④ `log-hygiene.test.ts` — OAuth 콜백 예외는 마스킹을 거친다

`oauthStateGuard(`로 감싼 핸들러 블록을 잘라, 그 안 `console.error(`가 마스킹 헬퍼 없이 에러 식별자를 통째로 넘기는 곳을 잡는다. `publish-guard.test.ts`가 `handleYoutubeReconcile` 함수 본문만 잘라 검사하는 방식과 동일.

실패 메시지: *"`index.ts:11406`은 마스킹하는데 여기는 안 한다 — 같은 위험, 다른 처리."*

### ⑤ `error-shape.test.ts` — `error` 필드는 기계가 읽는 코드다

`c.json({ error: "..." }`의 문자열에 `^[a-z0-9]+(_[a-z0-9]+)*$`를 요구. 기존 위반 232종을 동결 목록에 넣고 **새로 추가되는 것만** 막는다 — `docs-drift`의 오차 허용과 같은 사상("완벽"이 아니라 "더 나빠지지 않기").

### ⑥ `no-nul-in-source.test.ts` — 소스에 리터럴 NUL을 두지 않는다

`report/aggregate.ts`와 `tests/asset-path.test.ts`에 리터럴 NUL 바이트가 있다(복합 키 구분자 — 의도된 것). 그래서 **셸 `grep`이 이 두 파일을 바이너리로 보고 건너뛴다.**

현 아키텍처 테스트들은 `fs.readFileSync`를 쓰니 영향 없지만, 누가 grep 기반 검사를 추가하면 이 둘만 조용히 빠진다. `sources.ts:1-9` 주석이 경고하는 바로 그 병(**검사 범위가 조용히 줄어드는 것**)의 변종이다. ` ` 이스케이프로 바꾸면 끝.

### 덤 — 문서 드리프트 하나

`"라우트 118개"`가 소스 주석 **3곳**에 남아 있다 (실제 284개):
```
auth/api-keys.ts:15        "서버 라우트는 118개인데"
index.ts:625               "세션용 라우트 118개를 키에 통째로 열지 않는다"
tests/api-keys.test.ts:382  "화이트리스트 없이 통과하면 라우트 118개가 다 열린다"
```

118은 `docs-drift.test.ts:4`가 2026-08-12에 *이미 한 번 잡아 고친 바로 그 숫자*다. `.md`만 고쳤고 소스 주석은 남았다 — `docs-drift`가 `.md`만 보기 때문이다.

---

## D. 안 고쳐도 되는 것 (오해 방지)

분석 중에 "문제처럼 보이지만 의도된 것"으로 확인한 것들. **잘못 고치면 사고가 난다.**

- **결제·크레딧에 트랜잭션이 없는 것.** `index.ts:7491-7507` 주석대로 `addCreditEntry` → `markTopupPaid` **순서**가 방어이고, 멱등은 `credit_ledger.dedupe_key`의 `ON CONFLICT DO NOTHING`이 책임진다. 상태를 먼저 `paid`로 찍으면 재시도가 가드에 막혀 **크레딧이 영구히 사라진다.**
- **`entities`에 범용 GIN 인덱스가 없는 것.** 조회 패턴이 `kind` 등치 + `data->>'episodeId'` 등치뿐이라 `0048`의 표현식 부분 인덱스가 정확히 맞는다. 행 하나가 75KB라 GIN은 쓰기 비용만 커진다.
- **`/api/state`가 API 키 호출에 304를 안 주는 것.** `index.ts:2369-2377`의 근거가 정확하다 — 아끼는 바이트는 전부 브라우저 폴링 쪽이고, 남의 연동 코드에 위험을 지우지 않겠다는 판단.
- **카드 경로가 전역 `onError`를 우회하는 것.** `index.ts:6831` 주석 — DB 예외에 카드 원문이 실릴 수 있어서다. 수준 높은 판단이다.

그리고 **못 찾은 것도 적어둔다**: SQL 인젝션, 경로 traversal, 오픈 리다이렉트, 평문 크리덴셜 저장, 테넌트 격리 우회 — **다섯 가지 모두 방어가 실제로 작동하고 있다.** 동적 SQL 조립은 `db-pg.ts:4722` 한 곳뿐인데 컬럼명이 코드 상수다.

---

## E. 확인 못 한 것

정직하게 남긴다. 아래는 **추측이고 검증하지 않았다.**

- **런타임 동작 일절 미검증.** 서버를 띄우지 않았고 요청을 보내지 않았다. 전부 정적 읽기다.
- **`EXPLAIN` 실측 없음.** A-1·B-1의 "인덱스가 안 걸린다"는 판정은 인덱스 선두 컬럼과 쿼리 술어의 대조 + `0048` 마이그레이션이 기록한 RLS OR 술어 특성에 근거한 것이다. 프로덕션 행 수와 실제 실행 계획은 확인하지 않았다.
- **Cloud Run 서비스의 요청 크기 상한·메모리 설정.** `deploy/cloud.sh:162`의 `memory: 1Gi`는 문맥상 Job 쪽이고 server 값은 그 파일에 없었다.
- **Cloud Logging 보존기간·열람 권한.** B-4의 실제 노출 크기를 좌우하는데 GCP를 조회하지 않았다.
- **undici fetch 실패 시 `console.error(err)`가 실제로 URL/토큰을 출력하는지.** 마스킹 누락은 확정, 유출 여부는 미확인.
- **`report/aggregate.ts`의 집계 쿼리.** NUL 바이트 때문에 grep이 건너뛰어 인덱스 적합성을 못 봤다(⑥의 실제 사례).
- **`content.analyze` 재시도가 `recordUsage`/`addCreditEntry` 블록(`content-pipeline.ts:2051`)을 다시 실행하는지.** 핸들러 전체를 읽지 않았다. 재실행하지 않는다면 "사용량은 기록됐는데 차감은 안 된" 창이 남을 수 있다.
- **범위 밖**: `apps/web`, `admin/`, `core/` 파이썬, Vercel `/api/proxy` 계층.

---

## 실행 순서 제안

| 순서 | 항목 | 기대 효과 | 난이도 |
|---|---|---|---|
| 1 | A-1 + B-1 인덱스 4줄 (마이그레이션 하나) | sync 순차스캔 500회 → 인덱스 조회 | 매우 낮음 |
| 2 | A-3 로그인 레이트리밋 | 크리덴셜 스터핑 차단 | 낮음 |
| 3 | B-2 전역 `bodyLimit` | OOM·argv 폭주 차단 | 낮음 |
| 4 | C-① 화이트리스트 테스트 | 지금 초록 · 넣기만 하면 됨 | 낮음 |
| 5 | A-2 sync 배치화 | 2,000쿼리 → 4 | 중 |
| 6 | A-4 + C-③ LLM 라우트 제한 | 원가 폭주 차단 | 중 |
| 7 | B-5 `editorState` 분리 | `/api/state` 응답 92% 감소 | 중 |

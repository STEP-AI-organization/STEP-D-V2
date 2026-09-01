# STEP-D — FLOWS 정합 구현 계획

작성일 2026-08-10 · 기준 문서 `design_handoff_stepd/FLOWS.md`(동작) · `README.md`(생김새) · 기준 커밋 `c26e0ed`

---

## 0. 전제와 이 문서의 규칙

- **FLOWS 의 Invariants 와 ⊘ 는 협상 대상이 아니다.** 아래 §1 의 위반 목록은 "고칠지 말지"가 아니라 "언제 고치는지"만 논의한다.
- **F3(게이트)·F6(자동배포)은 서버 테스트로 고정한다.** UI 테스트를 쓰지 않는다 (FLOWS.md:207).
- **구현 순서는 FLOWS.md:194-206 을 따른다.** 단 한 곳에서 의도적으로 벗어난다 — §3.1 에 근거를 적었다.
- **PR 은 화면 단위로 쪼갠다.** 화면이 없는 서버 작업은 별도 레인(S)으로 두되, 어느 화면 PR 이 그것에 물리는지 명시한다.
- 근거는 전부 `file:line`. 이 문서를 쓰며 직접 열어 확인한 것만 적었고, 확인 못 한 것은 "미확인"으로 표시했다.

**검증 명령**: `apps/server` → `pnpm typecheck` + `pnpm test` (하네스는 이미 있다, §4.0) · `apps/web` → `npx next build`

---

## 1. 지금 코드가 위반하는 불변식 (최우선)

"위반(violated)"은 **코드가 명세와 반대로 능동적으로 동작하는 것**이다. "미구현(missing)"과 구분했다 — 미구현은 §1.2.

### 1.1 능동적 위반 — 즉시 고쳐야 하는 것

| # | 불변식 (FLOWS) | 지금 코드가 하는 일 | 근거 | 고치는 PR |
|---|---|---|---|---|
| **V1** | F1 Invariant (FLOWS.md:35) 업로드 완료 ≠ 분석 완료. 회차는 `분석 대기` 로만 들어간다 | 업로드 finalize 가 회차를 만들 때 **즉시** `stage:"analyze", stageStatus:"progress", progress:30, note:"AI 장면 분석 중…"` 으로 박는다. 워커가 잡을 집기도 전이다 — `prependEntity`(1491) → `markContentAnalysisPending`(1516) → `enqueue`(1517) 순서 | `apps/server/src/index.ts:1487-1489`, `:1491`, `:1516-1521` | U3 + S1a |
| **V2** | F1-3 ⚑ (FLOWS.md:31) "…분석 대기열에 들어갔고, 권리 정보는 분석이 끝난 뒤 등록합니다" | 토스트가 `"업로드 완료 · <파일명> · 회차·추천 생성됨"` 이다. **추천은 생성되지 않는다** — finalize 는 항상 `recommendations: []` 를 반환한다. 그리고 곧바로 빈 추천 보드(`?tab=recommend`)로 이동시킨다 | `apps/web/src/components/upload-video-dialog.tsx:112-114` / `apps/server/src/index.ts:1512-1513, :1527` | U3 |
| **V3** | F1-2 ⊘ (FLOWS.md:28) 진행 중 같은 프로그램·같은 회차 번호 재업로드 금지(409) | 회차 번호를 **클라이언트가 보내지 않는다.** 서버가 `MAX(episodeNumber)+1` 로 자동 채번하고, 주석 스스로 "rarely mint the same episodeNumber"라고 충돌을 허용한다. 같은 회차를 두 번 올리면 조용히 N화·N+1화 두 개가 생긴다. `(programId, episodeNumber)` 유니크 인덱스도 없다(회차는 `entities` JSONB) | `apps/server/src/index.ts:1467-1474` / `apps/server/migrations/0001_baseline.cjs:32` | U3 + S1a |
| **V4** | F1-2 (FLOWS.md:27) 모달을 닫아도 업로드는 계속된다 | **정반대.** 업로드 중 배경 클릭·닫기 버튼·취소가 전부 막혀 있고 툴팁이 "업로드 중에는 닫을 수 없습니다". 다이얼로그는 `{open && …}` 로 언마운트되므로 진행 상태를 끌어올린 전역 컨텍스트도 없다 | `apps/web/src/components/upload-video-dialog.tsx:150, :154-161` | U3 |
| **V5** | F2 Invariant (FLOWS.md:51) 이슈가 승계되지 않은 미디어는 존재할 수 없다 | 승계할 원본조차 없다. 추천 엔티티 생성부(`recFromShort`)에 권리·심의 필드가 0개이고, 수동 adopt 가 만드는 clip 객체와 factory 의 clip 객체에도 없다 | `apps/server/src/content-pipeline.ts:341-380` / `apps/server/src/index.ts:2803-2836` / `apps/server/src/factory.ts:334-358` | S1b |
| **V6** | F3 Invariant (FLOWS.md:73) 게이트를 통과하지 않은 미디어는 **어떤 경로로도** 게시되지 않는다 | 배포 경로 4곳 어디도 권리를 조회하지 않는다. `/publish` 는 `youtubeUploadEnabled()`(env 킬스위치)와 `isClipRendered()` 두 가지만 본다. `/retry` 동일. 워커도 동일. **factory 는 라우트를 아예 우회하고 큐에 직접 넣는다** | `index.ts:2932, :2947, :2972` · `index.ts:3000` · `worker.ts:1198` · `factory.ts:297-305` | S2 |
| **V7** | F3 Invariant (FLOWS.md:74) 게이트 상태 변경은 감사 로그에 남는다 | 감사 로그 테이블·라우트가 없다. `schema.sql` 의 CREATE TABLE 9개, migrations 0001~0010 어디에도 없다. 가장 가까운 사람-결정 기록(출연자 상태)도 in-place UPDATE 라 이전 값이 파괴되고 actor 컬럼이 없다 | `apps/server/schema.sql` · `apps/server/migrations/` · `apps/server/src/db-pg.ts:1613-1632` / `migrations/0003_cast-registry.cjs:52-71` | S1b |
| **V8** | F3 (FLOWS.md:60) **자동 판정 없음.** 이슈는 사람이 등록한다 | 파이프라인이 PPL 구간을 자동 검출해 `seg.rights.ppl = true` 를 써 넣는다. 반대로 **사람이 이슈를 등록하는 라우트는 0개**다 | `apps/server/src/content-pipeline.ts:1194-1196` / `index.ts` 의 PATCH/PUT 8곳(`:538,690,729,1226,2567,2755,3033,3053`) 중 rights 관련 0건 | S1b |
| **V9** | F2 Invariant (FLOWS.md:51) 이슈 없음도 명시적 판정 — 미판정과 구분 | 존재하는 유일한 권리 필터가 `NULL=미확인은 통과`를 명시적으로 코딩해 두었다. 미판정이 통과와 같은 취급이다 | `apps/server/src/db-pg.ts:1772-1774` (주석 원문 포함) | S1b |
| **V10** | F3 Invariant (FLOWS.md:73) 관리자 권한도 우회 불가 / F9 (FLOWS.md:174) 모든 권한은 서버에서 재검사 | 스포일러 필터가 **무인증 쿼리 파라미터 하나로 꺼진다**: `allowSpoiler: c.req.query("allow_spoiler") === "true"`. 서버 전역 미들웨어는 logger 와 전면허용 CORS 둘뿐 — 인증·인가 미들웨어가 없다 | `apps/server/src/index.ts:229` / `apps/server/src/index.ts:174-175` | S3 |
| **V11** | F4 Invariant (FLOWS.md:92) `기록됨`을 `게시됨`처럼 보여주지 않는다 | 서버가 **youtube 가 아닌 모든 채널**을 하나의 스텁 분기로 처리해 `status="published"` 를 쓰고 clip 자체도 published 로 승격한다. 타입에 `recorded`/`기록됨` 상태값이 없고, 배포 화면은 채널 구분 없이 초록 `done` 톤 "게시됨" 배지를 그린다 | `apps/server/src/index.ts:2967-2982` · `apps/server/src/index.ts:3020-3022` / `apps/web/src/lib/types.ts:257-259` / `apps/web/src/app/(app)/distribution/page.tsx:20-33` | S2 + U7 |
| **V12** | F4-4 ⊘ (FLOWS.md:89) 지수 백오프 자동 재시도 금지 | **부분 위반.** 업로드 실패 자체는 `catch → markDistributionFailed` 로 throw 없이 끝나 백오프를 안 탄다(정상). 그러나 업로드 **직전** 사전 단계 예외는 try 밖이라 throw 되고, 큐가 지수 백오프로 최대 5회 자동 재시도한다 | `apps/server/src/worker.ts:1191, :1213, :1216, :1220`(try 는 `:1229` 부터) / `apps/server/src/queue.ts:198-224` | S2 |
| **V13** | F5 (FLOWS.md:102-106) **의도적으로 없는 기능** — 되돌리기, 전체 속도 램프 | 둘 다 구현돼 있다. 되돌리기는 `useEditorHistory`, 속도 램프는 타임라인 "속도 램핑" 키프레임 UI. **더 나쁜 건 속도 램프가 UI 에만 있고 서버가 무시한다는 점** — `speedPoints` 가 있으면 `uniformSpeed()` 가 1 을 반환해 프리뷰와 렌더가 어긋난다 | `apps/web/src/components/editor/editor-shell.tsx:19, :108` / `apps/web/src/components/editor/editor-timeline.tsx:478, :196-207` / `apps/server/src/index.ts:2301-2312` | U9 |
| **V14** | F6 Invariant (FLOWS.md:142) 자동 배포는 게이트를 건너뛰지 않는다 | 현재는 "건너뛰는" 게 아니라 **건너뛸 게이트가 없다**. 문제는 구조다 — factory 가 `/api/distributions/publish` 를 부르지 않고 `enqueue("distribution.publish", …)` 를 직접 하므로, **앞으로 라우트에 게이트를 붙여도 factory 경로에는 적용되지 않는다.** 코드가 스스로 미배선을 인정한다: "그 본체(게이트 연동)는 F3 을 세운 뒤에 붙지만" | `apps/server/src/factory.ts:297-305` / `apps/server/src/tests/factory.test.ts:4-6` | S0 + S2 + S4 |
| **V15** | F6 Invariant (FLOWS.md:142) 보류된 건은 사람이 확정해야 다음 순방에 다시 잡힌다 | `hold` 상태는 있으나 **게이트가 아니라 일일 상한** 사유이고, `retryInMs: null` 종료 상태다. 해제 라우트가 없어 사람이 확정해도 다시 잡히지 않는다 | `apps/server/src/factory.ts:53-56, :234-239, :315-319` | S4 |

### 1.2 미구현이라 불변식을 만족할 수 없는 것 (동급으로 중요)

- **F3 게이트 5상태 전부 부재** — `통과`/`권리 홀드`/`조건부 처리`/`검수 대기`/`차단` 문자열이 코드 어디에도 없다. 유일한 `rights` 는 `search_segments.rights JSONB` 로, (a) 검색 SQL 필터 (b) 검색 카드 표시 주석 두 용도뿐이며 clip/media 와 **조인 키조차 없다**. 마이그레이션 주석이 미구현을 자백한다: `apps/server/migrations/0009_search-segments.cjs:14-15` "아직 파이프라인 신호 전이라 대부분 NULL로 들어온다 … 채우는 건 이후", `core/index_segments.py:24, :384-385` 전부 `None` placeholder.
- **F3 강제 지점 3곳 중 0곳 배선.** ① 미디어 화면 배포 버튼 — 발행 요건 엔진 `apps/web/src/lib/publish/requirements.ts` 336줄 전체에 권리·심의 체크가 0개(`EVALUATORS` `:282-288`). ② 편집기 — "배포"가 `/distribution` 으로 가는 단순 `<Link>`(`editor-shell.tsx:499-503`), "검수 요청" 개념 자체가 전 계층 0건. ③ 자동 배포 — 위 V14.
- **F4-2 길이 상한 초과 채널 선택 불가 + 사유** 없음. 차단 메커니즘 자체는 같은 파일에 이미 있다(세로 비율 체크 `requirements.ts:269-277`) — 엔진이 없는 게 아니라 체크가 없는 것이다.
- **F6 규칙 엔티티·스케줄러 순방·자동/수동 로그 분리** 없음. `automation` 성격 라우트가 `apps/web/src/app/(app)/` 에 없다.
- **F9 역할 4종(`editor`/`cp`/`pd`/`vendor`) 없음.** 현재는 이름·개수가 다른 3종(`user`/`admin`/`superadmin`, `apps/web/src/lib/nav.ts:21`)이 하드코딩 목 세션(`apps/web/src/lib/auth.tsx:16` superadmin 고정)으로만 있고 사용처는 사이드바 메뉴 필터 1곳이다. 수익 "비공개" 마스킹 없음.
- **F8 에셋 전부 부재** — "에셋"이라는 단어가 `apps/web/src` 에 0건.
- **F7 독립 썸네일 화면 부재.** 존재하는 두 경로는 (a) 쇼츠마다 3 variant 를 만드는 기존 파이프라인(= F7-1 "숏폼 제외"와 정반대), (b) 워커 `thumbnail.generate` 잡(결과를 읽는 GET 라우트 없음).
- **F10 프로그램 목록 필터 UI 부재**, 상태 3분류 없음 — `status: "active" | "archived"` 뿐이고 `"archived"` 는 **도달 불가능한 죽은 값**이다(`POST /api/programs` 가 `"active"` 하드코딩 `index.ts:372`, PATCH 에 status 분기 없음 `:538-658`).

### 1.3 지켜지고 있는 것 (되돌리지 말 것)

- F2-2 ⊘ 클라이언트 타이머로 100% 채우기 — 서버가 실행 중 99% 로 clamp 하고 100 은 완료 때만 쓴다(`content-pipeline.ts:983`, `:1259`). 단 명세의 97%·2.6초 폴링과는 값이 다르다(§7 D7).
- YouTube 업로드 킬스위치 3중 배선(라우트 → 워커 → youtube.ts) — 호출자 무관 설계라 factory 경로도 잡힌다(`upload-gate.ts:50-52`, `index.ts:2932`, `worker.ts:1198`). **F3 게이트도 같은 형태를 따라야 한다.**
- 발행 다이얼로그의 "제외 건수 고지" 패턴 — `publish-dialog.tsx:152-165, :172-190` 이 항목별 미충족 수를 보여준다. F3 의 ⚑ "제외 건수 토스트"를 여기에 끼우는 게 가장 짧은 경로다. (단 배포 화면의 "주간 일괄 예약"은 readiness 를 아예 안 보고 전 건을 밀어 넣는다 — `distribution/page.tsx:79-90`. 이 경로는 지금도 조용한 제외가 일어난다.)

---

## 2. 화면 대조 요약 (PR 분할의 근거)

README.md:115 가 요구하는 라우트 12개 + 오버레이 3개 + 앱 셸 1개 = **16개**.

| 설계 | 현재 | 판정 |
|---|---|---|
| `/dashboard` §1 | `(app)/page.tsx` ("오늘 할 일") | 대폭수정 (게이트 요약 줄·수익 마스킹 신규) |
| `/programs` §2 | `(app)/programs/page.tsx` | 대폭수정 (필터 UI 전무) |
| `/programs/:id` §3 | `(app)/programs/[id]/page.tsx` | 대폭수정 (상태 3분기 없음) |
| `/analyze` §4 | 없음 (`episodes/[id]` 가 유사) | 신규 라우트 |
| `/media` §5 | `(app)/clips/page.tsx` | 대폭수정 (게이트 축 전무) |
| `/assets` §6 | 없음 | **신규 (백엔드 포함)** |
| `/distribution` §7 | `(app)/distribution/page.tsx` | 대폭수정 |
| `/performance` §8 | `(app)/analytics/page.tsx` | 대폭수정 |
| `/search` §9 | `(app)/search/page.tsx` | 소폭수정 |
| `/channels` §10 (배포 채널) | `(app)/publish-channels/page.tsx` ⚠️ 현 `/channels` 는 YouTube 트렌드 분석 | **라우트 이름 충돌** |
| `/thumbnails` §11 | 없음 (`thumbnail-templates` 는 다른 것) | 신규 |
| `/automation` §12 | 없음 | 신규 |
| §13 업로드 모달 | `components/upload-video-dialog.tsx` | 대폭수정 |
| §14 편집기 | `(editor)/editor/[id]` | 대폭수정 |
| §15 주간 리포트 모달 | 없음 | 신규 |
| §0 앱 셸 | `(app)/layout.tsx` + `AppShell` | 대폭수정 (역할 컨텍스트) |

설계에 대응이 없는 현행 라우트 중 `/thumbnail-templates` 는 **2026-08-13 폐기됨**(썸네일 정책이
프로그램 스타일 프로파일로 일원화). 나머지(`/business`, `/trends`, `/ops`)와
`/highlights`·`/programs/[id]/highlights` 는 존치/폐기 결정 필요(§7 D9).

---

## 3. PR 계획

### 3.1 순서 — FLOWS.md:194-206 대비 딱 하나의 이탈

FLOWS 는 `3. 업로드→분석(F1,F2)` → `4. 게이트(F3)` 순이다. 그런데 **F2 Invariant(FLOWS.md:51, 이슈 승계·명시적 판정)가 게이트 데이터 모델을 선행으로 요구한다.** 그래서 F3 을 둘로 쪼갠다:

- **S1b(게이트 서버 코어)** — 스키마·순수 판정 함수·승계·감사 로그. **3번보다 앞에 착지**.
- **U6(미디어 화면 게이트 UI)** — 그대로 4~5번 자리.

이탈의 근거는 FLOWS 자신의 주석이다: "**이걸 먼저 세워야 이후 화면이 흔들리지 않음**"(FLOWS.md:199). 화면 순서는 그대로 지킨다.

### 3.2 서버 레인 (S) — 화면 없음, 전부 서버 테스트 동반

| PR | 범위 | 의존성 | FLOWS | 서버 테스트 |
|---|---|---|---|---|
| **S0** | 순수 함수 추출 + 아키텍처 테스트. `publish-guard.ts`(`isClipRendered`·`upsertDistribution`·`screenForPublish`) · `factory-policy.ts`(`nextStep`·`selectPicks`). **동작 변경 0** — 리팩터만 | 없음 (지금 착수 가능) | F3 강제 준비, F6 | ✅ 신규 파일 3개. 아키텍처 테스트는 **처음엔 의도적으로 실패**(§4.3) |
| **S1a** | F1 서버측: 회차 상태 `분석 대기` 신설(V1), `(programId, episodeNumber)` 유니크 + 409(V3), 회차 번호·방영일·트랙·자막을 요청 바디로 수용 | S0 | F1-1, F1-2 ⊘, F1 Inv | ✅ `episode-status.test.ts`, `episode-number.db.test.ts` |
| **S1b** | **게이트 도메인 코어.** migration `0011_gate.cjs`(`rights_issue` + `gate_audit` append-only) · `gate.ts`(순수) · adopt 승계 · 이슈 등록/해제 라우트(사람만) · PPL 자동 기입 제거(V8) | S0 | F2 Inv, F3 전부 | ✅ `gate.test.ts`(핵심), `gate-audit.db.test.ts` |
| **S2** | **배포 경로 4곳 게이트 수렴.** `/publish`·`/retry`·`worker`·`factory` 를 전부 `publish-guard.screenForPublish` 경유로. `기록됨` 상태 신설(V11). 사전 단계 throw 제거(V12) | S0, S1b | F3 강제①③, F4-3, F4-4 ⊘, F4 Inv | ✅ `publish-guard.test.ts` + 아키텍처 테스트 통과 전환 |
| **S3** | F9 서버 강제. 역할 4종 · 인증 미들웨어 · scope 필터 · `allow_spoiler` 쿼리 우회 제거(V10) | S1b | F9 | ✅ `authz.test.ts` (순수 정책 함수) |
| **S4** | F6 규칙 엔진. migration `0012_automation_rule.cjs`(`automation_rule` + `rule_run`) · 스케줄러 순방 · 보류 큐 재진입(V15) · factory 수렴(§5) | S2, S3 | F6 전부 | ✅ `factory-policy.test.ts`, `rule-scheduler.test.ts` |
| **S5** | F8 에셋 백엔드(폴더 CRUD·파일 업로드/서빙/삭제) | S3 | F8 | ✅ 경로 정규화·삭제 확인 순수 테스트 |
| **S6** | F7 썸네일 조회 라우트(생성물 GET), 대표 썸네일 지정 | 없음 | F7-3 | ⬜ (얇음) |

### 3.3 화면 레인 (U) — FLOWS 구현 순서 그대로

| # | PR | README | 범위 | 의존성 | 걸리는 FLOWS | 서버 테스트 |
|---|---|---|---|---|---|---|
| 1 | **U1 앱 셸 + 라우팅 + 역할 컨텍스트** | §0 | 사이드바 3그룹 · 상단바 · 토스트(하단 중앙 3초) · 12개 라우트 스캐폴딩 · 역할 4종 컨텍스트 · **`/channels` 리네임**(§7 D2) · 연결 상태 표시 | S3 | F9, F11 | S3 에 포함 |
| 2 | **U2 프로그램 목록** | §2 | 검색·섹션·상태·내담당 필터 + **잔여 개수** 라벨 · 카드 그리드 · 권리 윈도우 태그 | U1, S1b | F10 | ⬜ (개수 계산은 클라 순수 — web 유닛으로 충분) |
| 3 | **U3 프로그램 홈** | §3 | 헤더·3분할 지표 · **상태별 3분기**(방영중/종영/편성예정) · 회차 4열 · 미디어 레일 · 출연자 | U2, S1a | F10, **F2-5**(종영=클립 생성 없음) | ✅ S1a 의 status 전이 테스트 재사용 |
| 4 | **U4 회차 업로드 모달** | §13 | 진입점 3곳 동일 모달 · 필수 3개 · 숫자만 · 방영일 date · 트랙 유추 · 자막 체크 · **⚑ 고지 문구**(0.4배·권리 자동 인식 안 됨) · **백그라운드 계속**(V4) · 409 처리(V3) · **토스트 문구 교체**(V2) | S1a, U3 | **F1 전부** | ✅ S1a |
| 5 | **U5 영상 분석** | §4 | 좌 214px 회차 레일 · 원본 플레이어 · 추천 구간 리스트 · **권리/심의 레인** · 채택/보류 | S1b, U4 | **F2 전부** | ✅ S1b(승계) |
| 6 | **U6 미디어 (게이트 강제 지점 ①)** | §5 | 전체/숏폼/클립 + **게이트 필터** · 행 게이트 태그·이슈 요약 · **하단 액션바(선택 수 · 통과 건수 · 검수 요청/배포)** · 이슈 등록/해제 UI | S1b, S2 | **F3 전부**, F3 강제① | ✅ S1b + S2 |
| 7 | **U7 배포 채널** | §10 | 플랫폼 → 계정 카드 · 역할(본채널/서브/숏폼전용/계열) · **업로드 규칙 표**(길이 상한·비율·접두·해시태그·말투·공개범위·시간대) · 2단계 추가 모달 | S2 | F4-2 의 데이터 소스 | ✅ 규칙표 판정 순수 함수 |
| 8 | **U8 배포 + 배포 모달** | §7 | 채널 탭 · 로그 행 · **`기록됨` 태그 분리**(V11) · **길이 상한 초과 채널 선택 불가 + 사유** · ⚑ "실제 게시는 담당자가 직접" · 사람이 누르는 재시도만 | U7, S2 | **F4 전부** | ✅ S2 |
| 9 | **U9 편집기** | §14 | 비율 기본값 전환 + 사용자 선택 우선 · 타임라인 **권리 레인** · **검수 요청 버튼(강제 지점 ②)** · 변경 없음 ⚑ · **되돌리기·속도 램프 제거**(V13) | S2, U6 | **F5 전부**, F3 강제② | ✅ S2 |
| 10 | **U10 에셋** | §6 | 폴더 트리 · 파일 그리드 · 다중 선택 일괄 이동 · 새 폴더 · **이름 변경 없음** · 삭제 확인 · 정렬/종류 필터를 편집기 패널과 **공용 모듈**로 | S5, U9 | **F8** | ✅ S5 |
| 11 | **U11 썸네일 생성** | §11 | 대상 라디오(**숏폼 제외**) · 프롬프트 + 비율 · 3안 → 대표 지정 · 대상 변경 시 초기화 · ⚑ "다른 화면 가도 결과는 남음" | S6 | **F7** | ⬜ |
| 12 | **U12 자동 배포 (강제 지점 ③)** | §12 | 상태 바(다음 순방 시각) · 5단계 카드(04 게이트 앰버) · 규칙 리스트 · **자동 실행 로그(수동과 분리)** · 하단 경고 배너 · 규칙 추가 모달 · 일시정지/재시작/삭제 문구 | S4, U6 | **F6 전부** | ✅ S4 |
| 13 | **U13 대시보드** | §1 | **상단 게이트 요약 줄**(권리홀드/조건부/검수대기/윈도우 만료 임박) · 수익 카드 + **"비공개" 마스킹** · 채널 순위 · 상위 영상 · 최근 배포 로그 | S1b, S3, S4 | F3(윈도우 경고), F9 | ✅ S3 |
| 14 | **U14 성과 + 주간 리포트** | §8, §15 | 채널 선택 지표 · **차단 화면 2종 문구 분리**(권한 없음 vs 구조적 부재) · 주간 리포트 모달 | S3, U13 | F9 | ✅ S3 |
| 15 | **U15 영상 검색** | §9 | 자연어 + 날짜 필터 · 구간 카드 · 권리 배지를 게이트 어휘로 통일 · `allow_spoiler` 우회 제거 반영 | S3, S1b | F9(scope) | ✅ S3 |

**총 15개 화면 PR + 8개 서버 PR.** 서버 PR 은 화면 PR 을 막지 않도록 앞당겨 착지시킨다 (S0 → S1a/S1b → S2 → S3 → S4 → S5/S6).

---

## 4. F3·F6 을 서버 테스트로 고정 — 추출 사양

### 4.0 하네스는 이미 있다 (2026-08-10 `c26e0ed`)

`apps/server/package.json:11-12`
```
"test":       "node --import tsx --test \"src/**/*.test.ts\""
"test:watch": "node --import tsx --test --watch \"src/**/*.test.ts\""
```
- 러너 = Node 내장 `node:test` + `node:assert/strict`. **신규 의존성 0.**
- 기존 테스트 2개: `apps/server/src/tests/upload-gate.test.ts`, `apps/server/src/tests/factory.test.ts` (둘 다 env 스위치 불변식만 고정).
- **지금 손봐야 할 것 2가지**
  1. `apps/server/.dockerignore` 에 `*.test.ts` 추가 — 현재 내용은 `node_modules / dist / .env / .env.* / *.md` 뿐이라 테스트가 프로덕션 이미지에 들어간다(`Dockerfile` 이 `apps/server` 를 통째로 COPY).
  2. DB 필요 테스트 레인 분리. 파일명 규약 `*.db.test.ts` + `{ skip: !process.env.DATABASE_URL && "DATABASE_URL 없음" }`. 부트스트랩은 `initDb()`(migrate+seed 까지 돈다) 대신 `initQueue()` 만.

**import 가능 여부 실측**: `db-pg.ts`·`queue.ts`·`factory.ts`·`upload-gate.ts` 는 모듈 로드만으로 접속하지 않아 안전. **`index.ts`(6036줄, 말미 top-level `serve()`)와 `worker.ts`(1447줄, top-level `main()`)는 import 자체가 불가**하다 — 그래서 그 안의 게이트 로직은 **추출하지 않으면 원천적으로 테스트할 수 없다.**

> CLAUDE.md 의 "서버 라우트는 index.ts 한 파일에 유지, 분리하지 말 것" 규칙과 충돌하지 않는다. **라우트는 index.ts 에 그대로 두고, 순수 헬퍼만 모듈로 뺀다.** 추출 후 `app.post("/api/distributions/publish", …)` 는 여전히 index.ts 에 있다.

### 4.1 `src/gate.ts` — 신설 (F3 본체, DB 무관)

```
export type GateStatus = "pass" | "rights_hold" | "conditional" | "review" | "blocked";
export type IssueKind  = "music" | "portrait" | "ppl" | "cast_hold" | "brand_blur" | "vod_window";
                          // FLOWS.md:59 의 6종과 1:1

export interface RightsIssue {
  kind: IssueKind;
  resolution: "open" | "conditional" | "cleared";   // 조건부 처리 = 조치 확인 대기
  note?: string;
}

/** 미판정(undefined)과 "이슈 없음"([])을 타입으로 구분한다 — FLOWS.md:51 */
export type Judgement = RightsIssue[] | undefined;

export function evaluateGate(j: Judgement): { status: GateStatus; reason: string };
export function partitionByGate<T>(items: T[], gateOf: (t: T) => GateStatus)
  : { allowed: T[]; blocked: Array<{ item: T; status: GateStatus; reason: string }> };
export function inheritIssues(segment: Judgement): Judgement;   // F2-4 승계
export function buildGateAuditRecord(subject, from, to, actor, basis): GateAuditRecord;
```

**테스트로 고정하는 것**

| 불변식 | 테스트 |
|---|---|
| 미판정 ≠ 이슈 없음 (FLOWS.md:51) | `evaluateGate(undefined) === "review"`, `evaluateGate([]) === "pass"` — 두 값이 절대 같지 않음 |
| 자동 판정 없음 (FLOWS.md:60) | `gate.ts` 가 어떤 분석 결과도 import 하지 않음(모듈 그래프 assert). 이슈 생성 함수를 export 하지 않음 |
| 조건부 → 통과는 조치 확인 후에만 (FLOWS.md:61) | `resolution:"conditional"` 인 이슈가 하나라도 있으면 결과가 `"pass"` 가 될 수 없음(전수) |
| **관리자도 우회 불가** (FLOWS.md:73) | `assert.equal(evaluateGate.length, 1)` — role/override/force 파라미터를 **받을 자리가 없다**. 추가로 모듈 export 이름에 `force`/`override`/`bypass`/`admin` 매치 0건 assert |
| ⊘ 조용한 제외 금지 (FLOWS.md:69) | `partitionByGate` 가 blocked 를 **반환값으로 강제**. 반환 타입에 reason 이 필수라 사유 없는 제외가 컴파일되지 않음 |
| ⊘ 전체 실패 처리 금지 (FLOWS.md:69) | 통과 1건 + 미통과 1건 → `allowed.length === 1` (전체 throw 아님) |

### 4.2 `src/publish-guard.ts` — index.ts / worker.ts 에서 추출

지금 배포 진입점이 **4곳**이고 각자 따로 판정한다:

| 진입점 | 현재 검사 | 근거 |
|---|---|---|
| `POST /api/distributions/publish` | env 킬스위치 + `isClipRendered` | `index.ts:2932, :2947, :2972` |
| `POST /api/distributions/retry` | env 킬스위치만 | `index.ts:3000` |
| worker `distribution.publish` | env 킬스위치 + `mediaId` 유무 | `worker.ts:1198, :1212` |
| **factory `publishing`** | **아무것도 안 봄** | `factory.ts:297-305` |

추출 대상:
```
export function isClipRendered(clip): boolean            // index.ts:2868-2870 이동
export function upsertDistribution(d, channel, value)    // index.ts:2873 + worker.ts:1164 — 이미 2벌 중복, 통합
export function channelPublishMode(ch): "upload" | "record"      // F4-3
export function distributionStatusFor(mode, scheduled): "pending" | "scheduled" | "recorded"
export function screenForPublish(clips, ctx: { gateOf, channel }):
  { queue: string[]; skipped: Array<{ clipId: string; code: string; reason: string }> }
```

**아키텍처 테스트 (핵심 — 이게 V6·V14 를 영구히 막는다)**

```
소스 전체를 fs 로 읽어 /enqueue\(\s*"distribution\.publish"/ 매치 지점이 publish-guard.ts 1곳뿐임을 assert
```
현재 3곳(`index.ts:2955`, `index.ts:3013`, `factory.ts:299`)이므로 **이 테스트는 쓰는 즉시 실패한다. 그게 목적이다.** 의존성 0, DB 0. FLOWS.md:73 "어떤 경로로도"는 순수 함수 테스트로는 증명할 수 없고, 이 형태로만 고정된다.

**F4 Invariant 테스트**: `channelPublishMode("instagram") === "record"` → `distributionStatusFor("record", false) === "recorded"` 이고, `"published"` 는 `mode === "upload"` 에서만 나올 수 있음(전 채널 × 전 scheduled 조합 전수).

### 4.3 `src/factory-policy.ts` — factory.ts 에서 추출 (F6)

현재 `advance()`(`factory.ts:175-321`)는 상태 전이 + DB 읽기 + enqueue 가 한 함수라 **DB 없이 전이 하나도 짚을 수 없다.** 사실(facts)만 받는 순수 전이표로 뺀다.

```
export interface CycleFacts {
  mediaFound: boolean; stillDownloading: boolean;
  recCount: number; allRendered: boolean;
  dryRun: boolean; capReached: boolean;
  gate: GateStatus;          // ← 필수. optional 로 두면 빠뜨림이 컴파일 통과한다
  humanConfirmed: boolean;   // 보류 해제 (FLOWS.md:142)
}
export function nextStep(state: RuleRunState, f: CycleFacts)
  : { next: RuleRunState; retryInMs: number | null; note?: string };

export function selectPicks(recs, policy, alreadyToday, cap): Rec[];
export function normalizeConfidence(rec): number;      // factory.ts:245 버그 고정
export function dueRules(rules, now): Rule[];          // 스케줄러 순방
```

**테스트로 고정하는 것**

| 불변식 | 테스트 |
|---|---|
| **F6:142 자동 배포는 게이트를 건너뛰지 않는다** | `gate !== "pass"` 인 **모든** (state × facts) 조합에서 `next ∉ {"publishing","done"}` 전수 검사. `gate` 가 필수 필드라 빠뜨림이 **컴파일 에러**가 된다 |
| **F6:142 보류 → 사람 확정 → 다음 순방 재진입** | `state:"held", humanConfirmed:false` → `retryInMs !== null` 이고 `next === "held"` / `humanConfirmed:true` → `next === "publishing"`. **현재 `hold` 는 `retryInMs:null` 이라 이 테스트에 실패한다**(`factory.ts:238`) |
| **F6:143 규칙이 없으면 아무것도 하지 않는다** | `dueRules([], anyNow)` → `[]`. 전역 기본 동작 없음 |
| F6:131 일시정지 = 진행 중 순방은 끝내고 새 회차는 안 잡음 | `paused:true` → 01(회차수신)만 스킵, 02~05 는 계속 진행 |
| F6:135 규칙 삭제해도 게시된 건은 안 내려감 | 삭제 함수가 published 건을 건드리지 않음(반환값에 rollback 대상 없음) |
| 상한 판정 버그 | `normalizeConfidence({confidence:0.9, score100:88})` → `0.9` (현재 식은 `0.9/100 = 0.009`, `factory.ts:245`) |

### 4.4 DB 가 필요한 테스트 (`*.db.test.ts`, skip 가드)

mock 이 무의미한 것들만:
1. **dedupeKey 중복 방지** — `queue.ts:96-99`(partial unique index) + `:124-128`(`ON CONFLICT DO NOTHING`). PG 의미론 그 자체 → 중복 게시 방지의 마지막 방어선.
2. **`commitAdoption` 원자성** — `db-pg.ts:336-371` ("pending 일 때만 flip, 아니면 ROLLBACK").
3. **`gate_audit` append-only** — UPDATE/DELETE 가 실패하는지(권한 또는 트리거).
4. **`(programId, episodeNumber)` 유니크 → 409** (S1a).
5. 백오프 재스케줄 — `queue.ts:198-224`.

---

## 5. factory.ts → F6 규칙 모델 수렴

### 판단: **버리지 않는다. 실행 계층으로 남기고 그 위에 규칙 계층을 신설한다.**

**왜 버리지 않는가**
1. factory 가 하는 일은 F6 의 02·03·05 실행부와 사실상 1:1 이다 — `analyzing`(02) / `adopting`+`rendering`(03) / `publishing`(05) (`factory.ts:222-313`). 재작성하면 이걸 다시 만드는 것뿐이다.
2. **실측으로 검증된 재큐 설계를 잃는다.** `content.analyze` 는 실측 16분이고, 오케스트레이터가 기다리면 워커 하나를 통째로 점유한다 — 그래서 "한 걸음 전진하고 재큐"한다(`factory.ts:11-14`, `worker.ts:762-776`). F6 의 "순방(cycle)"과 개념이 같다.
3. 프로덕션에서 이미 돌고 있다(`7e19883 chore(deploy): 프로덕션 FACTORY_ENABLED=1`). 통째 교체는 되돌릴 수 없는 변경이 된다.

**무엇이 부족한가 (F6 대비 5개 전부 없음)**

| F6 요구 | factory.ts 현황 |
|---|---|
| 규칙 엔티티 (프로그램↔채널 = 자동화 단위, FLOWS.md:112) | 없음. 단위가 "ingest 요청 1건 = factoryJob 1개"(`factory.ts:136-159`) |
| 스케줄러 순방 (FLOWS.md:114) | 없음. self-requeue 로 **한 잡을 끝까지 밀어내는 원샷 완주** |
| **04 게이트 확인** (FLOWS.md:121) | 없음. 파일 전체 `gate|권리|심의|clearance` 검색 히트가 주석 1줄(`factory.ts:16`)뿐 |
| 보류 큐 + 사람 확정 후 재진입 (FLOWS.md:142) | `hold` 가 있으나 **일일 상한** 사유이고 `retryInMs:null` 종료(`factory.ts:234-239`) |
| 자동/수동 실행 로그 분리 (FLOWS.md:138) | 없음 |

### 수렴 3단계

**1단계 (S0, 동작 변경 0)** — `advance()` 를 `nextStep(순수) + I/O 어댑터` 로 분리. 상태 이름은 그대로. 이 시점에 §4.3 의 F6 테스트를 **실패 상태로** 심는다.

**2단계 (S2)** — 게이트 우회로 제거.
- `factory.ts:297-305` 의 직접 `enqueue("distribution.publish")` 를 `publish-guard.screenForPublish` 경유로 교체. §4.2 의 아키텍처 테스트가 초록으로 바뀐다.
- `nextStep` 에 `gate` 필수 필드 도입 → `publishing` 진입 전 04 단계 신설.

**3단계 (S4)** — 규칙 계층 신설.
- `automation_rule` 테이블 신설(프로그램·채널·미디어 종류·기준·게이트 정책·시간대 = FLOWS.md:124 그대로).
- `factoryJob` → **`ruleRun`(규칙 1회 순방)** 으로 개념 승격. 엔티티는 유지하고 `ruleId` 필드를 추가해, 규칙 없는 외부 ingest 는 `ruleId: null` 로 하위호환(§7 D10).
- 상태 분리: `hold`(일일 상한, 종료) ↔ **`held`(게이트 보류, 사람 확정 시 다음 순방 재진입)**. FLOWS.md:142 를 만족시키려면 반드시 다른 상태여야 한다.
- 로그 분리: `rule_run` 테이블에 자동 실행만 기록, 결과 5종(`게시됨`/`미디어 생성`/`보류`/`실패`/`기록됨`, FLOWS.md:139).

**폐기 대상 2개**
- `factory.ts:245` 의 confidence 식 — `(r.confidence ?? r.score100 ?? 100) / (r.score100 ? 100 : 1)`. 0~1 과 0~100 스케일을 한 식에 섞어, 둘 다 있으면 `0.9/100 = 0.009` 가 되어 `minConfidence` 를 거의 항상 탈락시킨다. `normalizeConfidence` 로 교체.
- `factory.ts:190-199` 의 `sourceUrl` 문자열 매칭 미디어 재사용 — 규칙 모델에서 "01 회차 수신"은 **프로그램의 새 회차 감지**로 바뀌므로 의미가 사라진다.

---

## 6. 신규 마이그레이션 (기존 0001~0010 다음)

| 번호 | 내용 | PR |
|---|---|---|
| `0011_gate.cjs` | `rights_issue`(subject_type: episode/recommendation/clip, subject_id, kind, resolution, note, actor, created_at) + `gate_audit`(append-only: subject, from, to, actor, basis, at) | S1b |
| `0012_episode_unique.cjs` | `(programId, episodeNumber)` 유니크 — 회차는 `entities` JSONB 라 expression index 필요. **기존 중복 데이터 사전 조사 필수**(§7 D4) | S1a |
| `0013_automation_rule.cjs` | `automation_rule` + `rule_run` | S4 |
| `0014_actor.cjs` | 사용자·역할(F9). 현재 users/roles 테이블 없음 | S3 |
| `0015_asset.cjs` | 폴더·파일(F8) | S5 |

**설계 결정 하나**: `clip.gate` 를 JSONB 에 캐시하지 않는다. 진실은 `rights_issue` 이고, 게이트는 매 판정마다 `evaluateGate` 로 계산한다. 캐시 필드를 두면 누군가 JSONB 를 덮어써 통과시킬 수 있어 FLOWS.md:73("어떤 경로로도")이 깨진다.

---

## 7. 위험 · 미결정

| # | 항목 | 내용 | 필요한 결정 |
|---|---|---|---|
| **D1** | **게이트 도입 = 자동배포 정지** | 미판정 미디어를 `검수 대기`로 두면(F2 Inv 준수) 프로덕션에서 돌고 있는 자동배포가 **즉시 전부 멈춘다**(`FACTORY_ENABLED=1`, `7e19883`). FLOWS 자신이 탈출구를 준다 — 규칙의 **게이트 정책** `승인 후 게시` / `권리 이슈 시 보류`(FLOWS.md:124). 후자면 "등록된 이슈 없음 → 진행". | 기본 정책을 어느 쪽으로 둘지. 권고: 신규 규칙 기본값 `승인 후 게시`, 기존 factory 잡은 마이그레이션 시 `권리 이슈 시 보류` 로 이관 |
| **D2** | **`/channels` 라우트 이름 충돌** | 설계의 `/channels` 는 "배포 채널"(README §10)인데 현재 `/channels` 는 YouTube 트렌드 분석이고 배포채널은 `/publish-channels` 다. 리네임을 U1 에서 처리하지 않으면 U7·U14 두 PR 이 서로 깨진다 | 리네임 대상: 현 `/channels` → `/channel-trends` 권고 |
| **D3** | **F9 를 서버에서 강제할 인증 기반이 없다** | 서버 전역 미들웨어가 logger + 전면허용 CORS 둘뿐(`index.ts:174-175`), users/roles 테이블 없음, 웹 세션은 목 하드코딩(`auth.tsx:16`). "모든 권한은 서버에서 재검사"(FLOWS.md:174)는 IdP 없이는 불가 | 어떤 인증을 쓸 것인가(Google Workspace? 자체?). 이게 정해지기 전엔 S3 이 못 움직이고, S3 에 물린 U1·U13·U14·U15 가 전부 멈춘다 |
| **D4** | 회차 번호 유니크 인덱스가 기존 데이터와 충돌할 수 있다 | 지금까지 MAX+1 자동 채번이라 이론상 중복이 없어야 하지만, 주석이 스스로 near-simultaneous 충돌 가능성을 인정한다(`index.ts:1467-1468`) | 마이그레이션 전 `SELECT programId, episodeNumber, count(*) … HAVING count(*)>1` 사전 조사 |
| **D5** | F5 "의도적으로 없는 기능" 2개가 이미 구현돼 있다 | 되돌리기(`editor-shell.tsx:19,108`)와 속도 램프(`editor-timeline.tsx:478`). 제거는 사용자 기능 회수다. **속도 램프는 최소한 UI 를 빼야 한다** — 서버가 무시해(`index.ts:2307-2312`) 프리뷰와 렌더가 어긋나는 현재 상태가 가장 나쁘다 | 되돌리기: 존치 예외로 둘지 제거할지 |
| **D6** | F8 에셋은 백엔드가 통째로 없다 | 폴더 CRUD·업로드·서빙·삭제 전부 신설(README.md:185). 다른 화면 PR 과 규모가 다르다 | 베타 범위에 넣을지. 메모리의 "영업 전 단계: 외부 데이터만으로 굴러가는 기능"과 대조 필요 |
| **D7** | 진행률·폴링 수치 불일치 | 명세는 97% 정지 + 2.6초 폴링(FLOWS.md:43). 현재는 서버 99% clamp(`content-pipeline.ts:983`)에 8/45/15초 적응형 폴링. **⊘ 규칙(클라 타이머로 100%)은 이미 지켜지고 있다** | 2.6초로 낮추면 DB 부하가 3배 이상. 값을 명세에 맞출지, ⊘ 만족으로 볼지 |
| **D8** | 프로그램 상태 3분류 도입 | 현재 `"archived"` 는 **도달 불가능한 죽은 값**(`index.ts:372` 하드코딩, PATCH 에 status 분기 없음 `:538-658`). `편성 예정`은 타입에도 없다 | 3분류 전이 규칙(누가 언제 종영 처리?) |
| **D9** | 설계에 대응이 없는 현행 화면 | `/business`, `/trends`, `/ops` (`/thumbnail-templates` 는 2026-08-13 폐기 완료) + `/highlights`, `/programs/[id]/highlights` | 존치/폐기. 특히 `/business` 의 "권리/승인 큐"(`business/page.tsx:404`)는 이름만 권리이고 실제로는 배포실패+19세+브랜드 파생 목록(`:142-172`)이라 U6 과 중복·혼동 |
| **D10** | factory ingest API 와 F6 규칙의 관계 | FLOWS.md:143 "규칙이 없으면 파이프라인은 아무것도 하지 않는다". 외부 소비자(AENA)의 `POST /api/factory/ingest` 는 사람이 명시적으로 부르는 것이라 "기본 동작"은 아니지만, 규칙을 우회하는 건 사실이다 | 규칙 우회 ingest 를 허용할지, 아니면 ingest 도 임시 규칙을 만들게 할지 |
| **D11** | 테스트가 프로덕션 이미지에 들어간다 | `apps/server/.dockerignore` 에 `*.test.ts` 없음. 지금은 2개지만 계획대로면 10개 이상 | S0 에서 한 줄 추가 |
| **D12** | `index.ts` 6036줄 | CLAUDE.md 는 라우트 분리를 금지한다. 이 계획은 **순수 헬퍼만** 빼므로 규칙과 충돌하지 않지만, S1b~S4 가 index.ts 를 크게 건드린다 — 병렬 세션 동시 편집 위험(메모리 `concurrent-editor-sessions`) | 서버 PR 은 직렬로. S 레인 병렬 금지 |
| **D13** | 미확인 | `docs/plans/active/*` 계획 문서 본문은 이 조사에서 열지 않았다. 기존 계획과 이 문서가 충돌할 수 있다 | 착수 전 `docs/plans/active/step-d-master-build-plan.md`·`factory-api-plan.md` 대조 |

---

## 8. 착수 순서 요약 (첫 5개 PR)

1. **S0** — 순수 함수 추출 + 아키텍처 테스트 심기(실패 상태). 동작 변경 0 이라 언제든 되돌릴 수 있다.
2. **S1b** — 게이트 도메인. FLOWS.md:199 가 "먼저 세우라"고 한 그것.
3. **S2** — 배포 4경로 수렴. §4.2 아키텍처 테스트가 초록으로 바뀌는 순간이 V6·V14 가 닫히는 순간이다.
4. **S1a + U4** — F1 위반 4건(V1~V4) 일괄 정리. 사용자에게 즉시 보이는 거짓말(V2)을 먼저 지운다.
5. **S3 + U1** — 역할·라우팅. D3 가 풀려야 움직인다.
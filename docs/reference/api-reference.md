# @stepd/server HTTP API 레퍼런스

> 실측: **2026-08-28 · 라우트 251개** (GET 111 · POST 94 · DELETE 25 · PATCH 14 · PUT 7) · `apps/server/src/index.ts` 기준 — 라우트 추가 시 이 문서도 갱신.
> 프론트 대응 함수는 `apps/web/src/lib/data/api.ts` 기준. 데이터 구조는 [data-model.md](data-model.md),
> 큐·워커 동작은 [../ops/worker-queue.md](../ops/worker-queue.md) 참고.

## 공통 사항

- 등록 라우트는 영역별로 관리한다: 헬스·상태 · **검색** · 콘텐츠(프로그램·업로드·미디어) · 캐스트 ·
  **썸네일 스타일** · 추천/클립/배포 · YouTube OAuth/채널/분석 · **Meta·TikTok OAuth** ·
  큐/파이프라인 · admin(운영·진단·파괴적) · Lab 검수 · Lab `match.*`.
- 모든 라우트는 `apps/server/src/index.ts` 한 파일에 등록된다 (작업 규칙: 분리 금지).
- `/api/*`에 CORS 허용 (origin 반사, credentials 없음).
- **인증 (2026-08-12 갱신 — 이전 판의 "라우트 자체 인증은 없다" 는 낡은 서술이었다).**
  모든 요청은 `resolveTenant` 를 지나며 세 경로 중 하나로 해석된다:
  ① `Authorization: Bearer <API 키>` → 그 키의 회사 + **라우트 화이트리스트**(`api-keys.ts`)
  ② 세션 쿠키(`stepd_session`) **또는 `x-stepd-session` 헤더** → 그 사용자의 회사
     (헤더는 쿠키 저장소가 없는 1인칭 클라이언트용 — 프리미어 UXP 패널. 검증은 같은
     `resolveSession`. 토큰은 로그인 때 `x-stepd-client` 를 보낸 호출자에게만 응답에 실린다)
  ③ 인증 없음 → **`AUTH_REQUIRED` 가 켜져 있으면 401**, 꺼져 있으면 기본 테넌트로 폴백
  프로덕션은 `AUTH_REQUIRED=1` 이다. 그 위에 Postgres **RLS** 가 테넌트 격리를 강제하고,
  발행은 운영 역할(`canPublish`), 파괴적 어드민 라우트는 `requireOpsAccess` 를 요구한다.
  ⚠️ 보안 서술이 실제보다 느슨하게 적히면 사람이 그걸 믿고 라우트를 연다 —
  `docs-drift.test.ts` 가 이 문단의 존재를 검사한다.
  Lab 매칭 쓰기(`POST/DELETE /api/lab/match*`)는 추가로 `LAB_WRITE_TOKEN`·`x-lab-token` 을 요구한다.
- 프론트의 `API_BASE`는 `NEXT_PUBLIC_API_URL`(없으면 `/api`). 스트림·썸네일 URL은
  `mediaUrl()` 헬퍼가 `API_BASE`를 붙여 조립한다.
- DB 초기화는 서버 기동과 비동기 — 기동 직후에는 `/health`의 `ok`가 `false`일 수 있다.

### 외부 API 키 (고객사 시스템 · 2026-08-12)

세션 없이 `Authorization: Bearer stepd_live_…` 로 부르는 경로가 있다 — 워크스페이스
API 키(`api-keys.ts`). **화이트리스트(`API_KEY_ROUTES`)에 올린 라우트만** 열리고,
스코프 6종(`media:write/read · search:read · factory:write/read · billing:read`)으로
쪼개진다. 발급·폐기는 superadmin 전용(admin 콘솔). 키 호출도 세션과 같은
`resolveTenant` → RLS 경로를 지나므로 데이터는 키가 속한 워크스페이스에 귀속된다.
`/api/factory/*` 는 익명 폴백이 막혀 있어 키 또는 세션 없이는 401 이다.
고객사 배포용 문서: [customer-api.md](customer-api.md).

## 헬스 · 상태

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /health` | 서버 생존 + DB/ffmpeg 준비 + **실업로드 게이트 상태** | → `{ ok: dbReady, ffmpeg, youtubeUpload }`. `youtubeUpload`는 비밀이 아니라 게이트 상태 — 배포된 리비전이 송출 불가임을 가장 빨리 확인하는 수단이고, 웹이 publish 액션을 숨기는 근거다 | (웹 미사용) |
| `GET /api/health` | `/health` 의 `/api` 별칭 — **웹 연결 표시등 전용** | 웹은 `API_BASE`(프로덕션 `/api/proxy/api`) 뒤에 붙여 부르므로 `/api` 밖의 `/health` 를 못 쓴다 | 사이드바 `ConnectionStatus` |
| `GET /api/programs/:id/image/:kind` | 프로그램 포스터·쇼츠 아이콘을 **바이트로** 서빙 (`kind`=`poster`\|`icon`) | 저장은 그대로 base64 · `/api/state` 는 이 필드를 빼고 `hasPosterImage`·`hasBrandIcon` 만 보낸다 | `programImageUrl` |
| `GET /api/state` | 웹 InitialData 전체 (엔티티 + 미디어) | → `{ programs, episodes, recommendations, clips, jobs, connections, media }` | `fetchState` |

> ⚠️ **`/api/state` 는 무겁다 — 실측 평균 11 MB/회**(2026-08-31 · 클립마다 `editorState` 가
> 실리고 그 안에 배경·아이콘이 base64 로 들어 있다). **상태 확인용으로 부르지 말 것.**
> 사이드바가 연결 표시등을 그리려고 이걸 8초마다 불러서, 탭 하나당 시간당 ~5 GB 가
> Cloud Run → Vercel 함수로 흘렀다(3시간 34.5 GB · 3,105회). 프로덕션 웹은 `/api/proxy` 를
> 거치므로 그게 전부 Vercel **Fast Origin Transfer** 로 청구된다. 연결 확인은 `/api/health`.
>
> **2026-08-31 슬림화 3종** — 응답에서 빼는 것들(저장은 그대로다):
> ① `job` 목록 상한 200(영구 누적이라 안 막으면 시간에 비례해 자란다)
> ② 클립 `editorState.channelIconDataUrl` 중 **프로그램 brandIcon 과 같은 복사본**
>   (ENA 실측 17.7 MB — 이미지 2개가 클립 51개에 복사돼 있었다)
> ③ 프로그램 `posterImageDataUrl`·`brandIconDataUrl`(ENA 실측 1.33 MB) → 위 image 라우트로
> 결과: ENA 기준 **19.4 MB → 약 0.4 MB**. `castPhotos` 는 아직 남아 있다(설정 화면 얽힘).

## 검색 — 자연어 영상 검색 (`search_segments` · pgvector)

제품의 목적물. 회차당 200여 개 세그먼트를 인덱싱해 두고 자연어로 질의한다.
**하이브리드** — `q`를 pg_trgm 키워드 축과 Vertex 쿼리 임베딩(768d) 코사인 축으로 동시에 때린다.
임베딩 실패 시 `embedded:false`로 **키워드 단독 폴백** (한국어는 키워드 매칭이 강해 검색이 성립).

**LLM 쿼리 파서**가 `q`를 `{인물·장면유형·방영기간·쇼츠·semantic}`으로 분해한다. 인물 후보(roster)는
해당 프로그램 세그먼트에서 뽑아 넘겨 **환각을 막고**, 파싱 실패 시 룰 폴백한다.
**명시 쿼리 파라미터가 파서 결과보다 우선한다.**

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/search` | 세그먼트 검색 | 쿼리 `q` · 필터 `program, scope_type, scope_id, episode, aired_from, aired_to, character(쉼표구분), scene_type, is_short, allow_spoiler, top_k`(기본 20) → `{ query, queryId, parsed:{…, charactersUsed, embedded}, results:[{ rank, segment_id, score, lex, vec, rightsStatus, … }] }`. 실패 시 500 `{ error, results: [] }` | `searchSegments` |
| `POST /api/search/log` | 검색 이벤트 로깅 (평가·학습 신호) | → 202 `{ ok:true }`. 허용 외 `event`면 400 | `logSearchEvent` |
| `GET /api/search/log` | 로그 열람 — 평가·학습 추출용(운영 진단) | 쿼리 `event, limit`. 기본은 `boundary_adjust` 제외 전체 최신순 → `{ events }` | (웹 미사용) |

**권리·스포일러는 SQL에서 걸러진다.** 걸러지지 않고 남은 상태는 카드 주석(`rightsStatus`)으로 붙는다 —
`spoiler`(⚠️ 스포일러) · `cast_ok`(출연자 권리 확인필요) · `music_cleared`(⚠️ 음원 미클리어 / 확인필요) ·
`ppl`(협찬/PPL 구간). `allow_spoiler=true`를 명시해야 스포일러 구간이 결과에 들어온다.

## 콘텐츠 — 프로그램 · 업로드 · 미디어

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/programs` | 프로그램 생성 (업로드 전 필수 콘텐츠 루트) | `{ title(필수), section, targetAge, cast, programCode, category, weekdays }` → `{ program }`. SMR 필드는 `smr` 블롭으로 저장 | `createProgram` |
| `GET /api/programs` | 프로그램 목록 (id·제목·상태만) | → `{ programs: [{ id, title, status }] }`. 드롭다운 하나 채우면 되는 클라이언트(프리미어 패널)용 — `/api/state` 전체를 받지 않게 | (웹은 `fetchState` 사용) |
| `GET /api/programs/:id` | 프로그램 1개 (이해 프로필 포함) | → `{ program }` / 404 | (`fetchState`로 대체) |
| `PATCH /api/programs/:id` | 부분 병합 수정 — **body에 있는 필드만** 바뀐다 | `{ title, section, targetAge, cast, castPhotos, category, weekdays, programCode, moods, pipelineGenre, posterImageDataUrl }` → `{ program }` | `updateProgram` |
| `POST /api/programs/:id/autofill` | 제목만으로 나머지 필드 자동 채움 (Gemini + google_search 그라운딩, 2단계: 검색·수집 → 팩트체크) | → `{ draft }`. **저장하지 않는다** — 사용자가 UI에서 확인 후 저장. 출연자·SMR은 안 채움. 실패 502 | `autofillProgram` |
| `POST /api/programs/:id/autofill/chat` | 대화형 자동 채움 (stateless · history 전체를 클라이언트가 전송) | `{ history, draft, sources }` → `{ message, action, draft }`. **[사용 안 함 · 참고용]** | (웹 미사용) |
| `POST /api/programs/profile/generate` | 이해 프로필 생성 — `mode: direct`(프로그램명/장르/설명) · `websearch`(프로그램명→웹검색+sources) · `planning`(기획정보) | `{ mode, input(필수) }` → `{ mode, profile }`. 정규화만 하고 저장은 안 한다 · 실패 502 | (웹 미사용) |
| `PATCH /api/programs/:id/profile` | 이해 프로필 설정/교체 | `{ profile }` → `{ program }` | (웹 미사용) |
| `POST /api/programs/:id/sync-from-analysis` | 얼굴 분석 → program 수동 sync | `{ mediaId? }`(생략 시 최근 분석 media 자동 선택) → `{ mediaId, workDirExists, addedNames, addedPhotos }`. 워커 python이 native cleanup crash로 자동 sync에 도달 못 한 경우의 **우회 트리거** | `syncProgramFromAnalysis` |
| `POST /api/media/from-youtube` | YouTube URL → 다운로드 잡 큐잉 → 회차·미디어 생성 | `{ url(필수), programId, title, fast }` → `{ ok, queued, … }`. URL 부적합 400 | `importYoutubeVideo` |
| `POST /api/media/upload-init` | 대용량 업로드 1단계: GCS resumable 세션 발급 | `{ programId, filename, contentType }` → `{ mode:"resumable", mediaId, objectPath, sessionUrl }`. **GCS 미설정(로컬)이면 `mode:"multipart"`** — 클라이언트가 `/upload`로 폴백 | `uploadVideo` |
| `POST /api/media/finalize` | 대용량 업로드 2단계: 서울 스테이징에 올라간 파일로 회차·마스터 placeholder 생성 + `media.prepare` 인큐 | `{ mediaId, objectPath(필수), programId, title, filename, contentType, size }` → **202** `{ media, episode, recommendations:[], queued:true }`. 운영 버킷 이동·probe·썸네일·분석은 워커가 비동기 처리. AENA는 반환된 `media.id`로 즉시 factory ingest 가능 | `uploadVideo` |
| `POST /api/media/upload` | (레거시) multipart 단일 요청 업로드 — 로컬 dev용 | FormData `file(필수), programId, title` → finalize와 동일 응답. Cloud Run ~32 MB 요청 캡 대상 | `uploadVideo` (로컬 폴백) |
| `POST /api/media/clip-finalize` | **완성 영상 직접 업로드**(GCS 2단계) — 회차·분석 없이 배포 가능한 클립 생성 | upload-init 이 준 `{mediaId, objectPath, programId, title, episodeNumber?, editKind?}` → `{ clip, media }`. `episodeNumber`는 기록되고 같은 번호의 회차가 있으면 연결, `editKind`=`shorts\|clip\|highlight`. rendered=true·mediaId 세팅으로 배포 흐름에 바로 얹힌다(파일 자체가 산출물) | `uploadFinishedClip` |
| `POST /api/media/clip-upload` | 완성 영상 직접 업로드(로컬 multipart 폴백) | FormData `file(필수), programId, title, episodeNumber?, editKind?` → clip-finalize 와 동일 응답 | `uploadFinishedClip` (로컬 폴백) |
| `GET /api/media/:id/stream` | 영상 스트리밍 | HTTP Range. Range 없어도 **항상 206 + 최대 4 MB 청크**(프록시 500 방지) | `mediaUrl`로 URL 조립 |
| `GET /api/media/:id/thumb` | 썸네일 JPEG | 200 / 404 | `mediaUrl`로 URL 조립 |
| `GET /api/media/:id/analysis` | AI 콘텐츠 분석 결과 (STT·씬·쇼츠) | → `{ status: pending\|done\|failed, data, error }`, 없으면 404 `{status:"none"}`. `data`에 `genre`(감지 장르)·`framesBase`(프레임 저장 경로) 추가, 실패 시엔 완료된 단계까지의 부분 결과(`data.partial=true` + transcript/scenes)가 담길 수 있다 | `getMediaAnalysis` |
| `GET /api/media/:id/analysis/frames/:name` | 워커가 영구 저장한 씬 대표 프레임 JPEG | `:name`은 `scene_NNNN.jpg` 형식만 허용. 저장 위치 `analysis/{mediaId}/scene_frames/`. 프레임 저장 이전 분석이면 404 | (직접 URL 조립) |
| `GET /api/media/:id/stream-url` | **서명 재생 URL** — 브라우저가 `<video src>`에 걸면 GCS에서 바로 스트리밍 | → `{ url, direct:true }`. 바이트 경로에 프록시·리다이렉트가 없어서 이게 미디어 서빙의 신뢰 경로다. 로컬 모드면 `{ url:"/media/…" }` | `getStreamUrl` |
| `GET /api/media/:id/frame` | 임의 시각 정지 프레임 (쇼츠·씬 카드 미리보기) | 쿼리 `t`(초, 소수 2자리로 반올림해 캐시 키) → JPEG. 캐시 히트면 즉시, 미스면 ffmpeg `-ss t -vframes 1`로 뽑아 `analysis/{id}/frames/{t}.jpg`에 저장 후 서빙. ffmpeg 없으면 503 | `frameUrl` |
| `POST /api/media/:id/analyze` | **분석 재실행** (실패한 런에서 운영자가 복구) | `{ fast? }` → `{ ok, queued }`. 체크포인트에서 재개하므로 **끝나지 않은 단계만 다시 과금**된다 | `reanalyzeMedia` |
| `GET /api/media/:id/transcript` | 자막 (공유 STT 저장소 — 캡션·프레이밍·하이라이트가 여기서 읽는다) | → `{ mediaId, source, updatedAt, segments }` / 404 `{ status:"none" }`. 정규 transcript 테이블 우선, 구식 행은 analysis 블롭 폴백 | (직접 호출) |
| `DELETE /api/media/:id` | 미디어 삭제 | → `{ ok, mediaId }` / 404 | (웹 미사용) |
| `DELETE /api/episodes/:id` | 회차 삭제 (딸린 미디어 동반) | → `{ ok, episodeId, mediaDeleted }` | `deleteEpisode` |
| `DELETE /api/programs/:id` | 프로그램 삭제 (회차·미디어 캐스케이드) | → `{ ok, programId, episodesDeleted, mediaDeleted }` | `deleteProgram` |

### 부가 산출물 — 얼굴 · PPL

`analysis.json`에도 들어가지만, **분석이 안 끝나도 부분 결과를 폴링**할 수 있게 별도 라우트로 뺐다.
`:id`는 media id 형식 검증(400), 파일명은 경로탈출 가드를 통과해야 한다.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/media/:id/faces` | `faces.json` — 얼굴 클러스터 메타(라벨·카운트·성별·대표 크롭 경로·매핑) | → `{ clusters, … }` | `getMediaFaces` |
| `GET /api/media/:id/analysis/faces/:name` | 얼굴 클러스터 대표 크롭 JPEG | `:name`은 `M1_0.jpg` / `F2_2.jpg` 형식(성별 M\|F + 클러스터 번호 + 대표 인덱스)만 | `faceCropUrl` |
| `PATCH /api/media/:id/faces/mapping` | **익명 화자/얼굴 클러스터에 이름 지정.** 자동 추론 없음 — 운영자가 등록 cast를 고르거나 직접 입력한 이름만 `faces.json.mapping`에 보존 | `{ mapping(객체, 필수) }` → `{ ok, mapping, refined_rewritten, narrative_rewritten, shorts_rewritten, db_content_analysis_updated, db_recommendations_renamed }` — 이름을 바꾸면 **산출물 전체를 되짚어 rewrite** 한다 | `patchMediaFacesMapping` |
| `GET /api/media/:id/ppl` | `ppl.json` — PPL·브랜드 검출 타임라인(구간·브랜드·카테고리·대표 프레임·요약) | → `{ detections, brand_summary }` | `getMediaPpl` |
| `GET /api/media/:id/analysis/ppl_frames/:name` | PPL 구간 대표 프레임 JPEG | `:name`은 브랜드 sanitize + zero-pad 인덱스 (`CJ_00012.jpg`) | `pplFrameUrl` |

> ⚠️ **PPL·faces는 파이프라인 기본 off** (`RUN_PPL=1` / `RUN_FACES=1`로만 켜진다).
> 끈 상태로 분석한 회차는 이 라우트들이 빈 결과를 돌려준다 — "버그"가 아니라 스위치다.

## 캐스트 — 출연자 레지스트리 · 회차 등장 타임라인

프로그램별 출연자를 등록해 두면, 파이프라인이 **화면에 박힌 이름표(lower-third) OCR**을 이 레지스트리에
매칭해 회차별 "출연자 × 등장 구간" 타임라인을 만든다(`core/cast.py`). **얼굴 인식이 아니다** — 근거는
이름 자막 + 등장 구간이며, 확정(`confirmed`)은 오직 운영자만 할 수 있다(파이프라인은 `matched`/`candidate`까지).
레지스트리가 비어 있으면 무동작 — 잡힌 이름은 전부 `candidate`로 남는다.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/programs/:id/cast` | 프로그램 출연자 레지스트리 조회 | → `{ cast: [{ castId, name, aliases, role, season, note }] }` |
| `POST /api/programs/:id/cast` | 출연자 등록 | `{ name(필수), aliases, role, season, note }` → 201 `{ member }`. 같은 (프로그램+이름+기수) 중복은 409 |
| `PATCH /api/programs/:id/cast/:castId` | 출연자 수정 (부분 병합 — 생략 필드는 보존) | → `{ member }` |
| `DELETE /api/programs/:id/cast/:castId` | 출연자 삭제 | → `{ ok, castId }`. **과거 회차의 등장 기록(근거)은 남고 링크만 끊긴다** |
| `GET /api/media/:id/cast` | 회차 출연자 타임라인 | → `{ mediaId, people: [{ name, castId, status, matchType, confidence, sceneCount, totalSec, evidence, appearances:[{start,end,scenes,source}] }], matchedCount, candidateCount }` |
| `POST /api/media/:id/cast/:name/status` | 운영자 판정 (확정/거절/재링크) | `{ status: confirmed\|rejected\|candidate\|matched, castId? }` → `{ person }`. **`confirmed`로 가는 유일한 경로** |
| `POST /api/media/:id/cast/:name/register` | 미등록 후보 → 레지스트리 등록 + 링크 + 확정 (원스텝 온보딩) | `{ role?, season?, aliases? }` → 201 `{ member, person }`. 잡힌 이름은 alias로 보존돼 다음 회차부터 자동 매칭 |

> 재분석은 기계 산출 컬럼만 덮어쓴다 — 운영자의 `confirmed`/`rejected`와 그 링크(`castId`)는 보존된다
> (`db-pg.ts saveEpisodeCast`). 추천 보드가 DELETE+INSERT로 과거 라벨을 잃는 것과 대비되는 지점.

### 업로드 시퀀스 (프로덕션 = GCS 직접 전송)

```
브라우저                      Cloud Run(@stepd/server)              GCS            워커 VM
   │ POST /api/media/upload-init ──▶ resumable 세션 생성 ──────────▶ │
   │ ◀── { mediaId, objectPath, sessionUrl }                        │
   │ PUT 16 MiB 청크 × N (Content-Range, 308 반복) ────────────────▶ │
   │ POST /api/media/finalize ──▶ 회차+미디어 생성, 서명 URL로 probe/썸네일,
   │                              content.analyze 인큐 (dedupe: content.analyze:<mediaId>)
   │ ◀── { media, episode, recommendations: [] }                          … content.analyze 실행
   │        (추천 보드는 비어 있음 — 워커가 채우면 회차 pipeline 상태 갱신) ◀──┘
```

파일이 Cloud Run을 거치지 않으므로 32 MB 요청 캡·타임아웃이 적용되지 않는다. 실제 추천
구간은 워커의 `content.analyze` 잡이 채운다 ([../ops/pipeline-current.md](../ops/pipeline-current-state.md)).
청크 전송·재개 로직은 `api.ts`의 `uploadResumable()` 참고.

## 썸네일 — 스타일 프로파일 · 생성

썸네일은 **사진 몇 장 + 한국어 한 줄 + 채널 스타일 프로파일**로 만든다. 프로그램별로 채널
썸네일을 수집·Vision 분석해 스타일 프로파일을 학습하고, 생성 프롬프트에 얹는 구조다.
(구 `thumbnail-refs` 레퍼런스 풀 9개 라우트는 **2026-08-13 삭제** — swap 접근 폐기.
정책의 근거는 이제 프로그램 스타일 프로파일 하나다.)

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/programs/:id/thumbnail-style` | 프로그램 스타일 프로파일 **학습** (프로그램당 1회성 — 톤이 바뀌면 재실행) | `{ sourceUrl(필수) }` → `{ ok, jobId }`(`thumbnail.style` 잡). **재생목록 URL을 권한다** — 큰 채널은 프로그램·기수를 재생목록으로 나눠 담아서, 채널 전체로 학습하면 여러 프로그램 톤이 섞인다 | `trainThumbnailStyle` |
| `GET /api/programs/:id/thumbnail-style` | 학습된 스타일 프로파일 조회 | → `{ programId, title, aggregate, prompt, refs, thumbs }`. `refs`=전형으로 뽑힌 대표 2장, `thumbs`=수집 썸네일 전체 파일명. 없으면 404 `not_trained` (먼저 학습을 돌려야 한다) | `fetchThumbnailStyle` |
| `GET /api/programs/:id/thumbnail-style/thumbs/:name` | 수집 썸네일 이미지 서빙 (`refs`·`thumbs`의 파일명) | → 이미지. 없으면 404 | `thumbnailStyleImageUrl` |
| `POST /api/media/:id/thumbnail` | 회차 → 썸네일 후보 생성 | `{ programId(필수) }` → `{ ok, jobId }`(`thumbnail.generate` 잡). **인물이 등록 안 됐으면 워커가 실패로 남긴다** | `generateThumbnail` |

### 출연자 사진 — 사람이 등록한다

얼굴 identity를 지키려면 AI 재생성이 아니라 **등록된 실제 사진**을 써야 한다. 자동 판정은 없다.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/programs/:id/cast-photos` | 등록된 출연자 목록 + 사진 수 | → `{ cast: [{ name, photos }] }` | `fetchCastPhotos` |
| `POST /api/programs/:id/cast-photos` | 사진 등록 (multipart `name` + `file`) | → `{ ok, name, path, bytes }`. 이름에 경로 문자 금지 400 · jpg·png·webp만 400 | `uploadCastPhoto` |
| `DELETE /api/programs/:id/cast-photos/:name` | 출연자 사진 삭제 | → `{ ok }` | `deleteCastPhotos` |

## 추천 · 클립 · 배포

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/recommendations` | 추천 목록 (구간·점수 + 프레임 정합 메타) | 쿼리 `programId, status`(기본 `pending` · `all` 가능), `limit`(기본 50·최대 200) → `{ recommendations: [{ id, title, startTime, endTime, score100, status, people, episodeId, episodeNumber, programId, programTitle, mediaId, fps, startTimecode }] }`. 점수 내림차순. **`startTime/endTime` 은 원본 파일 0초 기준 초** — Premiere·EDL(소스 타임코드 기준)로 넘기려면 같이 오는 `fps`·`startTimecode` 로 환산한다. 0046 이전 원본은 그 둘이 0/"" 이라 환산 불가(숨기지 않고 그대로 내보낸다) | (프리미어 패널 · 웹은 `fetchState`) |
| `POST /api/premiere/handoff` | **웹 → 프리미어 핸드오프**(맥락 남기기) | `{ programId?, episodeId?, clipId?, mediaId?, label? }`(하나는 필수, 없으면 400) → `{ ok:true }`. 사용자별 1건만 보관 | `openInPremiere` |
| `GET /api/premiere/handoff` | 프리미어 패널이 집어간다 (5초 폴링) | → `{ handoff }` / `{ handoff:null }`. **읽으면 지운다**(한 번만 소비) · 5분 지난 건 버린다. ⚠️ 브라우저가 UXP 패널에 값을 직접 넘길 수 없어서 서버를 경유한다 — 실행은 `stepd://` 스킴이 맡는다 | (프리미어 패널) |
| `POST /api/recommendations/:id/adopt` | 추천 채택 → ffmpeg 트림·인코딩으로 실제 클립 생성 | → `{ clipId, clip }`. 마스터 미디어+ffmpeg 있으면 실 인코딩(GCS는 서명 URL로 구간만 fetch), 없으면 메타데이터만 | `adoptRec` |
| `POST /api/recommendations/:id/reject` | 추천 거절 | `{ reason }` (기본 "기타") → `{ ok }` | `rejectRec` |
| `PATCH /api/recommendations/:id/thumbnail` | 생성된 썸네일 변형 중 하나를 선택 | `{ variantId(필수) }` → `{ recommendation }`. **정확히 하나만** chosen으로 마킹돼서, 이후 채택이 안정적·영속적인 결정을 갖는다 | `selectRecommendationThumbnail` |
| `GET /api/clips/:id/reframe` | 동적 9:16 리프레임 상태 조회. 입력 구간/원본이 바뀌면 `stale`을 보고하며 자동 큐잉하지 않는다 | → `{ clipId, reframe }`. 상태 `idle/queued/running/ready/stale/failed`; plan 시간은 마스터 절대 초, 추적 좌표는 0..1 | `getClipReframe` |
| `POST /api/clips/:id/reframe` | 기본 Fit 또는 AI Beat별 Fit/Fill 모드 선택·분석 큐잉 | `{ mode:"basic"|"ai_multi", retry? }` → `{ clipId, reframe, reused, queued }`. 동일 입력 ready/진행 중 요청은 재사용하며 실패 재시도는 `retry:true` 필요 | `requestClipReframe` |
| `POST /api/clips/:id/reframe/candidates` | 세로 4택 비교 잡(reframe.compare) 큐잉 — 정식 reframe 상태와 분리 | → `{ compareId, status, reused }`. compareId=입력 지문이라 같은 트림·beat 면 기존 산출물 재사용(멱등) | `createReframeCompare` |
| `GET /api/clips/:id/reframe/candidates/:compareId` | 비교 상태·산출물 조회 | ready 면 manifest+후보 4종 plan+스트리밍 URL, 아니면 큐 잡 상태 반영 | `fetchReframeCompare` |
| `GET /api/clips/:id/reframe/candidates/:compareId/file/:name` | 비교 산출물 스트리밍(프록시·contact sheet) | 파일명 화이트리스트만 — 경로 탈출 차단. 불변 산출물이라 1시간 캐시 | `reframeCompareFileUrl` |
| `POST /api/clips/:id/reframe/labels` | 비교 뷰어의 "이 장면은 이 레이아웃" 1클릭 정답 라벨 append | `{ compareId, chosen, machine?, beatId?, segStart?, segEnd?, atSec?, context?, note? }` → `{ ok }`. chosen 은 4레이아웃 화이트리스트 | `saveReframeLabel` |
| `GET /api/clips/:id/reframe/labels` | 이 클립·비교의 라벨 목록 (뷰어 진행 표시) | `?compareId=` → `{ rows }` (테넌트 명시 필터) | `fetchReframeLabels` |
| `POST /api/clips/:id/export` | **클립 렌더 — ffmpeg가 결과물을 굽는 유일한 지점** | `{ channel? }` → `{ clipId, clip, cached, preset, capped, hookPreroll }`. AI 모드는 현재 입력과 일치하는 ready plan 없이는 `409 reframe_not_ready`; revision에 모드·plan hash가 포함된다 | `exportClip` |
| `POST /api/clips/:id/regenerate-titles` | 제목 후보 재생성 — 사용자 추가 지시 반영 | `{ prompt }`(예: "더 자극적으로", "이모지 넣지 마") → 후보 4~5개. **저장하지 않는다**(에디터 세션 로컬). 클립에 자막 없으면 409 | `regenerateTitles` |
| `POST /api/clips/:id/generate-metadata` | 업로드용 title/description/tags를 자막 근거로 생성 | → 메타데이터 객체. **저장 X** — 프론트가 `state.uploadMeta`에 얹는다. 자막 없으면 409 | `generateUploadMetadata` |
| `POST /api/distributions/publish` | 배포 요청 | `{ clipIds(배열, 필수), channel(필수), reserveDate?, scheduled?, platforms? }` → `{ ok }` · 누락 400 `bad_request`. **`channel:"youtube"`는 실업로드 잡(`distribution.publish`)을 큐잉한다.** 게이트 OFF면 **어떤 부작용도 내기 전에** 409 `{ error:"upload_disabled" }` — distribution 상태를 손대지 않는다. 업로드할 채널이 없으면 409 `no_publish_channel`. Meta·SMR은 여전히 상태 기록만 | `publishClips` |
| `POST /api/distributions/retry` | 실패 배포 재시도 | `{ clipId, channel }` → `{ ok }` | `retryDist` |
| `PATCH /api/clips/:id/link-video` | 클립 ↔ 게시된 YouTube videoId 수동 연결 (성과 조인) | `{ videoId }` (null/""면 해제) → `{ ok, clipId, publishedVideoId, videoKnown }` | (웹 미사용) |
| `PATCH /api/clips/:id/editor` | 에디터 결정 블롭(EditorState) 저장 — 메타데이터만, 렌더 없음 | `{ editorState(필수, 객체) }` → `{ ok, clipId }` | `saveClipEditor` |

## YouTube — OAuth · 채널 관리

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/youtube/auth` | Google OAuth 동의 화면으로 리다이렉트 | 쿼리 `mode=analytics\|publish`(기본 analytics), `channel`(채널 URL 메모), `return`(완료 후 이동할 same-site 경로, 기본 `/register`) | `getYouTubeAuthUrl` (URL 조립) |
| `GET /api/youtube/callback` | OAuth 콜백: 토큰 교환 → 채널 upsert → 인라인 채널 분석 + `channel.analyze` 인큐 → `return`으로 리다이렉트 | GCP에 등록된 경로 | (브라우저 리다이렉트) |
| `GET /api/youtube/channels` | 연동 채널 목록 | → `{ channels: [{ channelId, channelName, subscribers, status, lastSyncedAt, lastAnalyzedAt, hasMonetaryScope, lastError, … }] }` | `fetchYouTubeChannels` |
| `DELETE /api/youtube/channels/:channelId` | 채널 연동 해제 | → `{ ok }` | `deleteYouTubeChannel` |
| `POST /api/youtube/refresh` | 액세스 토큰 강제 갱신 | `{ channelId }` → `{ ok, expiresAt }`. 리프레시 토큰 무효 시 **409 `revoked`** + 채널 상태 `revoked` | (웹 미사용) |

**mode별 스코프 세트** — `analytics`는 외부 크리에이터 채널의 지표 열람용 **읽기 전용**
(`youtube.readonly` + `yt-analytics.readonly` + `yt-analytics-monetary.readonly`),
`publish`는 자사 채널 업로드용 쓰기 권한(`youtube` + `youtube.force-ssl` +
`youtube.channel-memberships.creator`). 파트너에게 publish 링크를 보내지 말 것 —
유출 시 쓰기 토큰이 DB에 남는다. 상세: [../ops/youtube-channel-analytics-guide.md](../ops/youtube-channel-analytics-guide.md).

## YouTube — 분석 · 영상 · 트렌드

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/youtube/analytics/:channelId` | YouTube Analytics API 라이브 조회 (기본: 최근 90일 일별) | 쿼리 `start, end, dimensions, metrics, sort, maxResults` → `{ channelId, channelName, columns, rows }`. analytics 스코프 없는 구식 연동이면 **409 `channel_needs_reconsent`** | `fetchChannelAnalytics` |
| `GET /api/youtube/analytics/:channelId/daily` | 워커가 적재한 일별 지표 (자체 DB, YouTube 호출 없음) | 쿼리 `days`(기본 90) → `{ channelId, days, rows }` | `fetchChannelDaily` |
| `POST /api/youtube/sync/:channelId` | 업로드 영상 동기화 + 스냅샷 + 쇼츠 판별(프로브) | → `{ ok, videoCount, inserted, updated, shortsClassified, shortsPending }` | `syncChannelVideos` |
| `GET /api/youtube/videos/:channelId` | 동기화된 채널 영상 목록 | → `{ channelId, channelName, videoCount, videos }` | `fetchChannelVideos` |
| `GET /api/youtube/trends/:channelId` | 채널 조회수 트렌드 + 요약 | 쿼리 `days`(1~90, 기본 30) → `{ trend, summary }` | `fetchChannelTrends` |
| `GET /api/youtube/trends/video/:videoId` | 영상 1개의 일별 조회/좋아요/댓글 추이 (스냅샷 기반) | → `{ video, trend }` | `fetchVideoTrend` |
| `GET /api/youtube/videos/:videoId/analytics` | 영상 1개 종합 지표 (video.analyze/comments 잡 결과, 자체 DB) | → `{ video, summary, trafficSources, demographics, retention, comments, fetchedAt }`. 빈 섹션 = 잡 미실행 또는 데이터 없음 | `fetchVideoAnalytics` |
| `POST /api/youtube/videos/:videoId/comments/refresh` | **영상 1개 댓글 온디맨드 수집** (나이 무관) | → `{ queued:true, jobId, alreadyPending }`. 스케줄 fan-out은 `FRESH_VIDEO_WINDOW_MS` 이내 업로드만 `video.comments`를 큐잉해서, 오래된 영상은 **운영자가 여기서 요청해야만** 댓글이 붙는다. 큐잉만 함(Cloud Run은 YouTube를 부르지 않는다) — 결과는 `/analytics`로 폴링. dedupeKey가 연타를 흡수 | `refreshVideoComments` |
| `DELETE /api/youtube/videos/:videoId` | 추적 영상 삭제 | → `{ ok }` | `deleteTrackedVideo` |
| `GET /api/youtube/popular` | 지역·카테고리별 인기 영상 (트렌드 탐색) | 쿼리 `regionCode, categoryId, maxResults` → `{ regionCode, categoryId, count, videos, fetchedAt }`. `YOUTUBE_API_KEY` 또는 등록 채널 최소 1개 필요 — 없으면 `no_auth` | `fetchTrendingVideos` |
| `GET /api/youtube/video-categories` | 지역별 영상 카테고리 목록 | 쿼리 `regionCode` → `{ regionCode, categories }` · `no_auth` 400 | `fetchVideoCategories` |

동작 세부:

- `sync`의 조회수 스냅샷(`video_stats`)은 영상당 **1시간에 1회**만 적재된다 (마지막
  스냅샷이 1시간 이내면 건너뜀).
- 쇼츠 판별은 `youtube.com/shorts/<id>` 프로브 방식 — 동기화 1회당 프로브 상한과 동시성은
  `config.ts`의 `SHORTS_PROBE_MAX_PER_SYNC` / `SHORTS_PROBE_CONCURRENCY`로 제한되고,
  판별 결과는 영상별로 캐시된다 (`shortsPending`이 남은 미판별 수).
- OAuth 콜백은 가벼운 채널 분석(`runChannelPipeline`)을 응답 전에 **인라인 실행**하고,
  무거운 영상별 분석은 `channel.analyze` 잡으로 워커에 넘긴다.

## Meta · TikTok — OAuth 계정 연결

배포처 계정 연결까지만 구현돼 있다. **Meta·TikTok 송출은 아직 상태 기록만**이다. 실업로드
경로가 있는 건 YouTube(게이트 OFF)와 네이버 클립(아래) 둘뿐이다.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/meta/auth` | Meta OAuth — 동의 화면 리다이렉트 **겸 콜백** (`code` 유무로 분기) | 쿼리 `return`(완료 후 이동 경로) · 콜백 시 `code, state, error, rerequest`. `META_APP_ID` 미설정 500 · `code` 누락 400 | `getMetaAuthUrl` |
| `GET /api/meta/accounts` | 연결된 Meta 계정 목록 | → `{ accounts }` | `fetchMetaAccounts` |
| `DELETE /api/meta/accounts/:publicId` | 계정 연결 해제 | → `{ ok }` | `deleteMetaAccount` |
| `GET /api/instagram/auth` | Instagram 비즈니스 로그인(FB Page 경유 아님) — 동의 화면 리다이렉트 | 쿼리 `return`. `INSTAGRAM_APP_ID` 미설정 500 | `getInstagramAuthUrl` |
| `GET /api/instagram/oauth/callback` | IG OAuth 콜백 — 토큰 교환(장기 ~60일)·프로필 저장 | `code, state, error` | — |
| `GET /api/instagram/accounts` | 연결된 Instagram 계정 목록 | → `{ accounts }` (`expiresAt` 로 만료 표시) | `fetchInstagramAccounts` |
| `POST /api/instagram/accounts/:publicId/disconnect` | 연동해제 — 토큰만 비움 | → `{ ok, status }` | `disconnectInstagramAccount` |
| `DELETE /api/instagram/accounts/:publicId` | 계정 삭제 | → `{ ok }` | `deleteInstagramAccount` |
| `GET /api/tiktok/auth` | TikTok OAuth — 동의 화면 리다이렉트 겸 콜백 | 쿼리 `return` · 콜백 `code, state, error`. `TIKTOK_CLIENT_KEY` 미설정 500 | `getTikTokAuthUrl` |
| `GET /api/tiktok/accounts` | 연결된 TikTok 계정 목록 | → `{ accounts }` | `fetchTikTokAccounts` |
| `DELETE /api/tiktok/accounts/:publicId` | 계정 연결 해제 | → `{ ok }` | `deleteTikTokAccount` |

> TikTok 연동 3대 함정: 미승인 앱은 **sandbox 자격증명**을 써야 하고, `username` 필드를 스코프에
> 넣으면 스코프 전체가 깨지며, 시크릿은 v1=prod / v2=sandbox로 갈린다.

## 네이버 클립 — 계정 · 세션 · 자격증명 · 카테고리

네이버는 **공개 업로드 API 가 없다.** 그래서 사무실 상시 PC(윈도우2)의 `naver` 레인 워커가
로그인 세션으로 브라우저를 몰아 실제로 올린다 — 해외 데이터센터 IP 로 로그인하면 캡차·2차
인증에 막히기 때문에 한국 IP 가 필요하다. 서버가 하는 일은 **보관과 메타뿐**이다.

⚠️ **세션(`session_blob`)과 자격증명(`cred_blob`)은 어떤 응답에도 실리지 않는다.** 바깥으로
나가는 건 "있다/없다 + 상태 + 갱신시각" 뿐이다. 둘은 **서로 다른 키**로 봉인된다
(`NAVER_SESSION_KEY` ≠ `NAVER_CRED_KEY`) — 한쪽이 새도 다른 쪽은 안 열린다.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/naver/categories` | 클립 카테고리 분류표 (1차 40 · 2차 144) | → `{ categories, source }`. 화면이 **자유입력 대신 드롭다운**을 그리는 근거 | `fetchNaverCategories` |
| `GET /api/naver/accounts` | 계정 목록 | → `{ accounts, sessionStoreReady }`. 계정마다 `hasSession`·`status`·`loginCommand` | `fetchNaverAccounts` |
| `POST /api/naver/accounts` | 계정 등록 (label·target) | 매니저 권한 | `createNaverAccount` |
| `PATCH /api/naver/accounts/:id` | 라벨·상태 수정 | 매니저 권한 | `updateNaverAccount` |
| `DELETE /api/naver/accounts/:id` | 계정 삭제 | 매니저 권한 | `deleteNaverAccount` |
| `PUT /api/naver/accounts/:id/session` | 로그인 세션 등록 (봉인 저장) | 키 미설정이면 503 — 화면이 `sessionStoreReady` 로 미리 막는다 | `uploadNaverSession` |
| `GET`·`DELETE /api/naver/accounts/:id/session` | 세션 유무 조회 · 삭제 | 값은 안 나간다 | — |
| `PUT /api/naver/accounts/:id/credentials` | 아이디·비번 저장 (다른 키로 봉인) | 저장 후 워커가 검증한다. **실패한 자격증명은 지운다** — 틀린 비번을 들고 반복 시도하면 계정이 잠긴다 | `saveNaverCredentials` |
| `GET`·`DELETE /api/naver/accounts/:id/credentials` | 있다/없다·상태 조회 · 삭제 | 아이디는 `ha9***85` 로 마스킹 | `fetchNaverCredentials` |
| `POST /api/naver/accounts/:id/relogin` | 자격증명으로 재로그인 큐잉 | 세션 만료 시 사람을 안 부르고 워커가 되살린다 | `requestNaverRelogin` |
| `GET /api/naver/login-tool` | 편집자용 로그인 exe 내려받기 | GCS 서명 URL | — |

**카테고리는 1차·2차 둘 다 필수**다(안 고르면 등록 버튼이 활성화되지 않는다). 값이 정해지는
순서는 **발행 페이로드 → 프로그램 기본값(`program.naverCategory`) → 장르 유도**(드라마 →
엔터/드라마)이고, 어느 경로로 왔든 분류표와 대조해 **업로드 전에** 막는다.

> ⚠️ 예전에는 목록에 없는 값이 오면 브라우저가 **첫 항목을 대신 골랐다.** 엉뚱한 분류로
> 발행되는데 화면은 "발행 완료" 라고 말했고, 되돌리려면 네이버에서 손으로 고쳐야 했다.
> 지금은 화면(드롭다운) · 저장(PATCH 400) · 발행 직전(워커) 세 곳에서 막는다.

## 큐 · 파이프라인 트리거

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/youtube/pipeline/run` | due 채널 전체 분석 — Cloud Scheduler가 호출 (OIDC로 인증, 별도 시크릿 없음) | → `{ ok, channels, ran, tookMs, results }` | (웹 미사용) |
| `POST /api/youtube/pipeline/run/:channelId` | 채널 1개 분석을 워커 큐에 즉시 인큐 (`channel.analyze`, force) | → `{ ok, jobId, queued, note }`. `queued:false` = 동일 잡이 이미 대기 중(dedupe) | `triggerChannelAnalysis` |
| `GET /api/queue/stats` | 큐 상태별 잡 수 — 워커 VM 생존 확인용 | → `{ pending, running, done, failed }` | (웹 미사용) |

## admin — 파괴적 유지보수

두 라우트 모두 오조작 방지를 위해 **body에 `confirm` 문자열을 요구**한다. 불일치 시 400.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `POST /api/admin/reset` | 콘텐츠 전체 삭제 (프로그램·회차·추천·클립 + media 행 + GCS/로컬 파일). **복구 불가** | `{ confirm: "RESET" }` (필수) → `{ ok, deletedMedia }` | (웹 미사용 — curl 운영) |
| `POST /api/admin/queue/purge` | 큐 정리: `video.*` 백로그 삭제 + 좀비 `content.analyze` 제거 + 생존 잡 리셋 + 마스터별 분석 잡 보장 인큐 | `{ confirm: "PURGE" }` (필수) → `{ ok, deletedVideoJobs, deletedZombieContentJobs, resetContentJobs, reQueuedContentJobs }` | (웹 미사용 — curl 운영) |

## admin — 운영 · 진단 · VM 기동

`confirm` 없이 호출되지만 프로덕션 접근 제어는 Cloud Run IAM 몫이다.

| 메서드·경로 | 역할 | 요청/응답 요점 | 프론트 함수 |
|---|---|---|---|
| `GET /api/admin/jobs` | 개별 잡 목록 (최근 활동 순) + 큐 통계 — **워커가 지금 뭘 하는지의 라이브 뷰** | 쿼리 `limit` → `{ jobs, stats }` | `fetchOpsJobs` |
| `GET /api/admin/media-analysis` | 업로드 영상별 요약: 분석 상태 + 씬/쇼츠/캐스트 수 + 장르 + 에러 + 회차 pipeline 단계·진행률 | → `{ media: rows }`. 마스터 미디어당 1행 — "각 업로드에서 뭐가 나왔고 뭐가 깨졌나" 테이블. 드릴다운은 `GET /api/media/:id/analysis` | `fetchOpsMediaAnalysis` |
| `POST /api/admin/remux/:id` | 기존 마스터를 progressive mp4로 **제자리 remux** | → `{ ok, size }`. ingest remux 이전에 올라온 파일이나 fragmented 업로드를 재교정할 때. ffmpeg+GCS 필수(400) | (웹 미사용) |
| `POST /api/admin/worker-vm/wake` | pending 잡 있으면 워커 VM start (멱등 — 이미 RUNNING이면 no-op) | → `{ waked, instance, zone, pending }` / `{ waked:false, reason:"no pending jobs" }`. **Cloud Scheduler가 주기 호출** | (웹 미사용) |
| `POST /api/admin/gebd-vm/wake` | pending `gebd.detect` 있으면 GEBD GPU VM start | → `{ waked, … }` / `{ waked:false, reason:"no pending gebd.detect", pending }`. 이미 실행 중이면 `already <status>`. metadata 토큰 → Compute REST `/start` | (웹 미사용) |

> 두 wake 라우트 모두 **Cloud Run SA에 `roles/compute.instanceAdmin.v1`** 이 있어야 동작한다.
> 인증은 Cloud Scheduler OIDC(= Cloud Run IAM 게이팅)로 건다.

## Lab — admin 검수 도구 전용

레포 루트 `core/`(파이썬 파이프라인)의 **로컬 산출물**을 admin Lab 프론트(`admin/index.html`)에
서빙하는 라우트다. 웹 앱(apps/web)은 사용하지 않는다. 읽기 경로는 `CORE_DIR` env(기본: 레포
루트 `core/`). 산출물 스키마는 [core-pipeline-reference.md](core-pipeline-reference.md) 참고.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/lab/data` | 검수 페이로드 일괄 | `pipeline_output.json`·`refined_segments.json`·`scenes.json`·`shorts.json` 합본 → `{ video, video_name, stats, raw, refined, scenes, shorts }` |
| `GET /api/lab/frames/:name` | 씬 대표 프레임 JPEG | `core/scene_frames/<name>` (경로탈출 가드) |
| `GET /api/lab/portraits/:name` | 출연자 초상 이미지 (GCS or local) | `portrait_영철.jpg` 또는 그냥 `영철.jpg` 둘 다 받는다 |
| `GET /api/lab/video/:mediaId` | 원본 영상 스트리밍 (**HTTP Range 지원** — `<video>` 시킹이 되게) | 없으면 404 `no video` |
| `GET /api/lab/videos/:videoId/viewer-signals` | **시청자 목소리**(`viewer_signals`) 조회 — Lab VideosTab 위젯 | `:videoId`는 YouTube videoId. `from-youtube`로 임포트된 롱폼이면 `episode.sourceVideoId`에 남아 있고, 그 media의 `content_analysis.data`에 `viewer_signals` + `shorts`가 저장돼 있다 → `{ videoId, mediaId, viewer_signals, shorts, coverage }`. 미임포트/미분석이면 `{ …, reason }` |
| `GET /lab` | admin Lab 프론트 HTML 로컬 서빙 | 프로덕션에서는 admin이 Vercel에 별도 배포 |
| `GET /assets/:name` | 빌드된 Lab SPA의 정적 에셋 | Vite가 루트 절대 경로(`/assets/…`)로 뽑기 때문에 `/lab`도 같은 루트에서 서빙해야 한다. `basename()`으로 `dist/assets` 밖 조회를 막는다 |

### Lab — 숏폼 ↔ 롱폼 매칭 / LEARN

채널의 기존 숏폼 백카탈로그를 원본 롱폼 구간에 역매칭하고, 고성과 구간 규칙을 학습하기 위한 운영 API다.
쓰기 라우트는 모두 `LAB_WRITE_TOKEN`이 서버에 있어야 하고, 요청 헤더 `x-lab-token` 값이 일치해야 한다.

| 메서드·경로 | 역할 | 요청/응답 요점 |
|---|---|---|
| `GET /api/lab/match/channels` | 매칭 가능한 YouTube 채널 목록 | 토큰 제외, `{ channelId, channelName, subscribers }[]` |
| `GET /api/lab/match/videos/:channelId` | 채널별 숏폼·롱폼·기존 매핑 일괄 조회 | `durationSec <= 180` 또는 `isShort`를 숏폼으로 분류 |
| `POST /api/lab/match` | 수동 매칭 저장/upsert | `{ shortVideoId, channelId, longVideoId, segStart, segEnd, note? }` → `short_source_map`, source=`manual` |
| `POST /api/lab/match/auto` | 선택 숏폼들의 자동 오디오 정렬 큐잉 | `{ channelId, longVideoId, shortVideoIds[], delayMs? }` → `match.align` |
| `DELETE /api/lab/match/:shortVideoId` | 숏폼 매핑 삭제 | → `{ ok, removed }` |
| `GET /api/lab/match/auto-bulk/preview/:channelId` | 채널 일괄 자동 매칭 계획 미리보기 | 제목 토큰/게시일 기반 롱폼 후보 그룹, 쓰기 토큰 불필요 |
| `POST /api/lab/match/auto-bulk` | 한 채널의 자동 매칭 잡 일괄 큐잉 | `{ channelId, limit?, staggerMs? }` → `match.align` 여러 건 |
| `POST /api/lab/match/auto-bulk/all` | 여러 채널 또는 전체 채널 자동 매칭 큐잉 | `{ channelIds?, limitPerChannel?, staggerMs? }` |
| `GET /api/lab/match/overview` | 전 채널 매칭 현황 | shorts/matched/auto/remaining + `match.align` job 상태 |
| `GET /api/lab/match/status/:channelId` | 한 채널의 매칭 진행 상태 | pending/running/done/failed, matched/auto/confirmed/described |
| `POST /api/lab/match/segment` | 매칭 구간 설명 생성 큐잉 | `{ channelId, limitLongforms? }` → `match.segment`, segTranscript/segSummary/segEmotion/segHook 채움 |
| `GET /api/lab/match/export/:channelId` | LEARN 데이터셋 내보내기 | 같은 시기 채널 중앙값 대비 성과 tier(`high/mid/low`) 포함 |
| `POST /api/lab/match/learn` | 채널 포인트 프로파일 학습 큐잉 | `{ channelId }` → `match.learn`, `youtube_channels.pointProfile` 저장 |
| `GET /api/lab/match/profile/:channelId` | 학습된 채널 프로파일 조회 | `{ profile, at }` 또는 `{ profile: null, at: null }` |

## 프론트 연동 방식 (참고)

- 실제 서버 통신은 전부 `apps/web/src/lib/data/api.ts`의 REST 함수들이다. 새 라우트를
  추가하면 여기에 타입 + 함수를 같이 추가한다 (작업 규칙).
- `store.tsx`는 빈 상태(`EMPTY_STATE`)로 시작해 마운트 시 `fetchState()`로 서버 상태를
  로드한다. 실패하면 **빈 상태로 남는다** — 목 데이터 폴백은 제거됐다 (store.tsx 주석:
  "server unreachable — leave the store empty (no mock fallback)"). 연결 여부는
  `serverConnected` 플래그로 UI에 노출된다.

## 오류 응답 규약

- 오류는 JSON `{ error: string }` (때로 `message` 동반) + 상태 코드. 성공은 대부분 `{ ok: true, … }`.
- **400** — 필수 필드 누락 (`title required`, `mediaId and objectPath required`,
  `videoId is required`, `editorState is required`, admin `confirm` 불일치 등).
- **404** — 엔티티/미디어/채널/영상 없음. `GET /api/media/:id/analysis`는 404 body가
  `{ status: "none" }`.
- **409** 네 종류:
  - `{ error: "revoked" }` — 리프레시 토큰 무효. 채널 상태를 `revoked`로 바꾸고 재연동 요구.
    발생 지점: `refresh` · `analytics/:channelId` · `sync/:channelId`.
  - `{ error: "channel_needs_reconsent" }` — 스코프 분리 이전에 연동돼 `yt-analytics.readonly`가
    없는 채널. `/register`에서 재연동 필요. 발생 지점: `analytics/:channelId`.
  - `{ error: "upload_disabled" }` — **실업로드 게이트 OFF** (`YOUTUBE_UPLOAD_ENABLED` 미설정).
    부작용을 내기 전에 거절하므로 **아무 상태도 바뀌지 않는다.** 발생 지점: `distributions/publish`.
  - `{ error: "no_publish_channel" }` — 업로드할 YouTube 채널이 연결돼 있지 않음.
  - (그 밖에 클립에 자막이 없어 제목·메타 생성이 불가할 때도 409를 쓴다.)
- **416** — `stream`의 Range 시작점이 파일 크기를 벗어난 경우 (`Content-Range: bytes */<size>`).
- **500** — OAuth env 미설정(`OAuth not configured`), 외부 API·인코딩 실패 등.
- **502** — 외부 LLM 호출 실패 (`autofill failed` · `profile generation failed` · `no titles generated`).
- **503** — ffmpeg 없음 (`GET /api/media/:id/frame`).

## 웹 미사용 라우트 요약

`api.ts`에 대응 함수가 없는 라우트: `/health`, `PATCH /api/clips/:id/link-video`,
`POST /api/youtube/refresh`, `POST /api/youtube/pipeline/run`, `GET /api/queue/stats`,
`GET /api/search/log`, 프로그램 이해 프로필 2종(생성·설정),
`POST /api/programs/:id/autofill/chat`(사용 안 함), `DELETE /api/media/:id`,
파괴적 admin(`reset`·`queue/purge`)·`admin/remux/:id`·wake 2종, OAuth 콜백,
`/lab`·`/assets/*`·`/api/lab/*`. 운영 curl·Cloud Scheduler·admin Lab이 소비자다.

> `admin/jobs`·`admin/media-analysis`는 예외 — 슈퍼어드민 대시보드(`/ops`)가
> `fetchOpsJobs`·`fetchOpsMediaAnalysis`로 쓴다.

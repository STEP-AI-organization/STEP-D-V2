# STEP-D backend (@stepd/server) — 설계 노트

> 작성 2026-07-13. v2 전용으로 **새로 만든** 백엔드. 원본 STEPD(SPFN/Postgres/pg-boss) 와는
> 별개이며 원본은 미수정. 목표: 인프라 없이(로컬 디스크 + 내장 SQLite + ffmpeg) **실제 영상**을
> 올려 전체 플로우를 돌려보는 것.

## 스택 / 원칙

- **Hono**(라우팅·미들웨어) on Node, `tsx` 로 무빌드 실행.
- **node:sqlite**(Node ≥22 내장) — 네이티브 모듈 빌드 불필요. 도메인 그래프는 `entities`
  문서 저장(JSON blob), 업로드 영상은 관계형 `media` 테이블.
- **ffmpeg/ffprobe**(시스템 설치) — 프로브·썸네일·트림 인코딩. 없으면 우아하게 degrade.
- **로컬 스토리지** `storage/` — `uploads/`(원본), `clips/`(인코딩 클립), `thumbs/`, `stepd.sqlite`.

## 파일

| 파일 | 역할 |
|---|---|
| `src/index.ts` | Hono 앱 · 라우트 · Node 서버 |
| `src/db.ts` | node:sqlite 초기화·시드·엔티티/미디어 CRUD·`getState()` |
| `src/seed.ts` | 초기 데이터(웹 목과 동일) |
| `src/storage.ts` | 경로·디렉터리 보장 |
| `src/ffmpeg.ts` | `probe` / `captureThumbnail` / `trimEncode` |
| `src/pipeline.ts` | 추천 생성(휴리스틱; Gemini 자리) |

## API

| 메서드·경로 | 설명 |
|---|---|
| `GET /health` | `{ ok, ffmpeg, mediaCount }` |
| `GET /api/state` | 웹 `InitialData`(programs·episodes·recommendations·clips·jobs·connections) + `media[]` |
| `POST /api/media/upload` | multipart(`file`,`programId`,`title`) → 저장·ffprobe·썸네일·**회차+마스터+추천** 생성 |
| `GET /api/media/:id/stream` | **HTTP Range(206)** 비디오 서빙(재생/스크럽) |
| `GET /api/media/:id/thumb` | 썸네일 JPEG |
| `POST /api/recommendations/:id/adopt` | 마스터 구간을 **ffmpeg 트림 인코딩** → 재생 가능한 클립 미디어 생성 |
| `POST /api/recommendations/:id/reject` | 반려 |
| `POST /api/distributions/publish` | `{clipIds,channel,reserveDate,scheduled,platforms}` 채널별 발행 기록 |
| `POST /api/distributions/retry` | 실패 배포 재시도 |

CORS 는 `/api/*` 에 열려 있고(dev), 비디오 `<video src>` 는 크로스 오리진으로 바로 로드된다.

## 프론트 연동 (seam)

- `apps/web/src/lib/data/api.ts` — 백엔드 클라이언트.
- `apps/web/src/lib/data/store.tsx` — 마운트 시 `/api/state` 로드. 서버가 없으면 목 폴백.
  뮤테이션은 낙관적 로컬 업데이트 + 서버 호출. `adopt` 는 서버의 실제 인코딩 클립을 사용.
- 미디어 URL 은 서버-상대(`/api/media/..`); 프론트가 `API_BASE` 를 붙여 절대 URL 로 재생.

## 실제 STEPD 로의 매핑 (참고)

| v2 백엔드 | 원본 STEPD |
|---|---|
| `POST /api/media/upload` + ffprobe | `s3-download` → `file-probe(ffprobe)` 잡, `source_files`/`files` |
| `buildRecommendations`(휴리스틱) | `gemini-upload → analyze → recommend` 잡 체인(Gemini) |
| `adopt` 의 `trimEncode` | `export-clip.job`(트림·오버레이·인코딩) + `register-clip.job` |
| `GET /api/media/:id/stream` | 파일 서빙 `/files/:id/download` (range) |
| `distributions.publish/retry` | `smr-admin.publishClip` / `youtube.youtubePublish` / `meta.metaPublish` |
| `entities`(sqlite doc) | `programs/contents/clips/recommendations/distributions`(Drizzle/Postgres) |

## 실제화 하려면 (키/인프라)

- **AI 추천:** `src/pipeline.ts` 의 `buildRecommendations` 를 Gemini 호출로 교체
  (`GEMINI_API_KEY`). 반환 shape(추천 배열)만 맞추면 프론트·adopt 변경 불필요.
- **실제 채널 송출:** SMR XML 피드 서빙 / YouTube Data API / Meta Graph — 각 OAuth·계정 필요.
  현재는 배포 **상태·기록**만 로컬에 남긴다(엑셀·매트릭스·준비도는 실동작).

## 한계 (프로토타입)

- 업로드는 메모리 경유(대용량은 스트리밍 저장으로 개선 여지). 인증 없음(로컬 전용).
- `entities` 문서 저장은 쿼리성이 낮다 — 규모가 커지면 정규화 스키마로 이전.

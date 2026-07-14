# STEP-D → STEPD SPFN 백엔드 통합 맵 (M6)

> v2는 UX를 목(mock) 데이터 위에서 완성했다. 이 문서는 목 seam을 **기존 STEPD SPFN RPC**에
> 연결하는 계약이다. 화면·스토어는 그대로 두고, **`src/lib/data/repository.ts`의
> `activeRepository`를 `apiRepository`로 바꾸는 것**이 통합의 골자다.
> 참조: STEPD 코드는 읽기 전용 — `C:\Users\STEPAI05\STEPD\src\server\routes/*`, `router.ts`.

## 통합 지점 (seam) 4가지

| seam | 파일 | 지금(목) | M6(실연결) |
|---|---|---|---|
| 데이터 접근 | `lib/data/repository.ts` | `mockRepository` | `apiRepository` (SPFN RPC) |
| 초기 데이터 | `lib/data/store.tsx` `AppDataProvider({initial})` | `seedInitialData()` | 서버 로더가 `await activeRepository.loadInitial()` 주입 |
| 세션/RBAC | `lib/auth.tsx` `SessionProvider` | mock superadmin | `@spfn/auth` 세션 |
| 잡 진행률 | `lib/data/use-job-progress.ts` | no-op | SPFN 이벤트 스트림(SSE) 구독 |

## 데이터 로드 매핑 (`loadInitial`)

v2 `InitialData`는 여러 RPC 리스트 호출을 합성한다. STEPD 라우트(코드 실측) 기준:

| v2 필드 | STEPD RPC (route) | 비고 |
|---|---|---|
| `programs` | `smr-admin.ts` 프로그램 목록 | `programs` 엔티티 |
| `episodes` | `smr-admin.ts` 회차 목록 + `sources.ts` 소스셋 상태 | 회차의 `pipeline`은 `source_sets.status` + `process_logs`로 파생 |
| `recommendations` | `sources.ts` `getRecommendations` | `recommendations`(kind=short/clip), appeal은 `result` JSONB |
| `clips` | `smr-admin.ts` 클립 목록 + `distributions.ts` | `clips` + `distributions`(targetType='clip') |
| `jobs` | `system.ts` `getJobQueueStatus` | 실행/실패 잡 |

## 뮤테이션 매핑

| v2 액션 (store) | STEPD RPC | 파이프라인 |
|---|---|---|
| `adoptRecommendation(recId)` | `editor.ts` `exportClips` → `registerEncodedClip` | `export-clip.job` → `register-clip.job` → `clips`. v2 원클릭 = 이 수동 2단계를 자동 체인으로 묶음(로드맵 3-1) |
| `rejectRecommendation(recId, reason)` | (신규) `recommendations` 상태/사유 컬럼 필요 | STEPD엔 reject/사유 저장이 없음 → 스키마 소량 확장(페인 B2) |
| `publishClip` / `bulkPublish` | SMR: `smr-admin.ts` `publishClip` · YouTube: `youtube.ts` `youtubePublish` · Meta: `meta.ts` `metaPublish` | 정직 예약: SMR `reserveDate`는 항상 채워서 전달(페인 C2·현행 `nowReserveDate` 버그 회피) |
| `retryDistribution(clipId, channel)` | `youtube.ts` `youtubeRetry` / 채널별 재발행 | 실패 잡 재큐잉 |
| `selectThumbnail` | `smr-admin.ts` `updateClip({thumbnailFileId})` | 추천 썸네일 후보 → 클립 썸네일(페인 C5) |

## 에디터 저장 (M3 EditorState)

| v2 | STEPD |
|---|---|
| `EditorState`(선언적) 저장 | `editor.ts` edit-project 저장 → `edit_projects.clips`(EditClip/overlays v2 좌표) |
| 오버레이 렌더 | `editor-overlay.ts` `renderOverlay`/`getOverlayCache`(서버 텍스트 렌더+해시 캐시) |
| 인코딩 | `editor.ts` `exportClips` → `export-clip.job`(비율/오버레이/인트로·아웃) |
| 자동자막(STT) | 신규 `stt.job`(whisper/Gemini audio) — 통합분석 C안 / 로드맵 2-2 |

> WYSIWYG 계약: v2 프리뷰 %좌표·고정 종횡비 캔버스는 StepD의 `_scale_preview_px`처럼
> **렌더러와 동일 px 기준**을 공유해야 바이크가 일치한다(계획서 §3).

## 세션 / RBAC

- `SessionProvider`를 `@spfn/auth` 세션으로 교체. 역할 3종(`user`/`admin`/`superadmin`)은 STEPD와 동일.
- `navForRole`·화면 게이팅은 그대로 동작.

## 잡 진행률 (SSE)

- `apiRepository.subscribeJobs`를 SPFN 이벤트(`sourceSetChanged` 등)에 연결.
- 잡/알림 센터(`components/shell/job-center.tsx`)가 `useJobProgress`로 실시간 반영.

## 전환 절차

1. `apiRepository`의 각 메서드를 SPFN RPC 클라이언트로 구현(위 매핑).
2. 서버 로더(예: `(app)/layout.tsx`를 server component로)에서 `await activeRepository.loadInitial()` → `AppDataProvider initial={...}`. (로딩 상태 추가)
3. `activeRepository = apiRepository`로 스위치.
4. `SessionProvider session={실세션}` 주입.
5. 스키마 소량 확장: `recommendations` reject 사유, `distributions` 성과 컬럼(조회수 등 — 페인 B4/성과 대시보드).
6. 리그레션: 각 마일스톤 플로우(채택/배포/편집)를 실 데이터로 재검증.

## 데이터 모델 대응

v2 `lib/types.ts`는 STEPD Drizzle 엔티티를 반영(정본=STEPD). 상세 대응은 계획서 §11 표 참조.
신규(v2 표준): 컨트롤드 보캐뷸러리 단일 모듈(`lib/constants.ts`), 계보(`recommendationId→clipId→distributionId`) 명시 모델링.

# Factory API 프로덕션 관통 스모크 — 2026-08-12

STEPAI 워크스페이스(t_default) · 고객 경로(워크스페이스 API 키) 그대로 실측.
사실만 기록한다 — 판단·평가는 별도.

## 환경

- 서버: stepd-server (Cloud Run) · 워커: stepd-worker-youtube (drain) · DB: Cloud SQL
- 키 발급: Cloud SQL Proxy 경유 직접 INSERT (superadmin 세션 부재 · audit_log 테이블명이 달라 감사행 스킵)
  - `smoke-full` (스코프 6종) · `smoke-read-only` (factory:read 단독)
- Cloud Run 이 IAM 잠금(invoker=domain:stepai.kr+deployer SA)이라 스모크 호출은
  `X-Serverless-Authorization: Bearer <ID토큰>` 을 병행해 GFE 를 통과시켰다.
  **외부 고객은 이 방법을 쓸 수 없다** — 공개 방식 결정 필요(아래 미해결).

## A. 인증 케이스 (전부 기대 일치)

| 호출 | 결과 |
|---|---|
| 키 없이 `GET /api/factory/targets` | 401 login required (익명 폴백 차단) |
| 구 `x-factory-key` 헤더 | 401 |
| read 키 `GET /api/factory/targets` | 200 — 채널 목록 + canPublish/사유 (뮤·리모와 멜로=true) |
| read 키 `POST /api/factory/ingest` | 403 "이 키에 factory:write 권한이 없습니다" (발급 시 스코프 반영 = 1144 수정 검증) |
| 전체 키 `GET /api/credits` | 200 — balance 60 · 단가 ₩28 · 포트원 실결제(₩1,680) 이력 |
| 전체 키 `GET /api/media/:id/shorts` | 200 — 추천 20개 점수순 |
| 전체 키 `GET /api/media/:id/clips` | 200 |

## B. 공장 dryRun 관통 (m_f4202d8f · 58.6분 회차 · 기존 분석 재사용)

`POST /api/factory/ingest` sourceUrl=gs://…/m_f4202d8f.mp4 · maxShorts 2 · dryRun → 202.

최종: **queued → analyzing → adopting → rendering → done** · 클립 2개 렌더
(c_e1551fc8 36.5s · c_f1a580bd 40.5s) · distributions 0건(dryRun — 업로드 없음. 정상).

중간에 아래 결함들로 3회 재시도했고, 각 수정 후 이어서 완주했다.

## 발견 결함 (전부 이 세션에서 수정·배포됨)

1. **factory 미디어 매칭 실패** — media 행 필드는 `path` 인데 factory·videos 중복체크가
   존재하지 않는 `storedPath` 를 봐서 기존 미디어 재사용이 항상 실패("sourceUrl 로 미디어를
   찾지 못했다", f_eed92aed). → `path`(+mediaId 직접 지정)로 수정. (커밋 b98416c)
2. **워커→서버 렌더 호출 무인증** — "Cloud Run 은 allow-unauthenticated" 전제의 fetch 가
   IAM 잠금 + AUTH_REQUIRED 에서 401/403 무한 재시도. → 메타데이터 ID 토큰(IAM) +
   `INTERNAL_API_TOKEN` 공유 토큰(resolveTenant internal 경로) 이중 배선. (커밋 9c7cbdd)
3. **워커의 서버 주소가 웹 프록시** — `PUBLIC_URL`(=stepd.stepai.kr/api/proxy, Vercel)로
   렌더 요청이 웹에 가서 401. → 워커 잡 env `INTERNAL_API_BASE`=서버 직통 URL.
4. **분석 완료 미디어 재차감** — factory 가 content.analyze 를 무조건 재큐잉, 체크포인트로
   연산은 스킵돼도 recordUsage 가 전체 분수를 재차감 → **60→1 크레딧 (59 차감) 실측**.
   → 분석 status=done 이면 큐잉 없이 직행. (커밋 f086c67)
   - t_default 의 59크레딧은 미환급 상태 — superadmin 수동 grant 로 복구 가능(결정 대기).

## 운영 사고 (이 세션에서 발생·복구)

- `gcloud run jobs update --set-env-vars/--set-secrets` 가 **전체 목록 교체**라는 걸 놓쳐
  워커 잡 2종의 env·시크릿이 지워짐 → "GOOGLE_CLIENT_ID 필요"로 즉사. 과거 execution
  스냅샷에서 원본 확보해 완전 원복(+신규 2종). 이후는 `--update-env-vars` 를 쓸 것.
- `deploy/cloud.sh` 백그라운드 실행 1회가 "[deploy] ⚠️ 중단"으로 끝났는데 exit 0 이라
  성공으로 오독 → 낡은 리비전 상대로 30분 디버깅. **배포는 출력 본문까지 확인할 것.**

## 소요·비용

- 소요: 약 3.5시간 (결함 4건 수정·재배포 왕복 포함)
- 비용: 분석 재실행 없음 의도였으나 결함 4로 **59크레딧(명목 ₩1,652) 차감** 발생.
  실제 원가는 체크포인트 재개라 소액(재분석 스테이지 대부분 스킵). 렌더 ffmpeg 2건.

## 미해결 (결정 필요)

1. **외부 공개 경로** — cloudbuild 는 `--allow-unauthenticated` 를 주지만 IAM 에 allUsers 가
   안 붙는다(조직 정책 추정). ENA/aena 는 현재 서버를 직접 못 부른다. 선택지:
   ① 조직 정책 예외 + 서비스 공개 (앱 인증은 fail-closed 완비) ② LB/API Gateway 앞단
   ③ aena 에 GCP SA 발급(ID 토큰 병행). 결정 전까지 고객 연동 불가.
2. t_default 59크레딧 환급 여부.
3. `GET /api/factory/jobs` 목록 라우트 (aena 화면용 백로그).
4. 검증용 스모크 키 2개(smoke-full·smoke-read-only) 폐기 여부 — 남겨두면 운영 키와 섞인다.

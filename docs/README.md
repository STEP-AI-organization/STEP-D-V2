# STEP-D 문서 지도

> 2026-08-07 재편. **폴더가 문서의 성격을 말한다**: `ops/`는 지금 사실(현황·운영), `plans/`는 계획(`active/` 진행중 · `done/` 구현완료 · `onhold/` 보류),
> `reference/`는 사전처럼 찾아보는 레퍼런스, `research/`는 기술 조사, `archive/`는 역사 기록(따라하지 말 것).

## 리포 최상위 — 어디에 뭐가 있나

| 폴더 | 무엇 |
|---|---|
| `apps/web` · `apps/server` · `core/` | **제품 코드** (프론트 · 서버/워커 · AI 파이프라인) |
| `admin/` | 플랫폼 관리 콘솔 (STEPAI 운영자 전용) |
| `deploy/` | 배포 — 표준은 `bash deploy/cloud.sh <target>` |
| [`scripts/`](../scripts/README.md) | 개발·운영·실험 스크립트 (제품 코드 아님) |
| `docs/` | 이 문서들 |

## 읽는 순서

**새 개발자 / 새 AI 세션**
1. 루트 [CLAUDE.md](../CLAUDE.md) — 리포 전체 컨텍스트 (구조·함정·작업 규칙)
2. [ops/infra.md](ops/infra.md) — 인프라 단일 진실 소스
3. [ops/local-dev.md](ops/local-dev.md) — 로컬에서 돌려보기
4. [reference/data-model.md](reference/data-model.md) + [reference/api-reference.md](reference/api-reference.md)

**운영자 (배포·장애 대응)**
1. **`bash deploy/cloud.sh status`** — 지금 뭐가 떠 있나 (배포는 `server|worker|gebd|migrate|all`)
2. [ops/infra.md](ops/infra.md) §배포 — 함정 모음
3. [ops/runbook.md](ops/runbook.md) — 증상별 장애 대응 + 시크릿 로테이션
4. [ops/worker-queue.md](ops/worker-queue.md) — 큐·워커 구조와 점검 커맨드

**기획·설계 (다음에 뭘 만들까)**
1. [plans/active/step-d-master-build-plan.md](plans/active/step-d-master-build-plan.md) — **종합 빌드 플랜 (정본)**
2. [plans/active/b2b-workspace-strategy.md](plans/active/b2b-workspace-strategy.md) — **B2B 전략 정본** (워크스페이스 판매 · 고객사 API · KT ENA 연동)
3. [plans/active/broadcast-station-expansion-goal.md](plans/active/broadcast-station-expansion-goal.md) — 방송국 전사 확장 목표
4. [plans/active/](plans/active/) — 진행 중 18건 · [plans/onhold/](plans/onhold/) — 보류 8건

**영업·사업 (고객사에 뭘 말하나)**
1. [plans/active/b2b-workspace-strategy.md](plans/active/b2b-workspace-strategy.md) — 구조·안전장치·온보딩 체크리스트
2. [presentations/stepd-b2b-onepager.html](presentations/stepd-b2b-onepager.html) — 팀 공유용 한 장 요약 (브라우저로 열기)
3. [reference/customer-api.md](reference/customer-api.md) — **고객사에 그대로 주는 API 문서**
4. [ops/cost-and-dependencies.md](ops/cost-and-dependencies.md) — 원가·의존성 (⚠️ 가격 제시 전 필독)

## ops/ — 현황·운영 (지금 프로덕션에서 사실인 것)

| 문서 | 내용 |
|---|---|
| [how-it-works.md](ops/how-it-works.md) | **제품이 어떻게 돌고 한 편에 얼마 드는가** — 그림으로 보는 파이프라인 · **60분 회차 원가 ≈₩800 · 마진 ~51% (2026-08-19 flash-lite 전환 · 원가 정본)** · 측정 방법·함정까지. 영업·기획용 |
| [auto-deploy-failure-modes.md](ops/auto-deploy-failure-modes.md) | **자동배포가 멈추는 경우 전수** — 크레딧 바닥·소스 없음·소스 소실 등 · 각 경우에 사용자가 아는 방법과 재개 경로 · 조용한 정지 구멍 6개와 고칠 순서 |
| [infra.md](ops/infra.md) | **인프라 SSOT** — Cloud Run 서비스·**Cloud Run Jobs**·**GEBD GPU VM**·Cloud SQL·GCS·Vertex·Vercel·시크릿 |
| [pipeline-current-state.md](ops/pipeline-current-state.md) | **파이프라인 실제 상태** — 스테이지 22개·비용·사각지대 (코드 실측 기준) |
| [cost-and-dependencies.md](ops/cost-and-dependencies.md) | **원가·의존성 SSOT** — 외부 API 단가·회차당 원가 재산출·고정비·단일장애점. 단가표·의존성 인벤토리. ⚠️ **회차 원가 숫자는 how-it-works.md §4 가 정본** — 이 문서의 ₩994 는 로그 일부만 집계한 값이다 |
| [gebd-worker-setup.md](ops/gebd-worker-setup.md) | 여유 PC 를 GEBD 워커로 붙이기 (GPU 클라우드 대안) |
| [youtube-ingest.md](ops/youtube-ingest.md) | **유튜브 가져오기 배선** — 다운로드=윈도우2(한국 IP·download 레인), 분석=클라우드. 함정 7개와 점검 순서 |
| [gpu-quota-request.md](ops/gpu-quota-request.md) | GPU 쿼터 상향 신청 절차 |
| [deploy.md](ops/deploy.md) | 배포 런북 — 서버/워커/웹 배포 스크립트와 검증·롤백 |
| [deploy-win2.md](ops/deploy-win2.md) | **윈도우2(네이버 워커) 배포** — 윈도우1 에서 갱신·확인·진단. 평소엔 push 만 하면 자동 |
| [audit-2026-08-12.md](ops/audit-2026-08-12.md) | **전면 점검 결과** — 즉시 수정 20건(완료) + 미해결 우선순위 15건. 이 리포의 실패 유형 분석 |
| [runbook.md](ops/runbook.md) | 장애 대응 — 증상별 진단·조치, 시크릿 로테이션 |
| [local-dev.md](ops/local-dev.md) | 로컬 개발 — dev.ps1 (웹+서버+Docker Postgres), core/ 로컬 실행 |
| [worker-queue.md](ops/worker-queue.md) | 잡 큐(job_queue)·워커 VM 아키텍처 — 잡 5종, 신뢰성 설계 |
| [migrations.md](ops/migrations.md) | DB 마이그레이션(node-pg-migrate) — 버전 체계·baseline·작성 규칙 |
| [youtube-upload-gate.md](ops/youtube-upload-gate.md) | YouTube 실업로드 게이트(`YOUTUBE_UPLOAD_ENABLED`) — 기본 OFF, env로만 온오프 |
| [naver-publish.md](ops/naver-publish.md) | **네이버 TV·클립 발행** — 공개 API 가 없어 Playwright 자동화. 사무실 PC 전용 레인·세션·게이트·실측 수치 |
| [commerce-links.md](ops/commerce-links.md) | **쿠팡 제휴 링크 파이프라인** — 영상에서 상품 찾기(기존 메타 콜 편승 · 원가 ₩0) → 발급 → **사람 승인** → 발행 설명란. 회사별 계정(정산이 계정 단위)·수익 오귀속 가드·자기클릭 금지 |
| [vercel-ops.md](ops/vercel-ops.md) | Vercel 운영 — 환경변수 계약, CLI 레시피, 함정 모음 |
| [youtube-channel-analytics-guide.md](ops/youtube-channel-analytics-guide.md) | YouTube OAuth·채널분석 — 구현 현황과 남은 항목(심사·토큰 암호화) |

## plans/ — 계획 (폴더가 상태를 말한다)

| 폴더 | 뜻 | 개수 |
|---|---|---|
| **[active/](plans/active/)** | 진행 중이거나 곧 할 것 | 18 |
| [done/](plans/done/) | 구현 완료 — 현황은 `ops/` 문서가 정본 | 9 |
| [onhold/](plans/onhold/) | 보류 (예산·자원 대기) | 8 |
| [../archive/plans-2026-07/](archive/plans-2026-07/) | 역사 기록 — **따라하지 말 것** | 7 |

**진입점**
- [active/step-d-master-build-plan.md](plans/active/step-d-master-build-plan.md) — 종합 빌드 플랜 (정본)
- [active/cloud-migration-model-and-worker.md](plans/active/cloud-migration-model-and-worker.md) — 클라우드 이전 (2026-08-07 실행분 포함)
- [active/search-highlight-replan-2026-08-06.md](plans/active/search-highlight-replan-2026-08-06.md) — 검색·하이라이트
- [onhold/gebd-finetune-resume-plan.md](plans/onhold/gebd-finetune-resume-plan.md) — GEBD 파인튜닝 (⚠️ §1 근거 무효 · 재측정 필요)

## reference/ — 레퍼런스

| 문서 | 내용 |
|---|---|
| [content-model.md](reference/content-model.md) | **콘텐츠 모델 정본** — 롱폼 → 클립 → 숏폼·하이라이트 계층, beat·UI 원칙 |
| [glossary.md](reference/glossary.md) | 용어집 — SMR `clipType` 등 기존 코드값 참고 |
| [data-model.md](reference/data-model.md) | DB 스키마 종합 — schema.sql + 런타임 안전망 + **migrations/** + 변경 절차 |
| [api-reference.md](reference/api-reference.md) | 서버 HTTP API 전 라우트(일반 API + admin Lab + match.*) ↔ 프론트 함수 매핑 |
| [customer-api.md](reference/customer-api.md) | **고객사 API 정본** — 워크스페이스 키(Bearer)·스코프·화이트리스트 21개 라우트·공장·온보딩 런북. (구 `factory-api.md` 는 폐기) |
| [core-pipeline-reference.md](reference/core-pipeline-reference.md) | core/ 파이썬 파이프라인 모듈·출력 스키마·디버깅·admin Lab |
| [patent-new-figures-14-17-technical-brief.md](reference/patent-new-figures-14-17-technical-brief.md) | 변리사 회신용 신규 도면(도 14~17) 기술 설명 — 서사 앵커·역매칭·체크포인트·레이어 썸네일 |

## research/ · prototypes/ · archive/

- [archive/object-detection-research.md](archive/object-detection-research.md) — 객체인식·비전 기술 선정 조사 (아카이브)
- [archive/highlight-model-feasibility.md](archive/highlight-model-feasibility.md) — 하이라이트 품질 개선 실현가능성 조사 · 100만 구독 채널 데이터 활용 (아카이브, 결론은 plans/에 반영됨)
- prototypes/ — [editor-prototype.html](prototypes/editor-prototype.html) · [program-home-prototype.html](prototypes/program-home-prototype.html) (UI 목업, 코드 아님)
- presentations/ — [stepd-b2b-onepager.html](presentations/stepd-b2b-onepager.html) (B2B 구조 한 장 요약) · 회의 대본
- archive/ — 발명신고서·기술소개서·방향기획서 원본 (역사 기록)

## 문서 관리 규칙

- **현황 문서(ops/·reference/)는 코드가 바뀌면 같이 바꾼다** — 특히 라우트 추가 시 api-reference.md, 테이블 추가 시 data-model.md.
- 계획 문서(plans/)는 구현이 계획과 달라지면 지우지 말고 **'계획 vs 실제' 표에 기록**한다.
- 완전히 낡은 문서는 archive/로 옮기지 말고 **삭제**한다 (git 히스토리가 보존; 2026-07-16에 backend-notes·integration-map·step-d-ux-plan·deploy/INFRA·deploy/runbook 삭제 · 2026-07-21에 실현 완료된 쇼츠 계획문서 3편 삭제: channel-domain-adaptation·analysis-pipeline-next·shorts-quality-eval → shorts-engine-성과보고/experiments로 통합 · 2026-07-22에 실현·오래됨 4편 삭제: opencut-integration-plan(Phase 1 완료)·publish-fields-ux-plan(프론트 구현 완료)·editor-gap-analysis-vs-capcut(진단 종료)·investment-analysis-2026-07-17(스냅샷, 이후 대폭 진화)).
- 검증 커맨드: `apps/server`는 `npx tsc --noEmit`, `apps/web`은 `npx next build`.

# STEP-D 문서 지도

> 2026-07-16 재편. **폴더가 문서의 성격을 말한다**: `ops/`는 지금 사실(현황·운영), `plans/`는 미래 계획,
> `reference/`는 사전처럼 찾아보는 레퍼런스, `research/`는 기술 조사, `archive/`는 역사 기록(따라하지 말 것).

## 읽는 순서

**새 개발자 / 새 AI 세션**
1. 루트 [CLAUDE.md](../CLAUDE.md) — 리포 전체 컨텍스트 (구조·함정·작업 규칙)
2. [ops/infra.md](ops/infra.md) — 인프라 단일 진실 소스
3. [ops/local-dev.md](ops/local-dev.md) — 로컬에서 돌려보기
4. [reference/data-model.md](reference/data-model.md) + [reference/api-reference.md](reference/api-reference.md)

**운영자 (배포·장애 대응)**
1. [ops/deploy.md](ops/deploy.md) — 배포 런북
2. [ops/runbook.md](ops/runbook.md) — 증상별 장애 대응 + 시크릿 로테이션
3. [ops/worker-queue.md](ops/worker-queue.md) — 큐·워커 구조와 점검 커맨드

**기획·설계 (다음에 뭘 만들까)**
1. [plans/step-d-master-build-plan.md](plans/step-d-master-build-plan.md) — **종합 빌드 플랜 (정본)**
2. 세부 트랙: [plans/pipeline-plan.md](plans/pipeline-plan.md) · [plans/context-engine-plan.md](plans/context-engine-plan.md)

## ops/ — 현황·운영 (지금 프로덕션에서 사실인 것)

| 문서 | 내용 |
|---|---|
| [infra.md](ops/infra.md) | 인프라 SSOT — GCP(Cloud Run·워커 VM·Cloud SQL·GCS·Vertex)·Vercel·시크릿 |
| [deploy.md](ops/deploy.md) | 배포 런북 — 서버/워커/웹 배포 스크립트와 검증·롤백 |
| [runbook.md](ops/runbook.md) | 장애 대응 — 증상별 진단·조치, 시크릿 로테이션 |
| [local-dev.md](ops/local-dev.md) | 로컬 개발 — dev.ps1 (웹+서버+Docker Postgres), core/ 로컬 실행 |
| [worker-queue.md](ops/worker-queue.md) | 잡 큐(job_queue)·워커 VM 아키텍처 — 잡 5종, 신뢰성 설계 |
| [pipeline-current.md](ops/pipeline-current.md) | 파이프라인 현재 동작 — 데이터 수집 계층 + AI 콘텐츠 분석(content.analyze) 배선 + 2026-07-16 인시던트 부록 |
| [migrations.md](ops/migrations.md) | DB 마이그레이션(node-pg-migrate) — 버전 체계·baseline·작성 규칙 |
| [youtube-upload-gate.md](ops/youtube-upload-gate.md) | YouTube 실업로드 게이트(`YOUTUBE_UPLOAD_ENABLED`) — 기본 OFF, env로만 온오프 |
| [vercel-ops.md](ops/vercel-ops.md) | Vercel 운영 — 환경변수 계약, CLI 레시피, 함정 모음 |
| [youtube-channel-analytics-guide.md](ops/youtube-channel-analytics-guide.md) | YouTube OAuth·채널분석 — 구현 현황과 남은 항목(심사·토큰 암호화) |

## plans/ — 계획 (미래; 헤더의 상태 배너와 '계획 vs 실제' 표를 먼저 볼 것)

| 문서 | 내용 |
|---|---|
| [step-d-master-build-plan.md](plans/step-d-master-build-plan.md) | **종합 빌드 플랜 (정본)** — 아키텍처·로드맵·갭·착수점 |
| [pipeline-plan.md](plans/pipeline-plan.md) | AI 파이프라인 청사진 (발명신고서 구성 A~J) |
| [shorts-engine-research-report.md](plans/shorts-engine-research-report.md) | **쇼츠 엔진 연구보고서 (종합·자세)** — 배경·방법론·Exp 1-4·실패 F1-7·결론·재현법. 보고서/IR용 정본 |
| [shorts-engine-성과보고-2026-07-21.md](plans/shorts-engine-성과보고-2026-07-21.md) | 쇼츠 엔진 성과보고 (읽기용 짧은 요약) — 아침 확인용 진입점 |
| [shorts-engine-experiments-2026-07-21.md](plans/shorts-engine-experiments-2026-07-21.md) | 쇼츠 엔진 실증 실험 **상세 로그** — 인프라·측정 방법론·다중 홀드아웃 A/B·폐기 실험·로드맵 (성과보고의 근거) |
| [shorts-engine-experiment-log.md](plans/shorts-engine-experiment-log.md) | 쇼츠 엔진 **실험 연대기(로그)** — 방법론 진화 시간순 기록(IoU→Topic 등). 새 실험은 여기 append (보고서용) |
| [context-engine-plan.md](plans/context-engine-plan.md) | 인물·서사 컨텍스트 엔진(CX 트랙) 설계 |
| [ui-source-dependency-visualization.md](plans/ui-source-dependency-visualization.md) | UI 기획 — 원본→쇼츠 의존성 시각화 (원본→분석→추천→쇼츠→배포 추적) |

## reference/ — 레퍼런스

| 문서 | 내용 |
|---|---|
| [glossary.md](reference/glossary.md) | 용어집 — 쇼츠/클립/하이라이트 정의, SMR clipType 코드 |
| [data-model.md](reference/data-model.md) | DB 스키마 종합 — schema.sql + **코드 런타임 생성 테이블** + 변경 절차 |
| [api-reference.md](reference/api-reference.md) | 서버 HTTP API 전 라우트 (~40개) ↔ 프론트 함수 매핑 |
| [core-pipeline-reference.md](reference/core-pipeline-reference.md) | core/ 파이썬 파이프라인 모듈·출력 스키마·디버깅·admin Lab |

## research/ · prototypes/ · archive/

- [research/object-detection-research.md](research/object-detection-research.md) — 객체인식·비전 기술 선정 조사
- [research/highlight-model-feasibility.md](research/highlight-model-feasibility.md) — 하이라이트 품질 개선 실현가능성 조사 (100만 구독 채널 데이터 활용)
- prototypes/ — [editor-prototype.html](prototypes/editor-prototype.html) · [program-home-prototype.html](prototypes/program-home-prototype.html) (UI 목업, 코드 아님)
- archive/ — 발명신고서·기술소개서·방향기획서 원본 (역사 기록)

## 문서 관리 규칙

- **현황 문서(ops/·reference/)는 코드가 바뀌면 같이 바꾼다** — 특히 라우트 추가 시 api-reference.md, 테이블 추가 시 data-model.md.
- 계획 문서(plans/)는 구현이 계획과 달라지면 지우지 말고 **'계획 vs 실제' 표에 기록**한다.
- 완전히 낡은 문서는 archive/로 옮기지 말고 **삭제**한다 (git 히스토리가 보존; 2026-07-16에 backend-notes·integration-map·step-d-ux-plan·deploy/INFRA·deploy/runbook 삭제 · 2026-07-21에 실현 완료된 쇼츠 계획문서 3편 삭제: channel-domain-adaptation·analysis-pipeline-next·shorts-quality-eval → shorts-engine-성과보고/experiments로 통합 · 2026-07-22에 실현·오래됨 4편 삭제: opencut-integration-plan(Phase 1 완료)·publish-fields-ux-plan(프론트 구현 완료)·editor-gap-analysis-vs-capcut(진단 종료)·investment-analysis-2026-07-17(스냅샷, 이후 대폭 진화)).
- 검증 커맨드: `apps/server`는 `npx tsc --noEmit`, `apps/web`은 `npx next build`.

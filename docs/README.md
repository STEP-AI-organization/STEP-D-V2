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
| [pipeline-current.md](ops/pipeline-current.md) | 채널·영상·성과 데이터 수집 파이프라인의 현재 동작 |
| [content-pipeline-prod.md](ops/content-pipeline-prod.md) | AI 콘텐츠 분석(content.analyze) 프로덕션 배선 |
| [vercel-ops.md](ops/vercel-ops.md) | Vercel 운영 — 환경변수 계약, CLI 레시피, 함정 모음 |
| [youtube-channel-analytics-guide.md](ops/youtube-channel-analytics-guide.md) | YouTube OAuth·채널분석 — 구현 현황과 남은 항목(심사·토큰 암호화) |

## plans/ — 계획 (미래; 헤더의 상태 배너와 '계획 vs 실제' 표를 먼저 볼 것)

| 문서 | 내용 |
|---|---|
| [step-d-master-build-plan.md](plans/step-d-master-build-plan.md) | **종합 빌드 플랜 (정본)** — 아키텍처·로드맵·갭·착수점 |
| [pipeline-plan.md](plans/pipeline-plan.md) | AI 파이프라인 청사진 (발명신고서 구성 A~J) |
| [context-engine-plan.md](plans/context-engine-plan.md) | 인물·서사 컨텍스트 엔진(CX 트랙) 설계 |
| [opencut-integration-plan.md](plans/opencut-integration-plan.md) | 검수 에디터 OpenCut 부품 이식 (Phase 1 완료) |
| [publish-fields-ux-plan.md](plans/publish-fields-ux-plan.md) | 채널별 배포 필수 필드 분리 설계 근거 (프론트 구현 완료) |

## reference/ — 레퍼런스

| 문서 | 내용 |
|---|---|
| [glossary.md](reference/glossary.md) | 용어집 — 쇼츠/클립/하이라이트 정의, SMR clipType 코드 |
| [data-model.md](reference/data-model.md) | DB 스키마 종합 — schema.sql + **코드 런타임 생성 테이블** + 변경 절차 |
| [api-reference.md](reference/api-reference.md) | 서버 HTTP API 전 라우트 (~40개) ↔ 프론트 함수 매핑 |
| [core-pipeline-reference.md](reference/core-pipeline-reference.md) | core/ 파이썬 파이프라인 모듈·출력 스키마·디버깅·admin Lab |

## research/ · prototypes/ · archive/

- [research/object-detection-research.md](research/object-detection-research.md) — 객체인식·비전 기술 선정 조사
- prototypes/ — [editor-prototype.html](prototypes/editor-prototype.html) · [program-home-prototype.html](prototypes/program-home-prototype.html) (UI 목업, 코드 아님)
- archive/ — 발명신고서·기술소개서·방향기획서 원본 (역사 기록)

## 문서 관리 규칙

- **현황 문서(ops/·reference/)는 코드가 바뀌면 같이 바꾼다** — 특히 라우트 추가 시 api-reference.md, 테이블 추가 시 data-model.md.
- 계획 문서(plans/)는 구현이 계획과 달라지면 지우지 말고 **'계획 vs 실제' 표에 기록**한다.
- 완전히 낡은 문서는 archive/로 옮기지 말고 **삭제**한다 (git 히스토리가 보존; 2026-07-16에 backend-notes·integration-map·step-d-ux-plan·deploy/INFRA·deploy/runbook 삭제).
- 검증 커맨드: `apps/server`는 `npx tsc --noEmit`, `apps/web`은 `npx next build`.

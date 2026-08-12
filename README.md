# STEP-D (monorepo)

방송사·MCN 운영자 중심의 클립/쇼츠 스튜디오. 긴 영상을 올리면 AI 파이프라인이 추천 구간을
생성하고, 운영자가 채택하면 트림·인코딩된 클립이 되어 편집 → 멀티채널 배포 → 성과 추적까지 이어진다.

## 폴더 — 뭐가 뭔지

**리포에 있는 건 7개뿐이다.** 나머지(`node_modules` · `storage` · `logs` · `tmp` ·
`local-scratch` · `eval` · `gcp-keys`)는 전부 로컬 전용이고 git 에 없다.

| 폴더 | 무엇 | 언어 | 어디서 도나 |
|---|---|---|---|
| **[`apps/web`](apps/web/)** | 운영자가 보는 화면 | TypeScript (Next.js) | Vercel · stepd.stepai.kr |
| **[`apps/server`](apps/server/)** | HTTP 서버 + 잡 워커 | TypeScript (Hono) | Cloud Run · Cloud Run Jobs |
| **[`core/`](core/)** | **AI 파이프라인** — STT·장면경계·beat·추천·검색색인·썸네일 | **Python** | 워커가 `python -m core.analyze` 로 스폰 |
| **[`admin/`](admin/)** | 플랫폼 관리 콘솔 (STEPAI 운영자 전용) | TypeScript (Vite SPA) | Vercel · admin.stepd.stepai.kr |
| **[`deploy/`](deploy/)** | 배포·프로비저닝 | Bash / PowerShell | 사람이 실행 |
| **[`scripts/`](scripts/README.md)** | 개발·운영·실험 도구 (**제품 코드 아님**) | 잡다 | 사람이 실행 |
| **[`docs/`](docs/README.md)** | 문서 | — | — |

`assets/` 는 코드가 읽는 정적 자산(쇼츠 프레임 템플릿·썸네일 스타일 프로파일)이다.

### 헷갈리기 쉬운 두 가지

**① 서버는 Node, 파이프라인은 Python.** 둘 다 쓴다.
`apps/server` 는 HTTP 라우트와 큐만 담당하고, **무거운 AI 작업은 전부 `core/` 파이썬**이
한다. 서버가 자식 프로세스로 띄운다 — 접점은 `apps/server/src/content-pipeline.ts` 하나뿐이다.

```
브라우저 → apps/web → apps/server (라우트·큐)
                          └─ 워커가 spawn → core/ (python) → 결과를 DB·GCS 로
```

**② 워커는 서버와 같은 코드, 다른 프로세스다.**
`apps/server/src/worker.ts` 가 진입점이고 **레인 4개**로 갈라 돈다 —
`content`(파이썬·ffmpeg) · `youtube`(API 쿼터) · `gebd`(GPU VM) · `naver`(사무실 PC).
자세히는 [CLAUDE.md](CLAUDE.md) 의 워커 절.

> 구 STEPD(Python FastAPI `apps/api/` · `apps/docs/` · 그 테스트·배포 자산)는
> **2026-08-12 전부 삭제됐다.** 참고할 일이 있으면 git 이력에서 꺼낸다.

## 시작하기

| | |
|---|---|
| **리포 전체 컨텍스트** | [CLAUDE.md](CLAUDE.md) — 구조·함정·작업 규칙 (**여기부터**) |
| **문서 전체 지도** | [docs/README.md](docs/README.md) — 현황(ops) / 계획(plans) / 레퍼런스 |
| **로컬 개발** | [docs/ops/local-dev.md](docs/ops/local-dev.md) — `dev.ps1` 하나로 웹+서버+Postgres |
| **배포** | [docs/ops/deploy.md](docs/ops/deploy.md) — 표준은 `bash deploy/cloud.sh <target>` |
| **인프라 SSOT** | [docs/ops/infra.md](docs/ops/infra.md) |

## 사전 요구

- **Node ≥ 22**, **pnpm**, **Docker Desktop** (로컬 Postgres)
- **ffmpeg / ffprobe** (영상 프로브·썸네일·트림 인코딩)
- `core/` 를 로컬에서 돌리려면 **Python 3.11+** 와 GCP 인증 — [docs/ops/local-dev.md](docs/ops/local-dev.md)

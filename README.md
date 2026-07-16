# STEP-D (monorepo)

방송사·MCN 운영자 중심의 클립/쇼츠 스튜디오. 긴 영상을 올리면 AI 파이프라인이 추천 구간을
생성하고, 운영자가 채택하면 트림·인코딩된 클립이 되어 편집 → 멀티채널 배포 → 성과 추적까지 이어진다.

## 구조 (pnpm 워크스페이스)

```
apps/
  web/      Next.js 16 프론트엔드 (@stepd/web) → Vercel (stepd.stepai.kr)
  server/   백엔드 (@stepd/server) — Hono + PostgreSQL + GCS + ffmpeg → Cloud Run
            + 별도 워커 프로세스(worker.ts) → GCE VM (stepd-worker)
  api/      ⚠️ 레거시 (구 STEPD, Python FastAPI) — 미사용, 새 코드 금지
core/       Python AI 파이프라인 (STT→정제→장면→비전→이름→쇼츠 추천) — 워커가 스폰
admin/      STEP D Lab — core/ 분석 결과 검수 도구 (/lab)
deploy/     배포 스크립트 (deploy-server.ps1 · deploy-web.ps1) + 워커 VM 프로비저닝
docs/       문서 — 시작점: docs/README.md
```

## 시작하기

- **로컬 개발**: [docs/ops/local-dev.md](docs/ops/local-dev.md) — `dev.ps1` 하나로 웹+서버+Postgres 기동
- **문서 전체 지도**: [docs/README.md](docs/README.md) — 현황(ops) / 계획(plans) / 레퍼런스 구분
- **인프라 단일 진실 소스**: [docs/ops/infra.md](docs/ops/infra.md)
- **배포**: [docs/ops/deploy.md](docs/ops/deploy.md)

## 사전 요구

- **Node ≥ 22**, **pnpm**, **Docker Desktop** (로컬 Postgres)
- **ffmpeg / ffprobe** (영상 프로브·썸네일·트림 인코딩)
- AI 파이프라인(core/)을 로컬에서 돌리려면 Python 3.11+ 및 GCP 인증 — docs/ops/local-dev.md 참고

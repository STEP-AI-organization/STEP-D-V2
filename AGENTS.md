# STEP-D — 에이전트 컨텍스트

> **이 파일은 [CLAUDE.md](CLAUDE.md) 를 가리키는 포인터다. 내용은 거기 하나에만 둔다.**
>
> Codex 는 `AGENTS.md` 를, Claude Code 는 `CLAUDE.md` 를 읽는다. 예전에는 같은 내용을
> 두 파일에 복사해 뒀는데, 한쪽만 갱신되면서 **서로 다른 사실을 말하기 시작했다** —
> 2026-08-12 시점에 AGENTS.md 는 3주 낡은 파이프라인(프레임분석 · 워커 VM · SMR 배포)을
> 설명하고 있었고, 링크도 깨져 있었다. 어느 파일을 읽었느냐로 결론이 갈리는 상태가 된다.
>
> 그래서 **사본을 없앴다.** 컨텍스트를 고칠 일이 있으면 `CLAUDE.md` 만 고친다.

## 시작점

1. **[CLAUDE.md](CLAUDE.md)** — 제품 개요 · 모노레포 구조 · 백엔드/프론트 요약 · 작업 규칙
2. **[docs/README.md](docs/README.md)** — 문서 전체 지도 (현황 `ops/` vs 계획 `plans/` 구분)
3. 화면 작업이면 **[apps/web/CLAUDE.md](apps/web/CLAUDE.md)**

## 무엇을 만지는지에 따라

| 고치려는 것 | 어디로 |
|---|---|
| 서버 라우트 | `apps/server/src/index.ts` (한 파일에 유지 — 분리 금지) |
| 워커·잡 | `apps/server/src/worker.ts` · 레인 4개(content/youtube/gebd/naver) |
| AI 파이프라인 | `core/` (파이썬). 서버 접점은 `content-pipeline.ts` 뿐 |
| 화면 | `apps/web/` — ⚠️ 전면 개편 중일 수 있다. CLAUDE.md 작업 규칙 확인 |
| 배포 | `deploy/` — 표준은 `bash deploy/cloud.sh <target>` |
| 개발·실험 스크립트 | `scripts/` ([README](scripts/README.md)) |

⚠️ 구 STEPD(Python FastAPI `apps/api/`)는 **2026-08-12 삭제됐다.** 참고할 일이 있으면 git 이력에서 꺼낸다.

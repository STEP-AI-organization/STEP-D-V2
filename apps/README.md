# apps/ — 사람이 쓰는 것 두 개

| | 무엇 | 스택 | 어디서 도나 |
|---|---|---|---|
| [`web/`](web/) | 운영자 화면 (업로드·추천 검토·편집·배포) | Next.js 16 · React 19 · Tailwind v4 | Vercel · stepd.stepai.kr |
| [`server/`](server/) | HTTP 서버 **+ 잡 워커** | Hono · PostgreSQL · GCS · ffmpeg | Cloud Run · Cloud Run Jobs |

## server 가 둘인 이유

같은 코드베이스인데 **진입점이 두 개**다.

- `src/index.ts` — HTTP 라우트 118개. **Cloud Run 은 잡을 큐잉만 한다.**
- `src/worker.ts` — 워커 프로세스. 레인 4개로 갈라 돈다
  (`content` · `youtube` · `gebd` · `naver`). 무거운 일은 전부 여기서.

무거운 AI 작업은 워커가 [`core/`](../core/README.md) 파이썬을 자식 프로세스로 띄워서 한다 —
접점은 `src/content-pipeline.ts` 하나뿐이다.

⚠️ **라우트는 `src/index.ts` 한 파일에 유지한다**(분리 금지 — CLAUDE.md 규칙).
자세히는 루트 [CLAUDE.md](../CLAUDE.md) · 화면은 [web/CLAUDE.md](web/CLAUDE.md).

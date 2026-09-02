# assets/ — 코드가 읽는 정적 자산

실행 산출물이 아니라 **입력**이다. 사람이 만들어 넣고 코드가 읽는다.

| 폴더 | 무엇 | 누가 읽나 |
|---|---|---|
| `shorts-template/` | 쇼츠 프레임 템플릿 — `overlay.png` + `meta.json`(영역 기하) | 서버 `shorts-template.ts` · 에디터 미리보기 · ffmpeg 렌더 |
| `thumbnail-style/` | 채널별 썸네일 스타일 프로파일·레퍼런스 | `core/thumbnail/*` |
| `fonts/` | 렌더 글꼴 — 제목·자막이 쓰는 한글 폰트 (리포에 **담겨 있다** · [목록·추가 절차](fonts/README.md)) | 서버 `overlay-canvas.ts`(canvas PNG) · `index.ts`(ASS) · Dockerfile → fontconfig |
| `invoice-fonts/` | 지마켓 산스 — 자막 기본 서체 겸 인보이스 PDF 임베드(jsPDF 는 TTF 만 된다) | 위와 같은 `FONT_DIRS` · `invoice.ts` |
| `thumbnail-fonts/` | 썸네일용 한글 폰트 (**gitignore** · 61MB) | Pillow 자막 오버레이 |

`thumbnail-fonts/` 만 리포에 없다 — `scripts/ops/download-fonts.ps1` 로 로컬에 받는다.

쇼츠 템플릿을 추가·갱신하는 절차는 `.claude/skills/shorts-template/SKILL.md`.

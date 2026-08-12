# assets/ — 코드가 읽는 정적 자산

실행 산출물이 아니라 **입력**이다. 사람이 만들어 넣고 코드가 읽는다.

| 폴더 | 무엇 | 누가 읽나 |
|---|---|---|
| `shorts-template/` | 쇼츠 프레임 템플릿 — `overlay.png` + `meta.json`(영역 기하) | 서버 `shorts-template.ts` · 에디터 미리보기 · ffmpeg 렌더 |
| `thumbnail-style/` | 채널별 썸네일 스타일 프로파일·레퍼런스 | `core/thumbnail/*` |
| `thumbnail-fonts/` | 한글 폰트 (**gitignore** · 61MB) | Pillow 자막 오버레이 |

폰트는 리포에 없다 — `scripts/ops/download-fonts.ps1` 로 로컬에 받는다.

쇼츠 템플릿을 추가·갱신하는 절차는 `.claude/skills/shorts-template/SKILL.md`.

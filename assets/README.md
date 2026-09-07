# assets/ — 코드가 읽는 정적 자산

실행 산출물이 아니라 **입력**이다. 사람이 만들어 넣고 코드가 읽는다.
(빌드 산출물·업로드 미디어는 여기 없다 — `storage/` · GCS 로 간다.)

| 폴더 | 무엇 | 누가 읽나 | 리포에 |
|---|---|---|---|
| `fonts/` | **렌더 글꼴** — 제목·자막이 쓰는 한글 폰트 ([목록·추가 절차](fonts/README.md)) | 서버 `overlay-canvas.ts`(canvas PNG) · `index.ts`(ASS) · Dockerfile → fontconfig | ✅ |
| `invoice-fonts/` | 지마켓 산스 — 자막 기본 서체 겸 인보이스 PDF 임베드(jsPDF 는 TTF 만 된다) | 위와 같은 `FONT_DIRS` · `invoice.ts` | ✅ |
| `shorts-template/` | 쇼츠 프레임 템플릿 — `overlay.png` + `meta.json`(영역 기하) | 서버 `shorts-template.ts` · 에디터 미리보기 · ffmpeg 렌더 | ✅ |
| `shorts-template-samples/` | 캔바에서 받아 둔 템플릿 후보 4종 | **아무도 안 읽는다** — 참고용 보관 | ✅ |
| `thumbnail/` | 썸네일 엔진 자산 4종 ↓ | `core/thumbnail/*` | 일부 |

## `thumbnail/` — 썸네일 엔진 자산

2026-09-07 에 `thumbnail-fonts` · `thumbnail-benchmark` · `thumbnail-structure` ·
`thumbnail-style` 네 개를 여기로 묶었다. 최상위에 평평하게 있으면 폰트인지 데이터인지
이름만으로 안 갈렸다.

| | 무엇 | 리포에 |
|---|---|---|
| `thumbnail/fonts/` | 썸네일용 한글 폰트 (Pillow 오버레이) | ❌ **gitignore** |
| `thumbnail/style/` | 채널별 썸네일 스타일 프로파일·레퍼런스 | ✅ |
| `thumbnail/structure/` | 레이아웃 구조 레지스트리 | ✅ |
| `thumbnail/benchmark/` | 벤치마크용 참조 썸네일 | ✅ |

⚠️ **`thumbnail/fonts/` 만 리포에 없다** (61MB 부담 · `.gitignore`).
로컬에서 한 번 받는다: `powershell -File scripts/ops/download-fonts.ps1`

그 스크립트가 받는 건 **6종뿐**이다 — Pretendard 3 · NotoSansKR 2 · NotoSerifKR 1.
`caption_overlay.py` 의 `ROLE_STYLES`·`LANG_FONT_FALLBACK` 이 가리키는 파일은 반드시
**이 6종 안에 있어야 한다.** 없는 파일을 가리키면 Pillow 는 폴백을 안 하고 두부(□)를 그린다
(`caption-lang.test.ts` 가 이름 대조로 고정한다).

> ⚠️ **`Dockerfile.worker` 는 `assets/thumbnail/fonts` 를 복사하지 않는다** (2026-09-07 확인).
> 프로덕션 워커에 썸네일 폰트가 아예 없다는 뜻이다. `AUTO_THUMBNAIL` 이 기본 0 이라
> 아직 안 드러났을 뿐이니, 썸네일 생성을 켜기 전에 이걸 먼저 해결할 것.

---

쇼츠 템플릿을 추가·갱신하는 절차는 `.claude/skills/shorts-template/SKILL.md`.

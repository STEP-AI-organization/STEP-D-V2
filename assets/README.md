# assets/ — 코드가 읽는 정적 자산

실행 산출물이 아니라 **입력**이다. 사람이 만들어 넣고 코드가 읽는다.
(빌드 산출물·업로드 미디어는 여기 없다 — `storage/` · GCS 로 간다.)

| 폴더 | 무엇 | 누가 읽나 | 리포에 |
|---|---|---|---|
| `fonts/` | **글꼴 — 전부 여기 하나** ([목록·추가 절차](fonts/README.md)) | 서버 `overlay-canvas.ts`(canvas PNG) · `index.ts`(ASS) · **썸네일 Pillow** · Dockerfile → fontconfig | ✅ |
| `invoice-fonts/` | 지마켓 산스 — 자막 기본 서체 겸 인보이스 PDF 임베드(jsPDF 는 TTF 만 된다) | 위와 같은 `FONT_DIRS` · `invoice.ts` | ✅ |
| `shorts-template/` | 쇼츠 프레임 템플릿 — `overlay.png` + `meta.json`(영역 기하) | 서버 `shorts-template.ts` · 에디터 미리보기 · ffmpeg 렌더 | ✅ |
| `shorts-template-samples/` | 캔바에서 받아 둔 템플릿 후보 4종 | **아무도 안 읽는다** — 참고용 보관 | ✅ |
| `thumbnail/` | 썸네일 엔진 자산 4종 ↓ | `core/thumbnail/*` | 일부 |

## `thumbnail/` — 썸네일 엔진 자산

| | 무엇 | 리포에 |
|---|---|---|
| `thumbnail/style/` | 채널별 썸네일 스타일 프로파일·레퍼런스 | ✅ |
| `thumbnail/structure/` | 레이아웃 구조 레지스트리 | ✅ |
| `thumbnail/benchmark/` | 벤치마크용 참조 썸네일 | ✅ |

### 폰트는 여기 없다 — `assets/fonts/` 하나뿐이다 (2026-09-07 통합)

예전엔 `thumbnail-fonts/` 가 따로 있었고 **gitignore(76MB)** 였는데, 두 가지가 잘못돼 있었다:

1. **`Dockerfile.worker` 가 그 폴더를 복사하지 않았다** — 프로덕션 워커에 썸네일 폰트가
   아예 없었다. `AUTO_THUMBNAIL` 이 기본 0 이라 드러나지 않았을 뿐이다.
2. 13개 중 9개가 `assets/fonts/` 와 **중복**이었다.

합치면서 Noto 3종(56MB)을 버렸다 — 베트남어 대체용이었는데 이미 있는
**Pretendard-Black/Bold 가 베트남어를 100% 덮는다**(cmap 실측). 새로 담은 건
`GowunBatang-Bold.ttf`(7.8MB) 하나다.

이제 `Dockerfile`·`Dockerfile.worker` 가 이미 복사하는 `assets/fonts` 에 전부 들어 있어
**프로덕션에서도 그대로 쓰인다.** `caption-lang.test.ts` 가 세 가지를 고정한다 —
역할 기본 글꼴이 리포에 있는지 · 대체표가 가리키는 게 리포에 있는지 · Dockerfile 이 복사하는지.

---

쇼츠 템플릿을 추가·갱신하는 절차는 `.claude/skills/shorts-template/SKILL.md`.

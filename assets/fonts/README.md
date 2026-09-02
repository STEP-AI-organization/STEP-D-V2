# assets/fonts — 렌더 글꼴 (리포에 **담겨 있다**)

`thumbnail-fonts/`(gitignore)와 달리 여기 파일은 커밋돼 있다. Dockerfile 이
`/usr/share/fonts/opentype/pretendard` 와 `assets/fonts` 두 곳으로 COPY 하고 `fc-cache` 를
돌린다 — 빠지면 libass 가 **오류 없이 Noto 로 대체**해 글꼴만 다른 결과물이 조용히 나간다.

읽는 곳: `overlay-canvas.ts`(canvas 정적 오버레이 PNG) · `index.ts`(ASS 자막·애니메이션 제목) ·
`mogrt.ts`(프리미어 그래픽 — PostScript 이름을 파일에서 직접 읽는다).

## 목록 · 출처 · 라이선스

| 파일 | 글꼴 | 출처 | 라이선스 |
|---|---|---|---|
| `Pretendard-{Bold,ExtraBold,Black}.otf` | 프리텐다드 | [orioncactus/pretendard](https://github.com/orioncactus/pretendard) | SIL OFL 1.1 |
| `BlackHanSans-Regular.ttf` | 검은고딕 | Google Fonts | SIL OFL 1.1 |
| `DoHyeon-Regular.ttf` | 도현 | Google Fonts | SIL OFL 1.1 |
| `Jua-Regular.ttf` | 주아 | Google Fonts | SIL OFL 1.1 |
| `GothicA1-{Bold,Black}.ttf` | 고딕A1 | Google Fonts | SIL OFL 1.1 |
| `Paperlogy-8ExtraBold.ttf` | 페이퍼로지 | [freesentation.blog/paperlogyfont](https://freesentation.blog/paperlogyfont) | 무료 상업용(폰트 파일 자체 판매 금지) |
| `GangwonEduModu-Bold.otf` | 강원교육모두 | [강원특별자치도교육청](https://blog.naver.com/happygwedu/221897547714) | 무료 상업용(출처 표기 · 재판매 금지) |
| `Recipekorea.ttf` | 레코체 | [레시피코리아](https://recipekorea.com/bbs/board.php?bo_table=ld_0308&wr_id=2479) | 무료 상업용(폰트 파일 자체 거래 금지) |

지마켓 산스는 인보이스 PDF 와 공유하느라 `assets/invoice-fonts/` 에 있다(같은 FONT_DIRS).

## 추가 절차

`overlay-canvas.ts` 의 `FONT_FAMILIES` 주석이 정본. 요약하면 **네 군데가 같이 움직인다**:

1. 폰트 파일 → `assets/fonts/`(서버 렌더) + `apps/web/public/fonts/`(편집 중 CSS 미리보기 · **woff2 권장**)
2. `overlay-canvas.ts` `FONT_FAMILIES` 항목
3. `index.ts` `ASS_FONT_BY_ID` — 값은 **폰트 파일이 신고하는 패밀리명**(짐작 금지)
4. `apps/web` `presets.ts` `FONT_FAMILY_OPTIONS` + `globals.css` `@font-face`

`caption-font.test.ts` 가 네 군데를 서로 대조한다 — 이름은 파일의 `name` 테이블에서 읽어서 맞춘다.
파일명과 내부 패밀리명이 다른 경우가 실제로 있다(예: `GangwonEduModu-Bold.otf` → `GangwonEduAll Bold`).

## 웨이트를 한 종만 담는 이유

제목 줄은 항상 `weight: 800` 으로 그린다(`index.ts`). 나머지 웨이트는 스냅으로 밀려나 쓰이지
않으므로, 디스플레이 글꼴은 가장 굵은 한 종만 담아 이미지 크기를 아낀다.

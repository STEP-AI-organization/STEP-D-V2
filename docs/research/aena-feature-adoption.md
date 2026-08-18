# AENA → STEP-D 에디터/텍스트·오버레이 기능 채택 우선순위

> 2026-08-18 작성. 목적: AENA(사내 실서비스 참고 구현) 에디터의 **텍스트·오버레이 기능**을 훑어
> STEP-D 가 없거나 못 하는 것을 골라, **가치/노력 순으로 채택 리스트**를 만든다. 사용자가 콕 집은
> **텍스트 색깔**과 **글꼴 선택/변환("글꼴 변환")** 을 맨 위에 두고, 구체 구현안(추가할
> `EditorState` 필드 · `overlay-canvas.ts` 소비 방식 · 에디터 픽커 · 에디터↔렌더 파리티)까지 적는다.
> **코드 변경 없음 — 이 문서 하나만 작성.** 인용은 전부 `파일:줄`.
> 선행 문서: [aena-overlay-aspect-analysis.md](aena-overlay-aspect-analysis.md)(오버레이/종횡비 — 이미 채택 완료:
> 종횡비 5-값 enum + 하이브리드 canvas→PNG 텍스트 오버레이).
>
> **핵심 맥락:** STEP-D 는 이제 제목·채널 배지 텍스트를 **canvas→PNG**(`@napi-rs/canvas`)로 굽는다
> (`apps/server/src/overlay-canvas.ts` · `buildStaticOverlayItems` `index.ts:4432`). 즉 색·폰트·스트로크·
> 그림자 같은 리치 텍스트 스타일이 **이제 싸다** — ASS 문법을 손대지 않고 `ctx.fillStyle` /
> `registerFromPath` / `ctx.strokeText` 한 줄이면 된다. 아래 리스트는 어느 항목이 이 새 PNG 경로 덕에
> 값싼지 표시한다.

---

## 0. 한눈 요약 (가치/노력 순)

| 순위 | 항목 | STEP-D 현재 | 노력 | canvas-PNG 로 싸지나 | 한 줄 |
|-----|------|------------|------|--------------------|------|
| **1** | **텍스트 색깔 — 커스텀 색 입력** | 부분(고정 스와치 6색뿐) | **S** | — (색은 이미 파이프 통과) | `<input type="color">` 만 붙이면 임의 색. 렌더 변경 0 |
| **2** | **글꼴 선택/변환 (글꼴 변환)** | **없음** | **M** | ✅ 렌더는 `registerFromPath`+`ctx.font` | 폰트 파일 몇 개 번들 + 픽커 + `font` 필드 |
| 3 | 스트로크/아웃라인 (제목·채널) | 부분(자막만 ASS 스트로크) | S–M | ✅ `ctx.strokeText` 한 줄 | 정적 오버레이 PNG 에 외곽선 필드 추가 |
| 4 | 요소(element) 색상 필드 | 없음(타입별 하드코딩) | S | — | `EditorElement.color` 추가 + 스와치 |
| 5 | 한 줄 안 다색 (per-run color) | 없음(줄당 1색) | M–L | ✅ 렌더는 세그먼트 루프 | 에디터 UX(선택 영역)+ASS 파리티가 값 |
| 6 | 자유 이미지/스티커 오버레이 | 없음(채널 아이콘·배경만) | L | 부분 | 새 오버레이 타입 + 드래그/리사이즈/z-order |
| 7 | 정적 회전 필드 · 폰트 웨이트 픽커 | 회전=키프레임만 · 웨이트=하드코딩 | S | ✅ | 낮은 가치 · 곁다리 |

> **STEP-D 가 이미 AENA 보다 나은 것(§8 · 채택하면 오히려 후퇴):** 키프레임 애니메이션 · 시간창
> (startSec/endSec) · 자막 10종 + 단어별 강조/키워드 색 · 영상 필터 · 멀티트랙 · 속도 램프 · 전환 ·
> 프레임 템플릿 · AI 리프레임. AENA 텍스트 오버레이는 **전부 정적**(애니메이션·시간축 없음)이다.

---

## 1. 텍스트 색깔 — 커스텀 색 입력 (★ 최우선, 노력 S)

### AENA
- 텍스트 색: 프리셋 **8색** + **네이티브 색 선택기**(`<input type="color">`) 둘 다 제공
  (`overlay-panel.tsx:10` `COLOR_PRESETS`, `:160-162` color input). 값은 `#rrggbb` 로 저장
  (`OverlayData.color`, `text-overlay-layer.tsx:28`).
- 외곽선 색도 별도 색 선택기(`overlay-panel.tsx:221-227`).

### STEP-D 현재 — 부분(HAVE, 그러나 고정 팔레트)
- **줄별 제목 색은 이미 end-to-end 로 흐른다:** `TitleLine.color`(`presets.ts:130`) → 에디터 스와치
  (`editor-panel.tsx:317` `Swatches colors={COLOR_SWATCHES}`) → 프리뷰 `line.color`
  (`editor-preview.tsx:426`) → canvas-PNG `color: L.colorHex`(`index.ts:4442`) →
  `ctx.fillStyle = it.color`(`overlay-canvas.ts:157`). ASS 폴백도 `hexToAss`.
- 자막 색도 있음: `highlightColor`·`keywordColor`·`captionColor`(`presets.ts:334,335,342`).
- **한계:** 색 선택이 **고정 스와치 6색뿐**이다 — `COLOR_SWATCHES = ["#FFFFFF","#FFD400","#27E0A0",
  "#5B8CFF","#FF49DB","#16120D"]`(`presets.ts:394`). 임의 hex 입력·색 선택기가 **어디에도 없다**
  (`editor-panel.tsx` 전역에 `input type="color"` 0건).

### 채택안 (S · 렌더 변경 0)
색은 이미 `#rrggbb` 로 파이프 전체를 통과하므로 **UI 한 곳만** 손대면 된다. 렌더/ASS/canvas 무변경.

1. `Swatches`(`editor-panel.tsx:182`) 옆에 커스텀 색 컨트롤을 추가하거나 `Swatches` 자체에
   `<input type="color" value={value} onChange={e => onPick(e.target.value)} />` 를 끼운다.
   → 제목 색·자막 색·강조/키워드 색·배경 스와치까지 **한 컴포넌트로 전부** 임의 색 지원.
2. (선택) `COLOR_SWATCHES` 에 방송 상용색 몇 개 추가(현재 6 → 8~10). AENA 8색을 참고.

**파일:** `apps/web/src/lib/editor/presets.ts`(스와치 배열), `apps/web/src/components/editor/editor-panel.tsx`
(`Swatches` 프리미티브 1곳 수정 → 제목·자막·배경 탭 전부에 전파).

---

## 2. 글꼴 선택 / 변환 ("글꼴 변환") (★ 최우선, 노력 M)

### AENA
- 모든 텍스트 오버레이가 `fontFamily`(`edit-project.entity.ts:76`) + `fontWeight`(`:75`) 필드를 가짐.
- 에디터에 **폰트 `<select>`** 와 **웨이트 `<select>`**(`overlay-panel.tsx:129-148`,
  `FONT_WEIGHTS = [100,200,400,600,800,900]`).
- 렌더는 weight→OTF 파일 **9종 매핑**(`text-render.service.ts:13-23`, `HGGGothicssi_Pro_00g..99g.otf`)
  후 `GlobalFonts.registerFromPath(file, family)`(`:32-34`) → `ctx.font = "${px}px ${family}, …emoji…"`
  (`:65`).
- ⚠️ 단, AENA 는 **실제로 1개 패밀리만 등록**한다(`overlay-panel.tsx:8` `FONT_FAMILIES=["HGGGothicssi"]`
  + 주석 "다른 폰트 선택 시 프리뷰와 인코딩 결과가 어긋남"). 즉 AENA 도 "글꼴 변환"은 **웨이트 변환**이
  전부다. **여기서 STEP-D 가 AENA 를 넘어설 여지가 있다** — 진짜 다패밀리를 넣는 것.

### STEP-D 현재 — 없음(MISSING)
- **폰트 패밀리 개념이 에디터·모델·렌더 어디에도 없다.** `TitleLine`(`presets.ts:126`)·`EditorElement`
  (`:145`)·`ChannelExtraLine`(`:138`)에 `font` 필드 없음.
- canvas-PNG 는 **Pretendard 3웨이트만** 하드코딩 등록: `FONT_FILES = {700:Bold, 800:ExtraBold,
  900:Black}`(`overlay-canvas.ts:54-63`), 등록 후 아이템 weight 로 스냅(`snapWeight` `:84`). 아이템별
  weight 도 **호출부에서 하드코딩**(제목 `weight:800` `index.ts:4442` · 채널 `weight:700` `:4453`).
- ASS 폴백도 "Pretendard ExtraBold" 하드코딩(선행 문서 §3.1, `index.ts:4348` 부근).
- 번들된 폰트 파일: `assets/fonts/` 에 **Pretendard-Bold.otf · Pretendard-ExtraBold.otf ·
  Pretendard-Black.otf 3개뿐**(`overlay-canvas.ts:70-73` `FONT_DIRS` 가 로컬 `assets/fonts` +
  컨테이너 `/usr/share/fonts/opentype/pretendard` 양쪽 커버).

### 채택안 (M · canvas-PNG 가 렌더 측을 값싸게)
canvas 는 `registerFromPath(파일, 패밀리)` + `ctx.font = "px \"패밀리\""` 가 전부다 — **AENA 와 똑같은
메커니즘**. 일은 (a) 폰트 파일 번들, (b) 모델 `font` 필드, (c) 픽커, (d) 프리뷰 파리티 4가지.

**(a) 폰트 파일 번들 — 선행 조건.** 지금은 Pretendard 하나뿐이라 "변환"할 대상이 없다. `assets/fonts/`
에 OFL 라이선스 한국어 디스플레이 폰트 2~4종을 넣는다(예: 임팩트 예능=BlackHanSans/GmarketSans Bold,
명조=본명조/나눔명조, 손글씨=나눔손글씨). `deploy/` Dockerfile 의 폰트 COPY + `fc-cache` 경로에도
추가(컨테이너에서 libass·fontconfig 가 보게). `FONT_DIRS`(`overlay-canvas.ts:70`)는 이미 두 경로를
커버하므로 파일만 떨구면 된다.

**(b) 모델 — `EditorState` 필드.** `TitleLine`(그리고 필요시 `EditorElement`·`ChannelExtraLine`)에
```ts
// presets.ts TitleLine 인터페이스에 추가
font?: string;   // 패밀리 id (예: "pretendard" | "blackhansans" | "gmarket"). 미설정 = 기본 Pretendard
```
(캡션 폰트는 ASS 경로라 별도 — 아래 파리티 참고. 우선 제목/채널만 다패밀리로.)

**(c) overlay-canvas 소비.** `FONT_FILES`/`FONT_FAMILY`(단일 패밀리 map)를 **패밀리별 레지스트리**로
확장:
```ts
// overlay-canvas.ts — 개념
const FONTS: Record<string /*family id*/, Record<number /*weight*/, {file:string; family:string}>> = {
  pretendard:   { 700:{file:"Pretendard-Bold.otf",   family:"Pretendard Bold"}, 800:{...}, 900:{...} },
  blackhansans: { 400:{file:"BlackHanSans-Regular.otf", family:"Black Han Sans"} },
  gmarket:      { 700:{file:"GmarketSansBold.otf",   family:"Gmarket Bold"} },
};
```
`loadCanvas()`(`overlay-canvas.ts:95`)가 모든 패밀리를 `registerFromPath`. `OverlayTextItem`
(`:23`)에 `fontFamilyId?: string` 추가 → `renderTextLayerPng`(`:127`)의 `ctx.font` 조립부(`:142`)가
`registered` 에서 해당 패밀리를 고른다(미등록·미설정이면 지금처럼 Pretendard→sans-serif 폴백). weight
스냅(`snapWeight` `:84`)은 패밀리별 보유 웨이트 집합으로 일반화.

**(d) 정본이 값을 넘긴다.** `buildStaticOverlayItems`(`index.ts:4432`)가 `L.t.font` 를 읽어 아이템에
`fontFamilyId` 로 실어 보낸다(좌표 정본은 계속 index.ts — overlay-canvas 는 그리기만, `:10` 주석 규칙 유지).

**(e) 에디터 픽커.** `TextTab`(`editor-panel.tsx:269`)에 AENA 처럼 `<select>` 추가(패밀리 목록은 상수
또는 서버 제공). 줄별로 `setLine(id, { font })`.

**(f) 에디터↔렌더 파리티(제일 신경 쓸 곳).** 프리뷰는 CSS/DOM 이라 브라우저가 같은 폰트를 가져야
`line.color`/`fontSize` 처럼 폰트도 미리보기=결과물이 된다. 두 방법:
- **globals.css `@font-face`** 로 같은 OTF 를 웹폰트로 로드하고 프리뷰 텍스트에 `fontFamily` 적용
  (`editor-preview.tsx:425` `font` 객체에 `fontFamily` 추가).
- **더 강한 파리티(권장):** STEP-D 는 이미 **정적 제목일 때 서버 canvas-PNG 를 그대로 `<img>`** 로
  보여준다(`editor-preview.tsx:388` `showOverlayPng`). 그래서 폰트가 브라우저에 없어도 **PNG 는 항상
  정확**하다 — 폰트 파리티 문제의 상당 부분을 구조적으로 회피한다. CSS 근사는 편집 중(드래그·더블클릭)
  에만 보이므로 `@font-face` 는 "있으면 좋음" 수준.
- **ASS 폴백:** canvas 로드 실패 시에만 타는 경로(`index.ts:4954` `overlayCanvasAvailable()` 분기).
  다패밀리를 ASS 까지 반영하려면 familyId→ASS fontname 매핑 + libass 용 폰트 설치가 필요하나, PNG 가
  1차라 폴백은 Pretendard 로 열화(degrade)해도 무방. 처음엔 폴백을 Pretendard 고정으로 두는 게 안전.

**요약 파일:** `assets/fonts/*`(신규 폰트) · `deploy/` Dockerfile(폰트 COPY/fc-cache) ·
`apps/web/src/lib/editor/presets.ts`(`TitleLine.font`) · `apps/server/src/overlay-canvas.ts`(패밀리
레지스트리 + `OverlayTextItem.fontFamilyId`) · `apps/server/src/index.ts`(`buildStaticOverlayItems`
에서 `font` 전달) · `apps/web/src/components/editor/editor-panel.tsx`(픽커) · `apps/web/globals.css`
(선택 `@font-face`).

**폰트 픽커가 제안할 목록(예):** 기본 = Pretendard(현행) / 임팩트(예능 훅) / 명조(드라마·감성) /
손글씨(밈). 실제 후보는 라이선스(OFL) 확인 후 번들.

---

## 3. 스트로크 / 아웃라인 — 제목·채널 (노력 S–M · canvas 로 값쌈 ✅)

### AENA
텍스트 오버레이별 `strokeColor` + `strokeWidth`(`edit-project.entity.ts:79-80`), 렌더는
`ctx.lineJoin='round'; ctx.strokeText()` 후 `fillText()`(`text-render.service.ts:130-139`), 에디터에
외곽선 폭 + 색 컨트롤(`overlay-panel.tsx:214-228`), 프리뷰는 `WebkitTextStroke`(`text-overlay-layer.tsx:171`).

### STEP-D 현재 — 부분
- **자막(caption)은** ASS 스타일로 스트로크가 이미 있다(`korean_pop` 등 `\bord\3c`, 프리뷰
  `WebkitTextStroke` `editor-preview.tsx:56`).
- **정적 오버레이(제목·채널)는 스트로크가 없다.** `OverlayTextItem`(`overlay-canvas.ts:23-41`)에
  stroke 필드 자체가 없고, `renderTextLayerPng` 는 **그림자만** 세팅(`:146-159`) — `strokeText` 호출 0.
  프리뷰 제목도 그림자만(`editor-preview.tsx:430` `textShadow`, 스트로크 없음).

### 채택안 (canvas 가 trivial)
- `OverlayTextItem` 에 `stroke?: { color: string; width: number }` 추가(`overlay-canvas.ts:23`).
- `renderTextLayerPng` 에서 `fillText` 앞에 `ctx.lineJoin="round"; ctx.strokeStyle; ctx.lineWidth;
  ctx.strokeText()`(AENA `text-render.service.ts:130-139` 그대로) — **캔버스 3~4줄**.
- `TitleLine` 에 `strokeColor?`/`strokeWidth?` (또는 캡션스타일처럼 프리셋). `buildStaticOverlayItems`
  가 실어 보냄. 프리뷰는 `WebkitTextStroke`(자막이 이미 쓰는 패턴).
- ASS 폴백은 제목 Style 에 `\bord\3c` 추가(이미 자막이 쓰는 문법).

**가치:** 방송 훅 텍스트는 배경 영상 위 가독성 때문에 외곽선 수요가 큼. 지금은 그림자로만 버팀.

---

## 4. 요소(element) 색상 필드 (노력 S)

### STEP-D 현재 — 없음
`EditorElement`(`presets.ts:145`)에 `color`/`bg` 필드가 없다. 프리뷰가 **타입별로 색을 하드코딩**:
CTA=`state.accent`, 스티커=`#FFD400`, 나머지 흰 배경(`editor-preview.tsx:633-634`). 사용자가 스티커·
말풍선·화살표 색을 못 바꾼다.

### 채택안
`EditorElement` 에 `color?: string`(글자색) · `bg?: string`(칩 배경) 추가 → `ElementsTab`
(`editor-panel.tsx:821`)에 `Swatches`(+§1 커스텀 색) → 프리뷰 하드코딩(`editor-preview.tsx:633`)을
`el.color ?? 기본`으로 → 요소를 굽는 ASS 분기(`buildEditorAss` 데코레이션)에도 색 반영. 노력 S(요소는
드래그·키프레임 배선이 이미 있어 색 필드만 얹으면 됨).

---

## 5. 한 줄 안 다색 — per-run color (노력 M–L · 렌더는 값쌈 ✅)

### AENA
한 줄 안에서 **선택한 글자만** 색을 바꾼다: `contenteditable` + `document.execCommand("foreColor")`
로 인라인 `<font color>` HTML 을 만들고(`overlay-panel.tsx:61-81` `applyColor` + selection 추적
`:41-59`), 렌더는 `parseHtmlToSegments`(`text-render.service.ts:210-260`)로 세그먼트 분해 후
**세그먼트별 `fillStyle` + x 전진**(`:128-141`).

### STEP-D 현재 — 없음
`TitleLine.color` 는 **줄 전체 1색**. 강조는 "2줄이면 둘째 줄만 색"(hook2, `editor-panel.tsx:669-676`)
규칙으로 대체 — 즉 색 단위가 **줄**이다. 줄 안 부분 색 없음.

### 채택안 (렌더 측만 싸다)
- **렌더(캔버스)는 AENA 를 그대로 이식하면 쉽다:** `OverlayTextItem` 을 `runs: {text,color}[]` 로
  일반화하고 `renderTextLayerPng` 에 세그먼트 루프(measureText 로 x 전진 + fillStyle) 추가 — AENA
  `text-render.service.ts:128-141` 판박이.
- **비싼 건 에디터 UX + ASS 파리티:** ① 저장 모델을 HTML/`runs` 로 바꾸고(`TitleLine.text` 파서 or
  새 필드) ② 프리뷰가 그 HTML 을 렌더(현재 plain text) ③ ASS 폴백이 런별 `{\c}` 를 뿜게 — 3경로 동기화.
- **판단:** STEP-D 의 "줄=색 단위" 컨벤션(2줄 훅)이 방송 쇼츠 수요의 대부분을 이미 커버한다. per-run 은
  **여유 있을 때** — 값어치보다 파리티 비용이 크다. 당장은 §1(커스텀 색) + §4(요소 색)로 충분.

---

## 6. 자유 이미지 / 스티커 오버레이 (노력 L)

### AENA
임의 이미지 오버레이: 업로드(`page.tsx:1229` "🖼 이미지") → 드래그 이동 + **모서리 리사이즈**
(`image-overlay-layer.tsx:106-140`) + **z-order 스왑**(`image-overlay-panel.tsx:93-99`, entity
`zIndex`) + 투명도 + 회전. 렌더는 이미지 오버레이를 ffmpeg `overlay=x:y` 로 합성.

### STEP-D 현재 — 없음(부분 인프라만)
- 임의 이미지/스티커 오버레이 타입이 없다. "요소(elements)"는 **텍스트/이모지 칩**(cta·sticker·arrow·
  bubble, `presets.ts:36`)이지 이미지가 아니다.
- 단, **이미지 합성 배관은 있다:** 채널 아이콘 PNG 를 렌더에서 합성하고(선행 문서 §3.1, 채널 아이콘
  오버레이), 배경 이미지(`bgImageDataUrl`)도 있다. 즉 "이미지를 프레임 위에 얹는" 경로 자체는 존재.

### 채택안
새 오버레이 타입(`ImageElement { id, dataUrl/fileId, x,y,w,h,opacity,rotation,z }`) + 드래그/리사이즈
레이어(AENA `image-overlay-layer.tsx` 이식, STEP-D `Movable` 프리미티브 재사용) + 렌더 `overlay=`
합성(채널 아이콘 경로 확장). 노력 L. **가치:** 방송 로고·스폰서 배지·밈 스티커. 우선순위는 색·폰트
다음. base64 저장이면 `editorState` 페이로드 비대(에디터가 이미 아이콘/배경에 256KB·2MB 상한을 둠,
`editor-panel.tsx:391,776` 참고) — 파일 업로드로 가는 게 안전.

---

## 7. 곁다리 — 정적 회전 · 폰트 웨이트 픽커 (노력 S, 낮은 가치)

- **정적 회전 필드:** AENA 오버레이는 정적 `rotation`(`edit-project.entity.ts:64`). STEP-D 는 회전이
  **키프레임 안에만** 있다(`KeyframePoint.rotation` `presets.ts:44`, 프리뷰 `rotate(kf.rotation)`
  `editor-preview.tsx:442`). 키프레임 없이 "그냥 15° 기울이기"가 안 된다. `TitleLine`/`EditorElement`
  에 `rotation?` 정적 필드 추가하면 S. 방송 쇼츠 수요는 낮음.
- **폰트 웨이트 픽커:** AENA 는 웨이트 `<select>`(100~900). STEP-D 는 제목 800·채널 700 **하드코딩**
  (`index.ts:4442,4453`). Pretendard 3웨이트(700/800/900)는 이미 번들돼 있으니(`overlay-canvas.ts:54`)
  `TitleLine.weight?` + 픽커로 노출하면 S. §2(폰트) 작업에 자연히 딸려감.

---

## 8. STEP-D 가 이미 더 나은 것 — 채택하지 말 것(후퇴 주의)

AENA 텍스트 오버레이는 **정적**이다(`BaseOverlay` 에 시간·키프레임 필드 없음, `edit-project.entity.ts:56-67`).
아래는 STEP-D 우위 — AENA 를 따라가면 오히려 잃는다:
- **키프레임 애니메이션**(in/out·scale·opacity·rotation): `KeyframePoint`(`presets.ts:38`) + 편집기
  (`editor-panel.tsx:900` `KeyframeSection`) + 프리뷰 보간(`editor-preview.tsx:423`). AENA **없음**.
- **시간창**(`startSec`/`endSec` per overlay): `presets.ts:133-134`. AENA **없음**.
- **자막 10종 + 단어별 강조/키워드 색**: `CAPTION_STYLES`(`presets.ts:381`) · ASS 단어별 색
  (`buildEditorAss`). AENA 는 자막 스타일 개념이 약함.
- **영상 필터**(밝기/대비/채도/색온도): `FilterSettings`(`presets.ts:104`) · `FiltersTab`.
- **멀티트랙 · 속도 램프 · 전환**(`EditorTrack`·`SpeedPoint`·`TrackTransition`, `presets.ts:210-262`).
- **프레임 템플릿(캔바) + 종횡비 5-값 enum SSOT**(선행 문서에서 이미 채택).
- **AI 리프레임**(피사체 추적 crop, `reframe`).

---

## 9. 인용 색인 (핵심 파일:줄)

**AENA**
- 텍스트 오버레이 모델: `src/server/entities/edit-project.entity.ts:56-91`(`BaseOverlay`·`TextOverlay`·
  `ImageOverlay`; 정적=시간/키프레임 없음)
- 텍스트 편집 패널(색·폰트·웨이트·정렬·외곽선·투명도·너비): `.../editor/_components/overlay-panel.tsx:8-10`
  (FONT_FAMILIES 1개·WEIGHTS 6·COLOR 8), `:61-81`(per-run foreColor), `:129-148`(폰트·웨이트 select),
  `:152-167`(색: 프리셋+color input), `:214-228`(외곽선)
- 텍스트→PNG 렌더: `src/server/services/text-render.service.ts:13-23`(weight→OTF 9종), `:32-34`
  (registerFromPath), `:65`(ctx.font), `:128-141`(세그먼트별 stroke+fill), `:210-260`
  (`parseHtmlToSegments`=per-run 색)
- 이미지 오버레이(드래그/리사이즈/z-order): `.../image-overlay-layer.tsx:106-140`,
  `.../image-overlay-panel.tsx:93-99`; 추가 버튼 `.../editor/[id]/page.tsx:1228-1229`
- 기본 오버레이 값: `.../editor/[id]/page.tsx:421-431`(fontWeight 600·color #fff·family HGGGothicssi·rotation 0)

**STEP-D**
- 정적 오버레이 canvas 렌더: `apps/server/src/overlay-canvas.ts:23-41`(`OverlayTextItem` — stroke 필드
  없음), `:54-63`(Pretendard 3웨이트만), `:70-73`(FONT_DIRS), `:95-116`(registerFromPath), `:142`
  (ctx.font 조립), `:146-159`(그림자만·strokeText 없음), `:157`(fillStyle)
- 정본 아이템 빌더: `apps/server/src/index.ts:4432-4458`(`buildStaticOverlayItems` — 제목 weight 800·색
  L.colorHex / 채널 weight 700·색 #fff 하드코딩), `:4370-4421`(`layoutTitleLines`), `:7644-7694`
  (overlay-png 엔드포인트 · 해시 캐시)
- EditorState 모델: `apps/web/src/lib/editor/presets.ts:126-135`(`TitleLine` — color 있음·font/stroke/
  rotation 없음), `:145-156`(`EditorElement` — color 없음), `:394`(`COLOR_SWATCHES` 6색), `:334-342`
  (자막 색 필드들)
- 편집 패널: `apps/web/src/components/editor/editor-panel.tsx:182-196`(`Swatches` — color input 없음),
  `:269-366`(TextTab · 줄별 색 스와치), `:821-897`(ElementsTab · 색 컨트롤 없음)
- 프리뷰 파리티: `apps/web/src/components/editor/editor-preview.tsx:425-445`(제목 CSS — color/shadow,
  stroke·font 없음), `:388-396`(정적 오버레이 PNG `<img>` = 폰트 파리티 구조적 회피),
  `:633-634`(요소 색 하드코딩)
- 번들 폰트: `assets/fonts/Pretendard-{Bold,ExtraBold,Black}.otf` (3개뿐)
- ASS 폴백: `apps/server/src/index.ts:4460-4477`(`buildEditorAss` · staticToPng 분기), `:4954`
  (`overlayCanvasAvailable()` → PNG vs ASS)

# AENA 대비 STEP-D — 텍스트 오버레이 · 종횡비/크롭 모델 분석 + 권고

> 2026-08-18 작성. 목적: AENA(사내 실서비스 참고 구현) 에디터/렌더의 **텍스트 오버레이 합성**과
> **종횡비·크롭 정의**를 정확히 파악하고, STEP-D 의 현재 모호함을 진단해 **명확한 비율 모델**을
> 제안한다. **코드 변경 없음 — 이 문서 하나만 작성.** 인용은 전부 `파일:줄` 로 근거를 단다.
> AENA 경로는 `C:\Users\STEPAI05\aena` (읽기 전용 레퍼런스), STEP-D 는 이 리포.

---

## 0. 한눈 요약

| 축 | AENA | STEP-D (현재) |
|----|------|---------------|
| 비율 어휘 | **단일 enum** `16:9 / 9:16-letterbox / 9:16-crop-main / 9:16-crop-sub` — 클라·서버 공유 (`src/lib/aspect-presets.ts:12`) | **두 개의 분리된 어휘** — `clip.aspectRatio`(4값, 라벨 전용) vs `editorState.aspect(4값)+fit(2)+bgType(3)`(렌더 실사용) |
| crop 모델 | 비디오가 **캔버스 안의 사각형**(videoX/Y/W/H)에 앉고 나머지는 검정 pad. main/sub = 사각형 높이 차이 | crop = `fit:"cover"` **전체화면 중앙 크롭** 하나뿐. 사각형·밴드·crop-sub 개념 없음 |
| 텍스트 렌더 | **canvas→PNG** 를 이미지 오버레이로 합성 (`@napi-rs/canvas`). drawtext 는 코드에 있으나 export 경로 **미사용** | **ASS/libass** Dialogue 이벤트를 ffmpeg `ass=` 필터로 번인 (`buildEditorAss`) |
| WYSIWYG | 프리뷰가 **서버 렌더 PNG 자체를 `<img>`** 로 표시(해시 캐시 공유) → 픽셀 동일 | 프리뷰는 **DOM/CSS**, 렌더는 ASS — 두 수학을 **손으로 맞춘 파리티**(주석마다 "미리보기와 일치" 튜닝) |

**STEP-D 모호함의 핵심:** ① `9:16-crop-main`·`9:16-crop-sub`·`9:16-letterbox` 세 값이 **렌더에서
구분되지 않는다**(`normalizeAspect` 가 전부 `9:16` 로 뭉갠다), ② `9:16-crop-sub` 는 **어휘에만 있고
어디서도 배정되지 않는 죽은 값**, ③ 채택 라벨(`메인 크롭`)과 에디터의 실제 채움 축(`맞춤/채우기` +
`solid/blur/image`)이 **서로 다른 어휘**라 라벨↔동작이 어긋난다.

---

## 1. AENA — 텍스트 오버레이 기술

### 1.1 렌더 경로: canvas→PNG 이미지 합성 (drawtext 아님)

export 잡은 텍스트를 **투명 PNG 로 렌더한 뒤 이미지 오버레이로** ffmpeg 에 넘긴다. drawtext 는
쓰지 않는다.

- `src/server/jobs/export-clip.job.ts:82` — `renderTextOverlaysAsImages(clip, ...)` 로 텍스트를 PNG 화.
- `src/server/jobs/export-clip.job.ts:91-100` — `encodeWithOverlays(joinedPath, encodedPath, aspectRatio, [], allImageOverlays, ...)`.
  **네 번째 인자(textOverlays)가 `[]`** — drawtext 텍스트는 넘기지 않는다. 텍스트는 전부 `allImageOverlays` 로.
- `src/server/services/ffmpeg.service.ts:641-650` 에 `drawtext=fontfile=...:text=...` 분기가 **존재하지만**,
  export 경로가 textOverlays 를 비워 호출하므로 **사실상 죽은 코드**. 실제 합성은
  이미지 오버레이 분기(`ffmpeg.service.ts:621-638`)의 `overlay=x:y` 로만 이뤄진다.

**텍스트→PNG 렌더** (`src/server/services/text-render.service.ts`):
- `@napi-rs/canvas` 의 `createCanvas` + `GlobalFonts.registerFromPath` (`text-render.service.ts:32-34`).
- 폰트: `HGGGothicssi_Pro_*.otf` 를 weight→파일로 매핑(`text-render.service.ts:13-23`), `public/fonts/`.
- 줄바꿈: **글자 단위** wrap (`wrapSegments`, `text-render.service.ts:155-197`) — 한국어는 공백 분할이
  안 돼 유니코드 문자 단위로 `measureText` 하며 접는다.
- 스트로크/그림자: `ctx.strokeText`(lineJoin='round') 후 `ctx.fillText` (`text-render.service.ts:130-139`).
- 인라인 색: `<font color>`·`<span style="color">` HTML 을 세그먼트로 파싱해 **한 줄 안 다색** 지원
  (`parseHtmlToSegments`, `text-render.service.ts:210-260`).
- baseline 계산으로 CSS line-box 와 동일 배치(`text-render.service.ts:96-106`).

### 1.2 좌표계 (v2): 출력 해상도 절대 px

- `src/lib/overlay-coord.ts:26-33` — `resolveTargetResolution`: `16:9→1920×1080`, 그 외 `1080×1920`.
- 오버레이는 이 target 해상도 기준 **절대 px** 로 x/y/width/fontSize 를 저장(v2).
- v1(퍼센트+CSS px) → v2 마이그레이션: `overlay-coord.ts:55-92`. fontSize 는 `target.width / refW`
  배율로 스케일(16:9 refW=640, 9:16 refW=360, `overlay-coord.ts:30-32`).

### 1.3 WYSIWYG: 프리뷰가 곧 렌더 PNG (해시 캐시 공유)

이게 AENA WYSIWYG 의 정수다 — 프리뷰와 export 가 **같은 PNG 파일**을 본다.

- 해시 캐시: `src/server/services/overlay-render.service.ts:39-74` — 텍스트 렌더 입력을 정규화(opacity=1
  고정)해 `sha1` 해시 → `overlay-cache/{hash}.png` 캐시. **"프리뷰와 인코딩이 동일 이미지를 공유하는
  Single Source of Truth"**(파일 헤더 주석).
- 에디터가 속성 변경 시 debounce 로 렌더 API 호출 → 새 hash 수신 (`use-overlay-render.ts:65-70`).
- 프리뷰 레이어는 `overlayHash` 가 있으면 **서버 PNG 를 `<img src=/api/overlay-cache/{hash}.png>`**
  로 표시(편집 중이 아닐 때), 편집 중에만 CSS 근사 (`text-overlay-layer.tsx:177,204-213`).
- export 는 같은 hash 의 캐시 PNG 를 재사용 (`export-clip.job.ts:191-201`,
  `overlay-render.service.ts:76-83`).
- opacity 는 이미지에 굽지 않고 container CSS / ffmpeg overlay 단계에서 적용 → opacity 만 다른
  텍스트는 캐시 공유 (`overlay-render.service.ts:53-55`).

**가상 캔버스 + CSS scale** (`src/app/(editor)/studio/editor/_components/preview-frame.tsx`):
- 내부 자식을 target 해상도(1080×1920 등) **절대 px** 로 배치하고, `ResizeObserver` 로 뷰포트 폭 대비
  `transform: scale()` 만 조절 (`preview-frame.tsx:37-47,64-74`). 뷰포트 크기와 무관하게 기하가 export 와 동일.

---

## 2. AENA — 종횡비/크롭 모델

### 2.1 어휘 (단일 enum, 클라·서버 공유)

```ts
// src/lib/aspect-presets.ts:12
export type AspectRatio = '16:9' | '9:16-letterbox' | '9:16-crop-main' | '9:16-crop-sub';
```

crop 계열만 사각형 프리셋을 갖는다. **캔버스 1080×1920, 비디오는 (videoX,videoY,videoW,videoH)
사각형에 앉고 나머지는 검정 pad** (`aspect-presets.ts:26-41`):

| id | 라벨 | canvas | videoX,Y | videoW×H | 비디오 점유 영역 | 남는 밴드 |
|----|------|--------|----------|----------|-----------------|-----------|
| `9:16-crop-main` | 크롭(메인) | 1080×1920 | 0, 440 | 1080×1480 | y=440‥1920 (하단까지) | 상단 440px 한 줄 |
| `9:16-crop-sub` | 크롭(서브) | 1080×1920 | 0, 440 | 1080×980 | y=440‥1420 (중앙) | 상단 440 + 하단 500px |

**crop-main vs crop-sub 차이 = 비디오 사각형의 높이.** 둘 다 가로는 꽉(1080), y=440 에서 시작.
- **crop-main**: 비디오가 크다(1480). 소스를 `1080:1480≈0.73`(세로 크롭)으로 중앙 크롭 → 인물이
  세로 프레임을 거의 채운다. 캡션 밴드는 상단 하나.
- **crop-sub**: 비디오가 작다(980). 소스를 `1080:980≈1.10`(가로에 가까움)으로 중앙 크롭 → 더 넓게,
  낮게. **상단·하단 두 밴드**가 생겨 보조(sub) 요소 자리가 난다.
- 두 크롭 모두 **가로 중앙 크롭**(피사체 추적 없음). 즉 "메인/서브"는 *피사체 선택*이 아니라
  *레이아웃(사각형 위치·크기)* 차이다.

`16:9` / `9:16-letterbox` 는 소스 비율 의존이라 CROP_PRESETS 에 없고 특수 처리(`aspect-presets.ts:9`).
legacy `9:16-crop` → `9:16-crop-main` 정규화 단일 지점(`normalizeAspectRatio`, `aspect-presets.ts:62-67`).

### 2.2 렌더 ffmpeg 수식 (`encodeWithOverlays`, `ffmpeg.service.ts:589-618`)

출력 해상도는 품질 프리셋의 landscape/portrait(예: 1080×1920, `ffmpeg.service.ts:532-557`).

- **16:9** (`ffmpeg.service.ts:595`):
  ```
  [v]scale=1920:1080[scaled]
  ```
  단순 스케일(원본 비율 무시, 프리셋 해상도로).
- **9:16-letterbox** (`ffmpeg.service.ts:600`):
  ```
  [v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[scaled]
  ```
  맞춤(전체 보존) + 중앙 검정 pad.
- **crop-main / crop-sub** (`ffmpeg.service.ts:607-616`): 프리셋 사각형을 출력 해상도로 선형 스케일
  (`sx=outW/canvasW`, `vw=videoW*sx` 등)한 뒤:
  ```
  [v]crop=ih*{videoW}/{videoH}:ih,scale={vw}:{vh},pad={outW}:{outH}:{vx}:{vy}[scaled]
  ```
  = 소스를 `videoW:videoH` 비율로 **중앙 크롭** → 사각형 크기로 스케일 → 캔버스 위 `(vx,vy)` 에 pad.
  crop-main: `crop=ih*1080/1480:ih` (세로 크롭), crop-sub: `crop=ih*1080/980:ih` (넓은 크롭).

### 2.3 에디터가 비율을 고르는 법 (UI + 프리뷰)

- **버튼 4개** (`src/app/(editor)/studio/editor/[id]/page.tsx:1243`):
  `[["16:9","16:9"],["9:16-letterbox","레터박스"],["9:16-crop-main","크롭(메인)"],["9:16-crop-sub","크롭(서브)"]]`.
  누르면 `SET_RATIO` dispatch. (editor-v2 는 `<option>` 드롭다운, `editor-v2/[id]/page.tsx:192-194`.)
- **프리뷰가 렌더 수식을 CSS 로 그대로 재현** (`editor/[id]/page.tsx:991-1007`): 같은 프리셋 사각형을
  `%` 로 환산해 절대 배치하고, crop 은 `object-cover`(사각형 꽉 채우기+중앙 크롭),
  letterbox/16:9 는 `object-contain`. **프리뷰 크롭 수학과 렌더 크롭 수학이 같은 CROP_PRESETS 를 읽는다.**
- 기본 쇼츠 비율: 드라마 → `9:16-crop-main`, 그 외 → `9:16-letterbox` (`defaultShortsRatio`,
  `editor/[id]/page.tsx:1353-1359`).

### 2.4 STEP-D 가 채택할 만한 것

1. **단일 enum 하나가 클라·서버 공유** — 비율=크롭=밴드까지 한 값이 결정. 파생 필드(fit/bgType) 없이
   모호함이 원천 차단.
2. **crop = 캔버스 안 사각형 + pad** 모델 — "전체화면 cover" 말고 **비디오 사각형을 명시**하면
   캡션 밴드 자리가 확정되고 프리뷰/렌더가 같은 수식을 쓴다.
3. **프리뷰가 렌더와 같은 프리셋 상수를 읽음** — 손 파리티 대신 구조적 파리티.

---

## 3. STEP-D — 현재 상태와 모호함

### 3.1 텍스트 오버레이 = ASS/libass 번인

- `buildEditorAss` (`apps/server/src/index.ts:4348`) 가 `editorState` 를 ASS `Dialogue:` 이벤트로 만든다.
  `\pos(x,y)\an{7/8/9}\fs{px}\c{color}\bord\3c\shad` 등으로 제목·채널·요소·자막 배치
  (`index.ts:4386-4391, 4407-4473`).
- ffmpeg `ass='{path}'` 필터로 합성 프레임 위에 번인 (`apps/server/src/ffmpeg.ts:845-849`, renderShort).
- 폰트 px→ASS: `assFs`·`editorScale`(stage 높이 대비 출력 높이 배율)로 환산 (`index.ts:4021,4363,4409`).
- **프리뷰는 DOM/CSS** (`apps/web/src/components/editor/editor-preview.tsx`) — 별도 렌더러. ASS 와 CSS 를
  **손으로 맞춘다**: `buildEditorAss` 주석마다 "미리보기 CSS px 등가", "미리보기와 줄 수가 항상 일치",
  "예전엔 …어긋났다" 식 파리티 튜닝이 반복 (`index.ts:4402-4405,4419-4427,4436-4446`). AENA 처럼
  같은 산출물을 공유하지 않아 **드리프트가 상시 위험**.

STEP-D 오버레이는 AENA 와 목적이 달라(방송 번인 자막 위 어그로 제목/채널 배지/방영시간 박스) 기술
교체가 급하진 않다. 단 WYSIWYG 신뢰도는 AENA 방식이 구조적으로 우월.

### 3.2 종횡비 — 두 개의 분리된 어휘 (모호함의 뿌리)

**어휘 A — `clip.aspectRatio` (라벨 전용, AENA 를 닮았으나 죽어 있음):**
```ts
// apps/web/src/lib/constants.ts:47-53
export const ASPECT_RATIOS = {
  "16:9": "가로 16:9",
  "9:16-letterbox": "세로 9:16 (레터박스)",
  "9:16-crop-main": "세로 9:16 (메인 크롭)",
  "9:16-crop-sub": "세로 9:16 (서브 크롭)",
};
```
- 이 4값은 **표시 라벨로만** 쓰인다 — `derivatives-panel.tsx:318` 의 `ASPECT_RATIOS[clip.aspectRatio]`
  한 곳. **선택 UI 가 없다.**
- 실제 배정은 **채택 다이얼로그의 이분 orientation** 뿐: portrait→`9:16-crop-main`,
  landscape→`16:9` (`apps/server/src/index.ts:6207-6209`, `apps/web/src/lib/data/store.tsx:493-495`,
  `apps/server/src/factory.ts:682`). `adopt-dialog.tsx:52-58` 은 세로/가로 두 버튼뿐.
- ⇒ **`9:16-letterbox` 와 `9:16-crop-sub` 는 어휘에만 있고 어떤 클립에도 배정되지 않는다(죽은 값).**

**어휘 B — `editorState`(렌더가 실제로 읽는 것):**
```ts
// apps/web/src/lib/editor/presets.ts:10
export type AspectKey = "9:16" | "16:9" | "1:1" | "4:5";   // 컨테이너 비율만
// presets.ts:283  fit?: "contain" | "cover";              // 원본을 어떻게 넣나
// presets.ts:319  bgType?: "solid" | "blur" | "image";    // 레터박스 채움
```
- 렌더 해상도는 `renderDims(aspect)` 가 bare 비율에서 W/H 산출 (`index.ts:3919-3927`).
- 채움은 `renderShort` 가 `fit`+`bgType` 로 분기 (`ffmpeg.ts:818-837`):
  - `fit:"cover"` → `[0:v]scale=W:H:force_original_aspect_ratio=increase,crop=W:H` (전체화면 중앙 크롭, `ffmpeg.ts:821`)
  - `fit:"contain"`+`bgType:"solid"` → color pad 레터박스 (`ffmpeg.ts:826-829`)
  - `fit:"contain"`+`bgType:"blur"` → 블러 커버 배경 + 맞춤 전경 (`ffmpeg.ts:832-836`)
- 프리뷰도 같은 축을 CSS 로: `state.fit === "cover" ? object-cover : object-contain`
  (`editor-preview.tsx:284`), `bgType` 별 배경 (`editor-preview.tsx:185-242`).

**모호함 A — main/sub/letterbox 가 렌더에서 구분 안 됨.** `normalizeAspect` 가 `9:16*` 를 전부 bare
`9:16` 로 뭉갠다:
```ts
// apps/server/src/index.ts:3948-3955
function normalizeAspect(aspectRatio) {
  const s = String(aspectRatio ?? "");
  if (s.startsWith("9:16")) return "9:16";   // crop-main·crop-sub·letterbox 다 → 9:16
  if (s.startsWith("16:9")) return "16:9";
  ...
}
```
export 는 `editorState.aspect`(bare) → preset → `normalizeAspect(clip.aspectRatio)`(bare) 순으로
해상도만 정한다 (`index.ts:7346-7350`). **크롭/레터박스 구분은 전 경로에서 소실.** "메인 크롭" 라벨
클립과 (가정상) "레터박스" 클립이 같은 editorState 면 **동일하게 렌더**된다.

**모호함 B — crop 에 사각형/밴드 모델이 없음.** STEP-D 의 "크롭"은 `fit:"cover"` = 전체화면 중앙 크롭
하나뿐. AENA 의 crop-main(1080×1480)·crop-sub(1080×980) 처럼 **비디오가 사각형에 앉고 위/아래 밴드가
생기는 개념이 없다.** ⇒ `9:16-crop-sub` 에 줄 기하 자체가 없다.

**모호함 C — 라벨↔동작 어긋남.** 채택 시 "세로" → `clip.aspectRatio="9:16-crop-main"`("메인 크롭"
라벨)로 굳지만, 에디터는 crop/letterbox 선택을 안 보여주고 대신 `fit`(맞춤/채우기)·`bgType`
(solid/blur/image)를 **독립 축**으로 노출한다. "메인 크롭" 으로 채택한 클립이 에디터에서
`fit:"contain"`(=레터박스!)로 렌더될 수 있다 — **라벨과 실제 채움이 갈린다.** (기본 시드는
`fit:"contain"`, `presets.ts:516`·`autoEditorState` 는 `fit` 미설정=contain, `factory.ts:607-608`.)

**모호함 D — 피사체 크롭은 AI 리프레임에만.** basic `fit:"cover"` 는 중앙 크롭(피사체 무관,
`ffmpeg.ts:821`). 피사체 추적 크롭은 별도 `reframePlan`(`ai_multi`)의 per-beat fit/fill 경로에만 존재
(`ffmpeg.ts:550-561`, tracking cx/cy). AENA 도 basic 크롭은 중앙 크롭이라, "크롭이 어느 피사체를
지키나"의 답은 두 제품 모두 basic 에선 **중앙**이다 — main/sub 는 피사체가 아니라 레이아웃 축임을
명확히 할 것.

---

## 4. 권고 — STEP-D 를 위한 명확한 비율 모델

### 4.1 원칙

1. **비율=한 값.** AENA 처럼 **단일 enum** 하나가 컨테이너·크롭·밴드를 전부 결정한다. `aspect`(bare)
   +`fit`+`bgType` 3필드 곱을 **하나의 `aspectRatio` enum**으로 접어 모호함을 원천 제거.
2. **클라·서버가 같은 상수 파일 공유** (AENA `aspect-presets.ts` 처럼) — 프리뷰 CSS 와 렌더 ffmpeg 가
   같은 프리셋 숫자를 읽는다.
3. **라벨 = 동작.** 사용자가 고른 값이 렌더 수식과 1:1. `normalizeAspect` 로 뭉개지 않는다.
4. **죽은 값 제거 또는 실체 부여.** `9:16-crop-sub` 는 삭제하거나 AENA 처럼 진짜 사각형을 준다.

### 4.2 제안 enum (5값) + 사용자 문구 + 렌더 수식

출력 해상도: 가로 1920×1080, 세로 1080×1920.

| enum id | 사용자 라벨 | 한 줄 정의 | 렌더 수식 (W,H = 출력) |
|---------|------------|-----------|----------------------|
| `16:9` | 가로 16:9 | 원본 가로 그대로. | `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2` (또는 소스가 16:9면 `scale=W:H`) |
| `9:16-letterbox` | 세로 · 레터박스 | 원본 **전체**를 세로 화면에 넣고 위아래는 검정/블러. 잘림 없음. | 맞춤+pad: `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2` · (블러 배경 옵션은 §4.4) |
| `9:16-crop-full` | 세로 · 꽉 채우기 | 원본을 **잘라 세로 전체**를 채운다. 밴드 없음. 중앙(또는 AI 피사체) 크롭. | `scale=W:H:force_original_aspect_ratio=increase,crop=W:H` |
| `9:16-crop-main` | 세로 · 메인 크롭 | 상단 캡션 **밴드 1개**(제목/훅), 아래 비디오가 하단까지 크게. | 사각형 (0,440,1080,1480): `crop=ih*1080/1480:ih,scale=1080:1480,pad=1080:1920:0:440` |
| `9:16-crop-sub` | 세로 · 서브 크롭 | 상단·하단 **밴드 2개**(제목+보조), 비디오는 중앙에 작게. | 사각형 (0,440,1080,980): `crop=ih*1080/980:ih,scale=1080:980,pad=1080:1920:0:440` |

- `9:16-crop-full` = 현행 `fit:"cover"` 의 정식 이름(전체화면 크롭). 밴드가 필요 없을 때.
- `9:16-crop-main`/`crop-sub` = **AENA 의 사각형+밴드 모델을 그대로 이식**(위 숫자는 AENA
  `aspect-presets.ts:26-41` 값). 밴드 픽셀 좌표가 확정되므로 ASS 제목/채널 배지 y 도 밴드 안에 결정론적으로 앉힐 수 있다.
- 사각형 프리셋은 STEP-D 도 `apps/web/src/lib/editor/` 아래 **클라·서버 공유 상수**(예:
  `aspect-presets.ts`)로 두고, `renderShort`(`ffmpeg.ts`)와 `editor-preview.tsx` 가 함께 읽게 한다.
- `1:1`·`4:5` 는 현행 유지하되(정사각/피드) crop-full 과 같은 `increase+crop` 수식으로 통일.

> 최소안: crop-sub 를 당장 안 쓸 거면 **enum 에서 빼고**(죽은 라벨 제거) `16:9 / 9:16-letterbox /
> 9:16-crop-full / 9:16-crop-main` 4값으로 시작. crop-sub 는 밴드 실측 후 추가.

### 4.3 에디터 표현 (라벨 + 프리뷰)

- **비율 버튼 그룹 1개** — AENA `editor/[id]/page.tsx:1243` 처럼 `[[id,라벨]...]` 배열을 돌려 버튼.
  현재 `fit`(맞춤/채우기)·`bgType` 분리 노출을 이 단일 축으로 대체(고급 토글로 blur 배경만 남김, §4.4).
- **프리뷰는 같은 프리셋 상수를 CSS 로 재현** — AENA `editor/[id]/page.tsx:991-1007` 방식:
  crop 계열은 사각형을 `%` 배치 + `object-cover`, letterbox/16:9 는 `object-contain`. STEP-D
  `editor-preview.tsx` 는 이미 `object-cover/contain` 분기가 있으니(284행) 사각형 배치 레이어만 추가.
- 채택 다이얼로그: portrait 선택 시 하위 옵션으로 `레터박스 / 꽉 채우기 / 메인 크롭`을 고르게 하면
  라벨↔동작이 채택 시점부터 일치(현재 무조건 crop-main 배정, `index.ts:6207` 을 대체).

### 4.4 렌더 파리티 (에디터와 동일)

- `renderShort` 가 **enum 하나로 분기**: crop-full → `increase+crop`, letterbox → `decrease+pad`,
  crop-main/sub → 사각형 `crop,scale,pad`. `normalizeAspect` 의 `9:16*→9:16` 뭉갬을 **제거**하고 enum 을
  그대로 전달.
- 블러 배경은 letterbox 의 **하위 옵션**(`bgType:"blur"`)으로만 남긴다 — 비율 축과 직교하는 유일한 잔여
  파생 필드. (현행 `ffmpeg.ts:832-836` 블러 경로 재사용.)
- AI 리프레임(`reframePlan`)은 crop-full/crop-main 위에서 **피사체 추적 크롭**으로 동작(현행
  `ffmpeg.ts:550-561` 유지) — enum 은 "밴드 레이아웃", reframe 은 "크롭 중심"을 담당하는 **직교 축**으로 문서화.

### 4.5 오버레이 개선 (선택)

STEP-D 의 ASS 번인은 방송 자막/배지 목적에 맞아 교체 급하지 않지만, WYSIWYG 신뢰도를 올리려면
AENA 패턴을 부분 채택:
- **제목/채널 텍스트를 canvas→PNG 로 렌더해 해시 캐시**(AENA `overlay-render.service.ts`)하고
  프리뷰가 그 PNG 를 `<img>` 로 표시 → `buildEditorAss` 의 수동 CSS 파리티 튜닝(`index.ts:4402-4446`)을
  구조적으로 제거. 자막(caption)은 시간축 이벤트가 많아 ASS 유지가 합리적.
- 최소 개입: **밴드 좌표를 §4.2 프리셋에서 끌어와** 제목 `titleY`·채널 `channelY` 기본값을 밴드 중앙으로
  결정론화(현재 `factory.ts` TEMPLATE_SEEDS 의 손 숫자 `titleY:11,channelY:80` 등을 밴드에서 파생).

---

## 5. 인용 색인 (핵심 파일:줄)

**AENA**
- 비율 enum·프리셋: `src/lib/aspect-presets.ts:12,26-41,62-67`
- 렌더 수식: `src/server/services/ffmpeg.service.ts:589-618` (16:9=595, letterbox=600, crop=607-616)
- 텍스트=PNG 이미지 합성: `src/server/jobs/export-clip.job.ts:82,91-100` · drawtext 미사용 확인 `ffmpeg.service.ts:641-650`
- 텍스트→PNG 렌더: `src/server/services/text-render.service.ts:32-34,130-139,155-197,210-260`
- 해시 캐시(SSOT): `src/server/services/overlay-render.service.ts:39-83`
- WYSIWYG 프리뷰: `.../editor/_components/preview-frame.tsx:37-74` · `text-overlay-layer.tsx:177,204-213` · `use-overlay-render.ts:65-70`
- 좌표 v2: `src/lib/overlay-coord.ts:26-33,55-92`
- 비율 UI·프리뷰 크롭: `.../editor/[id]/page.tsx:991-1007,1243,1353-1359`

**STEP-D**
- 라벨 어휘(죽은 값): `apps/web/src/lib/constants.ts:47-53` · 유일 소비처 `apps/web/src/components/derivatives-panel.tsx:318`
- 렌더 어휘: `apps/web/src/lib/editor/presets.ts:10,283,319`
- 비율 뭉갬: `apps/server/src/index.ts:3948-3955` · export 해상도 결정 `index.ts:7346-7350`
- 해상도 표: `apps/server/src/index.ts:3919-3927`
- 렌더 채움 분기: `apps/server/src/ffmpeg.ts:818-837`(cover=821, solid=826-829, blur=832-836) · AI 피사체 크롭 `ffmpeg.ts:550-561`
- 프리뷰 채움: `apps/web/src/components/editor/editor-preview.tsx:100,175,185-242,284`
- crop-main 배정: `apps/server/src/index.ts:6207-6209` · `apps/web/src/lib/data/store.tsx:493-495` · `apps/server/src/factory.ts:682`
- 채택 UI(이분): `apps/web/src/components/adopt-dialog.tsx:52-58`
- ASS 오버레이: `apps/server/src/index.ts:4348,4386-4391,4407-4473` · ASS 번인 `apps/server/src/ffmpeg.ts:845-849`
- 자동 시드: `apps/server/src/factory.ts:535-558,607-608`

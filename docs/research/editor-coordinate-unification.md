# 에디터 좌표계 통일 — 단일 출력 해상도 basis

> 2026-08-19 · 브랜치 `flows-test-harness` · **로컬 검증 후 배포**(아직 미배포). 편집기 미리보기를
> CapCut/Premiere/AENA 표준(단일 출력 해상도 좌표계)으로 재구성했다.

## 1. 문제 — 이중 basis

예전엔 오버레이 크기(`line.size`·채널·요소·외곽선)가 **~640px 캐논 스테이지 px** 로 저장되고,
서버 렌더가 굽는 순간 `× (H / stageH)`(≈세로 3배) 해서 출력 해상도 px 로 올렸다.

- **저장/편집 basis** = 스테이지 px(~640)
- **렌더 basis** = 출력 px(1080×1920 등)

두 basis 가 갈라져 있어서 편집 CSS ↔ 서버 PNG 크기가 어긋났고, 서버는 에디터가 보내지도 않는
`es.stagePx`(실측 스테이지 높이)를 읽으려다 캐논 640 으로 폴백했다. 최근엔 CSS 쪽을 `cqh`(스테이지
높이 %)로 흉내내 맞췄지만, 그건 **캐논 640 간접 basis 를 흉내내는 우회**였다.

## 2. 모델 — 단일 출력 해상도 좌표계

**basis 는 하나. 출력 해상도(canvasW×canvasH) px.** (aspect-presets.ts `canvasW/canvasH`)

- 미리보기 **스테이지 = 출력 해상도 고정 `div`** 를 **단일 `transform: scale(fit)`**(`transform-origin: 0 0`)
  으로 축소해 보여준다. `fit = viewportWidth / canvasW`(ResizeObserver). → **편집 화면 = 결과물의 축소본.**
- 스테이지 내부는 전부 **출력 px / %**: 비디오(aspect rect %), 제목·채널·요소 오버레이(`line.size` =
  실제 출력 px, `titleX/titleY` = 출력 대비 %, 그림자·외곽선 = 출력 px). 자막은 `cqh`(=출력 높이 %)로
  유지 — 스테이지가 `container-type:size` 라 `cqh` = 출력 높이 % = 서버 `CAPTION_PCT`(% of H)와 1:1.
- 서버 렌더(canvas-PNG `overlay-canvas.ts` + ASS)도 **같은 출력 px 를 그대로** 쓴다. 저장값에 `×scale`
  하지 않는다 → 편집 CSS px == 서버 canvas px == 결과물 (구조적 WYSIWYG).

`renderDims().stageH`(서버) / `designStageH()`(웹)는 이제 **좌표 basis 가 아니라** 마이그레이션 계수와
고정 설계 상수(그림자 offset·패딩·gap·박스 폰트)를 출력 px 로 올리는 데만 쓰는 잔여값이다(`constScale`).

## 3. 마이그레이션 — 옛 클립 무회귀(net-zero)

옛 저장분·factory 시드는 크기가 스테이지 px 다. **로드/렌더 시 1회 정규화**(`normalizeEditorCoords`)로
`× outScale(aspect)` 해 출력 px 로 올린다. **멱등** — `coordBasis:"output"` 마커가 있으면 no-op.

- 웹: `ensureTracks`(로드) · `makeInitialEditorState`(새 클립) 가 `normalizeEditorCoords` 를 감싼다.
  저장 시 `coordBasis:"output"` 로 영속 → 다음 로드부터 재정규화 안 됨.
- 서버: `renderShort` 진입 + `overlayPreviewItems`(에디터 PNG)에서 `normalizeEditorCoords(es, aspect)`.
  웹이 `coordBasis:"output"` 로 보내면 no-op, 옛 DB 상태면 여기서 올린다.
- factory `autoEditorState`·automation 규칙 layout 은 **바꾸지 않았다** — 스테이지 px 로 두고(마커 없음)
  렌더/로드 시 정규화가 올린다. 자동배포 미리보기(`template-preview.tsx`)의 `×3/1920` 도 그대로 유효.

### 계수(= 서버 렌더 scale = `H / stageH` = 웹 `outputHeight / designStageH`)

| aspect | 출력 H | designStageH | **계수(outScale)** |
|--------|-------|--------------|--------------------|
| 9:16 (letterbox·crop-full·crop-main·crop-sub) | 1920 | 640 | **3.0** |
| 16:9 | 1080 | 506.25 (=900·1080/1920) | **2.13333…** |
| 1:1 | 1080 | 900 | **1.2** |
| 4:5 | 1350 | 640 | **2.109375** |

### net-zero 증명

옛 렌더 출력 px = `size × scale`, `scale = H/stageH`. 마이그레이션은 저장값을 `size × (H/stageH)` 로
올리고, 새 렌더는 그 출력 px 를 **그대로** 쓴다(×scale 없음). 두 출력 px 가 **정확히 같다**:

```
새_렌더_px = size × outScale(aspect) = size × (H/stageH) = 옛_렌더_px   (모든 aspect·size)
```

미설정 기본값(예: 제목 없으면 30, 채널 라벨 14, 아이콘 40)과 고정 상수(그림자 2·6, 패딩 4, gap 4/8,
박스 22)는 저장값이 아니라 `× scale` 로 유지 → 이들도 aspect별 정확히 net-zero. `overlay-parity.test.ts`
의 **"마이그레이션 계수 — net-zero"** 블록이 `size×scale == size×계수` 를 size∈{14,30,40,56}·4개 aspect
로 수치 검증한다.

## 4. 변경 파일

### 웹 (`apps/web`)
- **`src/lib/editor/presets.ts`** — `EditorState.coordBasis?` 추가 · `designStageH`·`outputHeight`·
  `outputWidth`·`outScale`·`normalizeEditorCoords` 신설 · `ensureTracks`/`makeInitialEditorState` 가
  이를 감싼다 · `defaultElementSize`(40/14→120/42 출력 px) · `CHANNEL_BADGE_PRESETS`(출력 px) ·
  `applyTemplate` 빈 줄 시드(30→90).
- **`src/components/editor/editor-preview.tsx`** — `canonicalStageH`·`stagePxToCqh` 제거 · 스테이지를
  **출력 해상도 고정 캔버스 + viewport + `scale(fit)` ResizeObserver** 로 재구성 · 오버레이 크기를
  출력 px 로 직접 사용(`toCqh` → `line.size`px / 상수는 `opx()`) · 자막은 `cqh` 유지.
- **`src/components/editor/editor-overlay.tsx`** — `Movable` 에 `resizePxScale`(=1/fit) 추가 → 리사이즈
  드래그 Δ를 출력 px 로 환산, 클램프 [8,600] 로 확장.
- **`src/components/editor/editor-panel.tsx`** — 크기 슬라이더 범위·시드·기본값을 출력 px(×3)로:
  제목 16–56→48–168 · 외곽선 1–12→3–36(기본 3→9) · 아이콘 12–120→36–360(기본 24→72) ·
  라벨 10–40→30–120(기본 14→42) · 부가줄 8–32→24–96 · 리셋 시드 30/40→90/120·새 줄 24→72.
- **`src/components/editor/use-overlay-png.ts`** — 폐기된 `stagePx` 키 제거, `coordBasis` 추가.

### 서버 (`apps/server`)
- **`src/index.ts`** — `renderDims` 문서 갱신(stageH 역할 재정의) · `normalizeEditorCoords` 신설 ·
  `editorScale`(stagePx 실측 해킹) → `constScale(H, stageH)` (4개 호출부) · 저장 크기의 `×scale` 제거
  (`layoutTitleLines` 제목 · `channelBadgeLayout` 라벨/부가줄 · `buildStaticOverlayItems` 외곽선 ·
  `buildEditorAss` 요소 · 아이콘 높이 2곳) · `renderShort`/`overlayPreviewItems` 진입에서 정규화.
- **`src/overlay-parity.test.ts`** — cqh/canonicalStageH 단언을 단일 출력 px 단언으로 재작성 +
  마이그레이션 계수 net-zero 수치 테스트 추가.
- `src/overlay-canvas.ts` — **변경 없음**(이미 출력 px 아이템을 받아 그린다).

**건드리지 않은 것(동시 세션 소유):** `automation-cycle.ts`·`db-pg.ts`·`automation.test.ts`·
`automation/page.tsx`·`editor-shell.tsx`.

## 5. 파리티 테스트

`overlay-parity.test.ts`(소스 스캔 + 수치):
- 편집 CSS 폰트가 `line.size`/`labelPx`(출력 px)를 그대로 쓴다(곱셈 없음) · 서버 `layoutTitleLines`도.
- 웹 `designStageH`/`outputHeight` ↔ 서버 `renderDims`(stageH/H) 1:1.
- 웹·서버 `normalizeEditorCoords` 가 같은 계수(`H/stageH` == `outputHeight/designStageH`)·같은 마커.
- 렌더 진입이 실제로 `normalizeEditorCoords` 를 부른다(생산→소비 배선).
- 외곽선·패딩이 출력 px basis.
- **net-zero 수치**: `size×scale == size×계수` (4 aspect × 4 size).

전체: 서버 749 테스트·48 파리티 테스트 그린. 아스펙트 rect 파리티는 `aspect-parity.test.ts`(변경 없음)가 계속 강제.

## 6. 로컬 시각 검증 (배포 전 필수)

```bash
# 1) 서버(로컬 API) — 별도 터미널
cd apps/server
# apps/server/.env 필요(DATABASE_URL 등). 워커/파이썬은 편집기 미리보기엔 불필요.
npm run dev            # tsx watch --env-file .env src/index.ts · PORT 기본 4000

# 2) 웹(에디터) — 별도 터미널
cd apps/web
# apps/web/.env.local: NEXT_PUBLIC_API_URL=http://localhost:4000/api  (서버 라우트 /api 베이스)
npm run dev            # next dev · http://localhost:3000
```

브라우저:
1. `http://localhost:3000` → 클립이 있는 회차/클립 목록에서 **기존(옛) 클립**을 연다
   (`/editor/<clipId>`). 제목·채널 오버레이 크기가 **예전과 동일**해 보이는지 확인(net-zero).
   - 옛 클립이 없으면: 회차에서 새 클립을 만들어 열면 `makeInitialEditorState`(출력 px 시드)로 뜬다.
2. 제목을 **선택/해제**(클릭 → 빈 곳 클릭)해도 크기가 **안 튀는지**(CSS↔서버 PNG 스왑) 확인.
3. 속성 패널에서 **제목/채널 크기 슬라이더**를 움직여 실시간 반영·리사이즈 핸들 드래그가 커서를
   따라가는지 확인. **종횡비 탭**(세로/가로)을 전환해도 재생이 안 끊기는지.
4. **확정(렌더)** 을 눌러 실제 결과물(트림·인코딩된 클립)을 스트림으로 재생 → 편집 화면에서 본
   오버레이 자리·크기와 **1:1** 인지 확인(편집 = 결과물).
5. 뷰포트(브라우저 창·패널 접기)를 바꿔도 오버레이 비율이 유지되는지(단일 `scale(fit)`).

> 사실만 리포트: 위 3·4단계가 "예전과 같다/결과물과 같다"의 **판정은 사용자 몫**이다. 코드·테스트는
> net-zero 를 보장하도록 짜였지만, 최종 시각 확인 없이는 배포하지 않는다.

## 7. 후속(범위 밖)

- `applyTemplate` 이 이제 slot.size(1080폭 캔버스 px = 출력 px)를 `line.size` 에 **직접** 복사할 수
  있다(구 주석의 "별도 작업"이 해소됨) — 원하면 위치·정렬처럼 크기도 슬롯에서 시드 가능.
- 요소 박스 패딩(`px-2 py-1`)·안전영역 목업은 여전히 고정 rem/px 라 출력 해상도 스테이지에서 작게
  보인다(장식·미export). 필요 시 출력 px 로 환산.

# 썸네일 엔진 계획 — 사람이 만든 것 같은 쇼츠/클립 썸네일 자동 생성

> 작성 2026-07-26. 이 문서는 초안(계획 시점)입니다.
> **최신 정본**: [`thumbnail-engine-consolidated.md`](thumbnail-engine-consolidated.md) (2026-07-28)
> — 오늘 세션 진행 상황 (Planner CoT · hybrid composition · style 학습) 반영 · MVP1/2/3 재정리.

관련: [`step-d-master-build-plan.md`](step-d-master-build-plan.md) §7(편집기) · `core/faces.py`(얼굴) ·
`apps/server/src/index.ts`의 `selectThumbnail`(현행: 단일 프레임)

---

## 0. 지금 상황 (현행 썸네일 배선)

- `apps/server/src/index.ts:806` `selectThumbnail`: 클립별 프레임 **시점 초** 하나만 기록.
- 실제 이미지 생성 = `ffmpeg -ss ... -vframes 1` (`ffmpeg.ts:captureThumbnail`).
- 결과: 특정 순간 스냅샷 하나. 자막·인물 강조·배경 처리 전혀 없음.

즉 지금은 **"프레임 뽑기"** 단계에서 멈춰 있고, 방송사 썸네일이 되려면 **"컷아웃 → 합성"**
단계가 통째로 추가돼야 한다.

---

## 1. 목표 — 어떤 결과물을 만들 것인가

### 1.1 벤치마크: 한국 방송 예능/드라마 썸네일 관행

관찰:
- **인물 컷아웃** 전면 배치 (배경에서 뜯어냄 · 얼굴 큰 비중 · 20~40% 화면 점유)
- **자막 2~4어절** 큰 폰트 (인용 대사 · 훅 질문 · 상황 요약)
- **배경**: 원본 blur+bokeh · 컬러 그라디언트 · 상황 이미지 확장
- **강조 요소**: 컬러 outline · 배지 · 별표 · 화살표 · 큰 이모지 (남용 X)
- **폰트**: 예능=굴림 굵게 · 드라마=세리프 · 뉴스=고딕
- **레이아웃**: 인물 좌/우 · 자막 반대편 · 상단 큰 텍스트 + 하단 부제

### 1.2 성공 기준 (시연 기준)

- 자동 생성 3~5개 variant 중 **사용자가 조정 없이 그대로 선택**하는 비율 ≥ 40%
- 시연에서 첫 반응이 "이거 사람이 만든 거 아냐?"
- 클립당 총 생성 시간 ≤ 15초 (variant 5개 병렬)

---

## 2. Layer Canvas + Photoshop-MCP 도구 모델

> **핵심 발상 2가지**:
> 1. **Layer Canvas**: 썸네일 = 미리 정의된 레이어 스택 (Photoshop 문서 개념). 시스템이 캔버스·Z-order·
>    마스크·블렌드를 관리.
> 2. **Photoshop-MCP 도구 API**: AI에게 JSON 하나 던지라고 하지 않고, **Photoshop 조작 도구들**을 노출하고
>    (create_layer · load_frame · segment_person · generate_background · add_text · apply_filter · export)
>    AI가 **function calling으로 도구를 순차 호출**해서 조립.
>
> 결과: AI가 이전 도구 결과(예: "인물 컷아웃 크기" · "자막이 배경과 겹치는 영역")를 보고
> 다음 도구를 조정. 사용자는 특정 도구 호출만 override 가능 ("배경만 바꿔" · "자막 위치만 이동").

### 2.1 캔버스 · 레이어 정의 (시스템이 관리)

썸네일 캔버스는 **고정 6-레이어 스택** (Z-order 아래→위):

```
Layer 0 : Background      배경 이미지 (AI 생성 or 원본 blur or 단색/그라디언트)
Layer 1 : BackFx          배경 이펙트 (halo · vignette · noise · lens flare)
Layer 2 : Person          인물 컷아웃 (원본 프레임 + rembg alpha)
Layer 3 : PersonFx        인물 강조 (outline glow · shadow · color pop)
Layer 4 : Caption         메인 자막 (2~4어절 · 큰 폰트 · outline + shadow)
Layer 5 : FrontFx         전경 스티커 (별표 · 화살표 · 배지 · 이모지)
```

각 레이어는 **소스 (source)** + **변형 (transform)** + **블렌드 (blend)** 3요소:

```ts
interface Layer {
  role: "background" | "backfx" | "person" | "personfx" | "caption" | "frontfx";
  source: LayerSource;      // 무엇 (AI 생성 / rembg / 원본 프레임 / 텍스트 / 스티커)
  transform: LayerTransform;// 어디에·얼마나 (bbox · rotation · scale · opacity)
  blend: BlendMode;         // "normal" | "multiply" | "screen" | ...
  mask?: LayerMask;         // alpha PNG · 그라디언트 마스크 등
}
```

이렇게 정의해 두면:
- 사용자 override = **특정 레이어의 source만 교체** (다른 레이어는 그대로)
- AI 재생성 = **특정 레이어만 재요청** (전체 재렌더 불필요)
- 병렬화 = 각 레이어 소스 생성 병렬 → 최종 composite만 순차

### 2.2 담당 매트릭스 (레이어별)

| Layer | AI 담당 | 시스템 담당 |
|-------|--------|-------------|
| **0 Background** | 어떤 mode (AI 생성 / 원본 blur / 그라디언트) · AI 생성 시 프롬프트 텍스트 · 팔레트 지정 | Gemini image gen 콜 or Pillow blur/그라디언트 렌더 · fetch · resize |
| **1 BackFx** | 어떤 이펙트 (halo · vignette · lens flare) · 컬러 | Pillow 필터 · 마스크 렌더 |
| **2 Person** | 어느 프레임 · 어느 인물 강조 (여러 명이면 화자 우선) · 좌/우/중앙 배치 · 크기 % | 프레임 다운 · rembg 세그 · alpha 크롭 · resize · 배치 픽셀 계산 |
| **3 PersonFx** | glow 색 · shadow 방향 · color pop 사용 여부 | Pillow blur+dilate로 outline · shadow 오프셋 |
| **4 Caption** | 텍스트 · 톤 (인용/훅/의문/충격) · 색 (문자·outline) · 폰트 스타일 힌트 | 자동 개행 · 폰트 파일 룩업 · outline + shadow 렌더 · WCAG 대비 검증·보정 |
| **5 FrontFx** | 스티커 종류 · 개수 · 위치 · 회전 | SVG 라이브러리에서 로드 · Pillow 오버레이 |
| **Composite** | (관여 없음) | Pillow에서 레이어 순차 합성 · 최종 crop 16:9/9:16 |
| **캔버스 정의 자체** | (관여 없음) | 이 §2.1 스택 · Z-order · 규칙 |

**변하지 않는 원칙** (지난 §의 유지):
- 후보 프레임 시점 = 시스템 알고리즘 (scene_frames + shot_types)
- 얼굴 bbox = 시스템 (insightface)
- 인물 세그멘테이션 = 시스템 (rembg)
- 폰트·자동 개행·WCAG 대비 = 시스템
- variant 오케스트레이션·GCS·DB = 시스템

**새로 추가**:
- **AI가 이미지 파일을 직접 만들어도 됨** (Layer 0 배경 한정) — Gemini 2.5 flash image / Imagen.
  - **인물·자막은 여전히 시스템이 픽셀 조합** (누끼는 실 원본 · 자막은 폰트 렌더).
  - AI 이미지 실패 시 원본 blur로 자동 폴백.

### 2.3 Photoshop-MCP 도구 API (핵심)

시스템이 AI에게 노출하는 **도구 세트**. Vertex Gemini의 function calling으로 AI가 호출.
각 도구는 순수 함수 · **결정론적** · 결과는 즉시 문서 상태 갱신 + AI에게 다음 콜용으로 반환.

**문서 상태(Document)**: AI 대화 세션 하나가 문서 하나 편집. 세션 종료 = export_thumbnail → 완성.

```
# Discovery (읽기 전용 · AI가 판단하려고 부름)
list_candidate_frames(top_k=5) → [{id, sec, faces:[{name,bbox,size}], shot_type}]
inspect_frame(frame_id) → {width, height, dominant_colors, brightness, face_details}
get_shorts_context() → {title, description, scene_summary, cast_names, program:{section,mood}}

# Document / Layer 관리
create_document(aspect="16:9"|"9:16") → doc_id  (레이어 스택 초기화 · Layer 0~5 slot 예약)
list_layers() → [{role, source_summary, transform, visible}]
set_layer_visible(role, visible)
clear_layer(role)

# Layer 0 · Background 소스
set_background_from_frame(frame_id, filter:"blur"|"none", blur_px:int)
set_background_gradient(colors:[str,str], angle:int)
set_background_solid(color:str)
generate_background(prompt:str, style:"cinematic"|"illustration"|"photo",
                   palette_hint:[str,...])
  → AI 이미지 (Gemini 2.5 flash image or Imagen) 생성 · Layer 0에 배치

# Layer 1 · BackFx
add_backfx_halo(center:[x,y], radius:int, color:str, opacity:float)
add_backfx_vignette(strength:float)
add_backfx_lens_flare(pos:[x,y], intensity:float)

# Layer 2 · Person
set_person_from_frame(frame_id, subject:"largest_face"|"name:XXX"|"bbox:xyxy",
                     side:"left"|"right"|"center", scale:float)
  → 시스템: 프레임 다운 + rembg 세그 + alpha 크롭 + 좌표 계산 · Layer 2에 배치
  ← 반환: {rendered_bbox, silhouette_edges} (다음 도구 결정에 사용)

# Layer 3 · PersonFx
add_person_outline(color:str, width:int)
add_person_shadow(offset:[x,y], blur:int, color:str, opacity:float)
add_person_color_pop(intensity:float)  # 인물 채도↑, 배경 채도↓

# Layer 4 · Caption
add_caption(text:str, position:"top"|"middle"|"bottom"|[x,y],
           text_color:str, outline_color:str, size_hint:"XL"|"L"|"M",
           font_role:"variety"|"drama"|"news"|"documentary",
           tone_tag:"인용"|"훅"|"의문"|"충격"|"기본")
  ← 시스템 자동 처리: 2어절 개행 · 폰트 룩업 · WCAG 대비 검증·보정 · outline+shadow
  ← 반환: {caption_bbox, contrast_ratio, was_adjusted}
add_subtitle(text, position, ...)  # 부제 (작은 폰트)

# Layer 5 · FrontFx
add_sticker(kind:"arrow-right"|"star-burst"|"shock-badge"|..., pos:[x,y],
           size:int, rotation_deg:int, color?:str)
add_speech_bubble(text, target_bbox, style:"round"|"pointed", tail_dir:"left"|"right")

# 반복 · 판단 지원
render_preview() → PNG base64 (AI가 시각적으로 결과 확인 · 자막 겹침·인물 잘림 등 판정)
undo_last() → 마지막 도구 되돌리기
export_thumbnail() → 최종 composite · GCS 업로드 · variant DB write
```

**세션 종료 조건**:
- AI가 `export_thumbnail()` 호출 (완성)
- 또는 시스템이 turn 한도(예: 12 turn) 초과 시 자동 export

### 2.4 파이프라인 흐름 (도구 호출 시퀀스)

```
[analyze 완료 · shorts.json 있음]
        ↓
[신규 스테이지: thumbnail] ← content-pipeline.ts에 배선
        │
        └── 각 shorts (top-N) 마다:
              │
              ┌── SYSTEM: candidate 프레임 뽑기 (list_candidate_frames가 반환할 것)
              │  · scene_frames + shot_types + faces bbox 재활용
              │
              ┌── AI 세션 시작 (Vertex Gemini · function calling multi-turn)
              │  · 시스템이 tool 세트 + 첫 프롬프트 던짐
              │  · AI는 도구 호출 반복 (예시 turn):
              │      turn 1: get_shorts_context()
              │      turn 2: list_candidate_frames(top_k=5)
              │      turn 3: inspect_frame("frame_002")
              │      turn 4: create_document(aspect="16:9")
              │      turn 5: generate_background(prompt="..", style="cinematic",
              │                                 palette_hint=["#1a2b3c","#e8d4a0"])
              │      turn 6: set_person_from_frame("frame_002",
              │                                    subject="name:원규", side="left", scale=0.9)
              │      turn 7: add_person_outline(color="#ffee00", width=4)
              │      turn 8: add_caption("제가\n결혼할래요?", position="right",
              │                          text_color="#ffffff", outline_color="#000000",
              │                          size_hint="XL", font_role="variety", tone_tag="인용")
              │      turn 9: render_preview()  ← AI가 결과 봄
              │      turn 10: (자막이 인물 얼굴에 겹치면) undo_last() + add_caption(position="bottom")
              │      turn 11: add_sticker(kind="shock-badge", pos=[850,60], size=120)
              │      turn 12: export_thumbnail()  ← 세션 종료
              │
              ┌── SYSTEM: export_thumbnail() 처리
              │  · 최종 composite (레이어 순차 합성)
              │  · 16:9 + 9:16 두 종 렌더
              │  · GCS 업로드: analysis/{mediaId}/thumbnails/{shortId}/{variantId}_{ratio}.png
              │  · DB write: recommendation.data.thumbnails[]
              │  · AI turn 로그 전체 저장 → recommendation.data.thumbnailSession (재현·디버깅용)
              │
              └── variant 3~5개 필요하면 위 AI 세션을 병렬로 N번 (다른 seed)
                     ↓
[Web UI: 클립 카드 · 편집기에 variant grid · 사용자 pick · chosen 갱신]
```

### 2.5 왜 이렇게 나누는가 (도구 API 방식 이점)

- **재현 가능**: 도구 호출 시퀀스가 로그로 저장 → 같은 시퀀스 replay = 같은 이미지
- **디버깅**: 어느 turn에서 잘못됐는지 정확히 추적 (예: "turn 8 add_caption 후 render_preview 결과 나쁨")
- **부분 override**: 사용자가 turn 시퀀스에서 특정 turn만 교체 → 그 뒤 replay ("turn 8 자막만 바꿔")
- **AI 자기 수정**: `render_preview()`가 반환한 이미지를 AI가 재판단해서 undo/재조합 (자막 겹침·색 대비 등)
- **비용**: 세션 하나 = 다중 도구 콜이지만 각 함수 응답은 짧아서 실제 토큰은 통제 가능. 이미지 생성 도구만 별도 비용.
- **테스트**: 각 도구는 순수 함수 · fixture 인자로 unit test 가능
- **미래 확장**: 새 도구(예: `add_speech_bubble`, `apply_film_grain`)만 추가하면 AI가 알아서 씀

---

## 3. 기술 스택 (선택안)

### 3.1 인물 누끼 (세그멘테이션)

| 옵션 | 장점 | 단점 | 결정 |
|------|------|------|------|
| **rembg** (u2net · isnet-general-use) | Python · 성숙 · 무료 · CPU/GPU 둘 다 | 첫 실행시 모델 다운 300MB | **1차 채택** |
| MediaPipe Selfie Segmentation | 빠름 · CPU 실시간 | portrait 전용 · 그룹샷 약함 | 폴백 후보 |
| SAM2 (Meta) | 최고 품질 · bbox prompt | 무거움 · 실행 어려움 | Phase 3+ |
| Vertex Gemini "remove background" | API 하나로 끝 | **현재 없음** (2026-07 시점) | 없음 |

### 3.2 자막 폰트 (한글 · 상용 OK)

| 폰트 | 용도 | 라이선스 |
|------|------|----------|
| Pretendard | 기본 (모든 장르) | SIL OFL · 상용 OK |
| Noto Sans KR Black | 예능 굵은 임팩트 | SIL OFL |
| Nanum Myeongjo | 드라마 감성 | SIL OFL |
| 카페24 · 배민 시리즈 | 특정 톤 원할 때 (스타일 변형) | 각 브랜드 무료 상용 (조건 확인) |

### 3.3 합성

- **Pillow (PIL)** — 파이썬 표준. 알파 채널 · 블러 · 텍스트 · outline · shadow 전부 지원.
- ImageMagick / OpenCV 불필요.

### 3.4 AI 콜 구조 (§2.3 도구 API를 실행)

**Function calling multi-turn 세션** (JSON 단일 응답 아님):

- Model: `gemini-3.1-flash` (function calling + vision · Vertex asia-northeast3)
- Tools: §2.3 도구 세트 전부 JSON schema로 declare (Vertex `tools=[Tool(function_declarations=[...])]`)
- 시스템 프롬프트: "너는 방송사 편집팀의 썸네일 디자이너다. 아래 도구들을 순차 호출해 완성해라. 마지막은 export_thumbnail." + [[title-prompt-yeneung-caption-tone]] 인용
- 첫 turn user 메시지: 쇼츠 컨텍스트 요약
- Turn 한도: 12 (넘으면 시스템이 강제 export)
- 각 turn마다 시스템이 함수 실제 실행 후 결과를 다음 turn의 tool response로 반환
- Temperature: 1.0 (도구 순서 다양성 · 재생성은 1.5 + 다른 seed)

**AI 이미지 생성 도구** (`generate_background`):
- Model 선택 우선순위:
  1. `gemini-3.1-flash-image` (nano banana · 저비용 · 빠름) — Vertex/AI Studio 지원 확인 후
  2. `imagen-4.0-generate-preview` (Vertex Imagen) — 상용 · 고품질 · 폴백
  3. Vertex 못 쓰면 Pillow blur 원본 자동 폴백
- Prompt 강제 접두: "photo · 16:9 · cinematic · 사람 없음 · text 없음"
- 출력: base64 PNG · GCS 업로드 후 Layer 0 source URL

**Variant 3~5개**: 같은 컨텍스트 · 병렬 세션 N개 (다른 seed) · 각자 다른 도구 조합 결과.

**시스템은 도구 실행 · Pillow 합성만.** 인물 컷아웃·자막·스티커는 시스템이 조작 · AI 이미지 생성은 배경 한정.

---

## 4. 신규 파일 · 배선

```
core/thumbnail/                          # NEW · 패키지 (파일 여러 개)
  ├── __init__.py
  ├── canvas.py                          # Layer/Document 클래스 · Pillow composite
  ├── tools.py                           # §2.3 도구 함수 (create_document, set_person_from_frame, add_caption 등)
  ├── tool_declarations.py               # Vertex Gemini function declarations
  ├── ai_session.py                      # multi-turn function calling 오케스트레이션
  ├── image_gen.py                       # generate_background (Gemini 2.5 flash image / Imagen)
  ├── layouts.py                         # 프리셋 룩업 (variety/drama/news 폰트·색)
  ├── contrast.py                        # WCAG 대비 계산·자동 보정
  └── __main__.py                        # CLI: python -m core.thumbnail --recommendation-id X

assets/thumbnail-fonts/                  # ✓ 완료 · Pretendard/Noto Sans/Serif KR
assets/thumbnail-stickers/               # NEW · SVG 스티커 라이브러리 (Phase 3)
apps/server/src/content-pipeline.ts      # 편집 · thumbnail 스테이지 추가
apps/server/src/index.ts                 # 편집 · POST /api/recommendations/:id/thumbnails/regenerate
                                         #        + PATCH /api/recommendations/:id/thumbnails/:variantId (사용자 override)
apps/server/src/db-pg.ts                 # 편집 · thumbnails · thumbnailSession(turn 로그) 필드
apps/web/src/lib/data/api.ts             # 편집 · regenerateThumbnails · patchThumbnailVariant
apps/web/src/components/thumbnail-picker.tsx  # NEW · variant grid + 사용자 pick
apps/web/src/components/thumbnail-editor.tsx  # NEW (Phase 5) · Photoshop-lite 편집기 · 도구별 조작
docs/reference/thumbnail-schema.md       # NEW · Layer/Variant/Session 스키마 문서
```

---

## 5. Phase별 착수 계획

각 Phase에 **도구 세트 · AI · 시스템** 담당 명시.

### Phase 1 — 도구 API 골격 + Layer 스택 + 최소 회로 (3~4일)

**신규 도구** (§2.3 중 필수 최소):
- `list_candidate_frames`, `inspect_frame`, `get_shorts_context` (읽기)
- `create_document(aspect)`
- `set_background_from_frame(frame_id, filter="blur")`
- `set_person_from_frame(frame_id, subject="largest_face", side)`
- `add_caption(text, position, tone_tag)`
- `render_preview()`, `undo_last()`, `export_thumbnail()`

**AI 담당**: 위 도구들을 순차 호출로 조립 (multi-turn function calling).

**시스템 담당**:
- [ ] `core/thumbnail/canvas.py` — Layer 클래스 + Document + Pillow composite
- [ ] `core/thumbnail/tools.py` — 필수 도구 8개 구현
- [ ] `core/thumbnail/tool_declarations.py` — Vertex function schemas
- [ ] `core/thumbnail/ai_session.py` — multi-turn 오케스트레이션 + turn 한도 · 예외 처리
- [ ] `core/thumbnail/contrast.py` — WCAG 대비 계산·자동 outline 보정
- [ ] `content-pipeline.ts` — analyze 완료 후 thumbnail 스테이지 스폰 (상위 3 shorts · 각 variant 1개)
- [ ] GCS 업로드 · `recommendation.data.thumbnails[]` · `thumbnailSession` (turn 로그)
- [ ] Web: 클립 카드에 썸네일 이미지 표시

**검증**: 시연용 유튜브 URL 하나 · turn 로그 사람 리뷰 · 자막 겹침·인물 잘림 등 실측.

### Phase 2 — AI 이미지 생성 배경 (2일)

**신규 도구**:
- `generate_background(prompt, style, palette_hint)` — Gemini 2.5 flash image / Imagen
- `set_background_gradient(colors, angle)`, `set_background_solid(color)`

**AI 담당**: `generate_background()` 호출 · 프롬프트 작문 (프레임 팔레트 참고 · 인물 없음 · 텍스트 없음)

**시스템 담당**:
- [ ] `core/thumbnail/image_gen.py` — Vertex 이미지 모델 어댑터 (Gemini flash image 우선 · Imagen 폴백)
- [ ] 실패 시 원본 blur 자동 폴백 (`set_background_from_frame`로 대체) · 세션 turn에 이유 기록
- [ ] 생성 이미지 GCS 캐시 (프롬프트 해시 키 · 재세션 시 재사용)

### Phase 3 — 이펙트 · 스티커 도구 확장 (2일)

**신규 도구**:
- `add_backfx_halo`, `add_backfx_vignette`, `add_backfx_lens_flare`
- `add_person_outline`, `add_person_shadow`, `add_person_color_pop`
- `add_sticker(kind, pos, size, rotation)` · `add_speech_bubble`

**AI 담당**: 이펙트/스티커 필요성·종류·위치 판단 · `render_preview()` 후 자기 수정

**시스템 담당**:
- [ ] `assets/thumbnail-stickers/` SVG 20~30개 (별표·화살표·배지·리액션)
- [ ] Pillow 필터 (halo=radial blur · vignette=corner darken · flare=lens flare stamp)
- [ ] 얼굴 bbox 기준 자동 crop (얼굴 잘리지 않게 안전 여백)

### Phase 4 — 9:16 세로 (1일)

**AI 담당**: 같은 도구 세트 · aspect="9:16"로 create_document (도구 자체는 aspect-agnostic)

**시스템 담당**:
- [ ] Canvas가 9:16이면 자막 더 크게 · 인물 중앙 우선 프리셋 자동 힌트
- [ ] `variant` 하나에서 export_thumbnail이 16:9 + 9:16 두 파일 동시 생성

### Phase 5 — 사용자 컨트롤 (Photoshop-lite UI) (3일)

**신규 도구** (사용자→시스템 직접):
- Web UI에서 `patch_variant` API로 특정 도구 turn 교체
- 예: turn 8 자막 텍스트 override → 이후 turn replay

**AI 담당**: "다르게 다시" 요청 시 새 세션 (temperature 1.5 · 다른 seed)

**시스템 담당**:
- [ ] `PATCH /api/recommendations/:id/thumbnails/:variantId` — 특정 turn args만 patch · replay
- [ ] Web: `thumbnail-editor.tsx` — Photoshop-lite (layer 리스트 · 각 layer 소스 편집 · undo/redo)
- [ ] 완성 이미지 다운로드 · YouTube publish 자동 첨부 (`snippet.thumbnails`)
- [ ] 사용자 pick·override 이력 → Phase 6+ 학습 데이터

---

## 6. 알려진 함정 · 리스크

- **rembg 모델 다운로드**: 첫 실행 300MB · 로컬 워커 disk에 캐시 (`~/.u2net/`). pm2 재시작마다 재사용.
- **인물 여러 명 프레임**: 얼굴 bbox 여러 개 · 강조 대상 선택 규칙 필요
  - 후보 규칙: (a) 가장 큰 얼굴 (b) 화면 중앙 근접 (c) 현재 대사 화자 (STT speaker + timestamp)
  - Phase 1 = (a) 최대 얼굴만 · Phase 3 = 조합
- **한글 폰트 라이선스**: 상용화 시 SIL OFL · 카페24/배민 조건 재확인
- **성능**:
  - rembg GPU 실행 개당 ~1초 · CPU 개당 ~5초
  - Pillow 합성 개당 ~0.5초
  - 클립당 3 variant · 상위 3 clips = 9 이미지 · 병렬로 15초 이내 목표
- **자막 개행**: 2어절씩 자동 wrap · 3줄 넘으면 폰트 축소
- **원본 프레임 화질**: 480p 유튜브 소스면 upscale 필요 (rembg 전에 REAL-ESRGAN 등 — Phase 4+)
- **가로 영상 → 9:16 세로 변환**: crop 후 인물 다시 배치 (Phase 4)
- **캐싱**: 같은 shorts에 프레임/자막 재생성 요청이면 기존 것 삭제 후 재생성. GCS 경로에 timestamp 붙임.

---

## 7. 데이터 모델 (스키마 추가)

`entities` (kind='recommendation') `data`에 필드 추가:

```ts
interface Recommendation {
  // ... 기존
  thumbnails?: ThumbnailVariant[];
  thumbnailDecision?: ThumbnailAIDecision;  // AI JSON 원본 (디버깅·재렌더용)
}

interface ThumbnailVariant {
  id: string;              // "th_XXXXXX"
  url: string;             // GCS analysis/{mediaId}/thumbnails/{shortId}/{id}_{ratio}.png
  aspectRatio: "16:9" | "9:16";
  frameSourceSec: number;  // AI가 선택한 프레임 시점
  captionText: string;     // 렌더된 자막
  captionTone: "인용" | "훅" | "의문" | "충격" | "기본";
  layoutPreset: "variety" | "drama" | "news" | "documentary";
  personBboxUsed: [number, number, number, number]; // xyxy (AI 판단 근거)
  aiSourceVariantIdx: number;  // ThumbnailAIDecision.captionVariants 인덱스
  generatedAt: number;
  chosen?: boolean;        // 사용자가 pick하면 true (하나만)
}
```

**AI JSON 원본**은 §12 스키마 그대로 저장 → 사용자 override 시 이 필드만 patch해서 시스템 렌더만 재실행.

문서: `docs/reference/thumbnail-schema.md` 신규 (Phase 1 착수와 동시).

---

## 8. UI 배치 (Phase 1 · 2)

- **클립 카드** (`components/shorts-card.tsx`): 기존 프레임 스냅샷 → 썸네일 이미지 (chosen 있으면 그것, 없으면 variant[0]).
- **편집기 프리뷰 옆 사이드바**: variant grid 3~5개 · 클릭 → chosen 갱신 · 자막/폰트 수정 가능 (Phase 5).
- **회차 상세 쇼츠 탭** (`components/derivatives-panel.tsx`): 각 쇼츠 카드에 mini variant thumbnails.
- **재생성 버튼**: 아이콘 (Sparkles) · confirm 없이 즉시 큐잉 · 상단 progress toast.

---

## 9. 향후 확장 (Phase 6+)

- **A/B 테스트 자동화**: 여러 variant 실제 발행 · 클릭률 학습 · 개인 채널 최적화 [[shorts-engine-experiment-log]]
- **템플릿 라이브러리**: 사용자가 즐겨찾기 세션 저장 (도구 turn 시퀀스) · 다음 회차 재사용
- **브랜딩 요소**: 프로그램 로고 · 회차 번호 · 방영일 워터마크 자동 삽입 (`add_watermark` 도구)
- **AI 도구 학습**: 사용자가 자주 undo하는 조합 → 시스템 프롬프트 개선 자동 반영
- **얼굴 표정 강조** (LivePortrait): 스코프 밖 (§11) · 필요해지면 별도 계획서
- **동영상 썸네일** (motion): YouTube API 별개 · 별도 계획서

---

## 10. 착수 조건 (Green light 판단)

Phase 1 착수 전 확인 필요:
- [x] 로컬 워커 GPU 상태 확인 (rembg CPU/DirectML 결정 · CUDA 대신 DML 확인 완료)
- [x] `assets/thumbnail-fonts/` 폰트 파일 다운로드 (61MB · gitignore + 다운스크립트)
- [x] 로컬 워커 rembg 설치 · 179MB 모델 캐시 완료 (~/.u2net/)
- [ ] `stepd-media` GCS 경로 규칙 확정 (제안: `analysis/{mediaId}/thumbnails/{shortId}/{variantId}_{ratio}.png`)
- [ ] Web 클립 카드 레이아웃 (기존 프레임 스냅샷 자리 확보)
- [ ] AI 프롬프트 스키마 (§12) 사용자 리뷰

---

## 11. Non-goals (이 문서에서 다루지 않는 것)

- **얼굴 표정 변형** (LivePortrait · deepfake로 웃음/놀람 만들기): 윤리적 반발 · 스코프 밖.
- **자동 A/B 테스트 · 클릭률 학습**: [[shorts-engine-experiment-log]] 흐름과 통합 · §9 향후.
- **동영상 썸네일 (motion thumbnails)**: YouTube API 별개 기능 · 스코프 밖.
- **AI가 인물/자막까지 이미지로 통째 생성**: **금지** — 실제 출연자 얼굴은 원본 프레임 rembg로만 (합성 이미지 얼굴은 라이선스·법적 문제).
  - AI 이미지 생성 = **Layer 0 배경 한정** (풍경·질감·추상 · 사람 없음).
- **완전 자유 캔버스**: 6-레이어 스택 고정. 무한 레이어 추가는 스코프 밖 (필요시 stack 규격을 늘림).

---

## 12. AI 세션 · 도구 API 계약

### 12.1 Vertex Gemini function calling 스펙

- Model: `gemini-3.1-flash` (Vision + function calling · Vertex asia-northeast3)
- Config:
  - `tools=[Tool(function_declarations=<§12.2 도구 세트>)]`
  - `tool_config={"function_calling_config":{"mode":"AUTO"}}`
  - `temperature: 1.0` (기본) · 재생성 세션은 `1.5` + 다른 seed
  - `max_output_tokens: 4096`
- Turn 한도: 12 (넘으면 시스템이 `export_thumbnail()` 강제)
- 각 세션 = variant 1개 → variant 3~5개면 병렬 세션 N개

### 12.2 도구 declarations (Vertex `FunctionDeclaration` 스타일)

§2.3 도구 시그니처를 Vertex JSON schema로 그대로 옮긴 것. Phase 1은 굵은 표시만.

```python
TOOLS = [
    # ── Discovery (읽기 · 필수) ──────────────────────────────
    { "name": "get_shorts_context",
      "description": "쇼츠 제목·설명·장면 요약·출연자·프로그램 정보 반환.",
      "parameters": {"type":"object","properties":{}}},

    { "name": "list_candidate_frames",
      "description": "후보 프레임 리스트 (scene_frames + shot_types + 얼굴 bbox).",
      "parameters":{"type":"object","properties":{
        "top_k":{"type":"integer","default":5}}}},

    { "name": "inspect_frame",
      "description": "특정 프레임의 도미넌트 컬러·밝기·얼굴 상세.",
      "parameters":{"type":"object","required":["frame_id"],"properties":{
        "frame_id":{"type":"string"}}}},

    # ── Document (Phase 1 필수) ──────────────────────────────
    { "name": "create_document",
      "description": "레이어 캔버스 초기화 (16:9 or 9:16 · Layer 0~5 예약).",
      "parameters":{"type":"object","required":["aspect"],"properties":{
        "aspect":{"type":"string","enum":["16:9","9:16"]}}}},

    { "name": "list_layers",   # 상태 조회
      "parameters":{"type":"object","properties":{}}},

    { "name": "clear_layer",
      "parameters":{"type":"object","required":["role"],"properties":{
        "role":{"type":"string","enum":["background","backfx","person","personfx","caption","frontfx"]}}}},

    # ── Layer 0 Background (Phase 1: blur만 · Phase 2: 나머지) ─
    { "name": "set_background_from_frame",
      "parameters":{"type":"object","required":["frame_id"],"properties":{
        "frame_id":{"type":"string"},
        "filter":{"type":"string","enum":["blur","none"],"default":"blur"},
        "blur_px":{"type":"integer","default":24}}}},

    { "name": "set_background_gradient",   # Phase 2
      "parameters":{"type":"object","required":["colors"],"properties":{
        "colors":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":3},
        "angle":{"type":"integer","default":90}}}},

    { "name": "generate_background",       # Phase 2 (AI 이미지 · reference-guided)
      "description": "Gemini 2.5 flash image로 배경 생성. 원본 프레임(장면 톤)과 인물 사진(스타일)을 reference로 · 사람·텍스트 자동 금지 접두.",
      "parameters":{"type":"object","required":["prompt","style"],"properties":{
        "prompt":{"type":"string","description":"장면·분위기 지시 (사람·텍스트 언급 금지)"},
        "style":{"type":"string","enum":["cinematic","illustration","photo","abstract"]},
        "palette_hint":{"type":"array","items":{"type":"string"}},
        "context_frame_ids":{"type":"array","items":{"type":"string"},
          "description":"원본 프레임 id 배열. 장면 톤·조명·구도 참고 (인물 부분은 시스템이 masking)"},
        "cast_reference_names":{"type":"array","items":{"type":"string"},
          "description":"프로그램 castPhotos 참고할 인물 이름들. 의상·스타일링 톤만 반영 · 얼굴 재현 금지"},
        "reference_mode":{"type":"string","enum":["style","composition","palette"],"default":"style",
          "description":"style=톤/조명만 · composition=구도까지 · palette=색만"}}}},

    # ── Layer 2 Person (Phase 1 필수) ────────────────────────
    { "name": "set_person_from_frame",
      "description": "프레임 → rembg 세그 → alpha 컷아웃 → Layer 2 배치.",
      "parameters":{"type":"object","required":["frame_id","subject","side"],"properties":{
        "frame_id":{"type":"string"},
        "subject":{"type":"string","description":"'largest_face' | 'name:XXX' | 'bbox:x1,y1,x2,y2'"},
        "side":{"type":"string","enum":["left","right","center"]},
        "scale":{"type":"number","default":0.9,"minimum":0.5,"maximum":1.2}}}},

    # ── Layer 3 PersonFx (Phase 3) ───────────────────────────
    { "name": "add_person_outline",
      "parameters":{"type":"object","required":["color"],"properties":{
        "color":{"type":"string"},
        "width":{"type":"integer","default":6}}}},

    { "name": "add_person_shadow",
      "parameters":{"type":"object","properties":{
        "offset":{"type":"array","items":{"type":"integer"},"default":[8,8]},
        "blur":{"type":"integer","default":20},
        "color":{"type":"string","default":"#000000"},
        "opacity":{"type":"number","default":0.5}}}},

    # ── Layer 4 Caption (Phase 1 필수) ───────────────────────
    { "name": "add_caption",
      "description": "메인 자막. 자동 개행·폰트 룩업·WCAG 대비 보정은 시스템이 알아서.",
      "parameters":{"type":"object","required":["text","position","tone_tag"],"properties":{
        "text":{"type":"string"},
        "position":{"type":"string","enum":["top","middle","bottom","top-left","top-right","bottom-left","bottom-right"]},
        "text_color":{"type":"string","default":"#ffffff"},
        "outline_color":{"type":"string","default":"#000000"},
        "size_hint":{"type":"string","enum":["XL","L","M"],"default":"XL"},
        "font_role":{"type":"string","enum":["variety","drama","news","documentary"],"default":"variety"},
        "tone_tag":{"type":"string","enum":["인용","훅","의문","충격","기본"]}}}},

    # ── Layer 5 FrontFx (Phase 3) ────────────────────────────
    { "name": "add_sticker",
      "parameters":{"type":"object","required":["kind","pos"],"properties":{
        "kind":{"type":"string","description":"assets/thumbnail-stickers 파일명 (without .svg)"},
        "pos":{"type":"array","items":{"type":"integer"},"minItems":2,"maxItems":2},
        "size":{"type":"integer","default":120},
        "rotation_deg":{"type":"integer","default":0}}}},

    # ── Coordinate / Layout helpers (Phase 1 필수 · §14 참고) ────
    { "name": "get_canvas_info",
      "description": "캔버스 크기·안전 영역·현재 레이어 실 bbox 반환.",
      "parameters":{"type":"object","properties":{}}},
      # returns: {size:[W,H], safe_zone:[x1,y1,x2,y2], layers:[{role, bbox, visible}]}

    { "name": "suggest_caption_position",
      "description": "자막 텍스트 길이·인물 bbox·안전 영역 감안 · 자동 위치·크기 제안.",
      "parameters":{"type":"object","required":["text","size_hint"],"properties":{
        "text":{"type":"string"},
        "size_hint":{"type":"string","enum":["XL","L","M"]},
        "prefer":{"type":"string","enum":["opposite_person","top","bottom","auto"],"default":"opposite_person"}}}},
      # returns: {position:[x,y], estimated_bbox, needs_wrap:bool, wrap_lines:int}

    { "name": "check_overlap",
      "description": "두 레이어(또는 bbox)의 겹침 IoU · 안전 영역 침범 여부.",
      "parameters":{"type":"object","properties":{
        "a":{"type":"string","description":"레이어 role 또는 'bbox:x1,y1,x2,y2'"},
        "b":{"type":"string"}}}},
      # returns: {iou:float, a_safe:bool, b_safe:bool, warning:str?}

    # ── Reflection / Control (Phase 1 필수) ──────────────────
    { "name": "render_preview",
      "description": "현재까지 조합된 미리보기 PNG(base64) + 모든 레이어 실 bbox. AI가 겹침·잘림 판정.",
      "parameters":{"type":"object","properties":{}}},

    { "name": "undo_last",
      "parameters":{"type":"object","properties":{}}},

    { "name": "export_thumbnail",
      "description": "세션 종료 · 최종 composite · GCS 업로드 · DB write.",
      "parameters":{"type":"object","properties":{}}},
]
```

### 12.3 시스템 프롬프트 (세션 첫 turn)

```
너는 한국 방송사 편집팀의 썸네일 디자이너다. 도구를 순차 호출해서
"이 쇼츠가 클릭될 만한 썸네일" 하나를 조립한다.

권장 순서 (참고 · 필수 아님):
  1) get_shorts_context() 로 무슨 쇼츠인지 파악
  2) list_candidate_frames() + inspect_frame() 로 프레임 골라
  3) create_document(aspect="16:9")
  4) 배경 (Phase 1은 set_background_from_frame(filter="blur"))
  5) set_person_from_frame(...)
  6) add_caption(...)  ← 2~4어절 · 큰 폰트 지향 ·
                        clickbait 어휘 금칙 (담백·여운·인용 톤)
  7) render_preview() 로 확인 · 문제 있으면 undo_last() 후 다시
  8) export_thumbnail() 로 완료

규칙:
- 인물·자막은 이미지 파일로 만들지 마 (인물은 원본 프레임 · 자막은 시스템 폰트).
- generate_background 는 배경 한정 · 프롬프트에 사람/텍스트 금지.
- 자막 톤은 예능이면 담백·여운, 드라마면 감정어. 프로그램 section 참고.
- 최대 12 turn. 넘으면 시스템이 자동 export.
```

### 12.4 시스템 fallback (AI 실패 · 도구 호출 없이 세션 종료)

AI가 아예 도구를 하나도 안 부르거나 turn 12 초과 시 시스템이 최소 썸네일 조립:

```
create_document(aspect="16:9")
set_background_from_frame(largest_face_frame, filter="blur", blur_px=32)
set_person_from_frame(largest_face_frame, subject="largest_face", side="center", scale=0.9)
add_caption(shorts.title, position="bottom", tone_tag="기본",
           text_color="#ffffff", outline_color="#000000", size_hint="XL")
export_thumbnail()
```

로그에는 명확히 `AI_FAIL: <reason> · fallback_used` 기록.

### 12.5 재생성 · Override 정책

- **variant 3~5개** = 초기부터 병렬 세션 N개 (각자 다른 seed · temperature 1.0)
- **"완전 다시"** = 새 세션 (temperature 1.5 · 다른 seed)
- **"자막만 다르게"** = 기존 세션 turn 로그에서 add_caption turn 이후 replay + 새 자막 힌트 프롬프트
- **사용자 수동 편집** (Phase 5): AI 없이 사용자가 도구를 직접 부름 (Web UI → PATCH API)
  예: 자막 텍스트만 바꾸기 → `add_caption(...)` turn args 교체 → 이후 turn replay
- **turn 로그 저장**: `recommendation.data.thumbnailSession[]` — 각 turn의 tool 이름 · args · result summary

---

## 13. 배경 이미지 생성 소스 정책 (`generate_background`)

> "AI 알아서 상상해서 그려" 금지. 항상 **영상 실체 + 인물 실체**를 근거로.

### 13.1 시스템이 자동 첨부하는 4가지 소스

시스템이 `generate_background` 도구 호출을 받으면 AI가 넘긴 `prompt`·`style`·`palette_hint` 위에
**아래 소스들을 Vertex Gemini image gen 요청에 자동으로 첨부**. AI가 명시하지 않아도 붙는다.

| 소스 | 무엇 | 왜 | reference_mode 별 사용 |
|------|------|-----|-------------------------|
| **A. 원본 프레임(들)** | AI가 넘긴 `context_frame_ids` (기본: 선택한 프레임 · 앞뒤 1장씩) | 장면의 실제 조명·시간대·인테리어·야외성·색 톤 유지 | style/composition 필수 · palette는 팔레트 추출만 |
| **B. 인물 사진** | `program.castPhotos[{name}]` (기본: focus 인물의 사진 · 없으면 skip) | 의상·헤어·전체 실루엣 스타일 참고 (얼굴은 재현 금지) | style 선택적 · composition 시 강함 |
| **C. 시놉시스 · 프로그램 정보** | `program.synopsis`·`section`·`mood` | 장르 톤 (예능=밝음/캐주얼 · 드라마=어두움/영화적 · 다큐=자연스러움) | 항상 텍스트 프롬프트에 첨부 |
| **D. 쇼츠 장면 요약** | `shorts.scene_summary`·`shorts.beats[].situation` | 상황 (인테리어·야외·조명·인원) | 항상 텍스트 프롬프트에 첨부 |

시스템 프롬프트 자동 접두 (AI 프롬프트 앞에 붙음):

```
목표: 위 참고 이미지들의 장면 톤·조명·색을 유지한 배경 이미지 생성.
제약:
- 사람 얼굴·전신 그리지 마 (인물은 별도 레이어에서 원본 사진으로 처리)
- 텍스트·자막·글자 그리지 마 (자막은 별도 레이어)
- 참고 이미지의 인테리어·야외성·시간대 유지
- 참고 인물 사진의 의상 톤·컬러 팔레트 부드럽게 반영
컨텍스트:
- 프로그램: {program.title} ({section}, mood: {mood})
- 시놉시스: {synopsis[:200]}
- 장면 요약: {scene_summary}
```

### 13.2 인물 사진 처리 (라이선스·법적 안전)

- **castPhotos는 시스템이 "스타일 레퍼런스"로만 사용** — 프롬프트에 "얼굴 재현 금지"·"의상·컬러만 참고" 명시.
- Gemini 2.5 flash image가 얼굴을 그려버리면 시스템이 후처리로 **얼굴 blur 검증** (insightface로 face detect → 신뢰도 낮으면 재생성 or 강제 blur).
- 만약 castPhotos에 이 프로그램 출연자 사진이 없으면 → 원본 프레임만 사용 (인물 사진 소스 skip).

### 13.3 예시 실제 요청 페이로드

**AI 도구 호출** (Vertex function calling turn):
```json
{
  "name": "generate_background",
  "args": {
    "prompt": "밤 · 카페 · 창가 · 도시 야경 은은한 반사",
    "style": "cinematic",
    "palette_hint": ["#1a2b3c", "#e8d4a0"],
    "context_frame_ids": ["frame_002", "frame_005"],
    "cast_reference_names": ["원규", "지연"],
    "reference_mode": "style"
  }
}
```

**시스템이 Vertex image gen에 보내는 실제 요청**:
```
model: gemini-3.1-flash-image
contents:
  - role: user
    parts:
      - image: <프레임 002 · GCS에서 다운>
      - image: <프레임 005>
      - image: <castPhotos.원규 · dataurl 디코드>
      - image: <castPhotos.지연>
      - text: |
          목표: 위 참고 이미지들의 장면 톤·조명·색을 유지한 배경 이미지 생성.
          제약: [위 자동 접두 그대로]
          컨텍스트: [프로그램·시놉시스·장면 요약]

          [AI 프롬프트]
          밤 · 카페 · 창가 · 도시 야경 은은한 반사
          style: cinematic
          palette hint: #1a2b3c, #e8d4a0

          출력: 16:9 · 사람/텍스트 없음
```

### 13.4 실 파일럿 결과 · default 확정 (2026-07-26)

환승연애 workdir(m_5ec98a5a) 실측 5개 조합 (`scripts/thumbnail_pilot.py`).
상세: [`../research/thumbnail-source-experiments.md`](../research/thumbnail-source-experiments.md)

| 실험 | 소스 | 결과 |
|------|------|------|
| A | 텍스트만 | 일반적 · 프로그램 톤 없음 |
| B | +프레임 1장 | 하우스 톤 유사 · 사람 없음 |
| C | +프레임 +인물 사진 1장 | ⚠️ **얼굴 재현** — 인물 사진 첨부 위험 확인 |
| D | +프레임 2장 (인물 shot + 배경 shot) +인물 2명 | B보다 세련 · 배경 shot 추가가 sanitize |
| E | D + 시놉시스 | **가장 자연스러움** · 감성 톤 확실히 반영 |

**default 확정**: `generate_background()` 는 **프레임 2장 (인물 있는 shot + 배경 shot) + 시놉시스 200~300자**만 자동 첨부.

- **인물 사진 (castPhotos) 자동 첨부 X** — 얼굴 재현 위험 (C가 실증) 대비 톤 반영 실효 낮음.
- 인물의 실 얼굴은 어차피 **Layer 2 (Person) 에서 원본 프레임 rembg**로 담는다 — Layer 0 배경에는 사람 그리지 마.
- AI가 `generate_background()` 인자로 `cast_reference_names` 를 넘기면 시스템은 warn 로그 + 무시.
- 배경 shot 없으면 프레임 1장만 (인물 있는 shot) + 프롬프트에 "인물 지우고 배경만" 강조.

### 13.5 원칙 재확인 — 합치기는 시스템의 몫

파일럿이 확인한 것: **AI가 이미지 파일을 만드는 건 Layer 0 배경 한정 · 그것도 인물 없이**.

```
배경 이미지 (Layer 0)      = AI 생성 (Gemini 2.5 flash image) — 사람·텍스트 없이
인물 컷아웃 (Layer 2)      = 시스템 (원본 프레임 → rembg alpha)
자막 (Layer 4)             = 시스템 (폰트 렌더 + outline + shadow)
─────────────────────────────────────────────────────────────
최종 composite             = 시스템 (Pillow 레이어 순차 합성)
```

**AI에게 "썸네일 한 장 완성해줘"라고 시켜서 얻은 이미지는 절대 최종물이 아니다.** AI 생성 배경은
캔버스의 한 레이어일 뿐 · 사용자에게 보이는 최종 썸네일은 시스템이 Pillow로 배경+인물 alpha+자막을
순차 합성한 결과. 이 원칙을 어긴다는 건 (a) 인물 얼굴 라이선스 문제 (b) 자막 폰트 통제 상실
(c) 재렌더/부분 override 불가.

---

## 14. 좌표 시스템 · 안전 영역 · 충돌 회피 (합치기 알고리즘)

> 합치기 = 시스템의 몫. 시스템이 좌표를 결정론적으로 계산해서 **인물 잘림·자막 겹침·화면 밖 노출** 없이 조립.
> AI는 "어디쯤" 힌트만 (position="right", side="left") · **정확한 픽셀 좌표는 시스템이 결정**.

### 14.1 좌표계 · 안전 영역

- **캔버스**: 16:9 = 1280×720 · 9:16 = 1080×1920 (모든 픽셀 좌표 여기 기준)
- **원점**: 좌상단 (0,0) · x→오른쪽 · y→아래
- **안전 영역 (safe zone)**: 화면 가장자리에서 **각 60px 안쪽** 사각형 (1280×720 기준 60,60 ~ 1220,660).
  - YouTube 재생 UI · 채널 뱃지 · 진행 바가 가리는 영역 회피
  - 자막·인물 얼굴·주요 스티커는 반드시 safe zone 안에 완전 포함
- **얼굴 안전 영역**: 얼굴 bbox는 세로 상단 15% 안쪽으로 떨어져야 (자막 옆에 얼굴이 잘리지 않게)

### 14.2 인물(Layer 2) 좌표 계산 알고리즘

시스템이 `set_person_from_frame(subject, side, scale)`을 실행할 때:

```
1. 원본 프레임 rembg → alpha PNG (segmented person)
2. subject 해석 → 얼굴 bbox 얻기 (insightface)
   · "largest_face": faces 중 최대
   · "name:XXX": episode_cast에서 name 매치 후 bbox
   · "bbox:x1,y1,x2,y2": 그대로
3. 인물 crop 규칙:
   · 상단: 얼굴 상단 y - 얼굴 높이 * 0.3 (머리 여백)
   · 하단: 얼굴 하단 y + 얼굴 높이 * 4.0 (상반신 or 전신)
   · 좌우: 얼굴 중심 ± 얼굴 폭 * 1.5
   · 원본 프레임을 벗어나면 max 클램프 + 여백 채움 (배경 blur 확장)
4. resize: crop된 인물 높이 = 캔버스 높이 * scale (기본 0.9)
5. 배치 좌표 (side 기준):
   · "left":   x = safe_zone.left + 20
   · "right":  x = safe_zone.right - 인물_폭 - 20
   · "center": x = (캔버스_폭 - 인물_폭) / 2
   · y = 캔버스_하단 정렬 · 얼굴은 세로 40% 위치가 되도록 auto 조정
6. 얼굴 bbox를 캔버스 좌표계로 변환해 기록 (자막 배치가 참고)
```

### 14.3 자막(Layer 4) 좌표 계산 · 자동 wrap

시스템이 `add_caption(text, position, size_hint, ...)` 실행 시:

```
1. 폰트·크기 결정:
   · size_hint XL=120px · L=90px · M=70px
   · font_role → 파일 룩업 (variety=NotoSansKR-Black · drama=NotoSerifKR-Black 등)
2. 자동 개행 (wrap):
   · 텍스트를 어절(공백)로 분할
   · 폭 계산 (Pillow font.getbbox) · 자막 최대 폭 = safe_zone_width * 0.55
   · 2~3어절씩 묶어 줄바꿈 · 3줄 넘으면 폰트 -20px 단계 축소 후 재시도
3. 자막 전체 bbox 계산 (개행 반영 · outline + shadow 포함)
4. 위치 결정:
   · position="top"|"bottom"|"middle": safe zone 안 y 좌표 · x는 인물 반대편
   · position=[x,y]: 좌표 그대로 (safe zone 검증)
   · position="opposite_person" (suggest_caption_position 결과): 인물 bbox 반대편 자동
5. 충돌 검사 (§14.4):
   · 인물 bbox와 IoU > 0.10 이면 자동 조정 시도
     (a) 좌우 반대편 이동 · (b) 상하 반대편 · (c) 폰트 -10 축소
   · 3번 시도 후에도 실패 = warn 로그 · AI 다음 turn에서 undo 유도
6. WCAG 대비 보정 (contrast.py):
   · 배경 평균 밝기 확인 · text_color와 대비 4.5:1 미만이면
     outline_color 자동 반전 or outline 폭 +2px
```

### 14.4 충돌 감지 · 회피

시스템이 항상 체크하는 것:

| 검사 | 임계 | 실패 시 |
|------|------|--------|
| 인물 bbox × 자막 bbox IoU | > 0.10 | 자막 위치 자동 조정 (§14.3 5) |
| 인물 얼굴 bbox × safe zone | 얼굴이 안전 영역 밖 | 인물 재배치 (scale ↓ or side 변경) |
| 자막 bbox × safe zone | 자막이 안전 영역 밖 | 폰트 축소 · 개행 재계산 |
| 인물 화면 잘림 (얼굴이 캔버스 밖) | 얼굴 bbox 벗어남 | crop 재계산 · 실패 시 다른 프레임 후보 요청 |
| 스티커 × 얼굴 | 얼굴 위 스티커 | 스티커 위치 회피 (인물 반대편) |
| 자막 × 배경 색 대비 | < 4.5:1 | outline 두께 up · 반전 |

### 14.5 AI 자기수정 흐름 (`render_preview`)

```
turn N   : add_caption(text="...", position="right", size_hint="XL")
turn N+1 : render_preview()   ← 시스템이 자막 실 bbox 반환
           → AI가 "자막이 인물 얼굴에 살짝 겹침" 판단
turn N+2 : undo_last()
turn N+3 : add_caption(text="...", position="bottom", size_hint="XL")
turn N+4 : render_preview()   ← 다시 확인 · OK
turn N+5 : export_thumbnail()
```

`render_preview()` 반환값에는:
- PNG base64 (AI가 시각적으로 확인)
- 모든 레이어의 실 bbox
- 감지된 충돌 warning 리스트 (`["caption overlaps person by IoU 0.12", "sticker outside safe zone"]`)

AI가 warning을 보고 스스로 undo · 재배치. 시스템이 warning을 반환한다고 자동 조정하지는 않음
(자동 조정은 §14.3의 add_caption 안에서만 · 명시적 · 예측 가능하게).

### 14.6 프리셋 레이아웃 (자주 쓰는 조합)

layout enum 값이 사실은 좌표 프리셋:

| Layout | 인물 side · scale | 자막 position · size | 얼굴 대비 자막 |
|--------|-------------------|---------------------|---------------|
| `person-left-caption-right` | left · 0.9 | right · XL | 완전 분리 |
| `person-right-caption-left` | right · 0.9 | left · XL | 완전 분리 |
| `person-center-caption-bottom` | center · 0.85 | bottom · XL | 얼굴 위 자막 X |
| `person-center-caption-top` | center · 0.85 | top · XL | 얼굴 아래 상반신 |
| `person-left-caption-diagonal` | left · 0.95 | top-right + bottom-left 분리 · L | 대각선 이야기 |

AI가 layout enum만 지정하면 시스템이 위 프리셋을 자동 적용 (인물 side/scale + 자막 위치까지).
AI가 세부 조정하고 싶으면 도구 개별 호출 (add_caption(position=[x,y])).

---

## 부록. 참고 링크

- rembg: https://github.com/danielgatis/rembg
- Pillow docs: https://pillow.readthedocs.io/
- SIL OFL: https://scripts.sil.org/OFL
- Vertex Gemini image gen: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini
- 방송 썸네일 관례 정리 (내부 관찰): 별도 리서치 문서 없음 · 필요 시 `docs/research/thumbnail-benchmark.md` 신규

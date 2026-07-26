# 썸네일 엔진 계획 — 사람이 만든 것 같은 쇼츠/클립 썸네일 자동 생성

> 작성 2026-07-26. **계획만** · 아직 구현 X.
> 목표: 영상 프레임 하나 자르는 게 아니라, **인물 누끼 + 배경 + 큰 자막 카피**를 결합해
> 방송사 편집팀이 만든 것 같은 클릭베이트 썸네일을 자동 생성.

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

## 2. AI vs 시스템 책임 분리 (핵심 원칙)

> **"AI 그냥 잘 만들어" 금지.** AI는 판단·창의만 · 시스템은 픽셀 합성·측정·규칙 실행.
> AI 콜은 반드시 **구조화된 JSON 결정**을 반환하고, 시스템은 그 결정을 그대로 렌더.
> 그래야 재현·디버깅·override 가능.

### 2.1 담당 매트릭스

| 항목 | 담당 | 근거 |
|------|------|------|
| 후보 프레임 시점 선정 (몇 초?) | **시스템** (알고리즘) | scene_frames + 얼굴 크기 + shot_type 이미 있음 · 규칙적으로 top-N |
| **어느 프레임이 훅으로 좋은가** | **AI** (Vision) | 표정·구도·상황 이해 필요 · 알고리즘 불가 |
| 얼굴 bbox 검출 | **시스템** (insightface) | 결정론적 CV · AI 낭비 |
| **인물 여러 명 중 누구를 강조** | **AI** (판단) | 내러티브 상 중요도 · 대사 화자 · 반응 |
| 인물 세그멘테이션 (alpha mask) | **시스템** (rembg) | 픽셀 처리 · AI 못 함 |
| **자막 카피 (3~5 variant)** | **AI** (텍스트 생성) | 인용/훅/의문/충격 톤 · 창의 |
| 자막 자동 개행 (2어절씩 wrap) | **시스템** (알고리즘) | 폭 계산 · 결정론 |
| 자막 폰트 · 크기 결정 | **시스템** (프리셋 룩업) | program.section 기반 |
| **자막 색 · 배경 대비 톤** | **AI가 지정** → 시스템 렌더 | 프레임 컬러 팔레트 이해 필요 |
| 색 대비 안전성 (WCAG 4.5:1) | **시스템** (계산 + AI 제안 검증) | AI가 어긴 대비는 시스템이 자동 보정 |
| **레이아웃 (인물 좌/우 · 자막 위치)** | **AI가 결정** → 시스템 배치 | 얼굴 방향·구도 상 자연스러움 |
| 배경 blur/그라디언트 렌더 | **시스템** (Pillow) | 픽셀 연산 |
| **배경 스타일 선택 (blur vs gradient)** | **AI가 결정** | 원본 프레임 분석 후 판단 |
| 이미지 압축 · GCS 업로드 · DB write | **시스템** | 인프라 |
| variant 3~5개 생성 오케스트레이션 | **시스템** (병렬 spawn) | 잡 큐잉 |
| 재생성 · 사용자 pick 상태 관리 | **시스템** | CRUD |

### 2.2 파이프라인 흐름

```
[analyze 완료 · shorts.json 있음]
        ↓
[신규 스테이지: thumbnail]  ← content-pipeline.ts에 배선
        │
        ├── 각 shorts (top-N) 마다:
        │
        │     ┌──── SYSTEM ────────────────────────────────────────┐
        │     │ 1. 후보 프레임 3~5장 뽑기                          │
        │     │    (scene_frames + shot_types + faces.py bbox 재활용)│
        │     │    → 규칙: 얼굴 크기 top-K + shot_type in [클로즈업, 미디엄]│
        │     │ 2. 각 프레임 얼굴 bbox · 크기 · 위치 · 표정 태그    │
        │     │    (기존 faces.py 결과)                            │
        │     └────────────────────────────────────────────────────┘
        │                              ↓
        │     ┌──── AI (Vertex Gemini Vision · 1콜 · JSON out) ────┐
        │     │ Input: 후보 프레임 3~5장 + 쇼츠 컨텍스트            │
        │     │   (title, description, scene_summary, cast 이름,   │
        │     │    program.section, program.mood)                   │
        │     │ AI 결정 (§12 스키마):                              │
        │     │   { chosenFrame: "frame_002",                      │
        │     │     chosenReason: "..",                            │
        │     │     focusPerson: {name, bbox, side:"left"|"right"},│
        │     │     captionVariants: [ {text, tone, dominantColor} × 3~5 ],│
        │     │     background: { mode:"blur"|"gradient"|"halo",   │
        │     │                    palette:["#hex","#hex"] },      │
        │     │     layout: "person-left-caption-right"|...        │
        │     │   }                                                 │
        │     └────────────────────────────────────────────────────┘
        │                              ↓
        │     ┌──── SYSTEM (결정론적 실행) ────────────────────────┐
        │     │ 3. 선택된 프레임 다운 (GCS)                        │
        │     │ 4. rembg 인물 세그 → alpha PNG                    │
        │     │ 5. 배경 렌더 (AI가 지정한 mode/palette로 Pillow)   │
        │     │ 6. Pillow 합성:                                    │
        │     │    · 인물 컷아웃 배치 (AI가 지정한 side)           │
        │     │    · 자막 각 variant마다:                           │
        │     │       - 자동 개행 (2어절씩 · 폭 계산)              │
        │     │       - 폰트 프리셋 (section 기반)                 │
        │     │       - AI가 준 색 → WCAG 대비 검증 · 미달시 자동 보정│
        │     │       - outline + shadow                          │
        │     │    · variant마다 1280×720 (16:9) + 1080×1920 (9:16)│
        │     │ 7. GCS 업로드: analysis/{mediaId}/thumbnails/{shortId}/{variantId}_{ratio}.png│
        │     │ 8. DB write: recommendation.data.thumbnails[]      │
        │     └────────────────────────────────────────────────────┘
        │
        └── (사용자 UI · 재생성 요청 시) → AI 콜만 재실행 (프레임 후보 그대로 재사용)
                ↓
[Web UI: 클립 카드 · 편집기에 variant grid · 사용자 pick · chosen 갱신]
```

### 2.3 왜 이렇게 나누는가

- **재현 가능**: 같은 AI JSON 결정 → 같은 이미지 항상 나옴 (시스템 결정론)
- **디버깅**: AI 결정 로그가 남아 "왜 이 프레임 골랐는지" 추적 가능
- **override**: 사용자가 특정 필드만 바꾸고 시스템 렌더만 재실행 (AI 재콜 없이)
- **비용**: AI 콜 1개로 3~5 variant 다 커버 (자막·배경·레이아웃 다 JSON에 포함) · 매 variant Gemini 콜 안 함
- **테스트**: 시스템 렌더 로직은 fixture JSON으로 unit test 가능

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

### 3.4 AI 콜 구조 (§2.1 매트릭스의 AI 담당 부분)

**1콜로 모든 판단 통합** (자막·프레임·인물·배경·레이아웃 다 하나의 JSON에):

- Model: Vertex Gemini 2.5-flash (Vision · JSON mode)
- Input:
  - 후보 프레임 3~5장 (base64 · 720p로 downsample → 토큰 절약)
  - 컨텍스트: `shorts.title`·`shorts.description`·`scene_summary`·`cast_names[]`·`program.section`·`program.mood`·`speaker_at_frame`
  - 기존 `recommend.py`의 예능 자막 톤 규칙 재활용 [[title-prompt-yeneung-caption-tone]]
- Output: **구조화 JSON** (§12 스키마) — 시스템이 파싱 실패 시 fallback 프리셋 사용
- 재생성 요청: 같은 인풋 · temperature 1.5 · seed 다르게 → 새 variant

**시스템은 이 JSON을 파싱해서 Pillow로 렌더만.** AI에게 이미지 파일 시켜서 안 됨 (Gemini image generation 안 씀).

---

## 4. 신규 파일 · 배선

```
core/thumbnail.py                        # NEW · 세그+합성 파이썬 진입점
core/thumbnail_layouts.py                # NEW · 프리셋(예능/드라마/뉴스) 레이아웃
assets/thumbnail-fonts/                  # NEW · TTF/OTF 파일들
apps/server/src/content-pipeline.ts      # 편집 · thumbnail 스테이지 추가
apps/server/src/index.ts                 # 편집 · POST /api/recommendations/:id/thumbnails/regenerate
apps/server/src/db-pg.ts                 # 편집 · thumbnails 필드 저장/조회 helper
apps/web/src/lib/data/api.ts             # 편집 · regenerateThumbnails 함수
apps/web/src/components/thumbnail-picker.tsx  # NEW · variant grid · 선택 UI
apps/web/src/components/derivatives-panel.tsx # 편집 · 쇼츠 탭에 썸네일 섹션
docs/reference/thumbnail-schema.md       # NEW · variant/style 스키마 문서
```

---

## 5. Phase별 착수 계획

각 Phase에 **AI 담당 · 시스템 담당** 명시. AI는 Vertex Gemini 콜 · 시스템은 파이썬 코드.

### Phase 1 — MVP (2~3일) : 최소 회로 · AI 결정 1콜 + 시스템 렌더

**AI 담당** (§12 프롬프트 스키마):
- 후보 3장 중 훅 프레임 1개 선정 (`chosenFrame`, `chosenReason`)
- 자막 카피 1개 (기본 톤 · shorts.title 재활용 or 다듬기)
- 배경 스타일 `mode:"blur"` 확정 (Phase 1은 blur 고정)
- 인물 좌/우 배치 결정 (`focusPerson.side`)

**시스템 담당**:
- [ ] `core/thumbnail.py` 신규
  - 후보 프레임 추출 (scene_frames 재활용)
  - AI Vision 콜 (Gemini 2.5-flash · JSON out · 파싱 실패 fallback)
  - rembg 세그멘테이션 (isnet-general-use)
  - Pillow 합성 (배경 blur → 인물 alpha 배치 → 자막 렌더)
  - 자막 자동 개행 · 폰트 프리셋 (Pretendard Bold)
  - CLI: `python -m core.thumbnail --recommendation-id X`
- [ ] `content-pipeline.ts`: `analyze` 완료 후 `thumbnail` 스테이지 스폰 (상위 3 shorts)
- [ ] GCS 업로드 · `entities.recommendation.data.thumbnails[0]`
- [ ] Web: 클립 카드에 썸네일 이미지 표시 (기존 프레임 스냅샷 대체)

**검증**: 시연용 유튜브 URL 하나로 e2e · AI JSON 로그 · 이미지 결과 사람 평가.

### Phase 2 — Variant + 톤 (2일) : AI 콜에 variant 담기

**AI 담당** (기존 스키마 확장):
- `captionVariants[]` 3~5개 각각 다른 톤 (인용/훅/의문/충격) · 각자 색 팔레트 지정
- `background.palette` (프레임 이해 기반 컬러 톤)

**시스템 담당**:
- [ ] Pillow 렌더 loop — variant마다 이미지 하나씩 만들기
- [ ] 프리셋 룩업 (예능=Noto Sans KR Black · 드라마=Noto Serif KR Black) — `program.section` 기반
- [ ] WCAG 대비 계산 · AI가 준 색이 미달이면 자동 outline 두께 증가 또는 색 반전
- [ ] Web: variant grid UI · 클릭해서 pick · `chosen` 필드 갱신 API

### Phase 3 — 레이아웃 다양화 (2일) : AI 판단 폭 넓히기

**AI 담당**:
- 인물 여러 명 프레임에서 강조 대상 지정 (`focusPerson.name` · 대사 화자 우선)
- `layout` enum 확장: `"person-left-caption-right"`, `"person-right-caption-left"`, `"person-center-caption-bottom"`, `"person-center-caption-diagonal"`
- 벡터 스티커 필요 여부 · 종류 (`stickers: ["arrow-right", "shock-star"]`) · 위치

**시스템 담당**:
- [ ] 레이아웃 프리셋별 Pillow 배치 함수
- [ ] SVG 스티커 라이브러리 (에셋으로 20~30개) · Pillow 오버레이
- [ ] 얼굴 bbox 기준 인물 자동 crop · 얼굴이 잘리지 않게 여백 룰

### Phase 4 — 9:16 세로 (1일) : 시스템만 확장

**AI 담당**: 변경 없음 (같은 JSON 재사용).

**시스템 담당**:
- [ ] 9:16 레이아웃 별도 함수 (같은 인물 alpha · 다른 배치 · 자막 더 크게)
- [ ] 세로 영상 원본 대응 (좌우 blur 확장 · 인물 중앙)
- [ ] `thumbnails[]`에 aspectRatio 필드로 구분

### Phase 5 — 사용자 컨트롤 (2일) : Override + 부분 재실행

**AI 담당**:
- "재생성" 요청: 같은 컨텍스트 · temperature/seed만 다르게 → 새 JSON

**시스템 담당**:
- [ ] "이 자막으로 바꿔" · "이 프레임으로 다시" · "색 이렇게" — AI 콜 없이 시스템 렌더만 재실행
- [ ] 완성 이미지 다운로드 버튼 · YouTube publish에 자동 첨부 (`snippet.thumbnails`)
- [ ] 사용자 pick 이력 (어떤 톤이 채택률 높은지) — Phase 6+ A/B 학습 준비

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

- **AI 이미지 생성 배경**: 자막·시놉시스 기반 배경 이미지 (SDXL 로컬 · 또는 Vertex Imagen)
- **얼굴 표정 변형**: 놀람·웃음 강조 (LivePortrait · 사용자 반발 가능성 있음)
- **A/B 테스트 자동화**: 여러 variant 실제 발행 · 클릭률 학습 · 개인 채널 최적화 [[shorts-engine-experiment-log]]
- **템플릿 라이브러리**: 사용자가 즐겨찾기 프리셋 저장 · 다음 회차 재사용
- **브랜딩 요소**: 프로그램 로고 · 회차 번호 · 방영일 워터마크 자동 삽입

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

- **AI 이미지 생성** (SDXL · Imagen 등으로 배경을 그리는 것): §9 향후.
- **얼굴 표정 변형** (LivePortrait · deepfake): 윤리적 반발 · §9 향후.
- **자동 A/B 테스트 · 클릭률 학습**: [[shorts-engine-experiment-log]] 흐름과 통합 · §9 향후.
- **동영상 썸네일 (motion thumbnails)**: YouTube API 별개 기능 · 지금 스코프 X.
- **AI가 이미지 파일을 직접 만드는 것**: **금지** (§2.3). 시스템이 Pillow로 결정론적으로 렌더.

---

## 12. AI 프롬프트 · 응답 스키마 (핵심 계약)

### 12.1 Vertex Gemini 콜 스펙

- Model: `gemini-2.5-flash` (Vision · JSON mode)
- `generation_config`:
  - `response_mime_type: "application/json"`
  - `response_schema`: 아래 §12.3 스키마
  - `temperature: 1.2` (자막 창의성)
  - `max_output_tokens: 2048`
- Timeout: 30초 · 실패 시 시스템 fallback (§12.4)

### 12.2 프롬프트 골격 (한국어)

```
너는 한국 방송사 편집팀의 썸네일 디자이너다. 아래 후보 프레임 3~5장과
쇼츠 컨텍스트를 보고, "이 쇼츠가 클릭될 만한 썸네일"을 만들기 위한
편집 결정을 내려라. 결정만 하면 시스템이 픽셀 합성한다.

[쇼츠 컨텍스트]
- 프로그램: {program.title} ({program.section}, {program.mood})
- 쇼츠 제목: {shorts.title}
- 쇼츠 설명: {shorts.description}
- 장면 요약: {shorts.scene_summary}
- 출연자: {cast_names}
- 대사 화자 (프레임별): {speaker_at_frame}

[후보 프레임]
(3~5장 이미지 · 각각 frame_XXX id 붙임)

[결정할 것]
1. chosenFrame: 훅으로 가장 좋은 프레임 하나 (표정·구도·상황 고려)
2. chosenReason: 왜 그 프레임인지 (30자 이내)
3. focusPerson: 강조할 인물 (여러 명이면 대사 화자·큰 얼굴 우선)
4. captionVariants: 자막 후보 3개 (인용/훅/의문 각 하나)
   · 2~4어절 (큰 폰트에 들어가야 함)
   · [[title-prompt-yeneung-caption-tone]] 규칙 준수 (담백·여운·clickbait 금칙)
5. background: blur(원본 blur) / gradient(단색 톤) / halo(인물 강조광) 중 하나
   · palette: 프레임 컬러 톤에서 뽑은 2~3색
6. layout: 인물 좌/우/중앙 + 자막 반대편 (구도 상 자연스러운 방향)

[출력]
아래 JSON 스키마 그대로. 설명·markdown 금지.
```

### 12.3 응답 JSON 스키마

```json
{
  "chosenFrame": "frame_002",
  "chosenReason": "터지는 리액션 · 정면 응시",
  "focusPerson": {
    "name": "원규",
    "bbox": [320, 180, 620, 560],
    "side": "left"
  },
  "captionVariants": [
    {
      "text": "제가\n결혼할래요?",
      "tone": "인용",
      "textColor": "#ffffff",
      "outlineColor": "#000000"
    },
    {
      "text": "3년 만에\n말했다",
      "tone": "훅",
      "textColor": "#ffee00",
      "outlineColor": "#000000"
    },
    {
      "text": "다들 정지",
      "tone": "충격",
      "textColor": "#ff3355",
      "outlineColor": "#ffffff"
    }
  ],
  "background": {
    "mode": "blur",
    "palette": ["#1a2b3c", "#e8d4a0"]
  },
  "layout": "person-left-caption-right",
  "stickers": []
}
```

### 12.4 시스템 fallback (AI 실패 · JSON 파싱 실패 시)

시스템은 AI 없이도 최소 썸네일을 만들 수 있어야 한다:

```
chosenFrame = 후보 중 얼굴 크기 top-1
focusPerson = insightface bbox 최대
captionVariants = [{ text: shorts.title, tone: "기본",
                     textColor: "#ffffff", outlineColor: "#000000" }]
background = { mode: "blur", palette: ["#000000", "#ffffff"] }
layout = "person-center-caption-bottom"
```

이 폴백은 **AI 실패를 감춤이 아니라 최소 결과 보증** · 로그에는 명확히 "AI_FAIL: <원인>" 기록.

### 12.5 재생성 (사용자가 "다시" 눌렀을 때)

- **자막만 재생성**: 시스템이 프롬프트에 "이전 자막: [...]. 이번엔 완전 다른 톤" 추가 · temperature 1.5 · seed 다르게 → 새 `captionVariants[]`만 갱신.
- **전체 재생성**: 위와 같지만 프레임 선정도 다시.
- **특정 필드 수동 편집** (자막 텍스트만 바꾸기 등): AI 콜 없음 · 시스템 렌더만 재실행 · GCS 이미지만 덮어쓰기.

---

## 부록. 참고 링크

- rembg: https://github.com/danielgatis/rembg
- Pillow docs: https://pillow.readthedocs.io/
- SIL OFL: https://scripts.sil.org/OFL
- 방송 썸네일 관례 정리 (내부 관찰): 별도 리서치 문서 없음 · 필요 시 `docs/research/thumbnail-benchmark.md` 신규

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

## 2. 파이프라인 설계

```
[analyze 완료 · shorts.json 있음]
        ↓
[신규 스테이지: thumbnail]  ← content-pipeline.ts에 배선
        │
        ├── 각 shorts (top-N) 마다:
        │     1. 후보 프레임 3~5장 뽑기 (기존 scene_frames 재활용 + 얼굴 큰 프레임 우선)
        │     2. 각 프레임에서:
        │        · 인물 세그멘테이션 → alpha PNG (rembg · GPU · 1~3초)
        │        · 얼굴 bbox 확인 (기존 faces.py · 강조 대상 결정)
        │     3. 자막 카피 3~5개 (Vertex Gemini · shorts.title 재활용/변형)
        │     4. Pillow 합성:
        │        · 배경 = 원본 blur+scale (16:9 crop)
        │        · 인물 컷아웃 화면 좌/우 배치 (얼굴 위치 반대편 자막)
        │        · 자막 굵은 폰트 + outline + shadow
        │        · 프리셋 (예능 · 드라마 · 뉴스) — program.section 기반
        │     5. 각 variant 1280×720 (16:9) + 1080×1920 (9:16 shorts) 2종
        │     6. GCS 업로드: analysis/{mediaId}/thumbnails/{shortId}/{variant}.png
        │
        └── DB write: entities kind='recommendation' data.thumbnails = [{variant, url, style}, ...]
                ↓
[Web UI: 클립 카드 · 편집기에 variant grid · 사용자 pick]
```

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

### 3.4 자막 카피 생성

- 재활용: `recommend.py`가 이미 만드는 `shorts.title` (예능 자막 톤 · [[title-prompt-yeneung-caption-tone]] 반영).
- 신규: **별도 Gemini 콜**로 3~5개 variant.
  - 프롬프트 요건:
    - 2~4어절 · 큰 폰트 지향
    - 인용/훅/의문/충격 4가지 톤 각 1개씩
    - clickbait 어휘 금칙 (기존 title 규칙 유지)
    - 프로그램 장르(section) 반영 — 예능은 담백·여운, 드라마는 감정어

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

### Phase 1 — MVP (2~3일)
**목표**: 인물 컷아웃 + blur 배경 + 기존 title 큰 폰트 하나.

- [ ] `core/thumbnail.py` 신규
  - rembg 세그멘테이션 (isnet-general-use)
  - Pillow 합성 (배경 blur + 인물 alpha + 자막 하나)
  - CLI: `python -m core.thumbnail --media-id X --short-id Y --frame-sec 12.5`
- [ ] `content-pipeline.ts` `analyze` 완료 후 `thumbnail` 스테이지 스폰
  - 상위 3개 shorts만 (성능 안전)
- [ ] GCS 업로드 · `entities.recommendation.data.thumbnailUrl` 필드에 URL 저장
- [ ] Web: 클립 카드에 썸네일 이미지 표시 (기존 프레임 스냅샷 대체)

**검증**: 시연용 유튜브 URL 하나로 e2e · 사람이 봤을 때 "AI냐 사람이냐" 반응.

### Phase 2 — Variant + 톤 (2일)
- [ ] 자막 3~5개 variant Gemini 콜 (인용/훅/의문/충격 톤)
- [ ] `program.section` 기반 폰트/색 프리셋 (예능 vs 드라마)
- [ ] Web: variant grid UI · 클릭해서 pick

### Phase 3 — 레이아웃 다양화 (2일)
- [ ] 얼굴 bbox 활용 · 인물 좌/우 배치 결정 (자막 반대편)
- [ ] 벡터 스티커 (별표 · 화살표 · 배지) · SVG 오버레이
- [ ] 그룹샷(얼굴 여러 개) 처리 · 화자 우선

### Phase 4 — 9:16 세로 (1일)
- [ ] Shorts용 1080×1920 별도 레이아웃
- [ ] 세로 영상 원본 대응 (좌우 여백 · blur 확장)

### Phase 5 — 사용자 컨트롤 (2일)
- [ ] "재생성" 버튼 (다른 톤)
- [ ] 폰트/색 수동 조정 슬라이더
- [ ] "이 프레임으로 다시" (사용자가 프레임 시점 선택 → 새 variant)
- [ ] 완성 이미지 다운로드 · YouTube publish 자동 첨부

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
}

interface ThumbnailVariant {
  id: string;              // "th_XXXXXX"
  url: string;             // GCS analysis/{mediaId}/thumbnails/{shortId}/{id}.png
  aspectRatio: "16:9" | "9:16";
  frameSourceSec: number;  // 어느 시점 프레임을 썼는지
  captionText: string;     // 실제 얹은 자막
  captionTone: "인용" | "훅" | "의문" | "충격" | "기본";
  layoutPreset: "variety" | "drama" | "news" | "documentary";
  personBboxUsed: [number, number, number, number]; // xyxy (검증용)
  generatedAt: number;
  chosen?: boolean;        // 사용자가 pick하면 true (하나만)
}
```

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
- [ ] 로컬 워커 GPU 상태 확인 (rembg CUDA · faster-whisper와 공유 · 메모리 여유)
- [ ] `assets/thumbnail-fonts/` 폰트 파일 다운로드 · 커밋 (라이선스 확인 후)
- [ ] `stepd-media` GCS 버킷의 `analysis/*/thumbnails/*` 경로 규칙 확정
- [ ] Web · 기존 클립 카드에서 썸네일 이미지 하나 크게 표시하는 자리 확보 (레이아웃 논의)

---

## 부록. 참고 링크

- rembg: https://github.com/danielgatis/rembg
- Pillow docs: https://pillow.readthedocs.io/
- SIL OFL: https://scripts.sil.org/OFL
- 방송 썸네일 관례 정리 (내부 관찰): 별도 리서치 문서 없음 · 필요 시 `docs/research/thumbnail-benchmark.md` 신규

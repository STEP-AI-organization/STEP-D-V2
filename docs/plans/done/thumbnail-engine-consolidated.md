# STEP D 썸네일 파이프라인 · 통합 설계안

> 사용자 정리 (2026-07-28) · 오늘 세션 작업과 대조한 현황 마킹 포함

## 1. 검사 대상

- 저장소: `C:/Users/STEPAI05/STEPD-repo`
- 제품 코드: `apps/server` · `apps/web` · `core`
- 레거시: `apps/api` (구 FastAPI · 미사용)

## 2. 관련 핵심 파일

- `core/analyze.py` · 전체 영상 분석 파이프라인
- `core/faces.py` · 얼굴 탐지·임베딩·클러스터링·cast 매핑
- `core/shots.py` · 샷 경계 탐지
- `core/scene_type.py` · 장면 유형 분류
- `core/ppl.py` · PPL/브랜드/텍스트성 프레임 분석
- `core/recommend.py` · 쇼츠/클립 추천
- `core/thumbnail/` · 썸네일 플래너·합성기·캡션 렌더러·CTR 평가기
- `apps/server/src/content-pipeline.ts` · 분석 실행·결과 저장·추천/썸네일 생성 연결
- `apps/server/src/index.ts` · media/frame/thumb/analysis/faces/recommendation/clip API
- `apps/web/src/components/thumbnail-picker.tsx` · 썸네일 선택 UI
- `assets/thumbnail-benchmark/` · MBC/JTBC/Netflix Korea 벤치마크
- `assets/thumbnail-fonts/` · 한글 폰트
- `assets/thumbnail-reference/` · 스타일 학습용 참고 이미지 (2026-07-27 추가)

## 3. 현재 구현 요약 (2026-07-28 기준)

```text
업로드 영상
→ STT
→ 자막 정제
→ 얼굴 탐지/클러스터링
→ PPL/프레임 분석
→ 샷/장면/비트 분석
→ 쇼츠 추천
→ 추천별 썸네일 생성 시도
→ 운영자 선택
→ 클립 채택/렌더링
```

**core/thumbnail 현재 상태** (오늘 세션 완료 항목):
- ✅ AI(Planner)는 JSON 계획만 생성 · 이미지는 시스템 합성
- ✅ 배경: nano banana `mode="hybrid"` · 인물 없는 blur 배경 gen (gemini-3-pro-image)
- ✅ 인물: remove.bg API 세그 (없으면 rembg birefnet-portrait 폴백) → alpha_composite
- ✅ 자막: Pillow overlay · role 4종 (main/subtitle/quote/badge) · role 별 폰트·색·pill
- ✅ Planner 스키마: `hook_summary` + `variants[{background, layout, featured_cast, person_layouts, captions}]`
- ✅ 원핵훅 CoT · 등록 인물 목록 강제 · 뷰 분화 (감정/상황/인용)
- ✅ 스타일 학습: 참고 이미지 → Gemini Vision 분석 → style_profile.md → Planner 프롬프트 주입
- ✅ 여러 variant 생성 (병렬 ThreadPoolExecutor)
- ✅ Vision 기반 CTR 4축 채점 (hook/clarity/tone/polish · Gemini flash)

## 4. 재사용 가능한 기존 모듈

### 4.1 영상 분석 결과
재사용: 추천 start/end · 제목/hook · narrative/synopsis · beat · scene type · shot frame · transcript · cast · PPL 위험 구간

활용: 썸네일 후보 프레임 = 추천 구간 내에서만 · hook 발화 · 감정 반전 · 리액션 · 씬 전환 우선

### 4.2 얼굴/인물 처리
재사용: `core/faces.py` InsightFace · 클러스터 · 대표 crop · cast mapping · cast photo 구조

활용: 실명 자동 확정 X · 운영자 승인된 mapping/photo 만 합성에 사용 · InsightFace embedding 으로 QA

### 4.3 프레임/샷 처리
재사용: `core/shots.py` · `core/scene_type.py` · ffmpeg frame capture · `/api/media/:id/frame?t=...`

활용: 단순 3프레임 X · shot boundary + beat 주변 후보 · 얼굴 크기·선명도·구도·자막 간섭·씬 유형 점수화

### 4.4 썸네일 합성 코드 (오늘 세션 완성)
재사용: `planner.py` · `nano_banana.py` · `caption_overlay.py` · `person_compositor.py` · `ctr_predictor.py`

## 5. 남은 부족 부분

### 5.1 서버 ↔ core.thumbnail CLI 계약 불일치 [MVP1 최우선]
서버는 `python -m core.thumbnail --multi 3` 호출 · 하지만 현재 `core.thumbnail.__main__` 은 `--multi` 대신 새 pipeline 배선.
`multi_session.json` 생성 계약 재확인 필요. → **결과가 recommendation DB 에 안정 반영 안 될 위험**

### 5.2 쇼츠별 컨텍스트 전달 불안정
서버가 `shorts_context.json` 만들지만 · 기본 실행은 `narrative.json` 첫 segment 를 우선 사용.
→ "이 추천 구간" 이 아니라 "영상 전체 첫 구간" 썸네일이 생성될 위험.

### 5.3 프레임별 얼굴 bbox 부족
`faces.json` 은 클러스터 중심 · 하지만 썸네일은 frame-level detection 필요:
- frame timestamp · face bbox · face size ratio · embedding id · eye/open/blur score · cluster id · cast mapping id

### 5.4 생성 썸네일 URL 서빙
`analysis/{mediaId}/thumbnails/...` 저장 경로는 있지만 프론트 안정 접근 API/signed URL 계약 명확화 필요:
- `/api/media/:id/analysis/thumbnails/:shortId/:file` 라우트
- 또는 GCS signed/public URL 저장
- 프론트 `mediaUrl()` 경로 정리

### 5.5 선택 썸네일 → 최종 배포 체인
```text
recommendation → selectedThumbnailId → clip.thumbnailUrl → exported media thumbPath → publish package → channel upload metadata
```
현재 각 단계 정합 확인 필요. clip export 시 여전히 영상에서 단순 캡처하는 흐름일 수 있음.

### 5.6 의존성 누락
`core/requirements.txt` 확인:
- `insightface` · `hdbscan` · `onnxruntime-gpu` / `onnxruntime-directml`
- `rembg[cpu]` (오늘 로컬 설치만 · requirements 미반영)
- worker VM 설치 스크립트 반영

### 5.7 문서 최신화
`docs/archive/plans-2026-07/thumbnail-engine-plan.md` "미구현" 톤 · 실제로는 상당 부분 구현됨 → 이 문서로 대체 or 갱신.

## 6. 현실적인 방송사형 파이프라인 (정본)

**원칙**: AI가 썸네일 전체를 상상하지 않음 · 실제 방송 프레임 + 승인된 인물 + 시스템 타이포 + 검증 가능한 합성.

### 6.1 입력 데이터
```json
{
  "mediaId": "...", "recommendationId": "...",
  "start": 123.4, "end": 178.9,
  "title": "...", "hook": "...", "storySynopsis": "...",
  "beats": [], "transcriptSlice": [], "shotFrames": [],
  "faces": [], "cast": [], "programStyle": {}
}
```

### 6.2 후보 프레임 생성
단순 시작/중간/끝 X · 다음 지점에서 후보:
- hook 발화 직후 · 감정 반응 · beat peak · interview/on_scene 씬
- 얼굴 큰 샷 · 2인 대비 · 자막/로고 덜 가리는 샷 · blur 낮고 조명 안정

후보별 점수:
```json
{"sharpness": 0.87, "faceArea": 0.31, "faceCount": 2,
 "expressionScore": 0.72, "textObstruction": 0.12,
 "composition": 0.81, "sceneRelevance": 0.9, "duplicatePenalty": 0.0}
```

### 6.3 인물 처리 순서
MVP:
1. 원본 프레임 속 인물 cutout
2. 운영자 등록 cast photo cutout
3. cutout 실패 시 원본 프레임 그대로

**금지**: AI 얼굴 새로 생성 · cast photo 로 "닮은 사람" 만들기 · 승인 안 된 인물 실명 추론 · QA 없는 얼굴 변형 합성.

QA: embedding similarity · 얼굴 가림 · 왜곡 · 피부/눈/입 artifact · 추가 얼굴 생성 여부.

### 6.4 배경 처리
MVP: 원본 프레임 확대 · blur · dim · gradient · vignette · 텍스트 영역 확보.
고도화: 사람 없는 배경만 Gemini/Imagen · OCR/face detector 검사 · 실패시 원본 blur 폴백.

### 6.5 AI 플래너 출력
```json
{
  "presetId": "two_person_tension",
  "backgroundMode": "source_blur",
  "persons": [
    {"castId":"cast_01", "source":"frame_cutout", "position":"left", "scale":1.15},
    {"castId":"cast_02", "source":"cast_photo",   "position":"right","scale":1.05}
  ],
  "caption": {"main":"결국 터졌다", "sub":"말없이 굳은 표정",
              "tone":"dramatic", "emphasis":["터졌다"]},
  "style": {"font":"BlackHanSans","mainColor":"#FFFFFF",
             "accentColor":"#00E5FF","strokeColor":"#111111"}
}
```
(현재 배선은 이 스키마와 거의 정합 · person_layouts + captions[] · style profile 은 별도 md)

### 6.6 시스템 합성 레이어 순서
```text
canvas → background frame → blur/dim/color grade
       → person cutout(s) → outline/shadow/rim light
       → caption box or stroke → badges/logo → final QA overlay-safe crop
```
산출: 16:9 1280x720 · 9:16 1080x1920 · 필요 시 4:5, 1:1.
**세로형은 별도 계획 + 별도 합성** (crop 재사용 X).

### 6.7 QA 게이트
자동 통과 조건: 파일 열림 · 해상도/비율 · 얼굴 similarity threshold · 텍스트 가림 X · OCR = 계획 caption · 대비 통과 · 생성 텍스트 X · 정책 · URL 접근 가능.
실패 시: variant reject → 같은 프레임 재합성 → 다른 프레임 → 최종 fallback (원본 프레임 + 시스템 카피).

## 7. MVP 단계

### MVP 1 · 연결 안정화 (미완)
목표: "추천 하나당 3개 썸네일이 실제로 생성되고 UI 에서 선택 가능"
- [ ] 서버 호출 ↔ core.thumbnail CLI 결과물 계약 통일
- [ ] `multi_session.json` 생성 (or 대체 계약)
- [ ] 쇼츠별 `shorts_context.json` 정확 사용
- [ ] 썸네일 파일 API route / signed URL 정리
- [ ] 프론트 `mediaUrl()` 처리
- [ ] `selectedThumbnailId` → recommendation → clip 반영
- [ ] 누락 dependency 정리 (rembg 등)

### MVP 2 · 원본 기반 고품질 합성 (진행 중 · 오늘 세션 대부분 완료)
목표: "AI가 얼굴을 만들지 않고 방송사형 3종 생성"
- [x] Planner CoT + hook_summary
- [x] Planner 4-role captions
- [x] person_compositor (remove.bg + rembg 폴백)
- [x] nano_banana hybrid mode
- [x] 스타일 학습 (참고 이미지 → 프로파일 → Planner 주입)
- [ ] 후보 프레임 sampler (sharpness/expression/composition 점수)
- [ ] face bbox frame-level metadata (faces.json 확장)
- [ ] 3 preset 명시 (리액션/2인 대립/명대사)
- [ ] QA 실패 시 auto fallback

### MVP 3 · 운영자 선택 → 배포 연결 (미착수)
- [ ] `selectedThumbnailId` 저장
- [ ] clip metadata 반영
- [ ] export 결과 thumbPath
- [ ] publish payload
- [ ] 운영자 UI: 비교/선택/재생성

## 8. 품질 고도화 (장기)

### 8.1 인물 cutout 고도화
rembg · BiRefNet · SAM 2 bbox prompt · remove.bg API fallback · edge refinement (머리카락/손/마이크)

### 8.2 얼굴 신뢰도
InsightFace similarity · cast registry 승인 workflow · 클러스터 병합/분리 UI · 중복 방지 · 프로그램별 출연진 DB

### 8.3 스타일 학습
채널별 benchmark embedding · 프로그램별 style profile · 성공 template clustering · title/caption tone guide · A/B 성과 기반 preset ranking

### 8.4 평가 모델
OpenCLIP similarity · OCR 텍스트 검증 · Vision judge hook/clarity/polish · YouTube watch time/CTR/retention 연결

### 8.5 썸네일 에디터
layer JSON 저장 · 텍스트/위치/배경 프레임 교체 · preset 재적용 · regenerate selected layer only

## 9. 추천 오픈소스 · 모델

### Segmentation / Background Removal
- [rembg](https://github.com/danielgatis/rembg) · MVP 적합 · u2net_human_seg / isnet-general-use / birefnet-portrait / bria-rmbg
- [BiRefNet](https://github.com/zhengpeng7/BiRefNet) · 고해상도 · MIT · 방송 인물 고도화 후보
- [SAM 2](https://github.com/facebookresearch/sam2) · prompt 기반 img/vid seg · bbox/click · 비디오 추적 확장
- [BRIA RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) · 품질 좋음 · HF weight 비상업 · SaaS 라이선스 확인
- **remove.bg API** · 상용 · 이미 배선 (`REMOVEBG_API_KEY`)

### Face / Identity
- [InsightFace](https://github.com/deepinsight/insightface) · 현재 stack 부합 · 모델팩 라이선스 확인

### OCR / Text QA
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · 한글 다국어 · 썸네일 텍스트 QA

### Style / Similarity
- [OpenCLIP](https://github.com/mlfoundations/open_clip) · 벤치마크 vs 후보 스타일/의미 유사도

### Image Generation
- [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation)
  - 2026-07 확인: `gemini-3-pro-image` (현재 사용) · `gemini-3.1-flash-image` · `gemini-3.1-flash-image-preview` · `gemini-3.1-flash-lite-image` · `gemini-3.1-flash-image`
  - **STEP D 는 배경만 gen** (인물은 castPhoto 세그 · 얼굴 identity 100%)

# 쇼츠 첫 3초 Hook Intro — 이탈 방지 · Attention Retention

2026-07-31 · 사용자 지시: "쇼츠 안에서 나오는 장면으로 3초 메이킹 및 어그로 · 쇼츠에 들어와서 사용자가 바로 이탈하지 않게 잡아주기 위함".

## 목적

Shorts/Reels 는 **첫 3초 = retention 결정적**. 스크롤 정지·시청 유지의 관문.
편집자·PD 가 이 순간을 놓치면 · 아무리 본문이 좋아도 시청자가 이탈. 그래서:

- **쇼츠 안 실제 장면**에서 · 가장 강한 hook 순간을 뽑아 · **첫 3초에 배치·강조**
- **어그로 톤 자막** (충격·반전·인용문·질문 등 · [[title-prompt-yeneung-caption-tone]] 지침 따름)
- 편집자는 · 이 hook 을 즉시 참고해서 편집 or 미리보기

## 스코프 (γ + α 통합)

### Phase 1 (이 세션): 메타데이터

- `shorts_from_beats` 스키마에 3개 필드 추가:
  - **`hook_quote`**: 실 대사 인용 (STT 원문 · 30자 이내 · 첫 3초에 뜰 텍스트 원본)
  - **`hook_time_sec`**: hook 대사 시각 (초 · 쇼츠 시작에서 얼마 후)
  - **`hook_intro_caption`**: 어그로 톤 편집 자막 (실 대사 다듬어 편집자용 · 20자 이내 · 예 "충격 고백!" "이거 진짜야?")
- Gemini 프롬프트 확장 · "쇼츠 첫 3초 hook 을 골라라" 지시 · 어그로 톤 강제
- Phase 1/Phase 2 (narrative-first) · scenarios · variations 스키마도 동일 확장

### Phase 2 (다음 세션): UI 표시

- Web 편집기 · 쇼츠 카드에 hook_intro_caption 미리보기 badge
- 편집자가 hook 자막을 직접 수정할 수 있는 편집 UI
- 카드에 hook_time_sec 시각 마커 (미니 파형/타임라인)

### Phase 3 (미래): 실제 렌더링 (α)

- ffmpeg 렌더 파이프라인 · 첫 3초에 hook_intro_caption 자막 overlay + zoom effect
- 원 오디오 위에 · 파형 · 시각 강조
- 편집자 승인 후 자동 렌더 · 배포 가능한 완성본

## Schema

```json
{
  "beat_ids": [12, 13],
  "title": "삼성 브랜드 이미지? 의료 전문가 그만두고 요식업",
  "hook": "반전",
  "hook_quote": "저는 원래 삼성증권 다녔어요",
  "hook_time_sec": 8.4,
  "hook_intro_caption": "삼성증권 나온 이유가?",
  "tags": ["직업공개", "반전"],
  "why": "..."
}
```

- `hook_quote` 는 STT 원문 · 검증 가능 (실 대사)
- `hook_intro_caption` 은 어그로 톤 · 편집자용 · 시청자에게 첫 3초 표시할 텍스트

## Gemini 프롬프트 확장 (요약)

```
각 쇼츠에 대해:
- hook_quote: 이 쇼츠 안 대사 중 · 첫 3초 attention 을 사로잡을 · 가장 임팩트 있는 한 문장 원문 그대로 (30자 이내)
- hook_time_sec: 그 대사가 나오는 시각 (초 · 쇼츠 시작 기준 상대 시각)
- hook_intro_caption: 그 대사를 · 시청자가 스크롤 멈추게 만들 어그로 편집자막으로 다듬은 것 (20자 이내 · 어그로/궁금증/충격 톤 · 예 "충격 고백!" "이거 진짜야?" "설마?")

우선 순위:
1. 인용문·폭로·직업공개·반전 순간 (강한 hook)
2. 질문·리액션 (이거 봐야겠다는 자극)
3. 웃음·감정 폭발 (감정 전이)

금지: 담백한 요약형 자막 · 시청자에게 이유를 안 주는 텍스트
```

## 관련 문서·메모리

- [[title-prompt-yeneung-caption-tone]] — 어그로/클릭베이트 톤 (담백 X)
- [[thumbnail-swap-winner]] — 썸네일 스왑 · hook 과 별개 (썸네일은 정지·hook 은 재생)
- `core/recommend.py` — shorts_from_beats · Phase 1/2 스키마
- `apps/web/src/app/(app)/*` — 쇼츠 카드 표시 UI

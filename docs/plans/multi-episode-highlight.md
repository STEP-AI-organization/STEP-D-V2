# 하이라이트 (multi-episode) — 확장 계획

작성: 2026-07-23 · 상태: **보류 (별도 이슈)** · 지금 파이프라인은 숏폼·클립만

## 결정

- **단일 영상 하이라이트 output 제거** (2026-07-23 사용자 결정)
- 이유: 단일 회차의 5~10분 요약은 방송 실무상 무의미 (원본 영상 자체가 이미 그 역할)
- **하이라이트는 여러 영상 종합할 때만 성립**

## 확장 예정: multi-episode highlight

**시나리오**:
- 시즌 하이라이트: "환승연애 시즌 1 · 12화 종합 요약" (10~15분)
- 인물 하이라이트: "은규가 나온 모든 장면 모음" (여러 회차 크로스)
- 주제 하이라이트: "직업 공개 순간 모음" (시즌 통틀어)
- 프로그램 하이라이트: "무한도전 500화 특집" (수년치 압축)

**입력 조건**:
- 최소 2개 이상 영상의 shorts.json 완료
- Program·시즌 단위로 그룹핑 (episodeId → programId → 회차들)
- 각 회차의 시나리오·클립·숏폼 pool을 합쳐 대주제 큐레이션

**구현 방향** (검토용, 확정 아님):
1. **새 API**: `POST /api/programs/:id/highlight` — 프로그램 단위 하이라이트 생성 요청
2. **새 파이프라인**: `core/multi_episode_highlight.py`
   - 입력: 여러 shorts.json + 각 회차 narrative.json
   - Gemini 콜: "이 N개 회차의 큰 서사 흐름 정의 + 편집 시퀀스"
   - output: 시나리오 참조 리스트 (episodeId + start~end + role)
3. **저장 위치**: 새 테이블 `program_highlights` (episodeId 아니라 programId 기반)
4. **UI**: `/programs/:id` 페이지에 하이라이트 탭 추가

**보류 이유**:
- 지금 우선순위 = 단일 회차 숏폼·클립 품질
- 여러 회차 데이터 축적 후 실증 판단
- 방송사마다 하이라이트 정의 다름 (미리 결정 어려움)

## 지금 코드 상태

- `core/recommend.py:curate_highlight()` — 함수는 유지 (dead code · 60분+ 조건으로 실행 안 됨)
- `core/recommend.py:recommend_narrative_first` — `duration >= 3600s` 조건 밑에서만 호출
- `shorts.json.shorts[].type` — `"shortform" | "clip"` 만 (highlight 안 나옴)
- UI 3-type 그룹핑 (`derivatives-panel.tsx`) — highlight 섹션은 items 비어 자동 숨겨짐

**정리 유예**: multi-episode 이슈 착수 시 curate_highlight 재활용 가능 · 지금 삭제하면 재작성 부담. 죽어있는 상태로 유지.

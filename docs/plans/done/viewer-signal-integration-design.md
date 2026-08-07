# 시청자 신호 파이프라인 통합 설계 (B2B SaaS 관점)

> 2026-07-23 · Exp 10~11 실측 결과를 실서비스에 반영하는 설계 문서

## 배경

Exp 10.5·B안 검증에서 **결정적 통찰** 확보:
- 리텐션 rel(대중적 인기) ≠ 시청자 지목(열혈팬 반응) = **서로 독립 신호**
- 하나의 통합 스코어링으로 병합하려는 접근은 잘못
- **목적별 이중 파이프라인**이 옳음

이 통찰을 STEP D **B2B SaaS 제품**에 반영하는 설계.

## 실서비스 제약 (핵심)

**롱폼과 숏폼이 동시에 업로드될 수 있음** → 신규 롱폼 픽 시점엔 **해당 롱폼 자체의 시청자 반응 데이터 없음**.

**해결**: 채널 **과거 데이터**로 시청자 프로파일 학습 → 신규 롱폼 픽에 적용 (Exp 11 실증).

## 아키텍처

### 학습 (Nightly Batch)

```
채널별 nightly cron:
  1. 최근 30일 발행 롱폼 조회 (5+ 롱폼 필요, 콜드스타트 임계)
  2. 각 롱폼 상위 좋아요 100 댓글 수집 (video.comments 잡)
  3. Gemini 8필드 추출 (moment_type, emotion, quote_ref, demand, sentiment)
  4. 채널 단위 aggregation → channel_viewer_profile 저장 (JSONB in youtube_channels 확장)
```

**콜드스타트**: 신규 채널 · 5 롱폼 미만 → 프로파일 없음 → 기존 v2 필터만 사용 (fallback 정상 작동).

### 픽 시점 (Recommend Pipeline)

**목적별 이중 파이프라인** 설계:

```
core/recommend.py:
  new: mode = "reach" | "engagement" | "both"

  reach 모드 (대중 노출용, 기존):
    - apply_profile_fit (hookWeights × targetLength)
    - 리텐션 rel 기준 스코어링 유지
    - 목표: 조회수 극대화

  engagement 모드 (팬층 결집용, 신규):
    - channel_viewer_profile 적용
    - moment_type · emotion 정렬성 스코어
    - viewer_hint_ranges 후보 강제 포함
    - 목표: 좋아요·댓글 극대화

  both 모드 (기본, 기존 API 호환):
    - 두 파이프라인 병렬 실행
    - 결과에 fit_reach·fit_engagement 태그
    - 사용자가 목적별로 선택 가능한 UI
```

### 데이터 스키마 (DB 추가)

```sql
-- youtube_channels 테이블에 컬럼 추가
ALTER TABLE youtube_channels
  ADD COLUMN viewer_profile JSONB,
  ADD COLUMN viewer_profile_updated_at BIGINT;

-- viewer_profile JSON 구조:
{
  "channelId": "...",
  "learned_from": {"n_longs": 8, "n_comments": 400, "total_likes": 1500},
  "moment_type_dist": {"인물반응": 42, "감정폭발": 25, ...},
  "emotion_dist": {"웃음": 38, "감동": 18, ...},
  "demand_category_dist": {"재출연/게스트": 45, ...},
  "top_demand_examples": [["ㅈㄸㄸ쑈 진행 여부", 1500], ...],
  "moment_ref_pct": 56.0,
  "quote_ref_pct": 24.0,
  "demand_pct": 16.0
}
```

## 채널 오너 대시보드 (B2B SaaS UI)

Lab 또는 Analytics에 **"시청자 목소리"** 위젯:

```
[내 채널 시청자 프로파일]
────────────────────────────────
학습 표본: 8편 · 400 댓글 · 지난 30일

📊 이 채널 시청자는:
- 인물반응 순간을 42% 지목 (예능 인물 중심 채널)
- 웃음 감정이 38%로 지배적
- 재출연 요청이 45%로 강함

🎯 시청자 최상위 요청:
1. [1500❤] ㅈㄸㄸ쑈 진행 여부 → 콘텐츠 전략에 반영 권장
2. [50❤] 양상국 재출연
3. [30❤] 부산바캉스 후속편

💡 이 프로파일이 픽 파이프라인에 자동 반영됩니다.
```

**가치**: 오너는 "AI가 뭘 알고 뽑는지" 투명 확인 · 콘텐츠 기획에도 활용 가능.

## Cold-start · Fail-safe

| 상황 | 처리 |
|---|---|
| 신규 채널 (롱폼 < 5) | viewer_profile 없음 → 기존 v2 파이프라인만 (안전 fallback) |
| 댓글 < 100 (전체) | 프로파일 학습 skip. reach 모드만 활성. |
| Gemini 추출 실패 | 부분 프로파일 저장 · 다음 batch에서 완결 |
| 채널 오너가 프로파일 사용 opt-out | mode=reach 강제 · 프로파일 저장은 유지 (재활성 시 즉시 사용) |

## 단계별 롤아웃

### Phase 1 · 프로파일 학습 배치 (인프라만)
- `video.comments` 잡 자동 트리거 (지금 트리거 안 됨)
- `channel.viewer_profile.learn` 잡 신규
- 스키마 마이그레이션 (viewer_profile JSONB 컬럼)
- 학습만, 픽 파이프라인엔 아직 반영 X

### Phase 2 · 오너 대시보드 (제품 가치)
- Lab에 "시청자 목소리" 위젯
- 프로파일 학습 결과 시각화
- 채널 오너가 인사이트 확인 가능
- 픽 파이프라인엔 여전히 반영 X

### Phase 3 · Engagement 모드 파이프라인 (핵심)
- `core/recommend.py`에 mode 인자 추가
- engagement 모드 스코어링 함수 배선
- 프론트에 목적 선택 UI (dropdown)
- A/B 게이트 (offline 검증 후 활성)

### Phase 4 · Viewer_hint_ranges 후보 (규모 무관 정확)
- explicit_timestamp 파싱 (댓글에서 M:SS 자동)
- 픽 후보 생성 단계에서 강제 포함
- v2 필터로 재검증

## 실측 근거 (참고)

- Exp 10: 3채널 15롱폼 1500 댓글 → 채널 규모 = 신호 강도
- Exp 10.5: 26 winner × 시청자 목소리 → ENA 50% 매칭 (known)
- Exp 10 B안: 시청자 명시 시간 12개 · **전부 리텐션과 독립** 실측
- Exp 11: 하하 과거 8 롱폼 → 채널 프로파일 학습 실증 (홀드아웃 예측)

## 우선순위 (사용자 판단)

- **Phase 1 (인프라)**: 빠르고 안전. 데이터 축적. 다음 실험 발판.
- **Phase 2 (대시보드)**: 오너 가치 즉시 제공. 세일즈 데모 자료.
- **Phase 3 (파이프라인 반영)**: 진짜 개선. 검증 게이트 필수.
- **Phase 4 (viewer_hint)**: 정확 신호. 규모 확보 후.

권장 순서: Phase 1 → Phase 2 → Phase 4 → Phase 3.

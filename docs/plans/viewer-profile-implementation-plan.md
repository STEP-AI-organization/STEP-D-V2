# 시청자 신호 실서비스 배선 · 구현 계획 (v2 — 방향 재정렬)

> 2026-07-23 · Exp 10~11 검증 기반 · 사용자 방향 재정렬 반영
> 상위 설계: [viewer-signal-integration-design.md](viewer-signal-integration-design.md)

## 지금 방향 (NOW · 파일럿·초기 서비스)

**원본 영상 자기 자신 댓글**만 참고해서 그 영상의 픽 생성.

- 편집자 시나리오: 롱폼 업로드 → 며칠~수주 후 클립 뽑기 요청 → 그 롱폼에 이미 댓글 있음 → 그 댓글로 픽 신호 강화
- 신규 업로드 즉시 픽은 이 신호 없이 기존 v2로만 (콜드스타트, 안전)
- 채널 단위 학습·프로파일 X · 배치 잡 X · nightly cron X

## 미래 방향 (LATER · B2B 스케일 · 기록 목적)

**전 회차·전 콘텐츠·채널 전체 반응 종합**해서 nightly 학습·프로파일 저장.

- Exp 11에서 검증한 하하 채널 63K 좋아요 학습 패턴
- viewer-signal-integration-design.md Phase 1~4 · viewer_profile.md
- 그때는 채널마다 롱폼 30+ · 댓글 수천+ 규모라 통계 안정
- 지금 시점엔 데이터·인프라 과잉 · **파일럿엔 오버킬**

## 왜 방향 재정렬

- Exp 10에서 하하 3 롱폼 상위 댓글만으로도 강한 시그널(56% moment_ref) 확보
- Exp 11의 63K 좋아요 채널 학습은 **B2B 스케일 준비** 실증 목적 (당장 파이프라인 반영 아님)
- 원본 자기 댓글이 프롬프트 튜닝·픽 부스트에 즉시 활용 가능 · 인프라 부담 최소

---

# 이번 세션 실행 계획 (심플)

## 구성 요소 3개

### A. **원본 영상 댓글 수집** (실시간, 픽 요청 시)
- 픽 생성 시 그 롱폼 videoId로 yt-dlp 실행 (혹은 YouTube API)
- 상위 좋아요 100 댓글 즉시 로드
- 캐싱: 롱폼별 24시간 (`content_analysis.data.viewer_signals` JSON에 저장)

### B. **시청자 신호 추출** (한 번, per-video)
- Gemini 8필드 분류 (Exp 10 스키마 그대로)
- moment_hint · emotion · quote_ref · demand
- explicit_timestamp 정규식 파싱 (Exp 10 B안)

### C. **픽 파이프라인에 신호 주입**
- 프롬프트 힌트로 삽입 (구체 예시로): "이 롱폼 시청자들이 특히 지목한 순간은 A, B, C이다"
- explicit_timestamp 순간은 픽 후보로 강제 포함
- v2 5신호 검증은 그대로 유지 (안전망)

---

## 구현 변경 파일 (4개, 총 ~200줄)

### 1. `core/viewer_signals.py` 신규 (~120줄)
**책임**: 롱폼 하나의 댓글 → 시청자 신호 JSON

**입력**: videoId
**출력**: 
```json
{
  "videoId": "...",
  "n_comments": 50,
  "top_moments": [["양상국 웃김", 20], ...],
  "explicit_timestamps": [{"sec": 643, "likes": 6, "text": "왜 환장을 하지"}, ...],
  "top_demands": [["ㅈㄸㄸ쑈 진행 여부", 1500], ...],
  "dominant_emotion": "웃음",
  "signals_summary_ko": "이 영상 시청자는 양상국 순간, 김원효 반응, 김치 감탄을 특히 지목했습니다..."
}
```

**로직 (Exp 10 코드 정리해서 이관)**:
1. yt-dlp `--write-comments` (상위 100)
2. Gemini 8필드 배치 추출
3. explicit_timestamp 정규식 파싱
4. 집계·요약

### 2. `core/analyze.py` (~15줄 추가)
- `--viewer-signals` CLI 인자 추가 (viewer_signals JSON 경로)
- 없으면 자동 생성 (`core.viewer_signals`) 
- 결과를 recommend에 전달

### 3. `core/recommend.py` (~40줄 추가)
- `_extract_candidates` 프롬프트에 viewer_signals 블록 삽입
  - "이 영상 시청자 반응 요약 (참고)" 섹션
  - top_moments · dominant_emotion · top_demands
- `_synthesize` 후보 생성 시 explicit_timestamps를 강제 후보로 포함
- 프롬프트 확장분 = **구체 예시** (Exp 12에서 확인한 원칙 · 성과 +70% 방향)

### 4. `apps/server/src/content-pipeline.ts` (~20줄 추가)
- content.analyze 잡에 optional viewer_signals 파라미터
- 잡 payload에서 viewerYoutubeId 있으면 `--viewer-signals` 전달

---

## 캐싱·비용

**yt-dlp 호출**: 롱폼당 1회 (첫 픽 요청 시). 결과 캐시.
- 같은 롱폼 재분석 시 재사용
- 24시간 후 무효 (시청자 반응 계속 쌓이므로 정기 갱신)
- 저장 위치: `content_analysis.data.viewer_signals` (기존 JSONB에 필드 추가)

**Gemini 호출**: 롱폼당 1회 (댓글 100개 배치)
- 비용: 대략 2~3 cent per 롱폼
- 파일럿 스케일에선 무시 가능

---

## 콜드스타트 처리

**신규 업로드 롱폼 (댓글 0)**:
- viewer_signals 스킵 (또는 empty 반환)
- 기존 v2 파이프라인만 실행 → 안전한 fallback

**최소 댓글 임계**: 10개 미만이면 skip 권장 (통계 노이즈)

---

## 검증 게이트

### Phase A · 로컬 (즉시 가능)
- 하하 3 홀드아웃 롱폼에 이 새 파이프라인 실행
- 픽 결과가 Exp 8 v2 winners를 얼마나 재현하는지
- 특히 시청자 지목 순간이 픽에 포함되는지

### Phase B · 오프라인 A/B (다채널 확장 시)
- ENA 5 롱폼에 실행
- 기존 vs 신규 Hit@10 대비 · 5회 반복

**게이트 통과 기준**: Hit@10 개선 or 최소 유지 (저하 없음)

**미통과 시**: viewer_signals는 프롬프트에만 소프트 힌트로 유지 · explicit_timestamp 강제 포함은 제거

---

## 배포

- 서버 배포 (`deploy-server.ps1`)
- 워커 배포 (`deploy-worker.ps1`)
- **DB 마이그레이션 없음** (content_analysis.data JSONB에 필드 추가만)
- **feature flag**: `VIEWER_SIGNALS_ENABLED=true` 환경변수로 카나리

**리스크**: 낮음. 픽 파이프라인 프롬프트에 텍스트 삽입만. 실패 시 자동 fallback (viewer_signals 없이).

---

## 순서 (커밋 단위)

### 커밋 1: `core/viewer_signals.py` 모듈 (~120줄)
- yt-dlp 다운로드 · Gemini 추출 · timestamp 파싱 · aggregation
- 단독 실행 검증: 하하 3 롱폼에 대해 실행 → JSON 출력 확인
- Exp 10 결과와 회귀 확인

### 커밋 2: `core/analyze.py` · `core/recommend.py` 배선 (~55줄)
- `--viewer-signals` CLI 인자
- 프롬프트에 신호 블록 삽입
- explicit_timestamps 강제 후보
- 로컬 검증: 하하 3 홀드아웃 재분석 → 픽 개선 확인

### 커밋 3: `apps/server/src/content-pipeline.ts` 배선 (~20줄)
- content.analyze 잡 payload 확장
- feature flag 가드
- 배포 · 실 채널 카나리 (하하만 활성)

---

## LATER 확장 계획 (B2B 스케일 · 기록만)

지금은 안 함. 미래에 활성:

- **채널 단위 nightly 학습**: viewer-signal-integration-design.md Phase 1
  - `channel.viewer_profile.learn` 잡 · viewerProfile JSONB 컬럼
  - Exp 11 검증 로직 (`core.viewer_profile`) 활성화
- **오너 대시보드**: Lab에 "시청자 목소리" 위젯 (Phase 2)
- **목적별 이중 파이프라인**: mode="reach"|"engagement" (Phase 3)
- **cross-episode 학습**: 시리즈 채널의 회차 간 반응 패턴 (drama·예능 시즌)

이 확장들은 **채널당 롱폼 30+ · 댓글 수천+ 스케일**에서 통계 안정·투자 대비 효과 확보. 지금 파일럿 시점엔 오버킬.

---

## 착수 결정 (사용자)

**추천**: 커밋 1 · `core/viewer_signals.py` 모듈부터. 
- 새 모듈 · 기존 파이프라인 영향 0
- 로컬 검증으로 즉시 판정 가능
- 다음 커밋(analyze·recommend 배선)의 발판

**세션 즉시 착수 vs 다음 세션?**

**모듈 이관 · 검증**: 이 세션 (Exp 10 코드 재활용이라 빠름 · 30분~1시간)
**서버·워커 배선 · 배포**: 다음 세션 (배포 안정성 위해)

지금 착수?

# STEP D — Feature Implementation Status

마지막 업데이트: 2026-06-27

---

## Phase 1 — Review OS MVP

| 기능 | 상태 | 비고 |
|------|------|------|
| MP4 파일 업로드 | ✅ 완료 | 최대 2048MB |
| YouTube URL 임포트 | ✅ 완료 | yt-dlp + android_vr 클라이언트 (SABR 우회) |
| OpenAI Whisper STT | ✅ 완료 | 한국어, whisper-1 모델 |
| AI 후보 탐지 (훅 키워드 기반) | ✅ 완료 | candidates.py |
| Gemini 비전 평가 | ✅ 완료 | gemini-3.5-flash, 82% 가중치 |
| 경계 정밀 조정 | ✅ 완료 | 발화 시작/끝 + **문장 종결어미 스냅** (다/요/죠/네 등) |
| 9:16 쇼츠 렌더링 | ✅ 완료 | blur background, 1080×1920 |
| 한국어 자막 번인 | ✅ 완료 | G마켓 산스 TTF Bold (Dockerfile 설치 완료, VM env 미적용) |
| 썸네일 생성 | ✅ 완료 | best_frame_time 기준 JPEG |
| 진행률 표시 (0-100%) | ✅ 완료 | 단계별 진행률 매핑 |
| 클립 재트림 (retrim) | ✅ 완료 | 시작/끝 조정 → 재렌더링 |
| 제목 옵션 생성 (5개) | ✅ 완료 | Gemini, **바이럴 쇼츠 패턴 프롬프트 적용** (직접인용·반전·숫자 등) |
| 썸네일 텍스트 옵션 | ✅ 완료 | 5-14자 한국어 캡션 |
| 크리에이티브 템플릿 적용 | ✅ 완료 | 오버레이·색상·폰트 |
| 클립 삭제 | ✅ 완료 | job + clips + 파일 전부 삭제 |
| 하이라이트 편집본 렌더링 | ✅ 완료 | 여러 클립 합치기 |
| 자막 캡션 탐지 (burned-in) | ✅ 완료 | Gemini, 신뢰도 0.72 기준 |

**미완성 / 예정:**

| 기능 | 상태 | 비고 |
|------|------|------|
| G마켓 산스 VM 활성화 | ⚠️ 대기 | Dockerfile 설치 완료. VM `.env.production`에서 `SHORTS_SUBTITLE_FONT_NAME=Noto Sans CJK KR` 제거 필요 |
| 웹 플레이어 기반 리뷰 UI | 🔄 부분 | 클립 재생 가능, 타임코드 이슈 카드는 미구현 |
| 담당자 승인/반려 워크플로우 | ❌ 미구현 | PDF 계획상 Phase 1 완성 기능 |
| 타임코드 댓글 | ❌ 미구현 | 팀 협업 리뷰 기능 |

---

## Phase 2 — PPL Report

| 기능 | 상태 | 비고 |
|------|------|------|
| PPL 분석 실행 | ✅ 완료 | Gemini Vision, 프레임 샘플링 |
| 브랜드/제품 로고 탐지 | ✅ 완료 | 최대 8프레임, 1초 간격 |
| PPL 오버레이 타임라인 | ✅ 완료 | 타임스탬프별 노출 구간 |
| PPL 싱크 정확도 | ✅ 수정됨 | ffmpeg -ss after -i로 수정 (1-2초 오류 해결) |
| 어필리에이트 링크 저장 | ✅ 완료 | PATCH /ppl/links |
| **노출 초수 자동 집계** | ✅ 완료 | 브랜드별 `exposure_seconds` 합산 |
| **음성 언급 탐지** | ✅ 완료 | transcript.json 세그먼트에서 브랜드명 매칭, clip_time 반환 |
| **잡 레벨 PPL 리포트** | ✅ 완료 | `GET /api/jobs/{job_id}/ppl-report` — 전체 클립 브랜드 통합 집계 |
| **PPL 리포트 CSV 내보내기** | ✅ 완료 | `GET /api/jobs/{job_id}/ppl-report/csv` — UTF-8 BOM, 한국어 컬럼 |

---

## Phase 3 — Edit Suggestion

| 기능 | 상태 | 비고 |
|------|------|------|
| 쇼츠/하이라이트 후보 추천 | ✅ 완료 | AI 스코어 기반 상위 8개 |
| 클립 경계 미세 조정 제안 | ✅ 완료 | boundary refine — 발화 시작/끝 기준 |
| **문장 종결 경계 스냅** | ✅ 완료 | 한국어 종결어미(다/요/죠/네 등) + 마침표 기반 자연스러운 컷 |
| **무음 구간 탐지** | ✅ 완료 | `GET /api/jobs/{job_id}/silence-report` — ffmpeg silencedetect, 3단계 분류 |
| **편집 제안 탭** | ✅ 완료 | 클립 상세 내 무음 컷 후보 리스트 (타임코드·절약 시간 표시) |
| 블러/크롭 제안 | ❌ 미구현 | 개인정보 노출 구간 자동 제안 |
| 편집안 미리보기 | 🔄 부분 | retrim UI 존재, 전체 편집 타임라인 없음 |

---

## Phase 4 — Distribution Analytics

| 기능 | 상태 | 비고 |
|------|------|------|
| YouTube OAuth 연동 | ✅ 완료 | Google Sign-In + YouTube Data API |
| YouTube 업로드 | ✅ 완료 | 제목·설명·태그·카테고리·예약 |
| 채널 성과 지표 조회 | ✅ 완료 | 조회수·구독자·영상 수 |
| **클립별 실시간 성과 조회** | ✅ 완료 | `GET /api/clips/{clip_id}/youtube-stats` — 조회수·좋아요·댓글 수 |
| **댓글 수집** | ✅ 완료 | `GET /api/youtube/clips/{clip_id}/comments` |
| **댓글 AI 요약** | ✅ 완료 | `?summarize=true` — Gemini 텍스트 프롬프트, 감성·테마·하이라이트 반환 |
| 주간 내부 보고서 | ❌ 미구현 | |

---

## Phase 5 — Feedback Loop

| 기능 | 상태 | 비고 |
|------|------|------|
| 성공 패턴 저장 | ❌ 미구현 | |
| 다음 영상 방향 추천 | ❌ 미구현 | |
| 제목/자막 실험 제안 | ❌ 미구현 | |

---

## 알려진 버그 / 임시 해결 상태

| 이슈 | 상태 | 해결 방법 |
|------|------|-----------|
| G마켓 산스 자막 폰트 | ⚠️ 대기 | Dockerfile에 설치 완료. VM `.env.production`에서 `SHORTS_SUBTITLE_FONT_NAME=Noto Sans CJK KR` 줄 삭제 후 재배포하면 G마켓 산스 적용 |
| Gemini 모델 deprecated | ✅ 해결 | gemini-3.5-flash로 교체 |
| YouTube SABR 포맷 오류 | ✅ 해결 | android_vr 클라이언트 + remote_components 리스트화 |
| PPL 오버레이 1-2초 싱크 오류 | ✅ 해결 | ffmpeg -ss를 -i 뒤로 이동 |
| Deno 미설치 (yt-dlp JS 오류) | ✅ 해결 | Dockerfile 멀티스테이지 빌드로 Deno 포함 |
| Caddy 환경변수 오류 | ✅ 해결 | VM에 `/home/STEPAI05/app/.env` 생성 |
| 대사 중간 잘림 | ✅ 해결 | 경계 정제 시 한국어 종결어미 기반 문장 끝 스냅 (candidates.py) |
| VM SCP 권한 오류 | ✅ 해결 | SCP 대신 VM에서 `git pull` → `docker compose up --build` 방식으로 전환 |

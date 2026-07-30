# 신규 도면(도 14~17) 기술 설명 회신 자료

> 작성일: 2026-07-28  
> 목적: 변리사 요청사항인 신규 도면(도 14~17) 관련 기술의 동작 방식, 기준값, 구현 증빙 정리  
> 기준: 현재 리포지토리 구현 기준. 도면 번호는 설명 편의상 아래와 같이 매핑한다.

## 0. 변리사 회신 본문 초안

변리사님, 요청주신 신규 도면(도 14~17) 관련 기술 설명을 아래와 같이 정리드립니다.

- 도 14: 서사 앵커 후보 생성
- 도 15: 숏폼-원본 역매칭
- 도 16: 체크포인트 기반 분석 재개
- 도 17: 레이어 캔버스 기반 썸네일 생성

각 기술별로 동작 방식, 주요 기준값, 현재 구현 증빙 파일/라인을 함께 기재했습니다. 특히 "서사 앵커"는 코드상 `narrative`, `beat`, `scenario` 구조로 구현되어 있으며, 후보 컷의 기준이 되는 `key_moment`, `core_moment_sec`, `beat_id`, `start/end` 구간을 통칭하는 설명 용어입니다. 현재 기본 추천 경로는 자유 시각을 새로 생성하는 방식이 아니라, 먼저 AI가 정돈한 최소 완결 편집 단위(`beats.json`)를 만들고, 추천기는 해당 beat들을 조합하여 숏폼 후보를 생성하는 방식입니다.

아래 상세 자료를 명세서 보완 및 도면 설명 작성에 참고 부탁드립니다.

## 1. 도면-기술 매핑 요약

| 도면 | 기술명 | 핵심 구현 |
|---|---|---|
| 도 14 | 서사 앵커 후보 생성 | STT/정제 자막, 서사 요약, key moment, shot boundary, scene type을 통합해 최소 완결 편집 단위(`beat`)를 만들고, beat 조합으로 숏폼 후보를 산출 |
| 도 15 | 숏폼-원본 역매칭 | 발행된 숏폼 오디오를 원본 롱폼 오디오 위에 FFT 상호상관으로 정렬하여 원본 내 시작 offset과 구간을 추정 |
| 도 16 | 체크포인트 기반 분석 재개 | 단계별 JSON 체크포인트와 미디어별 고정 작업 디렉토리를 사용해 실패/재시도 시 완료 단계부터 재개 |
| 도 17 | 레이어 캔버스 썸네일 | 고정 레이어 스택(background/backfx/person/personfx/caption/frontfx), 안전영역, bbox/IoU, 대비 보정, preview/export를 이용해 썸네일을 합성 |

## 2. 도 14 — 서사 앵커 후보 생성

### 동작 방식

1. 원본 영상 분석 파이프라인이 STT, 자막 정제, 장면/프레임 분석, 인물/서사 분석을 수행한다.
2. `narrative.json`에는 전체 요약, 5분 블록별 상세, key moments, 인물 분석, 주요 갈등/사건이 저장된다.
3. `beats.json`은 `narrative`, 정제 자막, shot boundary, shot type을 입력으로 "그대로 써도 이상하지 않은 최소 완결 편집 단위"를 만든다.
4. 추천기는 기본적으로 beat-only 경로를 사용한다. 즉, 새 시각을 임의 생성하지 않고 `beat_id`를 1~N개 조합해 숏폼 후보의 `start/end/title/hook/tags`를 만든다.
5. beat가 없을 때만 폴백으로 전체 서사를 보고 시나리오 후보를 먼저 만든 뒤(`propose_scenarios`), 각 시나리오의 컷 변형을 평가한다.

### 주요 기준값

| 항목 | 기준값 |
|---|---|
| 기본 추천 모드 | `RECOMMEND_MODE=narrative_first`; beat가 있으면 `mode="beat_only"` |
| 기본 추천 개수 | 요청 기본 `n=5`, 영상 길이/beat 수에 따라 최대 20까지 자동 확장 |
| narrative 블록 | timeline 없으면 5분 단위 블록 합성 |
| narrative 입력 상한 | 전체 요약 자막 3000라인, 블록당 160라인, 라인당 120자 |
| 인물 분석 상한 | 화면 노출시간 기준 상위 15명 |
| beat 최소 길이 | 8초 미만은 파편으로 보고 병합 |
| beat 재분해 기준 | 30초 초과 beat는 소주제 분해 시도 |
| shot boundary 스냅 | beat 경계 ±3초 안의 shot boundary로 보정 |
| word boundary 스냅 | STT word 경계 ±2.5초 안이면 단어 경계로 보정 |
| gap fill | beat 누락 구간이 8초 이상이고 자막이 있으면 자동 beat 생성 |
| gap 분할 | 화자 전환 또는 2초 초과 침묵을 기준으로 분할 |
| 숏폼 목표 길이 | beat-only 프롬프트상 40초~1분30초, 필요 시 최대 120초 허용 |
| 폴백 시나리오 길이 | 이상적 30~90초, 필요 시 120초, 하드 실링 180초 |
| 스코어 축 | `hook_strength`, `payoff`, `completeness` 각 0~10 |
| 스코어 가중치 | hook 0.40, payoff 0.35, completeness 0.25 |
| hook 카테고리 | 반전, 감정고조, 돌직구, 질문, 정보성, 웃음, 갈등, 공감, 기타 |

### 구현 증빙

- `core/analyze.py`
  - 단계별 파이프라인 및 체크포인트 목록: L1~50
  - narrative 생성 후 shot/beat/recommend 단계 연결: L457~604
  - 기본 추천 경로 `recommend_narrative_first`: L591~605
- `core/narrative.py`
  - `narrative.json` 구조: L1~15
  - narrative 기준값: L42~49
  - 구간별 key moments 생성: L250~319
  - 주요 갈등/사건 추출: L394~432
- `core/beats.py`
  - beat 정의와 입출력: L1~21
  - beat 기준값: L46~50
  - word/shot boundary 스냅: L120~126, L614~643
  - gap fill 및 화자/침묵 분할: L645~800
- `core/recommend.py`
  - narrative-first 설계 설명과 길이 상수: L1750~1770
  - 시나리오 후보 스키마: L1906~1939
  - 시나리오 생성 규칙: L1950~1964
  - beat-only 추천 규칙: L2784~3030
  - 기본 경로/폴백 분기: L2702~2720, L3164~3211
  - 3축 스코어 및 가중치: L563~583

## 3. 도 15 — 숏폼-원본 역매칭

### 동작 방식

1. YouTube 채널 동기화 결과(`channel_videos`)에서 숏폼과 롱폼 후보를 나눈다.
2. 운영자가 Lab에서 수동 매칭을 저장하거나, 자동 매칭을 요청한다.
3. 자동 매칭은 롱폼 1편 단위로 `match.align` 잡을 큐에 넣는다. 같은 롱폼은 dedupe key로 중복 큐잉을 막는다.
4. 워커가 yt-dlp로 롱폼/숏폼의 오디오만 다운로드한다.
5. `core.align`이 두 오디오를 16kHz mono PCM으로 통일하고, 로그-멜 스펙트로그램 특징을 만든다.
6. 숏폼 특징을 롱폼 특징 위로 미끄러뜨리며 FFT 기반 정규화 상호상관을 계산한다.
7. 최고점 위치를 원본 롱폼 내 시작 offset으로 판단한다.
8. 일치도와 peak ratio가 기준 이상일 때만 `short_source_map`에 자동 매칭 결과를 저장한다.
9. 자동 결과는 `source="auto"`와 `confidence`를 남기고, 사람 확인 전까지 `confirmedAt`을 비워 학습 데이터 오염을 막는다.

### 주요 기준값

| 항목 | 기준값 |
|---|---|
| 오디오 샘플레이트 | 16,000 Hz mono |
| STFT | `N_FFT=1024`, `HOP=512` |
| 프레임 해상도 | 초당 약 31.25프레임, offset 오차 약 ±0.03초 수준 |
| 멜 밴드 | 40 bands |
| feature 정규화 | 프레임별 평균 제거 및 L2 정규화 |
| 자동 채택 일치도 | `MIN_SCORE=0.80` 이상 |
| 자동 채택 peak ratio | `MIN_PEAK_RATIO=1.25` 이상 |
| 실측 양성 | score 0.886~0.998, ratio 1.66~1.82 |
| 실측 음성 | score 0.403~0.601, ratio 1.00~1.09 |
| 쇼츠 분류 보조 기준 | `isShort=true` 또는 duration 180초 이하 |
| bulk 후보 기간 | 롱폼 게시 후 180일 이내 숏폼 |
| 원본 롱폼 최소 길이 | 240초 이상 |
| bulk 잡당 숏폼 상한 | 14개 |
| bulk 점수식 | 제목 토큰 겹침×10 - 게시일 차이×0.02 - 무겹침 페널티 6 |

### 구현 증빙

- `core/align.py`
  - 기술 설명 및 한계: L1~19
  - 오디오/특징 기준값: L32~44
  - ffmpeg 16kHz mono 디코딩: L60~67
  - 로그-멜 특징 및 정규화: L98~124
  - FFT 상호상관: L127~137
  - 롱폼 특징 1회 계산 후 여러 숏폼 매칭: L140~152
  - 신뢰도 판정 및 offset 산출: L165~193
- `apps/server/src/index.ts`
  - Lab 매칭 API와 쓰기 토큰 보호: L4037~4060
  - 숏폼/롱폼 후보 목록: L4074~4107
  - 수동 매칭 저장 및 구간 검증: L4110~4152
  - 자동 매칭 큐잉: L4155~4185
  - bulk 후보 계획 기준값: L4201~4267
  - bulk 큐잉 stagger: L4286~4317
- `apps/server/src/worker.ts`
  - `match.align` 설계 설명: L506~514
  - 오디오 다운로드 및 Python 정렬 호출: L526~568
  - 자동 매칭 저장: L571~626
- `apps/server/src/db-pg.ts`
  - `short_source_map` 타입 및 필드: L665~692
  - manual/auto 구분, `confirmedAt` 처리: L701~735
- `apps/server/migrations/0005_short-source-map.cjs`
  - 기본 매핑 테이블: L3~37
- `apps/server/migrations/0006_short-source-map-auto.cjs`
  - `source`, `confidence`, `confirmedAt`: L3~29
- `apps/server/migrations/0007_short-source-map-segment.cjs`
  - 매칭 구간의 학습 입력 필드: L3~24

## 4. 도 16 — 체크포인트 기반 분석 재개

### 동작 방식

1. Cloud Run 서버는 분석을 직접 수행하지 않고 `content.analyze` 잡을 큐에 넣는다.
2. 워커 VM이 잡을 가져와 미디어별 고정 작업 디렉토리(`$TMP/stepd-content/<mediaId>`)에서 분석한다.
3. Python 파이프라인은 각 단계 완료 시 JSON 체크포인트를 원자적으로 저장한다.
4. 재시도 시 같은 작업 디렉토리를 다시 사용해 이미 완료된 단계는 재사용한다.
5. `manifest.json`은 영상명/크기 및 단계별 파라미터 fingerprint를 저장한다.
6. 다른 영상이거나 관련 파라미터가 바뀐 단계만 무효화하고, 비용이 큰 STT/프레임 분석 등은 가능한 보존한다.
7. 실패 시에도 완료된 transcript/scenes/cast 등 partial 산출물을 DB와 GCS에 저장하고, 작업 디렉토리는 삭제하지 않는다.
8. 성공 시 작업 디렉토리를 삭제하며, 방치된 디렉토리는 48시간 TTL로 청소한다.

### 주요 기준값

| 항목 | 기준값 |
|---|---|
| 체크포인트 파일 | `stt.json`, `refined.json`, `faces.json`, `ppl.json`, `scenes.json`, `cast.json`, `timeline.json`, `narrative.json`, `shots.json`, `scene_type.json`, `beats.json`, `shorts.json`, `analysis.json` |
| 원자적 저장 | `.tmp`에 쓰고 `os.replace()` |
| 작업 디렉토리 | `$TMP/stepd-content/<mediaId>` |
| 작업 디렉토리 TTL | 48시간 |
| Vision 중간 저장 | 20개 scene 처리마다 `scenes.json` 저장 |
| Vision 동시성 | 6개 Vertex call |
| 프레임 실패 상한 | 프레임당 3회 실패 시 영구 skip 처리 |
| 진행률 마커 | stdout `@@PROGRESS {stage,pct,note}` |
| 진행률 DB 쓰기 throttle | 2% 미만 변화이면서 3초 이내면 생략 |
| stall watchdog | stdout 무출력 60분 기본값 |
| queue maxAttempts | 기본 5회 |
| stale lock | 30분 |
| fail backoff | 30초 지수 백오프, 최대 30분 |

### 구현 증빙

- `core/analyze.py`
  - 체크포인트 재개 개요: L11~20
  - 체크포인트 목록: L50
  - 원자적 저장: L55~60
  - manifest/fingerprint와 파라미터별 무효화: L69~154
  - 진행률 마커: L157~164
  - 단계별 체크포인트 재사용 예시: L230~291, L457~482, L557~618
- `core/vision.py`
  - 재개 인식 및 중간 checkpoint: L15~17
  - `SAVE_EVERY=20`, `MAX_FRAME_ATTEMPTS=3`: L51~55
  - 이미 분석된 scene skip: L114~148
  - save callback 호출: L189~201
- `apps/server/src/content-pipeline.ts`
  - 미디어별 고정 work dir와 48h TTL: L9~20, L48~67
  - `python -m core.analyze` 실행과 progress 파싱: L135~234
  - 소스 파일 재사용: L869~877
  - 진행률 DB 반영: L879~899
  - partial 수집: L817~850
  - 성공/실패 시 산출물 저장 및 work dir 처리: L1018~1136
- `apps/server/src/queue.ts`
  - job queue와 `FOR UPDATE SKIP LOCKED`: L1~11, L108~138
  - dedupe index: L79~86
  - heartbeat/stale lock: L149~170, L203~223
  - retry/backoff: L172~201

## 5. 도 17 — 레이어 캔버스 기반 썸네일

### 동작 방식

1. 분석 완료 후 워커가 각 숏폼 후보별로 `shorts_context.json`을 만들고 Python 썸네일 엔진을 호출한다.
2. 기본 실행은 variant 3개 생성이며, 결과는 `multi_session.json`으로 반환된다.
3. 생성된 PNG는 `analysis/{mediaId}/thumbnails/{shortId}/{variantId}_{ratio}.png` 경로에 업로드된다.
4. 추천 엔티티에는 썸네일 variant 목록, 선택값, caption, layout, person bbox 등 메타데이터가 저장된다.
5. 레이어 캔버스 엔진은 Photoshop식 고정 레이어 스택을 사용한다.
6. 배경, 인물, 자막을 별도 레이어로 두고, bbox/안전영역/IoU/대비 보정을 통해 충돌 없는 썸네일을 만든다.

### 주요 기준값

| 항목 | 기준값 |
|---|---|
| 레이어 순서 | `background`, `backfx`, `person`, `personfx`, `caption`, `frontfx` |
| 지원 캔버스 | 16:9 = 1280×720, 9:16 = 1080×1920, 1:1 = 1080×1080 |
| safe zone | 가장자리 60px 안쪽 |
| preview | 긴 변 720px 축소 PNG |
| undo stack | 최근 30개 |
| 배경 blur 기본값 | Gaussian blur 24px |
| 인물 배치 scale 기본값 | frame 인물 0.9, cast photo 0.95 |
| 자막 폰트 크기 | XL 120px, L 90px, M 70px |
| 대비 기준 | WCAG 대비 4.5 이상으로 색/외곽선 보정 |
| 충돌 경고 | caption-person IoU 0.10 초과 |
| 얼굴 침범 경고 | caption-face bbox IoU 0.05 초과 |
| export 가드 | 기본적으로 person layer 없으면 export 거부 |
| 운영 variant 수 | 숏폼당 3개 |

### 구현 증빙

- `core/thumbnail/canvas.py`
  - 6-레이어 Document 구조: L1~18
  - 캔버스 크기와 safe margin: L21~28
  - 레이어 transform/metadata: L30~52
  - safe zone, undo, layer bbox: L73~131
  - alpha composite 및 blend mode: L133~189
  - bbox IoU: L192~203
- `core/thumbnail/tools.py`
  - 후보 프레임 탐색 및 얼굴 큰 순 정렬: L53~91
  - document 생성: L115~118
  - 배경 프레임 cover-fit/blur: L143~159
  - 인물 crop/rembg/배치/face bbox 기록: L162~232
  - 자막 자동 배치/대비 보정: L370~421
  - canvas info, caption position, IoU 검사: L424~467
  - preview warning 및 export 가드: L470~520
- `core/thumbnail/tool_declarations.py`
  - 레이어 캔버스 도구 스키마: L38~212
- `core/thumbnail/planner.py`
  - 쇼츠 구간의 실제 대사/narrative/scene 슬라이싱: L553~612
  - planner 프롬프트 입력 구성 및 다인물 강제 규칙: L138~230
- `core/thumbnail/__main__.py`
  - 서버 호출 계약과 `multi_session.json`: L1~8
  - 기본 variant 실행: L44~108
  - `--legacy-layer` 레이어 방식 실행 경로: L111~126
- `apps/server/src/content-pipeline.ts`
  - 썸네일 엔진 호출, variant 3개 생성, GCS 업로드, 추천 엔티티 갱신: L573~707
- `apps/web/src/components/thumbnail-picker.tsx`
  - 웹에서 썸네일 후보 표시 및 선택: L9~97

## 6. 전달 시 주의사항

- 위 내용은 현재 구현 기준의 기술 설명이며, 청구항 표현은 변리사 검토가 필요하다.
- `short_source_map`과 `youtube_channels.pointProfile`은 `docs/reference/data-model.md`에도 반영했다. 명세서 증빙은 코드와 마이그레이션 파일을 우선 기준으로 삼는 것이 안전하다.
- 썸네일의 경우 현재 기본 CLI는 hybrid 파이프라인을 먼저 사용하고, 레이어 캔버스 방식은 `--legacy-layer` 및 도구/합성 엔진으로 구현되어 있다. 도 17 설명에서는 "레이어 캔버스 엔진 구조"와 "운영 호출 경로"를 구분해 기재하는 것이 정확하다.

# 파이프라인 최적화·정보 유실 조사

작성: 2026-07-23 · 근거: `core/*.py`, `eval/snapshots/before-20260723-115124/`, worker log

이 문서는 **사실만** 나열한다. "느리다/좋다/개선하자"의 판정과 우선순위는 사용자 몫이다.

---

## 1. 실측 스테이지 소요시간

`eval/snapshots/before-20260723-115124/*/analysis.json`의 `stage_sec` 필드 8건 집계.

`0.0s`로 표시된 스테이지는 **체크포인트 재사용** (해당 파일이 이미 있어 재실행 스킵). 재실행이 실제로 걸린 항목만 병목 판정의 근거.

| 미디어 | dur | STT | refine | faces | ppl | timeline | narrative | recommend | total |
|---|---|---|---|---|---|---|---|---|---|
| kbs 다큐 | 46:53 | (캐시) | (캐시) | **764s** | **831s** | 32s | 147s | 93s | 31분 |
| 청문회 | 108:15 | 135s | 415s | 347s | **594s** | 53s | 209s | 120s | 31분 |
| 축구경기 | 109:00 | (캐시) | (캐시) | (캐시) | **3787s** | 49s | 203s | 72s | 68분 |
| 김부장 | 13:59 | 52s | 91s | **335s** | 176s | 12s | 97s | 37s | 13분 |
| 유퀴즈 | 14:09 | 32s | 133s | **451s** | 309s | 12s | 105s | 37s | 18분 |
| 환승연애 | 9:51 | 52s | 120s | **409s** | 136s | 10s | 85s | 10s | 14분 |
| 런닝맨 | 14:12 | 98s | 219s | **2167s** | 333s | 13s | 88s | 16s | 49분 |
| 테스트 | 12:08 | 50s | 91s | **1094s** | (실행됐는지 불명) | 14s | 110s | 11s | 23분 |

**관측**:
- **faces**: 14분 영상에서 335~2167초 (5~36분). refined 세그먼트 수에 비례 — `core/faces.py:155`에서 `for i, seg in enumerate(refined):` 로 **세그먼트마다 1프레임 단일-스레드 InsightFace 검출**. 런닝맨이 2167s인 건 세그먼트가 많거나 DirectML cold-start.
- **ppl**: 축구경기 3787s (63분). PPL_SAMPLE_SEC=5s × 109min → **1308 프레임**. `PPL_WORKERS=6` 병렬이라도 초당 처리량 제한.
- **narrative**: 영상 길이 무관 85~210s (일정). Gemini 콜 4~5회 (full_summary + segments 배치 + characters + conflicts).
- **timeline**: 10~53초. 블록 배칭(8/call)이라 콜 수 적음.
- **recommend**: 10~120초. Phase 1 병렬 청크 × PER_CHUNK=6, Phase 2 합성 1회, 재제목 1회.
- **STT/refine**: 대부분 캐시 재사용. 실제 첫 실행은 STT ~2분/108min, refine ~7분/108min.

**real-time 비율**:
- 108분 영상 = 31분 처리 (29% rt · 매우 빠름)
- 14분 영상 = 13~49분 처리 (95~344% rt) — faces/ppl fixed cost 때문
- 짧은 영상에 상대적으로 오래 걸림 (fixed overhead: InsightFace 모델 로딩 · Gemini 첫 콜 latency)

---

## 2. 스테이지 종속성 그래프

`core/analyze.py`가 순차 실행 중. 실제 데이터 의존만 뽑으면:

```
[video]
  ├──> STT ──> refine ─┬──> faces ──┐
  │                    ├──> ppl     ├──> narrative ──> recommend
  │                    └──> scenes ─┼──> cast ────────────┘
  │                                 └──> timeline ────────┘
  │
  └──> (ppl은 video만 필요 — refined 안 봄)
```

실제 코드상 종속성:

| 스테이지 | 필요한 입력 | 코드 근거 |
|---|---|---|
| STT | video | `asr.transcribe(video_path, ...)` |
| refine | STT segments | `refine.refine_segments(segments)` |
| faces | video + refined (speaker 덮어씀) | `faces.build_face_index(video, refined)` |
| ppl | video만 | `ppl.build_ppl_index(video, duration, ...)` — `refined` 안 씀 |
| scenes | refined (5분 청크) | `scenes_from_duration_chunks(refined)` |
| cast | scenes + cast_registry | `cast.build_cast_timeline(scenes, cast_registry)` |
| timeline | scenes | `timeline.build_timeline(scenes)` |
| narrative | refined + scenes + cast + timeline | `narrative.build_narrative(refined, scenes, cast, timeline, ...)` |
| recommend | scenes + refined + narrative_segments + cast_registry | `recommend.recommend(scenes, ..., transcript, cast_registry, narrative_segments)` |

**병렬화 가능 구간**:

1. **STT || PPL** — PPL은 video만 참조. STT 완료 대기 불필요.
2. **faces || scenes** — 둘 다 refined만 필요, 서로 독립.
3. **cast || timeline** — 둘 다 scenes만 필요.

**절감 추정 (108분 청문회 cold-run 기준, stage_sec 데이터)**:

- 현재 순차: 135 + 415 + 347 + 594 + (scenes 0) + (cast 0) + 53 + 209 + 120 = **1873s (31분)**
- **STT || PPL** 병렬화: max(135+415+347, 594)=**897s** for STT~faces vs 594s for PPL → 897s
  - 이후 순차: + 53 + 209 + 120 = **1279s (21분)** · **-10분 (32%)**
- 추가로 **faces || scenes** (여기선 scenes=0으로 미미)
- **cast || timeline** (여기선 max(0, 53)=53, 미미)

**축구경기(PPL 3787s가 지배)**: PPL이 supremum이라 병렬화 효과 미미. **PPL 자체를 빠르게 하는 방법이 필요**.

---

## 3. 병목 스테이지 세부 분석

### 3.1 faces (`core/faces.py`)

**현재 로직** (`build_face_index`):
- 각 refined 세그먼트마다 1개 프레임 추출 → InsightFace 검출
- **단일 스레드 loop** (`for i, seg in enumerate(refined):`)
- InsightFace: DirectML (Windows) or CPU

**병목 원인**:
- 세그먼트 수에 비례 (1667 세그 = 2167s)
- InsightFace `detect + genderage + w600k_r50` 모델 3개 로드 · 프레임당 ~1s

**있는 데이터 안 씀**:
- 인접 세그먼트가 <1초 간격이면 거의 같은 프레임 — 중복 검출
- `faces.json.clusters[X].representative_frames`는 UI만 씀

### 3.2 ppl (`core/ppl.py`)

**현재 로직** (`build_ppl_index`):
- `PPL_SAMPLE_SEC=5` → 영상 길이/5 프레임
- `PPL_WORKERS=6` 병렬 Gemini Vision 콜
- `max_output_tokens=8192`

**병목**:
- 109분 영상 = 1308 프레임 × Vision 콜
- 6워커 이론값: 1308/6 × (2.5s Vision latency) = ~545s
- 실측 3787s = **7배 초과** → 429 throttle · 재시도 · timeout 다수 존재 추정 (retry.py의 지수 백오프 발동)

**샘플 간격**:
- 5초는 밀도 높음. 상품 등장은 보통 수초 지속 → 10초 간격도 놓치지 않을 가능성
- 장르별 스킵 가능성: 뉴스·시사·스포츠는 PPL 흔치 않음 (스킵 후보)

### 3.3 refine (`core/refine.py`)

**현재 로직**:
- `BATCH=40` 세그 × `REFINE_WORKERS=4` 병렬
- 108분 영상 3000+ 세그 → 75+ 배치 = ~20분 예상 근데 실측 7분 (병렬 효과)
- `response_schema` 없이 프롬프트+partial JSON 복구 (2026-07-22 AENA 원칙)

**있음직한 최적화 여지**:
- `REFINE_WORKERS`를 6~8로 (Gemini rate limit 감내 범위)
- 짧은 세그(<0.5s)는 정제 대상서 제외 (STT 오인식 대비 부담)

---

## 4. 정보 유실 감사 — 만들어놓고 안 쓰는 것들

`recommend()`가 실제 소비하는 인자: `scenes, n, genre, on_progress, profile, channels, transcript, cast_registry, narrative_segments`.

Grep 결과 **recommend에 전달되지 않고 있는 이미-계산된 산출물**:

| 산출물 | 만드는 곳 | 담긴 정보 | 쓰이는 곳 |
|---|---|---|---|
| **cast.people** (분석된 인물 timeline) | `cast.py` | 인물별 화면 등장 시간(totalSec), 등장 씬 리스트 | narrative만 · **recommend는 못 봄** |
| **cast.people[].portraits** | `portraits.py` (cast 스테이지에 병합) | 인물별 대표 얼굴 크롭 | UI만 |
| **ppl.detections** | `ppl.py` | 브랜드·제품별 등장 구간·프레임 | UI만 · **recommend·narrative 못 봄** |
| **narrative.key_conflicts** | `narrative.py:build_conflict_analysis` | 주요 갈등·사건 with participants + time_range | UI만 · **recommend 못 봄** |
| **narrative.characters** | `narrative.py:build_character_analysis` | 인물별 관계/성격 분석 | UI만 · **recommend 못 봄** |
| **timeline.blocks[].key_points** | `timeline.py` | 짧은 구 형태 주요 순간 (시간 표기 없음) | narrative 컨텍스트만 |
| **faces.clusters** | `faces.py` | 얼굴 클러스터별 gender_hint + 대표 프레임 | UI만 |

### 겹침 (중복 Gemini 호출)

**timeline vs narrative.segments** — 같은 5분 블록을 두 번 요약:
- `timeline.build_timeline`: label + summary + key_points (짧은 구, **시간 없음**)
- `narrative.build_segment_analysis`: title + summary + **key_moments([MM:SS])** + characters + locations + brands + emotional_tone

**narrative.segments가 timeline.blocks의 super-set**. UI가 timeline 뷰를 narrative.segments로 대체 가능. 통합 시 `timeline` 스테이지 삭제 가능 (10~53s + Gemini call 절약).

### recommend에 주입 안 되어 있는 개선 여지

1. **cast.people** — "이 시간대 화면 등장 인물" → 캐릭터 하이라이트 쇼츠 판단
2. **ppl.detections** — 브랜디드 컨텐츠 회피 or 반대로 브랜드 쇼츠 제작 신호
3. **narrative.key_conflicts** — "갈등·핵심 사건 time_range" → 편집자가 잡는 지점 그대로
4. **narrative.characters (관계·성격)** — 인물 중심 쇼츠 title/reason에 근거 강화

---

## 5. Gemini 콜 분해

`core/*.py` grep 결과 모든 스테이지가 `gemini-2.5-flash` 사용.

108분 영상 청문회 콜 카운트 추정:

| 스테이지 | 호출 형태 | 대략 콜 수 (108분 기준) | 페이로드 |
|---|---|---|---|
| STT | 90s 창 × 6 워커 | ~72 콜 | audio blob per call |
| refine | 40 세그 배치 × 4 워커 | ~75 콜 | text ~40 줄 per call |
| ppl | 5초 프레임 × 6 워커 | ~1308 콜 | image per call · **가장 많음** |
| timeline | 8 블록 배칭 | ~3 콜 | text scene lines |
| narrative full_summary | 1회 | 1 콜 | 자막 최대 3000줄 |
| narrative segments | 5 블록 배치 | ~5 콜 | 블록당 자막 최대 160줄 |
| narrative characters | 1회 | 1 콜 | cast + 자막 |
| narrative conflicts | 1회 | 1 콜 | cast + 자막 |
| recommend genre detect | 1회 | 1 콜 | 샘플 대사·씬 |
| recommend Phase 1 | 청크 × 4 워커 | ~13 콜 | 청크 씬+자막 |
| recommend Phase 2 | 1회 | 1 콜 | 후보 목록 |
| recommend 재제목 | 1회 | 1 콜 | 최종 쇼츠 창별 자막 |
| **총** | | **~1482 콜** | |

**PPL 콜이 전체의 88%** (1308/1482). 나머지 스테이지 합쳐도 174콜.

**중복 컨텍스트** (동일 데이터 여러 콜에 반복 전송):
- `cast_registry` — refine 배치마다, recommend Phase1/Phase2/재제목마다, narrative 대부분 콜에 반복 삽입
- `refined transcript` — narrative의 full_summary + segments + characters + conflicts 각각에 전량 or 샘플링 재삽입
- 프로그램 profile — recommend Phase1 각 청크 콜마다 반복 삽입

**모델 선택 획일화**:
- STT: audio 특화 필요, Flash 적절
- refine: 문자열 정제, **Flash-Lite로도 충분 가능성** (미검증)
- ppl: image, Flash 유지 (Lite는 vision 열등)
- narrative full/segments/characters/conflicts: 컨텍스트 이해 필요, Flash
- recommend Phase 2: 창의적 선별, **Pro로 승격 시 품질↑ 가능** (비용↑)
- recommend Phase 1, retitle: Flash 유지

---

## 6. 옵션 목록 (판정 없이)

### A. 병렬화

- **A1**. `STT || PPL` (PPL이 video만 필요) — 청문회 108분에서 ~10분 절감. 축구는 PPL이 supremum이라 미미.
- **A2**. `faces || scenes` — scenes가 워낙 빨라 (10초대) 효과 작음.
- **A3**. `cast || timeline` — timeline 삭제 시 무의미.
- **A4**. narrative의 4개 하위 콜(full_summary·segments·characters·conflicts) 병렬화. 현재 순차. 예상 절감 200s → 60s per video.

### B. 병목 스테이지 최적화

- **B1**. faces 서브샘플링: 세그마다 대신 **N초마다** 1프레임. 라벨링 정확도 대신 속도.
- **B2**. faces 배치 추론: InsightFace batch API 사용 (현재 프레임당 개별 detect).
- **B3**. PPL 샘플 간격 5→10s: 프레임 수 50%.
- **B4**. PPL 워커 6→8~12: Gemini rate limit 여유 있으면.
- **B5**. PPL 장르 스킵: 뉴스·시사·스포츠 장르 검출 시 스킵.
- **B6**. PPL을 refined 뒤로 미뤄 대사에 브랜드/상품 언급 있는 구간만 스캔 (밀도 낮은 구간 스킵).

### C. 정보 유실 회수 (recommend 강화)

- **C1**. `narrative.key_conflicts`를 recommend에 주입 — 편집 급소.
- **C2**. `narrative.characters`를 recommend에 주입 — 인물 중심 쇼츠 근거.
- **C3**. `cast.people` timeline을 recommend에 주입 — 화면 등장 인물 근거.
- **C4**. `ppl.detections`를 recommend에 주입 — 브랜디드 회피/포함 신호.

### D. 중복 제거 · 리팩터

- **D1**. **timeline 스테이지 삭제**, narrative.segments가 대체 (super-set). UI 마이그레이션 필요. Gemini 3콜 + 10~53s 절감.
- **D2**. narrative full_summary/characters/conflicts를 recommend와 하나의 콜로 병합 (multi-output schema). 3콜 절감.
- **D3**. 중복 컨텍스트(`cast_registry`, `profile`) 를 세션·캐시 컨텍스트로 전환 — 프롬프트 토큰 절약.

### E. 모델 다변화

- **E1**. refine을 Flash-Lite로. 정제 품질 미검증. 검증 필요.
- **E2**. recommend Phase 2를 Pro로 승격 (creative synthesis). 품질↑ · 비용↑.

### F. B2B 운영성

- **F1**. 워커 concurrency 확장. 현재 워커 1개 = 큐 처리 순차.
- **F2**. GPU 워커 노드 (InsightFace CUDA · Flash 처리량↑).
- **F3**. 프로그램별 사전 계산: 프로그램 등록 시 profile·cast 확정 → 첫 재분석 사전 캐시.

---

## 7. 참고 데이터

- 스냅샷 원본: `eval/snapshots/before-20260723-115124/*/analysis.json`
- 워커 로그: `logs/worker-manual-*.log`
- 관련 코드: `core/analyze.py` · `core/{refine,faces,ppl,scenes,cast,timeline,narrative,recommend}.py`
- 메모리 참고: [[pipeline-chunked-parallel]] · [[aena-pipeline-reference]]

**판정 없음.** 어떤 옵션을 잡을지는 사용자가 우선순위·B2B 시나리오 감안해 결정.

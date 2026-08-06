# 자연어 검색 · 하이라이트 재계획서 — STEP-D 실측 기반

> 작성 2026-08-06 · 근거는 전부 `core/*.py` 코드 실측. 추측은 "추정"으로 명시.
> 이 문서는 앞서 만든 일반론 설계서(`video-search-architecture.md`)를 **STEP-D 현실에 맞춰 교체**한 것이다.
> 일반론 설계서의 권고 중 상당수는 STEP-D에는 **후퇴**이므로 아래 §7에서 명시적으로 철회한다.

> **⚠️ 2026-08-06 갱신 (같은 날 오후) — 초판의 3항목이 틀렸다.**
> 초판은 `core/*.py` 만 읽고 썼다. `apps/server/` 를 같이 읽으니 "없다"고 한 것 중 셋이 이미 있었다.
>
> | 초판 주장 | 실제 | 근거 |
> |---|---|---|
> | pgvector 저장소 미구현 (§2-⑤·§3·P1-5) | **구현·배선 완료** | migration `0009_search-segments.cjs`(HNSW×2·GIN trgm·GIN chars) · `db-pg.ts:1669 upsertSearchSegments` · `content-pipeline.ts:1103` 자동 적재 |
> | 쿼리 파서가 룰 스텁 (§3) | **LLM 파서 배선 완료** | `search-parse.ts:87 parseQuery` — roster 로 환각 차단. `core/search.py` 의 룰 파서는 오프라인 참조 구현일 뿐 |
> | scope·rights 전부 None (§3·P1-5) | **program_id·episode·aired_at·rights.ppl 주입됨** | `content-pipeline.ts` 가 episode 엔티티 조인 + PPL 구간 오버랩으로 채운다. 남은 None 은 `scope_type`/`scope_id`/`cast_ok`/`music_cleared`/`spoiler` |
>
> **같은 날 처리된 것** (아래 본문에 ✅ 로 표시):
> - **P1-1 검색 로그 배선 — 완료.** `0010_search-log.cjs` + `logSearchEvent()` + `/api/search`(search) ·
>   `POST /api/search/log`(click·export) · `PATCH /api/clips/:id/editor`(**boundary_adjust**) · `/search` 결과 클릭
> - **부록 #3 `chyron.json` writer 부재 — 해소.** `scan_per_seg` 가 감지 원본을 반환하고
>   `run_chyron_per_seg` 가 `chyron.json` 으로 덤프. 덤으로 **인물 필터 결함**을 찾아 고쳤다 (§2-⑧)
> - **P1-3 검색 평가셋 — 문서·러너 완료, 데이터 미작성.** `docs/research/search-evalset.md` + `core/eval_search.py`
>
> 나머지 분석(死코드·저수준 신호 소실·리텐션 미사용·랭킹 변별력 0)은 재확인해도 유효하다.

---

## 0. 결론 3줄

1. **STEP-D는 이미 일반론 설계서가 권고한 구조의 70%를 갖고 있다.** beat 단위 인덱싱, BM25+벡터 RRF 하이브리드, 문장 경계 스냅, 훅 필드, 시청자 신호까지. 새로 만들 게 아니라 **끊긴 배선을 잇는 일**이 남았다.
2. **가장 큰 문제는 없는 기능이 아니라 "만들어놓고 안 쓰는 것"이다.** 死코드·미배선·하드코딩 상수가 여러 층에 쌓여 있어, 정교하게 짠 로직이 실행 경로에 도달하지 못한다.
3. **가장 아까운 자산은 리텐션 커브다.** 하이라이트 판정의 최강 신호가 이미 DB에 수집·영속되어 있는데 추천에 한 줄도 쓰이지 않는다.

---

## 1. 실측 — 이미 있는 것

앞 설계서가 "만들어야 한다"고 한 것 중 **이미 있는 것**:

| 설계서 권고 | STEP-D 현황 | 위치 |
|---|---|---|
| 인덱싱 단위 = 샷/씬 | **beat** (하한 8초, STT word 경계 스냅) | `beats.py:992` `build_beats_from_boundaries` |
| 캡션 텍스트를 주력 채널로 | ✅ dialogue + summary 2벡터 | `index_segments.py:190-198` |
| BM25 + dense 하이브리드 + RRF | ✅ 자체 구현, `RRF_K=60` | `search.py:62-89`, `:223-233` |
| 문장 경계 스냅 우선 | ✅ word 타임스탬프 스냅 + 화자 블록 확장 | `beats.py:125`, `:189` |
| 클립 경계 정밀화 | ✅ **GUARD A/B** — 인용문 STT 실존 검증 + 화자 침범 거부 | `recommend.py:2760-2860` |
| 훅(앞 3초) | ✅ `hook_quote` / `hook_time_sec` / `hook_intro_caption` | `recommend.py:3009-3011` |
| 시청자 반응 신호 | ✅ 댓글 타임스탬프 정규식 추출 → ⭐VIEWER beat 마킹 | `comment_signal.py:48-49`, `recommend.py:3073-3107` |
| 검색 로그 스키마 | ✅ 4종 이벤트 + `boundary_adjust`의 `delta_start/end` | `search_log.py:26`, `:90-102` |
| 장르별 분기 | ✅ 7종 `GENRE_PACKS` | `recommend.py:64-108` |
| 쇼츠 평가 지표 | ✅ Hit@N · IoU≥0.5 · 경계 오차 중앙값 | `evaluate.py:7-9` |
| 학습 루프(발행 성과 → 규칙) | ✅ 수동 CLI | `learn_profile.py:166-219` |

**특히 `refine_boundaries_semantic`의 GUARD A/B는 일반론 설계서가 제안한 수준을 넘어선다.** LLM이 "여기까지 확장하라"며 준 인용문을 STT 원문에서 실제로 찾아보고, 못 찾으면 확장을 거부한다(`recommend.py:2760-2787`). 이건 이 코드베이스에서 가장 잘 짜인 부분이고, **다른 곳에도 이 패턴을 복제해야 한다**(§4 P0-4).

---

## 2. 결정적 발견 7가지

### ① 저수준 신호가 통째로 사라졌다 — 회귀

`docs/archive/highlight-model-feasibility.md:22-24`(2026-07-17)는 이렇게 적고 있다:

> **알고리즘 사전필터의 5개 원신호**(얼굴 수·모션·**오디오 에너지**·자막밴드 엣지밀도·대사밀도)가 `heur` 필드로 이미 프레임마다 계산된다(`prefilter.py:39·234`). 이것들이 `content_analysis.data` JSONB에 통째로 저장된다.

**그런데 `core/prefilter.py`는 현재 리포에 없다.** `core/ocr.py`도 없다. beat 파이프라인 전환 과정에서 삭제된 것으로 보인다. 흔적만 남아 있다 — `recommend.py:1142`가 `heur_score`를 읽지만 이 필드를 **쓰는 코드가 리포에 0건**이다.

결과: 현재 하이라이트 판정에 **오디오 에너지·모션·컷 속도 신호가 전무하다.** 전 `core/` grep에서 `rms|loudness|ebur128|volumedetect|astats|optical_flow` 매치 0건. 유일한 수치 신호인 대사 밀도(`_scene_signal`, `recommend.py:1137-1148`)조차 폴백 경로 전용이라 기본 경로에서 실행되지 않는다.

> 이것이 이번 재계획의 **1순위**다. ML 재랭킹 계획(feasibility 문서 §5)이 전제한 피처의 절반이 실제로는 존재하지 않는다. 지금 LightGBM을 붙이려 해도 먹일 피처가 없다.

### ② 리텐션 커브 — 최강 신호가 DB에서 잠자고 있다

`video_retention.curve` JSONB `[{ratio, watchRatio, relative}]`가 YouTube Analytics API로 **이미 수집·영속**되고 있다(`apps/server/src/youtube.ts:556`, `db-pg.ts:166`).

일반론 설계서에서 "다른 모든 신호보다 강력하다"고 1순위로 꼽은 바로 그 신호다. 그런데 `core/recommend.py`에는 리텐션을 읽는 코드가 없다. 원본 롱폼이 연결된 채널에 있으면 **beat 시간축에 매핑만 하면 즉시 쓸 수 있다.**

주의점 2개 (feasibility 문서가 이미 지적):
- `elapsedVideoTimeRatio`는 **0→1 정규화 비율**이지 초가 아니다. beat의 `start/end`를 `duration`으로 나눠 매핑해야 한다.
- 저트래픽 영상은 API가 400을 반환해 **빈 커브**가 온다(`youtube.ts:510·585`). 없을 때 우아하게 degrade해야 한다.

### ③ 死코드가 실행 경로를 잠식했다

| 죽은 것 | 정의 위치 | 결과 |
|---|---|---|
| `build_beats()` — LLM이 beat 시각을 직접 판단 | `beats.py:591` | 호출부 0건. **beat 생성에 LLM 판단이 전혀 없다.** 정교한 프롬프트(`:278-376`)가 통째로 사장 |
| `_force_split_large_beats(max=45s)` | `beats.py:706` | 死코드 경로 전용 → **beat 길이 상한이 사실상 없다** |
| `_enforce_shortform_length(max=90s)` | `recommend.py:3475` | 호출부 0건 → **쇼츠 길이 상한 강제 없음** |
| `_dedup_beat_overlap` | `recommend.py:3446` | 호출부 0건 → beat 재사용 방지 없음 |
| `scene_type.json` | `analyze_stages.py:517-524` | 생성 후 소비처가 死코드뿐. **비용만 쓰고 버려짐** |
| `apply_learned_rerank` | `recommend.py:387` | 의도된 no-op + 호출부 0건 |
| `faces.vision_auto_map_clusters` 외 5개 | `faces.py`, `chyron_scan.py` | 전부 미배선 |
| ~~`chyron.json`~~ | — | ~~`index_segments.py:214`가 읽지만 **writer가 리포에 없음** → 항상 `[]`~~ ✅ **2026-08-06 해소** (§2-⑧) |

### ④ beat-only 경로에서 랭킹 변별력이 0이다

기본 경로(`propose_shorts_beat_only`)는 모든 쇼츠에 **동일한 3축 점수를 하드코딩**한다 — `recommend.py:3417`, `:3429-3431`:

```python
derived = {"hook_strength": 7, "payoff": 7, "completeness": 8}
```

`_SHORTS_FROM_BEATS_SCHEMA`(`:2993-3020`)에 이 필드들이 아예 없다. **LLM에게 점수를 묻지 않는다.** 따라서 `score100`이 전부 72.5로 동일하고, `_AXIS_WEIGHTS = {0.40, 0.35, 0.25}`(`:588`)는 실질적으로 무의미하다. 최종 정렬(`:3720`)은 LLM 응답 순서를 그대로 유지할 뿐이다.

### ⑤ ~~검색 저장소와 로그가 둘 다 배선되지 않았다~~ → **둘 다 해소 (정정)**

- ~~**저장소**: pgvector 코드가 `core/`에 0건~~ → **초판 오류.** `core/`에 없는 건 맞지만 **거기 있을
  이유가 없다.** 저장소는 `apps/server` 담당이고 이미 완비돼 있다 — `0009_search-segments.cjs`
  (HNSW 코사인 ×2 · GIN trgm · GIN characters · 메타필터 인덱스 7종), `db-pg.ts:1669`
  `upsertSearchSegments`, `content-pipeline.ts:1103`가 analyze 끝나면 자동 적재.
  `search.py`의 O(N) 전수 스캔은 **오프라인 참조 구현**이지 프로덕션 경로가 아니다.
- **로그**: 지적은 정확했다. ✅ **2026-08-06 배선 완료** — `search_log.py`의 4종 이벤트 스키마를
  그대로 `search_events` 테이블(`0010_search-log.cjs`)로 옮기고 실제 호출부를 붙였다.

`search_log.py:4-6`의 자기 경고가 아팠다:

> "검색을 붙이기 **전에** 설계해야 하는 로그. 나중에 붙이면 몇 달치가 날아간다."

이제 쌓인다. 배선된 지점:

| 이벤트 | 어디서 | 비고 |
|---|---|---|
| `search` | `/api/search` | 노출 후보를 순위·score·lex·vec 와 함께. 응답에 `queryId` 를 실어 후속 이벤트를 묶는다 |
| `click` | `/search` 화면 "구간 보기" | rank 포함 → MRR 실측 |
| `export` | (입구만 열림 · 호출부 미배선) | `POST /api/search/log` |
| `boundary_adjust` | `PATCH /api/clips/:id/editor` | **AI 제안 → 사람이 옮긴 경계.** 저장 성공 시에만, 0.01초 이상 움직였을 때만 |

`boundary_adjust`는 검색뿐 아니라 **에디터 경로**에서 들어온다(그래서 `source`·`clip_id` 컬럼을
`search_log.py` 스키마에 더했다). 채택 직후 clip 의 start/end 는 추천 원본이므로 **한 클립의 첫
이벤트 `before` = AI 제안**이다 — 이 조인으로 "AI 제안 → 최종 컷" 페어가 복원된다.

### ⑥ 얼굴 클러스터가 회차 간 동일성을 보장하지 않는다

`faces.py:358-371` — 클러스터 라벨(`M1/F1/M2...`)은 **성별 majority + 클러스터 크기 내림차순**으로 매 회차 새로 매긴다. 같은 인물이 회차마다 다른 라벨을 받는다. 얼굴 centroid를 프로그램 단위로 영속화하는 코드가 없다.

`docs/stepd-core-and-future.md:42`가 내세우는 "출연자 사전등록 → 자동 실명 라벨링"의 실제 앵커는 **`cast_registry.json`의 이름 문자열 하나뿐**이다. `auto-cast-and-action-tags.md`의 "크로스-회차 3회 반복 → 자동 확정" 계획도 chyron 이름 문자열에만 의존한다.

> 다만 이건 **의도된 설계**이기도 하다. `cast.py:10-12`가 명시: *"Explicitly NOT face recognition. … That keeps us out of biometric territory (PIPA 민감정보)."* 얼굴로 신원을 주장하지 않는다는 원칙은 방송사 B2B에서 지켜야 할 선이다. 아래 §4 P2-3은 이 원칙을 깨지 않는 범위의 제안이다.

### ⑦ 장르 자동 감지가 앞 단계에 도달하지 못한다 — 타이밍 결함

`detect_genre`는 `recommend.py:3686`에서 실행된다. 그런데 shot threshold(`shots.py:76-80`)와 scene 청크 크기(`scenes.py:41-45`)의 장르 분기는 **그보다 훨씬 앞선 스테이지 13·9**에서 CLI 인자 `--genre`(기본 `"auto"`)를 읽는다.

`"auto"`는 dict에 없으므로 `.get()` 폴백:
- shot threshold → **항상 0.55** (드라마용 0.35는 CLI 명시 시에만)
- scene 청크 → **항상 300초** (예능용 180초 미도달)

즉 **장르 자동 감지는 프롬프트 문구에만 영향을 준다.** 드라마를 예능 임계값으로 자르고 있다.

### ⑧ chyron 실명이 인물 필터에 도달하지 않았다 ✅ 수정됨 (2026-08-06)

초판이 `chyron.json` writer 부재를 부록 #3에 사소하게 적어 뒀는데, 고치러 들어가 보니
**그 뒤에 더 큰 결함이 있었다.**

경로를 따라가면 이렇다:

```
scan_per_seg (Vision 화면 이름 태그)
   → refined[].speaker 를 실명으로 rewrite      ← 여기서 "화면자막이 근거"라는 사실이 소멸
   → index_segments._dialogue_slice 가 speakers 로 수집
   → 세그먼트 레코드의 speakers 컬럼에 저장
   → 🔴 characters 에는 안 들어감
```

그런데 검색의 인물 필터는 `characters @> '["영철"]'::jsonb`(`db-pg.ts:1769`)이고, LLM 쿼리
파서의 roster 도 `listKnownCharacters()` = **`characters` 컬럼**에서 나온다(`db-pg.ts:1819`).
`speakers` 는 필터 대상이 아니다.

결과: **chyron 이 돈 들여 실명을 찾아내도**
- "영철이 나오는 장면" → 인물 필터 0건 (대사에 "영철: …"이 있어 trgm 으로는 걸릴 수 있으나 우연)
- 쿼리 파서가 "영철"을 인물로 **인식조차 못 함** — roster 에 없으니까

수정 3곳:
1. `chyron_scan.py:scan_per_seg` — 감지 원본을 `stats["hits"]` 로 반환 (time·names·seg·start·end)
2. `analyze_stages.py:run_chyron_per_seg` — `chyron.json` 덤프 (`index_segments.py:214`의 reader가 살아남)
3. `index_segments.py` — `_real_names(speakers)` 를 `characters` 에 병합.
   익명 라벨(`S1`·`SPEAKER_00`·`발화자 N`·`화자N`)은 정규식으로 걷어낸다 —
   그것들이 인물 필터에 들어가면 필터가 무의미해진다

> 이건 §2-①(저수준 신호 소실)과 성격이 같다. **기능이 없는 게 아니라, 만든 기능의 출력이
> 소비처에 도달하지 못하는 것.** 이 코드베이스에서 가장 흔한 실패 모드다.
> 재분석해야 반영된다(기존 인덱스는 갱신 안 됨).

**실측 검증 (2026-08-06 · m_981d7c08 · 662 세그 · ≈₩150 · 4.4분)**

배선은 동작한다 — `chyron.json` 29건 생성, `characters` **0개 → 8개**(22/241 세그먼트).
그런데 **감지 품질에 오염이 있었다**:

```
영철 13 · 옥순 5 · 순자 3 · 정숙 3 · 경수 2   ← 실제 출연자
영수␣␣정숙 1 · 갸웃 1 · 해탈 1              ← 다중이름 · 상황자막(노이즈)
```

- `갸웃`·`해탈` = **상황자막**. 프롬프트가 "상황자막(경악·헐 등) 제외"라고 명시하는데도 뚫린다
- `영수␣␣정숙` = 두 이름이 한 문자열로 붙음 → 존재하지 않는 인물이 인물 필터에 등록됨

`characters` 는 **검색 인물 필터축**이라 오염되면 필터 자체가 무의미해진다. 후처리 2개 추가:

1. `_split_multi_name` — 공백2·`·`·`,`·`/` 로 분리
2. **저빈도 컷(`min_votes=2`)** — 회차 전체 등장 2회 미만은 버린다. 실측 분포가 빈도 2에서
   정확히 갈렸다. 버려진 세그의 speaker 는 원 익명 라벨로 남으니 정보 손실이 아니라
   "모른다"로 정직해지는 것. 이름이 2개인 태그는 **speaker 를 덮어쓰지 않는다**(화자 단정 불가)

**이 결과가 cast 사전등록의 필요성을 실증한다.** 등록 roster 가 있으면 빈도와 무관하게 통과시키는데:

| | 통과 | 컷 |
|---|---|---|
| roster 없음 | 경수·순자·영철·옥순·정숙 | `영수`(1) · 갸웃 · 해탈 |
| roster 있음 | + **영수** | 갸웃 · 해탈만 |

**등록이 없으면 진짜 출연자 `영수`(1회 등장)도 같이 잘린다.** 빈도 휴리스틱은 등록이 없을 때의
보루일 뿐이고, 정답은 `cast_registry` 사전등록이다 — 나는 솔로처럼 **고정 가명 로스터**를 쓰는
프로그램은 1회 등록으로 전 기수가 커버된다. `run_chyron_per_seg` 가 `cast_registry` 를 받아
`roster` 로 넘기도록 배선했다.

---

## 3. 갭 매트릭스

| 축 | 일반론 설계서 | STEP-D 현실 | 판정 |
|---|---|---|---|
| 인덱싱 단위 | 샷 (3~5초) | beat (8초~상한없음) | ✅ 더 나음. 단 **상한 복구 필요** |
| 텍스트 임베딩 | 캡션 임베딩 | `text-multilingual-embedding-002` 768d × 2벡터 | ✅ 완료 |
| 시각 임베딩 | 보조 채널 | 없음 | ⚠️ 우선순위 낮음 (§7에서 보류) |
| 하이브리드 검색 | BM25+dense+RRF | ✅ 구현됨 | ✅ 완료 |
| 한국어 형태소 | Nori/Kiwi 필수 | 서버는 **pg_trgm**(언어무관 부분일치) · `core/search.py`는 문자 bigram | ⚠️ 갭 축소 — trgm이 bigram보다 낫다 |
| 저장소 | Qdrant/pgvector | ~~segments.json 전수 스캔~~ → **pgvector + HNSW ×2** | ✅ **완료** (정정) |
| 쿼리 파서 | LLM 구조화 | ~~룰 스텁~~ → **LLM 파서**(`search-parse.ts`, roster 환각차단) | ✅ **완료** (정정) |
| 리랭커 | 크로스인코더 or VLM | 없음 | ⚠️ P3 |
| 메타 필터 | 인물/객체/샷사이즈 | program·episode·aired_at·rights.ppl **주입됨** / scope_type·scope_id·cast_ok·music_cleared·spoiler는 None | ⚠️ 부분 (정정) |
| 인물 필터 정확도 | — | ~~chyron 실명이 characters에 미도달~~ → **수정** | ✅ **완료** (§2-⑧) |
| action tag | (설계서 미포함) | 없음 (계획서만) | ❌ **갭** |
| 샷 경계 | TransNetV2 | ffmpeg scene 0.55 (GEBD 미배선) | ⚠️ P1 |
| 저수준 신호 | 오디오·컷속도·모션 | **전무 (prefilter.py 소실)** | ❌ **최대 갭** |
| 리텐션 신호 | 1순위 신호 | DB에 있으나 **미사용** | ❌ **최대 갭** |
| 클립 경계 | 문장>샷 스냅 | ✅ GUARD A/B로 정교하게 | ✅ 설계서 초과 |
| 훅 | 앞 3초 배치 | ✅ 3필드 — 단 **무검증** | ⚠️ P0 |
| 평가셋 | 50~100 쿼리 | 쇼츠용 O / 검색용 **문서·러너 O · 데이터 X** | ⚠️ 반 (정정) |
| 로그 학습 루프 | 클릭·경계조정 수집 | ~~스키마 O / 호출 0건~~ → **테이블 + 4지점 배선** | ✅ **완료** |

---

## 4. 재계획 — 우선순위

### 4.-1 스코프 — 드라마 · 예능 2장르 · 2분기 (2026-08-06 확정)

`GENRE_PACKS` 는 7종이지만 **이번 2분기 대상은 드라마 · 예능 둘뿐**이다. 시사·스포츠·뉴스는
측정도 튜닝도 하지 않는다.

이 결정이 우선순위를 실제로 바꾼다:

| 항목 | 2장르 특화 전 | 후 |
|---|---|---|
| **P0-5 장르 감지 타이밍** | 중간 순위 | **최우선** — 대상 두 장르가 **둘 다** 틀린 파라미터로 돌고 있었다(§P0-5 표). ✅ 처리함 |
| 평가셋 회차 구성 | 예능 2 + 시사 1 + 스포츠 1 | **예능 2 + 드라마 2** |
| **cast_registry 사전등록** | P2 | **드라마 진입의 선행조건** — 드라마는 화면자막이 거의 없어 chyron 경로가 무력하다. `characters` 를 채울 수단이 등록뿐 |
| `GENRE_PACKS` 나머지 5종 | 유지·개선 | **동결.** 안 재는 걸 지표 평균에 넣지 않는다 |
| P1-4 GEBD | 범용 개선 | 드라마에서 이득이 크다(씬 경계가 곧 편집 단위). 예능은 잔컷이라 이득 작음 |

**비용·시간 원칙 (사용자 2026-08-06 명시): 모든 제안에 예상 ₩·분을 붙인다.** 코드 변경은
대개 ₩0이지만 **검증은 재분석 1회(≈₩620 · 체크포인트 재사용 시 ~19분/32분 영상 실측)** 다.
"고쳤다"와 "확인했다"의 비용이 다르다는 걸 항상 분리해서 적는다.

---

### 4.0 관점 전환 — 목적물은 영상 DB, 쇼츠는 그 위의 질의 (2026-08-06 추가)

지금 코드의 목적함수는 여전히 "쇼츠 추천"이고 검색은 부산물이다 — `index_segments.py`
도크스트링이 명시한다("검색을 별도 시스템으로 만들지 않고 파이프라인 부산물로 나오게 한다").
그 설계 자체는 옳지만, **우선순위를 정할 때의 목적함수는 뒤집어야 한다.**

```
[지금]  분석 → 쇼츠 추천이 결과물. 검색은 곁가지
[전환]  분석 → 영상 DB가 결과물. 쇼츠·하이라이트는 그 DB 위의 질의 하나

  하이라이트     = highlight_score 상위 세그먼트 질의
  쇼츠           = 그중 훅 있고 완결된 것들의 조합
  아카이브 재활용 = 오늘 이슈 → 과거 회차 크로스 질의   (B2B 축 ④)
  광고 패키징     = rights·PPL 필터 위의 질의            (B2B 축 ②)
  다회차 하이라이트 = 시즌 전체 크로스 질의
```

이 전환이 코드에 요구하는 것은 **하나로 수렴한다**:

> **`highlight_score`가 LLM의 쇼츠 선택과 독립된 진짜 점수여야 한다.**

지금은 순환 정의다. `index_segments.py:167 _highlight_score`는
- 쇼츠에 걸렸으면 `appeal/5`
- 아니면 `hook` 문자열 → 상수 테이블 `_HOOK_BASE` lookup

즉 **LLM이 이미 쇼츠로 고른 구간만 점수가 높다.** DB로서 독립적인 정렬 기준이 없다.
"쇼츠 후보가 아닌 구간 중에 좋은 것"을 이 점수로는 영영 못 찾는다. 아카이브 재활용은
정확히 그 질의인데.

**따라서 P0-1(저수준 신호)의 위상이 바뀐다.** 초판은 "ML 재랭킹의 전제 피처"라서 1순위라 했다.
그것도 맞지만 더 중요한 이유는 이것이다 — **`highlight_score`를 LLM 독립으로 만드는 유일한 재료다.**
오디오 에너지·컷 속도·대사 밀도는 LLM이 뭘 골랐든 무관하게 계산된다.

같은 이유로 §3의 "인물 필터 정확도"(§2-⑧)와 "저수준 신호"가 다른 어떤 항목보다 앞선다:
**DB의 값어치는 배관이 아니라 레코드 안에 뭐가 들어 있느냐로 정해진다.** 배관(pgvector·
하이브리드·파서)은 이미 다 있다. 레코드 내용물이 아직 "자막 + LLM 감"뿐이다.

---

원칙: **비용 증가 0에 가깝고, 이미 있는 자산을 잇는 것부터.** STEP-D는 회차당 ₩620 예산 안에서 돌아가야 하므로(`pipeline-current-state.md:107`), 새 API 콜을 늘리는 제안은 뒤로 뺐다.

---

### P0 — 지금 당장 (추가 비용 ₩0, 각 반나절~2일)

#### ✅ P0-1. 저수준 신호 복구 — `core/signals.py` **완료 (2026-08-06)**

**구현됨.** `core/signals.py` + `analyze_stages.run_beat_signals`(스테이지 15.5, beats 직후).
산출 `signals.json` → `beats.json` 병합 → `index_segments` 가 세그먼트 레코드의 `signals{}` 로 실음.

| 필드 | 의미 |
|---|---|
| `audio_pct` | 회차 내 백분위(0..1). **스코어러가 쓸 축** — 원 RMS 는 마스터링 레벨이 회차마다 달라 비교 불가 |
| `audio_rms` / `audio_delta` | 구간 평균 / 최대 순간 상승폭(웃음·환호 대리 지표) |
| `silence_ratio` | 정적 창 비율 — 드라마의 긴 정적 = 긴장 |
| `cut_rate` · `dialogue_density` · `speaker_turn_rate` | 이미 있는 데이터의 산술 (I/O 0) |

**실측 비용 (m_981d7c08 · 나는 솔로 · 32분 · 298 beat)**: **API ₩0 · 2.3~4.5초.** ffmpeg 로
8kHz 모노 PCM 을 1패스 디코드 → numpy 창별 RMS. 예상(§원안 "ffmpeg 1패스")대로 동작.

**실측에서 나온 것 2가지:**

1. **신호가 LLM 선택과 실제로 독립이다.** `audio_pct` 상위 8개 중 4개가 **쇼츠 미채택** beat다
   (`영자도 영철이야?` `솔로남들의 굿모닝 인사` `마음이 통한 만큼 해피엔딩이길` `내면도 예쁘다고 해줘요!`).
   채택/미채택 `audio_pct` 중앙값은 0.525 / 0.475 로 거의 갈리지 않는다 — **단독 예측력은 약하고
   정보축으로는 새롭다**는 사실. 원안의 "LLM 판단을 덮지 말고 보정만(α·β 0.1~0.2)"이 맞는 방향이다.
2. **`cut_rate` 커버리지 — 처음 진단은 틀렸고, 실측으로 정정했다.**

   처음엔 "beat 의 74%가 미스캔"이라고 적었다. **오진이었다.** `cut_rate == 0` 을 "스캔 안 됨"으로
   읽었는데, 실측하니 `covered_sec = 1932.0` = **커버리지 100%** 다(narrative 창 7개가 각 300초씩
   전 구간을 덮는다). 재실행 결과 `cut_rate: None=0 · 0=164 · >0=77` — **미스캔 0건**이고, 0인
   beat 는 진짜로 컷이 없는 구간이다. **`cut_rate` 는 신뢰해도 된다.**

   99 shots / 32분 = 평균 19.5초에 한 컷이 성겨 보이는 건 커버리지가 아니라 **threshold 0.55**
   때문인데, `shots.py:71` 주석이 "예능: 잔컷 폭포 · **큰 공간/앵글 전환에만** 스냅하려면 0.55"
   라고 밝히듯 **의도된 설계**다. 버그가 아니다.

   `windows_sec` 추가는 그대로 둔다 — 커버리지가 자기기술적이 되고, 앞으로 창이 전 구간을 안 덮는
   경우(짧은 narrative, 실패한 창)가 생기면 그때 거짓 0을 잡아준다. `shot_windows_known` 플래그로
   **"미스캔 0"과 "판정 불가(구버전 shots.json)"를 구분**해 찍는다.

<details><summary>원안 (참고용)</summary>

**무엇**: 삭제된 `prefilter.py`의 5개 신호를 **프레임 단위가 아니라 beat 단위로** 재작성한다.

```
beat_signals(video_path, beats, refined) -> {beat_id: {...}}
  audio_rms_mean / audio_rms_peak / audio_rms_delta   # ffmpeg astats 또는 librosa
  laughter_ratio                                       # (선택) 오디오 분류, 2단계
  cut_rate                                             # 해당 구간 shots[] 밀도 — 이미 있는 데이터, 계산 무료
  motion_intensity                                     # ffmpeg select=gt(scene,..) 통계 재활용 or 프레임 diff
  dialogue_density                                     # 초당 문자수 — refined에서 무료
  speaker_turn_rate                                    # 화자 전환 횟수/초 — 무료
```

**왜 1순위인가**:
- GPU·API 비용 0. ffmpeg 1패스 + 이미 있는 `shots.json`·`refined.json` 재활용
- 이게 없으면 하이라이트가 영원히 "LLM 감"에만 의존한다
- ML 재랭킹(feasibility §5)의 전제 피처다. **이거 없이는 LightGBM을 못 붙인다**
- `cut_rate`와 `dialogue_density`는 **추가 I/O조차 없다** — 이미 메모리에 있는 데이터의 산술

**착수점**: `analyze_stages.py`에 `run_beat_signals` 추가 → beats 직후. 결과를 `beats.json`의 각 beat에 병합하고 `index_segments.py:235-262`의 세그먼트 스키마에 `signals{}` 추가.

**주의**: 축구경기 109분에서 PPL이 3787초 걸린 전례(`pipeline-optimization-findings.md`)가 있다. 오디오 신호는 **ffmpeg 단일 패스로 전 구간 RMS를 한 번에** 뽑고 beat 구간으로 슬라이스할 것. 구간마다 ffmpeg를 부르면 같은 함정에 빠진다.

</details>

#### ✅ P0-2. 3축 점수 하드코딩 해제 → **결정론 스코어로 대체 (2026-08-06)**

원안은 "LLM 에게 3축을 물어라"였다. **그 방향은 철회한다.** 사용자 지시(2026-08-06):

> "llm에게 선택의영역을주면안돼 / 맨날결과가바뀌어그러면"

LLM 점수는 같은 입력에도 실행마다 달라져 **A/B·회귀 판정 자체가 불가능**해진다. 품질 이전에
측정 가능성 문제다. 실제로 `_AXES_PROMPT` 가 *"※ 세 축을 다 8+로 주지 마라"* 라며 모델 편향과
싸우고 있었던 것이 그 자백이다.

**대체안 — `_deterministic_score` (recommend.py)**

```
score100 = 100 × ( 0.40×signal + 0.25×hook + 0.20×length + 0.15×complete )
             signal   core.signals 4축의 회차 내 백분위 평균 (LLM 무관)
             hook     beat_annot 카테고리 라벨 (0-10 점수가 아니라 분류 → 상대적으로 안정)
             length   25~90초 최적 곡선
             complete beat.is_complete 비율
```

| | 이전 | 이후 |
|---|---|---|
| 드라마 20쇼츠 `score100` | **전부 72.5** | **20종** · 69.8~85.6 |
| 예능 20쇼츠 | 전부 72.5 | 19종 · 62.7~84.3 |
| 입력 순서 셔플 5회 | — | **전부 동일** |

> 첫 구현은 재현성 테스트에서 **실패**했다 — 백분위 동점을 **리스트 인덱스**로 깨서 입력 순서에
> 의존했다. beat id 로 깨도록 고쳐야 성립한다. 결정론이 목적인 코드에서 가장 빠지기 쉬운 함정.

`score_parts` 로 근거를 남기고, 정렬 tie-breaker 도 `hook_strength`(이제 없음) → `start` 로 교체.

**남은 LLM 3축**: `_extract_candidates`(chunk_scan 모드 전용) · `propose_scenarios`(beats 없을 때만).
둘 다 `beats` 가 있으면 도달 불가라 실질적으로 死경로 — 이번엔 건드리지 않았다.

<details><summary>원안 (철회 · 참고용)</summary>

##### ~~P0-2. 3축 점수 하드코딩 해제~~

**무엇**: `_SHORTS_FROM_BEATS_SCHEMA`(`recommend.py:2993-3020`)에 `hook_strength`/`payoff`/`completeness`를 0-10 정수로 추가하고, `:3429-3431`의 하드코딩을 LLM 응답으로 교체.

**효과**: `_AXIS_WEIGHTS`가 살아나 랭킹 변별력이 생긴다. 프롬프트에 이미 축 정의(`_AXES_PROMPT`, `:631-639`)가 있으므로 **문구를 새로 쓸 필요도 없다.**

**후속**: P0-1의 신호와 곱셈 결합.
```
final = _axes_score(LLM 3축) × profile_fit × (1 + α·norm(audio_delta) + β·norm(cut_rate))
```
α·β는 작게(0.1~0.2) 시작하고 §5의 평가로 조정. **LLM 판단을 신호로 덮지 말고 보정만 할 것.**

</details>

#### P0-3. 死코드 3개 배선 (각 1~2줄)

- `_enforce_shortform_length(max_sec=90)` — `recommend.py:3475` → `:3701` 체인에 삽입
- `_dedup_beat_overlap` — `:3446` → 같은 위치. 쇼츠 간 beat 중복 방지
- `_force_split_large_beats` — `beats.py:706` → `build_beats_from_boundaries`의 `:1093-1096` 체인에 삽입. **beat 길이 상한 복구**

> 길이 상한을 안 두기로 한 건 "결정은 AI에 맡긴다"는 2026-07-27 방향(`recommend.py:3383-3384`)이었다. 유지하고 싶다면 최소한 **상한 초과 시 경고 로그**라도 남기고 실측 분포를 봐야 한다. 지금은 몇 분짜리 쇼츠가 나와도 아무도 모른다.

#### P0-4. `hook_quote` 검증 — GUARD A 패턴 복제

**무엇**: `hook_quote`가 실제 STT에 있는지, `hook_time_sec`가 `[0, end-start]` 범위인지 검증. 실패 시 필드를 비운다.

**왜**: 지금은 무검증 통과다(`recommend.py:3433-3434` 주석이 인정). 훅 자막은 **시청자가 가장 먼저 보는 3초**인데 환각 인용문이 그대로 번인될 수 있다.

**착수점**: `_semantic_closure_one`의 GUARD A(`recommend.py:2760-2787`) 정규화+검색 로직을 함수로 추출해 재사용. **새 코드가 아니라 이동이다.**

#### ✅ P0-5. 장르 감지 타이밍 수정 — **완료 (2026-08-06) · 2장르 특화로 최우선 승격됐던 항목**

**무엇**: `detect_genre`를 STT 직후로 앞당겨 `shots.py`·`scenes.py`가 실제 장르를 받게 한다. 입력은 이미 STT 대사만으로 충분하다(`recommend.py:424-433`이 대사 50줄 + vision 15개를 쓰는데, 대사만으로도 장르 판정은 된다).

**비용**: Gemini flash 1콜(`thinking_budget=0`) — 이미 나가는 콜을 앞으로 옮기는 것이므로 **증가분 0**.
recommend 는 확정 장르를 받으면 자기 감지를 건너뛰므로(`recommend.py:3685` 가드) **실질 1콜 감소**.

**왜 순위가 올라갔나 (2026-08-06 · 드라마·예능 2장르 특화 결정)**: 이 버그가 망가뜨리는 대상이
정확히 **우리가 특화하려는 두 장르**다. `--genre auto`(기본값)는 두 dict 어디에도 없어 폴백이 걸린다:

| | 필요한 값 | `auto` 폴백 실제값 | 결과 |
|---|---|---|---|
| **드라마** shot 임계 (`shots.py:76`) | 0.35 | **0.55** | 씬 컷이 드문 드라마에서 경계를 못 잡음 |
| **예능** 청크 (`scenes.py:41`) | 180s | **300s** | 코너 여러 개가 한 청크에 뭉개짐 — `scenes.py:37` 주석이 "현재 문제"라고 자인 |

시사·스포츠였다면 미뤄도 됐다. 2장르 특화를 정한 순간 **둘 다 틀린 값으로 돌고 있는 상태**가 된다.

**구현**: `analyze_stages.run_detect_genre` 신설 → `analyze.py` 의 scenes(스테이지 9)·shots(13)
**앞**에서 호출. 입력은 `scenes` 가 아니라 `refined` — scenes 가 genre 로 잘리므로 순환이다.
결과는 `genre.json` 으로도 남긴다.

⚠️ **검증 미실행.** 코드 변경 비용은 ₩0이지만 효과 확인은 재분석 1회가 필요하다
(≈₩620 · 체크포인트 재사용 시 ~19분/32분 영상 실측). 드라마 회차로 재실행해서
`shots.json` 의 `threshold` 가 0.35 로 찍히는지 확인할 것.

---

### P1 — 다음 (1~2주)

#### ✅ P1-1. 검색 로그 실배선 — **완료 (2026-08-06)**

~~`SearchLogger`를 `apps/server`의 검색 라우트와 에디터 경계 조정 핸들러에 연결한다.~~

배선 완료. 상세는 §2-⑤ 표. 실제로는 "호출 한 줄"이 아니었다 — Python JSONL 로거를 그대로
쓸 수 없어(검색이 TS 서버에서 돈다) 스키마를 Postgres 테이블로 옮겼다. 필드명은 원본 유지.

**남은 것 2개:**
- `export` 이벤트 호출부 (입구 `POST /api/search/log`는 열려 있음 — 반출 UI가 붙을 때 연결)
- **마이그레이션 `0010` 프로덕션 적용** — 안 하면 로그가 조용히 버려진다
  (`logSearchEvent`가 실패를 삼키는 설계라 검색은 정상 동작하고 로그만 안 쌓인다)

#### P1-2. 한국어 형태소 분석 도입 — **우선순위 하향**

초판은 `core/search.py:42-53`의 문자 bigram 근사를 문제로 봤는데, **프로덕션은 그 코드를 안 쓴다.**
서버는 `pg_trgm`(`search_text gin_trgm_ops`)으로 잡는다 — 언어무관 부분일치라 한자·가나도 통과한다.
초판이 지적한 "정규식 `[0-9a-z]+|[가-힣]+`가 한자를 버린다"는 **오프라인 참조 구현에만 해당**한다.

- 남은 실익: trgm은 형태소 경계를 모르므로 짧은 쿼리에서 오탐이 는다. **P1-3 평가셋의
  `quote` 유형 수치를 보고 판단** — 지금 감으로 Kiwi를 넣을 근거가 없다
- `core/search.py`와 `embed.py:45-53`의 토크나이저 2벌 문제는 여전히 유효(오프라인 도구 일관성)

#### ✅ P1-3. 검색 평가셋 — **문서·러너 완료, 데이터 작성 남음 (2026-08-06)**

`search_selftest.py`는 배관 회귀 테스트이지 품질 평가가 아니다(본인이 `:4-5`에서 인정). IR 지표가 0개다.

산출물:
- `docs/research/search-evalset.md` — 유형 5종·작성 절차·지표 정의·baseline 기록표·함정
- `docs/research/data/search-evalset.jsonl` — 평가셋 파일 (**형식 예시 2줄만 · 실 데이터 미작성**)
- `core/eval_search.py` — 러너. `GET /api/search`를 때려 유형별 Recall@1/5/10·MRR·경계오차·
  **후보0건 비율**을 낸다. 채점 로직은 오프라인 검증 완료

| 유형 | 예시 | 어느 채널이 잡아야 하나 | 목표 |
|---|---|---|---|
| `quote` 대사 인용 | "'그래서 내가 말했잖아' 나오는 데" | trgm | 15 |
| `person` 인물 | "영철이 나오는 장면" | `characters` 필터 | 12 |
| `person_action` 인물+행동 | "23기 영철 스킨십" | 필터 + action_tags (P2-2) | 12 |
| `situation` 상황 묘사 | "분위기 갑자기 싸해지는 부분" | 벡터 | 15 |
| `visual` 시각 | "노란 옷 입은 사람" | **현재 잡을 수단 없음** | 10 |

> 마지막 행이 중요하다. 순수 시각 쿼리는 지금 어떤 채널로도 안 잡힌다. 평가셋에 넣어두면 **시각 임베딩이 실제로 필요한지**를 데이터로 판단할 수 있다. 감으로 도입하지 말 것.

**남은 것: 실 회차 3~5개로 64개 쿼리·정답 구간을 사람이 작성.** 러너가 있어도 정답이 없으면 못 잰다.
`후보0건` 지표를 따로 낸 이유는 §2-⑧ 같은 필터 결함을 랭킹 문제로 오진하지 않기 위해서다.

#### P1-4. GEBD 배선 (`AUTO_GEBD=1`)

이미 계획이 완비되어 있다(`scene-boundary-model-wire.md`, `production-gpu-10usd-plan.md`). 재계획에서 덧붙일 것은 하나:

**fallback 경계가 전부 `grade="hard"`로 강제되어(`boundaries.py:200`) continuity gate가 무력화**된다(`beats.py:1029`는 soft만 강등). GEBD가 붙으면 soft 등급이 생겨 gate가 살아나므로, **beat 분포가 눈에 띄게 바뀔 것**이다. GEBD 배선과 동시에 P1-3 평가셋을 돌려 회귀를 확인할 것.

#### ✅ P1-5. 저장소 실장 (pgvector) — **이미 완료였다 (초판 오류)**

~~`segments.json` 전수 스캔 → `search_segments` 테이블.~~ 초판 작성 시점에 이미 있었다.
`search.py:6`의 설계 의도("필터=SQL WHERE, 벡터=pgvector, 같은 로직 다른 저장소")대로 되어 있다.

`rights`/`scope` None 문제도 **절반은 이미 해결돼 있었다** — `content-pipeline.ts`가 적재 직전
episode 엔티티를 조인해 `program_id`·`episode`·`aired_at`을 주입하고, PPL 검출 구간과 오버랩되는
세그먼트에 `rights.ppl=true`를 찍는다. 초판의 "스코프·방영일 필터를 걸면 항상 0건"은 틀렸다.

**진짜 남은 None:**

| 필드 | 무엇이 필요한가 |
|---|---|
| `scope_type` / `scope_id` | 기수·시즌 개념. **온보딩 설정 UI가 없어서 생산자 자체가 없다** |
| `rights.cast_ok` | 출연자 사용 승인 — 운영자 입력 또는 계약 데이터 |
| `rights.music_cleared` | 음원 클리어 — 방송사 내부 데이터(계약 후) |
| `rights.spoiler` | 방영 전 노출 금지 — 방영일 대비 자동 판정 가능(`aired_at`이 있으니) |

마지막 행은 **지금 바로 가능하다**: `aired_at > now()` 면 `spoiler=true`. 나머지 셋은
`pre-sales-beta-strategy`(계약 전엔 외부 데이터만) 원칙상 계약 후 항목이다.

---

### P2 — 그 다음 (2~4주)

#### P2-1. 리텐션 커브 → 하이라이트 신호 ★ 가장 높은 ROI

```
1. 원본 롱폼의 video_retention.curve 로드 (없으면 skip)
2. ratio(0~1) → 초 변환: t = ratio × duration
3. beat 구간 [start, end]에 매핑 → mean(watchRatio), mean(relative)
4. highlight_score 및 recommend 프롬프트에 주입
```

**두 가지 쓰임이 있고 혼동하면 안 된다** (feasibility `:154-161`가 지적):
- **(A) 원본 롱폼 리텐션** = "원본의 어느 구간이 붙들었나" → **하이라이트 후보 선정 신호**. 지금 바로 쓸 수 있다
- **(B) 발행된 쇼츠의 성과** = 폐루프 라벨. 클립↔영상 조인이 수동(`index.ts:1093`)이라 나중

프롬프트 주입 형태는 ⭐VIEWER 마킹(`recommend.py:3073-3107`)을 그대로 본뜨면 된다 — `📈RETENTION(상위 10%)` 같은 태그를 beat 목록에 붙이는 방식. **이미 검증된 패턴이라 새로 설계할 게 없다.**

#### P2-2. action_tags

`auto-cast-and-action-tags.md`의 Part 2를 그대로 실행. 재계획에서 덧붙일 것:

- **vocabulary를 30~50개로 고정**하는 판단은 옳다. 자유 태그는 recall이 무너진다
- 다만 `search_segments.action_tags TEXT[]` + GIN은 **P1-5(저장소 실장) 이후**여야 한다. 지금 스키마를 설계해도 적재할 테이블이 없다
- chyron 배치 콜에 얹는 방식(추가 콜 0)은 비용 면에서 정확한 선택이다. **단 chyron 배치화(Fix 2)가 선행**이다
- P1-3 평가셋에 action 쿼리를 미리 넣어두면 도입 효과를 수치로 볼 수 있다

#### P2-3. 회차 간 인물 앵커링 — PIPA 원칙을 지키면서

문제(§2-⑥): 얼굴 클러스터 라벨이 회차마다 재계산된다.

**제안**: 얼굴 임베딩으로 *신원을 주장하지 않되*, **클러스터 centroid를 프로그램 단위로 영속화**해 회차 간 라벨 일관성만 확보한다.

```
program_face_clusters(program_id, cluster_key, centroid vector(512), n_episodes, last_seen)
```

- 새 회차의 클러스터 centroid를 기존과 코사인 비교 → 임계값 이상이면 같은 `cluster_key` 승계
- **이름은 여전히 chyron/운영자만 부여한다.** 얼굴은 "같은 사람으로 보임"까지만 말하고 "누구"는 말하지 않는다
- 효과: `auto-cast-and-action-tags.md`의 "동명이인 → 얼굴 클러스터로 구분(영철A/영철B)" 계획(`:35`)이 비로소 가능해진다. 지금은 회차 간 클러스터가 이어지지 않아 그 계획이 성립하지 않는다
- 임계값은 `faces.py:313-339`의 병합 임계 0.70을 출발점으로. 회차 간은 조명·화질 차이가 크므로 **더 보수적으로(0.75~0.80) 시작**할 것 — 과병합이 과분할보다 훨씬 나쁘다(운영자가 못 되돌린다)

#### P2-4. `scene_type` 결정 — 살리거나 죽이거나

지금은 Gemini Vision 비용을 쓰고 결과를 버린다(소비처가 死코드뿐). 둘 중 하나:
- **살린다**: `index_segments.py`의 세그먼트에 `scene_type`을 넣는다 — **이미 넣고 있다**(`:243`). 그렇다면 검색 필터로는 살아 있는 셈이니, `recommend` 프롬프트에도 주입해 완성
- **죽인다**: 스테이지 제거. 회차당 비용 절감

검색 쿼리 로그(P1-1)가 쌓이면 "인터뷰/현장" 필터를 실제로 쓰는지 데이터로 판단할 수 있다. **그때까지 보류**가 합리적이다.

#### P2-5. faces·ppl 성능

`pipeline-optimization-findings.md` 실측: faces 335~2167초, ppl 최대 3787초. **파이프라인 전체 시간의 대부분**이다.

- faces: `faces.py:155`가 세그먼트마다 단일 스레드 InsightFace. 배치화 여지가 크다
- ppl: 축구 109분 = 1308프레임. `PPL_SAMPLE_SEC` 상향 또는 사전 필터
- **P0-1의 오디오/모션 신호로 사전 필터링**하면 두 스테이지 모두 프레임 수를 줄일 수 있다 (원래 `prefilter.py`의 역할이 정확히 이것이었다)

---

### P3 — 이후 (근거가 쌓인 뒤)

- **학습 재랭킹 (LightGBM)** — `apply_learned_rerank`(`recommend.py:387`) 자리에 투입. **전제: P0-1 신호 + P1-1 로그 + P2-1 리텐션.** 지금 시작하면 피처가 없어 실패한다
- **크로스인코더 리랭커** — P1-3 평가셋에서 RRF top-50의 recall은 높은데 top-5 precision이 낮게 나올 때만
- **시각 임베딩** — P1-3의 "시각 쿼리" 유형이 실제로 유의미한 비중일 때만 (§7 참조)
- **死코드 정리** — `build_beats()`, `timeline.py`, 미배선 chyron 모드 등. 별도 트랙

---

## 5. 검증 계획

각 P0/P1 항목마다 **바꾸기 전에 baseline을 뜬다.**

| 대상 | 지표 | 도구 |
|---|---|---|
| 쇼츠 추천 | Hit@N · IoU≥0.5 · 경계 오차 중앙값 | `evaluate.py` (이미 있음) |
| 검색 | Recall@10 · MRR · **쿼리 유형별 분해** | P1-3 신설 |
| beat 분포 | 길이 히스토그램 · 개수 | 신설 (10줄) |
| 비용 | 회차당 ₩ | `usage.json` (이미 있음) |
| 시간 | 스테이지별 초 | `stage_sec` (이미 있음) |

**GEBD 배선(P1-4)과 3축 해제(P0-2)는 반드시 단독으로 배포하고 각각 측정할 것.** 둘 다 beat 분포와 랭킹을 동시에 흔들어서, 같이 넣으면 어느 쪽이 효과였는지 영영 모른다.

---

## 6. 기존 계획 문서와의 관계

| 기존 문서 | 이 재계획과의 관계 |
|---|---|
| `auto-cast-and-action-tags.md` | **유효.** P2-2·P2-3으로 편입. 단 저장소 실장(P1-5) 선행 조건 추가, 회차 간 얼굴 앵커링(P2-3)을 전제로 보강 |
| `chyron-per-seg-hardening.md` | **유효.** action_tags의 선행 조건 |
| `scene-boundary-model-wire.md` | **유효.** P1-4. continuity gate 회귀 확인 항목 추가 |
| `production-gpu-10usd-plan.md` | **유효.** 이 재계획은 GPU 부하를 늘리지 않는다 (P0-1은 CPU/ffmpeg) |
| `highlight-model-feasibility.md` | **부분 무효.** 전제한 `prefilter.py` 5신호가 삭제됨(§2-①). P0-1로 복구한 뒤에야 §5의 ML 계획이 성립 |
| `docs/research/search-evalset.md` | **신설 (2026-08-06).** P1-3의 산출물. 유형 5종·절차·지표·baseline 표 |
| `context-engine-plan.md` | 대조 필요 (이번에 정독 못함) |
| `step-d-master-build-plan.md` | 설계 정본이나 낡음 — `pipeline-current-state.md`가 실측 정본 |

**문서 정정 필요 2건**:
- `pipeline-current-state.md:68` — "Vertex text-emb-004 + pgvector" → 임베딩 모델은 실제로
  `text-multilingual-embedding-002`(768d)다. **pgvector 부분은 맞다** — `apps/server`에 구현돼 있다
  (초판이 `core/`만 보고 "미구현"이라 한 것이 오류)
- `pipeline-current-state.md:66` — "4 시나리오 병렬"은 beat-only 전환 이전 표현. 현재 기본 경로에서 도는 4-병렬은 `refine_boundaries_semantic`(`recommend.py:2894`)

---

## 7. 앞 설계서에서 철회하는 권고

일반론 설계서(`video-search-architecture.md`)의 다음 권고는 **STEP-D에는 후퇴**다.

| 철회 항목 | 이유 |
|---|---|
| **로컬 GPU 스택 전면 채택** (X-CLIP, Qwen3-VL 8B, faster-whisper 자체 호스팅) | STEP-D는 이미 Soniox+Gemini API로 **회차당 ₩620**을 달성했다. GPU 스택 전환은 운영 복잡도를 크게 올리면서 비용을 못 낮춘다. 월 $10 GPU 계획(GEBD 전용 spot T4)이 이미 정답이다 |
| **TransNetV2** | GEBD(mmaction2)로 이미 결정됐고 Docker화 진행 중. TransNetV2는 **GEBD 배선이 실패할 때의 대안**으로만 유지 |
| **얼굴 임베딩으로 캐릭터 뱅크 자동 명명** | STEP-D는 PIPA 생체정보 리스크를 이유로 **의도적으로 배제**했다(`cast.py:10-12`). 이 원칙이 옳다. chyron 기반 명명이 맞고, 얼굴은 §P2-3처럼 "동일인 여부"까지만 |
| **시각 임베딩 즉시 도입** | 로컬 시각 임베딩의 검색 정확도가 텍스트 대비 낮다는 게 애초 설계서의 결론이었다. STEP-D는 이미 텍스트 채널이 강하다. **P1-3 평가셋에서 시각 쿼리 비중이 확인된 뒤**에 결정 |
| **Qdrant/OpenSearch 3-시스템 분리** | 이미 Cloud SQL이 있다. pgvector + Postgres 전문검색으로 충분하다. 규모가 문제가 되기 전에 분리하면 배보다 배꼽 |

**유지되는 권고**: 계단식 필터 원칙, 오디오 우선, 텍스트 채널 주력, 문장 경계 스냅 우선, 평가셋 필수, 로그 선행 수집.

---

## 8. 착수 순서 요약 (2026-08-06 오후 갱신)

```
[완료]   ✅ P1-1 로그 배선          — search_events + 4지점
         ✅ P1-5 pgvector 저장소     — 초판 오류. 이미 있었음
         ✅ §2-⑧ chyron→characters   — 인물 필터 결함 수정
         ✅ P1-3 평가셋 문서·러너     — 데이터 작성은 남음

[다음]   ① 마이그레이션 0010 프로덕션 적용   ← 안 하면 로그가 조용히 버려진다
         ② P1-3 평가셋 데이터 64개 작성      ← 이게 없으면 이하 전부 "좋아졌는지 모름"
         ③ P0-1 core/signals.py              ← highlight_score 를 LLM 독립으로 (§4.0)

Week 1-2 P0-2 3축 해제 (랭킹 변별력)   ─┐
         P0-3 死코드 배선               ├─ 각각 독립 배포 · 각각 측정
         P0-4 hook 검증                 │
         P0-5 장르 타이밍 수정          ─┘

Week 3   P1-4 GEBD 배선 (단독 배포 · beat 분포 회귀 확인)
         rights.spoiler 자동 판정 (aired_at 기반 · 지금 가능)

Week 4-6 P2-1 리텐션 ★ 최고 ROI
         P2-2 action_tags   (person_action 유형 baseline 이 이미 잡혀 있을 것)
         P2-3 회차 간 얼굴 앵커링
         P2-4 scene_type 결정
         P2-5 faces·ppl 성능

보류     P1-2 형태소 — 서버는 trgm 이라 초판만큼 급하지 않다. 평가셋 수치 보고 결정
이후     P3 (근거 축적 후)
```

~~**가장 먼저 할 딱 하나를 고르라면 P1-1(로그 배선)이다.**~~ → 했다.

**이제 가장 먼저 할 하나는 ② 평가셋 데이터다.** 러너는 있고 정답이 없다. 이 상태로 P0-1을
넣으면 좋아졌는지 나빠졌는지 모른 채 다음으로 넘어가게 된다 — 이 문서가 §5에서 스스로
경고한 실패 모드다. **①은 배포 시 같이 나가면 되므로 병렬.**

---

## 부록 · 이번 조사에서 확인된 코드-문서 불일치

| # | 위치 | 내용 |
|---|---|---|
| 1 | `faces.py:1-16` docstring vs `:373-376` | 헤더는 "speaker로 덮어씀"이라 하나 실제로는 안 건드림. `labeled`/`auto_mapping`/`photo_mapping`은 죽은 변수 |
| 2 | `asr.py:88-89` vs `:1197` | 기본 provider(soniox)가 `_apply_vad_postprocess`를 안 거쳐 **`diarization_turns` 미생성** → `analyze.py:246`의 speaker_face_map 블록이 기본 경로에서 死 |
| 3 | ~~`index_segments.py:214`~~ | ~~`chyron.json`을 읽지만 **writer가 리포에 없음** → 항상 `[]`~~ ✅ **2026-08-06 수정** — 파고 보니 인물 필터 결함이 딸려 있었다(§2-⑧) |
| 4 | `cast.py:23,148` | "PaddleOCR-only frame"·`scene["_prefiltered"]`를 전제하나 둘 다 리포에 없음 (`ocr.py`·`prefilter.py` 삭제 흔적) |
| 5 | `analyze_stages.py:697` | `speaker_identity_map.json`의 `name`/`confidence`/`status`가 하드코딩 → **chyron이 실명을 찾아도 이 파일엔 반영 안 됨** (`refined[].speaker_name`엔 반영됨) |
| 6 | `speaker_face_map.py:4,17` vs `asr.py:1034` | 전자는 `SPEAKER_00` 전제, ECAPA는 `발화자 N` 생성. 로직은 무관하게 동작하나 라벨 체계 2갈래 |
| 7 | `chyron_scan.py:309` | `map_speakers_from_chyron`이 `startswith("SPEAKER_")` 필터 → `발화자 N`과 절대 매칭 안 됨 (단, 함수 자체가 미배선) |
| 8 | `recommend.py:1142` | `heur_score`를 읽지만 **쓰는 코드가 리포에 0건** (`prefilter.py` 삭제 잔재) |

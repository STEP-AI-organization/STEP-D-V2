# 하이라이트 생성 품질 개선 실현가능성 조사 — 연결된 100만 구독자 채널 데이터 활용

> 작성: 2026-07-17 · 코드 실측 기반(추측 배제, 근거는 파일/함수/라인으로 인용)
> 조사 목적: **이미 연결된 대형(≈100만 구독자) 유튜브 채널의 데이터를 활용해, 현행 AI 하이라이트/쇼츠
> 추천의 품질을 어떻게 개선할 수 있는가**에 대한 기술적 실현가능성 판단.
> 성격: **기술 조사 산출물** — NCC 바우처/행정 제출과는 별개 문서다(§6에서 분리 원칙만 명시).
> 대상 코드: `core/`(파이썬 파이프라인) · `apps/server/src/`(수집·저장·YouTube 연동).

---

## 0. 요약 (TL;DR)

- **지금 당장 활용 가능한 학습 신호는 두 계열이 이미 코드에 영속되고 있다.**
  ① 운영자 결정 라벨 — 추천 채택(`adopt`)=positive, 거절(`reject`, 사유 포함)=negative가 `entities` 테이블에
     JSONB로 남는다(`index.ts:936·946`). ② 유튜브 성과 — **영상별 리텐션 커브(초 단위 이탈)**,
     조회수·평균지속·평균지속률·좋아요·공유·트래픽소스·인구통계가 실제 Analytics API로 수집되어
     `video_retention`/`video_analytics` 테이블에 저장된다(`youtube.ts:544`, `db-pg.ts:166·220`).
- **피처의 절반 이상이 이미 산출·영속된다.** Gemini 씬 채점(`vision_score`/`vision_reason`/`vision_tags`),
  번인 자막/이름(`on_screen_names`/`on_screen_text`), 그리고 **알고리즘 사전필터의 5개 원신호**
  (얼굴 수·모션·오디오 에너지·자막밴드 엣지밀도·대사밀도)가 `heur` 필드로 이미 프레임마다 계산된다(`prefilter.py:39·234`).
  이것들이 `content_analysis.data` JSONB에 통째로 저장된다.
- **모델은 "새 파이프라인"이 아니라 "Gemini 점수 뒤에 붙는 재랭킹 레이어"로 들어간다.** 현행 최종 점수는
  `final = appeal(Gemini 1–5) × program_fit`(`recommend.py:166 apply_profile_fit`)이라, 이 곱셈 보정 자리에
  **학습된 스코어러(LightGBM 등 gradient boosting)** 를 끼우면 된다. 3,000클립 규모에는 풀 딥러닝이 아니라
  gradient boosting이 정합적이다(§5).
- **추가 구현이 필요한 것**: (a) 채택/거절 라벨 ↔ 후보 피처 조인 배치(현재 라벨과 피처가 서로 다른 테이블),
  (b) 게시된 클립 ↔ 유튜브 영상 성과 조인의 자동화(현재 `link-video` 수동, `index.ts:1093`), (c) 후보 단위
  피처 집계기(씬 배열 → 구간 피처), (d) 학습·서빙 코드 자체. 순수 신규는 (c)(d)뿐이다.
- **NCC 분리 리스크**: "데이터를 학습에 쓰는 것"과 "라벨링 수행 주체(콴엔터 명의 3,000클립)"는 반드시
  분리 관리해야 한다. 데이터 활용은 무방하나, 자사가 라벨링을 대행한 것처럼 서류가 섞이면 반려·환수 사유다(§6).

---

## 1. 현재 하이라이트/추천 파이프라인 구조 (현황)

프로덕션 진입점은 `core/analyze.py`의 `analyze()`이며, 워커가 `content.analyze` 잡에서
`python -m core.analyze <video> --out <dir>`로 스폰한다(`content-pipeline.ts:101·335`). 전 단계 GPU-free,
Gemini/Vertex(서울, `asia-northeast3`) + ffmpeg + scenedetect. 각 단계는 `--out` 디렉토리에
체크포인트(`stt.json → refined.json → scenes.json → shorts.json → analysis.json`)로 저장돼 재개 가능(`analyze.py:45·115`).

### 1-1. 단계별 입출력

| # | 단계 | 코드 | 입력 → 출력 | Gemini 사용 |
|---|------|------|-------------|-------------|
| 1 | STT | `asr.py:transcribe` | 영상 → `{segments:[{start,end,text,words}]}` | ✅ Gemini(기본), 90초 윈도우 병렬. 실패 시 faster-whisper(int8 CPU) 폴백 |
| 2 | 자막 정제 | `refine.py:refine_segments` | segments → 맞춤법·반복 정리된 자막(타임스탬프 1:1 보존) | ✅ Gemini, 40세그먼트 배치 |
| 3 | 장면 분할+프레임 | `scenes.py:build_scenes` | 영상+자막 → `scenes[]{index,start,end,duration,frame,text,has_dialogue}` | ❌ scenedetect(ContentDetector th=27) + ffmpeg 대표프레임. 무음 장면도 후보로 남김 |
| 4a | OCR 사전추출 | `ocr.py:ocr_scenes` | 전 프레임 → `on_screen_names`/`on_screen_text` | ❌ PaddleOCR(옵션, 미설치 시 no-op) |
| 4b | 사전필터 | `prefilter.py:select_for_vision` | 전 프레임 → `heur_score`+`heur{}`, 상위 N만 Gemini行 선정 | ❌ OpenCV/librosa. 프레임 30개 초과 시만 작동 |
| 4c | 프레임 분석 | `vision.py:analyze_frames` | 상위 N 프레임 → `vision_score/reason/tags` + `on_screen_names/text` | ✅ Gemini Vision(프레임 1콜=시각채점+번인텍스트 동시) |
| 5 | 쇼츠 추천 | `recommend.py:recommend` | `scenes[]` → `shorts[]{rank,start,end,title,reason,appeal,tags,hook,...}` | ✅ Gemini 2-phase(후보추출→합성) |
| 6 | 결과 | `analyze.py:243` | 전부 → `analysis.json`(transcript+scenes+shorts) | — |

### 1-2. 추천 스코어가 실제로 계산되는 방식

핵심은 **"융합 점수(Gemini appeal)"에 "프로그램 적합(program_fit)"을 곱한 최종 점수**다. 단계별로:

1. **사전필터 heur_score (0–100)** — `prefilter.py:score_scenes_heuristic`. 5개 신호를 배치 내 정규화 후
   가중합: `faces 0.25 · motion 0.25 · audio 0.20 · caption 0.15 · dialogue 0.15`(`prefilter.py:39`).
   상위 N(기본 `VISION_GEMINI_MAX=30`)만 Gemini로 보내고, 나머지는 `vision_score = heur_score`로 채워
   `_prefiltered=True` 표식(`prefilter.py:237`). **→ 그래서 `vision_score`는 두 출처(진짜 Gemini vs 휴리스틱 대체)가 섞여 있다.**
2. **Gemini vision_score (0–100)** — `vision.py:analyze_frame`. 대사 무관하게 "시각적 숏폼 가치"를 채점.
   방송 자막이 박힌 프레임은 가점 유도(프롬프트 `vision.py:52`). temperature=0(재현성).
3. **후보 appeal (1–5)** — `recommend.py`. Phase 1이 ~80장면/10분 청크별로 후보를 뽑고(`_extract_candidates`),
   Phase 2가 전체 후보를 한 번에 보고 병합·순위·`appeal`(바이럴 절대평가)을 매긴다(`_synthesize`). **appeal은
   기계적 순위역산이 아니라 모델의 판단값**이다(`recommend.py:12` 주석).
4. **최종 = appeal × program_fit** — `recommend.py:166 apply_profile_fit`. 프로그램 프로파일이 있을 때만 작동:
   - `taboos` 히트 후보는 **하드 필터로 제거**,
   - `hookWeights`(8개 훅 카테고리 가중치)를 후보의 `hook`에 곱하고,
   - `targetLength` 근접도(`len_fit`)를 곱해 → `program_fit = hook_w × len_fit`,
   - `final_score = appeal × program_fit`로 재정렬(`recommend.py:195·198`).
   프로파일 신호가 없으면 no-op이고, `validate_shorts`가 rank/appeal 순으로 정렬(`recommend.py:417`).

> **중요한 사실 정정**: 현재 스코어에 "채널 적합"이라는 축은 **없다.** 존재하는 보정은 **프로그램 프로파일**
> 하나뿐이고(`program.profile`, 에피소드→프로그램에서 해석: `content-pipeline.ts:325`), 그나마 사람이 손으로
> 입력한 사전 정보(watchPoints/hookWeights/taboos/targetLength)다. **성과 데이터로 학습된 채널-특화 신호는 아직 0건.**
> 즉 "100만 채널 데이터로 채널적합을 학습"은 지금 존재하지 않는 새 능력을 만드는 것이다.

---

## 2. 데이터 저장 구조 — 무엇이 영속되고 무엇이 휘발되는가

### 2-1. 분석 결과 (하이라이트 파이프라인 산출물)

| 데이터 | 소재 | 영속성 | 근거 |
|--------|------|--------|------|
| transcript(정제 자막) | `content_analysis.data` JSONB(mediaId PK) | ✅ 영속(DB) | `db-pg.ts:220·841`, `analyze.py:247` |
| **scenes[] 전체** (vision_score/reason/tags, `heur_score`+`heur{faces,motion,audio,caption,dialogue}`, on_screen_names/text, has_dialogue, frame 경로) | `content_analysis.data.scenes` JSONB | ✅ 영속(DB) | `content-pipeline.ts:343`, `prefilter.py:234` |
| shorts[] (rank/appeal/hook/program_fit/final_score/title/reason/tags) | `content_analysis.data.shorts` JSONB | ✅ 영속(DB) | `recommend.py:195`, `content-pipeline.ts:343` |
| **씬 대표 프레임 JPG** | GCS `analysis/{mediaId}/scene_frames/*.jpg` | ⚠️ 최선노력(best-effort) | `content-pipeline.ts:219 persistArtifacts` — 실패해도 잡은 성공, `framesStored:false`만 기록(`:342`) |
| 스테이지 체크포인트 JSON | GCS `analysis/{mediaId}/*.json` | ⚠️ 최선노력 | `content-pipeline.ts:222` |
| 로컬 작업 디렉토리(영상+프레임+체크포인트) | 워커 VM `/tmp/stepd-content/{mediaId}` | ❌ 휘발 | 성공 시 즉시 삭제(`content-pipeline.ts:376`), 실패 시 48h 후 sweep(`:45·66`) |
| STT word-level 타임스탬프 | — | ❌ 없음(Gemini 경로) | `asr.py:192` — Gemini는 발화 단위만, `words:[]` |

**요지**: 하이라이트 학습에 필요한 **피처는 사실상 전부 `content_analysis.data` JSONB에 영속**된다.
휘발하는 것은 원본 영상 바이트와 로컬 tmp뿐이고, 프레임 이미지는 GCS에 남되 "최선노력"이라 유실 가능성이 있다
(재현하려면 원본에서 재추출 필요 — `analyze.py:157`에 프레임 복구 로직 존재).

### 2-2. 운영자 결정 라벨 (지도학습의 정답)

| 액션 | 저장 | 남는 신호 | 근거 |
|------|------|-----------|------|
| **채택(adopt)** | `recommendation` 엔티티 `status:"adopted"`, `adoptedClipId` 세팅 + `clip` 엔티티 생성 | **positive** | `index.ts:900·936` |
| **거절(reject)** | `recommendation` 엔티티 `status:"rejected"`, **`rejectReason`** 세팅 | **negative + 사유** | `index.ts:941·946` |
| 미결정 | `status:"pending"` | 약한 신호(관찰 안 됨) | `content-pipeline.ts:174` |

- 추천 재실행은 해당 에피소드 추천을 **전부 삭제 후 재삽입**(멱등, `content-pipeline.ts:196`)이므로, 라벨을
  장기 축적하려면 삭제 전에 별도로 적재하는 배치가 필요하다(현재는 최신 상태만 유지 → **과거 라벨이 덮여 사라질 수 있음**).
- **조인 갭 주의**: 라벨은 `recommendation` 엔티티에 있고, 피처(scenes/shorts)는 `content_analysis`에 있다.
  `recFromShort`가 엔티티로 옮길 때 **hook/program_fit/final_score를 버린다**(`content-pipeline.ts:157` — appeal·start·end·tags·title만 매핑).
  따라서 라벨↔피처 조인 키는 `episodeId(→mediaId) + startTime/endTime`이 된다(정확 매칭 아님, 근사 매칭 배치 필요).

---

## 3. 연결된 100만 채널로 확보 가능한 학습 신호

### 3-1. 가져올 수 있는 것 (코드로 이미 수집 중)

`youtube.ts:fetchVideoAnalytics`(`:544`)가 영상 하나에 대해 4~5개 리포트를 병렬 수집하고,
`video.analyze` 잡이 동기화된 전체 업로드에 대해 주기 실행한다(`worker.ts` fan-out, 게시7일 미만 매일/이후 주1회).

| 신호 | 어디서 | API 파라미터 | 저장 |
|------|--------|--------------|------|
| **리텐션 커브(구간별 이탈)** | `youtube.ts:556` | `dimensions=elapsedVideoTimeRatio`, `metrics=audienceWatchRatio,relativeRetentionPerformance` | `video_retention.curve` JSONB `[{ratio,watchRatio,relative}]` (`db-pg.ts:166`) |
| 조회수·평균지속·평균지속률·좋아요·공유·구독증가 | `youtube.ts:554` | `metrics=views,averageViewDuration,averageViewPercentage,subscribersGained,likes,shares` | `video_analytics.summary` |
| 트래픽 소스 | `youtube.ts:561` | `dimensions=insightTrafficSourceType` | `video_analytics.trafficSources` |
| 시청자 인구통계 | `youtube.ts` | `dimensions=ageGroup,gender` → `viewerPercentage` | `video_analytics.demographics` |
| 수익(estimatedRevenue 등) | `youtube.ts:582` | monetary 리포트(403이면 조용히 생략) | `channel_analytics.estimatedRevenue`, video summary에 병합 |
| 상위 댓글(최대 100) | `youtube.ts:608~` | commentThreads | `video_comments` |
| 누적 조회수 시계열 | sync | Data API statistics | `video_stats`(INSERT만, 스냅샷) |
| 신규 업로드 48h 시간별 스냅샷 | `video.hotwatch` | — | `video_stats` |

**리텐션 커브가 이 조사의 핵심 자산이다.** `audienceWatchRatio`는 영상 길이를 0→1로 정규화한 구간별
시청 유지율이고, `relativeRetentionPerformance`는 유사 영상 대비 상대 성과다. 즉 **"이 영상에서 시청자가
어디서 몰리고 어디서 이탈했는가"** 를 직접 준다 — 하이라이트 품질의 사실상 정답 신호에 가장 가깝다.

### 3-2. 가져올 수 없는 / 제약이 있는 것

- **남의 채널은 못 읽는다.** Analytics는 `ids=channel==MINE`만 가능(`youtube.ts:31` 주석). **연결된 100만 채널은
  그 채널 소유자의 refresh token으로 `MINE`을 부르는 구조라 OK**지만, 토큰 없는 제3자 채널·경쟁 채널은 불가.
- **동의화면 미게시(Testing)면 refresh token이 7일 뒤 죽는다** — 크리티컬 패스. 대형 채널 데이터를 지속
  수집하려면 OAuth 앱을 Production 게시 + Google 민감스코프 심사 통과가 선결(`youtube-channel-analytics-guide.md §1`).
- **스코프 분리 이전 연결 채널**은 토큰에 `yt-analytics.readonly`가 없어 403 → 재동의 필요(감지는 됨,
  `409 channel_needs_reconsent`, `index.ts:930`).
- **쿼터**: Data API 기본 10,000 units/day, Analytics 별도. 대형 채널 다수 붙으면 금방 소진 → 증설 신청 필요
  (`guide §4-4`). `video.analyze`는 영상당 Analytics 4~5콜.
- **리텐션/상대성과는 최소 트래픽 미달 영상엔 400**(계산 거부) → soft-degrade로 빈 배열(`youtube.ts:510·585`).
  즉 조회수 낮은 영상은 리텐션 라벨이 비어 있을 수 있다(라벨 희소성, §6).
- **클립 ↔ 게시영상 연결이 수동이다.** STEP D에서 만든 클립을 유튜브에 올렸을 때, 그 게시영상의 성과와
  클립을 잇는 건 `PATCH /api/clips/:id/link-video`로 **사람이 videoId를 입력**해야 한다(`index.ts:1093`,
  `publishedVideoId`). 배포(publish)도 아직 스텁(상태 기록만). → **"우리가 뽑은 하이라이트가 실제로 터졌는가"
  의 폐루프는 지금 자동으로 닫히지 않는다.**

### 3-3. 두 종류의 리텐션 신호를 혼동하지 말 것 (설계상 중요)

- **(A) 원본 롱폼의 리텐션 커브** → "원본의 어느 구간이 시청자를 붙들었나". 이게 **하이라이트 후보 선정의
  직접 라벨**이다. 단, 원본 롱폼이 그 채널에 유튜브로 올라가 있고 토큰으로 읽을 수 있어야 한다.
- **(B) 게시된 쇼츠/클립의 성과** → "우리가 뽑은 클립이 실제로 잘 됐나". 이건 **모델 검증(오프라인 평가)** 신호다.
  §3-2의 수동 조인 갭 때문에 지금은 확보가 어렵다.

→ 초기에는 확보 난이도가 낮은 **(A) 원본 리텐션 + 운영자 채택/거절(§2-2)** 을 라벨로 쓰고, (B)는 폐루프
자동화(§7-3단계) 후에 편입하는 게 현실적이다.

---

## 4. 피처 추출 가능성 — 이미 나오는 것 vs 추가 필요

후보 클립 하나의 피처 = 그 구간 `[start,end]`에 포함되는 `scenes[]`를 집계해서 만든다. 씬 배열은 §2-1대로 영속된다.

| 피처 | 상태 | 출처 | 비고 |
|------|------|------|------|
| Gemini 시각점수 통계(max/mean/구간분포) | ✅ 산출됨 | `scene.vision_score` | 사전필터 대체값 섞임 주의(`_prefiltered`) |
| 오디오 피크/에너지 | ✅ 산출됨 | `scene.heur.audio` | librosa onset 또는 numpy RMS(`prefilter.py:129`) |
| 얼굴 클로즈업/얼굴 수 | ✅ 산출됨(근사) | `scene.heur.faces` | Haar cascade 카운트(`prefilter.py:62`). "클로즈업 비율"은 박스 크기 미저장이라 **추가 필요** |
| 컷 전환 빈도 | ✅ 유도 가능 | `scenes[]` 밀도(초당 씬 수) | 씬 경계가 곧 컷 → 구간 내 씬 수/길이로 계산, 저장은 안 됨 → 집계기서 산출 |
| 자막(번인) 밀도/밈자막 유무 | ✅ 산출됨 | `scene.heur.caption`, `on_screen_text` | 방송 편집자가 이미 찍은 포인트 신호 |
| 대사 밀도(자/초) | ✅ 산출됨 | `scene.heur.dialogue` | `prefilter.py:183` |
| 등장인물(이름자막) | ✅ 산출됨 | `scene.on_screen_names` | 인물 등장/전환 신호로 활용 가능 |
| 훅 카테고리(반전/웃음/갈등…) | ✅ 산출됨 | `short.hook` | Gemini가 8종 중 택1(`recommend.py:112`) |
| 장르 | ✅ 산출됨 | `analysis.genre` | auto 감지(`recommend.py:213`) |
| **자막 감정/키워드 밀도** | ⚠️ 부분 | transcript 텍스트는 있음 | 감정 스코어/키워드 밀도는 **미산출** → 추가 구현(경량 KoELECTRA 감정분류 또는 Gemini 태깅) |
| **얼굴 클로즈업 "비율"(면적)** | ❌ 추가 필요 | — | Haar 박스 면적/프레임 면적을 저장하도록 prefilter 확장 |
| **음성 고조/샤우팅 감지** | ❌ 추가 필요 | — | audio 에너지는 있으나 피치/스펙트럴 대비 특징 미산출 |
| **씬 임베딩(시각/텍스트 벡터)** | ❌ 추가 필요 | — | 채널 스타일 표현이 필요해지면 CLIP/텍스트 임베딩 도입(별도 조사 `object-detection-research.md`) |

**요지**: 트리 기반 부스팅 모델에 바로 넣을 **테이블형 피처는 이미 대부분 존재**한다(heur 5종 + vision + hook + 자막/이름).
초기 모델은 신규 피처 없이도 학습 가능하고, "감정 밀도"와 "얼굴 면적 비율" 정도만 얹으면 표현력이 눈에 띄게 는다.

---

## 5. 모델 삽입 지점 — Gemini 뒤의 학습형 재랭킹 레이어

### 5-1. 어디에 붙나

현행 최종 점수 산출은 `recommend.py`의 마지막 단계다:

```
_synthesize (Gemini appeal)  →  apply_profile_fit (× program_fit)  →  validate_shorts (정렬/클램프)
                                        ▲
                                        └─ 여기가 삽입 지점: program_fit 곱셈 자리에 "학습된 스코어러"를 합류
```

즉 **`apply_profile_fit`와 같은 계층에 `apply_learned_rerank(shorts, features, model)` 을 추가**한다.
Gemini 파이프라인·프롬프트는 그대로 두고(창의적 판단은 Gemini가 유지), 학습 모델은 **후처리 보정·재랭킹**만 한다.
이렇게 하면 모델이 없거나 저신뢰일 때 non-destructive(현행 동작 유지)로 폴백하기 쉽다 —
`apply_profile_fit`가 프로파일 없으면 no-op인 것과 동일한 패턴(`recommend.py:178`).

**인터페이스(제안)**:
```
def apply_learned_rerank(shorts, scene_index, model, channel_ctx=None) -> shorts
    # 입력: shorts(후보) + scenes(피처 원천) + 학습모델 + 채널 컨텍스트
    # 처리: 후보별 피처 집계 → model.predict → learned_score
    #       final_score = appeal × program_fit × learned_score(정규화)  또는  단조 재랭킹
    # 출력: learned_score/rank 필드 추가된 shorts (기존 필드 보존)
```
`recommend.py`는 순수 함수 조합이라(스코어 계산에 부작용 없음) 이 레이어는 파이프라인 밖에서
오프라인 재랭킹으로도 실험할 수 있다 — `content_analysis.data.shorts`를 읽어 재점수만 다시 매기면 A/B 비교 가능.

### 5-2. 왜 gradient boosting인가 (3,000클립 규모)

- 라벨 규모 3,000 수준 + **테이블형 피처**(§4)에는 LightGBM/XGBoost류가 정합적이다. 풀 딥러닝은 이 규모에서
  과적합·데이터효율 면에서 불리하다. LightGBM은 MIT 라이선스, CPU 학습, 워커 VM에서 그대로 서빙 가능
  (현재 `core/requirements.txt`에 ML 라이브러리 **0건** — `torch`는 whisper 폴백용 언급뿐, `asr.py`).
- 학습 타깃 후보:
  - **랭킹**: LambdaMART(리텐션 상위 구간을 상위로) — 리텐션 커브가 라벨일 때 자연스럽다.
  - **이진분류**: 채택=1/거절=0 → 채택확률. 운영자 라벨이 라벨일 때.
  - 초기에는 둘을 앙상블하지 말고 하나(채택 이진분류)로 시작해 파이프라인부터 세운다.

### 5-3. 채널-공통 vs 채널-특화 피처 분리 (과적합/전이 방지)

100만 채널 하나에 과적합되면 다른 채널로 전이가 깨진다. 따라서 피처를 **두 계열로 명시 분리**한다:

| 계열 | 예 | 목적 |
|------|-----|------|
| **채널-공통(content-intrinsic)** | heur 5종, vision_score, hook, 컷밀도, 자막밀도, 대사밀도 | 어느 채널에나 이식되는 "터지는 구간"의 보편 신호 |
| **채널-특화(channel-conditioned)** | 채널 평균 리텐션 형태, 채널 선호 훅 분포, 채널 인구통계, 채널 length-fit | 그 채널 청중의 취향 보정. **원-핫 채널ID로 넣지 말고** 채널 통계 피처로 넣어 신규 채널에도 일반화 |

- **설계 원칙**: 학습은 다채널로(현 채널 1개면 우선 그 채널 + 운영자 라벨로 시작하되), **채널-특화 신호는 채널
  통계량으로 파라미터화**해 신규 채널이 붙어도 콜드스타트가 완만하게. 채널ID 임베딩·과한 채널 전용 피처는
  100만 채널 하나에 과적합될 위험이 크므로 초기엔 배제.
- **평가**: 반드시 **채널/영상 단위 hold-out**(같은 영상의 씬이 train/valid에 섞이지 않게)으로 검증.
  누수(같은 영상 분할이 양쪽에 들어가면 성능이 부풀려짐)를 1순위로 차단.

---

## 6. 리스크

### 6-1. NCC 바우처 라벨링과의 분리 (최우선 관리 포인트)

- **원칙**: **데이터 활용(학습)** 과 **라벨링 수행 주체(서류상)** 는 별개의 트랙이다. 콴엔터 명의로 수행되는
  3,000클립 라벨링 바우처의 "수행 주체"를 자사가 대행한 것처럼 산출물/정산 서류에 섞으면 **반려·환수 사유**가 된다.
- **분리 방안**:
  - 학습 데이터셋과 바우처 라벨링 산출물을 **저장소·계정·산출물 명세에서 물리적으로 분리**(어느 데이터가 어느
    트랙 소속인지 provenance를 기록). 본 리포는 STEP D 기술 트랙 문서이고, 바우처는 별도 행정 문서로 둔다.
  - 바우처 산출물(콴엔터 수행분)을 자사 모델 학습에 "사용"하는 것은 데이터 활용의 범주로 무방하되, **"자사가
    라벨링을 수행/대행했다"는 표현·정산은 금지**. 수행 주체·검수 주체·데이터 사용 주체를 문서상 명확히 구분.
  - 자사가 자체적으로 만든 라벨(운영자 채택/거절, §2-2)은 바우처와 무관한 자사 자산으로 별도 관리 — 오히려
    이쪽이 폐루프 학습의 주력 라벨이 되도록 설계(바우처 의존도를 낮춤).
- (이 항목은 기술 판단을 넘어 계약·회계 검토가 필요 — 여기서는 "분리해서 관리하라"는 설계 제약만 명시한다.)

### 6-2. 기술 리스크

| 리스크 | 내용 | 완화 |
|--------|------|------|
| **라벨 희소성** | 리텐션은 저트래픽 영상서 400(빈 커브, `youtube.ts:585`), 거절 라벨은 사유가 "기타"로 뭉개짐(`index.ts:945`) | 저트래픽 영상 제외·최소표본 게이트, 거절 사유 스키마화(자유입력→분류) |
| **라벨 유실** | 추천 재실행이 과거 라벨을 삭제-재삽입으로 덮음(`content-pipeline.ts:196`) | 삭제 전 라벨 스냅샷 적재 배치(§7-1) |
| **채널 과적합** | 100만 채널 1개에 특화되면 전이 붕괴 | 채널-공통/특화 분리(§5-3), 채널 통계 파라미터화, 채널 hold-out 평가 |
| **데이터 누수** | 같은 영상 씬이 train/valid 양쪽 | 영상 단위 분할 강제 |
| **피처 이질성** | `vision_score`가 Gemini/휴리스틱 혼재 | `_prefiltered` 플래그를 피처로 함께 넣어 모델이 구분하게 |
| **폐루프 미완결** | 클립↔게시영상 수동 조인, publish 스텁 | (A)원본 리텐션+운영자 라벨로 먼저 학습, (B)게시성과는 자동화 후 편입(§3-3) |
| **콜드스타트** | 신규 채널은 채널-특화 신호 없음 | 채널-공통 모델을 기본값으로, 데이터 쌓이면 채널 통계 보정 |
| **PII/데이터 잔residency** | 프레임·자막은 개인정보(생체 포함) → 서울 리전 유지 중(`vision.py:44`) | 학습 데이터도 서울 리전·접근통제 유지, 크로스보더 금지 |

---

## 7. 착수 순서 3단계 (현실적 실행 로드맵)

### 1단계 — 라벨/피처 조인 파이프라인 + 오프라인 데이터셋 (신규 학습 없음)

- **라벨 적재 배치**: 추천 재실행이 덮기 전에 `recommendation`의 채택/거절/사유를 스냅샷 테이블로 축적
  (조인 키 `episodeId+start/end`). `reject` 사유를 스키마화.
- **후보 피처 집계기**: `content_analysis.data`의 `scenes[]`를 구간별로 집계해 후보 1개당 피처 벡터 산출
  (heur 5종·vision 통계·hook·컷밀도·자막/대사밀도). — §4의 "이미 나오는 것"만으로 v0 피처셋 완성.
- **리텐션 라벨 결합**: 원본 롱폼이 연결 채널에 있으면 `video_retention.curve`를 구간에 매핑(§3-3의 A).
- 산출물: `(피처 → 채택/거절, 구간 리텐션)` 오프라인 데이터셋. **여기까지가 병목의 대부분**(순수 신규는 집계기뿐).

### 2단계 — 재랭킹 모델 학습 + 오프라인 A/B (파이프라인 미변경)

- LightGBM 채택-확률 이진분류부터 학습(채널 hold-out). 채널-공통/특화 피처 분리(§5-3).
- **오프라인 A/B**: `content_analysis.data.shorts`를 읽어 (현행 Gemini 순위) vs (학습 재랭킹) 를
  운영자 채택률·리텐션 상위 일치도로 비교. **프로덕션 파이프라인은 아직 안 건드림** — 무위험 검증.
- 게이트: 재랭킹이 채택률/리텐션 정렬에서 현행을 유의미하게 상회할 때만 다음 단계.

### 3단계 — 파이프라인 편입(non-destructive) + 폐루프 자동화

- `recommend.py`에 `apply_learned_rerank`를 `apply_profile_fit`와 같은 계층으로 추가(§5-1). 모델 부재/저신뢰 시
  현행 동작으로 폴백. `final_score = appeal × program_fit × learned`(또는 단조 재랭킹).
- **폐루프 자동화**: 클립 게시 시 `publishedVideoId` 자동 연결(현행 `link-video` 수동을 publish 흐름에 통합,
  `index.ts:1093`) → 게시 클립의 실제 성과(§3-3의 B)를 라벨로 편입 → 재학습 주기화.
- 채널이 늘면 채널-특화 통계 피처를 확장, 필요 시 감정 밀도·얼굴 면적 등 §4의 "추가 필요" 피처를 얹는다.

---

## 부록 — 인용한 핵심 코드 위치

- 파이프라인 오케스트레이션: `core/analyze.py`(`analyze()` :95, 체크포인트 :45·115)
- 사전필터(5개 원신호): `core/prefilter.py`(가중치 :39, `heur` 저장 :234, 선정 :237)
- Gemini 씬 채점+번인텍스트: `core/vision.py`(`analyze_frame` :82, 프롬프트 :52)
- 2-phase 추천 + 최종점수: `core/recommend.py`(`_synthesize` :361, `apply_profile_fit` :166)
- 워커 저장/조인: `apps/server/src/content-pipeline.ts`(`persistArtifacts` :219, `recFromShort` :149, 멱등 재삽입 :196)
- 라벨(채택/거절): `apps/server/src/index.ts`(adopt :900·936, reject :941·946, link-video :1093)
- YouTube 성과 수집: `apps/server/src/youtube.ts`(`fetchVideoAnalytics` :544, 리텐션 :556·585)
- 저장 스키마: `apps/server/src/db-pg.ts`(`video_retention` :166, `content_analysis` :220) · `docs/reference/data-model.md`
- 수집 운영/쿼터/게시 심사: `docs/ops/youtube-channel-analytics-guide.md`
- 인접 조사(검출/임베딩): `docs/archive/object-detection-research.md`

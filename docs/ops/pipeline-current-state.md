# STEP D 파이프라인 · 실제 상태 (2026-08-07 갱신)

이 문서는 **코드 실측 기준**이다. `docs/plans/step-d-master-build-plan.md` 는 설계 정본이지만 낡았다.
지금 실제로 뭐가 도는지는 여기가 정본.

> **2026-08-07 대규모 정정.** GEBD 배선에 버그 5개가 겹쳐 **경계 시각이 통째로 어긋나 있었다**
> (타임라인의 81%가 탐지 불가). 이 상태에서 뽑은 실측·판단이 여럿 무효가 됐다. §7 참조.

---

## 1. 상위 흐름

```
YouTube URL / 업로드
    │  POST /api/media/from-youtube  ·  /api/media/upload-init → finalize
    ▼
worker: youtube.download        yt-dlp → GCS
    ▼
worker: content.analyze         core.analyze 스폰 (maxAttempts=2)
    │
    ├─[AUTO_GEBD=1 이면] gebd.detect   GPU VM · Docker · boundaries.json 업로드 후 재큐
    ▼
content_analysis 저장 · search_segments(pgvector) 인덱싱 · 추천 배선
    ▼
편집자 UI → 채택 → clip → (썸네일 on-demand) → 배포(⚠️ 스텁)
```

## 2. 코드 구조

| 파일 | 역할 | 줄 |
|---|---|---|
| `core/analyze.py` | 오케스트레이터 — 병렬 executor + 스테이지 호출 + 결과 조립 | 406 |
| `core/analyze_stages.py` | 스테이지 helper 21개 (`run_*` / `join_*` / `index_*` / `dump_*`) | 961 |
| `core/analyze_utils.py` | 체크포인트 · 지문 · progress | 191 |
| `core/analyze_cli.py` | `python -m core.analyze` CLI | 81 |
| `core/beats.py` | 경계 → beat 조립 · 분할/병합/하한 | 1,191 |
| `core/beat_annot.py` | beat 프레임 Vision 주석 (+맥락 누적) | 449 |
| `core/signals.py` | beat 저수준 신호 (LLM 독립) | 250 |
| `core/index_segments.py` | 검색 세그먼트 재조립 + 임베딩 | 436 |
| `scripts/run_analyze_local.py` | **로컬 실행 러너** — .env 로드 + venv 선택 + 자격증명 사전 확인 | 81 |
| `scripts/make_review_viewer.py` | 검토 뷰어 생성 (영상+beat+쇼츠+검색) | 252 |

---

## 3. core.analyze 스테이지 (실제 순서)

| # | 스테이지 | helper | 도구 | 체크포인트 | 비고 |
|---|---|---|---|---|---|
| 0 | STT | `run_stt` | Soniox / whisper large-v3 / hybrid | `stt.json` | `STT_PROVIDER` 로 결정 |
| ‖ | ~~PPL~~ | (인라인) | ffmpeg+Gemini | `ppl.json` | **기본 off** (`RUN_PPL=1` 로 복귀) |
| 1 | faces 백그라운드 | (인라인) | InSightFace | — | `RUN_FACES=1` 일 때만 |
| 2 | viewer_signals | `load_viewer_signals` | Gemini flash | `viewer_signals.json` | comments.json 있을 때만 |
| 3 | fast 분기 | `run_fast_mode` | — | `analysis.json` | `--fast` 면 여기서 return |
| 4 | 자막 정제 | `run_refine` | Gemini flash | `refined.json` | 세그 80개/콜(`REFINE_BATCH`) · **전부 실패하면 예외로 죽는다**(원문이 체크포인트에 굳는 걸 막음) |
| 5 | chyron per-seg | `run_chyron_per_seg` | Gemini Vision | `refined.json`·`chyron.json` | `RUN_CHYRON_PER_SEG=0` 로 skip |
| 6 | speaker 후처리 | `run_speaker_postproc` | 규칙 | `refined.json` | 짧은 흡수·empty 계승 |
| 6.5 | 장르 확정 | `run_detect_genre` | 사람 지정 우선, 미지정 시 Gemini | `genre.json` | scenes·shots **앞**이어야 함 |
| 7 | faces join | (인라인) | 백그라운드 join | `faces.json` | |
| 8 | PPL join | `join_ppl` | 백그라운드 join | `ppl.json` | |
| 9 | 청크 분할 | `run_scenes` | STT gap | `scenes.json` | variety 180s · drama 300s |
| 10 | cast timeline | `run_cast_timeline` | Vision + portraits | `cast.json` | |
| ~~11~~ | ~~timeline~~ | ~~`run_timeline`~~ | — | — | **제거** (소비처 0) · helper 만 잔존 |
| 12 | narrative | `run_narrative` | Gemini flash | `narrative.json` | 4콜 병렬 |
| 13 | shot boundary | `run_shot_boundary` | ffmpeg scene | `shots.json` | 장르별 임계 (drama 0.35 · 기타 0.55) |
| 14 | scene_type | `run_scene_type` | Gemini Vision | `scene_type.json` | interview/on_scene/other |
| 15 | beats | `run_beats` | GEBD 경계 or fallback | `beats.json`·`boundaries.json` | **§4 참조** |
| 15.5 | beat 신호 | `run_beat_signals` | ffmpeg 오디오 1패스 | `signals.json` | **API ₩0** · LLM 독립 축 |
| 16 | beat annotate | `run_beat_annot` | Gemini Vision | `beats.json` | **맥락 누적 · §5** |
| 17 | speaker identity | `run_speaker_identity` | 규칙 | `speaker_identity_map.json` | cast 없으면 S1~SN 익명 |
| 18 | shorts recommend | `run_recommend` | Gemini flash | `shorts.json` | LLM=조합·제목만, **점수는 결정론** |
| 19 | analysis 저장 | (인라인) | — | `analysis.json` | |
| 20 | search 인덱싱 | `index_search_segments` | Vertex `text-multilingual-embedding-002` (768d) | `segments.json` | pgvector 적재는 서버(`content-pipeline.ts`) |
| 21 | 썸네일 (외부) | `content-pipeline.ts` | gemini-3-pro-image | `thumbnails/` | `AUTO_THUMBNAIL=1` 없으면 skip |
| 22 | usage dump | `dump_usage` | usage_metadata 누적 | `usage.json` | **캐시 토큰 포함** (2026-08-07) |

> ⚠️ **비용 집계는 `retry.call_with_retry` 안에만 있다.** Gemini 를 직접 호출하면 비용이 통째로 누락된다.

---

## 4. beat 조립 — 2026-08-07 재정비

### 경계(boundaries) 출처

**GEBD 학습모델**(`deploy/gebd/`)이 있으면 그걸 쓰고, 없으면 fallback(ffmpeg shots + STT gap).
`beats.json` 지문에 `boundaries.json` 해시가 들어가므로, 경계를 새로 얹으면
**beats·signals·shorts·analysis·segments 만** 재생성되고 STT·refine·narrative 는 보존된다.

### beat 길이 하한 (사용자 요청 2026-08-07)

`_split_beats_on_speaker_change`(화자 전환점에서 분할)와 `_merge_small_beats`(화자 다르면 병합 안 함)가
**서로 싸워서** 파편이 영영 안 붙었다. 실측: 413 beat 중 **215개(52%)가 6초 미만, 최소 1.0초.**

- 분할 최소 조각 3.0s → `MIN_BEAT_SEC`(8s) — 애초에 파편을 안 만든다
- `_enforce_min_beat_sec` — 화자 규칙 **예외 없이** 하한 강제 (`MIN_BEAT_SEC` env, 기본 6).
  짧은 쪽을 **더 짧은 이웃**에 붙여 길이 편차를 키우지 않고, 화자가 섞이면 `speaker_mixed` 표시

| | 이전 | 현재 |
|---|---|---|
| beat 개수 | 413 | **227** |
| p50 | 5.7s | **12.7s** |
| 최소 | 1.00s | **6.00s** |
| 6초 미만 | 215개 (52%) | **0개** |
| speaker_mixed | — | 26개 (11%) |

---

## 5. beat_annot 맥락 누적 (도미노) — 2026-08-07 신설

전 beat 을 한 번에 병렬로 던져 서로를 전혀 몰랐다("한 프레임만 평가하다 보니 맥락이 안 이어짐").

**프롬프트 배치가 전부다:**

```
[프로그램 정보]        ← 고정
[지금까지의 흐름]      ← 앞 beat 들의 제목·요약 누적    } 캐시 접두 (동일)
──────────────────
[프레임 이미지]        ← beat 별
[Beat 정보/대사/요청]  ← beat 별
```

- **이미지를 맨 앞에 두면 캐시가 전멸한다** — 호출마다 접두가 서로 다른 프레임으로 시작한다.
  예전 코드가 그랬고, 그래서 캐시가 한 번도 안 걸렸다.
- **청크 순차 + 청크 내 병렬** — 완전 순차는 4배 느리다. 맥락 지연은 최대 (workers-1) beat.
- **"최근 N개만 요약" 을 슬라이딩 창으로 잡으면 안 된다** — 창이 밀릴 때마다 접두가 깨진다
  (실측 공통접두 50% ≈ 600토큰 → Gemini 암묵캐시 최소치 미달). **블록 정렬**로 바꿔
  블록 안에서는 append-only(공통접두 100%)가 되게 했다.

**실측:** 긴 맥락에서 2번째 호출부터 **3,936 토큰(입력의 ~50%) 캐시 적중.**
`retry.py` 가 `cached_content_token_count` 를 집계한다 — 없으면 "캐시 활용" 이 검증 불가한 주장이 된다.

**효과 (정직하게):**

| | 이전 | 현재 |
|---|---|---|
| 인물 라벨 1회만 등장 | 70% | **40%** (라벨 재사용됨) |
| 앞 맥락 참조 표현 | 4% | **4%** (변화 없음) |

**라벨 일관성만 좋아졌고 서사 연결은 개선되지 않았다.** 요약이 여전히 해당 beat 안 내용만 서술한다.
부작용으로 라벨이 `여성 참가자 1` → `발화자 5` 로 바뀌었다(일관되지만 덜 읽힌다).
미확인 원인 셋: ①맥락 지시가 긴 프롬프트 맨 끝이라 묻힘 ②`thinking_budget=0` ③드라마라 실제로 대부분 불연속.

관련 env: `BEAT_ANNOT_CTX`(0=끄기) · `BEAT_ANNOT_CTX_RECENT`(블록 크기, 12) · `BEAT_ANNOT_CTX_MAX`(400)

---

## 6. GEBD 실행 (`deploy/gebd/`)

```
A. ffmpeg   원본 → 256p·매초 키프레임 정규화 → 정확히 CHUNK_SEC 청크
A'. module.py  청크 → 1초 세그먼트 (스트림 복사 · 0.4초)
B. mmaction2  TSN feature (1행/초)
C. SJNET      추론 → boundaries.json
```

| 파라미터 | 값 | 이유 |
|---|---|---|
| `CHUNK_SEC` | **300** | `FEATURE_LEN=300` × 1행/초 = 정확히 300행 → **0 패딩** |
| `CORES` | **1** | parmap 병렬이 산출물을 통째로 날린다 (실측 12청크 19분에 feature 0개) |
| feature 밀도 | **1.00 행/초** | 미달하면 경계 시각이 어긋난다 (`run_long_v3.sh` 가 0.8 미만이면 경고) |

**실측 (드라마 58.6분):** Stage A 277초 · Stage B 324초(29.5초/청크) · Stage C 43초 · 합 **371초** · **₩0**(로컬 GPU)

**검증:** 최근접 실제 컷까지 중앙 0.84초(무작위 1.17초) · score 구간별 적중률 단조 증가(35%→58%)
→ `GRADE_HARD_SCORE=0.35`·`GRADE_SOFT_SCORE=0.18` **그대로 둔다.**

---

## 7. ⚠️ 2026-08-07 에 무효가 된 것들

GEBD 배선 버그 5개가 겹쳐 **경계 256개가 각 60초 청크의 앞 11.4초에 몰려 있었다**(타임라인 81% 탐지 불가).
원인·수정 상세는 `deploy/gebd/README.md` §3.

| # | 버그 | 증상 |
|---|---|---|
| 1 | `module.py` `-c copy -segment_time 1` | 키프레임에서만 잘려 **0.3 행/초** (모델은 1행/초 학습) |
| 2 | `infer_batch.py` `scale = dur/300` | 0 패딩까지 영상 길이로 나눠 **16.7배 압축** |
| 3 | `infer_batch.py` `k` 변수 충돌 | 둘째 청크부터 conv1d padding 오염 |
| 4 | `run_long_v3.sh` `off = i*300` | 청크당 최대 **2.2초** 드리프트 |
| 5 | `CORES=2` parmap 병렬 | 산출물 소실 |

**이 상태에서 낸 결론은 전부 무효:**
- "리버스샷 49% · 오탐 29% · 씬전환 20%"
- "모델 score 가 씬경계와 **역상관**" → 올바른 경계에서는 **정비례**
- "`GRADE_HARD=0.35` 가 무의미" → **바꿀 필요 없음**
- 라벨 132개 (`docs/research/data/gebd/`) → JSON 에 `INVALID` 표시. 재라벨링 필요
- 파인튜닝 정당화 근거 전체 → `docs/plans/gebd-finetune-resume-plan.md` 머리말 참조

**교훈:** 모델이 "도메인 밖이라 성능이 낮다"고 결론내기 전에 **입력 텐서의 실제 모양부터** 확인할 것.

---

## 8. 같이 고친 체크포인트·인덱스 버그 (2026-08-07)

| 문제 | 증상 | 수정 |
|---|---|---|
| 무효 체크포인트를 즉시 `unlink` | `STT_PROVIDER` 미지정 → 지문 불일치 → stt.json 삭제 → 다음 줄에서 크래시 → **₩270 재지출** | 삭제 대신 `out_dir/.invalidated/` 로 이동 |
| `segments.json` 이 지문 목록에 **없음** | 무효화 루프가 `params.items()` 만 돌아 **한 번 만들면 영영 갱신 안 됨.** beats 413개인데 검색 인덱스는 182개(존재하지 않는 beat 참조) | 지문 추가(`INDEX_VER`) + 단계 자체도 beats 개수 대조 |
| Vertex 임베딩 250 instance 상한 | 389건을 한 번에 보내 `400 INVALID_ARGUMENT` → `embed_texts` 가 **전부 None** → 의미검색 전멸. beat 182개 시절엔 250 미만이라 잠복 | 200개씩 분할 (`EMBED_BATCH`) |

세 건 다 **`outputs-dont-reach-consumers`** 패턴 — 기능은 있는데 출력이 소비처에 도달 안 함.
감사할 때는 **생산 → 저장 → 소비** 3단을 전부 확인할 것.

---

## 9. 로컬 실행 (함정 3개)

```bash
python scripts/run_analyze_local.py <video> --out <workdir> --genre drama
```

이 러너를 쓸 것. 직접 돌리면 아래를 매번 밟는다:

1. **`.env` 를 bash 로 source 하면 안 된다.** `GOOGLE_APPLICATION_CREDENTIALS=C:\Users\...` 의
   백슬래시를 이스케이프로 먹어 `C:Users...` 가 된다 → Vertex 전멸 → refine 이 원문만 남기고 실패.
2. **venv 를 골라야 한다.** `core/.venv`(3.11)에는 `faster_whisper`·`torch` 가 없다.
   `STT_PROVIDER=hybrid|whisper` 는 **`core/.venv310`**(3.10 · GPU).
3. **환경변수를 안 넘기면 비싼 체크포인트가 날아간다.** `apps/server/.env` 의 `STT_PROVIDER=hybrid`
   가 없으면 기본값 `gemini` 로 지문이 어긋난다.

러너는 자격증명 파일 존재를 **실행 전에** 확인한다 — STT 비용 다 쓰고 죽는 걸 막는다.

검토 뷰어:

```bash
python scripts/make_review_viewer.py <workdir> <video> [out.html]
```

---

## 10. 환경 스위치

| env | default | 효과 |
|---|---|---|
| `STT_PROVIDER` | `gemini` (코드) / `hybrid` (apps/server/.env) | `whisper`=로컬 GPU · `hybrid`=whisper+Soniox |
| `MIN_BEAT_SEC` | `6` | beat 길이 하한 (예외 없는 강제) |
| `BEAT_ANNOT_CTX` | `1` | `0` = 맥락 누적 끄기 |
| `BEAT_ANNOT_CTX_RECENT` | `12` | 요약까지 붙일 블록 크기 (캐시 접두 안정성과 직결) |
| `EMBED_BATCH` | `200` | Vertex 임베딩 1회 instance 수 (상한 250) |
| `RUN_CHYRON_PER_SEG` | `1` | `0` = chyron 스킵 |
| `RUN_FACES` | 미설정 | `1` = 얼굴 스테이지 |
| `RUN_REFINE` | 미설정 | `0` = 정제 스킵 |
| `RUN_PPL` | **off** | `1` = PPL 검출 (과다검출 + 시간 절반) |
| `AUTO_THUMBNAIL` | 미설정 | `1` = 파이프라인 자동 썸네일 |
| `AUTO_GEBD` | 미설정 | `1` + `GCS_BUCKET` = gebd.detect 자동 큐잉 |
| `RECOMMEND_MODE` | `narrative_first` | 추천 모드 |

---

## 11. 실측 비용·시간 (드라마 58.6분 · 2026-08-07)

| 단계 | 시간 | API 비용 |
|---|---|---|
| GEBD 경계 (로컬 GPU) | 371초 | **₩0** |
| STT (whisper large-v3 · CUDA) | 351초 | **₩0** (로컬) |
| 본 파이프라인 (refine→beats→annot→recommend) | 318초 | ₩154 |
| 검색 인덱싱 (임베딩 227×2) | 29초 | (위에 포함) |
| **합계** | **~18분** | **₩154** |

`STT_PROVIDER=soniox` 를 쓰면 STT 가 API 로 가서 **+₩270** 이 붙는다.
`usage.json` 이 회당 실측을 남긴다 (캐시 토큰 포함).

> 이전 문서의 "회당 ~₩620" 은 Soniox STT + chyron on 기준. 위는 whisper 로컬 + chyron off 기준이다.

---

## 12. 알려진 사각지대

- **인물이 전부 익명** — `cast_registry` 없으면 `발화자 N` / `S1~SN`. 드라마는 chyron(화면 이름자막)이
  없어 **cast 사전등록이 선행돼야** 실명이 붙는다. 화자도 73명으로 과분할된다.
- **beat_annot 서사 연결 미달** — §5 참조. 라벨 일관성만 개선.
- **`AUTO_GEBD` 미활성** — 프로덕션에서 경계는 여전히 fallback. GEBD 이미지가 Artifact Registry 에
  없다(`Repository "stepd" not found`).
- ~~장르 파라미터 미검증~~ ✅ **2026-08-07 검증됨.** `shots.json` 이 `threshold=0.35 · genre=drama`
  로 찍힌다 — `run_detect_genre`(6.5) 가 scenes·shots 앞에서 장르를 확정하는 배선이 실제로 작동한다.
- **검색 로그 마이그레이션 `0010` 미적용** — `search_events` 없으면 `logSearchEvent` 가 실패를 삼켜
  **검색은 정상인데 로그만 조용히 안 쌓인다.** 확인: `SELECT count(*) FROM search_events;`
- **`signal_score`·`highlight_parts` 가 `search_segments` 테이블에 없음** — segments.json 엔 있는데
  DB 컬럼이 없어 검색 랭킹에서 못 쓴다.
- **action tag 없음** — "23기 영철 스킨십" 류 쿼리는 chyron+action 배선 후.
- **배포는 스텁** — `POST /api/distributions/publish` 는 상태만 기록.
- **GEBD 파인튜닝 보류** — GPU 24GB+ 필요. 단 §7 때문에 **필요성 자체가 재측정 대상**이다.

---

## 관련

- `deploy/gebd/README.md` — GEBD 실행·제약·버그 이력 (§3 필독)
- `docs/plans/gebd-finetune-resume-plan.md` — 파인튜닝 보류·재개 (머리말에 무효 경고)
- `docs/plans/auto-cast-and-action-tags.md` — 검색 강화
- `docs/plans/scene-boundary-model-wire.md` — GEBD 워커 배선
- `docs/plans/step-d-master-build-plan.md` — 설계 정본 (일부 낡음)

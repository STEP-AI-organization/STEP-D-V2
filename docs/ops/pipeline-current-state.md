# STEP D 파이프라인 · 실제 상태 (2026-08-06)

이 문서는 코드 실측 기준. `docs/plans/step-d-master-build-plan.md` 는 설계 정본이지만 낡음.
여기가 지금 실제로 뭐가 도는지의 정본.

## 코드 구조 (2026-08-06 리팩터 후)

`core/analyze.py` 1019줄 → **382줄** 로 정리. 로직 재조직뿐 · 동작 무변경.

| 파일 | 역할 | 크기 |
|---|---|---|
| `core/analyze.py` | 오케스트레이터 (analyze() = 병렬 executor 시작 + 15 스테이지 호출 + 결과 조립) | 382줄 |
| `core/analyze_stages.py` | 15개 스테이지 helper (STT · refine · chyron · faces · PPL · scenes · cast · timeline · narrative · shots · scene_type · beats · beat_annot · speaker · recommend + fast/viewer_signals/search-index/usage) | 782줄 |
| `core/analyze_utils.py` | 체크포인트 · progress · 지문 유틸 (save_json/load_json/prepare_checkpoints/progress) | 137줄 |
| `core/analyze_cli.py` | `python -m core.analyze` CLI (argv 파싱 + 요약 print) | 81줄 |

## 상위 흐름

```
YouTube URL / 업로드
    │
    ▼
POST /api/media/from-youtube  (또는 /api/media/upload-init → finalize)
    │  media 등록 + episode placeholder
    ▼
worker: youtube.download   (yt-dlp → GCS)
    │
    ▼
worker: content.analyze    (core.analyze 스폰)
    │
    ▼
[GEBD 배선됐다면 병렬] gebd.detect  (GEBD VM · Docker · GPU)
    │
    ▼
content_analysis 저장 · search_segments 인덱싱 · 추천 배선
    │
    ▼
편집자 UI → 채택 → clip → (썸네일 on-demand) → 배포
```

## core.analyze 스테이지 (실제 순서 · 리팩터 후 orchestrator)

각 스테이지 = `analyze_stages.py` 의 `run_*` helper 하나. `analyze()` 는 이들을 순차/병렬 호출.

| # | 스테이지 | helper | 도구 | 병렬 | 체크포인트 | 비고 |
|---|---|---|---|---|---|---|
| 0 | STT | `run_stt` | **Soniox** (default) | — | stt.json | ~$0.20/hr · `STT_PROVIDER=whisper` 로컬 GPU 폴백 |
| ‖ | ~~PPL 백그라운드 시작~~ | (analyze.py 인라인) | ffmpeg + Gemini flash | STT 와 병렬 | ppl.json | **2026-08-06 기본 off** (`RUN_PPL=1` 로 복귀). 과다검출 + 파이프라인 시간 절반 소모. 코드는 존치 |
| 1 | faces 백그라운드 시작 | (analyze.py 인라인) | InSightFace | STT 후 백그라운드 | — | `RUN_FACES=1` 활성 시 |
| 2 | viewer_signals | `load_viewer_signals` | Gemini flash | — | viewer_signals.json | comments.json 있을 때만 |
| 3 | fast mode 분기 | `run_fast_mode` | — | — | analysis.json | `--fast` 옵션시 여기서 return |
| 4 | 자막 정제 | `run_refine` | Gemini flash | 8배치 | refined.json | Soniox default = skip · `RUN_REFINE=on` 강제 |
| 5 | chyron per-seg | `run_chyron_per_seg` | Gemini flash Vision | 6 workers | refined.json · **chyron.json** | **`RUN_CHYRON_PER_SEG=0` 로 skip** · Fix 1 진행률로그 배선 · chyron.json = 감지 원본(검색 인물 필터 근거, 2026-08-06 추가) |
| 6 | speaker 후처리 | `run_speaker_postproc` | 규칙 | — | refined.json | 짧은 흡수 · empty 계승 · 접속사 |
| 6.5 | **장르 확정** | `run_detect_genre` | (사람 지정) · 미지정 시 Gemini flash | — | genre.json | **2026-08-06 신설.** 정답은 **사람이 지정한 `program.pipelineGenre`** — 이 스테이지는 미지정일 때의 폴백이다. scenes(청크 180/300s)·shots(임계 0.55/0.35) **앞**이어야 한다. 전엔 recommend(18)에서야 감지해 둘 다 폴백값으로 돌았음 |
| 7 | faces join | (analyze.py 인라인) | 백그라운드 join | — | faces.json | 화자↔얼굴 매핑 (diarization_turns 있을 때) |
| 8 | PPL join | `join_ppl` | 백그라운드 join | — | ppl.json | brand_summary 포함 |
| 9 | 청크 분할 | `run_scenes` | STT gap 기반 | — | scenes.json | 장르별 (variety 180s · drama 300s) |
| 10 | cast timeline | `run_cast_timeline` | Vision 병합 + portraits | — | cast.json | 얼굴 클러스터 → 인물 타임라인 |
| ~~11~~ | ~~timeline blocks~~ | ~~`run_timeline`~~ | ~~Gemini flash~~ | ~~배치~~ | ~~timeline.json~~ | **제거 (2026-08-06 · UI 소비처 0 · narrative 로 충분)** · helper 는 `analyze_stages.py` 에 잔존 |
| 12 | narrative 요약 | `run_narrative` | Gemini flash | 4콜 병렬 | narrative.json | 서사 · 인물 · 갈등 |
| 13 | shot boundary | `run_shot_boundary` | **ffmpeg scene (thr=0.55)** | — | shots.json | ⚠️ 학습 모델 미사용 · GEBD 있으면 boundaries.json 로 교체 |
| 14 | scene_type | `run_scene_type` | Gemini flash Vision | batch | scene_type.json | interview/on_scene/other 분류 |
| 15 | beats | `run_beats` | GEBD or shots+STT gap fallback | — | beats.json · boundaries.json | GEBD 있으면 정밀 · 없으면 fallback |
| 15.5 | **beat 저수준 신호** | `run_beat_signals` | **ffmpeg 오디오 1패스** | — | signals.json (+beats.json 병합) | **2026-08-06 신설 · API ₩0 · 실측 4.5초/32분.** audio_pct·audio_delta·silence_ratio·cut_rate·dialogue_density·speaker_turn_rate. **LLM 쇼츠 선택과 독립인 유일한 축** — `highlight_score` 순환정의를 깨는 재료 |
| 16 | beat annotate | `run_beat_annot` | Gemini Vision + STT | 4 workers | beats.json | title/summary/characters |
| 17 | speaker identity | `run_speaker_identity` | 규칙 후처리 | — | speaker_identity_map.json | S1~SN 익명 · chyron 없으면 실명 미확정 |
| 18 | shorts recommend | `run_recommend` | Gemini flash | 4 시나리오 병렬 | shorts.json | beat 조합 기반 (narrative_first default). **2026-08-06: LLM 은 조합·제목·훅자막만, `score100`·순위는 `_deterministic_score`(signals·hook·길이·완결성)가 계산** — LLM 점수는 실행마다 달라져 A/B 판정이 불가능해서 |
| 19 | analysis.json 저장 | (analyze.py 인라인) | — | — | analysis.json | 최종 result 조립 |
| 20 | search 인덱싱 | `index_search_segments` | Vertex **text-multilingual-embedding-002**(768d) | — | segments.json | 자연어 검색 준비 · 회당 ~₩10 · pgvector 적재는 `content-pipeline.ts:1103`(서버) |
| 21 | 썸네일 gen (외부) | `content-pipeline.ts` | Gemini gemini-3-pro-image | — | thumbnails/ | **AUTO_THUMBNAIL=1 없으면 skip** (2026-08-06 · 회당 ₩500 절감) |
| 22 | usage dump | `dump_usage` | Gemini usage_metadata 누적 | — | usage.json | 회당 토큰·₩ (2026-08-06 신설). ⚠️ 집계는 `retry.call_with_retry` 안에만 있다 — **Gemini 콜을 직접 호출하면 비용이 통째로 누락된다.** 2026-08-06 `beat_annot`·`names`·`portraits` 누락 수리 |

## 잡 종류 (worker.ts)

- `youtube.download` — yt-dlp → GCS
- `content.analyze` — core.analyze 실행 · **maxAttempts=2** (2026-08-06 재시도 폭탄 방지)
- `gebd.detect` — GEBD VM Docker · boundaries.json 생성 후 content.analyze 재큐
- `channel.analyze` — 채널 동기화 + 애널리틱스
- `video.analyze` / `video.hotwatch` / `video.comments` — 영상별 지표
- `distribution.publish` — 배포 (⚠️ **스텁** · 상태만 기록 · 실 송출 X)
- `match.align` / `match.segment` / `match.learn` — Lab (숏폼↔롱폼 매칭)

## 환경 스위치 (핵심만)

| env | default | 효과 |
|---|---|---|
| `STT_PROVIDER` | `soniox` | `whisper` = 로컬 GPU · `hybrid` = 양방향 |
| `RUN_CHYRON_PER_SEG` | `1` (스킵 안 함) | `0` = chyron 스킵 (실측·개발 우회) |
| `RUN_FACES` | 미설정 | `1` = 얼굴 스테이지 활성 |
| `RUN_REFINE` | 미설정 | `0` = 정제 스킵 |
| **`RUN_PPL`** | **`0` (off)** | **`1` = PPL 검출 활성.** 2026-08-06 기본 off — 과다검출 + 시간 절반. 켜면 `rights.ppl` 마킹도 함께 살아난다 |
| `AUTO_THUMBNAIL` | 미설정 | `1` = 파이프라인에서 자동 썸네일 gen (default off = editor-trigger) |
| `AUTO_GEBD` | 미설정 | `1` + `GCS_BUCKET` = gebd.detect 자동 큐잉 |
| `CORE_ANALYZE_FAST` | `0` | `1` = 빠른 모드 (비전 스킵 · 자막만) |

## 실측 비용 (60분 회차 · 2026-08-06 정정)

| 스테이지 | 회당 | 비고 |
|---|---|---|
| STT (Soniox) | ~₩270 | duration billed |
| refine | ~₩30 | 8~13 batch |
| PPL frame pair | ~₩30 | Vision ~120콜 |
| chyron per-seg | ~₩150 (배치화 후 ~₩50) | RUN_CHYRON_PER_SEG=0 이면 ₩0 |
| beat annotate | ~₩45 | 298 세그 Vision |
| beats gen | ~₩5 | |
| shorts propose+select | ~₩80 | |
| segments 임베딩 | ~₩10 | text-emb-004 |
| 썸네일 (AUTO off) | ₩0 | on-demand 시 variant N × ~₩50 |
| **합계 (chyron on · 썸네일 off)** | **~₩620** | ₩1000 이내 안전 |
| **합계 (chyron+썸네일 on)** | **~₩1100** | 오버 · 이래서 썸네일 on-demand 로 뺌 |

usage.json 이 회당 실측 데이터 수집 · 위 수치는 대략치 · 청구서 대조 후 갱신 필요.

> ⚠️ **2026-08-06 이전 usage.json 은 과소집계다.** `beat_annot`(회당 최대 콜 소비처)·`names`·
> `portraits` 가 `call_with_retry` 를 안 거쳐 집계에서 빠져 있었다. 58.6분 드라마 실측에서
> 실제로는 beat_annot 239콜 + scene_type 178 shot 을 돌았는데 usage.json 은 **35콜 ₩27** 만
> 보고했다. 수리 후 회차부터 신뢰 가능.

## 알려진 사각지대

- **shot boundary 학습모델 미사용** — 지금 ffmpeg scene 필터만. GEBD 있으면 교체되지만 자동
  트리거 배선 최근 (`AUTO_GEBD=1`). 미활성 상태이 default.
- **장르 파라미터 — 고쳤으나 미검증(2026-08-06).** `run_detect_genre` 신설로 scenes·shots 가
  실제 장르를 받는다. **재분석해야 반영되고, 효과 확인도 재분석 1회(≈₩620·~19분)가 든다.**
  확인 지점: `shots.json` 의 `threshold` 가 드라마에서 0.35 로 찍히는지 · `genre.json` 생성 여부.
- ~~**chyron per-seg 성능** — 회당 시간 병목.~~ ✅ **2026-08-06 해소.** 원인은 API 가 아니라
  **ffmpeg 시킹 방향**이었다. `_extract_at` 이 `-ss` 를 `-i` 뒤에 둬서 매 프레임 추출마다 0초부터
  전부 디코드했다. `-ss` 를 앞으로 옮김 → **83.2초 → 0.149초 (558배)**, 프레임은 바이트 동일.
  662 세그 실측: 10분 초과(타임아웃) → **약 6.2분**. 배치화(Fix 2)는 시간 근거가 사라져 우선순위 하향.
- **speaker 실명 부여** — chyron 없으면 S1~SN 익명. 검색·추천에 실명이 없음.
  자동 cast 발견은 `docs/plans/auto-cast-and-action-tags.md` 참고.
- **action tag** — 아직 없음. 검색 "23기 영철 스킨십" 같은 쿼리는 chyron+action 배선 후.
- **재시도 시 PPL 캐시 미활용** — 로컬 실측에서 관찰. workdir checkpoint 재사용은 refined 만.
  ppl_frames 는 매번 다시 뽑음. 개선 여지.
- **배포는 스텁** — CLAUDE.md 이미 명시.
- **검색 로그 — 배선됨(2026-08-06), 단 마이그레이션 `0010` 적용 필요.** `search_events` 테이블이
  없으면 `logSearchEvent`가 실패를 삼켜 **검색은 정상이고 로그만 조용히 안 쌓인다.**
  적용 확인: `SELECT count(*) FROM search_events;`

## 관련

- `docs/plans/chyron-per-seg-hardening.md` — chyron 3단 fix
- `docs/plans/scene-boundary-model-wire.md` — GEBD 배선 이번 세션
- `docs/plans/auto-cast-and-action-tags.md` — 검색 강화
- `docs/plans/factory-api-plan.md` — Factory API 외부 노출
- `docs/plans/step-d-master-build-plan.md` — 설계 정본 (일부 낡음)
- [[pipeline-chunked-parallel]] — 재구성 배경 (2026-07-22)

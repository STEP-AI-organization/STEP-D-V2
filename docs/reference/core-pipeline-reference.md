# core/ 파이썬 AI 파이프라인 레퍼런스

> 2026-07-16 신규 작성. 리포 루트 `core/`는 업로드 영상 하나를 받아 자막·장면·쇼츠 추천을 뽑는
> 콘텐츠 분석 파이프라인(파이썬)이다. 전 단계가 **Gemini(Vertex AI) + ffmpeg + scenedetect**로
> 도는 GPU-free 구성이며, 인증은 ADC(`gcloud auth application-default login`) — API 키 없음.
> 서버 접점은 워커의 `content.analyze` 잡(`apps/server/src/content-pipeline.ts`).
> 운영 배포 이력은 [../ops/content-pipeline-prod.md](../ops/content-pipeline-prod.md), 큐/워커 구조는 [../ops/worker-queue.md](../ops/worker-queue.md) 참고.

## 1. 오케스트레이션 — `python -m core.analyze`

프로덕션 진입점은 `core/analyze.py` 하나다. 6단계를 순서대로 실행하고 결과를 `analysis.json` 한 파일로 쓴다.

```powershell
core/.venv310/Scripts/python -m core.analyze <video> --out <dir> [--shorts N]
# --out 생략 시 영상이 있는 폴더에, --shorts 기본 5
```

| 단계 | 모듈 | 하는 일 | 입력 → 출력 |
|------|------|---------|-------------|
| 1. STT | `asr.py` | 음성 인식 (provider 스위치, §3) | 영상 → `[{start,end,text,words}]` 세그먼트 |
| 2. 자막 정제 | `refine.py` | Gemini로 오타·반복·말더듬 정리. 40줄 배치, 타임스탬프는 입력과 1:1 보존, 요약·의역 금지. `core/glossary.json`(오인식→정답 사전) 강제 적용. 배치 실패 시 원문 유지 | 세그먼트 → 정제 세그먼트(= `transcript`) |
| 3. 장면 분할+프레임 | `scenes.py` | scenedetect `ContentDetector(threshold=27)`로 샷 경계 분할(컷 미검출 시 전체 1장면), 장면 중간 지점 JPEG 프레임 추출(ffmpeg), 겹치는 STT 대사 첨부. 무음 장면은 `has_dialogue: false`로 살아남음 | 영상+정제 세그먼트 → 장면 배열 + `scene_frames/scene_NNNN.jpg` |
| 4. 시각 채점 | `vision.py` | 대표 프레임을 Gemini Vision으로 숏폼 가치 채점(대사 무관·시각만). 동시 6워커 | 장면 → `vision_score(0-100)`/`vision_reason`/`vision_tags` 필드 추가 |
| 5. 이름자막 | `names.py` | 프레임에 번인된 화면 텍스트 OCR — 인물 이름자막과 기타 자막 분리 | 장면 → `on_screen_names`/`on_screen_text` 필드 추가 |
| 6. 쇼츠 추천 | `recommend.py` | 장면별 분석 타임라인(화면분석+대사+인물+시각점수)을 Gemini 추론 1콜에 넣어 훅→펀치라인 완결 구간 선정. 15~60초 권장 | 장면 → `shorts` 배열 |

각 단계 모듈의 Gemini 설정 공통값: `GOOGLE_CLOUD_PROJECT`(기본 `step-d`) / `VERTEX_LOCATION`(기본
`asia-northeast3`, 서울 — 음성·프레임은 개인정보라 국내 처리) / `GEMINI_MODEL`(기본 `gemini-2.5-flash`).

## 2. 출력 스키마 — `analysis.json`

`analyze.py`가 `<out>/analysis.json`에 쓰는 최상위 구조 (`analyze.py:67-75`):

```jsonc
{
  "video": "…/source.mp4",       // 입력 경로
  "duration": 1234.5,            // 마지막 장면(없으면 마지막 자막)의 end
  "transcript": [                 // 정제 세그먼트 (refine 결과)
    { "start": 0.0, "end": 3.2, "text": "…", "words": [] }
  ],
  "scenes": [                     // 장면 타임라인 (scenes→vision→names 누적)
    { "index": 1, "start": 0.0, "end": 8.4, "duration": 8.4,
      "text": "겹치는 대사…", "has_dialogue": true,
      "frame": "scene_frames/scene_0001.jpg",   // 실패 시 null
      "vision_score": 85, "vision_reason": "…", "vision_tags": ["리액션"],
      "on_screen_names": ["이름"], "on_screen_text": ["상황 자막"] }
  ],
  "shorts": [                     // 쇼츠 추천 (recommend 결과)
    { "rank": 1, "start": 120.0, "end": 155.0, "title": "…", "reason": "…",
      "scene_from": 14, "scene_to": 17, "tags": ["폭소"] }   // scene_*/tags는 선택 필드
  ],
  "took_sec": 512.3
}
```

- `words`: Gemini STT는 발화 단위 타임스탬프만 주므로 빈 배열. whisper provider일 때만 단어별 `{word,start,end,probability}`가 채워진다.
- 프레임 경로는 out 디렉토리 기준 상대경로(`scene_frames/…`).

## 3. STT provider 스위치 — `STT_PROVIDER`

`asr.py`의 `transcribe()` 뒤에 provider 2개가 같은 형태(`{segments, language}`)로 교체 가능하다.

**`gemini` (기본, 프로덕션)** — 관리형·GPU 불필요. Vertex AI `asia-northeast3`(서울)에서
`gemini-2.5-flash`로 전사. ffmpeg으로 16kHz mono WAV 추출 후 90초 창(`STT_WINDOW_SEC`)으로 잘라
6병렬(`STT_WORKERS`) 호출 — 창 단위라 타임스탬프가 정확하고 JSON 출력이 토큰 예산 안에 든다.
출력 넘침(truncation) 시 창을 반으로 쪼개 2단계까지 재시도. `thinking_budget=0`으로 출력 예산 전부를
JSON에 사용. 모델은 `GEMINI_STT_MODEL`로 별도 오버라이드 가능.
(선정 사유: 관리형 Google STT는 예능 클립에서 "정우성"→"정구속"으로 뭉갰지만 Gemini·whisper는 보존 — `asr.py` 도크스트링.)

**`whisper` (로컬 GPU, 개발용)** — faster-whisper `large-v3`, CUDA float16 기본(CPU면 int8 강등).
`word_timestamps` + VAD 필터(무음 500ms) + `condition_on_previous_text=False`로 환각·반복 억제.
지연 import라 GPU 없는 워커 VM에는 설치조차 안 되어 있다.
⚠️ 로컬 GPU 경로는 PIL·cuDNN 버전 함정이 있어(과거 로컬 검증에서 확인) **프로덕션 기본이 아니다** — 서버가 스폰할 때도 `STT_PROVIDER`를 지정하지 않으면 gemini다.

## 4. 서버 접점 — `content.analyze` 잡

업로드 완료 시 서버(`index.ts` `buildEpisodeAndMedia`)가 `content_analysis` 행을 pending으로 만들고
`content.analyze` 잡을 enqueue(dedupeKey `content.analyze:<mediaId>`) → **워커 VM**(`worker.ts:112`)이
`content-pipeline.ts`의 `runContentAnalyze(mediaId)`를 실행한다:

1. 미디어를 GCS/로컬 저장소에서 임시 폴더(`os.tmpdir()/stepd-content-<id>-…`)로 다운로드
2. `CORE_PYTHON -u -m core.analyze <video> --out <임시폴더>`를 스폰 (cwd=리포 루트, `STT_PROVIDER`·`GOOGLE_CLOUD_PROJECT`·`VERTEX_LOCATION` 전달)
3. `analysis.json`을 읽어 `content_analysis` 테이블(JSONB, `db-pg.ts:215` — schema.sql에는 없고 코드 생성)에 저장. **scene_frames는 v1에서는 임시 폴더와 함께 폐기**(프레임 호스팅은 추후)
4. `shorts`를 회차 추천 보드의 recommendation 엔티티로 기록 — 재실행 시 기존 추천을 지우고 교체(멱등), `rank 1 → appeal 5` 매핑, `kind: "short"`
5. 회차 `pipeline` 상태 갱신(성공: recommend/done, 실패: analyze/error + `content_analysis.error` 기록), finally에서 임시 폴더 삭제

환경변수: `CORE_PYTHON`(파이썬 실행 파일 — 기본 `core/.venv310/Scripts/python.exe`(Windows 로컬),
워커 VM에서는 `core/.venv/bin/python` 지정). 결과 조회는 `GET /api/media/:id/analysis`(없으면 404 `{status:"none"}`).

## 5. 로컬 디버깅 — 단독 실행

전체 파이프라인 1방(`core/analysis.json` + `core/scene_frames/` 생성):

```powershell
core/.venv310/Scripts/python -m core.analyze core/영상.mp4 --out core
```

단계별 단독 실행(각 모듈이 CLI를 가짐 — `asr.py`는 라이브러리 전용, 단독 CLI 없음):

```powershell
python -m core.refine    core/pipeline_output.json            # → refined_segments.json + refined_transcript.srt
python -m core.scenes    core/영상.mp4 --transcript core/refined_segments.json [--threshold 27]  # → scenes.json + scene_frames/
python -m core.vision    core/scenes.json [--limit 10]        # scenes.json에 vision_* 필드 in-place 기록
python -m core.names     core/scenes.json [--limit 15]        # scenes.json에 on_screen_* 필드 in-place 기록
python -m core.recommend core/scenes.json [--n 8]             # → shorts.json
```

- 원시 STT 산출물 `pipeline_output.json`을 쓰던 구 `core.pipeline` 모듈은 **제거됨** — `core/`에 남은 파일은 보존된 샘플 산출물이다.
- Windows 콘솔 cp949 크래시 방지를 위해 전 모듈이 stdout/stderr를 UTF-8로 재설정한다.

## 6. admin Lab — 분석 결과 검수

루트 `admin/index.html`(정적 프론트) + 서버의 lab 라우트(`index.ts:1193-1287`)로 파이프라인 산출물을
브라우저에서 검수한다. 서버를 띄우고 `http://localhost:<PORT>/lab` 접속.

| 라우트 | 내용 |
|--------|------|
| `GET /lab` | `admin/index.html` 서빙 (로컬 편의) |
| `GET /api/lab/data` | 통합 페이로드: 원본/정제 자막 + 장면 + 쇼츠 + 통계 |
| `GET /api/lab/frames/:name` | `scene_frames/` JPEG (경로탈출 가드) |
| `GET /api/lab/video` | 원본 영상 Range 스트리밍 (`<video>` 시킹 지원) |

- 읽는 위치는 `CORE_DIR` env(기본 리포 루트 `core/`) — **로컬 개발용 심(shim)**이다. 운영에서는 워커가 만든 결과가 DB/GCS에 있으므로 이 라우트를 그쪽으로 교체할 예정.
- ⚠️ lab은 `analysis.json`이 아니라 **단계별 파일**(`pipeline_output.json`·`refined_segments.json`·`scenes.json`·`shorts.json`)을 읽는다. `core.analyze`는 이 파일들을 만들지 않으므로, lab에서 새 결과를 보려면 §5의 단계별 CLI로 갱신해야 한다.
- 자세한 실행 절차는 [admin/README.md](../../admin/README.md).

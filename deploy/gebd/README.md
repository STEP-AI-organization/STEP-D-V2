# GEBD — 장면 전환 학습모델 배선

**뭐가 어디 있는지** 한 장에 정리. 2026-08-06 기준.

GEBD = Generic Event Boundary Detection. NIA "비디오 전환 경계 추론" 과제의 참조구현(Kotechnia)
으로, 영상에서 **이벤트 경계(장면 전환)** 를 찾아낸다. STEP-D 는 이 경계를 **beat**(편집 단위)의
기반으로 쓴다 — beat 이 정확해야 쇼츠 구간·검색 단위·하이라이트가 다 정확해진다.

---

## 1. 파일이 어디 있나

| 무엇 | 위치 | 크기 | git |
|---|---|---|---|
| **실행 래퍼** | `deploy/gebd/run-local.sh` | — | ✅ 커밋 |
| **참조구현 소스** | `deploy/gebd/prepare/` · `deploy/gebd/cla/` | 97K | ✅ 커밋 |
| **실행 스크립트** | `deploy/gebd/scripts/` (`run_long_v3.sh`·`infer_batch.py`) | — | ✅ 커밋 |
| **자체 빌드 Dockerfile** | `deploy/gebd/Dockerfile` | — | ✅ 커밋 (대안 · §5) |
| **모델 가중치** | `~/stepd-models/gebd/model_cla_f_0_s_-1_7728.pt` | **1.5 GB** | ❌ 리포 밖 |
| **도커 이미지 tar** | `Downloads/비디오 전환 경계 추론 데이터/5.도커이미지/` | **26.9 GB** | ❌ 리포 밖 |
| 원본 패키지 전체 | `Downloads/비디오 전환 경계 추론 데이터/` | 43 GB | ❌ 리포 밖 |
| 실험 산출물 | `tmp/gebd/` | 2.5 GB | ❌ `.gitignore` |

> ⚠️ **`.gitignore` 에 `/tmp/` 와 `*.pt`·`*.tar` 를 2026-08-06 에 추가했다.** 그 전까지
> `tmp/gebd/`(2.5GB, 가중치 포함)가 커밋 대상이었다. 대용량 바이너리를 리포에 넣지 말 것.

---

## 2. 실행

```bash
# 1) 이미지 로드 (최초 1회 · ~15~25분)
docker load -i "$HOME/Downloads/비디오 전환 경계 추론 데이터/5.도커이미지/event-boundary-detection.tar"

# 2) 가중치 배치 (최초 1회)
mkdir -p ~/stepd-models/gebd
cp "$HOME/Downloads/비디오 전환 경계 추론 데이터/2.학습모델파일/model_cla_f_0_s_-1_7728.pt" ~/stepd-models/gebd/

# 3) 실행 — 영상 1개 → boundaries.json
bash deploy/gebd/run-local.sh <video.mp4> <out_dir> [CHUNK_SEC=60] [CORES=2]
```

산출물을 분석 워크디렉토리에 넣으면 다음 `core.analyze` 가 자동으로 쓴다:

```bash
cp <out_dir>/boundaries.json tmp/<workdir>/boundaries.json
# beats.json 지문에 boundaries 해시가 들어 있어 beats·signals·shorts 만 재생성된다
# (STT·refine·narrative 는 보존 → 재실행 비용 ₩270 이 아니라 beats 이후만)
```

**환경변수**: `GEBD_MODEL`(가중치 경로) · `GEBD_IMAGE`(이미지 태그, 기본 `event-boundary-detection:latest`)

> ⚠️ **Git Bash 함정**: `docker run` 에 `MSYS_NO_PATHCONV=1` 이 없으면 MSYS 가 컨테이너 내부
> 경로 `/gebd/...` 를 호스트 경로로 번역해 `C:/Program Files/Git/gebd/...` 를 넘긴다.
> 그리고 `-v` 의 호스트 쪽은 반대로 **Windows 절대경로**(`pwd -W`)여야 한다 — Git Bash 의
> `/c/...` 는 Docker 가 못 알아본다. `run-local.sh` 가 둘 다 처리한다.

---

## 3. 실측 제약 (여기서 막힌다)

| 제약 | 값 | 이유 |
|---|---|---|
| `CHUNK_SEC` | **60** | 참조구현이 5분 하드코드 — 더 길면 뒤가 잘린다 |
| `CORES` | **2** (RTX 3060 Ti) | 4는 VRAM 91%로 렉 |
| 코덱 | **h264** | AV1 은 못 읽는다 → 먼저 변환 |
| 학습샘플 길이 | 최대 300초 | `FEATURE_LEN=300`·`TIME_UNIT=1` 코드 고정 |

---

## 4. 파이프라인 3단

```
A. ffmpeg     영상 → 60초 청크 (stream copy)          빠름
B. mmaction2  TSN clip feature 추출                    GPU · 이미지가 필요한 이유
C. SJNET      cla/ 로 boundary 추론 → boundaries.json  모델 가중치
```

출력이 `core/boundaries.py` 스키마와 그대로 맞는다:

```json
{"source":"gebd", "boundaries":[{"t":57.0,"score":0.42,"kind":"...","source":"gebd"}]}
```

**score 임계값도 일치한다** — runner 가 hard=0.35/soft=0.18 로 집계하고,
`boundaries.py` 의 `GRADE_HARD_SCORE=0.35`·`GRADE_SOFT_SCORE=0.18` 과 같다.

> **이게 GEBD 를 붙이는 핵심 이유다.** 지금 fallback 은 `boundaries.py:200` 이 전부 `hard` 로
> 강제해서(실측: 드라마 346/346 hard, soft 0) **continuity gate 가 통째로 무력화**돼 있다
> (`beats.py:1029` 는 soft 만 강등한다). GEBD 가 붙으면 soft 등급이 생겨 gate 가 살아나고,
> **beat 분포가 눈에 띄게 바뀐다.** 그래서 배선은 단독 배포하고 전후를 측정해야 한다.

---

## 5. Dockerfile 은 왜 있나 (대안)

원본 tar(26.9GB)를 못 쓰는 환경을 위해 `deploy/gebd/Dockerfile` 로 같은 스택을 재현할 수 있다.
**단 버전이 전부 고정이다** — `torch==1.8.1+cu111` 위에서만 도는 `mmcv 1.x`/`mmaction2 0.x` 조합이고,
mmaction2 1.x 는 mmengine 기반 재작성이라 `tools/misc/clip_feature_extraction.py` 와 TSN config 가
아예 없다. **올리지 말 것.**

기본은 원본 tar 로드다 — 개발 당시 환경 그대로라 버전 불일치 위험이 없다.

---

## 6. 프로덕션 배선 (코드는 준비됨 · 아직 안 켬)

```
content.analyze  →  AUTO_GEBD=1 + GCS_BUCKET 이면 gebd.detect 큐잉 (non-blocking)
gebd.detect      →  GPU VM lane (WORKER_JOBS=gebd) · Docker · gsutil 왕복
                 →  boundaries.json 을 GCS workdir 에 업로드 → content.analyze 재큐
```

- `apps/server/src/worker.ts::handleGebdDetect` — 핸들러
- `apps/server/src/content-pipeline.ts:915` — 자동 트리거
- `GEBD_IMAGE` 기본값이 Artifact Registry 를 가리키는데 **그 저장소는 아직 없다**
  (`Repository "stepd" not found`) — 프로덕션에서 켜려면 이미지를 먼저 푸시해야 한다

**지금은 로컬 우선이라 켜지 않는다.**

---

## 7. 학습(재훈련)은 지금 못 한다

`STEPD_학습데이터_스키마_및_생성가이드.md` 기준으로 학습 입력은 2개다:

1. 1초 단위 TSN feature pickle — 자동 (GPU)
2. **전환 경계 timestamp annotation — 사람이 1초 해상도로 찍어야 함**

그런데 **원본 패키지에 학습 데이터가 없다.** `all_data.json`·`dataset_split_list.json`·`*.pkl`
전부 0건이고 `data/dump` 는 0바이트다. 온 건 학습된 모델(1.5GB)뿐이다.

즉 재훈련하려면 라벨을 처음부터 만들어야 한다 — 300초 클립 하나당 300 라벨, 58.6분 회차면
12클립 = 3,600 라벨이다. **먼저 지금 모델이 우리 콘텐츠에서 뭘 못 하는지 측정하고**,
틀리는 유형만 골라 라벨링하는 게 맞다. 무작정 전체를 찍으면 사람 시간이 대량으로 낭비된다.

---

## 관련

- `docs/plans/scene-boundary-model-wire.md` — 워커 배선 계획·재실행 이중지출 방지
- `core/boundaries.py` — boundaries.json 소비 (`load_boundaries`·`dedup_boundaries`·`_grade`)
- `core/beats.py::build_beats_from_boundaries` — 경계 → beat
- `Downloads/비디오 전환 경계 추론 데이터/STEPD_학습데이터_스키마_및_생성가이드.md` — 학습 스키마

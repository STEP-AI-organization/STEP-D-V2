# GEBD 파인튜닝 — 보류 및 재개 계획

> 2026-08-06 작성 · **보류 결정**: 학습에 필요한 GPU가 없어 중단. 예산 확보 후 재개.
> 배선·데이터·도구는 전부 준비돼 있고 **학습만 남았다.** 이 문서 하나로 재개 가능하게 적는다.

---

> # ⚠️ 2026-08-07 · §1 의 근거는 무효다 (§2 이하는 유효)
>
> §1 의 실측 근거 전체 — 판정 분포(리버스샷 49%·오탐 29%·씬전환 20%), 모델 score 역상관,
> 규칙 F1 0.42/0.55 vs score 0.33 — 은 **경계 시각이 통째로 어긋난 상태**에서 매긴 것이다.
> 배선 버그 3개가 겹쳐 경계가 각 60초 청크의 앞 11.4초로 압축돼 있었고(타임라인 81% 탐지 불가),
> 라벨링 UI 가 보여준 프레임이 그 경계의 실제 시각이 아니었다.
> 원인·수정 상세: `deploy/gebd/README.md` §3.
>
> **수정 후 5분 클립 실측: 최근접 실제 컷까지 중앙 0.445초** — 1초 양자화의 하한이 0.5초이므로
> 모델은 **표현 가능한 한계까지 정확**했다. 망가진 건 모델이 아니라 배선이었다.
>
> 따라서 **파인튜닝이 필요한지 자체가 재측정 대상**이다. 예산을 쓰기 전에 반드시:
> 1. 수정된 배선으로 회차 재추출 (`CHUNK_SEC=300` · 1행/초 확인)
> 2. 새 경계로 라벨 재작성 (기존 132개는 폐기 — 원본 JSON 에 `INVALID` 표시해 둠)
> 3. 그래도 못 맞히는 유형이 남는지 확인
>
> §6(파인튜닝 없이 되는 개선)의 1·2번도 같은 이유로 근거가 없어졌다 — 재측정 후 다시 판단할 것.

---

## 1. 왜 파인튜닝이 필요한가 (실측 근거) — ⚠️ 위 경고 참조, 이 절은 무효

기존 모델(`model_cla_f_0_s_-1_7728.pt`, NIA 참조구현)을 드라마 1회차(58.6분)에 돌리고
**경계 132개를 전량 사람 판정**한 결과다. 감(感)이 아니라 수치다.

### ① 판정 분포 — 쓸 수 있는 경계가 20%뿐

| 판정 | 개수 | 비율 |
|---|---|---|
| 같은 씬 컷 (리버스샷 등) | 65 | **49%** |
| 오탐 | 38 | **29%** |
| 씬전환 컷 | 27 | 20% |
| 컷 없는 행동전환 | **0** | 0% |
| 보류 | 2 | 2% |

- **리버스샷이 절반**이다. 컷은 맞지만 씬 경계가 아니라, beat 을 여기서 끊으면 대화가 조각난다
- **`change_of_action` 이 0건** — 이 모델은 사실상 컷 검출기다. "카메라는 그대로인데 상황이 바뀌는
  지점"을 못 잡는다. 그게 원래 기대했던 고유 가치였다

### ② 모델 score 가 씬경계와 **역상관**이다 ← 가장 중요

| score 구간 | n | 씬경계 비율 |
|---|---|---|
| 0.00–0.20 | 20 | **25%** |
| 0.20–0.40 | 22 | 23% |
| 0.40–0.60 | 28 | 21% |
| 0.60–0.80 | 44 | 18% |
| 0.80–1.00 | 18 | **17%** |

score 가 높을수록 씬경계 비율이 **낮다**. 무상관도 아니고 약한 역상관이다.

- score 0.94·0.92·0.87·0.86·0.85 **5건이 전부 오탐**(같은 앵글 클로즈업)
- score 0.0·0.02·0.16 **4건이 실제 씬전환**인데 `noise` 로 폐기됨

즉 `core/boundaries.py` 의 `GRADE_HARD_SCORE=0.35` · `GRADE_SOFT_SCORE=0.18` 필터는
**아무 의미가 없다.** 지금 파이프라인이 이 값으로 hard/soft/noise 를 나누는데 실제와 무관하다.

### ③ 규칙으로는 안 갈린다 (그래서 학습이 필요하다)

정답 132개에 대해 프레임 특징으로 분리를 시도했다:

| 방법 | F1 | 정밀 | 재현 |
|---|---|---|---|
| 색조 유사도 → 씬전환 vs 리버스샷 | 0.42 | 0.40 | 0.44 |
| 픽셀 변화량 → 오탐 제거 | 0.55 | 0.44 | 0.74 |
| **(현재) 모델 score** | **0.33** | 0.21 | 0.89 |

분포는 방향이 맞다(오탐은 색조 0.949·픽셀 0.031 / 씬전환은 색조 0.768). 하지만 겹치는 구간이
넓어 임계값으로는 못 나눈다. **2차원으로 부족한 신호가 2048차원 TSN feature 에는 있을 것**이고,
그게 학습으로 뽑아야 하는 이유다.

> 단순 픽셀 규칙(F1 0.55)이 모델 score(0.33)보다 낫다는 것도 기록해 둔다.
> **파인튜닝 전이라도 `GRADE_*` 임계값은 재검토할 값어치가 있다.**

### ④ 헤드룸이 있다

파일명이 말해준다 — `model_cla_f_0_s_-1_**7728**.pt` = validation F1 **0.7728**.
`config.py` 의 `GOAL_SCORE = 0.815` 에 **도달하지 못하고 early stopping(patience 20)으로 멈췄다.**

---

## 2. 막힌 것 — GPU 하나뿐이다

| | 상태 |
|---|---|
| 파이프라인 배선 | ✅ 완료 (§4) |
| 학습 데이터 | ✅ 확보 가능 (§3) |
| 도구 | ✅ 완성 (§4) |
| **학습 GPU** | ❌ **RTX 3060 Ti 8GB 로는 불가** |

실측: `GEBD_BATCH=1` 에서도 PyTorch 가 `12.90 GiB allocated · 18.45 GiB reserved` 를 보고한다.
8GB 카드에서 이 숫자가 나오는 건 **Windows WDDM 이 초과분을 시스템 RAM 으로 넘기기** 때문이고,
그 경로는 수십~수백 배 느리다. **5분 40초 동안 첫 배치도 못 끝냈다.**

원인은 모델 구조다 — `network.py:pairwise_minus_l2_distance` 가 `[B, 300, 300, D]` 텐서를 만들고
event·shot·whole 3분기 × `CHANNEL_NUM=4` 로 반복된다. batch 1 이 이미 최소값이라 더 줄일 수 없다.

**필요 스펙**: batch 8 기준 **24GB 이상**(L4 / A6000 / A100). batch 2~4 면 16GB 로도 가능할 수 있다.

> **추론은 이 PC 로 충분하다.** 회차당 feature 12.3분 + 추론 33초, GPU 사용률 7~10%
> (병목이 연산이 아니라 1초 조각 3,540개 생성 I/O 다). 역할을 나누면 된다:
> **로컬 = 추론·feature·라벨링 / 클라우드 = 학습만.**

---

## 3. 데이터 현황

원본 영상: `C:\Users\STEPAI05\Downloads\aena-mp4` — **41편 · 74GB · 약 40시간** (전부 h264 1080p)

| | 수치 |
|---|---|
| 300초 학습 샘플 (`FEATURE_LEN=300`) | **약 480개** — 권장 170~310을 넘는다 |
| feature 추출 소요 | 8.4시간 GPU · API ₩0 (실측 0.21분/영상1분) |
| 라벨 완료 | **1편 132경계** (`docs/research/data/gebd/`) |

**남은 병목은 라벨링이다.** 41편이면 약 5,400 경계다. 전량은 비현실적이니
**3~5편(400~700 경계)** 을 라벨링해 AI허브 데이터와 섞는 구성이 현실적이다.

AI허브에 원본 데이터셋이 있고 **이미 라벨이 붙어 있다** — feature 만 뽑으면 바로 쓴다.
우리 라벨은 도메인 적응용이므로 **오버샘플링**해야 한다(그냥 섞으면 AI허브가 압도한다).

---

## 4. 이미 만들어 둔 것 (재개 시 그대로 사용)

```
deploy/gebd/
  README.md              파일 위치·실행법·실측 제약 (여기부터 읽을 것)
  Dockerfile             자체 빌드용(대안). 기본은 원본 tar 로드
  run-local.sh           영상 1편 → boundaries.json
  batch-run.sh           폴더 전체 배치 · **재개 가능** · 경계 개수로 성공 판정
  label-boundaries.py    검수 UI (필름스트립·대사·프레임단위 조정·오탐사유)
  build-dataset.py       라벨+feature → 300초 학습샘플 · --append 로 누적
  prepare/ cla/ scripts/ NIA 참조구현 (+ 아래 수정 포함)
```

### 참조구현에 가한 수정 (전부 이유 주석 있음)

| 파일 | 수정 |
|---|---|
| `cla/main.py` | `GEBD_FINETUNE` — 체크포인트에서 출발 + LR 1e-4→1e-5. **원본은 항상 밑바닥부터 학습**이라 수천 샘플이 필요했다. `device_ids` 재포장(다중 GPU 체크포인트를 1장에서 로드 시 `invalid device ordinal`) |
| `cla/config.py` | `GEBD_BATCH` · `GEBD_WORKERS` env |
| `cla/dataset.py` | numpy 버전 교차 호환 (호스트 2.x pickle ↔ 컨테이너 1.x) |
| `scripts/run_long_v3.sh` | `-write_tmcd 0` — 타임코드 스트림 있는 파일(`clean_*`)이 조용히 0경계로 끝나던 것 |

### 반드시 알아야 할 함정 (다시 밟으면 시간을 통째로 날린다)

1. **`-c copy -segment_time 1` 은 1초로 안 잘린다** — 키프레임에서만 잘려 실측 **초당 0.555행**.
   참조구현은 **1행 = 1초**(`TIME_UNIT=1`)를 전제하고 경계 초를 행 인덱스로 그대로 쓴다.
   게다가 우리 클립(~167행)은 300행 미만이라 `resize` 가 아니라 **`paddingFeature`** 경로를 타서
   뒤가 0으로 채워진다. → `build-dataset.py` 가 **300행으로 리샘플**해 해결. 안 고치면
   경계가 통째로 어긋난 채 학습된다(끝으로 갈수록 130초 이상).
2. **`dataset_split_list.json` 은 fold 중첩 금지** — `dataset.py:145` 가 최상위에서 바로
   `train`/`validation` 을 찾는다.
3. **`-write_tmcd 0`** — `-map 0:v:0` 이나 `-dn` 만으로는 부족하다. mp4 muxer 가 타임코드를 다시 쓴다.
4. **성공 판정을 파일 존재로 하지 말 것** — 실패해도 `boundaries.json` 은 생성되고 안이 비어 있다.
5. **Git Bash 는 `MSYS_NO_PATHCONV=1`** — 없으면 컨테이너 경로 `/gebd/...` 가 호스트 경로로 번역된다.
   `-v` 의 호스트 쪽은 반대로 `pwd -W`(Windows 절대경로)여야 한다.
6. **`-ss` 는 `-i` 앞** — 뒤에 두면 0초부터 전량 디코드(실측 558배).

---

## 5. 재개 절차

```bash
# 0) 준비 (최초 1회)
docker load -i "…/비디오 전환 경계 추론 데이터/5.도커이미지/event-boundary-detection.tar"   # 26.9GB
mkdir -p ~/stepd-models/gebd && cp "…/2.학습모델파일/model_cla_f_0_s_-1_7728.pt" ~/stepd-models/gebd/

# 1) 경계 추출 — 로컬 GPU 로 충분 (재개 가능 · 41편 8~9시간 · ₩0)
bash deploy/gebd/batch-run.sh "C:/Users/STEPAI05/Downloads/aena-mp4" tmp/gebd-batch 60 2

# 2) 라벨링 — 회차당 30~60분 (사람) 또는 프레임 시트로 AI 판정
python deploy/gebd/label-boundaries.py --video <mp4> --boundaries <boundaries.json> \
    --refined <refined.json> --out tmp/gebd-label
#    → 브라우저에서 1~5 키로 판정 → Export JSON

# 3) 데이터셋 조립 (회차마다 --append 로 누적)
python deploy/gebd/build-dataset.py --annotation <labeled.json> \
    --features-dir tmp/gebd-batch/<name>/features_flat --out tmp/gebd-dataset --append

# 4) 학습 — **여기서만 클라우드 GPU 필요**
#    cla/ 와 data/ 를 올리고:
docker run --gpus all -v <dir>:/train -v <models>:/models \
  -e GEBD_FINETUNE=/models/model_cla_f_0_s_-1_7728.pt -e GEBD_BATCH=8 \
  event-boundary-detection:latest bash -lc 'cd /train/cla && python -u main.py'
```

**4단계 직전까지는 전부 이 PC 에서 ₩0 으로 된다.** 데이터가 다 모인 뒤 클라우드 GPU 를
몇 시간만 빌리면 되므로 비용이 작다.

---

## 6. 재개 전에 먼저 볼 것 (파인튜닝 없이 되는 개선)

파인튜닝을 기다리는 동안에도 값어치가 있는 것들이다. 전부 위 §1 실측에서 나왔다.

1. **`GRADE_HARD_SCORE`/`GRADE_SOFT_SCORE` 재검토** — 지금 임계값(0.35/0.18)이
   단순 픽셀 규칙보다 못한 판정을 한다(F1 0.33 vs 0.55). 임계값을 바꾸거나 아예 안 쓰는 게 나을 수 있다
2. **리버스샷 억제** — beat 조립에서 `kind='shot'` 만인 경계를 약하게 취급.
   지금은 리버스샷마다 beat 이 끊겨 대화가 조각난다
3. **`min_beat_sec` 조절** — 큰 beat 을 원하면 6→20~45. 실측표는
   `docs/plans/active/search-highlight-replan-2026-08-06.md` 참고

---

## 관련

- `deploy/gebd/README.md` — 파일 위치·실행·제약 (실무 진입점)
- `docs/research/data/gebd/eb5cd1_verdicts.json` — 판정 132개 원본
- `docs/research/data/gebd/master_2026-06-18_eb5cd1.labeled.json` — NIA 스키마 annotation
- `docs/plans/done/scene-boundary-model-wire.md` — 워커 배선·재실행 이중지출 방지
- `Downloads/비디오 전환 경계 추론 데이터/STEPD_학습데이터_스키마_및_생성가이드.md` — 학습 스키마 원본

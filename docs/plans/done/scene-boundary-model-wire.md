# 장면 전환 모델 (GEBD) 워커 배선

2026-08-06. 지금 파이프라인은 ffmpeg `scene` 필터 (threshold=0.55) + STT gap fallback 만 사용.
학습된 boundary 모델 (GEBD/mmaction2) 은 코드에 존재하나 자동 트리거 안 됨. 이 문서로 배선.

## 이전 상태 (2026-08-06 오전까지)

- `apps/server/src/worker.ts::handleGebdDetect` — GEBD Docker + gsutil + GPU VM 실행 handler **존재**.
- `core/boundaries.py::load_boundaries` — `boundaries.json` 파일이 있으면 GEBD 결과 **소비**.
- `core/analyze.py` — `boundaries.json` 없으면 `build_fallback_boundaries` (shots+STT gap) 로 fallback.
- 문제: `content.analyze` 가 `gebd.detect` 를 **트리거 안 함** → 항상 fallback.
- 결과: 예능 컷 튀는 구간은 잡지만 롱테이크·크로스컷·매치컷 놓침. beats 품질 상한 있음.

## 이번 변경 (2026-08-06)

`apps/server/src/pipeline/content-pipeline.ts::runContentAnalyze` 시작 시 자동 트리거:

```ts
if (process.env.AUTO_GEBD === "1" && process.env.GCS_BUCKET) {
  const boundariesLocal = path.join(work, "boundaries.json");
  if (!fs.existsSync(boundariesLocal)) {
    await enqueue("gebd.detect", { mediaId, videoGcsPath: media.path,
                                    workdirGcsPrefix: `analysis/${mediaId}` },
                  { dedupeKey: `gebd.detect:${mediaId}` });
  }
}
```

- **Blocking 안 함** — 지금 실행은 fallback 로 완주. GEBD 결과는 뒤늦게 도착.
- `handleGebdDetect` 가 완료되면 이미 있는 코드로 `content.analyze` 를 새 dedupeKey 로 재큐 →
  재개 시 boundaries.json 을 소비해 정밀 beats/shorts.
- **로컬 워커에선 skip** (`GCS_BUCKET` 미설정 · gsutil/Docker 없음). 로컬 실측은 여전히 fallback.
- **활성화 스위치** `AUTO_GEBD=1` — 프로덕션 워커 `.env.worker` 에 설정 시 자동. default off (기존 동작 유지).

## 남은 것

### ✅ 재실행 이중지출 방지 — 완료 (2026-08-06 오후)

**배선만으로는 GEBD 가 동작하지 않았다.** `beats.json` 지문
(`analyze_utils.prepare_checkpoints`)이 `BEATS_VER·REFINE_VER·SHOTS_VER·SCENE_TYPE_VER·STT_VER`
로만 계산돼 **`boundaries.json` 이 빠져 있었다**. 그래서 GEBD 가 boundaries 를 얹고
content.analyze 를 재큐해도, 재실행이 **fallback beats 를 그대로 재사용**하고 GEBD 결과를
영영 소비하지 않는다. 배선은 돌고 결과는 안 바뀌는 — 가장 나쁜 종류의 무동작이었다.

수정: `boundaries.json` 해시를 `beats.json`·`signals.json`·`shorts.json`·`analysis.json` 지문에 주입.

검증 (합성 시나리오 4회차):

| 회차 | 상황 | 보존 | 재생성 |
|---|---|---|---|
| 2 | fallback boundaries 그대로 | stt·refined·narrative·scenes·shots | beats·signals·shorts·analysis (자기안정화 1회) |
| 3 | 변화 없음 | **전부** | 없음 |
| 4 | **GEBD 도착** | stt·refined·narrative·scenes·shots | beats·signals·shorts·analysis |

**핵심: STT 가 보존된다** → GEBD 재실행 비용이 ₩620 이 아니라 **beats 이후만(≈₩140)**.
이게 없으면 GEBD 를 켤 때마다 회차당 ₩270(STT)이 이중 지출된다.

> 자기안정화 1회: 첫 실행은 지문 계산 시점에 boundaries.json 이 없어 ""로 잡히고 실행 중
> fallback 이 파일을 쓴다. 그래서 바로 다음 재실행 1회만 beats 를 더 만들고, 그 뒤로는 안정.

함께 처리:
- `CHECKPOINTS`(core) 에 `signals.json`·`genre.json`·`chyron.json` 추가 — 빠져 있으면 "다른 영상"
  초기화 때 살아남아 오염된다
- `CHECKPOINT_FILES`(worker GCS 왕복) 에 같은 3개 추가 — **`chyron.json` 은 재생성이 ₩150**
- `beats.py` 로그가 fallback 인데도 항상 "GEBD 기반"이라 찍던 것 수정 → `boundary source=…`
  실측 두 회차 모두 `shots+stt_gap` 이었는데 로그만 보고 GEBD 가 도는 줄 알았다

### 지금 안 함 (다음 세션)

- **GEBD VM 관리** — `deploy/gebd-vm.sh` (idle 10분 auto-shutdown 이라 함) 은 있는 듯. 실측 시
  VM 부팅 지연 (콜드 스타트 몇 분) · 처리 시간 (60분 영상 GEBD 추론 ~5~10분 · 3060 Ti CORES=2)
  · 두 번째 실행 cost 를 감안한 게이팅 필요.
- **재실행 비용 이중지출 방지** — 첫 실행은 fallback 로 STT+refine 다 함. 재실행 시 checkpoint
  재사용으로 STT/refine 은 skip · beats/shorts 만 새로 돌아야 함. 현재 fingerprint 로직이
  boundaries 변화로 beats 만 재실행하는지 확인 필요. 아니면 fallback 결과에 GEBD merge 하는
  경로가 더 나을 수 있음.
- **첫 실행 fallback vs GEBD 대기 UX** — 편집자가 처음 열면 fallback beats · 나중에 새로고침시
  GEBD beats. "재분석 필요" 표시 있어야 혼란 없음.

### 로컬 워커 지원 (선택)

로컬 GPU (3060 Ti) 로도 돌리려면:
- Docker Desktop + WSL2 GPU 패스스루 설치
- `docker pull` 로 GEBD 이미지 (asia-northeast3 Artifact Registry 인증 필요)
- `handleGebdDetect` 가 gsutil 대신 로컬 파일 경로 지원하도록 `if (useGcs())` 분기 추가
- 우선순위 낮음 · 프로덕션 배선이 먼저.

## 관련

- `apps/server/src/worker.ts:178-227` — `handleGebdDetect`
- `core/boundaries.py` — load/dedup/window
- `core/analyze.py:687-708` — boundaries 소비 지점
- [[gebd-model-limits]] · [[gebd-gpu-parallel]] · [[beat-pipeline-v1]] — 이전 실측 노트

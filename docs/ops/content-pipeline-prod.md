# 콘텐츠 파이프라인 실서비스 배선

업로드한 영상을 AI가 분석해 쇼츠를 추천하는 파이프라인(core/)을 실서비스에 연결한 구조.
2026-07-16.

## 전체 흐름

```
웹 업로드 → apps/server(Cloud Run) /api/media/upload
      │        (대용량은 upload-init → 브라우저→GCS 직행 → finalize, 같은 꼬리로 합류)
      │  episode.pipeline={stage:analyze, progress:30} + content_analysis=pending
      │  + enqueue("content.analyze", {mediaId}, dedupeKey="content.analyze:<mediaId>")
      ▼
   job_queue (Cloud SQL — 코드 생성 테이블, 아래 함정 참고)
      ▼
워커 VM(stepd-worker, e2-small, GPU 없음)  ── content-pipeline.ts
      │  GCS에서 영상 다운로드 → python -m core.analyze
      │  (STT→정제→장면→시각채점→이름자막→쇼츠추천, 전부 관리형 Gemini)
      ▼
   content_analysis(mediaId, data=결과JSON) ← saveContentAnalysis
      ├─ AI 쇼츠 → 회차 추천 보드에 기록 (writeRecommendationsFromShorts, 멱등)
      └─ episode.pipeline={stage:recommend, stageStatus:done, progress:100}
      ▼
웹: 회차 상세 분석 탭이 GET /api/media/:id/analysis 조회 + 추천 & 채택 보드에 쇼츠 노출
```

**핵심: 전 단계가 GPU-free다** (STT까지 Gemini 오디오). e2-small 워커에서 그대로 돈다.
GPU VM 불필요.

**추천 보드 배선** — 분석이 끝나면 워커가 shorts를 회차의 추천 엔티티(kind=recommendation)로
변환해 기록한다(`content-pipeline.ts` `writeRecommendationsFromShorts`). 재실행 시 해당 회차의
기존 추천을 전부 지우고 다시 쓰는 멱등 동작이라 중복이 쌓이지 않고, rank 1이 보드 맨 앞에 온다.
업로드 시 휴리스틱 더미 추천은 더 이상 만들지 않는다 — 보드는 비어 있다가 AI 결과로 채워진다.

## 구성 요소

| 파일 | 역할 |
|------|------|
| `core/analyze.py` | 전 스테이지 오케스트레이터(단일 진입점). `python -m core.analyze <video> --out <dir>` → analysis.json |
| `core/asr.py` | STT provider 스위치. `STT_PROVIDER=gemini`(기본, 관리형) / `whisper`(로컬 GPU) |
| `apps/server/src/content-pipeline.ts` | 워커측 실행기: 영상 다운로드 → analyze.py 스폰 → 결과 DB 저장 + 추천 보드 기록 + episode.pipeline 갱신 |
| `apps/server/src/queue.ts` | `content.analyze` 잡 타입 + `job_queue` 런타임 생성 |
| `apps/server/src/worker.ts` | `content.analyze` 케이스 → `runContentAnalyze` 호출 |
| `apps/server/src/db-pg.ts` | `content_analysis` 테이블(런타임 생성) + `markContentAnalysisPending`/`saveContentAnalysis`/`getContentAnalysis` |
| `apps/server/src/index.ts` | 업로드 시 enqueue + `GET /api/media/:id/analysis` + `POST /api/admin/queue/purge` |
| `deploy/worker-pipeline-setup.sh` | 워커 VM에 파이썬 파이프라인 설치 (최초 1회) |
| `deploy-worker.ps1` (루트) | 워커 코드 갱신(재배포) 스크립트 |

**⚠️ 스키마 함정:** `content_analysis`와 `job_queue`는 `apps/server/schema.sql`에 **없다**.
각각 db-pg.ts(initDb)와 queue.ts(initQueue)가 기동 시 `CREATE TABLE IF NOT EXISTS`로 런타임
생성한다. 새 DB를 schema.sql만으로 부트스트랩하면 이 둘이 빠져 보이지만, 서버/워커 첫 기동 때
자동으로 생긴다.

## 진행 상태와 실패 처리

- **진행 상태** — `content_analysis.status`(pending/done/failed)와 별개로, 워커가
  **episode.pipeline**에 실제 상태를 기록한다. 업로드 시 서버가
  `{stage:'analyze', stageStatus:'progress', progress:30}`으로 시작하고(index.ts), 워커가 완료
  시 `{stage:'recommend', stageStatus:'done', progress:100, note:'AI 쇼츠 추천 N건'}`으로
  뒤집는다(content-pipeline.ts). 스테이지별 세분 진행률(STT 몇 %…)은 아직 없다.
- **실패 경로** — 오류 시 워커가 `content_analysis`에 `status='failed'` + `error`(메시지
  1000자 절단)를 저장하고, episode.pipeline을
  `{stage:'analyze', stageStatus:'error', blockedReason:'AI 분석 실패 — 재시도 필요'}`로
  남긴다. 잡 자체는 throw로 실패해 큐가 지수 백오프로 재시도하고(기본 maxAttempts 5), 소진되면
  `job_queue`에 `failed`로 남는다 — 무엇이 깨졌는지의 기록이다.

## 워커 VM 배포

**최초 1회 — 파이썬 환경 설치:**

```bash
# 워커에 파이썬 파이프라인 환경 설치 (ffmpeg + venv + core deps, GPU 불필요)
gcloud compute ssh stepd-worker --zone us-central1-a \
  --command "cd /opt/stepd && sudo git pull && sudo bash deploy/worker-pipeline-setup.sh"

# 워커 서비스 env에 파이썬 경로 추가 (systemd EnvironmentFile 또는 서비스에)
#   CORE_PYTHON=/opt/stepd/core/.venv/bin/python
# 그리고 워커 재시작
```

워커 SA(stepd-deployer)는 이미 `roles/aiplatform.user` 보유 → Vertex(Gemini) ADC 인증 자동, 키 불필요.

**이후 코드 갱신(재배포) — 루트 `deploy-worker.ps1`:**

```powershell
.\deploy-worker.ps1            # 재시작 생략은 -SkipRestart
```

VM에 SSH해 `git fetch` + `git reset --hard origin/main` + `systemctl restart stepd-worker`를
한 번에 실행한다. 워커는 tsx로 소스를 직접 실행하므로 빌드가 없고, `reset --hard`라 VM의 로컬
변경은 폐기된다(멱등). 파이썬 의존성이 바뀌었으면 worker-pipeline-setup.sh를 다시 돌려야 한다.

## 운영 복구 (큐가 막혔을 때)

- 업로드 enqueue는 dedupeKey `content.analyze:<mediaId>`를 쓴다. **pending/running인 동일
  키만** 충돌하는 부분 유니크 인덱스라, 끝난 잡은 다시 넣을 수 있고 재기동 시 중복이 안 생긴다
  (충돌 시 enqueue는 null 반환·스킵).
- `POST /api/admin/queue/purge` (body `{"confirm":"PURGE"}`) — video.* 잡 홍수에
  content.analyze가 굶을 때의 원샷 복구 라우트:
  1. `video.*` 백로그(pending/failed) 삭제 — 다음 채널 틱에 재생성되므로 안전
  2. 미디어가 이미 지워진 좀비 content.analyze 잡 삭제 ("media not found"로 영원히 실패하는 것들)
  3. 살아남은 content.analyze를 pending·attempts=0으로 리셋해 즉시 실행
  4. 모든 master 미디어에 analyze 잡 존재 보장 (잡이 유실/미생성된 경우 커버, dedupe가 중복 스킵)

## 잡 네임스페이스 (다른 트랙과 조율)

- **`content.*`** — 업로드 콘텐츠 분석 (이 문서, core/ 파이썬 파이프라인)
- **`channel.* / video.*`** — YouTube 채널·영상 애널리틱스 (별도 트랙, TS 구현 — [pipeline-current.md](pipeline-current.md))

둘은 같은 워커·큐·DB를 공유하되 잡 타입·핸들러·테이블이 분리돼 충돌하지 않는다.
큐 자체(클레임·백오프·dedupe)의 상세는 [worker-queue.md](worker-queue.md).

## 남은 것 (v1 이후)

1. **장면 프레임 호스팅** — 지금 v1은 프레임을 워커 임시디렉터리에서 시각채점에만 쓰고 버린다.
   analysis.json엔 프레임 경로가 있지만 프로덕션에선 해석 안 됨. admin 썸네일이 필요하면
   프레임을 GCS 업로드 + `/api/media/:id/frames/:name` 서빙 추가.
   (쇼츠 추천·자막·장면 점수/텍스트는 프레임 없이도 다 나옴 — 핵심 가치는 이미 저장됨.)
2. **처리량** — 8분 영상이 vision+names 182 Gemini 호출로 수 분 소요. 90분 회차는 1000+ 호출.
   비동기 배치라 문제는 아니나, 동시 회차가 몰리면 Vertex 리전 쿼터가 천장(리뷰 R5).
   전역 레이트리미터·배치 API 오프로드 검토.
3. **진행 상태 세분화** — episode.pipeline 반영으로 UI 표시는 해결됐고(위 섹션),
   스테이지별 진행률(%)만 남음.
4. ~~admin 연결~~ — **완료(2026-07-16).** 회차 상세 분석 탭이
   `getMediaAnalysis`(apps/web/src/lib/data/api.ts)로 `/api/media/:id/analysis`(DB)를 읽어
   실제 content_analysis를 렌더한다(apps/web/src/components/episode-detail.tsx).

## 로컬 테스트

```bash
# 오케스트레이터 단독 (전 스테이지)
core/.venv310/Scripts/python -m core.analyze core/영상.mp4 --out /tmp/out
# → /tmp/out/analysis.json (transcript + scenes + shorts)
```

# 콘텐츠 파이프라인 실서비스 배선

업로드한 영상을 AI가 분석해 쇼츠를 추천하는 파이프라인(core/)을 실서비스에 연결한 구조.
2026-07-15.

## 전체 흐름

```
웹/admin 업로드 → apps/server(Cloud Run) /api/media/upload → GCS 저장
      │  content_analysis=pending + enqueue("content.analyze",{mediaId})
      ▼
   job_queue (Cloud SQL)
      ▼
워커 VM(stepd-worker, e2-small, GPU 없음)  ── content-pipeline.ts
      │  GCS에서 영상 다운로드 → python -m core.analyze
      │  (STT→정제→장면→시각채점→이름자막→쇼츠추천, 전부 관리형 Gemini)
      ▼
   content_analysis(mediaId, data=결과JSON) ← saveContentAnalysis
      ▼
웹/admin: GET /api/media/:id/analysis 로 조회
```

**핵심: 전 단계가 GPU-free다** (STT까지 Gemini 오디오). e2-small 워커에서 그대로 돈다.
GPU VM 불필요.

## 이번에 넣은 것

| 파일 | 변경 |
|------|------|
| `core/analyze.py` | **신규** — 전 스테이지 오케스트레이터(단일 진입점). `python -m core.analyze <video> --out <dir>` → analysis.json |
| `core/asr.py` | STT provider 스위치. `STT_PROVIDER=gemini`(기본, 관리형) / `whisper`(로컬 GPU) |
| `apps/server/src/content-pipeline.ts` | **신규** — 워커측 실행기: 영상 다운로드 → analyze.py 스폰 → 결과 DB 저장 |
| `apps/server/src/queue.ts` | `content.analyze` 잡 타입 추가 |
| `apps/server/src/worker.ts` | `content.analyze` 케이스 2줄 |
| `apps/server/src/db-pg.ts` | `content_analysis` 테이블 + `markContentAnalysisPending`/`saveContentAnalysis`/`getContentAnalysis` |
| `apps/server/src/index.ts` | 업로드 시 enqueue + `GET /api/media/:id/analysis` |
| `deploy/worker-pipeline-setup.sh` | **신규** — 워커 VM에 파이썬 파이프라인 설치 |

## 워커 VM 배포 (한 번)

```bash
# 워커에 파이썬 파이프라인 환경 설치 (ffmpeg + venv + core deps, GPU 불필요)
gcloud compute ssh stepd-worker --zone us-central1-a \
  --command "cd /opt/stepd && sudo git pull && sudo bash deploy/worker-pipeline-setup.sh"

# 워커 서비스 env에 파이썬 경로 추가 (systemd EnvironmentFile 또는 서비스에)
#   CORE_PYTHON=/opt/stepd/core/.venv/bin/python
# 그리고 워커 재시작
```

워커 SA(stepd-deployer)는 이미 `roles/aiplatform.user` 보유 → Vertex(Gemini) ADC 인증 자동, 키 불필요.

## 잡 네임스페이스 (다른 트랙과 조율)

- **`content.*`** — 업로드 콘텐츠 분석 (이 문서, core/ 파이썬 파이프라인)
- **`channel.* / video.*`** — YouTube 채널·영상 애널리틱스 (별도 트랙, TS 구현)

둘은 같은 워커·큐·DB를 공유하되 잡 타입·핸들러·테이블이 분리돼 충돌하지 않는다.

## 남은 것 (v1 이후)

1. **장면 프레임 호스팅** — 지금 v1은 프레임을 워커 임시디렉터리에서 시각채점에만 쓰고 버린다.
   analysis.json엔 프레임 경로가 있지만 프로덕션에선 해석 안 됨. admin 썸네일이 필요하면
   프레임을 GCS 업로드 + `/api/media/:id/frames/:name` 서빙 추가.
   (쇼츠 추천·자막·장면 점수/텍스트는 프레임 없이도 다 나옴 — 핵심 가치는 이미 저장됨.)
2. **처리량** — 8분 영상이 vision+names 182 Gemini 호출로 수 분 소요. 90분 회차는 1000+ 호출.
   비동기 배치라 문제는 아니나, 동시 회차가 몰리면 Vertex 리전 쿼터가 천장(리뷰 R5).
   전역 레이트리미터·배치 API 오프로드 검토.
3. **진행 상태** — content_analysis.status(pending/done/failed)만 있음. 단계별 진행률이
   필요하면 세분화.
4. **admin 연결** — 지금 admin은 로컬 core/ 파일을 읽음. 프로덕션 admin은
   `/api/media/:id/analysis`(DB)를 읽도록 전환 (Vercel 배포 시).

## 로컬 테스트

```bash
# 오케스트레이터 단독 (전 스테이지)
core/.venv310/Scripts/python -m core.analyze core/영상.mp4 --out /tmp/out
# → /tmp/out/analysis.json (transcript + scenes + shorts)
```

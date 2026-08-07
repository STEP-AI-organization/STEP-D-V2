---
name: deploy
description: STEP-D 클라우드 배포 — 서버·워커 Job·GEBD 이미지·DB 마이그레이션을 한 번에. 배포/deploy/올려/반영 요청 시 사용.
---

# STEP-D 클라우드 배포

전부 `deploy/cloud.sh` 하나로 한다. 손으로 gcloud 를 치지 말 것 — 아래 함정들을 이 스크립트가 막는다.

```bash
bash deploy/cloud.sh status     # 지금 뭐가 떠 있나 (배포 안 함 · 먼저 이걸로 확인)
bash deploy/cloud.sh server     # stepd-server (Cloud Run 서비스)
bash deploy/cloud.sh worker     # 워커 이미지 2종 + Cloud Run Jobs 갱신
bash deploy/cloud.sh gebd       # GEBD 슬림 이미지 → Artifact Registry
bash deploy/cloud.sh migrate    # DB 마이그레이션 (Cloud Run Job 으로 Cloud SQL 접속)
bash deploy/cloud.sh all        # server + worker + migrate
```

## 배포 전 확인

1. **`status` 를 먼저 돌려** 현재 상태를 본다.
2. 스크립트가 `apps/server`·`core` 의 미커밋 변경을 경고한다 —
   `gcloud builds submit` 은 **작업 트리를 그대로** 올리므로 미완성 코드가 나갈 수 있다.
3. 커밋 author 는 `contact@stepai.kr` 여야 한다 (웹 배포 시 Vercel 이 다른 author 를 막는다).

## 무엇이 어디로 가나

| 대상 | 결과물 | 비고 |
|---|---|---|
| `server` | Cloud Run **서비스** `stepd-server` | 루트 `cloudbuild.yaml` · `:latest` 갱신 |
| `worker` | Cloud Run **Jobs** `stepd-worker-youtube` / `-content` | 태그가 시각별로 붙는다 (`:latest` 안 건드림) |
| `gebd` | AR `stepd/gebd-mmaction2:latest` (13.8GB) | 빌드는 GCP 안에서 — 로컬 업로드는 컨텍스트뿐 |
| `migrate` | `pgmigrations` 테이블 갱신 | 서버는 부팅 시 마이그레이션을 **안 돌린다** |

## 함정 (전부 실제로 겪은 것)

- **루트 `cloudbuild.yaml` 은 마지막에 `gcloud run deploy` 를 한다.** 워커만 올리려고
  이걸 쓰면 **프로덕션 서버까지 재배포**된다. 그래서 워커는 `deploy/cloudbuild-worker.yaml`
  (빌드·푸시만) 을 쓰고 `:latest` 도 건드리지 않는다.
- **이미지를 새로 푸시해도 Cloud Run Job 은 안 바뀐다.** `gcloud run jobs update --image` 를
  꼭 해야 반영된다. 스크립트가 같이 한다.
- **`.gcloudignore` 가 있으면 `.gitignore` 는 무시된다.** `tmp/` 를 `.gcloudignore` 에
  안 적어서 빌드 컨텍스트가 1.9GB 였던 적이 있다.
- **마이그레이션은 자동이 아니다.** `search_segments`·`search_events` 가 프로덕션에 없어서
  검색 인덱스가 저장될 곳이 없던 적이 있다 — 파이프라인은 성공으로 보이는데 검색만 빈다.
- **Cloud Run Job 의 `/tmp` 는 tmpfs(RAM)** 다. content Job 이 1GB 영상을 받으면 그만큼
  메모리를 먹는다. 8Gi 로 잡아뒀고, 90~120분 회차는 16Gi 검토가 필요하다.

## 배포 후

```bash
bash deploy/cloud.sh status
```

Scheduler 가 `ENABLED` 인지, 큐가 도는지 확인한다. 새 잡만 처리하려면 Scheduler 를
`pause` → 큐 정리 → `resume` 순서로 한다.

## 관련

- `docs/plans/cloud-migration-model-and-worker.md` — 이전 계획·비용
- `docs/ops/pipeline-current-state.md` — 파이프라인 실제 상태
- `docs/ops/gebd-worker-setup.md` — GPU 워커(로컬 대안) 셋업
- `deploy/deploy-web.ps1` — 웹(Vercel)은 별도

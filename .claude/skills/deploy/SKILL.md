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

웹(Vercel)은 별도: `.\deploy\deploy-web.ps1` — push 만 하면 자동 배포이며 스크립트는 확인용.

## 철칙 — 이것부터

1. **배포는 사용자가 명시적으로 요청했을 때만.** "ㄱㄱ"·"배포해줘" 없이 실행 금지.
2. **인증은 deployer SA 로.** `cloud.sh` 가 `CLOUDSDK_CORE_ACCOUNT` 를 deployer SA 로
   기본 설정한다(2026-08-14 추가). 사용자 계정(hkj)은 토큰이 만료되면 비대화형에서
   재인증을 못 해 **배포가 중간에 죽는다** — "Reauthentication failed. cannot prompt" 가
   그 증상이다. 스크립트 밖에서 ad-hoc gcloud 를 칠 때는 직접 붙일 것:
   `CLOUDSDK_CORE_ACCOUNT=stepd-deployer@step-d.iam.gserviceaccount.com`
3. **gcloud 기본 프로젝트를 믿지 말 것.** 다른 세션이 `aena-platform` 등으로 바꿔 둘 수
   있다(2026-08-14 실측 — describe 한 번이 남의 프로젝트로 날아갔다). 모든 ad-hoc 명령에
   `--project step-d` 명시. **기본값을 되돌리지도 말 것** — 남의 작업일 수 있다.
4. **exit 0 을 믿지 말고 출력 본문을 읽을 것.** cloud.sh 는 `⚠️` 경고를 찍고도 0 으로
   끝나는 경로가 있다(더티 가드 중단 · env 자가치유 실패). 마지막 몇 줄에 `⚠️` 가 있으면
   원인을 파고, "완료" 문구를 확인한 뒤에 성공이라고 보고한다.

## 배포 전 확인

1. **`status` 를 먼저 돌려** 현재 상태를 본다.
2. 스크립트가 `apps/server`·`core` 의 미커밋 변경을 경고한다 —
   `gcloud builds submit` 은 **작업 트리를 그대로** 올리므로 미완성 코드가 나갈 수 있다.
   비대화형에선 y/N 프롬프트가 EOF → 중단(exit 0)이니 본문 확인 필수(철칙 4).
3. 커밋 author 는 `contact@stepai.kr` 여야 한다 (웹 배포 시 Vercel 이 다른 author 를 막는다).
4. **새 마이그레이션이 있으면 순서가 생명**: `migrate` 는 서버 `:latest` **이미지 안의**
   마이그레이션을 돌린다 → server 빌드가 먼저다(`all` 이 이 순서). 반대로 서버만 먼저
   내보내고 migrate 를 미루면 새 코드 × 옛 스키마로 500 이 난다(2026-08-13 실측) —
   server 와 migrate 는 한 몸으로 내보낼 것.

## 무엇이 어디로 가나

| 대상 | 결과물 | 비고 |
|---|---|---|
| `server` | Cloud Run **서비스** `stepd-server` | 루트 `cloudbuild.yaml` · `:latest` 갱신 |
| `worker` | Cloud Run **Jobs** `stepd-worker-youtube` / `-content` | 태그가 시각별로 붙는다 (`:latest` 안 건드림) |
| `gebd` | AR `stepd/gebd-mmaction2:latest` (13.8GB) | 빌드는 GCP 안에서 — 로컬 업로드는 컨텍스트뿐 |
| `migrate` | `pgmigrations` 테이블 갱신 | 서버는 부팅 시 마이그레이션을 **안 돌린다** |

윈도우2(네이버·다운로드 워커)는 push 만 하면 10분 내 자가 갱신 — `docs/ops/deploy-win2.md`.

## 함정 (전부 실제로 겪은 것)

- **루트 `cloudbuild.yaml` 은 마지막에 `gcloud run deploy` 를 한다.** 워커만 올리려고
  이걸 쓰면 **프로덕션 서버까지 재배포**된다. 그래서 워커는 `deploy/cloudbuild-worker.yaml`
  (빌드·푸시만) 을 쓰고 `:latest` 도 건드리지 않는다.
- **이미지를 새로 푸시해도 Cloud Run Job 은 안 바뀐다.** `gcloud run jobs update --image` 를
  꼭 해야 반영된다. 스크립트가 같이 한다.
- **env 는 `--set-*` 가 아니라 `--update-*`.** `--set-env-vars`/`--set-secrets` 는 전체
  목록 교체라 나머지 env 가 전부 증발한다. 서버 env 의 SSOT 는 `cloudbuild.yaml` — 수동으로
  `services update` 한 env 는 다음 배포 때 지워지므로 반드시 cloudbuild.yaml 에도 넣는다.
- **jobs 의 `--remove-env-vars` 는 Done 을 찍고도 조용히 무시된다.** 지우기 대신 정답 값으로
  `--update-env-vars` 덮어쓰기. env 변경 후엔 반드시 `jobs describe` 로 재확인 —
  cloud.sh 의 content job 자가치유(CORE_PYTHON·CORE_DIR)가 이 방식이다.
- **`MSYS2_ARG_CONV_EXCL="*"` 는 gcloud 자체를 죽인다.** 래퍼의 자기 경로 변환까지 막혀
  아예 안 뜬다(자가치유가 배포마다 조용히 실패했던 원인). `/opt/...` 같은 값 보호는
  해당 플래그 이름만: `MSYS2_ARG_CONV_EXCL="--update-env-vars"`. 애초에 Cloud Run env
  작업은 PowerShell 에서 하는 편이 안전하다(Git Bash MSYS 변환이 값을 깨뜨린다).
- **`.gcloudignore` 가 있으면 `.gitignore` 는 무시된다.** `tmp/` 를 `.gcloudignore` 에
  안 적어서 빌드 컨텍스트가 1.9GB 였던 적이 있다.
- **마이그레이션은 자동이 아니다.** `search_segments`·`search_events` 가 프로덕션에 없어서
  검색 인덱스가 저장될 곳이 없던 적이 있다 — 파이프라인은 성공으로 보이는데 검색만 빈다.
  migrate 후 로그에서 번호 INSERT 를 확인할 것.
- **Cloud Run Job 의 `/tmp` 는 tmpfs(RAM)** 다. content Job 이 1GB 영상을 받으면 그만큼
  메모리를 먹는다. 8Gi 로 잡아뒀고, 90~120분 회차는 16Gi 검토가 필요하다.
- **웹 배포(deploy-web.ps1)의 watch 단계 exit 1 은 배포 실패가 아니다**(PS 5.1 stderr
  함정). push 가 찍혔으면 성공 — Bash 에서 `vercel ls` 로 확인한다. push 는 로컬 main 이
  아니라 `git push origin HEAD:main`(로컬 main 은 낡아 있어 거부된다).

## 배포 후

```bash
bash deploy/cloud.sh status
```

Scheduler 가 `ENABLED` 인지, 큐가 도는지 확인한다. 새 잡만 처리하려면 Scheduler 를
`pause` → 큐 정리 → `resume` 순서로 한다. env 를 바꿨다면 `jobs describe`/`services
describe` 로 실제 값 재확인까지가 배포다.

## 관련

- `docs/ops/deploy.md` — 배포 런북 (검증·롤백)
- `docs/ops/infra.md` — 인프라 SSOT
- `docs/ops/deploy-win2.md` — 윈도우2(네이버·다운로드 워커) 갱신
- `docs/ops/pipeline-current-state.md` — 파이프라인 실제 상태
- `deploy/deploy-web.ps1` — 웹(Vercel)은 별도

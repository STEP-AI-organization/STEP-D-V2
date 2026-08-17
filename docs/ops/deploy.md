# 배포 방법 (한 장 요약)

> 2026-08-12 실측 기준 전면 개정. 이전 판은 **systemd 워커 VM(`stepd-worker`)** 전제로
> 쓰여 있었는데 그런 VM 은 더 이상 없다 — 워커는 Cloud Run Jobs(drain) + 전용 머신 2대다.
> 그대로 따라하면 없는 VM 에 SSH 를 시도하게 된다.

## 무엇을 고쳤나 → 어디로 나가나

| 고친 것 | 실행 | 반영되는 곳 |
|---|---|---|
| **서버** (`apps/server/`) | `bash deploy/cloud.sh server` | Cloud Run `stepd-server` |
| **워커** (잡 핸들러) | `bash deploy/cloud.sh worker` | Cloud Run Jobs `stepd-worker-content` · `stepd-worker-youtube` |
| **DB 스키마** (`migrations/`) | `bash deploy/cloud.sh migrate` | Cloud SQL (Cloud Run Job 으로 접속) |
| **GEBD** (`deploy/gebd/`) | `bash deploy/cloud.sh gebd` | GPU T4 spot VM 이미지 |
| **프론트** (`apps/web/`) | `.\deploy\deploy-web.ps1` | Vercel (`stepd.stepai.kr`) |
| **네이버 워커** | `git push origin HEAD:main` 만 | **윈도우2** — 10분 폴링으로 자동 ([deploy-win2.md](deploy-win2.md)) |

지금 뭐가 떠 있는지: **`bash deploy/cloud.sh status`** (서비스·Jobs·Scheduler·GEBD VM·큐)

`all` 은 `server` → `worker` → `migrate` 순서로 전부 돌린다.

---

## 왜 PowerShell 이 아니라 Bash 인가

`cloud.sh` 는 **비대화형 Bash + deployer 서비스계정**으로 돈다. PowerShell 5.1 은 네이티브
exe 의 **stderr 한 줄만 나와도 실패로 판정**해서(`NativeCommandError`), gcloud 의 정상 경고에
배포가 멈춘다. 재인증 프롬프트에 걸리는 문제도 있었다. 그래서 표준 경로를 Bash 로 옮겼다.

`/deploy` 스킬(`.claude/skills/deploy/`)이 같은 스크립트를 감싼다.

> 프론트만 예외로 `.ps1` 이다(Vercel CLI + git author 강제 때문). 같은 stderr 함정이 있어서,
> **로컬 `next build` 검증 단계에서 자주 오탐으로 멈춘다.** Bash 로 `npx next build` 를 먼저
> 통과시킨 뒤 `-SkipChecks` 로 돌리면 된다.

---

## ⚠️ `gcloud builds submit` 은 **작업 트리**를 올린다

커밋이 아니라 **지금 디스크에 있는 파일**이 그대로 이미지에 들어간다. 이 리포는 병렬
세션으로 작업하는 일이 잦아서, 남의 미커밋 변경이 같이 배포될 수 있다.

`cloud.sh` 가 `apps/server`·`core` 의 미커밋 변경을 감지하면 물어본다(`check_clean`).
**다른 세션 것이면 "n" 을 누르고**, 커밋된 상태만 올린다:

```bash
T=$(mktemp -d) && git archive HEAD | tar -x -C "$T" && cd "$T"
CLOUDSDK_CORE_ACCOUNT=stepd-deployer@step-d.iam.gserviceaccount.com \
  gcloud builds submit --config=cloudbuild.yaml --project=step-d .
```

---

## 사전 준비물

- **gcloud 인증** — deployer SA 가 활성화돼 있어야 한다. `cloud.sh` 가
  `CLOUDSDK_CORE_ACCOUNT=stepd-deployer@…` 로 강제한다.
- **pnpm install** — 루트 1회 (타입체크·`next build` 가 node_modules 를 요구)
- **`gcp-keys/vercel-token.txt`** — 없어도 푸시·배포는 되지만 `deploy-web.ps1` 이
  빌드 감시를 건너뛴다. 발급은 [vercel-ops.md](vercel-ops.md).

---

## 프론트

```powershell
git add -A ; git commit -m "..."
.\deploy\deploy-web.ps1
```

1. 커밋 author 를 `contact@stepai.kr` 로 강제 — **Vercel 은 author 가 팀 멤버가 아니면 빌드를
   조용히 차단한다**(UNKNOWN 무한대기). 상세 [vercel-ops.md](vercel-ops.md).
2. 로컬 `next build` (깨지면 여기서 멈춤)
3. `git push` → Vercel 자동 빌드 → 완료 대기 → 라이브 확인

옵션: `-SkipChecks`(로컬 빌드 생략) · `-SkipVerify`(라이브 확인 생략)

**Vercel 은 main 푸시로 자동 배포된다.** 다른 이유로 이미 푸시했다면 스크립트가
"이미 최신 — 배포할 커밋 없음" 으로 끝나는데, 그건 **실패가 아니라 이미 나갔다는 뜻**이다.
`npx vercel ls` 로 Production Ready 를 확인하면 된다.

---

## 확인

```bash
bash deploy/cloud.sh status
```

서버에 직접 curl 하면 **403 이 정상이다** — Cloud Run 이 인증을 요구하고, 웹은
`/api/proxy` 로 ID 토큰을 붙여 경유한다. 직접 찔러보려면 토큰을 붙인다:

```bash
S=https://stepd-server-nsh6xfqyla-uc.a.run.app
T=$(gcloud auth print-identity-token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" $S/health   # 200
curl -s -H "Authorization: Bearer $T" $S/api/state | head -c 200
```

`AUTH_REQUIRED=1` 이라 대부분의 `/api/*` 는 **세션 없이 401** 이다. 그건 라우트가 살아 있다는
신호지 장애가 아니다.

### "배포됐다"고 방심하지 말 것

- **Cloud Run 은 GitHub 푸시로 자동 배포되지 않는다.** 서버를 고치고 `cloud.sh server` 를
  안 돌리면 옛 코드가 계속 돈다. (Vercel 만 자동이다.)
- **코드가 최신이어도 프로세스가 옛날이면 소용없다.** 2026-08-11 에 5일간 구버전으로 돌던
  워커가 잡을 가로채 계속 실패시켰다 — 증상이 "잡은 조용히 실패하는데 전용 워커는 큐가
  비어 보임" 이라 원인을 찾기 어렵다.
- 마이그레이션 실패 메시지는 곧이곧대로 읽지 말 것 — [migrations.md](migrations.md) 의
  순번 충돌 항목.

---

## 롤백

**Cloud Run** — 이전 리비전으로 트래픽만 되돌린다(재빌드 없이 즉시):

```bash
gcloud run revisions list --service stepd-server --region us-central1 --project step-d
gcloud run services update-traffic stepd-server --to-revisions <리비전>=100 \
  --region us-central1 --project step-d
```

**Jobs·Vercel·윈도우2** — 트래픽 전환이 없다. `git revert` 후 재배포한다.

⚠️ **서버만 되돌리면 워커는 새 코드로 남아 둘이 어긋난다.** 코드 자체가 문제면
`git revert` → `cloud.sh all` 로 함께 되돌리는 것이 안전하다.
⚠️ **마이그레이션은 트래픽 전환으로 안 돌아온다.** 컬럼을 지우는 `down` 은 데이터를 버린다 —
되돌리기 전에 [migrations.md](migrations.md) 를 볼 것.

---

## 워커는 어디서 도는가 (배포 대상이 다르다)

| 레인 | 어디 | 어떻게 깨어나나 |
|---|---|---|
| `content` | Cloud Run Job `stepd-worker-content` | Cloud Scheduler `*/15` · drain 모드(큐 비면 종료) |
| `youtube` | Cloud Run Job `stepd-worker-youtube` | Cloud Scheduler `*/15` · drain 모드 |
| `gebd` | GPU T4 spot VM `stepd-gebd-vm` | `*/10` wake · idle 시 자동 종료 |
| `naver` | **윈도우2** (사무실 상시 PC) | 상주 · [deploy-win2.md](deploy-win2.md) |

**drain 모드가 비용 구조의 핵심이다** — 상시 폴링 대신 스케줄러가 깨우고 큐가 비면 종료해
idle 과금이 0 이다. 구조 상세는 [worker-queue.md](worker-queue.md), 인프라 SSOT 는
[infra.md](infra.md).

### content 잡의 env 는 `cloud.sh worker` 가 매번 덮어쓴다

`stepd-worker-content` 는 배포마다 아래 값을 `--update-env-vars` 로 다시 눌러쓴다.
Cloud Run Jobs 는 `--remove-env-vars` 가 조용히 무시되므로 **지우는 대신 정답으로 덮는다**.

| env | 값 | 왜 |
|---|---|---|
| `CORE_PYTHON` · `CORE_DIR` | `/opt/corevenv/bin/python` · `/app` | 윈도우 경로가 눌러앉아 분석이 `spawn ENOENT` 로 전멸한 사고(2026-08-13·14) 재발 방지 |
| `GEMINI_BATCH` | `1` | chyron 을 Vertex 배치로 → 그 스테이지 원가 절반(60분 ₩1,218 → ₩609) |

**배치를 급히 끄려면** 재배포 없이 잡 env 만 바꾸면 된다(다음 `cloud.sh worker` 에서 다시 1 로 돌아온다 — 항구적으로 끌 거면 `deploy/cloud.sh` 도 같이 고칠 것):

```bash
gcloud run jobs update stepd-worker-content --project step-d --region asia-northeast3 \
  --update-env-vars=GEMINI_BATCH=0
```

끌 만한 상황은 **분석이 오래 걸려서 곤란할 때**다. 배치는 큐 대기가 붙는다(실측 5분 19초) —
원가는 내려가고 시간은 늘어난다. 판단 근거는 [how-it-works.md §6](how-it-works.md).

# 장애 대응 런북 — 증상별 진단·조치

> 프로덕션(Cloud Run `stepd-server` + 워커 VM `stepd-worker` + Cloud SQL `stepd-db` + GCS + Vercel)이
> 이상할 때 여기부터. 인프라 전체 그림은 [infra.md](infra.md), 배포·롤백 절차는 [deploy.md](deploy.md). 최종: 2026-07-16.

## 0. 첫 3분 — 어디가 죽었는지부터

```powershell
curl -s https://stepd.stepai.kr/api/state          # 백엔드 (Vercel 프록시 경유) — 200 + JSON이면 정상
curl -s https://stepd.stepai.kr/api/queue/stats    # 큐 — {"pending":N,"running":N,"done":N,"failed":N}
gcloud compute ssh stepd-worker --zone us-central1-a --project step-d --command "sudo systemctl status stepd-worker --no-pager"
```

- Cloud Run은 **비공개(IAM)**라 직접 URL 익명 접근은 403이 정상이다 (2026-07-16 실측). 직접 찌르려면:
  ```powershell
  curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" https://stepd-server-nsh6xfqyla-uc.a.run.app/health
  # {"ok":true,"ffmpeg":true} — ok=false면 DB 초기화 실패(DATABASE_URL/Cloud SQL 연결)
  ```
- 평소 경로는 `stepd.stepai.kr/api/*` — Vercel rewrite가 ID 토큰 프록시(`apps/web/src/app/api/proxy/`)로
  Cloud Run에 전달하므로 익명 200이다. `/health`는 `/api/*` 밖이라 프록시를 안 탄다.

## 1. 웹은 뜨는데 데이터가 전부 빈값

**증상**: 화면·사이드바는 정상인데 프로그램/회차/추천이 텅 비어 있다.

**원인**: `apps/web/src/lib/data/store.tsx`는 마운트 시 `fetchState()`(`/api/state`)를 부르고,
**실패하면 조용히 빈 상태로 남는다** — 에러 화면이 없어서 백엔드 장애가 "데이터 없음"처럼 보인다.
(과거엔 목 시드로 폴백해 **그럴싸한 가짜 데이터**가 보였다. 그런 화면이 보이면 낡은 프론트 빌드다.)

**진단 → 조치**:
1. `curl -s https://stepd.stepai.kr/api/state` — 200 + 실데이터면 프론트 문제(강력 새로고침), 아니면 §2로.
2. Vercel env `NEXT_PUBLIC_API_URL`은 **비어 있어야** 프록시를 탄다 — 값이 있으면 프록시를 우회해
   비공개 Cloud Run에 직접 붙다 403이 난다. 상세: [vercel-ops.md](vercel-ops.md).

## 2. 서버 5xx

**진단**:

```powershell
gcloud run services logs read stepd-server --region us-central1 --project step-d --limit 100
```

**조치** — 직전 배포가 원인이면 리비전 롤백(재빌드 없이 즉시):

```powershell
gcloud run revisions list --service stepd-server --region us-central1 --project step-d
gcloud run services update-traffic stepd-server --to-revisions <직전정상리비전>=100 --region us-central1 --project step-d
```

⚠️ Cloud Run만 되돌리면 **워커 VM은 새 코드로 남아 둘이 어긋난다.** 코드 자체가 문제면
`git revert` → `.\deploy\deploy-server.ps1`로 두 곳을 함께 되돌릴 것 ([deploy.md](deploy.md) 롤백 절).

## 3. 큐 적체 / 워커 스톨

**진단**: `curl -s https://stepd.stepai.kr/api/queue/stats`

| 패턴 | 의미 |
|---|---|
| `pending` 계속 증가, `running` 0 | 워커가 죽었다 → `journalctl` 확인 후 재시작 |
| `failed` 증가 | `job_queue.error` 컬럼이 원인 기록 (지수 백오프 5회 소진분) |
| `running`이 장시간 그대로 | 크래시로 잠긴 잡 — **30분 뒤 `requeueStale()`이 자동 회수**한다(기동 시 + 15분 tick, `queue.ts`). 급하면 워커 재시작 |

```powershell
gcloud compute ssh stepd-worker --zone us-central1-a --project step-d --command "sudo journalctl -u stepd-worker -n 100 --no-pager"
gcloud compute ssh stepd-worker --zone us-central1-a --project step-d --command "sudo systemctl restart stepd-worker"
# SIGTERM은 현재 잡을 마치고 종료한다(TimeoutStopSec=120) — 작업이 중간에 끊기지 않는다.
```

**video.\* 백로그가 content.analyze를 굶길 때** — 채널 팬아웃(`video.analyze`/`video.comments`)이
수백 건 쌓이면 업로드 분석이 뒤로 밀린다. 드레인 라우트(`index.ts`)가 있다:

```powershell
curl -X POST https://stepd.stepai.kr/api/admin/queue/purge -H "Content-Type: application/json" -d '{"confirm":"PURGE"}'
```

하는 일: ① `video.*` pending/failed 백로그 **삭제**(다음 15분 sweep이 due한 것만 다시 넣으니 안전)
② media가 사라진 좀비 `content.analyze` 삭제 ③ 살아있는 `content.analyze`를 attempts=0으로 즉시 재기동
④ master 미디어마다 분석 잡 존재 보장(재큐). 큐·잡 구조 상세: [worker-queue.md](worker-queue.md).

## 4. Cloud Run 메모리(OOM) — /tmp는 RAM이다

**증상**: 업로드/채택 몇 번 뒤 "Memory limit exceeded"로 인스턴스가 죽는다(상한 4Gi).

**원인**: Cloud Run의 `/tmp`는 **tmpfs(RAM)**. GCS 모드에서 ffmpeg 트림·썸네일은 파일을 `/tmp`로
내려받아 처리하는데, 지우지 않으면 요청마다 메모리가 쌓인다. 현행 코드는 finalize/adopt 경로의
`finally`에서 `fs.unlinkSync`로 정리한다(`index.ts`) — **새 임시파일 경로를 추가할 때 이 원칙을 지킬 것.**

**조치**: 로그에서 OOM 직전 요청 확인 → 정리 누락 경로를 고쳐 재배포. 당장은 리비전 재배포로
인스턴스를 갈아치우면 증상은 사라진다(근본 원인은 코드).

## 5. content.analyze 실패 (AI 분석)

**증상**: 회차 파이프라인이 "AI 분석 실패 — 재시도 필요"에 멈춘다.

**진단**:
1. `curl -s https://stepd.stepai.kr/api/media/<mediaId>/analysis` — 실패 시 `content_analysis.error`에
   원인이 저장된다(1000자 절단, `content-pipeline.ts`).
2. 워커 로그(§3)에서 `core.analyze exited <code>` — 파이썬 파이프라인 stdout/stderr가 journal에 그대로 나온다.
3. Vertex 쿼터: 파이프라인은 **`asia-northeast3`(서울)** 리전 Gemini를 쓴다(`VERTEX_LOCATION` 기본값,
   `content-pipeline.ts`). 429/RESOURCE_EXHAUSTED면 콘솔에서 서울 리전 Gemini 쿼터를 확인 —
   vision/names 단계가 프레임당 호출이라 쿼터를 가장 먼저 소진한다.

**재큐**: `POST /api/admin/queue/purge`(§3) — attempts를 리셋하고 master 미디어마다 잡을 보장하므로
실패·유실된 분석이 즉시 다시 돈다. 파이프라인 배선 상세: [content-pipeline-prod.md](content-pipeline-prod.md).

## 6. YouTube 토큰 (invalid_grant → revoked)

**증상**: 특정 채널의 동기화·애널리틱스가 멈추고 워커 로그에 `token revoked — channel ... parked`.

**흐름** (`youtube.ts` / `worker.ts`): 토큰 리프레시가 `invalid_grant`를 받으면 **터미널**이다
(`TokenRevokedError` — 재시도로 살아나지 않음) → 워커가 채널을 `status='revoked'`로 파킹하고
그 채널 잡을 전부 스킵한다. `POST /api/youtube/refresh`도 409 `revoked`를 돌려준다.

**복구는 재동의뿐**: 채널 소유자가 다시 OAuth를 통과해야 한다 — `/register`(외부 유튜버) 또는
배포채널 화면에서 재연결(`GET /api/youtube/auth`). 재동의하면 새 refresh token이 upsert되고 파킹이 풀린다.

참고: 403은 다른 문제다 — **스코프 부족 또는 쿼터 소진**이라 재시도하지 않는다(`withAccessToken`).
수익 지표는 monetary 스코프 재동의가 필요하다([infra.md](infra.md) 변경 이력 2026-07-16).

## 7. 배포가 안 나간다

| 증상 | 원인 → 조치 |
|---|---|
| Vercel 빌드가 UNKNOWN으로 무한대기 | **커밋 author가 Vercel 팀 멤버가 아님** — `contact@stepai.kr` author여야 한다. `deploy-web.ps1`이 자동 강제하니 스크립트로 배포할 것. 상세: [vercel-ops.md](vercel-ops.md) |
| `gcloud builds submit` 인증 오류 | gcloud 유저 인증 만료 → `gcloud auth login`. 안 되면 배포 SA 키로 `gcloud auth activate-service-account`(2026-07-16 전례, [infra.md](infra.md)) |
| 배포됐는데 옛 동작 | Cloud Run은 **푸시로 자동 배포되지 않는다**. `deploy-server.ps1` 실행 여부 확인. 워커만/서버만 올려 코드가 어긋난 경우도 여기 |

⚠️ 루트 `cloudbuild.yaml:37`과 `apps/server/cloudbuild.yaml`의 `--allow-unauthenticated`는 현재
IAM에 반영되지 않아 실효가 없지만(익명 403 실측), 배포 SA에 IAM 권한이 생기는 순간 **매 배포가
서비스를 공개로 뒤집는다** — 플래그 제거 권장. 현행 invoker는 `domain:stepai.kr` + 배포 SA뿐이다.

## 8. 시크릿 로테이션 / 키 유출 대응

**Secret Manager 시크릿** ([infra.md](infra.md)): `stepd-db-url`(Cloud Run 소켓) ·
`stepd-worker-db-url`(워커 TCP — 값이 다름!) · `stepd-google-client-id` · `stepd-google-client-secret` ·
`stepd-jwt-secret`(현재 코드에서 안 읽음) · `stepd-public-url`.

**로테이션 절차** — 새 버전 추가만으로는 반영되지 않는다:

```powershell
printf '<새값>' | gcloud secrets versions add <시크릿이름> --data-file=- --project step-d
# ① Cloud Run: :latest 바인딩은 리비전 생성 시점에 고정된다 → 재배포(deploy-server.ps1) 필요
# ② 워커 VM: 시크릿이 프로비저닝 때 /etc/stepd/worker.env에 박제된다(deploy/worker-vm.sh)
#    → SSH해서 worker-vm.sh의 "Secrets" 블록 재실행(또는 worker.env 수동 갱신) 후 systemctl restart stepd-worker
```

**키가 유출됐다면 (2026-07-14 사고 교훈 — SA 개인키가 공개 리포에 커밋됐었다)**:
1. **즉시 폐기가 먼저**: `gcloud iam service-accounts keys list/delete --iam-account stepd-deployer@step-d.iam.gserviceaccount.com` → 새 키 발급.
2. 유출 시크릿 전부 위 절차로 로테이션 (DB 비밀번호가 샜으면 Cloud SQL 유저 비밀번호 변경 → 두 DB URL 시크릿 갱신).
3. **git 히스토리 정리** — 커밋 삭제만으론 부족하다. 히스토리 재작성(filter-repo) + force push. 공개된 순간 이미 유출로 간주하고 1·2를 먼저 끝낼 것.
4. 예방: `.env*`·`gcp-keys/`는 gitignore — 커밋 전 `git status` 확인 (루트 CLAUDE.md 작업 규칙).

**YouTube refresh token 재발급**: 우리 쪽 파일이 아니라 DB(`youtube_channels.refreshToken`)에 있고,
재발급 수단은 채널 재동의(§6)뿐이다. OAuth **클라이언트 자체를 새로 만들면**(client ID 교체) 기존
refresh token이 전부 무효가 되어 **모든 채널이 재동의**를 거쳐야 한다 — 시크릿만 로테이션할 때도
서버·워커에 새 값이 반영되기 전까지는 토큰 리프레시가 실패하니 위 절차의 ①②를 곧바로 수행할 것.

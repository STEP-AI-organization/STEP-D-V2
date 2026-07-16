# 배포 방법 (한 장 요약)

> 코드를 고쳤으면 **커밋 → 스크립트 하나 실행**. 끝. 스크립트가 검증까지 자동으로 한다. 최종: 2026-07-16.

배포 대상이 3곳이고 반영 방식이 다르다. 그래서 스크립트로 묶었다.

| 무엇을 고쳤나 | 실행 | 반영되는 곳 |
|---|---|---|
| **프론트** (`apps/web/`) | `.\deploy\deploy-web.ps1` | Vercel |
| **백엔드** (`apps/server/`) | `.\deploy\deploy-server.ps1` | Cloud Run + 워커 VM |
| **Vercel env 변경** | 빈 커밋 → `.\deploy\deploy-web.ps1` | Vercel (재빌드 트리거) |

`deploy-web.ps1`에 재빌드 강제 옵션은 **없다** (파라미터는 `-SkipChecks`/`-SkipVerify` 뿐이고,
푸시할 커밋이 없으면 "이미 최신"으로 끝난다). env만 바꿨으면
`git commit --allow-empty -m "chore(web): trigger redeploy"`로 빈 커밋을 만들어 돌리거나
Vercel 대시보드에서 Redeploy 한다.

⚠️ **백엔드는 Cloud Run과 워커 VM 두 곳에서 같은 코드가 돈다.** 한쪽만 올리면 어긋나므로
`deploy-server.ps1`이 둘을 함께 처리한다. 절대 `gcloud builds submit`만 따로 돌리지 말 것.

---

## 사전 준비물

- **gcloud 인증** — `gcloud auth login` (Cloud Build 제출·워커 VM SSH에 필요)
- **pnpm install** — 루트에서 1회. 타입체크(`pnpm --filter @stepd/server typecheck`)와
  `next build`가 node_modules를 요구한다.
- **`gcp-keys/vercel-token.txt`** — Vercel API 토큰. 없어도 푸시·배포는 되지만
  `deploy-web.ps1`이 **빌드 감시를 건너뛰므로** 대시보드에서 직접 확인해야 한다.
  발급 방법은 [vercel-ops.md](vercel-ops.md).

---

## 프론트 고쳤을 때

```powershell
git add -A ; git commit -m "..."
.\deploy\deploy-web.ps1
```

스크립트가 하는 일:
1. 커밋 author를 `contact@stepai.kr`로 강제 — **Vercel은 author가 팀 멤버가 아니면 빌드를
   조용히 차단한다(UNKNOWN 무한대기).** 미푸시 커밋의 author가 다르면 재작성한다.
   상세는 [vercel-ops.md](vercel-ops.md).
2. `next build` 로컬 실행 — **깨지면 여기서 멈춘다** (프로덕션에 안 올라감)
3. `git push` → Vercel 자동 빌드
4. Vercel 빌드 완료까지 대기(토큰 없으면 스킵), 실패하면 상태 출력
5. `/`, `/channels`, `/register` 가 200인지 확인

옵션: `-SkipChecks` (로컬 빌드 생략 — 급할 때만), `-SkipVerify` (라이브 확인 생략)

## 백엔드 고쳤을 때

```powershell
git add -A ; git commit -m "..."
.\deploy\deploy-server.ps1
```

스크립트가 하는 일:
1. 서버 타입체크 — 깨지면 멈춤
2. `git push` (워커가 origin/main을 당겨가므로 선행)
3. `gcloud builds submit` → Cloud Run 배포 (수 분)
4. 워커 VM SSH → `git fetch --depth 1 origin main` + `git reset --hard origin/main` +
   `systemctl restart stepd-worker`. **pull이 아니라 reset --hard다** — VM에 남은 로컬 변경을
   버리고 origin/main과 정확히 일치시킨다. 소스만 갱신하므로 `core/` 파이썬 의존성이 바뀌었으면
   VM에서 별도로 설치해야 한다.
5. **검증**: `/api/state` 응답 + media에 `durationSec` 있는지(컬럼 버그 카나리아) + `/api/queue/stats`

옵션:
- `.\deploy\deploy-server.ps1 -SkipWorker` — Cloud Run만
- `.\deploy\deploy-server.ps1 -Only worker` — 워커만 재시작 (코드 변경 없이)
- `.\deploy\deploy-server.ps1 -WhatIf` — 뭐가 배포될지 미리보기

### 루트의 deploy.ps1 · deploy-worker.ps1은 뭔가

**정본은 `deploy/` 폴더의 두 스크립트다.** 리포 루트에 있는 것들은 부분 배포용 단축 스크립트:

- 루트 `deploy.ps1` — **Cloud Run만** 배포 (git pull → `gcloud builds submit` → `/health` 폴링).
  워커를 올리지 않는다.
- 루트 `deploy-worker.ps1` — **워커 VM만** 배포 (SSH → fetch + `reset --hard origin/main` → restart).

둘 다 `deploy-server.ps1`의 부분집합이고(`-SkipWorker` / `-Only worker`와 같은 일),
한쪽만 돌리면 Cloud Run과 워커의 코드가 어긋난다. 평소엔 `deploy\deploy-server.ps1`을 쓸 것.

---

## 정상 작동 확인 (스크립트가 자동으로 하지만, 수동으로도)

```powershell
# 1. 웹 — 브라우저로 열거나
curl https://stepd.stepai.kr/

# 2. 백엔드 살아있나
curl https://stepd.stepai.kr/api/state          # 200 + 데이터

# 3. 큐 · 워커 건강 (가장 중요)
curl https://stepd.stepai.kr/api/queue/stats
#   {"pending":0,"running":1,"done":42,"failed":0}
#   → pending이 계속 쌓이면 워커 VM이 죽은 것. failed가 늘면 job_queue.error 확인.

# 4. 워커 로그 (문제 있을 때)
gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo journalctl -u stepd-worker -n 30 --no-pager"

# 5. 특정 채널 분석 데이터 확인
curl "https://stepd.stepai.kr/api/youtube/analytics/CHANNEL_ID/daily?days=90"
```

### "배포됐다"고 방심하지 말 것 — 이걸로 여러 번 데였다

- Cloud Run은 **GitHub 푸시로 자동 배포되지 않는다.** 서버 고치고 `deploy-server.ps1`을
  안 돌리면 옛 코드가 계속 돈다. (Vercel만 자동이다.)
- `media`에 `durationSec`이 없으면 → **옛 Cloud Run 코드가 도는 것.** 다시 배포.
- `/api/queue/stats`의 `pending`이 안 줄면 → **워커 VM이 죽은 것.** 로그 확인.

---

## 롤백 (잘못 배포했을 때)

**Cloud Run** — 이전 리비전으로 트래픽을 되돌린다 (재빌드 없이 즉시):

```powershell
# 리비전 목록에서 직전 정상 리비전 확인
gcloud run revisions list --service stepd-server --region us-central1 --project step-d

# 해당 리비전으로 트래픽 100% 복귀
gcloud run services update-traffic stepd-server --to-revisions <리비전이름>=100 --region us-central1 --project step-d
```

**워커 VM · Vercel** — 리비전 트래픽 전환이 없다. `git revert <커밋>` 후 해당 스크립트로 재배포
(`deploy-server.ps1` / `deploy-web.ps1`).

⚠️ Cloud Run만 이전 리비전으로 돌리면 **워커는 새 코드로 남아 둘이 어긋난다.** 코드 자체가
문제면 `git revert` → `deploy-server.ps1`로 두 곳을 함께 되돌리는 것이 안전하다.

---

## 채널 자동 분석은 어떻게 도는가 (참고)

```
유튜버 채널 연결 (OAuth)
  → Cloud Run이 job_queue에 enqueue (즉시)
  → 워커 VM이 큐에서 꺼내 분석 (영상 동기화 + Analytics 수집)
```

Cloud Run 배포를 깜빡해도 **워커가 15분마다 전 채널을 스윕**해서 아직 분석 안 된 채널을
자동으로 잡는다. 즉 자동 분석의 최종 보증은 워커다. 다만 즉시성·조회 API를 위해
백엔드 배포는 여전히 필요하다.

## 워커 VM 관리

```powershell
# 상태
gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo systemctl status stepd-worker"

# 실시간 로그
gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo journalctl -u stepd-worker -f"

# 재시작 (현재 잡을 마치고 재시작 — 작업 안 끊김)
gcloud compute ssh stepd-worker --zone us-central1-a --command "sudo systemctl restart stepd-worker"
```

프로비저닝·시크릿 등 상세는 [worker-queue.md](worker-queue.md), Vercel 상세는 [vercel-ops.md](vercel-ops.md).

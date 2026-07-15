# 배포 방법 (한 장 요약)

> 코드를 고쳤으면 **커밋 → 스크립트 하나 실행**. 끝. 스크립트가 검증까지 자동으로 한다.

배포 대상이 3곳이고 반영 방식이 다르다. 그래서 스크립트로 묶었다.

| 무엇을 고쳤나 | 실행 | 반영되는 곳 |
|---|---|---|
| **프론트** (`apps/web/`) | `.\deploy\deploy-web.ps1` | Vercel |
| **백엔드** (`apps/server/`) | `.\deploy\deploy-server.ps1` | Cloud Run + 워커 VM |
| **Vercel env 변경** | `.\deploy\deploy-web.ps1 -Force` | Vercel (재빌드 강제) |

⚠️ **백엔드는 Cloud Run과 워커 VM 두 곳에서 같은 코드가 돈다.** 한쪽만 올리면 어긋나므로
`deploy-server.ps1`이 둘을 함께 처리한다. 절대 `gcloud builds submit`만 따로 돌리지 말 것.

---

## 프론트 고쳤을 때

```powershell
git add -A ; git commit -m "..."
.\deploy\deploy-web.ps1
```

스크립트가 하는 일:
1. `next build` 로컬 실행 — **깨지면 여기서 멈춘다** (프로덕션에 안 올라감)
2. `git push` → Vercel 자동 빌드
3. Vercel 빌드 완료까지 대기, 실패하면 빌드 로그 출력
4. `/`, `/register`, `/privacy` 가 200인지 확인

## 백엔드 고쳤을 때

```powershell
git add -A ; git commit -m "..."
.\deploy\deploy-server.ps1
```

스크립트가 하는 일:
1. 서버 타입체크 — 깨지면 멈춤
2. `git push` (워커가 origin/main을 pull하므로 선행)
3. `gcloud builds submit` → Cloud Run 배포 (수 분)
4. 워커 VM SSH → `git pull` + `systemctl restart stepd-worker`
5. **검증**: `/api/state` 응답 + media에 `durationSec` 있는지(컬럼 버그 카나리아) + `/api/queue/stats`

옵션:
- `.\deploy\deploy-server.ps1 -SkipWorker` — Cloud Run만
- `.\deploy\deploy-server.ps1 -Only worker` — 워커만 재시작 (코드 변경 없이)
- `.\deploy\deploy-server.ps1 -WhatIf` — 뭐가 배포될지 미리보기

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

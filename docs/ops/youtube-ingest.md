# 유튜브 가져오기 경로 — 윈도우2 다운로드 배선 (2026-08-14)

> **한 줄 요약**: 유튜브 다운로드는 **윈도우2(한국 IP)** 가 받고, 분석부터는 클라우드가 잇는다.
> 유튜브가 데이터센터 IP(Cloud Run)를 쿠키를 물려도 봇으로 판정해 다운로드가 **상시 실패**했다
> — 우회가 아니라 구조를 바꾼 것이다.

## 경로 전체

```
[사용자] POST /api/media/from-youtube  (잔액 402 게이트)
    → youtube.download 큐잉 (download 레인)
        → [윈도우2] worker:naver 런처 (WORKER_JOBS=naver,download 코드 고정)
           yt-dlp 로 다운로드 (한국 IP → 봇 판정 없음)
           → GCS(stepd-media) 업로드
           → checkCredits(실측 길이) 정밀 판정 → content.analyze 큐잉
        → [클라우드] stepd-worker-content 가 분석 (STT→beat→추천→검색 인덱싱)
        → (자동화 규칙 있으면) 채택 → 렌더 → 배포
```

## 구성요소와 위치

| 구성요소 | 위치 | 비고 |
|----------|------|------|
| download 레인 정의 | `apps/server/src/worker.ts` `JOB_LANES.download` | `youtube.download` 하나. **머신 전용 레인** — all/content 워커는 안 집는다 (`worker-lanes.test.ts` 가 강제) |
| 윈도우2 런처 | `apps/server/scripts/worker-naver.mts` | `WORKER_JOBS=naver,download` **코드 고정** (env 로 못 뒤집음) |
| 부팅 게이트 예외 | `worker.ts` `YT_FREE` | naver·gebd·download(조합 포함)는 GOOGLE_CLIENT_ID 불요 — 예외에 없으면 **부팅 즉시 exit(1) 인데 작업 스케줄러는 Running 으로 보임** |
| yt-dlp (윈도우2) | `C:\Users\STEPAI04\tools\node-v24.18.0-win-x64\yt-dlp.exe` | PATH 에 있음. 갱신: 같은 경로에 최신 exe 덮어쓰기 |
| GCS 쓰기 권한 | `stepd-naver-worker@step-d.iam` → `gs://stepd-media` objectAdmin | 읽기만 있던 SA 라 업로드 403 났었음 (2026-08-14 부여) |
| 클라우드 yt-dlp (예비) | `apps/server/Dockerfile.worker` — corevenv 에 pip 설치 + deno + `YT_DLP` env | download 레인이 윈도우2로 갔으므로 평시엔 안 쓰이지만, 비상시 레인을 되돌릴 수 있게 유지 |
| 쿠키 (예비) | 시크릿 `stepd-ytdlp-cookies` → content 잡에 `/secrets/ytdlp/cookies.txt` 마운트, `runYtDlp` 가 **tmp 사본**으로 전달 | 시크릿 마운트는 읽기 전용인데 yt-dlp 는 종료 시 쿠키를 **되쓴다**(EROFS) — 그래서 사본 |

## 밟았던 함정 7개 (재발 방지 포함)

1. **클라우드 이미지에 yt-dlp 없음** → Dockerfile.worker 에 설치.
2. **유튜브 봇 판정** — 데이터센터 IP 는 쿠키를 물려도 "Sign in to confirm you're not a bot".
   → **다운로드를 윈도우2 레인으로 이동** (이 문서의 존재 이유).
3. **읽기 전용 시크릿에 쿠키 되쓰기(EROFS)** → `runYtDlp` 가 tmp 사본을 만들어 전달.
4. **깨진 CORE_PYTHON/CORE_DIR(윈도우 경로) env 가 잡에 눌러앉음** + ⚠️ **jobs 의
   `--remove-env-vars` 는 Done 을 찍고도 조용히 무시된다** → 지우지 말고 정답
   (`/opt/corevenv/bin/python` · `/app`)으로 `--update-env-vars` 덮어쓰기.
   `deploy/cloud.sh do_worker` 가 배포마다 자가 치유(MSYS 변환 차단 포함).
5. **윈도우2 부팅 게이트** — `naver,download` 조합이 OAuth 검증 예외에 없어 즉사 → `YT_FREE` 확장.
6. **윈도우2에도 yt-dlp 없음** → 위 경로에 exe 설치.
7. **윈도우2 SA 의 GCS 쓰기 권한 없음(403)** → objectAdmin 부여.

## 안 될 때 보는 순서

1. **잡이 pending 인 채 안 집힘** — 윈도우2 워커 생존 확인:
   `ssh STEPAI04@192.168.13.14` 로 node.exe 프로세스 확인. **작업 스케줄러 Running ≠ 프로세스 생존**
   (부팅 게이트로 즉사해도 Running 으로 보인다). 재시작:
   `Stop-ScheduledTask STEPD-Naver-Worker; Start-ScheduledTask STEPD-Naver-Worker`
2. **yt-dlp 오류** — 윈도우2에서 `yt-dlp --version`. 봇 판정이 윈도우2에서도 나면(드묾)
   실브라우저 쿠키를 내보내 `--cookies` 로 (deploy-win2.md 참고).
3. **GCS 403** — SA 권한 확인: `gcloud storage buckets get-iam-policy gs://stepd-media`.
4. **다운로드는 done 인데 분석이 안 돎** — 잔액 확인(크레딧 부족이면 회차 노트에 남는다),
   클라우드 content 워커 로그에서 `content.analyze m_...` 확인.
5. **잡 자체가 종결(failed·attempts 소진)** — 원인 해결 후 회차에서 링크 재등록이 정석.
   (급하면 윈도우2에서 job_queue 를 직접 pending 으로 되돌릴 수 있으나 원인 해결이 먼저다.)

## 관련 문서

- [deploy-win2.md](deploy-win2.md) — 윈도우2 배포·자가 갱신·SSH 경로
- [worker-queue.md](worker-queue.md) — 큐·레인 구조 전반
- `CLAUDE.md` §워커 — 레인 5개 요약 (content · youtube · gebd · naver · **download**)

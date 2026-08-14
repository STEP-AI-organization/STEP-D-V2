# 윈도우2 배포 — 윈도우1 에서 하는 법

> **머신 호칭**
>
> | 이름 | 정체 | 주소 |
> |---|---|---|
> | **윈도우1** | 개발·배포 PC. **배포는 전부 여기서 나간다** | `desktop-c5bdabc` |
> | **윈도우2** | 네이버 발행 + **유튜브 다운로드** 워커 (한국 IP 상시 PC) | `DESKTOP-IGVKIBN` · `192.168.13.14` · 계정 `STEPAI04` · 리포 `C:\Users\STEPAI04\STEP-D-V2` |

> 2026-08-14 부터 윈도우2 는 `naver,download` 두 레인을 돈다 — 유튜브 다운로드 배선 전체는
> [youtube-ingest.md](youtube-ingest.md) 참고 (밟은 함정 7개·점검 순서 포함).

최초 셋업은 [deploy/naver-pc/README.md](../../deploy/naver-pc/README.md) 다. **이 문서는 그 뒤,
"코드 고쳤는데 윈도우2 에 어떻게 반영하지?" 하나만 다룬다.**

---

## 결론부터 — 보통은 아무것도 안 해도 된다

```
git push origin HEAD:main     ← 이걸로 끝
```

윈도우2 는 **10분마다 스스로 `origin/main` 을 당겨 워커를 재시작한다**(작업 스케줄러 ·
`self-update.ps1`). 변경이 없으면 재시작도 안 한다 — 발행 중인 잡이 끊기지 않게.

왜 밀지 않고 당기는가: 윈도우2 는 사무실 NAT 뒤라 밖에서 밀어넣으려면 포트포워딩·고정IP·
키 관리가 전부 유지보수 부담이 된다. **당겨오는 쪽은 설정할 게 없다.**

---

## 즉시 반영이 필요할 때

10분을 못 기다리겠으면 윈도우1 에서 찌른다.

```powershell
.\deploy\naver-pc\push-update.ps1 -TargetHost 192.168.13.14 -User STEPAI04
```

같은 LAN 이라 **VPN·Tailscale 이 필요 없다.** 내부 IP 로 바로 닿는다.
(윈도우2 가 다른 망에 있을 때만 Tailscale 이름을 쓴다.)

> ⚠️ 이건 **빠른 경로일 뿐 보장 경로가 아니다.** PC 가 꺼져 있거나 SSH 가 막히면 실패하고,
> 그때는 폴링이 나중에 따라잡는다. **폴링(작업 스케줄러)을 지우지 말 것.**

> ⚠️ 자가 갱신은 **자기 자신을 갱신하는 커밋에서 한 박자 늦는다.** `self-update.ps1` 자체를
> 고쳤다면, 첫 실행은 옛 코드로 돌아 pull 만 하고 새 코드는 다음 회차부터 적용된다.
> 급하면 두 번 돌린다.

---

## 반영됐는지 확인

```powershell
# 윈도우1 에서 한 줄로
ssh STEPAI04@192.168.13.14 "powershell -NoProfile -Command \"cd C:\Users\STEPAI04\STEP-D-V2; git rev-parse --short HEAD; Get-ScheduledTask STEPD-* | Select-Object TaskName,State\""
```

기대값 — 커밋 해시가 윈도우1 의 `git rev-parse --short origin/main` 과 같고, 아래 둘이 `Running`:

| 작업 | 역할 |
|---|---|
| `STEPD-CloudSQL-Proxy` | 프로덕션 큐(`job_queue`) 접속용 프록시 · 127.0.0.1:5432 |
| `STEPD-Naver-Worker` | 워커 본체 · `lane=naver` |

갱신 이력은 윈도우2 의 `~/.stepd/self-update.log` 에 쌓인다.

---

## 코드가 아니라 **설정**을 바꿨을 때

**자가 갱신은 코드만 당긴다.** 아래는 자동으로 안 따라오므로 사람이 한 번 해야 한다.

| 바뀐 것 | 해야 할 일 |
|---|---|
| `apps/server/.env` (DATABASE_URL·NAVER_SESSION_KEY 등) | 윈도우2 에서 직접 수정 → 워커 재시작 |
| 작업 스케줄러 등록 내용 (실행 경로·인자) | `install.ps1` 다시 실행 |
| GCP 서비스 계정 키 | 파일 교체 → 워커 재시작 |
| 네이버 로그인 세션 | 아래 참고 |

`.env` 를 원격에서 고칠 때는 **줄바꿈을 조심할 것.** 개행 없이 append 하면
`NAVER_MIN_GAP_MS=60000NAVER_SESSION_KEY=...` 처럼 한 줄이 뭉쳐서, 값이 조용히 망가진다
(2026-08-11 실측 — 증상이 "워커는 뜨는데 세션을 못 푼다" 라 원인이 안 보인다).

```powershell
# 워커만 재시작
ssh STEPAI04@192.168.13.14 "powershell -NoProfile -Command \"Stop-ScheduledTask STEPD-Naver-Worker; Start-ScheduledTask STEPD-Naver-Worker\""
```

---

## 네이버 로그인 세션

**서버에 등록하는 쪽이 기본이다** — 그러면 워커가 어느 머신이든 받아 쓰고, 윈도우2 앞에
갈 필요가 없다. 배포채널 화면의 계정 카드가 명령을 주소까지 채워서 보여준다.

```powershell
pnpm --filter @stepd/server naver:login:upload -- --account <nva_xxx> --api <프록시주소> --web https://stepd.stepai.kr
```

⚠️ **브라우저 창이 뜨는 건 이때뿐이다.** 워커는 headless 라 창이 안 뜬다 — 윈도우2 를 누가
쓰고 있어도 방해되지 않는다. 반대로 **SSH 로는 이 명령을 못 돌린다**(GUI 를 못 띄운다).
윈도우2 앞에 앉거나 원격데스크톱이 필요하고, 그게 싫으면 윈도우1 에서 돌려도 된다 —
세션은 어차피 서버로 올라간다.

---

## 안 될 때 보는 순서

1. **켜져 있나** — `ping 192.168.13.14`
2. **SSH 되나** — `ssh STEPAI04@192.168.13.14 hostname` → `DESKTOP-IGVKIBN`
   (관리자 계정은 `administrators_authorized_keys` 를 쓴다. 개인키 권한이 넓으면 조용히 거부된다.)
3. **작업 둘 다 Running 인가** — 위 확인 명령
4. **잡을 집고 있나** — 워커 로그에 `lane=naver · claims=naver.publish`
5. **큐에 있는데 아무도 안 집나** — ⚠️ **다른 워커 프로세스가 떠 있는지부터 본다.**
   2026-08-11 에 5일간 구버전으로 돌던 워커가 `naver.publish` 를 가로채 계속 실패시켰다.
   증상이 "잡은 조용히 실패하는데 전용 워커는 큐가 비어 보임" 이라 원인을 찾기 어렵다.
   (지금은 `ALL_LANE_TYPES` 가 막지만, 아주 옛 프로세스면 그 코드가 없다.)

---

## 관련 문서

- [deploy/naver-pc/README.md](../../deploy/naver-pc/README.md) — 최초 셋업 (클론 후 이것만 보면 된다)
- [docs/ops/naver-publish.md](naver-publish.md) — 네이버 발행 운영 상세
- [docs/ops/deploy.md](deploy.md) — 서버·워커·웹 배포 (클라우드 쪽)

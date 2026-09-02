# 윈도우2 배포 — 윈도우1 에서 하는 법

> **머신 호칭**
>
> | 이름 | 정체 | 주소 |
> |---|---|---|
> | **윈도우1** | 개발·배포 PC. **배포는 전부 여기서 나간다** | `desktop-c5bdabc` |
> | **윈도우2** | 네이버 발행 + **유튜브 다운로드** 워커 (한국 IP 상시 PC) | `DESKTOP-IGVKIBN` · `192.168.13.14` · 계정 `STEPAI04` · 리포 `C:\Users\STEPAI04\STEP-D-V2` |

> 2026-08-14 부터 윈도우2 는 `naver,download` 두 레인을 돈다 — 유튜브 다운로드 배선 전체는
> [youtube-ingest.md](youtube-ingest.md) 참고 (밟은 함정 7개·점검 순서 포함).
>
> 2026-08-27 부터 **`commerce` 레인이 추가**됐다(쿠팡 제휴 링크 발급). 한국 IP + 화면 있는
> 크롬이 필요해 이 PC 여야 한다 — 아래 "커머스 레인 켜기" 참고.

최초 셋업은 [deploy/naver-pc/README.md](../../deploy/naver-pc/README.md) 다. **이 문서는 그 뒤,
"코드 고쳤는데 윈도우2 에 어떻게 반영하지?" 하나만 다룬다.**

---

## 결론부터 — 보통은 아무것도 안 해도 된다

```
git push origin HEAD:main     ← 이걸로 끝
```

윈도우2 는 **10분마다 스스로 `origin/main` 을 당겨 워커를 재시작한다**(작업 스케줄러 ·
`self-update.ps1`). 변경이 없으면 재시작도 안 한다 — 발행 중인 잡이 끊기지 않게.

재시작 대상은 **이 PC 의 워커 프로세스 전부**다 — `STEPD-Naver-Worker` ·
`STEPD-Render-Server` · `STEPD-Render-Worker`. 등록 안 된 작업은 건너뛴다.

> ⚠️ 2026-09-02 이전에는 **네이버 워커 하나만** 재시작했다. 그래서 렌더 프로세스 둘이 옛
> 코드로 남았고, `git rev-parse` 로 보면 최신인데 **결과물만 옛날**이 됐다(실측: 렌더 서버가
> 8/31 코드로 이틀을 돌아 새로 넣은 글꼴 3종이 말없이 프리텐다드로 폴백). 렌더는 실패가
> 아니라 **다른 결과물**로 나타나서 더 안 보인다 — 배포 후 프로세스 시작 시각을 볼 것:
> `Get-Process -Name node | Select-Object Id,StartTime`

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
| **커머스(쿠팡) 레인 추가** | 아래 "커머스 레인 켜기" — env 2개 + 계정 세션 등록 |

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

## 커머스 레인 켜기 (쿠팡 제휴 링크 · 2026-08-27 추가)

윈도우2 는 이제 `naver,download,**commerce**` 세 레인을 돈다(런처가 고정). 커머스가 여기인
이유 둘 — ① **한국 IP**(파트너스 콘솔이 Akamai) ② **화면 있는 크롬**: headless 는 세션이
유효해도 차단된다(실측 2026-08-27 · Access Denied). 그래서 Cloud Run 에 못 올린다.

코드는 자가 갱신이 당겨오지만 **아래 셋은 사람이 한 번 해야 한다.**

### 1) `.env` 에 두 줄 (윈도우2 에서 직접)

```
COMMERCE_LINKS_ENABLED=1
COMMERCE_SESSION_KEY=<Secret Manager stepd-commerce-session-key 와 **같은 값**>
```

키 값 꺼내기(윈도우1 에서):
```bash
CLOUDSDK_CORE_ACCOUNT=stepd-deployer@step-d.iam.gserviceaccount.com \
  gcloud secrets versions access latest --secret=stepd-commerce-session-key --project step-d
```

⚠️ **서버와 같은 키여야 한다.** 서버가 봉인한 세션을 워커가 푸는 구조라, 키가 다르면
복호화가 조용히 실패하고 "세션 없음" 으로 끝난다(에러가 아니라 0건 발급이다).
⚠️ 개행 없이 append 하면 앞 줄과 뭉쳐 값이 망가진다 — 위 `.env` 주의사항과 같다.

### 2) 회사 계정 세션 등록 (회사마다 한 번)

**회사마다 자기 법인 파트너스 계정을 쓴다** — 커미션 정산이 계정 단위라, 남의 계정으로
발급하면 수익이 엉뚱한 회사로 귀속된다. 계정이 없으면 서버가 아예 큐잉을 안 한다.

```powershell
pnpm --filter @stepd/server commerce:login -- --api <서버주소> --web https://stepd.stepai.kr --label "회사이름"
```

브라우저가 뜨고 **두 번 로그인**한다 — STEP D 에 한 번(어느 워크스페이스인지), 쿠팡파트너스에
한 번(어느 계정인지). 그러면 세션이 봉인돼 서버에 올라가고 워커가 받아 쓴다.
네이버와 마찬가지로 **SSH 로는 못 돌린다**(GUI 필요) — 윈도우2 앞이나 원격데스크톱,
혹은 윈도우1 에서 돌려도 된다(세션은 어차피 서버로 간다).

세션이 만료되면 `/commerce` 화면이 "로그인이 만료됐습니다" 라고 말한다 — 같은 명령을 다시.

### 3) 워커 재시작

```powershell
ssh STEPAI04@192.168.13.14 "powershell -NoProfile -Command \"Stop-ScheduledTask STEPD-Naver-Worker; Start-ScheduledTask STEPD-Naver-Worker\""
```

로그에 `lane=naver,download,commerce · claims=naver.publish,youtube.download,commerce.link` 가
찍히면 된 것이다.

> ⚠️ **크롬이 필요하다.** 발급은 실제 크롬 창을 띄운다(headless 불가). 윈도우2 에 크롬이
> 설치돼 있어야 하고, **데스크톱 세션이 살아 있어야 한다** — 로그아웃 상태로 두면 창을
> 못 띄운다. 작업 스케줄러 등록이 "사용자가 로그온한 경우에만 실행" 인지 확인할 것.

---

## 렌더 레인 (2026-08-31 추가 · **셋업 완료**)

윈도우2 가 **클립 렌더(ffmpeg 인코딩)** 를 당겨간다. 다른 레인과 이유가 다르다 — 한국 IP 나
브라우저가 아니라 **CPU** 다. 렌더는 건당 50~90초로 이 리포에서 CPU 를 통째로 쓰는 유일한
일이고, 그래서 클라우드 순방이 스스로를 `AUTOMATION_MAX_RENDERS_PER_TICK=8` 로 묶는다.
이 PC(i7-9700K 8코어 · 32GB)가 놀고 있어 그리로 넘긴다.

**이 PC 에 프로세스가 둘 뜬다** — 워커만으로는 안 된다:

| 작업 | 하는 일 |
|---|---|
| `STEPD-Render-Server` | 로컬 서버(`PORT=4100`). **렌더가 실제로 도는 곳** |
| `STEPD-Render-Worker` | `clip.render` 잡을 집어 `http://127.0.0.1:4100/api/clips/:id/export` 를 부른다 |

왜 워커가 직접 인코딩하지 않는가: 렌더 로직(자막 ASS·훅 프리롤·오버레이 PNG·리프레임 플랜)이
그 라우트에 있다. 워커로 복제하면 두 벌이 갈라지고, 그 순간부터 "편집기 미리보기와 결과물이
다르다" 가 시작된다. 그래서 **코드는 한 벌**이고 어느 CPU 가 그걸 실행하느냐만 바꾼다.

`.env` 에 넣은 값 (2026-08-31):

```
INTERNAL_API_TOKEN=…      # 워커→로컬서버 내부 인증. 클라우드와 같은 값(secret stepd-factory-api-key)
AUTH_REQUIRED=1           # 프로덕션과 같은 자세
PORT=4100                 # 로컬 서버 포트
RENDER_API_BASE=http://127.0.0.1:4100
```

⚠️ **클라우드 쪽 스위치는 아직 OFF 다.** `stepd-worker-youtube` 에 `RENDER_VIA_QUEUE=1` 을
줘야 순방이 `/export` 직접 호출 대신 `clip.render` 를 큐에 넣는다. 그 전까지는 종전대로
클라우드가 굽고, 이 PC 의 두 프로세스는 놀고만 있다(해롭지 않다).

⚠️ **이 PC 가 꺼져도 배포는 나가야 한다**(ENA 는 계약 물량이다). `clip.render` 가
`RENDER_QUEUE_STALL_MS`(기본 10분) 넘게 방치되면 순방이 감지해 **클라우드가 직접 렌더한다.**

확인 (윈도우2 에서):

```powershell
Invoke-WebRequest http://127.0.0.1:4100/health -UseBasicParsing   # {"ok":true,"ffmpeg":true,...}
Get-Content $env:USERPROFILE\.stepd\logs\render-worker.out.log -Tail 5
```

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

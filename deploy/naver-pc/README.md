# 윈도우2 (네이버 워커) 셋업

> **머신 호칭** — 문서·대화에서 "이 컴/저 컴" 대신 아래를 쓴다.
>
> | 이름 | 정체 | Tailscale |
> |---|---|---|
> | **윈도우1** | 개발·배포 PC (배포는 여기서 나간다) | `desktop-c5bdabc` / `100.85.157.120` |
> | **윈도우2** | **이 문서의 대상** — 네이버 워커 전용 | 아래 1단계에서 등록 |

윈도우2 는 **네이버 TV·클립 발행만** 담당한다. 다른 잡은 집지 않는다.

왜 클라우드가 아닌가: 네이버는 공개 업로드 API 가 없어 브라우저 자동화가 유일한데,
해외 데이터센터 IP(Cloud Run)로 로그인하면 캡차·2차인증에 막힌다. 그래서 **한국 IP 의
상시 PC 한 대**가 필요하다. GEBD 를 GPU VM 전용 레인으로 뺀 것과 같은 구조다.

운영 상세는 [docs/ops/naver-publish.md](../../docs/ops/naver-publish.md).

> 이 문서는 리포 안에 있다. 윈도우2 에서 **먼저 클론하고 열어도 된다** — 2단계를 1단계보다
> 먼저 해도 무방하다.
> ```powershell
> git clone https://github.com/STEP-AI-organization/STEP-D-V2.git $env:USERPROFILE\STEPD-repo
> ```

---

## 0. 준비물

- Windows 10/11 (윈도우2), **절전·최대절전 끔** (잠들면 잡을 못 집는다)
- Node ≥22 · pnpm · git
- 네이버 계정 (발행할 채널의 주인)
- GCP 서비스 계정 키 2종 — Cloud SQL 접속용(`roles/cloudsql.client`),
  GCS 읽기용. **리포 안에 두지 말 것.**

---

## 1. 원격 접속 (SSH)

윈도우1 이 배포 직후 윈도우2 를 갱신하기 위한 통로다.

**같은 LAN 이면 이것만 하면 된다** — 내부 IP·호스트명으로 바로 닿는다.
Tailscale 은 **윈도우2 가 다른 망에 있거나 재택에서 붙어야 할 때만** 필요하다
(그때는 `winget install tailscale.tailscale` → `tailscale up`).

> LAN 으로 갈 거면 **DHCP 고정 할당**을 걸어두는 편이 낫다. IP 가 바뀌면 자동 갱신이
> 조용히 실패한다 — 폴링이 백스톱이라 치명적이진 않지만 원인 찾기가 번거롭다.

```powershell
# OpenSSH Server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic
Start-Service sshd
```

윈도우1(`desktop-c5bdabc`)의 공개키를 등록한다.

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKh3WFBK1kFd1mwQF9m+lbJ1hX4Gw1vJCWmf62MuRYDu hkj@stepai.kr
```

> ⚠️ **관리자 계정은 `~/.ssh/authorized_keys` 를 읽지 않는다.** Windows 특유의 함정으로,
> `C:\ProgramData\ssh\administrators_authorized_keys` 를 써야 한다. 권한도 잠가야
> sshd 가 파일을 무시하지 않는다.

```powershell
$f = "C:\ProgramData\ssh\administrators_authorized_keys"
Add-Content -Path $f -Value "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKh3WFBK1kFd1mwQF9m+lbJ1hX4Gw1vJCWmf62MuRYDu hkj@stepai.kr" -Encoding utf8
icacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

확인:
```powershell
hostname
ipconfig | Select-String IPv4        # 같은 LAN 이면 이 주소를 쓴다
# tailscale status                   # Tailscale 을 쓸 때만
```
→ **호스트명(또는 내부 IP)을 알려줄 것.** 윈도우1 에서 이걸로 원격 갱신을 찌른다.

---

## 2. 리포 + 의존성

```powershell
git clone https://github.com/STEP-AI-organization/STEP-D-V2.git $env:USERPROFILE\STEPD-repo
cd $env:USERPROFILE\STEPD-repo
pnpm install
npx playwright install chromium          # ~150MB
```

---

## 3. Cloud SQL 접속

프로덕션 큐(`job_queue`)를 봐야 하므로 **Cloud SQL Auth Proxy** 를 상시 띄운다.

```powershell
cloud-sql-proxy step-d:us-central1:stepd-db --port 5432
```

프록시도 워커와 함께 **항상** 떠 있어야 한다. `install.ps1` 이 작업 스케줄러에
`STEPD-CloudSQL-Proxy` 로 등록한다(로그온 시 시작 · 죽으면 1분 뒤 재시작 · 시간제한 없음).

> pm2 는 쓰지 않는다. Windows 에서 두 번 막혔다 — pm2 가 프록시의 `--port` 를 자기 옵션으로
> 먹고, pm2 로 pnpm 을 띄우면 빌드 승인 문제로 exit 1 이 나 워커가 아예 안 뜬다.

---

## 4. `apps/server/.env`

```
DATABASE_URL=postgresql://<user>:<pw>@localhost:5432/stepd
GCS_BUCKET=stepd-media
GOOGLE_APPLICATION_CREDENTIALS=<GCS 읽기 키 경로>
NAVER_UPLOAD_ENABLED=1
```

- `WORKER_JOBS` 는 **넣지 않는다.** `worker:naver` 런처가 레인을 코드로 고정한다.
- `NAVER_UPLOAD_ENABLED` 가 없으면 업로드가 **안 된다**(게이트 기본 OFF). 의도된 방향이다 —
  잘못된 env 의 실패 모드는 "업로드 안 됨" 이어야지 "실수로 업로드됨" 이면 안 된다.
- `.env` 는 `.gitignore` 대상이다. 커밋 전 `git status` 확인.

---

## 5. 네이버 로그인 (사람이 직접, 1회)

```powershell
pnpm --filter @stepd/server naver:login
# 고객사 계정이 여럿이면: naver:login --account <accountKey>
```

⚠️ **이때만 브라우저 창이 뜬다.** 워커는 headless 로 돌아 창이 안 뜬다 — 윈도우2 를
누가 쓰고 있어도 방해되지 않는다. 로그인은 윈도우2 앞에 있거나 원격데스크톱(Tailscale
위로 RDP)이 필요하다. SSH 로는 GUI 를 못 띄운다.

브라우저가 뜨면 **2차인증까지** 끝낸다. 코드는 아이디·비밀번호를 만지지 않는다.
끝나면 `~/.stepd/naver-storage-state.json` 에 세션이 저장된다.

> ⚠️ 이 파일은 **로그인 쿠키 그 자체다.** 커밋·복사·전송 금지, 클라우드에 올리지 않는다.

세션은 언젠가 만료된다. 잡이 `네이버 세션이 만료됐습니다` 로 실패하면 이 명령을 다시 돌린다.

---

## 6. 설치 (한 번)

```powershell
.\deploy\naver-pc\install.ps1
```

작업 스케줄러에 세 개를 건다 — `STEPD-CloudSQL-Proxy` · `STEPD-Naver-Worker` ·
**10분마다 origin/main 을 당겨 재시작**하는 자가 갱신. 이후 **배포는 `main` 에 push 하는 것으로 끝난다** — 윈도우2 는 알아서 따라온다.
급하면 윈도우1 에서 Tailscale 로 즉시 갱신을 찌를 수도 있다(`push-update.ps1`).

---

## 7. 확인

```powershell
Get-ScheduledTask STEPD-*                # 둘 다 Running 이어야 한다
Get-Process node -ErrorAction Ignore     # 워커 프로세스
Get-Content $env:USERPROFILE\.stepd\self-update.log -Tail 20
```

발행까지 실제로 돌려보려면(로컬 DB 가 아니라 프로덕션 큐를 쓰므로 주의):

```powershell
pnpm --filter @stepd/server naver:e2e-seed <세로영상.mp4>
```
로그에 `naver.publish … 완료 → https://clipcreators.naver.com/…` 가 뜨면 정상이다.

---

## 문제 해결

| 증상 | 원인·조치 |
|---|---|
| 잡이 안 잡힌다 (큐는 pending 인데 "큐 비었음") | **다른 워커 프로세스 확인.** 구버전 코드로 도는 워커가 가로챈다. 2026-08-11 에 5일 묵은 워커 때문에 실제로 겪었다 |
| `네이버 세션이 만료됐습니다` | `naver:login` 재실행 |
| `설명이 10자 미만입니다` | 클립은 설명 10자 이상이 필수 |
| `저장 완료를 확인하지 못했습니다` | `~/.stepd/naver-artifacts/` 스크린샷 확인. 네이버 DOM 개편이면 셀렉터 수정 필요 |
| SSH 가 비밀번호를 묻는다 | 관리자 계정인데 `administrators_authorized_keys` 에 안 넣었거나 권한을 안 잠갔다 |
| 배포했는데 반영이 안 된다 | `self-update.log` 확인. `pnpm install` 이 실패하면 워커를 **일부러** 재시작하지 않는다(반쪽 갱신보다 구버전 유지가 낫다) |

## 알아둘 것

- **코드가 최신이어도 프로세스가 옛날이면 소용없다.** self-update 가 재시작까지 하는 이유다.
- **발행 사이에 60초 간격**이 들어간다(`NAVER_MIN_GAP_MS`). 짧은 시간에 몰아넣으면
  네이버가 불안정해져서 보수적으로 잡았다. 정확한 한도는 아직 모른다.
- **약관 리스크는 사업 판단이다.** 본인 계정·본인 콘텐츠라도 자동화 도구는 제한될 수 있다.

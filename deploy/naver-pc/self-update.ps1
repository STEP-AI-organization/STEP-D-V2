#Requires -Version 5.1
<#
.SYNOPSIS
  네이버 워커 PC 자가 갱신 — origin/main 을 당겨 워커를 재시작한다.

.DESCRIPTION
  윈도우2 는 사무실 NAT 뒤에 있어서 배포 서버가 SSH 로 밀어 넣기 어렵다(포트포워딩·고정IP·
  키 관리가 전부 유지보수 부담이 된다). 그래서 **PC 가 스스로 당겨온다** — 배포는
  `main` 에 push 하는 것 하나로 끝나고, 이 스크립트가 주기적으로 따라온다.

  변경이 없으면 아무것도 하지 않는다(불필요한 재시작이 발행 중인 잡을 끊지 않게).

.NOTES
  - 워커 재시작이 핵심이다. 오늘(2026-08-11) 구버전 코드로 5일간 돌던 워커가 잡을
    가로채 계속 실패시켰다 — 코드가 최신이어도 **프로세스가 옛날이면 소용없다.**
  - 재시작 대상은 **이 PC 의 워커 프로세스 전부**다($TaskRestart) — 네이버 워커 + 렌더
    서버/워커. 2026-09-02 에 렌더 둘이 빠져 있어 이틀간 옛 코드로 클립을 구웠다.
  - 작업 스케줄러에 10분 간격으로 걸어둔다(설치는 install-task.ps1).
  - **재시작 전에 새 코드가 실제로 뜨는지 확인한다**(Test-ServerBoots · 2026-09-03).
    안 뜨면 아무것도 재시작하지 않는다 — 돌던 프로세스는 메모리에 옛 코드를 들고 있어
    그대로 일한다. 깨진 코드로 재시작하면 그때부터 아무 일도 안 되는데, 로그에는
    "재시작" 이라고 찍혀서 죽은 걸 아무도 모른다(그날 렌더 16건이 그렇게 탔다).
  - ⚠️ **이 파일을 고친 커밋에서는 한 박자 늦는다.** 첫 실행은 옛 스크립트가 돌아 pull 만
    하고, 새 재시작 목록은 다음 회차부터다. 급하면 두 번 돌린다(docs/ops/deploy-win2.md).
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$Branch   = "main",
  [string]$TaskWorker = "STEPD-Naver-Worker",
  # 코드를 당겼으면 **이 PC 의 모든 워커 프로세스**를 재시작한다 (2026-09-02).
  # 예전엔 네이버 워커 하나뿐이라 렌더 프로세스가 옛 코드로 남았다 — 아래 재시작 블록 주석 참고.
  # 등록 안 된 작업은 조용히 건너뛴다(렌더를 안 쓰는 PC 도 있다).
  [string[]]$TaskRestart = @($TaskWorker, "STEPD-Render-Server", "STEPD-Render-Worker"),
  # yt-dlp 갱신 채널. **nightly 가 기본이다** — stable 은 릴리스 간격이 길어(2026-08-19 기준
  # 최신 stable 이 2026.07.04, 6주 전) 그 사이 유튜브가 바꾼 것을 못 따라가 403 이 난다.
  # 갱신을 아예 끄려면 -YtDlpChannel none.
  [ValidateSet("nightly", "stable", "none")]
  [string]$YtDlpChannel = "nightly",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$log = Join-Path $env:USERPROFILE ".stepd\self-update.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Say([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Write-Output $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

# ── yt-dlp 자가 갱신 ─────────────────────────────────────────────────────────────
#
# ⚠️ **리포 변경과 무관하게 매 회차 돈다** — 아래 "변경 없음 → exit" 보다 위에 있는 이유다.
# 유튜브가 우리 커밋과 상관없이 다운로드를 깨뜨리고, 고침은 yt-dlp 릴리스로 온다. 리포가
# 조용한 주에도 yt-dlp 는 묵으면 안 된다(2026-08-19: 6주 묵은 stable 이 미디어 데이터에서만
# 403 → "유튜브 다운로드 계속 실패"의 정체).
#
# 실패는 전부 삼킨다 — 갱신을 못 해도 **워커 코드 갱신은 계속돼야** 한다. 다운로드가 깨진
# 것보다 워커가 통째로 안 도는 게 나쁘다.
function Update-YtDlp([string]$Channel) {
  if ($Channel -eq "none") { return }
  try {
    $cmd = Get-Command yt-dlp -ErrorAction Stop
    $exe = $cmd.Source
  } catch {
    Say "yt-dlp: PATH 에 없다 — 갱신 건너뜀 (docs/ops/youtube-ingest.md 의 설치 경로 확인)"
    return
  }
  if ($exe -notmatch '\.exe$') {
    # pip 설치본 등 exe 가 아니면 덮어쓰기가 안 맞는다 — 손대지 않는다.
    Say "yt-dlp: standalone exe 가 아니라 갱신 건너뜀 ($exe)"
    return
  }

  $repo = if ($Channel -eq "nightly") { "yt-dlp/yt-dlp-nightly-builds" } else { "yt-dlp/yt-dlp" }
  try {
    $cur = (& $exe --version 2>$null | Select-Object -First 1).Trim()
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
      -Headers @{ "User-Agent" = "stepd-self-update" } -TimeoutSec 30
    $latest = [string]$rel.tag_name
  } catch {
    Say "yt-dlp: 최신 버전 조회 실패 — 이번 회차 건너뜀 ($($_.Exception.Message))"
    return
  }
  if (-not $latest) { Say "yt-dlp: 릴리스 태그를 못 읽음 — 건너뜀"; return }
  if ($cur -eq $latest) { Say "yt-dlp: 최신 ($cur)"; return }

  Say "yt-dlp 갱신 $cur → $latest ($Channel)"
  $tmp = Join-Path $env:TEMP ("yt-dlp-{0}.exe" -f ([guid]::NewGuid().ToString("N")))
  try {
    Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest/download/yt-dlp.exe" `
      -OutFile $tmp -TimeoutSec 300 -UseBasicParsing
    # 받은 게 진짜 도는지 먼저 확인한다 — 깨진 파일로 덮으면 다운로드가 통째로 죽는다.
    $probe = (& $tmp --version 2>$null | Select-Object -First 1)
    if (-not $probe) { throw "받은 exe 가 --version 에 응답하지 않는다" }
    # 다운로드 잡이 도는 중이면 파일이 잠겨 있다 → 이번 회차는 넘기고 다음에 다시 시도.
    Move-Item -Path $tmp -Destination $exe -Force -ErrorAction Stop
    Say "yt-dlp 갱신 완료 → $($probe.Trim())"
  } catch {
    Say "yt-dlp 갱신 실패(계속 진행) — $($_.Exception.Message)"
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# ── 부팅 검증 ────────────────────────────────────────────────────────────────────
#
# ⚠️ **깨진 코드로는 재시작하지 않는다** (사용자 2026-09-03: "빌드가 깨지면 그거를 올리면 안 돼").
#
# 2026-09-03 실측: `index.ts` 가 `./chatbot/agent.ts` 를 import 하도록 커밋됐는데 그 폴더는
# 커밋이 안 돼 있었다. 이 PC 는 git 에서 받아 **소스로** 도니까 그 순간 렌더 서버가 부팅에
# 실패했다. 그런데 이 스크립트는 pull·install 만 보고 **그대로 재시작**했고, 로그에는
# "재시작" 이라고만 찍혔다 — 죽은 걸 아무도 몰랐다. 렌더 워커는 살아서 잡을 계속 집었고
# `fetch failed` 로 16건이 탔다.
#
# 그래서 **재시작 전에 새 코드가 실제로 뜨는지 본다.** 안 뜨면 돌던 프로세스를 건드리지
# 않는다 — 돌고 있는 옛 프로세스는 메모리에 옛 코드를 들고 있어서 그대로 멀쩡히 일한다.
# **옛 코드로 도는 것이 죽어 있는 것보다 낫다.**
#
# 포트는 실제 서버와 겹치지 않는 값을 쓴다(실서비스에 붙지 않는다).
function Test-ServerBoots([string]$RepoRoot) {
  $server = Join-Path $RepoRoot "apps\server"
  if (-not (Test-Path (Join-Path $server "src\index.ts"))) {
    Say "부팅 검증: apps/server 가 없다 — 건너뜀"
    return $true
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Say "부팅 검증: node 를 못 찾음 — 건너뜀"; return $true }

  # ⚠️ 파일명에 GUID 를 넣는다 — 고정 이름이면 **지난 회차의 로그**를 읽고 통과해 버린다
  #    (검증 함수가 거짓 통과하는 게 검증이 없는 것보다 나쁘다).
  $g = [guid]::NewGuid().ToString("N")
  $out    = Join-Path $env:TEMP ("stepd-boot-$g.log")
  $outErr = Join-Path $env:TEMP ("stepd-boot-$g.err")
  $prevPort = $env:PORT
  $env:PORT = "4399"                      # 실서버(4100)와 겹치지 않는 임시 포트
  $proc = $null
  try {
    $proc = Start-Process -FilePath $node `
      -ArgumentList "--unhandled-rejections=warn", "--import", "tsx", "--env-file-if-exists=.env", "src/index.ts" `
      -WorkingDirectory $server -PassThru -NoNewWindow `
      -RedirectStandardOutput $out -RedirectStandardError $outErr
    # 90초 안에 "listening" 이 나오면 성공.
    #
    # ⚠️ **DB 준비까지 기다리지 않는다.** 서버는 "listening" 을 먼저 찍고 그 다음에
    #    "database + queue ready" 를 찍는다(Cloud Run 로그 실측). DB 까지 조건에 넣으면
    #    DB 가 잠깐 느린 날 **거짓 실패**로 갱신이 영영 멈춘다 — 그 손해가 훨씬 크다.
    #    이 검증이 잡으려는 건 모듈 해석 실패다(그건 "listening" 전에 죽는다).
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 1
      if ($proc.HasExited) { break }
      $text = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
      if ($text -and $text -match "listening on") { return $true }
    }
    # 여기 왔다는 건 죽었거나 90초 안에 못 떴다는 뜻이다.
    $err = ((Get-Content $outErr -Raw -ErrorAction SilentlyContinue) + "`n" +
            (Get-Content $out -Raw -ErrorAction SilentlyContinue))
    Say "부팅 검증 실패 — 새 코드가 뜨지 않는다:"
    Say (($err -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 6) -join "`n")
    return $false
  } catch {
    Say "부팅 검증 중 오류(검증 불가로 보고 계속) — $($_.Exception.Message)"
    return $true
  } finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $env:PORT = $prevPort
    Remove-Item $out, $outErr -Force -ErrorAction SilentlyContinue
  }
}

Set-Location $RepoRoot
Say "self-update 시작 — $RepoRoot ($Branch)"

Update-YtDlp $YtDlpChannel

git fetch --quiet origin $Branch
if ($LASTEXITCODE -ne 0) { Say "fetch 실패 — 네트워크 확인. 이번 회차 건너뜀"; exit 0 }

$local  = (git rev-parse HEAD).Trim()
$remote = (git rev-parse "origin/$Branch").Trim()

if ($local -eq $remote -and -not $Force) {
  Say "변경 없음 ($($local.Substring(0,7))) — 재시작 안 함"
  exit 0
}

Say "갱신 $($local.Substring(0,7)) → $($remote.Substring(0,7))"

# 이 PC 는 워커 전용이라 로컬 수정본을 보존할 이유가 없다. 충돌 없이 원격을 그대로 따른다.
# (.env·세션 파일은 gitignore 라 reset 대상이 아니다 — 날아가지 않는다.)
git reset --hard "origin/$Branch" --quiet
if ($LASTEXITCODE -ne 0) { Say "reset 실패 — 중단"; exit 1 }

Say "의존성 동기화"
# 윈도우2 는 SSH·작업 스케줄러로 돌아 **TTY 가 없다.** node_modules 가 lockfile 과 어긋나면
# pnpm 이 modules 디렉토리 삭제를 물어보는데(확인 프롬프트), TTY 가 없으면 거기서 죽는다
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) → 코드는 당겨도 워커가 영영 재시작 안 된다
# (2026-08-18 실측). CI=true 면 pnpm 이 비대화형으로 진행한다.
$env:CI = "true"
$pnpmOut = (pnpm install --frozen-lockfile 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) {
  # pnpm 은 "빌드 스크립트를 안 돌렸다"는 **경고**로도 exit 1 을 낸다(ERR_PNPM_IGNORED_BUILDS).
  # 설치 자체는 끝난 상태라 이걸 실패로 보면 워커가 영원히 갱신되지 않는다.
  # 다른 에러까지 뭉뚱그려 무시하지 않으려고, 이 마커가 있을 때만 통과시킨다.
  if ($pnpmOut -match "ERR_PNPM_IGNORED_BUILDS") {
    Say "pnpm: 빌드 스크립트 미승인 경고 — 설치는 완료. 계속 진행"
  } else {
    Say "pnpm install 실패 — 워커는 재시작하지 않는다(구버전 유지가 낫다)"
    Say ($pnpmOut -split "`n" | Select-Object -Last 5 | Out-String)
    exit 1
  }
}

# Playwright 브라우저는 버전이 올라갈 수 있다. 이미 있으면 즉시 끝난다.
#
# ⚠️ **여기서 스크립트가 죽으면 안 된다.** PS 5.1 은 네이티브 명령의 stderr 를 NativeCommandError
# 로 감싸는데, 이 스크립트는 $ErrorActionPreference="Stop" 이라 그게 **종료성 오류**가 된다.
# npx 는 경고 한 줄만 찍어도 stderr 를 쓴다 → 그 순간 스크립트가 여기서 끝나고 **아래 워커
# 재시작이 영영 안 돈다**. 증상이 고약하다: 코드는 당겨졌는데(위 reset 은 이미 끝났다) 워커는
# 옛 프로세스 그대로라, git 으로 보면 최신인데 동작은 옛날이다.
# (2026-08-19 실측: 윈도우2 가 8/18 12:29 부터 이 지점에서 매번 죽어 워커가 하루 넘게 옛 코드로
#  돌았다 — 유튜브 다운로드가 계속 실패한 진짜 이유. 로그가 "의존성 동기화" 에서 끊긴 게 표식.)
# 브라우저 설치는 실패해도 워커 재시작보다 덜 중요하다 — 삼키고 계속 간다.
try {
  $ErrorActionPreference = "Continue"
  npx playwright install chromium 2>&1 | Out-Null
} catch {
  Say "playwright install 건너뜀 — $($_.Exception.Message)"
} finally {
  $ErrorActionPreference = "Stop"
}

# **재시작 전 마지막 관문.** 여기서 막으면 돌던 프로세스가 그대로 산다.
if (-not (Test-ServerBoots $RepoRoot)) {
  Say "재시작하지 않는다 — 돌던 프로세스를 그대로 둔다(옛 코드가 죽은 것보다 낫다)."
  Say "고친 커밋이 올라오면 다음 회차에 자동으로 다시 시도한다."
  exit 1
}

Say "워커 재시작 ($($TaskRestart -join ', '))"
# pm2 가 아니라 작업 스케줄러다(Windows 에서 pm2 가 두 번 발목을 잡았다 — install.ps1 주석 참고).
#
# ⚠️ **렌더 프로세스도 여기 들어간다** (2026-09-02). 예전엔 네이버 워커 하나만 재시작해서,
#    코드는 최신인데 STEPD-Render-Server·STEPD-Render-Worker 는 옛 프로세스 그대로였다.
#    이 파일 .NOTES 의 "코드가 최신이어도 프로세스가 옛날이면 소용없다" 가 렌더에도 똑같이
#    적용되는데, 렌더는 결과물이 조용히 달라져서 더 안 보인다 — 실측(2026-09-02): 렌더 서버가
#    8/31 코드로 이틀을 돌아 새로 넣은 글꼴 3종이 말없이 프리텐다드로 폴백되고 있었다.
#    `RENDER_VIA_QUEUE=1` 이라 실제로 고객 클립을 굽는 중이었다.
$failed = @()
foreach ($t in $TaskRestart) {
  if (-not (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) {
    Say "  $t — 등록 안 됨, 건너뜀"
    continue
  }
  try {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $t -ErrorAction Stop
    Say "  $t — 재시작"
  } catch {
    Say "  $t — 재시작 실패: $($_.Exception.Message)"
    $failed += $t
  }
}
# 네이버 워커는 이 PC 의 본체라 실패하면 중단한다(종전과 같다). 렌더는 실패해도 계속 —
# 클라우드가 정체를 감지해 대신 굽기 때문에(renderQueueStallMs) 배포가 멈추지는 않는다.
if ($failed -contains $TaskWorker) {
  Say "워커 재시작 실패 — install.ps1 로 먼저 등록할 것"
  exit 1
}
if ($failed.Count -gt 0) { Say "일부 작업 재시작 실패(계속 진행): $($failed -join ', ')" }

Say "완료 — $($remote.Substring(0,7))"

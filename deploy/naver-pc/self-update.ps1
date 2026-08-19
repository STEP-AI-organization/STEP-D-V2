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
  - 작업 스케줄러에 10분 간격으로 걸어둔다(설치는 install-task.ps1).
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$Branch   = "main",
  [string]$TaskWorker = "STEPD-Naver-Worker",
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
npx playwright install chromium 2>&1 | Out-Null

Say "워커 재시작 ($TaskWorker)"
# pm2 가 아니라 작업 스케줄러다(Windows 에서 pm2 가 두 번 발목을 잡았다 — install.ps1 주석 참고).
try {
  Stop-ScheduledTask -TaskName $TaskWorker -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskWorker -ErrorAction Stop
} catch {
  Say "워커 재시작 실패 — install.ps1 로 먼저 등록할 것: $($_.Exception.Message)"
  exit 1
}

Say "완료 — $($remote.Substring(0,7))"

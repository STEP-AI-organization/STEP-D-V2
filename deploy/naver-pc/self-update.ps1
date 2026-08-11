#Requires -Version 5.1
<#
.SYNOPSIS
  네이버 워커 PC 자가 갱신 — origin/main 을 당겨 워커를 재시작한다.

.DESCRIPTION
  이 PC 는 사무실 NAT 뒤에 있어서 배포 서버가 SSH 로 밀어 넣기 어렵다(포트포워딩·고정IP·
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
  [string]$PmName   = "stepd-naver-worker",
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

Set-Location $RepoRoot
Say "self-update 시작 — $RepoRoot ($Branch)"

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
pnpm install --frozen-lockfile 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Say "pnpm install 실패 — 워커는 재시작하지 않는다(구버전 유지가 낫다)"; exit 1 }

# Playwright 브라우저는 버전이 올라갈 수 있다. 이미 있으면 즉시 끝난다.
npx playwright install chromium 2>&1 | Out-Null

Say "워커 재시작 ($PmName)"
pm2 restart $PmName 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Say "pm2 restart 실패 — 등록되어 있지 않으면 install-task.ps1 을 먼저 실행할 것"
  exit 1
}

Say "완료 — $($remote.Substring(0,7))"

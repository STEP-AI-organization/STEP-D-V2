#Requires -Version 5.1
<#
.SYNOPSIS
  네이버 워커 PC 1회 설치 — pm2 로 워커를 등록하고, 자가 갱신을 스케줄러에 건다.

.DESCRIPTION
  이 PC 에서 사람이 딱 한 번 실행한다. 이후 배포는 `main` 에 push 하는 것으로 끝난다 —
  self-update.ps1 이 10분마다 당겨와 워커를 재시작한다.

  전제(먼저 끝나 있어야 함):
    1. pnpm install
    2. npx playwright install chromium
    3. apps/server/.env  (DATABASE_URL·GCS_BUCKET·NAVER_UPLOAD_ENABLED=1)
    4. pnpm --filter @stepd/server naver:login   ← 사람이 2차인증까지

.EXAMPLE
  .\deploy\naver-pc\install.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoRoot   = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$PmName     = "stepd-naver-worker",
  [int]$UpdateEveryMin = 10
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

Write-Host "==> 전제 확인"
$envFile = Join-Path $RepoRoot "apps\server\.env"
if (-not (Test-Path $envFile)) { throw "apps/server/.env 가 없다. 먼저 만들 것." }
$session = Join-Path $env:USERPROFILE ".stepd\naver-storage-state.json"
if (-not (Test-Path $session)) {
  throw "네이버 세션이 없다 — 'pnpm --filter @stepd/server naver:login' 을 먼저 실행할 것."
}
Write-Host "    OK  .env · 네이버 세션"

# pm2 로 돌리는 이유: self-update 가 `pm2 restart` 한 줄로 갱신할 수 있고, 로그온·재부팅
# 후에도 pm2 resurrect 로 살아난다.
Write-Host "==> 워커 등록 (pm2)"
pm2 delete $PmName 2>&1 | Out-Null   # 있으면 갈아끼운다
pm2 start "pnpm" --name $PmName --cwd $RepoRoot -- --filter @stepd/server worker:naver
if ($LASTEXITCODE -ne 0) { throw "pm2 start 실패" }
pm2 save | Out-Null
Write-Host "    OK  $PmName"

Write-Host "==> 자가 갱신 스케줄 ($UpdateEveryMin 분)"
$taskName = "STEPD-Naver-SelfUpdate"
$script   = Join-Path $RepoRoot "deploy\naver-pc\self-update.ps1"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $UpdateEveryMin)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null
Write-Host "    OK  $taskName"

Write-Host ""
Write-Host "설치 완료. 이제 배포는 main 에 push 하는 것으로 끝난다."
Write-Host "  상태 확인 : pm2 status $PmName"
Write-Host "  워커 로그 : pm2 logs $PmName"
Write-Host "  갱신 로그 : $env:USERPROFILE\.stepd\self-update.log"
Write-Host ""
Write-Host "⚠️ 절전/최대절전을 꺼둘 것 — 잠들면 잡을 못 집는다."

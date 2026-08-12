#Requires -Version 5.1
<#
.SYNOPSIS
  윈도우2(네이버 워커) 1회 설치 — Cloud SQL 프록시·워커·자가 갱신을 작업 스케줄러에 건다.

.DESCRIPTION
  윈도우2 에서 사람이 딱 한 번 실행한다. 이후 배포는 `main` 에 push 하는 것으로 끝난다 —
  self-update.ps1 이 10분마다 당겨와 워커를 재시작한다.

  전제(먼저 끝나 있어야 함):
    1. pnpm install
    2. npx playwright install chromium
    3. apps/server/.env  (DATABASE_URL·GCS_BUCKET·NAVER_UPLOAD_ENABLED=1)
    4. 네이버 로그인 — 둘 중 하나면 된다:
       · 윈도우2 앞에서 `pnpm --filter @stepd/server naver:login` (브라우저가 뜬다)
       · 또는 서버에 올려둔 세션(naver_account.session_blob)을 워커가 받아 쓴다
         → 이 경우 .env 의 NAVER_SESSION_KEY 가 서버와 같아야 한다

.EXAMPLE
  .\deploy\naver-pc\install.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoRoot   = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$TaskWorker = "STEPD-Naver-Worker",
  [string]$CloudSqlInstance = "step-d:us-central1:stepd-db",
  [int]$UpdateEveryMin = 10
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

Write-Host "==> 전제 확인"
$envFile = Join-Path $RepoRoot "apps\server\.env"
if (-not (Test-Path $envFile)) { throw "apps/server/.env 가 없다. 먼저 만들 것." }
Write-Host "    OK  .env"

# 세션은 여기(로컬 파일)에 없어도 된다 — 서버에 올려둔 세션을 워커가 받아 쓰는 경로가 있다.
# 그래서 막지 않고 경고만 한다. 둘 다 없으면 잡이 "세션 없음"으로 실패하지, 설치가 실패하는 게 아니다.
$naverDir = Join-Path $env:USERPROFILE ".stepd\naver"
$legacy   = Join-Path $env:USERPROFILE ".stepd\naver-storage-state.json"
$hasLocal = (Test-Path $legacy) -or ((Test-Path $naverDir) -and (Get-ChildItem $naverDir -Recurse -Filter "storage-state.json" -ErrorAction SilentlyContinue))
if ($hasLocal) {
  Write-Host "    OK  네이버 세션(로컬)"
} else {
  Write-Warning "네이버 세션이 로컬에 없다. 서버 세션을 쓸 게 아니라면 'pnpm --filter @stepd/server naver:login' 을 실행할 것."
}

# Windows 에서는 pm2 를 쓰지 않는다. 두 번 막혔다:
#  - pm2 가 네이티브 exe 의 `--port` 를 자기 옵션으로 먹는다
#  - pm2 를 거쳐 pnpm 을 띄우면 pnpm 의 자동 install 이 빌드 승인 문제로 exit 1 을 내
#    워커가 아예 안 뜬다
# 작업 스케줄러가 네이티브 exe·node 둘 다에 더 단순하고, 재부팅도 그대로 견딘다.
Write-Host "==> Cloud SQL 프록시 등록 (작업 스케줄러)"
$proxyExe = Join-Path $env:USERPROFILE "tools\cloud-sql-proxy.exe"
if (-not (Test-Path $proxyExe)) { throw "cloud-sql-proxy 가 없다: $proxyExe" }
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "STEPD-CloudSQL-Proxy" -Force -Settings $set `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Action (New-ScheduledTaskAction -Execute $proxyExe -Argument "$CloudSqlInstance --port 5432") | Out-Null
Start-ScheduledTask -TaskName "STEPD-CloudSQL-Proxy"
Write-Host "    OK  STEPD-CloudSQL-Proxy"

Write-Host "==> 워커 등록 (작업 스케줄러)"
$serverDir = Join-Path $RepoRoot "apps\server"
$nodeExe = (Get-Command node).Source
$workerArgs = "--unhandled-rejections=warn --import tsx --env-file-if-exists=.env scripts/worker-naver.mts"
Register-ScheduledTask -TaskName $TaskWorker -Force -Settings $set `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Action (New-ScheduledTaskAction -Execute $nodeExe -Argument $workerArgs -WorkingDirectory $serverDir) | Out-Null
Start-ScheduledTask -TaskName $TaskWorker
Write-Host "    OK  $TaskWorker"

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
Write-Host "  상태 확인 : Get-ScheduledTask STEPD-*"
Write-Host "  워커 확인 : Get-Process node | Where-Object { $_.Path -like "*node*" }"
Write-Host "  갱신 로그 : $env:USERPROFILE\.stepd\self-update.log"
Write-Host ""
Write-Host "⚠️ 절전/최대절전을 꺼둘 것 — 잠들면 잡을 못 집는다."

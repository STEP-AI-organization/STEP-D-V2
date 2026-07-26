# Worker watchdog - restarts the tsx worker if it dies (Windows subprocess native crash).
# 이전 이슈: Start-Process -FilePath "pnpm"이 확장자 없어 "%1은 올바른 Win32..." 오류.
# fix: pnpm.cmd 절대경로로 실행 + GOOGLE_APPLICATION_CREDENTIALS 상속.
$ErrorActionPreference = "Continue"
$LogDir = Join-Path $PSScriptRoot "..\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$WatchdogLog = Join-Path $LogDir "watchdog.log"
$ServerDir = Join-Path $PSScriptRoot "..\apps\server"

# pnpm.cmd 경로 자동 탐지 (Windows는 .cmd 확장자 필수)
$PnpmCmd = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $PnpmCmd) {
  $PnpmCmd = "C:\Users\STEPAI05\AppData\Roaming\npm\pnpm.cmd"
}

# SA credentials 자동 세팅 (Vertex Gemini · Cloud SQL 접근용)
$SaKeyDefault = "C:\Users\STEPAI05\stepd-deployer-key.json"
if (-not $env:GOOGLE_APPLICATION_CREDENTIALS -and (Test-Path $SaKeyDefault)) {
  $env:GOOGLE_APPLICATION_CREDENTIALS = $SaKeyDefault
}

function Write-WatchdogLog($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $msg"
  try { Add-Content -Path $WatchdogLog -Value $line -Encoding utf8 } catch {}
  Write-Output $line
}

function Test-WorkerAlive {
  $procs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "src[/\\]worker" }
  return @($procs).Count -gt 0
}

Write-WatchdogLog "watchdog started · pnpm=$PnpmCmd · SA=$env:GOOGLE_APPLICATION_CREDENTIALS"
while ($true) {
  if (-not (Test-WorkerAlive)) {
    Write-WatchdogLog "worker not running - restarting"
    $newLog = Join-Path $LogDir ("worker-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
    try {
      Start-Process -FilePath $PnpmCmd -ArgumentList "run","worker" `
        -WorkingDirectory $ServerDir `
        -RedirectStandardOutput $newLog `
        -RedirectStandardError ($newLog + ".err") `
        -WindowStyle Hidden
      Write-WatchdogLog "worker restart requested - log=$newLog"
    } catch {
      Write-WatchdogLog "restart failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 15
  }
  Start-Sleep -Seconds 30
}

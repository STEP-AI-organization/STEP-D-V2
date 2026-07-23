# Worker watchdog - restarts the tsx worker if it dies overnight.
# Checks every 30 seconds, restarts if needed, appends to logs/watchdog.log.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\worker-watchdog.ps1
$ErrorActionPreference = "Continue"
$LogDir = Join-Path $PSScriptRoot "..\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$WatchdogLog = Join-Path $LogDir "watchdog.log"
$ServerDir = Join-Path $PSScriptRoot "..\apps\server"

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

Write-WatchdogLog "watchdog started"
while ($true) {
  if (-not (Test-WorkerAlive)) {
    Write-WatchdogLog "worker not running - restarting"
    $newLog = Join-Path $LogDir ("worker-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
    try {
      Start-Process -FilePath "pnpm" -ArgumentList "run","worker" `
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

# Bootstraps pm2 apps at user logon (called by Task Scheduler task 'STEPD-pm2-boot').
# Sets PATH so pm2/node resolve, then pm2 resurrect loads the saved dump.
# Idempotent: if pm2 apps are already online, resurrect is a no-op.

$ErrorActionPreference = "Continue"
$LogFile = "C:\Users\STEPAI05\STEPD-repo\logs\pm2-boot.log"
if (-not (Test-Path (Split-Path $LogFile))) { New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null }

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "[$ts] $msg"
}

$env:PATH = "C:\Program Files\nodejs;C:\Users\STEPAI05\AppData\Roaming\npm;$env:PATH"

Log "boot triggered"
try {
  $result = & pm2 resurrect 2>&1 | Out-String
  Log "resurrect: $result"
  Start-Sleep -Seconds 3
  $status = & pm2 list 2>&1 | Out-String
  Log "list: $status"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}

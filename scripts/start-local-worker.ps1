# Boot the local production worker stack under pm2.
# Usage: powershell -File scripts\start-local-worker.ps1
#
# Requires: node/pnpm, pm2 (npm i -g pm2), cloud-sql-proxy.exe, SA key.
# Idempotent: safe to re-run - pm2 will not double-start online apps.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }

# preflight
$SaKey = "C:\Users\STEPAI05\stepd-deployer-key.json"
$ProxyExe = "C:\Users\STEPAI05\cloud-sql-proxy\cloud-sql-proxy.exe"
$EnvFile = Join-Path $Root "apps\server\.env.worker"
if (-not (Test-Path $SaKey)) { Fail "SA key missing: $SaKey" }
if (-not (Test-Path $ProxyExe)) { Fail "cloud-sql-proxy missing: $ProxyExe" }
if (-not (Test-Path $EnvFile)) { Fail "apps/server/.env.worker missing (contains prod DATABASE_URL etc.)" }
$pm2Version = & pm2 --version 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { Fail "pm2 not installed. Run: npm i -g pm2" }

Info ("pm2 version: {0}" -f $pm2Version)
Info "starting ecosystem.config.cjs..."
pm2 start ecosystem.config.cjs
if ($LASTEXITCODE -ne 0) { Fail "pm2 start failed" }

Info "pm2 save (survives daemon restart via 'pm2 resurrect')..."
pm2 save | Out-Null

Start-Sleep -Seconds 3
Ok "started."
pm2 list

Write-Host ""
Info "next steps:"
Write-Host "  pm2 status                   # health"
Write-Host "  pm2 logs stepd-worker        # live logs"
Write-Host "  pm2 monit                    # dashboard"
Write-Host "  scripts\update-local-worker.ps1   # git pull + safe restart"
Write-Host "  pm2 stop all                 # stop everything"
Write-Host ""
Info "GCE stepd-worker VM should stay TERMINATED:"
Write-Host "  gcloud compute instances describe stepd-worker --zone=us-central1-a --format=value(status)"
Write-Host ""
Info "auto-start on Windows boot (optional):"
Write-Host "  npm i -g pm2-installer && pm2-installer  # creates Windows service"
Write-Host "  or: register 'pm2 resurrect' in Task Scheduler at logon"

# 로컬 컴을 프로덕션 워커 VM으로 실행 (aena 방식 · GPU 비용 절감).
# 실행: powershell -File scripts\start-local-worker.ps1
#
# 세팅 요구사항:
#   - C:\Users\STEPAI05\cloud-sql-proxy\cloud-sql-proxy.exe (v2.14.1+)
#   - C:\Users\STEPAI05\stepd-deployer-key.json (SA · roles/cloudsql.client + storage + aiplatform.user)
#   - apps\server\.env.worker (DATABASE_URL은 127.0.0.1:5434 프록시 경유)
#   - GCE stepd-worker VM은 stop 상태여야 잡 중복 픽업 없음
#
# 프록시(5434) + watchdog(worker:prod)를 백그라운드로 띄운다.
# 종료: taskkill /F /IM cloud-sql-proxy.exe · Get-CimInstance Win32_Process | Where CommandLine -match worker

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$ProxyExe = "C:\Users\STEPAI05\cloud-sql-proxy\cloud-sql-proxy.exe"
$SaKey = "C:\Users\STEPAI05\stepd-deployer-key.json"
$Instance = "step-d:us-central1:stepd-db"
$ProxyPort = 5434

if (-not (Test-Path $ProxyExe)) { Write-Error "cloud-sql-proxy.exe 없음: $ProxyExe"; exit 1 }
if (-not (Test-Path $SaKey)) { Write-Error "SA key 없음: $SaKey"; exit 1 }

# 1) Cloud SQL Auth Proxy (127.0.0.1:5434 → step-d:us-central1:stepd-db)
$proxyRunning = Get-CimInstance Win32_Process -Filter "Name='cloud-sql-proxy.exe'" -ErrorAction SilentlyContinue
if (-not $proxyRunning) {
  $proxyLog = Join-Path $LogDir "cloud-sql-proxy.log"
  Start-Process -FilePath $ProxyExe `
    -ArgumentList "--address","127.0.0.1","--port",$ProxyPort,"--credentials-file",$SaKey,$Instance `
    -RedirectStandardOutput $proxyLog -RedirectStandardError ($proxyLog + ".err") `
    -WindowStyle Hidden
  Write-Output "proxy started · log=$proxyLog · port=$ProxyPort"
  Start-Sleep -Seconds 3
} else {
  Write-Output "proxy already running (pid=$($proxyRunning.ProcessId))"
}

# 2) Watchdog을 WORKER_SCRIPT=worker:prod 로 실행 (로컬 dev와 격리)
$env:WORKER_SCRIPT = "worker:prod"
$env:GOOGLE_APPLICATION_CREDENTIALS = $SaKey

$watchdogRunning = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "worker-watchdog.ps1" }
if (-not $watchdogRunning) {
  $watchdogScript = Join-Path $PSScriptRoot "worker-watchdog.ps1"
  $watchdogLog = Join-Path $LogDir "watchdog-prod.log"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$watchdogScript `
    -RedirectStandardOutput $watchdogLog -RedirectStandardError ($watchdogLog + ".err") `
    -WindowStyle Hidden `
    -Environment @{ WORKER_SCRIPT="worker:prod"; GOOGLE_APPLICATION_CREDENTIALS=$SaKey } `
    -ErrorAction SilentlyContinue
  # -Environment는 PS 7.4+ 필요. PS 5.1은 그냥 상속됨 ($env: 위에서 세팅 완료).
  if ($LASTEXITCODE -ne 0) {
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$watchdogScript `
      -RedirectStandardOutput $watchdogLog -RedirectStandardError ($watchdogLog + ".err") `
      -WindowStyle Hidden
  }
  Write-Output "watchdog started · log=$watchdogLog · script=worker:prod"
} else {
  Write-Output "watchdog already running (pid=$($watchdogRunning.ProcessId))"
}

Write-Output ""
Write-Output "로컬 워커 = 프로덕션 큐 폴링 모드."
Write-Output "GCE stepd-worker VM은 stop 상태여야 함:"
Write-Output "  gcloud compute instances describe stepd-worker --zone=us-central1-a --format=value(status)"

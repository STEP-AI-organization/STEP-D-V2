# Safe update loop for the local production worker (managed by pm2).
# Usage: powershell -File scripts\update-local-worker.ps1 [-Force] [-SkipPull] [-SkipInstall] [-SkipTypecheck]
#
# Flow: git pull -> pnpm install -> typecheck -> check running jobs -> pm2 restart stepd-worker.
# ASCII-only intentionally (PS 5.1 mangles Hangul in BOM-less files).

param(
  [switch]$Force = $false,
  [switch]$SkipPull = $false,
  [switch]$SkipInstall = $false,
  [switch]$SkipTypecheck = $false
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }

# 0) pm2 must have the worker registered (parse via node - PS 5.1 ConvertFrom-Json
#    trips on duplicate env keys like username/USERNAME in pm2's env dump)
$pm2Status = & pm2 jlist 2>$null | & node -e "
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
  const t=s.substring(s.indexOf('['), s.lastIndexOf(']')+1);
  let a; try{a=JSON.parse(t);}catch(e){console.log('PARSE_FAIL');process.exit(0);}
  const w=a.find(x=>x.name==='stepd-worker');
  const p=a.find(x=>x.name==='cloud-sql-proxy');
  console.log(JSON.stringify({
    worker: w ? {status:w.pm2_env.status, pid:w.pid, restarts:w.pm2_env.restart_time} : null,
    proxy: p ? {status:p.pm2_env.status, pid:p.pid} : null
  }));
});
" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $pm2Status) { Fail "pm2 jlist failed. Run: pm2 resurrect or scripts\start-local-worker.ps1" }
if ($pm2Status -eq 'PARSE_FAIL') { Fail "pm2 jlist json parse failed" }
$state = $pm2Status | ConvertFrom-Json
if (-not $state.worker) { Fail "pm2 has no 'stepd-worker'. Run: pm2 start ecosystem.config.cjs" }
if (-not $state.proxy) { Warn "pm2 has no 'cloud-sql-proxy' - worker will fail DB." }
if ($state.worker.status -ne 'online') {
  Warn ("stepd-worker status={0} (restart will start fresh)" -f $state.worker.status)
}

# 1) git pull
if (-not $SkipPull) {
  Info "git pull origin main..."
  $before = (git rev-parse HEAD).Trim()
  git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { Fail "git pull failed" }
  $after = (git rev-parse HEAD).Trim()
  if ($before -eq $after) {
    Info ("HEAD unchanged ({0}). Will restart to pick up any local edits." -f $before.Substring(0,7))
  } else {
    Ok ("pulled {0} -> {1}" -f $before.Substring(0,7), $after.Substring(0,7))
    git log --oneline "$before..$after" | ForEach-Object { Write-Host "  $_" }
  }
}

# 2) pnpm install (respects lockfile)
if (-not $SkipInstall) {
  Info "pnpm install --frozen-lockfile..."
  pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed. If lockfile drifted, commit it first." }
}

# 3) typecheck (worker survives if this fails)
if (-not $SkipTypecheck) {
  Info "typecheck apps/server..."
  Push-Location "apps/server"
  npx tsc --noEmit 2>&1 | Select-Object -Last 20
  $tcExit = $LASTEXITCODE
  Pop-Location
  if ($tcExit -ne 0) { Fail "typecheck failed - keeping current worker alive (no restart)." }
  Ok "typecheck passed"
}

# 4) running jobs check (put mjs inside apps/server so node resolves 'pg')
Info "checking running jobs..."
$jsPath = Join-Path $Root "apps\server\.check-running.mjs"
$jsCheck = @'
import pg from 'pg';
const c = new pg.Client({connectionString:'postgresql://postgres:DZ5YakaZzKekH20xz__u4IN4QkThheUqBe-rzbBOXLU@127.0.0.1:5434/stepd'});
try {
  await c.connect();
  const r = await c.query("SELECT id, type FROM job_queue WHERE status='running'");
  console.log(JSON.stringify(r.rows));
  await c.end();
} catch (e) {
  console.log('__DB_ERROR__:' + e.message);
  process.exit(0);
}
'@
Set-Content -Path $jsPath -Value $jsCheck -Encoding UTF8
Push-Location "apps/server"
# Redirect stderr to a temp file to bypass PS 5.1 NativeCommandError wrapping
$errFile = Join-Path $env:TEMP "stepd-check.err"
$runningOut = & node .\.check-running.mjs 2>$errFile
$dbExit = $LASTEXITCODE
Pop-Location
Remove-Item $jsPath -Force -ErrorAction SilentlyContinue
$runningOut = ($runningOut | Out-String).Trim()
if ($runningOut -like '__DB_ERROR__:*' -or -not $runningOut) {
  Warn ("running-job query failed: {0}" -f $runningOut)
  if (-not $Force) { Fail "DB check failed. Use -Force to skip." }
} else {
  try {
    $running = @($runningOut | ConvertFrom-Json)
    if ($running.Count -gt 0) {
      $typeList = ($running | ForEach-Object { $_.type }) -join ", "
      Warn ("running jobs: {0} ({1})" -f $running.Count, $typeList)
      if (-not $Force) { Fail "running jobs exist. Wait, or -Force (jobs re-queued by 15min sweep; mid-pipeline work lost)." }
      Warn "-Force set - proceeding despite running jobs"
    } else {
      Ok "no running jobs"
    }
  } catch {
    Warn ("could not parse: {0}" -f $runningOut)
    if (-not $Force) { Fail "parse failed. Use -Force to skip." }
  }
}

# 5) pm2 restart (graceful SIGTERM w/ 30s kill_timeout from ecosystem)
Info "pm2 restart stepd-worker..."
pm2 restart stepd-worker --update-env 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Fail "pm2 restart failed. Check: pm2 logs stepd-worker" }

# 6) verify online (same node-based json parse trick)
Start-Sleep -Seconds 4
$afterJson = & pm2 jlist 2>$null | & node -e "
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
  const t=s.substring(s.indexOf('['), s.lastIndexOf(']')+1);
  const a=JSON.parse(t); const w=a.find(x=>x.name==='stepd-worker');
  console.log(JSON.stringify(w?{status:w.pm2_env.status,pid:w.pid,restarts:w.pm2_env.restart_time}:null));
});
" 2>&1
$after = $afterJson | ConvertFrom-Json
if (-not $after -or $after.status -ne 'online') {
  Fail ("stepd-worker not online (status={0}). Check: pm2 logs stepd-worker" -f $after.status)
}
Ok ("stepd-worker online pid={0} restarts={1}" -f $after.pid, $after.restarts)

# 7) tail log
Info "tail 12 lines (5s wait for polling)..."
Start-Sleep -Seconds 5
pm2 logs stepd-worker --lines 12 --nostream 2>&1 | Select-Object -Last 15 | ForEach-Object { Write-Host "  $_" }

Ok ("update done. HEAD={0}" -f (git rev-parse HEAD).Substring(0,7))

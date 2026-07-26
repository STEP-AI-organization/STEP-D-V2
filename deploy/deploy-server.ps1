<#
.SYNOPSIS
  백엔드 배포 — apps/server → Cloud Run (stepd-server) + 로컬 pm2 워커

.DESCRIPTION
  아키텍처 (2026-07-26 이후):
    Cloud Run 은 API 를 서빙하고 잡을 큐에 넣기만 한다 (enqueue).
    실제 잡 실행은 **로컬 컴 pm2** 가 담당한다 (aena 방식 · GPU 비용 절감).
    기존 GCE stepd-worker VM 은 TERMINATED — 이 스크립트는 더 이상 SSH 안 한다.

  같은 소스가 두 곳에서 돈다:
    Cloud Run  → cloudbuild.yaml 이미지 빌드 · 배포
    로컬 워커  → pnpm/tsx 로 apps/server/src/worker.ts 직접 실행 (git pull → pm2 restart)
  한쪽만 배포하면 코드가 어긋나므로 이 스크립트는 함께 올린다. 워커 스킵은 -SkipWorker.

  ⚠️ Cloud Run 은 GitHub 푸시로 자동 배포되지 않는다 (Vercel 과 다르다).

.PARAMETER DeploySaAccount
  이 계정으로 모든 gcloud 를 실행한다 (gcloud --account). stepd-deployer 같은 배포
  서비스계정을 넣으면 hkj 재인증 프롬프트 없이 비대화형으로 통과한다. 파라미터가 없으면
  환경변수 DEPLOY_SA_ACCOUNT 를, 그것도 없으면 gcloud 활성 계정을 그대로 쓴다.

.EXAMPLE
  .\deploy\deploy-server.ps1               # 검증 → Cloud Run → 로컬 워커 → 확인
  .\deploy\deploy-server.ps1 -SkipWorker   # Cloud Run 만
  .\deploy\deploy-server.ps1 -Only worker  # 로컬 워커 재시작만 (코드 pull 없이는 -SkipPull 로)
  .\deploy\deploy-server.ps1 -WhatIf       # 무엇이 배포될지만 확인
#>
[CmdletBinding()]
param(
  [ValidateSet("all", "cloudrun", "worker")]
  [string]$Only = "all",

  [switch]$SkipWorker,
  [switch]$SkipChecks,
  [switch]$SkipVerify,
  [switch]$WhatIf,
  # -Force: 로컬 워커에 running 잡이 있어도 restart (재큐잉됨 · 진행중 파이프라인 로스)
  [switch]$Force,

  # 배포 SA (gcloud --account). 미지정 시 env:DEPLOY_SA_ACCOUNT → 활성 계정 순.
  [string]$DeploySaAccount = $env:DEPLOY_SA_ACCOUNT
)

$ErrorActionPreference = "Stop"

# ── 비대화형 네이티브 실행 래퍼 ────────────────────────────────────────────────
# PowerShell 5.1 은 네이티브 명령이 stderr 에 쓰기만 해도 (gcloud·git 는 정상 진행상황을
# stderr 로 낸다) $ErrorActionPreference='Stop' 하에서 NativeCommandError 로 조기 종료할 수
# 있다. 배포 성공/실패는 오직 종료코드로만 판정해야 한다.
$script:DeployAccount = $DeploySaAccount

function Invoke-Native {
  param(
    [switch]$Quiet,
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$NativeArgs
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { & $Exe @NativeArgs 2>&1 | Out-Null }
    else        { & $Exe @NativeArgs 2>&1 | ForEach-Object { Write-Host $_ } }
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return $LASTEXITCODE
}

function Invoke-Gcloud {
  param(
    [switch]$Quiet,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$GcloudArgs
  )
  if ($script:DeployAccount) { $GcloudArgs = @($GcloudArgs) + "--account=$script:DeployAccount" }
  if ($Quiet) { return (Invoke-Native -Quiet -Exe gcloud -NativeArgs $GcloudArgs) }
  return (Invoke-Native -Exe gcloud -NativeArgs $GcloudArgs)
}

$Project    = "step-d"
$Service    = "stepd-server"
$Region     = "us-central1"
$PublicUrl  = "https://stepd.stepai.kr"
$RepoRoot   = Split-Path -Parent $PSScriptRoot

$script:Step = 0
function Say-Step($m) { $script:Step++; Write-Host ""; Write-Host "==> [$script:Step] $m" -ForegroundColor Cyan }
function Say-Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Say-Warn($m) { Write-Host "    !!  $m" -ForegroundColor Yellow }
function Die($m)      { Write-Host ""; Write-Host "실패: $m" -ForegroundColor Red; exit 1 }

$doCloudRun = $Only -in @("all", "cloudrun")
$doWorker   = ($Only -in @("all", "worker")) -and (-not $SkipWorker)

Set-Location $RepoRoot

# ── 0. 무엇이 올라가는가 ──────────────────────────────────────────────────────
Say-Step "배포 대상"

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { Say-Warn "브랜치가 '$branch' 입니다 (로컬 워커는 origin/main 을 pull 합니다)" }

$dirty = git status --porcelain -- apps/server cloudbuild.yaml
if ($dirty) {
  Say-Warn "커밋되지 않은 백엔드 변경이 있습니다:"
  $dirty -split "`n" | Select-Object -First 8 | ForEach-Object { Write-Host "        $_" }
  Say-Warn "Cloud Run 은 로컬 소스를, 로컬 워커는 origin/main 을 씁니다 → 커밋·푸시하지 않으면 둘이 어긋납니다."
}

Write-Host "    Cloud Run  : $(if ($doCloudRun) { '배포' } else { '건너뜀' })"
Write-Host "    로컬 워커  : $(if ($doWorker)   { 'pm2 restart (git pull 후)' } else { '건너뜀' })"
Write-Host "    배포 계정  : $(if ($script:DeployAccount) { "$script:DeployAccount (--account, 비대화형)" } else { 'gcloud 활성 계정 (기본)' })"

if ($WhatIf) { Write-Host ""; Write-Host "-WhatIf — 실제 배포 안 함." -ForegroundColor Yellow; exit 0 }

# ── 1. 타입체크 ───────────────────────────────────────────────────────────────
if (-not $SkipChecks) {
  Say-Step "서버 타입체크"
  pnpm --filter "@stepd/server" typecheck
  if ($LASTEXITCODE -ne 0) { Die "타입체크 실패 — 배포하지 않았습니다" }
  Say-Ok "타입체크 통과"
} else {
  Say-Warn "타입체크 건너뜀 (-SkipChecks)"
}

# ── 2. 로컬 워커가 pull 할 코드를 먼저 푸시 ───────────────────────────────────
if ($doWorker) {
  git fetch origin main --quiet
  $ahead = [int]((git rev-list --count "origin/main..HEAD").Trim())
  if ($ahead -gt 0) {
    Say-Step "푸시 (로컬 워커가 origin/main 을 pull 하므로 선행 필요)"
    $pushCode = Invoke-Native -Exe git -NativeArgs @("push", "origin", "main")
    if ($pushCode -ne 0) { Die "git push 실패 (exit $pushCode)" }
    Say-Ok "커밋 $ahead 개 푸시"
  }
}

# ── 3. Cloud Run ──────────────────────────────────────────────────────────────
if ($doCloudRun) {
  Say-Step "Cloud Run 빌드 · 배포 (수 분 소요)"
  $buildCode = Invoke-Gcloud builds submit --config cloudbuild.yaml --project $Project
  if ($buildCode -ne 0) { Die "gcloud builds submit 실패 (exit $buildCode)" }
  Say-Ok "Cloud Run 배포 완료"
}

# ── 4. 로컬 pm2 워커 ──────────────────────────────────────────────────────────
if ($doWorker) {
  Say-Step "로컬 워커 재시작 (pm2)"

  # scripts/update-local-worker.ps1 이 실제 오케스트레이션:
  #   git pull (여기서 이미 push 됐으니 no-op) → pnpm install → typecheck (스킵)
  #   → running 잡 안전장치 → pm2 restart → online 검증
  # git pull/install/typecheck 는 상위에서 이미 했으니 스킵. -Force 는 상위에서 위임.
  $updateArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass",
                  "-File", (Join-Path $RepoRoot "scripts\update-local-worker.ps1"),
                  "-SkipPull", "-SkipInstall", "-SkipTypecheck")
  if ($Force) { $updateArgs += "-Force" }
  $code = Invoke-Native -Exe powershell -NativeArgs $updateArgs
  if ($code -ne 0) {
    Say-Warn "로컬 워커 재시작 실패 (exit $code) — running 잡이 있어 막혔거나 pm2 이슈."
    Say-Warn "  강제: .\deploy\deploy-server.ps1 -Only worker -Force"
    Say-Warn "  진단: pm2 status · pm2 logs stepd-worker"
    Die "로컬 워커 재시작 실패"
  }
  Say-Ok "로컬 워커 재시작 완료"
}

# ── 5. 확인 ───────────────────────────────────────────────────────────────────
# "배포됐다"와 "동작한다"는 다르다. Vercel 프록시(/api/proxy)를 거쳐 실 서버 상태 조회.
if (-not $SkipVerify) {
  Say-Step "확인"

  try {
    $state = Invoke-RestMethod "$PublicUrl/api/proxy/api/state" -TimeoutSec 30
    Say-Ok "/api/state 응답"

    if ($state.media -and $state.media.Count -gt 0) {
      if ($null -eq $state.media[0].PSObject.Properties['durationSec']) {
        Say-Warn "media 에 durationSec 이 없습니다 — 옛 코드가 돌고 있습니다 (Cloud Run 배포 확인 필요)"
      } else {
        Say-Ok "media 필드 온전함 (Postgres 컬럼 수정 반영됨)"
      }
    }
  } catch {
    Say-Warn "/api/state 실패 (Vercel 프록시 배포 안 됐거나 웹 미배포일 수 있음): $($_.Exception.Message)"
  }

  try {
    $q = Invoke-RestMethod "$PublicUrl/api/proxy/api/queue/stats" -TimeoutSec 30
    Say-Ok "큐: pending=$($q.pending) running=$($q.running) done=$($q.done) failed=$($q.failed)"

    if ($q.pending -gt 20) {
      Say-Warn "pending 이 쌓였습니다 — 로컬 워커가 죽었을 수 있습니다:"
      Say-Warn "  pm2 status"
      Say-Warn "  pm2 logs stepd-worker --lines 100 --nostream"
    }
    if ($q.failed -gt 0) {
      Say-Warn "실패한 잡 $($q.failed) 건 — job_queue.error 를 확인하세요"
    }
  } catch {
    Say-Warn "/api/queue/stats 실패 — Cloud Run 이 아직 새 코드가 아닐 수 있습니다"
  }
}

Write-Host ""
Write-Host "백엔드 배포 완료." -ForegroundColor Green
Write-Host "  로컬 워커 로그  pm2 logs stepd-worker" -ForegroundColor DarkGray
Write-Host "  로컬 워커 상태  pm2 status · pm2 monit" -ForegroundColor DarkGray
Write-Host "  업데이트 재시작 .\scripts\update-local-worker.ps1" -ForegroundColor DarkGray

<#
.SYNOPSIS
  백엔드 배포 — apps/server → Cloud Run (stepd-server) + 워커 VM (stepd-worker)

.DESCRIPTION
  백엔드 코드 하나가 두 곳에서 돈다:

    Cloud Run  API 를 서빙하고 잡을 큐에 넣는다 (enqueue 전용)
    워커 VM    큐에서 잡을 꺼내 실제로 실행한다 (분석 파이프라인)

  둘은 같은 소스를 쓴다. 한쪽만 배포하면 코드가 어긋나므로 이 스크립트는 함께 올린다.
  워커를 빼려면 -SkipWorker.

  ⚠️ Cloud Run 은 GitHub 푸시로 자동 배포되지 않는다 (Vercel 과 다르다).
     서버를 고쳤으면 반드시 이걸 돌려야 반영된다.

.EXAMPLE
  .\deploy\deploy-server.ps1               # 검증 → Cloud Run → 워커 → 확인
  .\deploy\deploy-server.ps1 -SkipWorker   # Cloud Run 만
  .\deploy\deploy-server.ps1 -Only worker  # 워커만 (코드 변경 없이 재시작)
  .\deploy\deploy-server.ps1 -WhatIf       # 무엇이 배포될지만 확인
#>
[CmdletBinding()]
param(
  [ValidateSet("all", "cloudrun", "worker")]
  [string]$Only = "all",

  [switch]$SkipWorker,
  [switch]$SkipChecks,
  [switch]$SkipVerify,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$Project    = "step-d"
$Service    = "stepd-server"
$Region     = "us-central1"
$WorkerVm   = "stepd-worker"
$WorkerZone = "us-central1-a"
$WorkerDir  = "/opt/stepd"
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
if ($branch -ne "main") { Say-Warn "브랜치가 '$branch' 입니다 (워커는 origin/main 을 당겨갑니다)" }

$dirty = git status --porcelain -- apps/server cloudbuild.yaml
if ($dirty) {
  # Cloud Run 은 로컬 소스를 업로드하지만 워커는 origin/main 을 pull 한다.
  # 커밋하지 않으면 둘이 서로 다른 코드로 돌게 된다.
  Say-Warn "커밋되지 않은 백엔드 변경이 있습니다:"
  $dirty -split "`n" | Select-Object -First 8 | ForEach-Object { Write-Host "        $_" }
  Say-Warn "Cloud Run 은 로컬 소스를, 워커는 origin/main 을 씁니다 → 커밋·푸시하지 않으면 둘이 어긋납니다."
}

Write-Host "    Cloud Run : $(if ($doCloudRun) { '배포' } else { '건너뜀' })"
Write-Host "    워커 VM   : $(if ($doWorker)   { '배포' } else { '건너뜀' })"

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

# ── 2. 워커가 당겨갈 코드를 먼저 푸시 ─────────────────────────────────────────
if ($doWorker) {
  git fetch origin main --quiet
  $ahead = [int](git rev-list --count "origin/main..HEAD").Trim()
  if ($ahead -gt 0) {
    Say-Step "푸시 (워커가 origin/main 을 당겨가므로 선행 필요)"
    git push origin main
    if ($LASTEXITCODE -ne 0) { Die "git push 실패" }
    Say-Ok "커밋 $ahead 개 푸시"
  }
}

# ── 3. Cloud Run ──────────────────────────────────────────────────────────────
if ($doCloudRun) {
  Say-Step "Cloud Run 빌드 · 배포 (수 분 소요)"
  gcloud builds submit --config cloudbuild.yaml --project $Project
  if ($LASTEXITCODE -ne 0) { Die "gcloud builds submit 실패" }
  Say-Ok "Cloud Run 배포 완료"
}

# ── 4. 워커 VM ────────────────────────────────────────────────────────────────
if ($doWorker) {
  Say-Step "워커 배포 ($WorkerVm)"

  gcloud compute instances describe $WorkerVm --zone $WorkerZone --project $Project --format="value(name)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Say-Warn "VM '$WorkerVm' 이 없습니다 — 건너뜁니다. 생성 방법은 docs/worker-queue.md."
  } else {
    # 워커는 SIGTERM 을 받으면 처리 중인 잡을 끝내고 종료한다 → restart 가 작업을 자르지 않는다.
    $remote = @(
      "cd $WorkerDir",
      "sudo git fetch --depth 1 origin main",
      "sudo git reset --hard origin/main",
      "sudo systemctl restart stepd-worker",
      "sleep 3",
      "sudo systemctl is-active stepd-worker"
    ) -join "; "

    gcloud compute ssh $WorkerVm --zone $WorkerZone --project $Project --command $remote
    if ($LASTEXITCODE -ne 0) { Die "워커 배포 실패" }
    Say-Ok "워커 재시작 완료"
  }
}

# ── 5. 확인 ───────────────────────────────────────────────────────────────────
# "배포됐다"와 "동작한다"는 다르다. 실제로 찔러본다.
if (-not $SkipVerify) {
  Say-Step "확인"

  try {
    $state = Invoke-RestMethod "$PublicUrl/api/state" -TimeoutSec 30
    Say-Ok "/api/state 응답"

    # Postgres 가 따옴표 없는 식별자를 소문자로 접는 버그의 카나리아.
    # 수정 전에는 media 행에서 durationSec / episodeId 가 통째로 사라졌다.
    if ($state.media -and $state.media.Count -gt 0) {
      if ($null -eq $state.media[0].PSObject.Properties['durationSec']) {
        Say-Warn "media 에 durationSec 이 없습니다 — 옛 코드가 돌고 있습니다 (Cloud Run 배포 확인 필요)"
      } else {
        Say-Ok "media 필드 온전함 (Postgres 컬럼 수정 반영됨)"
      }
    }
  } catch {
    Die "/api/state 실패: $($_.Exception.Message)"
  }

  try {
    $q = Invoke-RestMethod "$PublicUrl/api/queue/stats" -TimeoutSec 30
    Say-Ok "큐: pending=$($q.pending) running=$($q.running) done=$($q.done) failed=$($q.failed)"

    if ($q.pending -gt 20) {
      Say-Warn "pending 이 쌓였습니다 — 워커가 죽었을 수 있습니다:"
      Say-Warn "  gcloud compute ssh $WorkerVm --zone $WorkerZone --command 'sudo journalctl -u stepd-worker -n 50'"
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
Write-Host "  워커 로그  gcloud compute ssh $WorkerVm --zone $WorkerZone --command 'sudo journalctl -u stepd-worker -f'"

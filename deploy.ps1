#Requires -Version 5.1
<#
.SYNOPSIS
    Build + deploy the STEP-D server (apps/server) to Cloud Run.

.DESCRIPTION
    Runs the root cloudbuild.yaml, which builds apps/server/Dockerfile (ffmpeg baked in),
    pushes the image to Artifact Registry, and deploys the `stepd-server` Cloud Run service
    in us-central1 (project step-d). After a successful deploy it polls /health to confirm
    the new revision is serving.

    NOTE: This deploys ONLY the server. The web app (apps/web) deploys via Vercel on
    `git push origin main`. The old apps/api Python VM path is gone.

.PARAMETER SkipPull
    Skip the `git pull` step (deploy the current working tree as-is).

.PARAMETER SkipHealthCheck
    Skip the post-deploy /health poll (just build + deploy).

.EXAMPLE
    .\deploy.ps1                    # git pull + build + deploy + health check
    .\deploy.ps1 -SkipPull          # deploy current tree without pulling
    .\deploy.ps1 -SkipHealthCheck   # build + deploy only
#>
param(
    [switch]$SkipPull,
    [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"

$PROJECT = "step-d"
$REGION  = "us-central1"
$SERVICE = "stepd-server"
$CONFIG  = "cloudbuild.yaml"

# Run from the repo root so Cloud Build can access the whole monorepo (Dockerfile needs it).
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
if (-not (Test-Path $CONFIG)) {
    throw "cloudbuild.yaml not found in $repoRoot — run this from the repo root."
}

# ── 1. Pull latest ──────────────────────────────────────────────────────────────
if ($SkipPull) {
    Write-Host "==> Skipping git pull (-SkipPull)." -ForegroundColor Yellow
} else {
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    Write-Host "==> Pulling latest ($branch)..." -ForegroundColor Cyan
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        throw "git pull failed (exit $LASTEXITCODE) — resolve conflicts / commit local changes, or re-run with -SkipPull."
    }
}

# ── 2. Build + deploy ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Building + deploying '$SERVICE' to Cloud Run ($REGION, project=$PROJECT)..." -ForegroundColor Cyan
Write-Host "    (Docker build + Artifact Registry push + Cloud Run deploy — 보통 5~10분)" -ForegroundColor DarkGray
Write-Host ""

gcloud builds submit --config=$CONFIG --project=$PROJECT
if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "==> Deployed." -ForegroundColor Green

# ── 3. Health check ─────────────────────────────────────────────────────────────
if ($SkipHealthCheck) {
    Write-Host "==> Skipping health check (-SkipHealthCheck)." -ForegroundColor Yellow
    return
}

Write-Host "==> Resolving service URL..." -ForegroundColor Cyan
$url = gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format="value(status.url)"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($url)) {
    Write-Host "!! Could not resolve service URL — check the Cloud Run console." -ForegroundColor Yellow
    return
}
$url = $url.Trim()
Write-Host "    $url" -ForegroundColor DarkGray

Write-Host "==> Polling $url/health ..." -ForegroundColor Cyan
try {
    $resp = Invoke-RestMethod -Uri "$url/health" -Method Get -TimeoutSec 30
    Write-Host ""
    Write-Host "==> Health: ok=$($resp.ok) ffmpeg=$($resp.ffmpeg)" -ForegroundColor Green
    Write-Host "==> Deploy complete!" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "!! Health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "   (배포 자체는 성공했을 수 있음 — 콜드스타트/DB 초기화 대기일 수 있으니 잠시 후 다시 확인)" -ForegroundColor DarkGray
    Write-Host "   수동 확인:  curl $url/health" -ForegroundColor DarkGray
}

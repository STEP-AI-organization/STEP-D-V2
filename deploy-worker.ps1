#Requires -Version 5.1
<#
.SYNOPSIS
    Deploy latest main to the STEP-D worker VM (stepd-worker) and restart it.

.DESCRIPTION
    The worker runs the TS source from /opt/stepd (tsx), so a deploy is just:
    fetch origin → hard-reset to origin/main → restart the systemd service.

    Uses `git reset --hard` (not `pull`) on purpose: it discards any local drift on
    the VM (e.g. a file hot-copied via scp) and makes the tree exactly match main —
    so the deploy is idempotent and never blocks on "local changes would be overwritten".

    Auth: the VM's git remote already carries a read-only token in its URL, so fetch
    works non-interactively. (Rotate that token periodically; see runbook.)

.EXAMPLE
    .\deploy-worker.ps1
#>
param(
    [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"

$PROJECT = "step-d"
$ZONE    = "us-central1-a"
$VM      = "stepd-worker"
$APP     = "/opt/stepd"

$restart = if ($SkipRestart) {
    "echo 'skip restart'"
} else {
    "sudo systemctl daemon-reload && sudo systemctl restart stepd-worker && sleep 3 && systemctl is-active stepd-worker"
}

# Single remote command: update code, (re)start, and confirm the shorts wiring is present.
$remote = "cd $APP && sudo git fetch origin && sudo git reset --hard origin/main && $restart && echo '--- 배선 확인 ---' && grep -c writeRecommendationsFromShorts apps/server/src/content-pipeline.ts"

Write-Host ""
Write-Host "==> Deploying latest main to worker VM '$VM' ($ZONE)..." -ForegroundColor Cyan
Write-Host ""

gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --command=$remote
if ($LASTEXITCODE -ne 0) { throw "worker deploy failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "==> Worker deploy complete. (기대: 'active' 그리고 '1' 이상)" -ForegroundColor Green

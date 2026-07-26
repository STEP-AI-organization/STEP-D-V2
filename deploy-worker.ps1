#Requires -Version 5.1
<#
.SYNOPSIS
    로컬 워커(pm2) 업데이트 · 재시작. GCE VM 은 더 이상 안 쓴다.

.DESCRIPTION
    2026-07-26 이후 워커는 로컬 컴 pm2 프로세스. 이 스크립트는
    scripts/update-local-worker.ps1 을 그대로 호출하는 얇은 래퍼다 (기존 tooling
    호환용). 새 스크립트를 바로 써도 된다.

.EXAMPLE
    .\deploy-worker.ps1              # git pull + typecheck + safe pm2 restart
    .\deploy-worker.ps1 -Force       # running 잡 있어도 재시작
    .\deploy-worker.ps1 -SkipPull    # 로컬 편집만 반영
#>
param(
    [switch]$Force,
    [switch]$SkipPull,
    [switch]$SkipInstall,
    [switch]$SkipTypecheck
)

$ErrorActionPreference = "Stop"
$Script = Join-Path $PSScriptRoot "scripts\update-local-worker.ps1"
if (-not (Test-Path $Script)) { Write-Host "실패: $Script 없음" -ForegroundColor Red; exit 1 }

$passArgs = @()
if ($Force)         { $passArgs += "-Force" }
if ($SkipPull)      { $passArgs += "-SkipPull" }
if ($SkipInstall)   { $passArgs += "-SkipInstall" }
if ($SkipTypecheck) { $passArgs += "-SkipTypecheck" }

& powershell -NoProfile -ExecutionPolicy Bypass -File $Script @passArgs
exit $LASTEXITCODE

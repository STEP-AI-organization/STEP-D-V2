$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $root "apps/api"
$webDir = Join-Path $root "apps/web"
$venvActivate = Join-Path $root ".venv/Scripts/Activate.ps1"

Write-Host "Starting API on http://127.0.0.1:8010"
Start-Process powershell -WindowStyle Hidden -WorkingDirectory $apiDir -ArgumentList "-NoExit", "-Command", "& '$venvActivate'; uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload"

Write-Host "Starting Web on http://localhost:3000"
Start-Process powershell -WindowStyle Hidden -WorkingDirectory $webDir -ArgumentList "-NoExit", "-Command", "npm run dev"

Write-Host "Monorepo dev servers requested."

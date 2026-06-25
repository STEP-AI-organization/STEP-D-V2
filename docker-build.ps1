# Build the API image with Docker's CLASSIC builder. (Web runs outside Docker.)
#
# Why: this repo lives under a non-ASCII (Korean) folder name. Docker Compose's
# default BuildKit/bake builder puts the build-context folder name into a gRPC
# session header and fails with:
#   header key "x-docker-expose-session-sharedkey" contains value with
#   non-printable ASCII characters
# The classic builder (DOCKER_BUILDKIT=0) does not use that session, so it builds
# fine. After building, start the stack with `docker compose up -d` (NO --build).
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\docker-build.ps1
#         docker compose up -d

$ErrorActionPreference = "Stop"
$env:DOCKER_BUILDKIT = "0"

Write-Host "Building ai-shorts-api:local (classic builder)..." -ForegroundColor Cyan
docker build -f apps/api/Dockerfile -t ai-shorts-api:local .
if ($LASTEXITCODE -ne 0) { throw "api image build failed" }

Write-Host "`nDone. Now start api + postgres (uses the image just built):" -ForegroundColor Green
Write-Host "  docker compose up -d" -ForegroundColor Green

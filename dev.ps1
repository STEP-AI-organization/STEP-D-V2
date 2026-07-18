<#
.SYNOPSIS
  로컬 개발 스택 — Postgres(Docker) + 웹 + 서버, 핫리로드.

.DESCRIPTION
  이거 하나면 로컬 개발 환경이 뜬다. 배포 없이 여기서 돌린다.

    Postgres  Docker 컨테이너 stepd-pg (localhost:5432, db=stepd)
    서버      apps/server → localhost:4100  (tsx watch, 저장하면 자동 재시작)
    웹        apps/web    → localhost:3000  (next dev, 핫리로드)

  웹은 apps/web/.env.local 의 NEXT_PUBLIC_API_URL=http://localhost:4100/api 로
  로컬 서버를 직접 호출한다 (GCP 프록시·Cloud Run 안 씀).

.EXAMPLE
  .\dev.ps1          # 전부 기동
  .\dev.ps1 -DbOnly  # Postgres만 (서버/웹은 따로 돌릴 때)
#>
[CmdletBinding()]
param([switch]$DbOnly)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── Postgres (Docker) ─────────────────────────────────────────────────────────
$exists = docker ps -a --filter "name=stepd-pg" --format "{{.Names}}"
if (-not $exists) {
  Write-Host "Postgres 컨테이너 생성..." -ForegroundColor Cyan
  docker run -d --name stepd-pg `
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=stepd `
    -p 5432:5432 -v stepd-pg-data:/var/lib/postgresql/data `
    postgres:16-alpine | Out-Null
} else {
  docker start stepd-pg | Out-Null
}

Write-Host "Postgres 준비 대기..." -NoNewline
for ($i = 0; $i -lt 30; $i++) {
  docker exec stepd-pg pg_isready -U postgres 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
Write-Host " OK (localhost:5432)" -ForegroundColor Green

# ── DB 마이그레이션 (node-pg-migrate) ─────────────────────────────────────────
# initDb()의 CREATE TABLE IF NOT EXISTS 부트스트랩은 일부 테이블만 만든다. 0002~ 이후
# 추가된 테이블(transcript · program_cast · episode_cast)은 마이그레이션에만 있으므로,
# 여기서 밀린 마이그레이션을 적용한다. 이미 최신이면 no-op. 로컬 DATABASE_URL(apps/server/.env)
# 만 대상으로 하며 additive라 안전. 실패해도 개발 기동은 막지 않는다(경고만).
Write-Host "DB 마이그레이션 적용..." -NoNewline
try {
  pnpm --filter @stepd/server migrate up | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host " OK" -ForegroundColor Green }
  else { Write-Host " 경고: migrate up 실패(exit $LASTEXITCODE) — 'pnpm --filter @stepd/server migrate:status'로 확인" -ForegroundColor Yellow }
} catch {
  Write-Host " 경고: migrate up 실행 불가 — $($_.Exception.Message)" -ForegroundColor Yellow
}

if ($DbOnly) {
  Write-Host "DB만 기동. 서버/웹은 'pnpm dev' 로 실행하세요." -ForegroundColor Yellow
  return
}

# ── 웹 + 서버 (핫리로드, 병렬) ────────────────────────────────────────────────
Write-Host ""
Write-Host "웹 → http://localhost:3000   서버 → http://localhost:4100" -ForegroundColor Green
Write-Host "Ctrl+C 로 둘 다 종료. (Postgres 컨테이너는 계속 떠 있음)" -ForegroundColor DarkGray
Write-Host ""
pnpm dev

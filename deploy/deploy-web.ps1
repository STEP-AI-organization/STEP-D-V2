<#
.SYNOPSIS
  프론트엔드 배포 — apps/web → Vercel (step-d-v2-web)

.DESCRIPTION
  Vercel 은 main 푸시를 감지해 자동 빌드한다. 이 스크립트는 그 앞뒤를 책임진다:
  올리기 전에 로컬에서 `next build` 로 막고, 올린 뒤 실제 배포 결과를 지켜본다.

  ⚠️ NEXT_PUBLIC_* 는 빌드 시점에 번들로 구워진다. Vercel env 를 바꿨다면
     반드시 재배포해야 반영된다 (-Force 로 커밋 없이도 재배포 가능).

.EXAMPLE
  .\deploy\deploy-web.ps1              # 검증 → 푸시 → Vercel 빌드 확인
  .\deploy\deploy-web.ps1 -Force       # 푸시할 커밋이 없어도 강제 재배포 (env 변경 후)
  .\deploy\deploy-web.ps1 -SkipChecks  # 로컬 빌드 생략 (급할 때만)
#>
[CmdletBinding()]
param(
  [switch]$SkipChecks,
  [switch]$Force,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$Project    = "step-d-v2-web"
$Scope      = "step-ai"
$PublicUrl  = "https://stepd.stepai.kr"
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$TokenFile  = Join-Path $RepoRoot "gcp-keys\vercel-token.txt"

$script:Step = 0
function Say-Step($m) { $script:Step++; Write-Host ""; Write-Host "==> [$script:Step] $m" -ForegroundColor Cyan }
function Say-Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Say-Warn($m) { Write-Host "    !!  $m" -ForegroundColor Yellow }
function Die($m)      { Write-Host ""; Write-Host "실패: $m" -ForegroundColor Red; exit 1 }

Set-Location $RepoRoot

# ── 1. 로컬 검증 ──────────────────────────────────────────────────────────────
# Vercel 이 돌리는 것과 같은 명령. 여기서 깨지면 거기서도 깨진다.
if (-not $SkipChecks) {
  Say-Step "웹 빌드 (next build — 타입 · 프리렌더까지 검사)"
  Push-Location "$RepoRoot\apps\web"
  try {
    npx next build
    if ($LASTEXITCODE -ne 0) { Die "next build 실패 — 푸시하지 않았습니다" }
    Say-Ok "빌드 통과"
  } finally { Pop-Location }
} else {
  Say-Warn "로컬 빌드 건너뜀 (-SkipChecks)"
}

# ── 2. 푸시 → Vercel 자동 빌드 ────────────────────────────────────────────────
Say-Step "푸시"

$dirty = git status --porcelain
if ($dirty) {
  Say-Warn "커밋되지 않은 변경은 배포되지 않습니다:"
  $dirty -split "`n" | Select-Object -First 8 | ForEach-Object { Write-Host "        $_" }
}

git fetch origin main --quiet
$ahead = [int](git rev-list --count "origin/main..HEAD").Trim()

if ($ahead -gt 0) {
  git log --oneline "origin/main..HEAD" | ForEach-Object { Write-Host "        $_" }
  git push origin main
  if ($LASTEXITCODE -ne 0) { Die "git push 실패" }
  Say-Ok "푸시 완료 — Vercel 빌드 시작"
} elseif ($Force) {
  Say-Warn "푸시할 커밋 없음 — 강제 재배포합니다 (-Force)"
} else {
  Say-Ok "이미 최신 — 배포할 것이 없습니다"
  Say-Warn "Vercel env 를 바꾼 뒤라면 -Force 로 재배포해야 반영됩니다 (NEXT_PUBLIC_* 는 빌드 시 구워짐)"
  exit 0
}

# ── 3. Vercel 배포 결과 지켜보기 ──────────────────────────────────────────────
if (-not (Test-Path $TokenFile)) {
  Say-Warn "Vercel 토큰이 없습니다 ($TokenFile) — 배포 상태를 확인할 수 없습니다."
  Say-Warn "대시보드에서 직접 확인하세요. 토큰 발급은 docs/vercel-ops.md 참고."
  exit 0
}
$token = (Get-Content $TokenFile -Raw).Trim()

if ($Force) {
  Say-Step "강제 재배포"
  npx vercel deploy --prod --yes --token=$token --scope $Scope --cwd "$RepoRoot\apps\web"
  if ($LASTEXITCODE -ne 0) { Die "vercel deploy 실패" }
}

Say-Step "Vercel 빌드 대기"
$deadline = (Get-Date).AddMinutes(10)
$status = ""
while ((Get-Date) -lt $deadline) {
  $line = (npx vercel ls $Project --token=$token --scope $Scope 2>$null | Select-String "Production" | Select-Object -First 1).ToString()
  if ($line -match "Ready")    { $status = "Ready";    break }
  if ($line -match "Error")    { $status = "Error";    break }
  if ($line -match "Canceled") { $status = "Canceled"; break }
  Write-Host "    빌드 중..." -NoNewline
  Write-Host "`r" -NoNewline
  Start-Sleep -Seconds 10
}

if ($status -eq "Ready") {
  Say-Ok "Vercel 배포 완료"
} elseif ($status -eq "") {
  Say-Warn "10분 내에 끝나지 않았습니다 — 대시보드를 확인하세요"
} else {
  Write-Host ""
  Say-Warn "배포 상태: $status"
  Write-Host "    빌드 로그:" -ForegroundColor Yellow
  npx vercel inspect --logs --token=$token --scope $Scope 2>&1 | Select-Object -Last 30
  Die "Vercel 배포 실패"
}

# ── 4. 실제로 뜨는지 확인 ─────────────────────────────────────────────────────
if (-not $SkipVerify) {
  Say-Step "확인"
  foreach ($p in @("/", "/register", "/privacy")) {
    try {
      $r = Invoke-WebRequest "$PublicUrl$p" -TimeoutSec 20 -UseBasicParsing
      Say-Ok "$p → $($r.StatusCode)"
    } catch {
      Say-Warn "$p → 실패: $($_.Exception.Message)"
    }
  }
}

Write-Host ""
Write-Host "웹 배포 완료 — $PublicUrl" -ForegroundColor Green

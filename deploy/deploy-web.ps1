<#
.SYNOPSIS
  프론트엔드 배포 — apps/web → Vercel (step-d-v2-web)

.DESCRIPTION
  Vercel 은 main 푸시를 감지해 자동 빌드한다. 이 스크립트는 그 앞뒤를 책임진다:
  ① 배포 author 강제  ② 로컬 next build 검증  ③ push  ④ Vercel 빌드 감시  ⑤ 라이브 확인.

  ⚠️ 함정(2026-07-16): Vercel git 배포는 커밋 author 이메일이 Vercel 팀 멤버여야 빌드된다.
     ha983885@snu.ac.kr(hakyungjin) author 커밋은 "Git author must have access"로 조용히
     UNKNOWN 차단(에러도 없이 무한 대기처럼 보임). → author 를 contact@stepai.kr 로 강제한다.

.EXAMPLE
  .\deploy\deploy-web.ps1              # author 강제 → 검증 → 푸시 → 배포 확인
  .\deploy\deploy-web.ps1 -SkipChecks  # 로컬 빌드 생략 (급할 때만)
#>
[CmdletBinding()]
param(
  [switch]$SkipChecks,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$Project     = "step-d-v2-web"
$Scope       = "step-ai"
$PublicUrl   = "https://stepd.stepai.kr"
$DeployEmail = "contact@stepai.kr"   # Vercel 팀 멤버여야 함 (필수)
$DeployName  = "contact"
$RepoRoot    = Split-Path -Parent $PSScriptRoot
$TokenFile   = Join-Path $RepoRoot "gcp-keys\vercel-token.txt"

function Say($m)  { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host ""; Write-Host "실패: $m" -ForegroundColor Red; exit 1 }

# git 등 네이티브 exe 는 Start-Process 로 실행한다. PS 5.1 은 네이티브 stderr(예: git push
# 진행표시)를 NativeCommandError 로 감싸 ErrorActionPreference=Stop 에서 오탐 종료시키기 때문.
function Invoke-Native([string]$exe, [string[]]$argList) {
  $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -NoNewWindow -PassThru
  return $p.ExitCode
}

Set-Location $RepoRoot

# ── 1. 배포 author 강제 ───────────────────────────────────────────────────────
Say "배포 author = $DeployEmail 강제 (Vercel 팀 멤버라야 빌드됨)"
git config user.email $DeployEmail
git config user.name  $DeployName
Ok "git config (이 리포 로컬)"

Invoke-Native "git" @("fetch", "origin", "main", "--quiet") | Out-Null
$ahead = [int]((git rev-list --count "origin/main..HEAD").Trim())

# 미푸시 커밋 중 author 가 다르면 재작성한다 (아직 origin 에 없으니 force-push 불필요·안전).
if ($ahead -gt 0) {
  $bad = git log "origin/main..HEAD" --format="%ae" | Where-Object { $_ -ne $DeployEmail }
  if ($bad) {
    Warn "미푸시 커밋 $ahead 개에 다른 author 발견 → $DeployEmail 로 재작성"
    $env:GIT_COMMITTER_NAME  = $DeployName
    $env:GIT_COMMITTER_EMAIL = $DeployEmail
    git rebase "origin/main" --exec "git commit --amend --reset-author --no-edit" *> $null
    if ($LASTEXITCODE -ne 0) { git rebase --abort *> $null; Die "author 재작성 실패 — 수동 확인 필요" }
    Ok "재작성 완료"
  }
}

# ── 2. 로컬 검증 (Vercel 과 동일한 명령) ──────────────────────────────────────
if (-not $SkipChecks) {
  Say "웹 빌드 (next build — 타입·프리렌더까지 검사)"
  Push-Location "$RepoRoot\apps\web"
  try {
    npx next build
    if ($LASTEXITCODE -ne 0) { Die "next build 실패 — 푸시하지 않았습니다" }
    Ok "빌드 통과"
  } finally { Pop-Location }
} else {
  Warn "로컬 빌드 건너뜀 (-SkipChecks)"
}

# ── 3. push → Vercel 자동 빌드 ────────────────────────────────────────────────
Say "push"
$dirty = git status --porcelain
if ($dirty) {
  Warn "커밋되지 않은 변경은 배포되지 않습니다:"
  ($dirty -split "`n" | Select-Object -First 6) | ForEach-Object { Write-Host "        $_" }
}
$ahead = [int]((git rev-list --count "origin/main..HEAD").Trim())
if ($ahead -le 0) { Ok "이미 최신 — 배포할 커밋 없음"; exit 0 }

git log --oneline "origin/main..HEAD" | ForEach-Object { Write-Host "        $_" }
if ((Invoke-Native "git" @("push", "origin", "main")) -ne 0) { Die "git push 실패" }
Ok "푸시 완료 — Vercel 빌드 시작"

# ── 4. Vercel 빌드 감시 ───────────────────────────────────────────────────────
if (-not (Test-Path $TokenFile)) {
  Warn "Vercel 토큰 없음 ($TokenFile) — 대시보드에서 확인하세요 (docs/ops/vercel-ops.md)"
  exit 0
}
$token = (Get-Content $TokenFile -Raw).Trim()

Say "Vercel 빌드 대기 (author 가 팀 멤버 아니면 UNKNOWN 으로 안 끝남)"
$deadline = (Get-Date).AddMinutes(8)
$status = ""
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 12
  $line = (npx vercel ls $Project --token=$token --scope $Scope 2>$null |
           Select-String "step-d-v2-" | Select-Object -First 1)
  if ($line -match "Ready")    { $status = "Ready";    break }
  if ($line -match "Error")    { $status = "Error";    break }
  if ($line -match "Canceled") { $status = "Canceled"; break }
  Write-Host "    빌드 중..." -ForegroundColor DarkGray
}

if ($status -eq "Ready") {
  Ok "Vercel 배포 완료"
} elseif ($status -eq "") {
  Warn "8분 내 미완료 — 대시보드 확인 (커밋 author 가 $DeployEmail 인지 먼저 볼 것)"
} else {
  Die "Vercel 배포 상태: $status"
}

# ── 5. 실제로 뜨는지 확인 ─────────────────────────────────────────────────────
if (-not $SkipVerify) {
  Say "확인"
  foreach ($p in @("/", "/channels", "/register")) {
    try {
      $r = Invoke-WebRequest "$PublicUrl$p" -TimeoutSec 20 -UseBasicParsing
      Ok "$p → $($r.StatusCode)"
    } catch {
      Warn "$p → 실패: $($_.Exception.Message)"
    }
  }
}

Write-Host ""
Write-Host "웹 배포 완료 — $PublicUrl" -ForegroundColor Green

#Requires -Version 5.1
<#
.SYNOPSIS
  윈도우2(네이버 워커) 즉시 갱신 — SSH 로 self-update 를 바로 돌린다.

.DESCRIPTION
  평소에는 윈도우2 가 스스로 당겨온다(작업 스케줄러 · 최대 10분 지연). 이 스크립트는
  **배포 직후 기다리지 않고 즉시** 반영하고 싶을 때 쓴다.

  **같은 LAN 이면 VPN 이 필요 없다** — 내부 IP·호스트명을 그대로 주면 된다.
  Tailscale 은 윈도우2 가 다른 망에 있거나 재택에서 붙어야 할 때만 의미가 있다.

  ⚠️ 폴링(스케줄러)을 없애지 말 것. 이 push 는 **빠른 경로일 뿐 보장 경로가 아니다** —
  PC 가 꺼져 있거나 SSH 가 막히면 실패하고, 그때는 폴링이 나중에 따라잡아야 한다.

.EXAMPLE
  .\deploy\naver-pc\push-update.ps1 -TargetHost 192.168.13.14 -User STEPAI04
  .\deploy\naver-pc\push-update.ps1 -TargetHost DESKTOP-IGVKIBN -User STEPAI04
#>
[CmdletBinding()]
param(
  # LAN 호스트명·내부 IP·Tailscale 이름 무엇이든 된다. ($Host 는 PowerShell 예약어라 못 쓴다)
  [Parameter(Mandatory = $true)][Alias("TailscaleHost")][string]$TargetHost,
  [string]$User = $env:USERNAME,
  # 비우면 원격에서 찾는다 — 클론 폴더가 STEPD-repo 일 수도 STEP-D-V2 일 수도 있다
  # (리포 이름이 STEP-D-V2 라 그대로 클론하면 후자가 된다).
  [string]$RepoPath = ""
)

$ErrorActionPreference = "Stop"
$target = "$User@$TargetHost"
Write-Host "==> $target 에 갱신 지시"

# 원격에서 실행할 PowerShell. 경로를 안 주면 후보를 훑는다 — 매번 폴더 이름을 외우지 않게.
# self-update.ps1 에 인자를 넘기지 않는다 — SSH 를 거치면 인자 파싱이 깨진다
# ("-RepoRoot 이(가) 사용되지 않았습니다"). 스크립트가 자기 위치로 리포 루트를 계산한다.
if ($RepoPath) {
  $resolve = "`$r = '$RepoPath'"
} else {
  $resolve = '$r = @("$env:USERPROFILE\STEPD-repo", "$env:USERPROFILE\STEP-D-V2") | ' +
             'Where-Object { Test-Path (Join-Path $_ ".git") } | Select-Object -First 1'
}
$script = $resolve + '; ' +
  'if (-not $r) { Write-Error "repo not found - use -RepoPath"; exit 1 }; ' +
  '& (Join-Path $r "deploy\naver-pc\self-update.ps1")'

# BatchMode: 비밀번호 프롬프트가 뜨면 배포가 멈춘다 — 키 인증이 안 되어 있으면 즉시 실패시킨다.
# ⚠️ 원격 기본 셸이 cmd.exe 라 파이프(|)·따옴표가 PowerShell 에 닿기 전에 잘린다.
#    -EncodedCommand(UTF-16LE base64)로 넘기면 셸을 거치지 않아 그 문제가 사라진다.
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$out = & ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "ConnectTimeout=15" `
            $target "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc" 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { Write-Host "    $_" }

if ($code -ne 0) {
  Write-Host ""
  Write-Warning "원격 갱신 실패 (exit $code). 확인 순서:"
  Write-Warning "  1. 윈도우2 가 켜져 있고 네트워크에 닿는가 (ping)"
  Write-Warning "  2. sshd 가 떠 있는가 (Get-Service sshd)"
  Write-Warning "  3. 키 인증이 되는가 (관리자 계정은 administrators_authorized_keys 를 쓴다)"
  Write-Warning "폴링(작업 스케줄러)이 살아 있으면 몇 분 뒤 알아서 따라잡는다 — 치명적이지 않다."
  exit 1
}

Write-Host "==> 완료"

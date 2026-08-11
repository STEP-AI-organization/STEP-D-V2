#Requires -Version 5.1
<#
.SYNOPSIS
  윈도우2(네이버 워커) 즉시 갱신 — Tailscale 로 SSH 해서 self-update 를 바로 돌린다.

.DESCRIPTION
  평소에는 윈도우2 가 스스로 당겨온다(작업 스케줄러). 이 스크립트는 **배포 직후 기다리지
  않고 즉시** 반영하고 싶을 때 쓴다. 배포 파이프라인 끝에 붙여도 되고, 손으로 쳐도 된다.

  Tailscale 이라 NAT·포트포워딩·고정IP 가 필요 없다 — 테일넷 안에서는 그냥 닿는다.

  ⚠️ 폴링(스케줄러)을 없애지 말 것. 이 push 는 **빠른 경로일 뿐 보장 경로가 아니다** —
  PC 가 꺼져 있거나 SSH 가 막히면 실패하고, 그때는 폴링이 나중에 따라잡아야 한다.

.EXAMPLE
  .\deploy\naver-pc\push-update.ps1 -TailscaleHost win-skp4vv5uc23
  .\deploy\naver-pc\push-update.ps1 -TailscaleHost 100.84.183.74 -User STEPAI05
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TailscaleHost,
  [string]$User     = $env:USERNAME,
  [string]$RepoPath = "C:\Users\$($env:USERNAME)\STEPD-repo",
  [int]$TimeoutSec  = 300
)

$ErrorActionPreference = "Stop"
$target = "$User@$TailscaleHost"
Write-Host "==> $target 에 갱신 지시"

# 워커 PC 의 self-update.ps1 을 -Force 로 돌린다. 원격 SHA 비교는 그쪽에서 한다.
$remote = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$RepoPath\deploy\naver-pc\self-update.ps1`""

# BatchMode: 비밀번호 프롬프트가 뜨면 배포가 멈춘다 — 키 인증이 안 되어 있으면 즉시 실패시킨다.
$out = & ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new `
            -o "ConnectTimeout=15" $target $remote 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { Write-Host "    $_" }

if ($code -ne 0) {
  Write-Host ""
  Write-Warning "원격 갱신 실패 (exit $code). 확인 순서:"
  Write-Warning "  1. tailscale status — 그 PC 가 온라인인가"
  Write-Warning "  2. 그 PC 에 OpenSSH Server 가 켜져 있는가 (Get-Service sshd)"
  Write-Warning "  3. 키 인증이 되는가 (관리자 계정은 administrators_authorized_keys 를 쓴다)"
  Write-Warning "폴링(작업 스케줄러)이 살아 있으면 몇 분 뒤 알아서 따라잡는다 — 치명적이지 않다."
  exit 1
}

Write-Host "==> 완료"

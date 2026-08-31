#requires -Version 5.1
<#
  stepd:// 프로토콜 등록 — 웹의 "프리미어에서 편집" 버튼이 프리미어를 띄울 수 있게 한다.

  왜 필요한가: 브라우저는 보안상 임의의 프로그램을 실행할 수 없다. 유일하게 허용된 길이
  **등록된 URL 스킴**이라, `stepd://` 를 이 PC 에 등록해 두면 링크 한 번으로 앱이 뜬다.

  ⚠️ 관리자 권한이 필요 없다 — HKCU(현재 사용자)에만 쓴다. 편집자 PC 마다 한 번 실행한다.
  제거는 `install.ps1 -Uninstall`.

  맥락(어느 회차인가)은 여기로 오지 않는다. UXP 패널에는 OS 가 인자를 넘길 문이 없어서,
  웹이 서버에 남기고 패널이 폴링해 집어간다. 그래서 이 스크립트는 **실행만** 책임진다.
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\stepd'

if ($Uninstall) {
  if (Test-Path $key) {
    Remove-Item $key -Recurse -Force
    Write-Host 'stepd:// 등록을 제거했습니다.'
  } else {
    Write-Host '등록돼 있지 않습니다 — 할 일 없음.'
  }
  return
}

$cmd = Join-Path $PSScriptRoot 'open-premiere.cmd'
if (-not (Test-Path $cmd)) {
  throw "open-premiere.cmd 를 찾지 못했습니다: $cmd"
}

# URL 스킴의 최소 형태: 기본값에 "URL:<설명>", 빈 "URL Protocol" 값, shell\open\command.
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name '(default)'   -Value 'URL:STEP-D Protocol' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'URL Protocol' -Value ''                    -PropertyType String -Force | Out-Null

$cmdKey = Join-Path $key 'shell\open\command'
New-Item -Path $cmdKey -Force | Out-Null
# %1 은 stepd://... URL 전체다. 스크립트는 안 읽지만, 넘겨 둬야 나중에 쓸 수 있다.
New-ItemProperty -Path $cmdKey -Name '(default)' -Value ('"{0}" "%1"' -f $cmd) -PropertyType String -Force | Out-Null

Write-Host "stepd:// 등록 완료 → $cmd"
Write-Host '확인: 브라우저 주소창에 stepd://test 를 입력하면 프리미어가 떠야 합니다.'

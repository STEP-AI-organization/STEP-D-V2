#requires -Version 5.1
<#
  STEP-D 렌더 글꼴 설치 — 지마켓 산스.

  왜 필요한가: 프리미어가 제목·자막을 **우리 글꼴로** 그리려면 그 글꼴이 Windows 에 설치돼
  있어야 한다. 서버 렌더는 컨테이너 안에 폰트를 넣어 두지만(Dockerfile), 편집자 PC 는 아무도
  안 챙긴다 — 그래서 프리미어에서만 글꼴이 달라지는 어긋남이 생긴다.

  ⚠️ **관리자 권한이 필요 없다.** 사용자 폰트로 설치한다:
     파일 → %LOCALAPPDATA%\Microsoft\Windows\Fonts
     등록 → HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts
  Windows 10 1809+ 가 이 조합을 정식 지원한다. 제거는 -Uninstall.

  ⚠️ **이미 설치돼 있으면 아무것도 하지 않는다** — 같은 글꼴을 두 번 넣으면 프리미어 글꼴
     목록에 중복으로 뜨고, 어느 쪽이 쓰이는지 사람이 알 수 없게 된다.
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

# 웹에 이미 서빙 중인 파일을 받는다 — 리포를 클론하지 않은 편집자 PC 에서도 되게.
$sources = @(
  @{ Name = 'GmarketSansTTFBold.ttf';   Url = 'https://stepd.stepai.kr/fonts/GmarketSansTTFBold.ttf' },
  @{ Name = 'GmarketSansTTFMedium.ttf'; Url = 'https://stepd.stepai.kr/fonts/GmarketSansTTFMedium.ttf' }
)

$fontDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$regPath = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'

if ($Uninstall) {
  foreach ($s in $sources) {
    $target = Join-Path $fontDir $s.Name
    Get-ItemProperty $regPath -ErrorAction SilentlyContinue |
      Get-Member -MemberType NoteProperty |
      Where-Object { $_.Name -like 'Gmarket Sans*' } |
      ForEach-Object { Remove-ItemProperty -Path $regPath -Name $_.Name -ErrorAction SilentlyContinue }
    if (Test-Path $target) { Remove-Item $target -Force -ErrorAction SilentlyContinue }
  }
  Write-Host '지마켓 산스 사용자 설치를 제거했습니다. (프리미어 재시작 후 반영)'
  return
}

New-Item -ItemType Directory -Force $fontDir | Out-Null
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }

$installed = 0
foreach ($s in $sources) {
  $target = Join-Path $fontDir $s.Name
  if (Test-Path $target) {
    Write-Host "이미 있음: $($s.Name)"
    continue
  }
  Write-Host "받는 중: $($s.Name)"
  Invoke-WebRequest -Uri $s.Url -OutFile $target -UseBasicParsing

  # 등록 이름은 **글꼴 이름 + (TrueType)** 이 관례다. 파일이 아니라 이 이름으로 앱이 찾는다.
  $face = if ($s.Name -match 'Bold') { 'Gmarket Sans TTF Bold (TrueType)' } else { 'Gmarket Sans TTF Medium (TrueType)' }
  New-ItemProperty -Path $regPath -Name $face -Value $target -PropertyType String -Force | Out-Null
  $installed++
}

if ($installed -gt 0) {
  Write-Host ''
  Write-Host "설치 완료 ($installed 개). ⚠️ **프리미어를 재시작해야** 글꼴 목록에 뜹니다."
} else {
  Write-Host '할 일 없음 — 이미 설치돼 있습니다.'
}

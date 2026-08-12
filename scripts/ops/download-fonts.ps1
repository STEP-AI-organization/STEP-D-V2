#Requires -Version 5.1
<#
.SYNOPSIS
    썸네일 엔진용 한글 폰트 다운로드 (assets/thumbnail-fonts/).

.DESCRIPTION
    docs/plans/thumbnail-engine-plan.md §3.2 참고.
    Pretendard · Noto Sans KR · Noto Serif KR (전부 SIL OFL · 상용 OK).
    총 ~61MB · gitignore돼있음 · 워커 fresh checkout 시 한 번만 실행.

.EXAMPLE
    powershell -File scripts\download-fonts.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dir = Join-Path $Root "assets\thumbnail-fonts"
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

$fonts = @(
    # Pretendard (기본 · 모든 장르) — https://github.com/orioncactus/pretendard (SIL OFL)
    @{ Url = "https://github.com/orioncactus/pretendard/raw/main/packages/pretendard/dist/public/static/Pretendard-Bold.otf";      Name = "Pretendard-Bold.otf" }
    @{ Url = "https://github.com/orioncactus/pretendard/raw/main/packages/pretendard/dist/public/static/Pretendard-ExtraBold.otf"; Name = "Pretendard-ExtraBold.otf" }
    @{ Url = "https://github.com/orioncactus/pretendard/raw/main/packages/pretendard/dist/public/static/Pretendard-Black.otf";     Name = "Pretendard-Black.otf" }
    # Noto Sans KR (예능 임팩트) — https://github.com/notofonts/noto-cjk (SIL OFL)
    @{ Url = "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Bold.otf";  Name = "NotoSansKR-Bold.otf" }
    @{ Url = "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Black.otf"; Name = "NotoSansKR-Black.otf" }
    # Noto Serif KR (드라마 감성) — https://github.com/notofonts/noto-cjk (SIL OFL)
    @{ Url = "https://github.com/notofonts/noto-cjk/raw/main/Serif/OTF/Korean/NotoSerifCJKkr-Black.otf"; Name = "NotoSerifKR-Black.otf" }
)

foreach ($f in $fonts) {
    $out = Join-Path $Dir $f.Name
    if (Test-Path $out) {
        Write-Host ("[skip] {0} (이미 있음)" -f $f.Name) -ForegroundColor DarkGray
        continue
    }
    Write-Host ("[get ] {0}" -f $f.Name) -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $f.Url -OutFile $out -UseBasicParsing
        $sizeMB = [math]::Round((Get-Item $out).Length / 1MB, 1)
        Write-Host ("       {0} MB" -f $sizeMB) -ForegroundColor Green
    } catch {
        Write-Host ("[FAIL] {0}: {1}" -f $f.Name, $_.Exception.Message) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("완료. 총 파일: {0}" -f (Get-ChildItem $Dir -File | Measure-Object).Count) -ForegroundColor Green
Get-ChildItem $Dir -File | Format-Table Name, @{L='MB'; E={[math]::Round($_.Length/1MB,1)}} -AutoSize

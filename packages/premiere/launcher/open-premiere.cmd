@echo off
REM ============================================================================
REM  stepd:// 프로토콜 핸들러 — 웹에서 "프리미어에서 편집" 을 누르면 여기로 온다.
REM
REM  이 스크립트가 하는 일은 **프리미어를 띄우는 것 하나뿐**이다.
REM  어느 회차를 열지(맥락)는 여기로 오지 않는다 — UXP 패널에는 OS 가 인자를 넘길 문이
REM  없어서, 맥락은 서버를 지난다(웹이 POST /api/premiere/handoff 로 남기고 패널이 폴링).
REM  그래서 여기서 %1(stepd://... URL)은 읽지 않아도 된다. 로그로만 남긴다.
REM
REM  프리미어가 이미 떠 있으면 Windows 가 기존 창을 앞으로 가져온다(새 인스턴스 X).
REM ============================================================================
setlocal

REM 설치된 프리미어 중 **가장 최신 연도**를 고른다 (dir /o-n = 이름 내림차순).
for /f "delims=" %%d in ('dir /b /o-n "C:\Program Files\Adobe\Adobe Premiere Pro *" 2^>nul') do (
  if exist "C:\Program Files\Adobe\%%d\Adobe Premiere Pro.exe" (
    start "" "C:\Program Files\Adobe\%%d\Adobe Premiere Pro.exe"
    exit /b 0
  )
)

REM 못 찾았을 때 조용히 끝내지 않는다 — 사용자는 "눌렀는데 아무 일도 안 일어남" 을 겪는다.
echo Adobe Premiere Pro 를 찾지 못했습니다.
echo C:\Program Files\Adobe\ 아래에 설치돼 있는지 확인하세요.
pause
exit /b 1

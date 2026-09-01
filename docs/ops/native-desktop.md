# Windows 데스크탑 앱

`native/`는 Electron 기반 STEP-D Windows 셸이다. 설치 앱은 `https://stepd.stepai.kr`을 전용
세션으로 표시하고, 원본 영상과 편집 완료 클립을 브라우저 메모리에 올리지 않은 채 로컬 파일에서
GCS resumable upload 세션으로 직접 전송한다. 일반 브라우저의 기존 업로드 동작은 바뀌지 않는다.

## 범위

- Windows 10/11 우선, Electron 44
- 한 번에 한 파일씩 전송하는 FIFO 큐
- 일시정지·재개·취소·재시도·파일 다시 찾기
- 앱 재시작, 네트워크 단절, GCS 세션 만료 뒤 이어 올리기
- 미완료 전송이 있을 때만 창 닫기를 트레이로 전환하고 Windows 로그인 시 백그라운드 재개
- `stepd://open`으로 설치된 Adobe Premiere Pro 실행

v1은 원본을 로컬에서 렌더링하거나 변환하지 않는다. 업로드 초기화와 완료 등록은 기존
`/media/upload-init`, `/media/finalize`, `/media/clip-finalize` API를 사용하고, 바이트만 GCS로
직접 보낸다.

## 로컬 실행

웹 개발 서버를 함께 쓸 때:

```powershell
$env:STEPD_WEB_URL = "http://localhost:3000"
$env:STEPD_API_BASE = "http://localhost:8787/api"
pnpm dev:native
```

환경변수를 생략하면 개발 빌드도 프로덕션 웹과 Vercel API 프록시를 연다. Electron 개발자 도구는
개발 빌드에서만 허용된다.

## 검증과 설치 파일

```powershell
pnpm --filter @stepd/native typecheck
pnpm --filter @stepd/native test
pnpm build:native
pnpm dist:native
```

설치 파일은 `native/release/`에 생성된다. 현재 배포물은 사내용 unsigned NSIS 설치 파일이므로
Windows SmartScreen 경고가 나올 수 있다. 외부 배포 전에는 Windows 코드 서명 인증서와
자동 업데이트 채널을 별도로 붙여야 한다.

## 저장 위치와 보안

Electron `userData` 아래 `transfer-queue/`에 작업별 JSON을 원자적으로 저장한다. 파일 경로와 업로드
메타데이터는 메인 프로세스에만 있고 렌더러에는 공개 작업 정보만 전달한다. GCS resumable session
URL은 Windows DPAPI(`safeStorage`)로 암호화한다. Google 자격 증명이나 서비스 계정 키는 앱에
포함하지 않는다. 로그인은 전용 Electron 세션의 `stepd_session` HttpOnly 쿠키를 그대로 쓴다.

완료·취소 작업은 최근 50개만 보관한다. 전송 재개 시 파일 크기·수정 시각·앞뒤 샘플 해시를
대조하므로 같은 경로의 파일이 바뀌면 사용자 확인이 필요한 상태로 멈춘다.

## 장애 확인

- `AUTH_REQUIRED`: 앱 창에서 다시 로그인하면 자동 재시도한다.
- `NETWORK`: 연결 복구 또는 절전 해제 뒤 자동 재시도한다.
- `FILE_CHANGED` / `FILE_MISSING`: 상단 전송 센터에서 원본 파일을 다시 선택한다.
- `DUPLICATE_EPISODE`: 같은 회차가 이미 등록되어 있는지 프로그램 화면에서 확인한다.
- 큐 파일을 직접 고치지 말 것. 민감한 GCS 세션 URL은 암호문이지만 로그나 이슈에 첨부하지 않는다.

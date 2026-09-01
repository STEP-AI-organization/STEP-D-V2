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

## ⚠️ 아직 검증 안 된 것 (2026-09-01)

**실기기 대용량 인수 테스트를 한 번도 못 했다.** 코드와 단위·통합 테스트까지만 됐다.

| 미검증 | 왜 못 했나 | 무엇이 위험한가 |
|---|---|---|
| 10GB+ 실파일 재개 (네트워크 차단 · 앱 종료 · Windows 재부팅) | 실제 방송 원본을 아직 못 구했다(2026-09-01 보류) | 재개 로직이 진짜로 committed offset 부터 이어붙이는지 아무도 모른다. 오늘 리뷰에서 나온 결함이 **전부 이 경로에 몰려 있었다** |
| MXF 정규화 (`needsMp4Normalize` → 변환 → `.norm.mp4`) | 시스템에 mxf 오브젝트가 **0개**다(GCS 1,994개 전수 확인 — mp4 234 · jpg 1,260, mxf 없음) | 원본 덮어쓰기 버그를 고친 그 경로인데 실제 MXF 로 돌아본 적이 없다 |

### 2026-09-01 오후 리뷰에서 고친 것 (설치본 18:36 빌드에 포함)

| 고친 것 | 증상이었던 것 |
|---|---|
| 진행률과 **커밋 확인**을 분리(`bytesComplete`) | 마지막 청크를 디스크에서 다 읽은 순간 끊기면 `uploadedBytes == size` 가 저장돼, 재기동이 "다 올라갔다" 고 오판하고 업로드를 건너뛴 채 finalize 만 무한 반복 — 남은 바이트가 **영원히 전송되지 않았다.** 탈출구는 취소 후 전량 재업로드뿐 |
| finalize 중 취소 차단(엔진 + 버튼 숨김) | 서버는 회차를 만들고 분석까지 큐잉했는데 로컬만 canceled — **유령 회차와 크레딧 소진**을 아무도 모른다 |
| 창을 다시 열면 자동 종료 예약 해제(`win.on("show")`) | 트레이로 숨겼다 다시 연 뒤 작업 중인데, 마지막 업로드가 끝나는 순간 앱이 통째로 종료됐다 |
| 409(회차 중복)를 재시도 불가로 분류 | 재시도가 영원히 같은 409 를 받는데, 그 잡이 '미완료' 로 남아 X 종료와 로그인 자동기동 해제를 영구히 막았다 |
| `shutdown()` 이 진행 중인 잡을 기다린 뒤 저장 | 늦게 도착한 저장이 종료 스냅샷을 덮었다(재기동 시 `init()` 이 복구하긴 했다) |

회귀 테스트는 `native/src/transfer-engine.test.ts` — 특히
"uploadedBytes 가 size 여도 GCS 확인이 없으면 다시 올린다" 가 첫 번째 항목을 고정한다.

**구하면 할 것:** 윈도우1에서 10GB 이상 MXF 를 올리는 중에 ① 네트워크 차단 ② 앱 강제 종료
③ Windows 재부팅을 각각 걸고, 매번 **처음부터 다시 올라가지 않는지** 확인한다.
완료 기준은 "원본과 완성본이 Cloud Run 을 거치지 않고 GCS 로 직접 가고, 재개 후 중복 회차·클립
없이 기존 분석/배포 화면에 나타난다" 이다. 브라우저 업로드 회귀도 같이 본다.

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

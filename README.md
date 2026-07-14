# STEP-D (monorepo)

KT ENA 방송 콘텐츠 제작·배포 스튜디오의 **UX 재설계** 버전 + **v2 전용 백엔드**.
실제 영상을 올려 업로드 → 소스 재생 → 추천 → 채택(실제 트림 인코딩) → 편집 → 배포/엑셀까지
로컬에서 그대로 돌려볼 수 있다. (원본 STEPD `C:\Users\STEPAI05\STEPD` 는 별도 저장소로 미수정.)

## 구조 (pnpm 워크스페이스)

```
apps/
  web/      Next.js 16 프론트엔드 (@stepd/web, :3100)
  server/   신규 백엔드 (@stepd/server, :4000) — Hono + node:sqlite + ffmpeg
packages/   (공유 패키지 자리)
docs/       설계·분석 문서
storage/    런타임 데이터 (업로드 영상·썸네일·클립·sqlite) — git 무시
```

## 사전 요구

- **Node ≥ 22** (내장 `node:sqlite` 사용 — 네이티브 빌드 불필요)
- **pnpm**
- **ffmpeg / ffprobe** (실제 영상 프로브·썸네일·트림 인코딩용). 없으면 업로드는 되지만
  메타데이터/썸네일/클립 인코딩은 건너뛴다.

## 실행

```bash
pnpm install
pnpm dev          # web(:3100) + server(:4000) 동시 실행
# 또는 개별:
pnpm dev:web      # 프론트만
pnpm dev:server   # 백엔드만
pnpm build        # 전체 빌드
pnpm typecheck    # 전체 타입체크
```

열기: **http://localhost:3100**  ·  백엔드 상태: http://localhost:4000/health

프론트는 서버가 떠 있으면 자동으로 서버 데이터를 쓰고, 서버가 없으면 목 데이터로 단독 구동한다.

## 실제 영상으로 해보기

1. `pnpm dev` 로 둘 다 실행 → http://localhost:3100 접속.
2. **콘텐츠** 화면 → **영상 업로드** → 프로그램 선택 후 영상 파일(mp4/mov/webm)을 끌어다 놓기.
   - 서버가 ffprobe로 길이/해상도/코덱을 읽고, 썸네일을 뽑고, **새 회차 + 추천**을 생성한다.
3. 생성된 회차의 **소스** 탭에서 업로드한 실제 영상이 재생된다.
4. **추천** 탭에서 [채택] → 서버가 해당 구간을 **ffmpeg로 트림 인코딩**해 실제 클립을 만든다.
   [편집] 을 누르면 에디터에서 그 클립 영상이 재생된다.
5. **배포**(채널별 준비도) · **엑셀 내보내기** 도 그대로 동작한다.

## 설정 / 리셋

- `NEXT_PUBLIC_API_URL` (web): 백엔드 주소. 기본 `http://localhost:4000`.
- `PORT` (server): 기본 `4000`. `STEPD_STORAGE_DIR`: 저장 위치(기본 `./storage`).
- **데이터 초기화:** `storage/stepd.sqlite` 삭제 후 서버 재시작 → 시드로 다시 시작.

## 아직 seam(키 필요)

- **AI 추천:** 현재는 길이 기반 휴리스틱. `GEMINI_API_KEY` 연결 시 실제 분석으로 교체(동일 shape).
- **실제 채널 배포(SMR/YouTube/Meta):** UI·상태는 실동작(로컬 기록), 실제 송출은 OAuth·계정 필요.

자세한 백엔드 설계·매핑: [`docs/backend-notes.md`](docs/backend-notes.md).

## 참조 소스 (읽기 전용, 미수정)

- STEPD: `C:\Users\STEPAI05\STEPD`
- StepD(롱퐁 쇼츠화): `C:\Users\STEPAI05\OneDrive\문서\롱퐁 쇼츠화`

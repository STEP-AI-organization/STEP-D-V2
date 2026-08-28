# 네이버 TV·클립 발행 — 운영 런북

> 2026-08-11 실측. 코드는 `apps/server/src/naver-tv.ts` · `naver-session.ts` ·
> `naver-gate.ts` · `naver-workdir.ts`. 작업 지침은 스킬 `/naver-publish`.

> **머신 호칭** — 윈도우1 = 개발·배포 PC(`desktop-c5bdabc`), **윈도우2 = 네이버 워커 전용 PC**.
> 아래에서 "워커 PC" 는 전부 윈도우2 를 가리킨다.

네이버는 **공개 업로드 API 가 없다.** 파트너 계약(SMR) 경로가 열리기 전까지 Playwright
브라우저 자동화가 유일하다. 그래서 다른 잡과 달리 **클라우드가 아니라 윈도우2 한 대**에서
돈다 — 해외 데이터센터 IP(Cloud Run us-central1)로 로그인하면 캡차·2차인증에 막힌다.
GEBD 를 GPU VM 전용 레인으로 뺀 것과 같은 구조다.

## 1. 윈도우2 세팅 (한 번)

> **그 PC 에서 따라갈 순서는 [deploy/naver-pc/README.md](../../deploy/naver-pc/README.md)
> 하나에 정리돼 있다.** 클론 후 그것만 보면 된다. 아래는 요약.

```bash
npx playwright install chromium                        # ~150MB
pnpm --filter @stepd/server naver:login                # 브라우저가 뜬다 → 사람이 로그인
```

`naver:login` 은 아이디·비밀번호를 **코드가 만지지 않는다.** 사람이 2차인증까지 끝내면
쿠키+localStorage 를 `~/.stepd/naver-storage-state.json` 에 저장한다. 이 파일은
**로그인 쿠키 그 자체다** — 커밋·복사·전송 금지, 클라우드에 올리지 않는다.

로그인 후 네이버 TV·클립 두 사이트를 한 번씩 방문해 양쪽 도메인 쿠키를 함께 담는다.

### 로그인 방법이 두 가지다 — 어느 쪽인지 먼저 정할 것

| | 저장 위치 | 언제 쓰나 |
|---|---|---|
| `naver:login` | **그 PC 로컬 파일** | 워커가 한 대뿐이고 그 앞에 앉을 수 있을 때 |
| `naver:login:upload` | **서버(암호화)** | 운영자가 웹에서 계정을 관리할 때 · 워커가 여러 대일 때 |

```bash
# 서버에 등록 — 브라우저 창 하나에서 STEP D 한 번, 네이버 한 번 로그인한다
pnpm --filter @stepd/server naver:login:upload -- \
  --account <nva_xxx> --api https://<서버> --web https://stepd.stepai.kr
```

⚠️ **`--api` 에 오리진만 주면 안 된다.** 프로덕션 웹은 서버를 `/api/proxy` 로 경유하므로
`https://stepd.stepai.kr/api/proxy` 처럼 프록시 경로까지 줘야 한다. 배포채널 화면의
계정 카드가 **이 명령을 주소까지 채워서** 보여주니 그대로 복사하는 게 안전하다.

⚠️ STEP D 로그인이 왜 필요한가: 프로덕션은 `AUTH_REQUIRED=1` 이라 인증 없는 세션 등록은
401 이다. 예전 버전은 그걸 안 보내서 **로컬 서버에만 등록되고 프로덕션에서는 조용히
실패**했다. 이제 브라우저에서 받은 세션 쿠키를 그대로 쓴다.

⚠️ 올라가는 건 **네이버 도메인 쿠키만**이다. `storageState` 를 통째로 올리면 방금 받은
STEP D 세션 쿠키까지 네이버 세션 blob 안에 묻힌다 — 그 blob 을 푸는 사람이 우리 계정도
갖게 된다.

## 2. 설치 — 한 번만 (그 뒤로는 자동)

```powershell
.\deploy
aver-pc\install.ps1
```

작업 스케줄러에 `STEPD-CloudSQL-Proxy` · `STEPD-Naver-Worker` 와 **10분마다 origin/main 을
당겨 재시작**하는 자가 갱신을 건다(pm2 를 쓰지 않는 이유는 `deploy/naver-pc/README.md`). 이후 **배포는 `main` 에 push 하는 것으로 끝난다** — 이 PC 는 알아서 따라온다.

왜 SSH 로 밀지 않는가: 사무실 PC 는 NAT 뒤라 포트포워딩·고정IP·키 관리가 전부 유지보수
부담이 된다. **당겨오는 쪽이 설정할 게 없다.** 변경이 없으면 재시작도 하지 않으므로
발행 중인 잡이 끊기지 않는다.

```
Get-ScheduledTask STEPD-*          # 프록시·워커 둘 다 Running
Get-Process node                   # 워커 프로세스
~/.stepd/self-update.log           # 갱신 로그
```

> ⚠️ **코드가 최신이어도 프로세스가 옛날이면 소용없다.** 2026-08-11 에 5일간 구버전으로
> 돌던 워커가 잡을 가로채 계속 실패시켰다 — self-update 가 재시작까지 하는 이유다.

### 즉시 반영 (Tailscale)

폴링은 최대 10분 지연된다. 배포 직후 바로 반영하려면 테일넷으로 찔러준다:

```powershell
.\deploy
aver-pc\push-update.ps1 -TailscaleHost <워커PC이름>
```

Tailscale 이라 NAT·포트포워딩·고정IP 가 필요 없다. **워커 PC 1회 준비:**

```powershell
# 1) Tailscale 설치 후 테일넷 로그인
# 2) OpenSSH Server 켜기 (Windows 기능)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd

# 3) 배포 머신의 공개키를 등록
#    ⚠️ 관리자 계정은 ~/.ssh/authorized_keys 가 아니라 아래 파일을 쓴다(Windows 특유)
#    C:\ProgramData\sshdministrators_authorized_keys
```

> ⚠️ **폴링을 없애지 말 것.** push 는 빠른 경로일 뿐 **보장 경로가 아니다** — PC 가 꺼져
> 있거나 SSH 가 막히면 실패한다. 그때는 스케줄러가 나중에 따라잡는다. 둘 다 있어야 한다.

## 2-b. 수동 실행 (디버깅용)

```bash
NAVER_UPLOAD_ENABLED=1 pnpm --filter @stepd/server worker:naver
```

`worker:naver` 는 **레인을 코드에 못 박은 전용 런처**다(`scripts/worker-naver.mts`).
`WORKER_JOBS` 를 env 로 잘못 넣어도 뒤집히지 않는다 — 이 PC 가 실수로 "all" 워커가 되어
남의 레인 잡을 집어 실패시키는 사고를 원천 차단한다.

| 환경변수 | |
|---|---|
| ~~`WORKER_JOBS`~~ | **불필요.** `worker:naver` 가 naver 로 고정한다 |
| `NAVER_UPLOAD_ENABLED` | 실업로드 게이트. 기본 OFF — 명시적 truthy 일 때만 ON |
| `DATABASE_URL` | Cloud SQL 을 봐야 같은 `job_queue` 를 집는다 |
| `NAVER_WORK_DIR` | 작업 폴더 (기본 `~/.stepd/naver-work`) |
| `NAVER_SESSION_PATH` | 세션 파일 (기본 `~/.stepd/naver-storage-state.json`) |

게이트는 **워커 진입 시 + 업로드 직전** 2중으로 본다. 잘못된 env 의 실패 모드가
"업로드 안 됨"이어야지 "실수로 업로드됨"이면 안 된다.

## 3. 잡 페이로드

```jsonc
{
  "clipId": "clip_…",
  "target": "clip",              // "clip"(네이버 클립) | "tv"(네이버 TV)
  "description": "10자 이상",     // 클립 필수 — 사람이 배포 시점에 입력한 값이 최우선
  "tags": ["게임"],               // 선택. 클립은 고정 버튼 목록과 겹치는 것만 적용
  "category": { "primary": "엔터", "secondary": "엔터" },  // 생략 시 기본값
  "publishAt": 1786430000000     // 선택. 등록 예약(로컬시각 기준)
}
```

- **알 수 없는 `target` 은 버린다.** tv 로 폴백하지 않는다 — "클립에 올린 줄 알았는데
  TV 에 올라간" 실패가 제일 나쁘다.
- 과거 `publishAt` 은 워커가 버린다(무시하면 즉시 등록된다).

## 4. 작업 폴더

Playwright 는 **로컬 파일 경로**만 받으므로 스토리지에서 한 번 내려받는다.

```
<NAVER_WORK_DIR>/<워크스페이스>/<프로그램>/<회차>/<clipId>.mp4
```

업로드가 끝나면 **영상 파일은 지운다**(성공·실패 무관 — 원본이 GCS 에 있고 클립 하나가
수백 MB다). **폴더는 남긴다** — 뭘 돌렸는지 눈으로 보이는 편이 운영에 낫다.
잡이 중간에 죽어 남은 파일은 워커 기동 시 3일 경과분을 훑어 정리한다.

## 5. 실측 수치

| | 클립 | TV |
|---|---|---|
| 1건 소요 | 약 40초 | 약 26초 |
| 제목 | **없음** (설명 300자 하나) | 있음 (120자) |
| 설명 | 필수 · **최소 10자** | 3,000자 |
| 카테고리 | 1차+2차 필수 | 1차+2차 필수 |
| 예약 | 등록 예약 (분은 5분 눈금) | 공개 예약 |
| 발행 후 | `/web/draft/<id>` | 목록에 등록, 인코딩 안내 모달 |

커버·AI 활용·재생국가·댓글 허용은 **건드리지 않아도 기본값으로 등록된다.**

### 카테고리 — 어떻게 정해지나

1차 40개 · 2차 144개이고 **둘 다 골라야** 등록 버튼이 활성화된다. 값이 정해지는 순서:

```
발행 페이로드(배포 모달에서 사람이 고른 값)
  → 프로그램 기본값 (프로그램 설정 화면 · program.naverCategory)
    → 장르 유도 (pipelineGenre: drama → 엔터/드라마 · variety → 엔터/예능)
      → 엔터/엔터
```

**영상 내용으로 자동 판정하지 않는다.** 장르 유도도 추측이 아니라 사람이 프로그램에
지정해 둔 장르를 옮기는 것뿐이다 — 틀린 분류는 발행된 뒤에야 알게 되고, 되돌리려면
네이버에서 손으로 고쳐야 한다.

> ⚠️ **예전엔 목록에 없는 값이 오면 브라우저가 첫 항목을 대신 골랐다.** 엉뚱한 분류로
> 발행되는데 화면은 "발행 완료" 라고 말했다. 지금은 세 곳에서 막는다 —
> 화면(드롭다운이라 애초에 못 넣음) · 저장(프로그램 PATCH 400) · 발행 직전(워커가 영상을
> 내려받기 **전에** 분류표와 대조). 화면에서도 못 찾으면 스크린샷과 함께 실패로 남는다.

## 6. 실패 처리

**자동 재시도를 하지 않는다.** 브라우저 자동화 실패는 대개 DOM 개편이나 세션 만료라
재시도해도 같은 결과고, 계정 잠금 위험만 키운다. 실패하면
`~/.stepd/naver-artifacts/` 에 **스크린샷을 남기고** 잡을 failed 로 둔다 —
사람이 그림을 보는 게 로그를 읽는 것보다 빠르다.

| 증상 | 원인·조치 |
|---|---|
| `네이버 세션이 만료됐습니다` | `naver:login` 재실행 (2차인증 포함) |
| `설명이 10자 미만입니다` | 배포 시 설명 입력 필요 |
| `저장 완료를 확인하지 못했습니다` | 스크린샷 확인. DOM 개편이면 셀렉터 수정 |
| **잡이 안 잡힘** (전용 워커는 큐가 비어 보임) | **다른 워커 프로세스 확인.** 구버전 코드로 도는 `all` 워커가 가로챈다 |

## 6-b. 다계정 (B2B)

고객사가 여럿이면 네이버 계정도 여럿이다. **한 PC 에서 계정별 세션을 나눠 든다.**

```
~/.stepd/naver/<accountKey>/storage-state.json     # 계정마다 따로
pnpm --filter @stepd/server naver:login --account <accountKey>
```

`naver_account` 테이블은 **자격증명을 담지 않는다** — "누구 것이고, 어느 세션 키를 쓰고,
살아있나" 만 안다. `accountKey` 는 불투명 키다(네이버 아이디를 경로·로그·DB 에 안 박는다).

잡 페이로드에 `naverAccountId` 를 넣으면 그 계정으로 올린다. 워커는 올리기 전에
**잡의 테넌트와 계정의 테넌트가 같은지 대조**한다 — 다르면 거부한다.
RLS 가 이미 막지만 워커에는 시스템 스코프로 도는 구간이 있어 한 번 더 본다.
**B2B 에서 제일 위험한 사고가 "A사 클립이 B사 채널에 올라가는 것"이다.**

> ⚠️ **한 IP 에서 여러 네이버 계정을 자동으로 돌리는 건 어뷰징 신호다.** 계정 정지
> 위험이 계정 수에 비례하는 게 아니라 급격히 커진다. 계정 전환 사이에 충분한 간격을
> 두고, 물량이 커지면 **SMR 파트너 계약**이 정공법이다.

## 7. 알려진 한계

- **약관 리스크.** 본인 계정·본인 콘텐츠라도 자동화 도구는 네이버 약관상 제한될 수 있고
  계정 정지 가능성이 실재한다. 기술 판단이 아니라 사업 판단이다 — 게이트가 기본 OFF 인
  이유이기도 하다.
- **페이싱 미구현.** 짧은 시간에 반복 업로드하면 불안정해진다(스로틀 추정). 한도를 아직
  측정하지 않았다 — 병렬화보다 간격 두기가 맞다.
- **분류표는 스냅샷이다** (2026-08-28 캡처 · `src/data/naver-clip-categories.json`).
  네이버가 분류를 바꾸면 낡는다 — `pnpm --filter @stepd/server naver:categories` 로 다시 뜬다.
- 대량 물량은 브라우저 자동화의 영역이 아니다. 방송사 물량이면 **SMR 파트너 계약**이
  정공법이다.

## 관련

- 스킬 `/naver-publish` — 셀렉터 함정·프로브 도구 (개발 시)
- `docs/ops/infra.md` — 인프라 SSOT

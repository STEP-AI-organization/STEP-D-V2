# STEP-D

**긴 영상을 넣으면 쇼츠가 채널에 올라간다.** 그 사이의 모든 단계 — 받아쓰기, 장면 나누기,
쓸 만한 구간 고르기, 자르기, 자막·제목 입히기, 채널별 규격 맞추기, 예약 발행, 성과 집계 —
를 자동화한 운영자용 스튜디오다.

쓰는 사람은 방송사·MCN 의 **운영자**다. 편집자가 아니라 "이번 주에 뭘 내보낼지" 를 정하는
사람이고, 그래서 제품의 목표는 **영상을 대신 만들어 주는 것이 아니라 사람 손을 줄이는 것**이다.
어디까지 자동이고 어디부터 사람 몫인지는 아래 §자동/수동 경계에 적었다.

```
긴 영상 ─▶ AI 파이프라인 ─▶ 추천 구간 ─▶ [사람이 채택] ─▶ 클립 ─▶ 편집 ─▶ 다중 채널 배포 ─▶ 성과
                                            ▲
                            자동배포 계획을 켜면 이 손이 빠진다
```

**지금 규모** (2026-09-14 실측): 운영자 화면 28개 + 공개 7개 · 서버 라우트 282개 ·
잡 28종을 워커 레인 7개가 나눠 처리 · 테스트 107(서버) + 11(파이썬) 파일.

---

## 처음 클론했다면 — 이 순서대로

```bash
git clone https://github.com/STEP-AI-organization/STEP-D-V2.git
cd STEP-D-V2

pnpm install                                   # 1. Node 의존성
cp apps/server/.env.example apps/server/.env   # 2. 값 채우기 (최소: DATABASE_URL)
cp apps/web/.env.example    apps/web/.env

pnpm setup:check                               # 3. ⭐ 내 머신에 뭐가 없는지 확인
```

**`pnpm setup:check` 가 뭐가 빠졌는지와 채우는 방법까지 알려준다.** 준비물을 README 로만
두면 빠뜨린 채 개발을 시작해서 한참 뒤 엉뚱한 에러로 나타난다(ffmpeg 이 없어 썸네일이 빈
파일이 되는 식). 통과하면:

```bash
pnpm dev            # 웹 + 서버   (Windows 는 .\dev.ps1 — Postgres 컨테이너까지 같이)
```

### 값을 어디서 얻나

로컬 Postgres 를 쓸 거면 그대로 넣으면 된다:
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stepd`

GCP·YouTube·포트원 같은 **실제 키는 팀에게 받는다** — 리포에 없다.
`.env` 는 절대 커밋하지 않는다(§규칙).

**전부 필요하지는 않다.** 하려는 것에 따라 최소만 채우면 된다:

| 하려는 것 | 최소 |
|---|---|
| 웹·서버 띄우기 | `DATABASE_URL` |
| AI 파이프라인 | + GCP ADC(`gcloud auth application-default login`) · `SONIOX_API_KEY` |
| 유튜브 연동 | + `GOOGLE_CLIENT_ID`/`SECRET` · `PUBLIC_URL` |
| 결제 화면 | + `PORTONE_*` · `CREDIT_PRICE_KRW` |

### 사전 요구

| | 무엇에 쓰나 | 없으면 |
|---|---|---|
| **Node ≥ 22** · **pnpm 10** | 전부 | 아무것도 안 된다 |
| **Docker Desktop** | 로컬 Postgres | 원격 DB 를 쓰면 생략 가능 |
| **ffmpeg / ffprobe** | 영상 프로브·썸네일·트림 인코딩 | 클립이 안 만들어진다 |
| Python 3.11+ | `core/` AI 파이프라인 | **웹·서버는 그대로 뜬다** |
| gcloud SDK | GCP 인증·배포 | 로컬 개발만 하면 생략 가능 |

pnpm 은 `packageManager` 에 **버전이 고정**돼 있다(`pnpm@10.33.2`). corepack 을 쓰면 알아서
맞춰 준다 — 임의 버전으로 깔면 lockfile 검증에서 갈린다.

AI 파이프라인까지 돌리려면 파이썬 환경이 따로 필요하다:

```bash
python -m venv core/.venv310
core/.venv310/Scripts/pip install -r core/requirements.lock.txt   # macOS/Linux: bin/pip
core/.venv310/Scripts/pip install -r core/requirements-dev.txt    # 테스트용
```

> ⚠️ 설치는 **`requirements.lock.txt`** 로 한다. `requirements.txt` 는 사람이 읽는 직접
> 선언분이고, 같은 커밋이 같은 것을 깔게 만드는 건 lock 쪽이다.

---

## 기술 스택

| 층 | 무엇 | 왜 |
|---|---|---|
| **웹** | Next.js 16 (App Router) · React 19 · TypeScript 5.7 · **Tailwind v4** · base-ui · lucide · recharts | 운영자 화면. 서버 컴포넌트는 거의 안 쓴다 — 대부분 실시간 상태를 다루는 클라이언트 화면이다 |
| **서버** | **Hono** · PostgreSQL(`pg`) · ffmpeg | 라우트 282개가 `index.ts` **한 파일**에 있다(§규칙) |
| **워커** | 같은 코드, 다른 프로세스(`worker.ts`) | Postgres 잡 큐 · `FOR UPDATE SKIP LOCKED` |
| **AI** | **Python** · Vertex Gemini(`google-genai`) · Soniox STT · scenedetect · mediapipe · Pillow · rembg | 무거운 건 전부 여기. 서버가 자식 프로세스로 띄운다 |
| **인프라** | Cloud Run(서비스) · Cloud Run Jobs(워커) · Cloud SQL · GCS · Vercel(웹) | 아래 §어디서 도나 |
| **결제** | 포트원 + KG이니시스 (선불 크레딧) | 크레딧 1개 = 분석 1분 |

**데이터베이스는 PostgreSQL 하나다.** 엔티티 대부분이 JSONB(`entities`) 한 테이블에 살고,
미디어·YouTube·검색 세그먼트만 정규 테이블이다. 검색은 **pgvector**(768차원) + pg_trgm
하이브리드 — 벡터가 실패해도 키워드축만으로 검색이 성립한다(한국어는 키워드 매칭이 강하다).

---

## 폴더 — 뭐가 뭔지

**리포에 있는 건 8개뿐이다.** 나머지(`node_modules` · `storage` · `logs` · `tmp` ·
`local-scratch` · `eval` · `gcp-keys`)는 전부 로컬 전용이고 git 에 없다.

| 폴더 | 무엇 | 언어 | 어디서 도나 |
|---|---|---|---|
| **[`apps/web`](apps/web/)** | 운영자가 보는 화면 | TypeScript (Next.js) | Vercel · stepd.stepai.kr |
| **[`apps/server`](apps/server/)** | HTTP 서버 + 잡 워커 | TypeScript (Hono) | Cloud Run · Cloud Run Jobs |
| **[`core/`](core/)** | **AI 파이프라인** — STT·장면경계·beat·추천·검색색인·썸네일 | **Python** | 워커가 `python -m core.analyze` 로 스폰 |
| **[`admin/`](admin/)** | 플랫폼 관리 콘솔 (STEPAI 운영자 전용) | TypeScript (Vite SPA) | Vercel · admin.stepd.stepai.kr |
| **[`native/`](native/)** | Windows 데스크탑 셸 — 대용량 업로드 큐·트레이 | TypeScript (Electron) | 편집자 PC |
| **[`deploy/`](deploy/README.md)** | 배포·프로비저닝 (**머신별 폴더**) | Bash / PowerShell | 사람이 실행 |
| **[`scripts/`](scripts/README.md)** | 개발·운영·실험 도구 (**제품 코드 아님**) | 잡다 | 사람이 실행 |
| **[`docs/`](docs/README.md)** | 문서 | — | — |

`assets/` 는 코드가 읽는 정적 자산(쇼츠 프레임 템플릿·글꼴·썸네일 스타일)이다.

### 헷갈리기 쉬운 세 가지

**① 서버는 Node, 파이프라인은 Python.** 둘 다 쓴다.
`apps/server` 는 HTTP 라우트와 큐만 담당하고, **무거운 AI 작업은 전부 `core/` 파이썬**이
한다. 접점은 `content-pipeline.ts` 하나뿐이다.

```
브라우저 → apps/web → apps/server (라우트·큐)
                          └─ 워커가 spawn → core/ (python) → 결과를 DB·GCS 로
```

**② 워커는 서버와 같은 코드, 다른 프로세스다.**
`apps/server/src/worker.ts` 가 진입점이고 **레인 7개**로 갈라 돈다. 레인을 가르는 이유는
서로 굶기지 않기 위해서이기도 하지만, **레인마다 돌 수 있는 기계가 다르기** 때문이다:

| 레인 | 어디서 | 왜 거기여야 하나 |
|---|---|---|
| `content` · `youtube` | Cloud Run Jobs | 파이썬·ffmpeg 무거운 잡 · API 쿼터 잡 |
| `gebd` | GPU L4 spot VM | mmaction2 가 GPU 를 요구한다 |
| `naver` · `download` · `commerce` · `render` | 사무실 PC(윈도우2) | **한국 IP·화면 있는 크롬**이 필요하다 |

네이버는 공개 업로드 API 가 없어 Playwright 자동화인데 해외 IP 로 로그인하면 캡차에 막히고,
유튜브 다운로드도 데이터센터 IP 를 봇으로 판정한다. 전부 **그 PC 여야만 하는 이유**가 있다.

⚠️ **CPU 가 공짜라고 아무 잡이나 사무실 PC 로 보내면 안 된다.** GCS 에서 원본을 받아오는
잡은 인터넷 egress(≈₩165/GB)가 새로 생긴다 — 같은 리전 Cloud Run 은 0원이다.
**바이트를 옮기는 잡은 클라우드, CPU 만 쓰는 잡은 PC.**

**③ 드레인 모드가 비용 구조의 핵심이다.** 워커는 상시 폴링하지 않는다. Cloud Scheduler 가
Job 을 깨우고 → **큐가 비면 종료** → idle 과금 0.

---

## 자동/수동 경계

"전부 자동화" 가 아니라 **"사람 부담 최소화"** 가 목표다. 기능마다 몫이 갈린다.

| 사람 몫 | 자동 |
|---|---|
| 장르·출연진 **사전 등록** (정확도가 여기서 갈린다) | 받아쓰기·장면 분할·구간 추천·점수 |
| 추천 구간 **채택/거절** | 트림·인코딩·자막·제목·썸네일 |
| 발행 전 **검토** (자동배포를 안 켰다면) | 채널 규격 맞추기·예약 발행·성과 집계 |
| 커머스 링크 **승인** (발급 ≠ 게시) | 상품 후보 추출·링크 발급 |

**자동배포 계획**을 켜면 채택·검토까지 자동으로 넘어간다 — 그때는 사람이 "계획을 만드는
것" 까지만 한다. 계획이 없으면 파이프라인은 **아무것도 하지 않는다.** 기본 동작이 없는 건
편의를 뺀 게 아니라 안전장치다.

> ⚠️ **점수·순위·선별은 LLM 에 맡기지 않는다.** 실행마다 결과가 바뀌면 측정이 불가능해진다.
> LLM 은 서술·추출·생성만 하고 순위는 결정론 코드가 낸다.

---

## 개발

```bash
pnpm dev          # 웹 + 서버
pnpm check        # ⭐ 커밋 전 이거 하나 (CI 가 같은 걸 돌린다)
pnpm test:e2e     # 진짜 Postgres + 진짜 서버 (DB 필요 · check 와 별도)
```

`pnpm check` = 전 패키지 타입체크 + 서버·네이티브 테스트 + **core 파이썬 테스트**.
파이썬이 없으면 core 는 **조용히 건너뛴다**(웹·서버만 하는 사람을 막지 않으려고) — 단
CI 는 건너뛰지 못하게 강제한다.

**`main` 은 보호돼 있다.** 직접 푸시는 거부되고 PR + CI 초록이어야 머지된다.
협업 규칙·커밋 메시지·리뷰는 [CONTRIBUTING.md](CONTRIBUTING.md).

### 이 리포의 테스트는 좀 특이하다

상당수가 **소스를 읽어 불변식을 고정하는** 형태다 — "큐에 넣는 곳은 한 군데",
"모든 잡 타입은 도는 레인에 있다", "문서 숫자가 코드와 같다", "허용 글꼴이 그 언어를
실제로 덮는다(폰트 cmap 을 읽어 확인)".

순수 함수로 증명할 수 없는 것들이라 이렇게 한다. **깨지면 기대값을 지우지 말고 원인을
고칠 것** — 숫자를 현실에 맞추면 그 불변식이 조용히 사라진다.

---

## 규칙 (자주 걸리는 것)

- **`.env*` · `gcp-keys/` 절대 커밋 금지.** 2026-07-14 개인키 유출 사고가 있었고, 이 리포는
  현재 public 이다. 커밋 전 `git status` 확인.
- **서버 라우트는 `apps/server/src/index.ts` 한 파일에 유지.** 분리하지 말 것.
- **새 잡 타입은 반드시 레인에 넣는다.** 안 넣으면 아무도 안 집는다(테스트가 강제).
- **env 는 시크릿과 인프라 위치에만.** 켜고 끄는 스위치는 DB·화면·요청 파라미터로 간다.
- **배포는 요청받았을 때만.** 머지 ≠ 배포다(웹만 예외 — 아래).

---

## 배포

**서버·워커는 자동으로 안 나간다.** 사람이 스크립트를 실행한다.

```bash
bash deploy/cloud.sh status    # 먼저 지금 상태를 본다
bash deploy/cloud.sh all       # server + worker + migrate
```

**웹만 다르다 — `apps/web` 을 건드린 커밋이 `main` 에 들어가면 그 즉시 프로덕션에 나간다**
(머지 = 배포). 그래서 머지 버튼이 곧 배포 버튼이다.

⚠️ Vercel 은 **커밋 이메일이 아니라 GitHub 계정 연결**을 본다. 팀 시트가 유료라 인원을
안 늘리는 대신 **팀 시트를 가진 사람이 머지**한다 — 아니면 그 시점부터 웹 배포가 조용히
멈춘다. 자세히는 [docs/ops/onboarding-access.md](docs/ops/onboarding-access.md).

---

## 원가 — 인용하기 전에

60분 회차 ≈ **₩800**(분당 ₩13.3) · 판매가 ₩60/분 → 마진 ~78%.

⚠️ **이 리포는 원가를 네 번 틀렸고 뿌리가 매번 같았다** — 안 돈 스테이지를 0 으로 셌거나,
프로덕션이 그걸 켰다고 짐작했다. 숫자를 인용하기 전에 정본을 볼 것:

- 정본 문서 [docs/ops/how-it-works.md](docs/ops/how-it-works.md) §4
- 실측값 `GET /api/superadmin/usage` → `totals.costPer60minKrw`
  (2026-09-03 부터 회차마다 `usage.json` 에 토큰·받아쓰기 시간을 **실측**해 원장에 넣는다)

---

## 시작하기

| | |
|---|---|
| **리포 전체 컨텍스트** | [CLAUDE.md](CLAUDE.md) — 구조·함정·작업 규칙 (**여기부터**) |
| **협업 규칙** | [CONTRIBUTING.md](CONTRIBUTING.md) — 브랜치·PR·검증·커밋 메시지 |
| **합류자 권한** | [docs/ops/onboarding-access.md](docs/ops/onboarding-access.md) — 없으면 무슨 증상인지까지 |
| **문서 전체 지도** | [docs/README.md](docs/README.md) — 현황(ops) / 계획(plans) / 레퍼런스 |
| **파이프라인이 실제로 하는 일** | [docs/ops/how-it-works.md](docs/ops/how-it-works.md) |
| **로컬 개발** | [docs/ops/local-dev.md](docs/ops/local-dev.md) |
| **배포 런북 · 인프라** | [docs/ops/deploy.md](docs/ops/deploy.md) · [docs/ops/infra.md](docs/ops/infra.md) |

> 구 STEPD(Python FastAPI `apps/api/` · `apps/docs/`)는 **2026-08-12 전부 삭제됐다.**
> 참고할 일이 있으면 git 이력에서 꺼낸다.

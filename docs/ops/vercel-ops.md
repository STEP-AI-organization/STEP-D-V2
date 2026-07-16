# Vercel 운영 메모 (STEP-D V2)

이 저장소(`STEP-AI-organization/STEP-D-V2`)의 웹앱을 Vercel에서 다루는 법.
2026-07-16 기준. 삽질했던 함정들을 같이 적어둔다.
(리포는 원래 `STEP-AI-official`이었으나 `STEP-AI-organization`으로 이전됨 — `git remote -v`로 확인 가능.)

---

## 1. 프로젝트 좌표

| 항목 | 값 |
|------|-----|
| 팀 (scope) | `step-ai` — 표시명 "STEP AI" |
| 프로젝트 | `step-d-v2-web` |
| 프로덕션 도메인 | **https://stepd.stepai.kr** (DNS: `stepd.stepai.kr` A `76.76.21.21` → Vercel) |
| .vercel.app URL | https://step-d-v2-web-step-ai.vercel.app — **기본 별칭일 뿐**, 운영 진입점 아님 |
| GitHub 리포 | `STEP-AI-organization/STEP-D-V2` (Vercel Git 연동) |
| Root Directory | `apps/web` |
| 빌드 명령 | `next build --webpack` (`apps/web/vercel.json`) — 이유는 아래 §1.2 |
| 배포 트리거 | GitHub `main` 푸시 → 자동 배포. **표준 경로는 `deploy/deploy-web.ps1`** (§1.1) |

> **주의:** 팀 슬러그는 `step-ai`다. CLI가 가끔 `step-ais-projects`라는 엉뚱한 스코프로
> 붙으려다 `Not authorized`를 뱉는데, 그건 옛 로그인 설정(`config.json`)의 잔재다.
> **항상 `--scope step-ai`를 명시하면 피할 수 있다.**

### 1.1 표준 배포 경로 — `deploy/deploy-web.ps1`

맨손 `git push`도 배포는 되지만, 표준은 래퍼 스크립트다. 순서:

1. **배포 author 강제** — `git config user.email contact@stepai.kr` + 미푸시 커밋 중
   author가 다르면 rebase로 재작성 (아래 §5 git-author 함정 참고)
2. **로컬 `next build` 검증** — Vercel과 동일 명령으로 타입·프리렌더까지 확인 후에만 푸시
3. **push** → Vercel 자동 빌드
4. **Vercel 빌드 감시** — `vercel ls`를 폴링해 Ready/Error 판정 (토큰 파일
   `gcp-keys/vercel-token.txt` 없으면 이 단계는 스킵)
5. **스모크 확인** — `https://stepd.stepai.kr`의 `/`, `/channels`, `/register`가 200인지

옵션: `-SkipChecks`(로컬 빌드 생략), `-SkipVerify`(스모크 생략).

### 1.2 왜 `next build --webpack`인가

Next 16은 `next build` 기본이 Turbopack인데, Turbopack 출력이 Vercel에서
`/_next/static/immutable/*` 자산 404를 유발했다. 그래서 `apps/web/vercel.json`의
`buildCommand: "next build --webpack"`으로 표준 `/_next/static/chunks/` 출력을 고정했다.
**vercel.json을 지우거나 buildCommand를 빼면 재발한다.**

---

## 2. 토큰

토큰 값은 **이 문서에 적지 않는다** (문서는 커밋됨). 파일로 둔다:

```
gcp-keys/vercel-token.txt      ← 여기. gcp-keys/ 는 .gitignore 처리됨
```

**토큰 발급 시 스코프를 반드시 팀으로:**
Vercel → Account Settings → Tokens → Create
→ **Scope 드롭다운에서 "STEP AI" 팀 선택** (개인 계정으로 만들면 팀 프로젝트에 접근 못 해서
`You do not have access to the specified account` 로 막힌다. 실제로 한 번 겪었다.)

쓸 때는:

```bash
T=$(cat gcp-keys/vercel-token.txt)
vercel <명령> --token="$T" --scope step-ai
```

---

## 3. 환경변수 계약 (코드 기준)

코드가 실제로 읽는 건 **딱 3개**다. 그 외에 뭘 넣어도 아무 효과 없다.

| 변수 | 읽는 곳 | 값 | 비고 |
|------|---------|-----|------|
| `CLOUD_RUN_URL` | `src/app/api/proxy/[[...path]]/route.ts`, `src/lib/gcp-auth.ts` | `https://stepd-server-...run.app` | 서버 전용 |
| `GCP_SERVICE_ACCOUNT_KEY` | `src/lib/gcp-auth.ts` | 서비스 계정 JSON 전체 | 서버 전용 · 시크릿 |
| `NEXT_PUBLIC_API_URL` | `src/lib/data/api.ts` | **설정하지 말 것** | 아래 참고 |

### `NEXT_PUBLIC_API_URL`은 비워둬야 한다 ⚠️

```ts
// src/lib/data/api.ts
export const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "/api";
```

이게 **설정돼 있으면** 브라우저가 그 주소로 Cloud Run을 직접 호출한다. 그런데 Cloud Run은
IAM 보호라 ID 토큰이 필요하고, 브라우저는 그걸 못 만든다 → **403**.

비워두면 `/api`로 폴백 → `next.config.ts`의 rewrite → `/api/proxy/*` 라우트 →
Next 서버가 `GCP_SERVICE_ACCOUNT_KEY`로 ID 토큰을 발급해 붙임 → Cloud Run 도달. 이게 정상 경로다.

> **Cloud Run이 정말 비공개인지 (2026-07-16 실측):** 맞다. 직접 URL
> `https://stepd-server-...run.app/health` 익명 접근은 403이고, invoker IAM은
> `domain:stepai.kr` + 배포 SA뿐(`allUsers` 없음). 단, 루트 `cloudbuild.yaml`과
> `apps/server/cloudbuild.yaml`에는 `--allow-unauthenticated` 플래그가 남아 있는데
> IAM에 반영되지 않고 있다(배포 SA 권한 부족으로 경고 후 무시되는 것으로 추정).
> **권한이 생기는 순간 공개로 뒤집힐 수 있으니 플래그 제거 권장.** 상세는 [infra.md](infra.md).

### 죽은 변수들 (2026-07-14 삭제함)

`API_PROXY_TARGET`, `NEXT_PUBLIC_API_PROXY`, `NEXT_PUBLIC_API_BASE_URL` — 구 STEPD 잔재로
코드가 전혀 읽지 않는다. 다시 넣지 말 것. (`NEXT_PUBLIC_API_BASE_URL`은 `apps/web/CLAUDE.md`에도 명시)

### Preview 환경은 현재 깨져 있다

`CLOUD_RUN_URL`·`GCP_SERVICE_ACCOUNT_KEY`가 **Production에만** 설정돼 있다.
PR/브랜치 프리뷰 배포는 `GCP_SERVICE_ACCOUNT_KEY not set` 으로 죽는다.
프리뷰를 쓰려면 두 변수를 Preview에도 추가해야 한다 — 다만 서비스 계정 키가 프리뷰 배포까지
퍼지는 걸 감수해야 한다.

---

## 4. 자주 쓰는 명령

```bash
T=$(cat gcp-keys/vercel-token.txt)
V="vercel --token=$T --scope step-ai"

# 프로젝트 연결 (최초 1회, .vercel/ 생성 — gitignore됨)
vercel link --token="$T" --scope step-ai --project step-d-v2-web --yes

# 환경변수
$V env ls
$V env add  CLOUD_RUN_URL production            # 값은 프롬프트로 입력
$V env add  GCP_SERVICE_ACCOUNT_KEY production < gcp-keys/vercel-proxy-key.json
$V env rm   어떤변수 production --yes

# 배포 상태 / 로그
$V ls step-d-v2-web                              # 최근 배포 목록 + 상태
$V inspect <배포URL> --logs                      # 빌드 로그 (실패 원인은 여기서)

# 팀·프로젝트 확인
$V teams ls
$V project ls
```

> `NEXT_PUBLIC_*` 는 **빌드 시점에 번들로 구워진다.** 값을 바꾸면 반드시 재배포해야 반영된다.

---

## 5. 함정 모음 (실제로 당한 것들)

### ⛔ 커밋 author가 Vercel 팀 멤버가 아니면 배포가 조용히 차단된다

**Vercel git 배포는 커밋 author 이메일이 Vercel 팀 멤버여야 빌드된다.**
`ha983885@snu.ac.kr`(hakyungjin) author 커밋은 "Git author must have access to the
project"로 **전 배포가 UNKNOWN 차단**됐다 — 에러도 없이 무한 대기처럼 보인다.

→ 배포 커밋은 반드시 **`contact@stepai.kr`** author로. `deploy/deploy-web.ps1`이
이걸 강제한다: `git config user.email` 설정 + 미푸시 커밋 중 author가 다르면
`git rebase --exec "git commit --amend --reset-author"`로 자동 재작성.
빌드가 시작조차 안 되면 **가장 먼저 author부터 의심할 것.**

### ⛔ `apps/web` 에서 `npm install` 하지 말 것

이 저장소는 **pnpm 워크스페이스**다 (루트 `pnpm-lock.yaml` + `pnpm-workspace.yaml`).
pnpm으로 설치된 상태에서 `apps/web`에서 `npm install`을 돌리면, npm이 pnpm 심볼릭 링크를
그대로 락파일에 기록한다:

```json
"node_modules/clsx": { "resolved": "../../node_modules/.pnpm/clsx@2.1.1/...", "link": true }
```

Vercel은 root directory가 `apps/web`이라 거기 `package-lock.json`이 있으면 **npm으로 설치**하는데,
`../../node_modules/.pnpm/` 은 거기 존재하지 않는다 → **clsx·cva·exceljs·@base-ui/react·
@tailwindcss/postcss 등 13개가 아예 설치되지 않고 빌드 실패.**

> 실제로 이것 때문에 7시간 동안 배포 6개가 연속 `● Error` 났다.
> `Module not found: Can't resolve 'clsx'` 가 뜨면 이걸 의심할 것.

`package-lock.json`은 `.gitignore`에 넣어뒀다. 의존성 설치는 **루트에서 `pnpm install`**.

### 배포 보호(Deployment Protection)는 현재 꺼져 있다

2026-07-16 실측: `https://stepd.stepai.kr`도 `https://stepd.stepai.kr/api/state`도
**익명 200**이다 (후자는 rewrite 프록시 경유). curl 스모크테스트가 가능하고,
`deploy-web.ps1`의 5단계 확인도 이를 전제로 한다.

과거(2026-07-14)에는 켜져 있어서 익명 요청이 Vercel SSO 로그인으로 302됐다.
누가 다시 켜면 curl 헬스체크·스모크가 302로 깨지니, 그때는 이 설정부터 확인할 것.

### 로컬 `.vercel/project.json` 이 낡을 수 있다

리포가 `STEP-AI-organization`으로 이전되면서 Vercel 프로젝트의 Git 연동도 재연결됐다.
로컬 `.vercel/project.json`이 옛 팀 ID(`team_JnURKZ…`)나 이전 전 연결 정보를 물고 있으면
CLI가 접근 불가 스코프로 붙으려다 실패한다.
`rm -rf .vercel` 후 §4의 `vercel link`를 다시 돌리면 된다.

---

## 6. 배포가 실패했을 때

먼저 **커밋 author가 `contact@stepai.kr`인지** 확인 (빌드가 아예 안 잡히거나 UNKNOWN이면
십중팔구 §5의 author 함정). 그 다음:

```bash
T=$(cat gcp-keys/vercel-token.txt)
vercel ls step-d-v2-web --token="$T" --scope step-ai        # ● Error 인 배포 URL 확인
vercel inspect <그URL> --logs --token="$T" --scope step-ai  # 빌드 로그 확인
```

빌드 로그 앞부분에서 **어떤 패키지 매니저로 설치했는지** 먼저 볼 것.
`npm warn` / `npm fund` 가 보이면 위의 락파일 함정이다 (pnpm이어야 정상).

배포 전체 흐름(서버·워커 포함)은 [deploy.md](deploy.md), 인프라 전반은 [infra.md](infra.md) 참고.

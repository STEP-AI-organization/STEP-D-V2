# 협업 규칙

> 2026-09-07 작성 — 사람이 늘면서 만들었다. 그전엔 혼자라 규칙이 머릿속에 있었다.
> 리포 전체 맥락은 [CLAUDE.md](CLAUDE.md), 처음 켜는 법은 [README.md](README.md).

---

## 첫 주에 알아야 할 것 다섯

1. **`pnpm check` 가 통과해야 PR 을 연다.** CI 가 같은 걸 돌린다 — 로컬에서 먼저 보는 게 빠르다.
2. **`.env` · `gcp-keys/` 는 절대 커밋하지 않는다.** (2026-07-14 개인키 유출 사고가 있었다)
3. **서버 라우트는 `apps/server/src/index.ts` 한 파일에 유지한다.** 분리하지 말 것.
4. **깨진 테스트의 숫자를 지우지 말 것.** 이 리포의 테스트 상당수는 "소스를 읽어 불변식을
   고정하는" 형태다. 빨개지면 **원인을 고친다** — 기대값을 현실에 맞추는 게 아니다.
5. **배포는 요청받았을 때만 한다.** 머지 ≠ 배포다 (§배포).

---

## 브랜치와 PR

`main` 은 **보호돼 있다.** 직접 푸시는 거부되고, PR + CI 초록이어야 머지된다.

```bash
git switch -c fix/자막-줄바꿈          # 브랜치 이름은 자유 · 무엇을 하는지 알아보게
# ... 작업 ...
pnpm check                            # ← 먼저 돌린다
git commit                            # 메시지 규칙은 아래
gh pr create --fill
```

- **작게 쪼갠다.** 리뷰가 가능한 크기가 좋은 PR 이다.
- **머지는 squash.** `main` 이력이 한 줄로 읽힌다.
- ⚠️ **머지는 Vercel 팀 시트를 가진 사람이 누른다.** squash 머지 커밋의 author 는
  **머지를 실행한 사람**이 되는데(실측 2026-09-07), 그 사람이 Vercel 팀에 없으면
  그 시점부터 **웹 배포가 조용히 멈춘다**. 시트가 유료라 인원을 안 늘리는 대신 이 규칙을 쓴다
  — 자세히는 [docs/ops/onboarding-access.md](docs/ops/onboarding-access.md).
- 리뷰는 필수가 아니지만, **처음 몇 개는 받는 걸 권한다** — 이 리포엔 함정이 많고
  대부분 코드 주석에 적혀 있다.

### 커밋 메시지

한국어로, **무엇을 왜** 를 쓴다. 제목은 "무엇이 달라지는가", 본문은 "왜 그렇게 했는가".

```
feat(i18n): 베트남어 배포 — 자막·제목·메타·글꼴이 한 값을 따른다

자막만 바꾸면 "자막은 베트남어인데 제목은 한국어 규격" 이 되므로 한 표에서
자막 폭·제목 폭·허용 글꼴·메타 언어를 같이 꺼내 쓴다.

가장 위험한 건 글꼴이었다. 지마켓 산스는 베트남어를 1% 밖에 안 덮는데
libass 는 오류 없이 다른 폰트로 대체한다 — 발행 뒤에야 안다.
```

접두사는 `feat` · `fix` · `refactor` · `docs` · `test` · `chore`, 범위는 폴더나 도메인.
**"왜" 가 제목보다 중요하다** — 6개월 뒤 이 줄을 읽는 사람은 코드는 볼 수 있지만 이유는 못 본다.

---

## 검증 — `pnpm check` 하나면 된다

```bash
pnpm check
```

전 패키지 타입체크 + 서버 테스트(1733) + 네이티브 테스트(106) + **core 파이썬 테스트(103)** 를 돈다.

⚠️ 네이티브 테스트 106개는 **2026-09-07~09-11 나흘간 CI 에서 한 번도 안 돌았다.** ci.yml 의
필터 이름이 틀렸는데(`@stepd/native` · 실제는 `stepaistudio`) pnpm 이 그걸 **exit 0** 으로
넘겼기 때문이다. 지금은 `--fail-if-no-match` 와 `workspace-filters.test.ts` 가 같이 막는다.

개별로 돌리려면:

| | |
|---|---|
| 서버 | `cd apps/server && npx tsc --noEmit` · `node --import tsx --test "src/tests/**/*.test.ts"` |
| 웹 | `cd apps/web && npx next build` (⚠️ `tsc --noEmit` 만으론 부족 — 프리렌더가 빌드에서 걸린다) |
| core | `pnpm test:core` (파이썬 없으면 조용히 건너뛴다) |

**`pnpm lint` 는 아직 관문이 아니다.** 기존 오류가 30개 남아 있어 CI 에서 뺐다 —
초록이 아닌 관문은 사람이 무시하게 된다. 0 으로 만들면 `.github/workflows/ci.yml` 에 추가한다.
새 코드는 경고를 안 만드는 쪽으로 쓸 것.

### 테스트를 어떻게 쓰나

순수 함수는 평범하게 쓰면 된다. 다만 **이 리포 테스트의 상당수는 소스를 읽는다** —
`publish-guard` · `worker-lanes` · `docs-drift` · `rls-access` · `caption-font` 같은 것들.

순수 함수로 증명할 수 없는 불변식을 고정하기 위해서다:

- "큐에 넣는 곳은 한 군데다"
- "모든 잡 타입은 실제로 도는 레인에 있다"
- "문서에 적힌 숫자가 코드와 같다"
- "허용 글꼴이 그 언어를 실제로 덮는다" (폰트 파일 cmap 을 읽어 확인한다)

**깨지면 원인을 고친다.** 기대값을 지우면 그 불변식이 조용히 사라진다.

테스트는 `apps/server/src/tests/` 에 모은다. 그 안에서 소스를 스캔할 때 쓰는 `SRC` 같은
상수는 `".."` 가 붙어 `src/` 를 가리키므로 그대로 쓰면 된다.

### e2e — 진짜 DB · 진짜 서버 (2026-09-11 신설)

`pnpm check` 에는 **안 들어간다.** DB 가 필요해서 따로 돈다(CI 는 PR 마다 별도 job 으로 돌린다).

```bash
# Postgres 가 없으면 먼저 (⚠️ 그냥 postgres:16 은 안 된다 — 마이그레이션이 pgvector 를 쓴다)
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres --name stepd-e2e-pg pgvector/pgvector:pg16

pnpm test:e2e
```

빈 DB 생성 → 마이그레이션 → superadmin 부트스트랩 → 서버 기동 → HTTP 로 검증 → 정리까지
`apps/server/scripts/e2e.mts` 하나가 다 한다. **CI 는 Postgres 를 띄워 주기만 한다** — 그래야
로컬과 CI 가 같은 것을 돌린다.

**여기엔 DB 없이는 증명 못 하는 것만 넣는다.** 지금은 인증과 **워크스페이스 격리(RLS)** 다.
격리는 소스를 아무리 읽어도 증명이 안 된다 — 정책이 `current_setting('app.tenant_id')` 를
읽는데 그게 안 세워지면 **에러가 아니라 빈 결과**가 나오기 때문이다. 실제로 2026-08-11 에
그 모양으로 API 키가 프로덕션에서 통째로 안 도는 채 나갔다(순수·소스 테스트는 전부 통과했다).

⚠️ e2e 파일은 `*.e2e.ts` 다. `*.test.ts` 로 만들면 `pnpm check` 가 집어가서 **DB 없이 돌다
전부 실패한다.**

⚠️ e2e 용 DB 역할은 일부러 **NOSUPERUSER·NOBYPASSRLS** 다. superuser 로 붙으면 RLS 가 통째로
무시돼 격리 테스트가 **거짓 통과**한다(`assertRlsEnforced` 는 localhost 면 경고만 하고 넘어간다).
그 역할 설정을 건드리지 말 것 — 검증해 뒀다: superuser 로 바꾸면 격리 테스트 2개가 실패한다.

---

## 의존성 — 버전은 리포가 정한다, 그날의 npm/PyPI 가 아니라

**같은 커밋은 같은 것을 깔아야 한다.** 안 그러면 "어제는 됐는데" 가 빌드마다 생긴다.

| 무엇 | 어디서 고정 | 규칙 |
|---|---|---|
| node 패키지 | `pnpm-lock.yaml` | 이미지도 `--frozen-lockfile` 로 깐다. `--no-frozen-lockfile` 금지 |
| pnpm 자체 | `package.json` `packageManager` + Dockerfile 2개 | **세 곳을 같이** 올린다 (`docker-pnpm-pin.test.ts` 가 강제) |
| core 파이썬 | `core/requirements.lock.txt` | 이미지는 이걸로 깐다. `requirements.txt` 는 사람이 읽는 직접 선언분 |
| 파이썬 테스트 도구 | `core/requirements-dev.txt` | `==` 로 핀 — 도구가 바뀌어 CI 가 빨개지는 걸 막는다 |

- **새 워크스페이스 패키지를 추가하면** Dockerfile 두 개에 `COPY <dir>/package.json` 도
  넣어야 한다. `--frozen-lockfile` 이 lockfile importer 를 전부 대조하므로 하나만 빠져도
  **빌드가 죽는다.** `docker-lockfile.test.ts` 가 미리 잡아 준다.
- **파이썬 버전을 올리려면** `requirements.txt` 의 `==` 를 고치고 → lock 을 재생성하고
  (절차는 `core/requirements.lock.txt` 헤더에) → **워커 이미지를 빌드해** 빌드타임 스모크를
  통과시킨다. 스모크는 `cv2` 가 4.x contrib 인지와 mediapipe detector 가 뜨는지를 본다.
  ⚠️ opencv 는 둘이 깔린다(scenedetect→`opencv-python`, mediapipe→`opencv-contrib-python`).
  같은 `cv2` 를 덮어써서 **나중에 깔린 쪽이 이긴다** — 그래서 스모크가 있다. 지우지 말 것.
- **업데이트는 Renovate 가 PR 로 가져온다**(`renovate.json5`). 월요일 새벽, 동시 3개까지.
  pnpm 과 파이썬은 짝을 맞춰야 해서 **대시보드에서 사람이 승인할 때만** PR 이 열린다.

---

## 코드 규칙 (자주 걸리는 것)

| 무엇 | 규칙 |
|---|---|
| 서버 라우트 | `apps/server/src/index.ts` **한 파일**. 헬퍼는 도메인 폴더(`ai/` `billing/` `media/`…)로 |
| 프론트 API | `apps/web/src/lib/data/api.ts` 에 **타입과 함수를 같이** 추가 |
| 새 화면 | `src/app/(app)/<route>/page.tsx` + `src/lib/nav.ts` 의 `NAV` 배열 등록 |
| 새 잡 타입 | **반드시 레인에 넣는다** — 안 넣으면 아무도 안 집는다. `worker-lanes.test.ts` 가 강제 |
| AI 파이프라인 | `core/` (파이썬). 서버 접점은 `content-pipeline.ts` 하나 |
| env 추가 | **웬만하면 추가하지 않는다** ↓ |

### env 는 시크릿과 인프라 위치에만

제품 동작을 env 로 두면 값이 어디 있는지 아무도 모르고, 바꾸려면 재배포해야 하고,
오타의 실패 모드가 조용하다. **켜고 끄는 스위치는 DB·화면·요청 파라미터로 간다.**

2026-09-07 에 이 원칙으로 `FACTORY_ENABLED`·`FACTORY_DAILY_CAP`·`TRANSLATE_OUT_LANGS`
등을 걷어냈다. 배포 언어는 자동배포 계획(DB)이 정하고, 공장 상한은 요청 `policy` 가 정한다.

env 를 정말 추가해야 하면 순서가 있다: **로컬 `.env` + `.env.example` → Secret Manager →
Cloud Run.** `.env.example` 을 빼먹으면 다음 사람이 그 값의 존재를 모른다.

### 스타일

- 웹은 Tailwind 클래스. 인라인 style 객체 금지, 색은 CSS 변수(`var(--color-*)`)
- 주석은 **왜** 를 적는다. 무엇을 하는지는 코드가 말한다
- 함정을 발견하면 그 자리에 주석으로 남긴다 — 이 리포가 그렇게 굴러왔다

---

## 배포

**머지해도 자동으로 안 나간다.** 배포는 사람이 배포 스크립트를 직접 실행한다 —
CI 에 배포 job 을 두지 않는 건 의도한 것이다(사용자 결정 2026-09-07).
"머지했으니 나갔겠지" 를 없애려면 배포가 **눈에 보이는 행위**여야 한다.

```bash
bash deploy/cloud.sh status     # 먼저 지금 상태를 본다
bash deploy/cloud.sh server     # Cloud Run 서비스
bash deploy/cloud.sh worker     # Cloud Run Jobs 2종
bash deploy/cloud.sh all        # server + worker + migrate
```

웹(Vercel)은 `main` 푸시로 자동 배포된다 — 단 **커밋 author 가 allowlist 에 있어야 한다.**

⚠️ **새로 합류했다면 배포 권한이 아직 없다.** 필요한 권한과 부여 절차는
[docs/ops/onboarding-access.md](docs/ops/onboarding-access.md) 에 정리돼 있다.

배포 런북·함정은 [docs/ops/deploy.md](docs/ops/deploy.md), 인프라 정본은
[docs/ops/infra.md](docs/ops/infra.md).

---

## 막혔을 때

| 증상 | 먼저 볼 곳 |
|---|---|
| 로컬이 안 뜬다 | `pnpm setup:check` — 뭐가 없는지와 까는 법을 알려준다 |
| 화면이 비었다 | "서버 미연결" 인지 "데이터 없음" 인지 `/api/state` 응답으로 구분 |
| 잡이 안 잡힌다 | 그 잡 타입이 **도는 레인에 있는지** 확인 (CLAUDE.md 워커 절) |
| 원가 숫자를 인용해야 한다 | [docs/ops/how-it-works.md](docs/ops/how-it-works.md) §4 **하나뿐**이다. 다른 데 있는 숫자는 낡았다 |
| 함정 같은데 | 대개 그 파일 주석에 이미 적혀 있다. `git log -p` 로 왜 그렇게 됐는지 볼 것 |

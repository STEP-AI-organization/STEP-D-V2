# 새 합류자 권한 — 무엇을 왜 주나

> 2026-09-07 작성. **부여는 사람이 콘솔에서 한다** — 여기 적힌 건 "무엇이 필요하고
> 안 주면 무슨 증상이 나는가" 다. 증상을 모르면 권한 문제를 코드 버그로 오해한다.

권한은 **단계별로** 준다. 코드만 쓰는 동안 배포 권한은 필요 없고, 없는 편이 안전하다.

| 단계 | 필요한 것 | 없으면 |
|---|---|---|
| 1. 코드 | GitHub 리포 write | PR 을 못 연다 |
| 2. 로컬 실행 | `.env` 값 (팀에게 받는다) | 서버가 안 뜬다 |
| 3. 프로덕션 조회 | Cloud SQL·로그 읽기 | 장애 조사를 못 한다 |
| 4. 배포 | GCP deployer (Vercel 시트는 **유료 — 기본 안 줌**) | **아래 ⚠️ 를 반드시 읽을 것** |

---

## ⚠️ 가장 먼저 — 웹 배포와 Vercel 시트

**Vercel 팀 시트는 유료다.** 그래서 합류자를 팀에 넣지 않고도 웹이 배포되게 해야 한다.

### 실측으로 확인한 것 (2026-09-07 · PR #14 머지)

- Vercel 은 **커밋 이메일이 아니라 GitHub 계정 연결**을 본다.
  머지 커밋 author 가 `ha983885@snu.ac.kr` 이었는데도 정상 빌드됐다
  (Vercel 이 `contact-4523` 계정 소행으로 인식 — 그 GitHub 계정이 팀에 연결돼 있어서).
- **squash 머지 커밋의 author 는 "머지를 실행한 사람"이다.** PR 작성자가 아니다.

### 그래서 돈 안 드는 규칙

> **합류자의 PR 은 팀 시트를 가진 사람이 머지한다.**

머지 실행자가 author 가 되므로 `main` 커밋은 항상 팀 멤버 소행이 되고, 웹 배포가 안 막힌다.
합류자는 PR 만 열면 되고 Vercel 시트가 필요 없다.

**만약 합류자가 직접 머지하게 되면**: 그 시점부터 웹 배포가 조용히 멈춘다
(`Git author must have access` · 에러 없이 빌드가 시작되지 않는다 · 2026-07-16 실측).
서버는 멀쩡해서 한참 뒤에야 안다.

확인:
```bash
# main 최근 커밋들이 팀 계정 소행인지
git log --format='%ae  %s' -10 origin/main
npx vercel ls step-d --scope step-ai      # Username 열이 contact-4523 이면 정상
```

막혔을 때 우회: `.\deploy\deploy-web.ps1` 이 author 를 `contact@stepai.kr` 로 강제해서
푸시한다 — 로컬 배포 경로는 이 보호를 탄다(GitHub 머지 경로는 안 탄다).

---

## 1단계 — GitHub

- 리포: `STEP-AI-organization/STEP-D-V2` → **Write** 권한
- `main` 은 보호돼 있다(PR + CI 초록 필수). 직접 푸시는 거부된다.

> ⚠️ **이 리포는 현재 public 이다.** 실수로 커밋한 시크릿은 즉시 공개된다
> (2026-07-14 개인키 유출 사고가 실제로 있었다). 커밋 전 `git status` 를 보는 습관을
> 첫날에 들일 것. `.gitignore` 44행이 `.env*` 를 막지만 `git add -f` 는 그걸 뚫는다.

---

## 2단계 — 로컬 실행에 필요한 값

`.env` 는 리포에 없다. `apps/server/.env.example` 을 복사한 뒤 값을 받아 채운다.

**로컬 개발만 할 거면 전부 필요하지 않다:**

| 하려는 것 | 최소 필요 |
|---|---|
| 웹·서버 띄우기 | `DATABASE_URL` (로컬 Postgres 면 `dev.ps1` 가 띄운 값 그대로) |
| AI 파이프라인 | + GCP ADC(`gcloud auth application-default login`) · `SONIOX_API_KEY` |
| 유튜브 연동 | + `GOOGLE_CLIENT_ID` / `SECRET` · `PUBLIC_URL` |
| 결제 화면 | + `PORTONE_*` 4종 · `CREDIT_PRICE_KRW` |

`pnpm setup:check` 가 빠진 걸 알려준다. **실제 키는 팀에게 받는다** — Slack DM 이 아니라
1Password/Secret Manager 등 보관되는 경로로.

---

## 3단계 — 프로덕션 조회 (읽기)

장애를 볼 수 있어야 고칠 수 있다. 배포 권한보다 먼저 주는 게 낫다.

| 권한 | 용도 |
|---|---|
| `roles/logging.viewer` | Cloud Run·Jobs 로그 |
| `roles/run.viewer` | 서비스·잡 상태, env 확인 |
| `roles/cloudsql.client` | cloud-sql-proxy 로 DB 조회 |

DB 조회 방법은 [prod-db 조회 절차](#) 참고 — **접속 후 `set_config('app.tenant_id', …)` 를
반드시 호출해야 한다.** FORCE RLS 라 안 하면 모든 쿼리가 0건이고, "데이터가 없다" 로 오해한다.

---

## 4단계 — 배포 권한

### Vercel (웹) — **기본은 주지 않는다**

시트가 유료다. 위 §"돈 안 드는 규칙" 대로 **팀 시트를 가진 사람이 머지**하면 합류자는
Vercel 계정 없이도 웹이 배포된다.

정말 합류자가 직접 웹을 배포해야 할 때만:
1. Vercel 팀 `step-ai` 에 멤버 초대 (**유료 시트 1개 증가**)
2. 그 사람의 **GitHub 계정**이 그 Vercel 계정에 연결돼 있어야 한다
3. 프로젝트: `stepd-web`(프로덕션) · `stepd-admin`(어드민 — **`step-d-admin` 은 버려진 것**)

### GCP (서버·워커)

배포는 `deploy/cloud.sh` 가 **deployer SA 로** 실행한다
(`stepd-deployer@step-d.iam.gserviceaccount.com`). 사용자 계정으로 직접 하지 않는 이유는
토큰 만료 시 비대화형에서 재인증을 못 해 배포가 중간에 죽기 때문이다.

그래서 합류자에게 줄 것은 **SA 를 빌려 쓸 권한**이다:

| 권한 | 대상 | 왜 |
|---|---|---|
| `roles/iam.serviceAccountTokenCreator` | deployer SA | 그 SA 로 gcloud 를 실행 |
| `roles/cloudbuild.builds.editor` | 프로젝트 | 이미지 빌드 |
| `roles/run.developer` | 프로젝트 | 서비스·잡 갱신 |
| `roles/secretmanager.secretAccessor` | 필요한 시크릿 | 배포가 시크릿을 참조로 붙인다 |

부여 예 (실행은 프로젝트 소유자가):
```bash
gcloud iam service-accounts add-iam-policy-binding \
  stepd-deployer@step-d.iam.gserviceaccount.com \
  --member="user:<이메일>" --role="roles/iam.serviceAccountTokenCreator" \
  --project step-d
```

확인:
```bash
bash deploy/cloud.sh status     # 배포 안 하고 상태만 본다 — 권한 점검에 이걸 쓴다
```

---

## 주지 않는 것 (당분간)

- **어드민 콘솔 superadmin** — 고객사 데이터 전체가 보인다. 필요할 때 건별로.
- **커머스 세션 키**(`COMMERCE_SESSION_KEY`) — 고객사 법인 계정의 전체 권한이 담긴다.
- **포트원 API 시크릿** — 결제 실행 권한이다.
- **윈도우2 SSH** — 네이버·다운로드·커머스 워커가 도는 사무실 PC.

---

## 합류자 체크리스트

```
[ ] GitHub write · main 보호 확인(직접 푸시가 거부되는지)
[ ] 첫 PR 은 **팀 시트를 가진 사람이 머지**한다 (Vercel 웹 배포가 안 막히게)
[ ] pnpm install && pnpm setup:check 통과
[ ] .env 값 수령 (보관되는 경로로)
[ ] pnpm check 초록
[ ] 첫 PR 을 작게 하나 — CI 가 도는 걸 눈으로 확인
[ ] CLAUDE.md · CONTRIBUTING.md 읽기
```

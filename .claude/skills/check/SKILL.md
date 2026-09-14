---
name: check
description: STEP-D 검증 — CI 가 도는 것을 로컬에서 그대로 (typecheck·서버/네이티브/파이썬 테스트·웹 빌드·실제 DB e2e). 테스트/검증/체크/CI/PR 전 확인 요청 시 사용.
---

# STEP-D 검증 — CI 와 같은 것을 로컬에서

```bash
pnpm ci:local             # 전부 (CI 와 동일)
pnpm ci:local --fast      # e2e·웹빌드 빼고 (빠른 확인)
pnpm ci:local --no-e2e    # DB 를 못 띄울 때
```

`scripts/ci-local.mjs` 가 `.github/workflows/ci.yml` 의 단계를 그대로 돈다.

⚠️ **`pnpm ci` 가 아니다.** `ci` 는 **pnpm 내장 명령**(`npm ci` 처럼 lockfile 설치)이라
package.json 스크립트로 덮어쓸 수 없다 — 내장이 이기고 `--fast` 는
`ERROR Unknown option: 'fast'` 로 죽는다(2026-09-11 실측).

## 왜 `pnpm check` 로는 부족한가

`pnpm check` 에는 **웹 빌드와 e2e 가 없다.**

| | `pnpm check` | `pnpm ci` | CI |
|---|---|---|---|
| 전 패키지 typecheck | ✅ | ✅ | ✅ |
| 서버 테스트 | ✅ | ✅ | ✅ |
| 네이티브 테스트 | ✅ | ✅ | ✅ |
| core 파이썬 | ✅ (없으면 건너뜀) | ✅ (`--required`) | ✅ (`--required`) |
| **웹 빌드(next build)** | ❌ | ✅ | ✅ |
| **e2e (진짜 DB·서버)** | ❌ | ✅ | ✅ |

- `pnpm -r typecheck` 는 `tsc --noEmit` 이라 **Next 프리렌더 오류를 못 잡는다**
  (`useSearchParams` 를 Suspense 로 안 감싼 페이지 같은 것). 그건 빌드에서만 드러난다.
- e2e 는 **DB 없이는 증명 안 되는 것**을 본다 — 인증, 그리고 **워크스페이스 격리(RLS)**.

## e2e 용 Postgres

스크립트가 알아서 한다:

1. `127.0.0.1:5432` 가 열려 있으면 **그대로 쓴다**
2. 없으면 docker 로 띄운다 — `pgvector/pgvector:pg16` · 컨테이너 `stepd-e2e-pg`
3. docker 도 없으면 **e2e 만 건너뛰고** 나머지는 돈다 (마지막에 `SKIP` 으로 표시)

⚠️ **`postgres:16` 은 안 된다.** 마이그레이션 0009 가 `CREATE EXTENSION vector` 를 쓴다
(검색 임베딩 768d). 반드시 pgvector 가 든 이미지여야 한다.

⚠️ e2e 는 매번 **DB 를 지우고 새로 만든다**(`stepd_e2e`). 로컬 개발 DB 와 이름이 다르니
안전하지만, 5432 에 **다른 용도의 Postgres** 를 띄워 뒀다면 그 서버 안에 `stepd_e2e`
데이터베이스와 `stepd_e2e_app` 역할이 생긴다.

## 결과 읽는 법

마지막에 단계별 `PASS`/`FAIL`/`SKIP` 과 소요 시간이 나온다.

- **`SKIP` 이 있으면 "전부 통과" 가 아니다.** 스크립트도 그렇게 말한다
  (`전부 통과 — 단 N개는 안 돌았다`). CI 는 그것도 돌린다.
- 실패해도 **끝까지 돈다** — 한 번에 다 보는 게 낫다. CI 도 job 을 병렬로 돌린다.

## ⚠️ 함정

1. **CI 에 관문을 추가하면 `scripts/ci-local.mjs` 의 `STEPS` 에도 추가해야 한다.**
   `ci-local-parity.test.ts` 가 강제한다 — ci.yml 의 **`name:` 이 붙은 step** 을 전부
   대조한다. 그래서 **ci.yml 에 관문을 넣을 때는 `name:` 을 붙일 것**(이름 없는 `- run:` 은
   환경 준비로 간주해 지나간다).
   갈라지면 "로컬에선 초록인데 CI 는 빨강" 을 이 스크립트가 직접 만들어낸다.

2. **`--fail-if-no-match` 를 지우지 말 것.** pnpm 은 필터가 아무 패키지와도 안 맞으면
   `No projects matched the filters` 를 찍고 **exit 0** 으로 끝난다 — 빨강이 아니라
   **조용한 초록**이다. 2026-09-07~09-11 나흘간 CI 의 "네이티브 테스트" 가 그래서
   106개를 하나도 안 돌렸다(필터가 `@stepd/native`, 실제 이름은 `stepaistudio`).

3. **core 파이썬은 `--required` 로 돈다** — CI 와 같게 하려는 것이다. 파이썬이 없으면
   실패하고 까는 법을 안내한다. (`pnpm check` 는 반대로 조용히 건너뛴다 — 웹·서버만
   하는 사람을 막지 않으려고.)
   ⚠️ **새로 클론했거나 worktree 를 쓰면 여기서 빨개진다** — `core/.venv310` 은 gitignore 라
   따라오지 않는다. `python3 -m pip install -r core/requirements-dev.txt` 하면 된다
   (테스트 103개는 네트워크를 안 타므로 무거운 것들은 필요 없다).
   파이썬을 안 깔 거면 `--no-core` 대신 **`pnpm check` 를 쓸 것** — 그쪽은 건너뛴다.

4. **`pnpm lint` 는 아직 관문이 아니다.** 기존 오류가 남아 있어 CI 에서 뺐다. 여기에도 없다.
   0 으로 만들면 ci.yml 과 `STEPS` 에 **같이** 넣을 것.

## 실패했을 때

| 증상 | 볼 곳 |
|---|---|
| 소스 스캔 테스트가 빨강 | **기대값을 지우지 말 것.** 그 불변식을 고정하려고 있는 테스트다 — 원인을 고친다 (CONTRIBUTING §테스트를 어떻게 쓰나) |
| e2e 격리 테스트가 빨강 | RLS 정책이 안 걸렸거나, `app.tenant_id` 를 안 세우는 경로로 조회했거나, 접속 역할에 BYPASSRLS 가 있다 (`scripts/e2e.mts` 주석) |
| 웹 빌드만 빨강 | 대개 프리렌더 — Suspense 경계, 빌드타임에 브라우저 API 접근 |
| e2e 가 `SKIP` 으로만 나옴 | docker 가 없거나 5432 를 못 띄운 것. 위 §Postgres 참고 |

배포는 이 스킬이 아니라 `/deploy` 다. **머지 ≠ 배포.**

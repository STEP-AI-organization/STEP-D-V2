# DB 마이그레이션 (node-pg-migrate)

> 스키마 변경을 추적·재현 가능하게 관리한다. 도구: [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) v7.
> 위치: `apps/server/migrations/` · 추적 테이블: `pgmigrations` · 접속: `DATABASE_URL`.

## 배경 — 왜 baseline인가

프로덕션 스키마는 지금까지 런타임 부트스트랩(`src/db-pg.ts` `migrate()` + `src/queue.ts` `initQueue()`)이
전부 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`로 **additive하게만** 만들어 왔다.
그 최종 상태를 **baseline 마이그레이션 1개**(`migrations/1784246400000_baseline-production-schema.cjs`)로
그대로 캡처했다. 빈 DB(로컬/CI)에 `migrate up`을 돌리면 프로덕션과 동일한 스키마가 재현된다.

**비파괴 원칙:** baseline의 모든 문장은 `IF NOT EXISTS` 형태다. DROP·파괴적 변경 없음. `down`은
`false`(비가역)로 두어 실수로 라이브 스키마를 지우지 못하게 막았다. 런타임 부트스트랩은 **그대로 유지**한다
— 둘 다 `IF NOT EXISTS`라 충돌 없이 공존하는 안전망이다.

## 명령어 (apps/server 안에서)

```bash
pnpm migrate up            # 밀린 마이그레이션 적용
pnpm migrate down          # 직전 1개 되돌리기 (baseline은 거부됨 = 정상)
pnpm migrate create <이름> # 새 마이그레이션 파일 생성 (migrations/에 타임스탬프_이름.cjs)
pnpm migrate up --fake     # 실행 없이 "적용됨"으로만 표시 (아래 프로덕션 절 참고)
```

`pnpm migrate`는 내부적으로 `--envPath .env --migrations-dir migrations --migrations-table pgmigrations`를
붙인다. 로컬은 `apps/server/.env`의 `DATABASE_URL`을 자동으로 읽고, CI는 `.env`가 없어도(무시됨) 환경변수
`DATABASE_URL`을 사용한다.

## 빈 DB 재현 검증 (로컬/CI)

Docker Postgres로 검증된 절차 (2026-07-17 실측 통과):

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=stepd -p 55433:5432 postgres:16
cd apps/server
DATABASE_URL="postgres://postgres:test@localhost:55433/stepd" \
  npx node-pg-migrate up --migrations-dir migrations --migrations-table pgmigrations
# → 12개 도메인 테이블 + pgmigrations, 전체 인덱스(부분 unique dedupe 포함), additive 컬럼 모두 생성
docker rm -f pgtest
```

검증 항목: 재실행 시 `No migrations to run!`(멱등) · 추적행 삭제 후 재실행해도 기존 스키마에 no-op으로
통과(IF NOT EXISTS) · `--fake`는 DDL 없이 추적행만 기록.

## ⚠️ 프로덕션 (Cloud SQL) — 반드시 확인 후

**프로덕션 DB에는 절대 임의로 `migrate up`을 돌리지 않는다.** 담당자 확인 필수.

프로덕션에는 이미 전체 스키마가 존재하므로, baseline을 **실행 없이 "적용됨"으로만** 표시하면 된다:

```bash
# apps/server 안, DATABASE_URL = 프로덕션 Cloud SQL
pnpm migrate up --fake     # pgmigrations에 baseline 추적행만 INSERT, DDL 실행 안 함
```

baseline 자체가 전부 `IF NOT EXISTS`라 설령 `--fake` 없이 실제로 실행해도 no-op(파괴 없음)이지만,
관례상 프로덕션에서는 `--fake`로 표시만 하고 실제 스키마 변경은 하지 않는다. 이후 새로 추가되는
마이그레이션부터 프로덕션에서 실제로 `migrate up` 적용한다(그때도 확인 후).

## 새 스키마 변경 추가하기

1. `pnpm migrate create add-something` → `migrations/<ts>_add-something.cjs` 생성.
2. `exports.up`에 `pgm.sql(...)` 또는 pgm 헬퍼로 변경 작성. **되도록 additive**(ADD COLUMN 등).
3. 빈 DB(위 Docker 절차)에서 `migrate up` 검증.
4. 런타임 부트스트랩(`db-pg.ts`)과의 정합성 유지 — 새 컬럼/테이블은 부트스트랩에도 `IF NOT EXISTS`로
   반영해 안전망을 계속 일치시킨다(또는 부트스트랩 단계적 축소 결정 시 별도 논의).

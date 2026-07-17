# DB 마이그레이션 (node-pg-migrate)

> 스키마를 **버전 순차**로 관리한다. 도구: [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) v7.
> 위치: `apps/server/migrations/` · 추적 테이블: `pgmigrations` · 접속: `DATABASE_URL`.
> 개발자용 짧은 규칙: [apps/server/MIGRATIONS.md](../../apps/server/MIGRATIONS.md).

## 버전관리 체계

- 마이그레이션은 **4자리 순번**으로 관리한다: `0001_baseline.cjs`, `0002_...`, `0003_...`.
  적용 순서 = 버전 순서. node-pg-migrate가 숫자 프리픽스로 정렬하고, 적용 이력은 `pgmigrations`에 기록된다.
- **`0001_baseline` = version 1** — 현재 프로덕션 전체 스키마의 스냅샷(아래 "배경").
- **이후 모든 스키마 변경은 새 번호 파일 추가로만** 한다. 기존 파일을 수정하지 않는다(이미 적용된 마이그레이션은 불변).
- 파일 생성은 `pnpm migrate:create <이름>` — `migrations/`의 최고 순번 +1로 만들어 준다.

## 배경 — 왜 baseline인가

프로덕션 스키마는 지금까지 런타임 부트스트랩(`src/db-pg.ts` `migrate()` + `src/queue.ts` `initQueue()`)이
전부 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`로 **additive하게만** 만들어 왔다.
그 최종 상태를 `0001_baseline.cjs`로 그대로 캡처했다. 빈 DB(로컬/CI)에 `migrate up`을 돌리면 프로덕션과
동일한 스키마가 재현된다.

**비파괴 원칙:** baseline의 모든 문장은 `IF NOT EXISTS` 형태다. DROP·파괴적 변경 없음. `down`은
`false`(비가역)로 두어 실수로 라이브 스키마를 지우지 못하게 막았다. 런타임 부트스트랩은 **그대로 유지**한다
— 둘 다 `IF NOT EXISTS`라 충돌 없이 공존하는 안전망이다. **단, 앞으로 스키마 변경을 db-pg.ts에 새로
추가하지 않는다** — 변경은 새 마이그레이션으로만.

## 명령어 (apps/server 안에서)

```bash
pnpm migrate:create <이름>   # 다음 순번 마이그레이션 파일 생성 (0002_...cjs)
pnpm migrate:status          # 적용/미적용 목록 (migrations/ vs pgmigrations)
pnpm migrate up              # 밀린 마이그레이션 순서대로 적용
pnpm migrate down            # 직전 1개 되돌리기 (0001 baseline은 거부됨 = 정상)
pnpm migrate:redo            # 직전 1개 down→up
pnpm migrate up --fake       # 실행 없이 "적용됨"으로만 표시 (프로덕션 절 참고)
```

`pnpm migrate`는 내부적으로 `--envPath .env --migrations-dir migrations --migrations-table pgmigrations`를
붙인다. 로컬은 `apps/server/.env`의 `DATABASE_URL`을 자동으로 읽고, CI는 `.env`가 없어도(무시됨) 환경변수
`DATABASE_URL`을 사용한다.

## up / down 작성

`.cjs` 파일에 `exports.up` / `exports.down`. `pgm.sql(...)`로 raw SQL을 넣는 게 가장 명시적이다. 되도록
additive(`ADD COLUMN IF NOT EXISTS` 등)하게 쓰고, 되돌릴 수 없는 변경은 `exports.down = false;`. 자세한
템플릿·예시는 [apps/server/MIGRATIONS.md](../../apps/server/MIGRATIONS.md).

## ⚠️ migrations/ 폴더에는 `.cjs` 마이그레이션만

node-pg-migrate는 마이그레이션 디렉터리의 **모든 파일을 `require()`** 한다(기본 무시 패턴은 닷파일뿐).
`README.md` 같은 게 섞여 있으면 JS로 파싱하려다 `SyntaxError`로 죽고, **`migrate up`이 아예 안 돈다.**
실제로 0001 도입 당시 `migrations/README.md`가 그 폴더에 있어서 이 상태였다(→ `apps/server/MIGRATIONS.md`로 이동).

- **폴더에 마이그레이션 파일만 유지**한다 — 플래그 없이 `npx node-pg-migrate …`로 돌려도 안전해지는 유일한 보장.
- `package.json`의 `migrate` 스크립트는 추가 방어로 `--ignore-pattern "(?!\d{4}_.*\.cjs$).*"`(= `NNNN_*.cjs`만
  허용)를 붙인다. 스크립트를 거칠 때만 적용되니 위 규칙을 대체하지는 않는다.

## 빈 DB 재현 검증 (로컬/CI)

Docker Postgres로 검증된 절차 (2026-07-17 재실측 통과, 0002 포함):

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=stepd -p 55433:5432 postgres:16
cd apps/server
export DATABASE_URL="postgres://postgres:test@localhost:55433/stepd"
pnpm migrate up        # 0001 → 0002 → … 순서대로 적용
pnpm migrate:status    # 전부 [x] applied 확인
docker rm -f pgtest
```

검증 항목(실측 통과): 순번 순서대로 적용(`pgmigrations` = 0001 → 0002) · `migrate:status` 정확 ·
`migrate down`이 직전 1개만 역적용(0002만 드랍, 나머지 13개 테이블 무손상) · 재실행 시
`No migrations to run!`(멱등) · baseline `down` 거부.

> **이력:** 최초 도입(534661d) 당시 "실측 통과"로 적어 뒀지만, 같은 커밋이 `migrations/README.md`를
> 그 폴더에 넣는 바람에 이후 `migrate up`은 어떤 경로로도 실행되지 않았다(위 "`.cjs`만" 절 참고).
> 0002 작업 중 발견해 고쳤고, 위 항목은 그 수정 이후 다시 측정한 결과다.

## ⚠️ 프로덕션 (Cloud SQL) — 반드시 확인 후

**프로덕션 DB에는 절대 임의로 `migrate up`을 돌리지 않는다.** 담당자 확인 필수.

프로덕션에는 이미 전체 스키마가 존재하므로, baseline(0001)을 **실행 없이 "적용됨"으로만** 표시한다:

```bash
# apps/server 안, DATABASE_URL = 프로덕션 Cloud SQL
pnpm migrate up --fake     # pgmigrations에 0001 baseline 추적행만 INSERT, DDL 실행 안 함
```

baseline 자체가 전부 `IF NOT EXISTS`라 설령 `--fake` 없이 실제로 실행해도 no-op(파괴 없음)이지만, 관례상
프로덕션에서는 `--fake`로 표시만 한다. **0001을 fake로 표시한 뒤부터** 새로 추가되는 마이그레이션(0002~)은
프로덕션에서 실제로 `migrate up` 적용한다(그때도 확인 후, 되도록 additive로).

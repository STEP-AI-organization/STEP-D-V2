# DB 마이그레이션 — 버전관리 규칙

스키마 변경은 **`migrations/`에 새 번호 파일을 추가하는 것으로만** 한다.
도구: [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) v7 · 추적 테이블: `pgmigrations` · 접속: `DATABASE_URL`.
운영 절차·프로덕션 반영은 [docs/ops/migrations.md](../../docs/ops/migrations.md) 참고.

> 이 문서가 `migrations/` **밖에** 있는 이유는 아래 "migrations/ 폴더에는 마이그레이션 파일만" 참고.

## 파일명 규칙

```
NNNN_kebab-slug.cjs        예) 0001_baseline.cjs, 0002_add-clip-status.cjs
```

- 4자리 순번(`0001`, `0002`, …) — 적용 순서 = 버전 순서. node-pg-migrate가 숫자 프리픽스로 정렬한다.
  (실행 중 `Can't determine timestamp for 0002` 경고가 뜨는데, 순번을 타임스탬프로 못 읽었다는 뜻일 뿐
  정렬·적용은 정상이다. 무해.)
- `0001_baseline.cjs` = version 1. 현재 프로덕션 전체 스키마의 스냅샷(비가역, `down=false`).
- 확장자는 `.cjs` (CommonJS). 이 워크스페이스는 `type: module`이라 `.js`는 ESM으로 로드되니 `.cjs`를 쓴다.

## ⚠️ migrations/ 폴더에는 마이그레이션 파일만

**`migrations/`에 `.cjs`가 아닌 파일을 절대 두지 말 것** (README·메모·백업 등).

node-pg-migrate는 마이그레이션 디렉터리의 **모든 파일을 `require()`** 한다. 기본 무시 패턴은
`^\..*`(닷파일)뿐이라, `README.md` 같은 파일이 있으면 그걸 JS로 파싱하려다 터진다:

```
Error: Can't get migration files: …/migrations/README.md:1
# DB 마이그레이션 — 버전관리 규칙
^
SyntaxError: Invalid or unexpected token
```

이 때문에 `migrate up`이 **아예 실행되지 않는다**(실제로 이 문서가 여기 있어서 그랬고, 그래서 밖으로 뺐다).

방어는 2겹이다:
1. **폴더를 깨끗하게 유지** — 이게 진짜 보장. `npx node-pg-migrate …` 처럼 플래그 없이 직접 돌려도 안전해진다.
2. `package.json`의 `migrate` 스크립트가 `--ignore-pattern "(?!\d{4}_.*\.cjs$).*"` 로 **`NNNN_*.cjs`만 허용**
   — 실수로 파일이 들어와도 `pnpm migrate …` 경로는 버틴다. 단, 이건 스크립트를 거칠 때만 적용되므로
   1번을 대체하지 않는다.

## 명령어 (apps/server 안에서)

```bash
pnpm migrate:create <이름>   # 다음 순번으로 파일 생성 (예: 0002_add-clip-status.cjs)
pnpm migrate:status          # 적용/미적용 목록
pnpm migrate up              # 밀린 마이그레이션 순서대로 적용
pnpm migrate down            # 직전 1개 되돌리기 (0001 baseline은 거부됨 = 정상)
pnpm migrate:redo            # 직전 1개 down→up
```

`pnpm migrate:create`는 `migrations/`의 최고 순번 +1로 파일을 만든다. 여러 명이 동시에 작업하면 같은 번호가
날 수 있으니 **생성 전에 `git pull`** 하고, 충돌 나면 번호를 하나 올려 rename.

## up / down 작성 가이드

`.cjs`에 `exports.up` / `exports.down`을 쓴다. `pgm.sql(...)`로 raw SQL을 넣는 게 가장 단순하고 명시적이다.

```js
/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // 되도록 ADDITIVE·비파괴적으로.
  pgm.sql(`ALTER TABLE clips ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE clips DROP COLUMN IF EXISTS status;`);
};
```

원칙:
- **비파괴 우선** — `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`. 라이브 데이터 DROP·파괴적 변경은 피하고, 꼭 필요하면 PR에서 명시적으로 리뷰.
- **down은 up의 역**을 쓴다. 되돌릴 수 없는 변경이면 `exports.down = false;` 로 두면 `migrate down`이 거부한다(baseline이 그 예).
- 빈 DB에서 `migrate up`이 통과하는지 검증하고 커밋(방법: docs/ops/migrations.md).

## db-pg.ts 부트스트랩은 어떻게?

`src/db-pg.ts`(`migrate()`)와 `src/queue.ts`(`initQueue()`)의 `CREATE TABLE IF NOT EXISTS` 부트스트랩은
**안전망으로 그대로 유지**한다. 단, **앞으로 스키마 변경을 거기에 새로 추가하지 말 것** — 변경은 이 폴더의
새 마이그레이션으로만. (baseline이 그 부트스트랩의 현재 상태를 이미 캡처했고, 둘 다 IF NOT EXISTS라 공존한다.)

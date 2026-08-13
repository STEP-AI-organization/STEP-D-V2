/* eslint-disable camelcase */
/**
 * 0034 — instagram_accounts 를 테넌트 격리에 편입 (0013·0014 의 누락분 · 0021 과 같은 방식).
 *
 * 이 테이블은 마이그레이션 없이 db-pg.ts 런타임 CREATE 로만 생겨 tenant_id 도 RLS 도
 * 없었다 — 회사 A 가 회사 B 의 인스타그램 계정(액세스 토큰 포함)을 그대로 본다.
 * 새 테이블을 만들 때 0014 목록을 같이 안 늘리면 매번 이렇게 샌다.
 *
 * CREATE TABLE 을 여기서 먼저 하는 이유: 마이그레이션이 런타임 생성(db-pg.ts)보다 먼저
 * 도는 새 DB 에서도 RLS 가 걸려야 한다. 컬럼은 db-pg.ts 의 런타임 스키마와 동일하게
 * 유지해야 하고, 런타임이 먼저 만든 기존 DB 에서는 IF NOT EXISTS 로 지나간다.
 * (런타임 CREATE 는 meta_accounts 전례대로 그대로 둔다 — 로컬은 마이그레이션 없이 돈다.)
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const TABLES = ["instagram_accounts"];

// 0014 와 **같은** 술어. EXECUTE 안의 문자열 리터럴이라 작은따옴표를 두 번 쓴다.
// (한 번만 쓰면 EXECUTE 문자열이 거기서 끊겨 "syntax error at or near ." 로 죽는다.)
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS instagram_accounts (
      publicId           TEXT PRIMARY KEY,
      igUserId           TEXT NOT NULL UNIQUE,
      username           TEXT NOT NULL,
      name               TEXT,
      profilePictureUrl  TEXT,
      accessToken        TEXT NOT NULL,
      expiresAt          BIGINT NOT NULL,
      permissions        TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'active',
      connectedAt        BIGINT NOT NULL
    );
  `);

  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        -- 기존 행은 기본 테넌트로, 새 행은 커넥션 컨텍스트를 따른다 (0013 → 0014 순서와 동일).
        EXECUTE 'ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT ''t_default''';
        EXECUTE 'ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${t}_tenant') THEN
          EXECUTE 'ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_tenant
                     FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
        END IF;

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)';

        EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
        EXECUTE 'CREATE POLICY tenant_isolation ON ${t}
                   USING ${PREDICATE}
                   WITH CHECK ${PREDICATE}';
      END $$;
    `);
  }
};

// 되돌리면 격리가 사라진다 — 라이브에서 실수로 내려가지 않게 막는다 (0014 와 동일).
exports.down = false;

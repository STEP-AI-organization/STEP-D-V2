/* eslint-disable camelcase */
/**
 * 0021 — 뒤에 생긴 테이블들을 테넌트 격리에 편입 (0013·0014 의 누락분).
 *
 * 0014 의 TABLES 목록은 그때 존재하던 테이블만 담고 있다. 그 뒤에 만든
 * channel_rule(0015) · asset_folder/asset_file(0016) · automation_*(0019) 은
 * **RLS 밖에 있었다.** 방송사 A 가 방송사 B 의 채널 규칙·에셋·자동배포 규칙을
 * 그대로 보는 상태다. 새 테이블을 만들 때마다 0014 를 같이 안 고치면 매번 이렇게 샌다.
 *
 * ⚠️ 유일성도 함께 고친다 — 이게 더 조용한 사고다.
 *   asset_folder 의 PK 는 `path` 하나였다. 방송사 두 곳이 각자 `/로고` 폴더를 만들면
 *   **두 번째가 PK 충돌로 실패한다.** RLS 로 안 보이게만 해서는 못 고친다 —
 *   유일 제약은 정책과 무관하게 테이블 전체에 걸리기 때문이다.
 *   asset_file(folder,name) · channel_rule(platform,account_id) ·
 *   automation_rule(program_id,platform,account_id) · rule_hold PK 도 같은 문제다.
 *
 * 정책 문자열은 0014 와 같아야 한다 — 두 벌이 되면 한쪽만 고치게 된다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** 0014 이후에 생긴 테이블들. */
const TABLES = [
  "channel_rule",
  "asset_folder",
  "asset_file",
  "automation_rule",
  "rule_run",
  "rule_hold",
  "automation_setting",
];

// 0014 와 **같은** 술어. EXECUTE 안의 문자열 리터럴이라 작은따옴표를 두 번 쓴다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/**
 * 테넌트를 포함하도록 다시 잡아야 하는 제약: [테이블, 제약명, 종류, 새 컬럼들]
 * PK 를 UNIQUE 로 바꾸면 NULL 허용이 되어 의미가 달라진다 — 종류를 그대로 유지한다.
 */
const KEYS = [
  ["channel_rule", "channel_rule_pkey", "PRIMARY KEY", "tenant_id, platform, account_id"],
  ["asset_folder", "asset_folder_pkey", "PRIMARY KEY", "tenant_id, path"],
  ["asset_file", "asset_file_folder_name_key", "UNIQUE", "tenant_id, folder, name"],
  ["automation_rule", "automation_rule_program_id_platform_account_id_key", "UNIQUE", "tenant_id, program_id, platform, account_id"],
  ["rule_hold", "rule_hold_pkey", "PRIMARY KEY", "tenant_id, rule_id, clip_id"],
  ["automation_setting", "automation_setting_pkey", "PRIMARY KEY", "tenant_id, key"],
];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = current_schema() AND table_name = '${t}') THEN
          -- 기존 행은 기본 테넌트로. 새 행은 커넥션 컨텍스트를 따른다(0014 와 동일).
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
        END IF;
      END $$;
    `);
  }

  // 유일 제약을 테넌트 포함으로 다시 잡는다.
  // (RLS 는 행을 숨길 뿐 유일 제약을 우회하지 못한다 — 남의 행과 충돌해서 INSERT 가 실패한다.)
  for (const [table, constraint, kind, cols] of KEYS) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = current_schema() AND table_name = '${table}') THEN
          EXECUTE 'ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}';
          EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${kind} (${cols})';
        END IF;
      END $$;
    `);
  }
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = current_schema() AND table_name = '${t}') THEN
          EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
          EXECUTE 'ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY';
        END IF;
      END $$;
    `);
  }
};

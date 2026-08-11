/* eslint-disable camelcase */
/**
 * 0025 — 네이버 계정 레지스트리 (B2B 다계정).
 *
 * 지금까지 네이버 발행은 **워커 PC 에 세션 파일 하나**를 전제로 했다. 고객사가 늘면
 * 그대로 깨진다 — A사 클립이 B사 채널에 올라갈 수 있고, 그걸 막는 장치가 없었다.
 * (계정이 하나뿐이라 문제가 안 드러났을 뿐이다.)
 *
 * 이 테이블은 **자격증명을 담지 않는다.** 로그인 세션(쿠키)은 워커 PC 로컬 파일에만
 * 있고, 여기는 "누구 것이고, 어느 세션 키를 쓰고, 살아있나"만 안다.
 *   - account_key : 세션 파일 경로에 쓰는 **불투명 키**. 네이버 아이디를 쓰지 않는다 —
 *                   경로·로그·DB 에 고객사 계정 아이디가 박히면 안 된다.
 *   - status      : active | session_expired | disabled
 *
 * 유일성은 (tenant_id, account_key) 로 잡는다. account_key 단독 PK 로 두면 고객사가
 * 늘었을 때 조용히 충돌한다(0021 에서 이미 같은 실수를 정리했다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

// 0014·0021 과 **같은** 술어여야 한다. 두 벌이 되면 한쪽만 고치게 된다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS naver_account (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      label          TEXT NOT NULL,
      account_key    TEXT NOT NULL,
      target         TEXT NOT NULL DEFAULT 'both',
      status         TEXT NOT NULL DEFAULT 'active',
      last_login_at  BIGINT,
      last_publish_at BIGINT,
      created_at     BIGINT NOT NULL,
      CONSTRAINT naver_account_key_uniq UNIQUE (tenant_id, account_key)
    );
  `);
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_naver_account_tenant') THEN
        EXECUTE 'ALTER TABLE naver_account ADD CONSTRAINT fk_naver_account_tenant
                   FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
      END IF;

      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_naver_account_tenant ON naver_account(tenant_id)';

      EXECUTE 'ALTER TABLE naver_account ENABLE ROW LEVEL SECURITY';
      EXECUTE 'ALTER TABLE naver_account FORCE  ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON naver_account';
      EXECUTE 'CREATE POLICY tenant_isolation ON naver_account
                 USING ${PREDICATE}
                 WITH CHECK ${PREDICATE}';
    END $$;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS naver_account`);
};

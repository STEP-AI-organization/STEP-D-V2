/* eslint-disable camelcase */
/**
 * 0033 — 자동 충전 정책 (워크스페이스별 1행).
 *
 * "잔액이 임계 이하로 떨어지면 저장 카드로 자동 충전." 판정 로직(shouldAutoTopup)은
 * credits.ts 에 이미 있고, 이 표는 그 **정책값**을 워크스페이스별로 담는다.
 *
 * ⚠️ **자동으로 진짜 카드가 긁힌다.** 그래서 상한이 스키마에 박혀 있다 — 파이프라인 버그로
 * 크레딧이 빨리 닳아도 하루/월 상한을 넘으면 멈춘다. 기본은 **꺼짐(enabled=false)**:
 * 사람이 켜고 상한을 정하기 전까지는 아무것도 자동으로 긁지 않는다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS auto_topup (
      tenant_id          TEXT PRIMARY KEY REFERENCES tenants(id),
      enabled            BOOLEAN NOT NULL DEFAULT FALSE,
      -- 잔액이 이 크레딧 이하로 떨어지면 충전한다.
      threshold_credits  INTEGER NOT NULL DEFAULT 300,
      -- 한 번에 충전할 크레딧(=분).
      topup_credits      INTEGER NOT NULL DEFAULT 600,
      -- 폭주 방어 상한. 이걸 넘으면 자동 충전을 멈추고 알린다.
      max_per_day        INTEGER NOT NULL DEFAULT 3,
      max_krw_per_month  INTEGER NOT NULL DEFAULT 200000,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by         TEXT NOT NULL DEFAULT ''
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE auto_topup ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
      EXECUTE 'ALTER TABLE auto_topup ENABLE ROW LEVEL SECURITY';
      EXECUTE 'ALTER TABLE auto_topup FORCE  ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON auto_topup';
      EXECUTE 'CREATE POLICY tenant_isolation ON auto_topup
                 USING ${PREDICATE}
                 WITH CHECK ${PREDICATE}';
    END $$;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS auto_topup;`);
};

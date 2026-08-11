/* eslint-disable camelcase */
/**
 * 0029 — 회사별 저장 카드(빌링키).
 *
 * 매번 카드를 다시 넣지 않고 버튼 한 번으로 충전하기 위한 표다.
 *
 * ## 카드 번호는 여기 없다
 * 브라우저 SDK 가 카드 정보를 포트원으로 **직접** 보내고, 우리는 결과인 빌링키 문자열만
 * 받는다. 그래서 이 표가 털려도 카드 번호는 없다. 다만 **빌링키 자체가 "이 카드로 긁을 수
 * 있는 권한"** 이라 RLS 를 건다 — 남의 회사 빌링키가 보이면 그 회사 카드를 긁을 수 있다.
 *
 * ## 회사당 한 장
 * `tenant_id` 가 PK 다. 여러 장을 관리하는 건 "어느 걸로 긁을지" 를 매번 정해야 해서
 * 화면과 사고 모두 복잡해진다. 바꾸려면 새로 등록해서 덮어쓴다.
 *
 * ## 해지는 지우지 않는다
 * `revoked_at` 을 찍는다 — 언제 등록하고 언제 뗐는지가 결제 분쟁에서 필요하다.
 * 다만 **빌링키 문자열은 해지 시 비운다**: 해지된 권한을 계속 들고 있을 이유가 없다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS billing_card (
      tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id),
      -- 포트원 빌링키. 해지하면 비운다(권한을 계속 들고 있지 않는다).
      billing_key  TEXT,
      -- 화면 표시용. 카드 번호는 애초에 못 받고 브랜드·끝 4자리만 온다.
      card_brand   TEXT,
      card_last4   TEXT,
      issued_by    TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at   TIMESTAMPTZ
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE billing_card ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
      EXECUTE 'ALTER TABLE billing_card ENABLE ROW LEVEL SECURITY';
      EXECUTE 'ALTER TABLE billing_card FORCE  ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON billing_card';
      EXECUTE 'CREATE POLICY tenant_isolation ON billing_card
                 USING ${PREDICATE}
                 WITH CHECK ${PREDICATE}';
    END $$;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS billing_card;`);
};

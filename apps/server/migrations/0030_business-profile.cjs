/* eslint-disable camelcase */
/**
 * 0030 — 회사 사업자정보 (거래명세서의 "공급받는 자").
 *
 * ## tenants 에 넣지 않는 이유
 * `tenants` 는 0단계(회사 정지 실효화) 이후 **세션 검증마다 조인된다**. 인보이스에서만
 * 쓰는 칸 여섯 개를 거기 붙이면 매 요청이 조금씩 무거워진다. 1:1 별도 표로 둔다.
 *
 * ## 상호는 tenants.name 과 다를 수 있다
 * 화면에서 부르는 이름("한국방송")과 등기상 상호("주식회사 한국방송공사")가 다르다.
 * 문서에는 **상호**가 들어가야 하므로 따로 받는다.
 *
 * 사업자등록번호는 **숫자만** 저장한다(표시할 때만 하이픈). 같은 번호가 `123-45-67890` 과
 * `1234567890` 두 모양으로 들어오면 중복 검사도 대조도 안 된다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS business_profile (
      tenant_id     TEXT PRIMARY KEY REFERENCES tenants(id),
      biz_name      TEXT NOT NULL,              -- 상호(법인명) · tenants.name 과 다를 수 있다
      biz_no        TEXT NOT NULL,              -- 사업자등록번호 · **숫자 10자리만**
      ceo_name      TEXT NOT NULL DEFAULT '',   -- 대표자
      address       TEXT NOT NULL DEFAULT '',   -- 사업장 주소
      biz_type      TEXT NOT NULL DEFAULT '',   -- 업태
      biz_item      TEXT NOT NULL DEFAULT '',   -- 종목
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      updated_by    TEXT NOT NULL DEFAULT '',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 숫자만 10자리인지 DB 에서도 못박는다 — 애플리케이션을 우회해 들어오는 경로가 생겨도
  // 하이픈 섞인 값이 저장되지 않게.
  pgm.sql(`
    DO $$ BEGIN
      ALTER TABLE business_profile ADD CONSTRAINT business_profile_bizno_digits
        CHECK (biz_no ~ '^[0-9]{10}$');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      EXECUTE 'ALTER TABLE business_profile ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
      EXECUTE 'ALTER TABLE business_profile ENABLE ROW LEVEL SECURITY';
      EXECUTE 'ALTER TABLE business_profile FORCE  ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON business_profile';
      EXECUTE 'CREATE POLICY tenant_isolation ON business_profile
                 USING ${PREDICATE}
                 WITH CHECK ${PREDICATE}';
    END $$;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS business_profile;`);
};

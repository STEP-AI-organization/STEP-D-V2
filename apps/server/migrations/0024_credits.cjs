/* eslint-disable camelcase */
/**
 * 0024 — 선불 크레딧 원장. **크레딧 1개 = 분석 1분** (2026-08-11 확정).
 *
 * 결제 방식이 구독(빌링키)에서 **선불 크레딧 + 일반결제**로 바뀌었다. 이게 규정 문제를
 * 통째로 없앤다 — 빌링키는 "정기적 구독"으로 제한되는데(계획 §4-3) 사용량 기반 변동금액은
 * 거기 안 맞았다. 선불은 결제 시점에 금액이 확정돼 있으니 그 충돌이 사라진다.
 *
 * **잔액을 컬럼으로 캐시하지 않는다.** 진실은 원장 합계다. 캐시 컬럼은 언젠가 어긋나고,
 * 돈에서 어긋난 숫자는 조용히 틀린 채로 굴러간다. 게이트를 저장 안 하는 것과 같은 이유다.
 *
 * `delta` 부호로 방향을 나눈다: 충전 +, 사용 −. 정정도 반대 부호 행으로 넣는다
 * (회계 원장의 관례). 그래서 이 표도 **append-only** 다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      -- 크레딧 증감. 충전 +, 사용 −. 1 크레딧 = 분석 1분.
      delta       INTEGER NOT NULL,
      -- topup(충전) | usage(사용) | grant(무상 지급) | adjust(정정) | refund(환불)
      reason      TEXT NOT NULL,
      media_id    TEXT,
      -- 충전이면 포트원 paymentId. 결제와 원장을 잇는 유일한 끈이다.
      payment_id  TEXT,
      -- 실제로 받은 금액(원). 충전 행에만 있다. 크레딧 단가 변경 이력이 여기 남는다.
      amount_krw  INTEGER,
      note        TEXT NOT NULL DEFAULT '',
      actor       TEXT NOT NULL DEFAULT '',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 'topup:{paymentId}' · 'usage:{mediaId}' — 웹훅 재전송·워커 재시도에도 한 번만.
      dedupe_key  TEXT UNIQUE
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_credit_tenant_at ON credit_ledger(tenant_id, occurred_at DESC);`);

  /**
   * 충전 시도. 결제창을 띄우기 **전에** 우리가 먼저 만든다 —
   * paymentId 를 우리가 정해야 멱등이 성립하고, 결제 결과를 대조할 기준이 생긴다.
   * **브라우저가 알려주는 금액을 믿지 않는다**: 여기 적힌 금액과 포트원 조회 결과가
   * 일치할 때만 크레딧을 올린다.
   */
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS credit_topup (
      payment_id   TEXT PRIMARY KEY,          -- 우리가 만든 값. 멱등키.
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      credits      INTEGER NOT NULL,          -- 충전될 크레딧(=분)
      amount_krw   INTEGER NOT NULL,          -- 청구 금액
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed|canceled
      requested_by TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at   TIMESTAMPTZ
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_topup_tenant ON credit_topup(tenant_id, created_at DESC);`);

  for (const t of ["credit_ledger", "credit_topup"]) {
    pgm.sql(`
      DO $$
      BEGIN
        EXECUTE 'ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
        EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
        EXECUTE 'CREATE POLICY tenant_isolation ON ${t}
                   USING ${PREDICATE}
                   WITH CHECK ${PREDICATE}';
      END $$;
    `);
  }

  // 원장은 고쳐 쓰지 못한다. 정정은 반대 부호 행으로.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'credit_ledger is append-only (attempted %) — 정정은 반대 부호 행으로', TG_OP;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`DROP TRIGGER IF EXISTS trg_credit_ledger_append_only ON credit_ledger;`);
  pgm.sql(`
    CREATE TRIGGER trg_credit_ledger_append_only
      BEFORE UPDATE OR DELETE ON credit_ledger
      FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_credit_ledger_append_only ON credit_ledger;`);
  pgm.sql(`DROP FUNCTION IF EXISTS credit_ledger_append_only();`);
  pgm.sql(`DROP TABLE IF EXISTS credit_topup;`);
  pgm.sql(`DROP TABLE IF EXISTS credit_ledger;`);
};

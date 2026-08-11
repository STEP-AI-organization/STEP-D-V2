/* eslint-disable camelcase */
/**
 * 0023 — 과금 원장 (docs/plans/active/billing-portone-plan.md §2, 구현 순서 2단계).
 *
 * PG: **포트원(PortOne) 중계 + KG이니시스**(2026-08-11 계약 완료).
 *
 * **정산 근거라서 런타임 암묵 생성이 아니라 마이그레이션에 명시한다.** 이 리포는 일부
 * 테이블을 코드가 런타임에 만들지만(queue.ts·db-pg.ts), 돈이 걸린 표는 그러면 안 된다 —
 * "언제 어떤 모양이었는지"를 되짚을 수 없다.
 *
 * ⚠️ 테넌트 스코프가 표마다 다르다:
 *   plans        전역 — 요금제 정의는 워크스페이스마다 다르지 않다. RLS 없음.
 *   나머지 넷    테넌트 — 남의 워크스페이스 사용량·인보이스·API 키가 보이면 안 된다.
 *                0021 과 **같은 정책 문자열**로 RLS 를 건다.
 *
 * **`usage_events.dedupe_key` 가 이 설계의 핵심 안전장치다.** 워커는 재시도·중복 큐잉이
 * 있는 구조라(job_queue 가 지수 백오프로 최대 5회) 과금 기록이 멱등이 아니면
 * **한 번 분석하고 세 번 청구**하는 사고가 난다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** 테넌트 스코프 표. 0021 과 같은 술어를 쓴다 — 두 벌이 되면 한쪽만 고치게 된다. */
const TENANT_TABLES = ["subscriptions", "usage_events", "invoices", "api_keys"];

const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // 요금제 정의 — 전역. **가격은 넣지 않는다**: 단가·플랜 정액이 아직 미결이라
  // (계획 §8) 임의의 숫자를 심으면 그게 사실인 것처럼 굳는다. 사람이 채운다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS plans (
      id                  TEXT PRIMARY KEY,             -- 'free' | 'starter' | 'pro' | 'ent_kbs'
      display_name        TEXT NOT NULL,
      monthly_krw         INTEGER NOT NULL DEFAULT 0,
      included_min        INTEGER NOT NULL DEFAULT 0,
      overage_krw_per_min INTEGER,                      -- NULL = 초과 시 차단(청구가 아니라 거부)
      seats               INTEGER,
      meta                JSONB NOT NULL DEFAULT '{}'   -- volume tier · 최소 커밋 등
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   TEXT PRIMARY KEY,
      tenant_id            TEXT NOT NULL REFERENCES tenants(id),
      plan_id              TEXT NOT NULL REFERENCES plans(id),
      status               TEXT NOT NULL,               -- trialing|active|past_due|canceled
      period_start         TIMESTAMPTZ NOT NULL,
      period_end           TIMESTAMPTZ NOT NULL,
      -- 포트원 빌링키. ⚠️ 빌링키는 "정기적 구독"으로 제한된다(§4-3) — 매달 금액이 달라지는
      -- 종량 청구를 여기로 긁지 말 것. 정액분만 빌링키, 초과분은 인보이스 별도 경로.
      billing_key          TEXT,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);`);

  // 사용량 원장 — append-only. 절대 UPDATE/DELETE 하지 않는다(감사 로그와 같은 이유).
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      kind        TEXT NOT NULL,            -- 'analyze_minutes' | 'clip_render' | 'publish'
      quantity    NUMERIC NOT NULL,         -- 분석은 분
      media_id    TEXT,
      job_id      TEXT,
      cost_krw    NUMERIC,                  -- 우리 원가(실측). 마진 감시용 — 청구액이 아니다
      source      TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'api'
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 'analyze:{mediaId}' — 재시도해도 한 번만 쌓인다. 이게 없으면 중복 청구가 난다.
      dedupe_key  TEXT UNIQUE
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_usage_tenant_at ON usage_events(tenant_id, occurred_at DESC);`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS invoices (
      id           TEXT PRIMARY KEY,        -- inv_xxx
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      period_start TIMESTAMPTZ NOT NULL,
      period_end   TIMESTAMPTZ NOT NULL,
      subtotal_krw INTEGER NOT NULL,
      vat_krw      INTEGER NOT NULL,
      total_krw    INTEGER NOT NULL,
      status       TEXT NOT NULL,           -- draft|open|paid|failed|void
      lines        JSONB NOT NULL DEFAULT '[]',
      payment_id   TEXT,                    -- 포트원 paymentId
      issued_at    TIMESTAMPTZ,
      paid_at      TIMESTAMPTZ,
      -- 오프라인 이체 후 수동 paid 처리한 사람. (c) 경로를 빼면 엔터프라이즈 계약을 못 받는다(§4-4).
      paid_by      TEXT
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, period_start DESC);`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,        -- ak_xxx
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      name         TEXT,
      -- sha256(raw). **평문은 발급 순간에만 1회 노출**하고 저장하지 않는다.
      key_hash     TEXT NOT NULL,
      prefix       TEXT NOT NULL,           -- 'stepd_live_ab12' — 화면 식별용
      scopes       TEXT[] NOT NULL DEFAULT '{}',
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_hash ON api_keys(key_hash);`);

  // 테넌트 격리 — 0021 과 같은 방식. 새 표를 만들 때마다 이걸 빼먹으면 격리 밖이다.
  for (const t of TENANT_TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        EXECUTE 'ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)';
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

  // 사용량 원장은 고쳐 쓰지 못하게 막는다 — gate_audit 과 같은 이유.
  // 정정이 필요하면 반대 부호의 행을 새로 넣는다(회계 원장의 관례).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION usage_events_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'usage_events is append-only (attempted %) — 정정은 반대 부호 행으로', TG_OP;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`DROP TRIGGER IF EXISTS trg_usage_events_append_only ON usage_events;`);
  pgm.sql(`
    CREATE TRIGGER trg_usage_events_append_only
      BEFORE UPDATE OR DELETE ON usage_events
      FOR EACH ROW EXECUTE FUNCTION usage_events_append_only();
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_usage_events_append_only ON usage_events;`);
  pgm.sql(`DROP FUNCTION IF EXISTS usage_events_append_only();`);
  pgm.sql(`DROP TABLE IF EXISTS api_keys;`);
  pgm.sql(`DROP TABLE IF EXISTS invoices;`);
  pgm.sql(`DROP TABLE IF EXISTS usage_events;`);
  pgm.sql(`DROP TABLE IF EXISTS subscriptions;`);
  pgm.sql(`DROP TABLE IF EXISTS plans;`);
};

/* eslint-disable camelcase */
/**
 * 0018 — 플랫폼 관리자(superadmin) 감사 로그
 *
 * superadmin 은 이 시스템에서 **가장 위험한 권한**이다. 테넌트 격리(0014 RLS)를 합법적으로
 * 우회하는 유일한 통로이기 때문이다. 그래서 권한을 만드는 것과 **그 사용을 기록하는 것**을
 * 같은 마이그레이션에 넣는다 — 나중에 붙이면 안 붙는다.
 *
 * 기록 원칙
 *   · 남의 테넌트를 **읽기만 해도** 남긴다. 유출 사고에서 정작 알고 싶은 건 "누가 봤나"다.
 *   · `reason` 은 선택이 아니라 라우트가 강제한다(방송사 계약에서 요구받기 쉬운 형태).
 *   · RLS 대상이 아니다 — 전 테넌트 횡단 기록이라 특정 테넌트에 속하지 않는다.
 *     대신 조회 라우트가 superadmin 만 열어준다.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id            BIGSERIAL PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_email   TEXT NOT NULL,
      action        TEXT NOT NULL,          -- tenant.list · tenant.view · tenant.create · user.suspend …
      target_tenant TEXT,                   -- 대상 테넌트 (없으면 플랫폼 전역 작업)
      target_id     TEXT,                   -- 대상 리소스 id (사용자·잡 등)
      reason        TEXT,
      detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip            TEXT,
      at            BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant ON admin_audit(target_tenant);
  `);
};

exports.down = false;

/* eslint-disable camelcase */
/**
 * 0015 — 로그인: 사용자 · 세션 · 초대
 *
 * 결정 (2026-08-10 사용자)
 *   · 이메일 + 비밀번호 (외부 IdP 의존 없음)
 *   · **초대제만** — 자유가입 없음. 모르는 사람이 테넌트에 들어올 경로를 아예 안 만든다.
 *
 * ⚠️ 이 세 테이블은 **RLS 대상이 아니다.**
 *   세션 조회가 "요청이 어느 테넌트인가"를 *결정하는* 단계다. 즉 테넌트 컨텍스트가
 *   정해지기 **전에** 읽어야 한다. 여기에 RLS 를 걸면 스코프가 없어 0행 → 아무도 못 로그인한다.
 *   대신 조회 조건 자체가 열쇠(세션 토큰 해시 · 초대 토큰 해시)라 스코프 없이도 안전하다.
 *   tenants 테이블을 RLS 에서 뺀 것과 같은 이유다(0014 참조).
 *
 * 비밀번호·토큰은 **평문으로 저장하지 않는다.**
 *   password_hash = scrypt (node:crypto 내장 — 네이티브 의존성 추가 없이 OWASP 권장 축에 든다)
 *   session/invite 토큰 = 원문은 발급 순간에만 나가고 DB 에는 sha256 만 남는다.
 *   DB 가 통째로 유출돼도 그것만으로 로그인할 수 없어야 한다.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      email         TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
      status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended
      created_at    BIGINT NOT NULL,
      last_login_at BIGINT
    );

    -- 이메일은 **전역 유일**로 둔다. 한 사람이 두 방송사에 동시에 속하는 경우는 지금 없고,
    -- 유일하지 않으면 로그인 시 "어느 테넌트로 들어갈지"를 물어야 해서 흐름이 복잡해진다.
    -- 나중에 필요해지면 users↔tenants 다대다 조인 테이블로 푼다.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,          -- sha256(원문). 원문은 저장하지 않는다
      user_id     TEXT NOT NULL REFERENCES users(id),
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      user_agent  TEXT,
      ip          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS invites (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member',
      token_hash  TEXT NOT NULL UNIQUE,
      invited_by  TEXT,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      accepted_at BIGINT,
      revoked_at  BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_tenant ON invites(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(LOWER(email));
  `);
};

exports.down = false;

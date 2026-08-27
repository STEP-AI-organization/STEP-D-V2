/* eslint-disable camelcase */
/**
 * 0045 — 쿠팡파트너스 계정 레지스트리 (회사마다 자기 법인 계정).
 *
 * ## 왜 필요한가
 *
 * 커머스 링크는 **커미션이 발생하는 기능**이다. 정산은 계정 단위로 이뤄지므로, 회사마다
 * 자기 법인 명의의 파트너스 계정을 써야 한다 — 한 계정에 subId 로 가르는 방식은 실적 보고서만
 * 갈릴 뿐 **돈은 그 계정 하나로 들어온다**(우리가 지급대행이 된다). 그래서 계정 자체를 가른다.
 *
 * 이 표가 없던 동안 `COUPANG_CDP_URL` 환경변수 하나로 계정이 못박혀 있었다. 고객사가 둘이
 * 되는 순간 A사 클립의 링크가 B사(혹은 우리) 계정으로 발급돼 **수익이 조용히 엉뚱한 곳에
 * 귀속된다.** 에러가 아니라 성공으로 보이는 종류라 아무도 눈치채지 못한다.
 * (0025 네이버 계정 레지스트리가 같은 이유로 생겼다 — "A사 클립이 B사 채널에 올라간다".)
 *
 * ## 세션은 여기 **암호화해서** 담는다
 *
 * 네이버(0025)는 세션을 워커 PC 로컬 파일에만 뒀다가 0031 에서 서버 보관(session_blob)을
 * 추가했다. 커머스는 처음부터 서버 보관으로 간다 — 워커 PC 앞에 가지 않아도 계정이 늘어나야
 * 하기 때문이다. 값은 `COMMERCE_SESSION_KEY` 로 AES-256-GCM 봉인하며, 키가 없으면 서버가
 * 저장 자체를 거부한다(평문 폴백 없음 · session-crypto.ts).
 *
 * ⚠️ **session_blob 은 어떤 SELECT 목록에도 넣지 않는다.** 한 번 들어가면 로그·응답·에러
 *    덤프 어디로든 샌다. 세션 쿠키는 그 계정의 전체 권한이다(실측: 쿠키만 주입해도 로그인됨).
 *
 * 유일성은 (tenant_id, provider) — 회사 하나에 제공자별 계정 하나. 계정을 여러 개 두고
 * 고르게 하면 "어느 계정으로 나갔는지" 를 사람이 매번 판단해야 하는데, 그건 수익 귀속
 * 문제라 실수하면 안 되는 자리다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

// 0014·0021·0025 와 **같은** 술어여야 한다. 두 벌이 되면 한쪽만 고치게 된다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

// ⚠️ 이 배열 형태를 지킬 것 — `rls-access.test.ts` 가 마이그레이션에서 RLS 표 목록을 **걷어서**
//    "스코프 없는 풀(getRawPool)로 만지지 않는가" 를 검사한다. 표 이름을 SQL 안에만 적으면
//    그 검사에서 빠져 무방비가 된다(0025 naver_account 가 그 상태다).
const TABLES = ["commerce_account"];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS commerce_account (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      provider           TEXT NOT NULL DEFAULT 'coupang',
      label              TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'active',
      session_blob       TEXT,
      session_updated_at BIGINT,
      last_issued_at     BIGINT,
      created_at         BIGINT NOT NULL,
      CONSTRAINT commerce_account_provider_uniq UNIQUE (tenant_id, provider)
    );
  `);
  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
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

// 되돌리면 격리가 사라지고, 무엇보다 **고객사 세션이 담긴 표**가 통째로 날아간다.
/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS commerce_account`);
};

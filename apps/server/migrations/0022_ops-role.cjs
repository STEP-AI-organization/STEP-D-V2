/* eslint-disable camelcase */
/**
 * 0022 — 운영 역할(방송 업무 권한) 컬럼. 워크스페이스 역할과 **별도 축**이다.
 *
 * users.role  = 워크스페이스 관리 권한 (owner/admin/member/superadmin)
 * users.ops_role = 방송 업무 권한 (editor/cp/pd/vendor · FLOWS F9)
 *
 * 하나로 합치면 반드시 이런 사람이 생긴다: **워크스페이스 owner 인 외주 편집자.**
 * 계정을 자기가 만들었으니 owner 인데 방송 권한은 vendor 여야 한다.
 * 축이 하나면 그 사람에게 배포 버튼이 열린다. (2026-08-11 결정)
 *
 * 기본값은 editor 다 — 가장 넓은 cp 로 시작하면 초대받은 사람이 곧바로 배포를 누를 수 있다.
 * 기존 사용자도 editor 로 들어간다. 첫 owner 는 아래에서 cp 로 올린다(그 조직에서 판단을
 * 내리는 사람이라 화면이 잠겨 있으면 아무 일도 못 한다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS ops_role TEXT NOT NULL DEFAULT 'editor';
  `);
  // 모르는 값이 들어오면 애플리케이션이 vendor 로 좁히지만, DB 에서도 한 번 막는다.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_ops_role_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_ops_role_check
          CHECK (ops_role IN ('editor','cp','pd','vendor'));
      END IF;
    END $$;
  `);
  // 기존 워크스페이스 소유자는 cp 로 (초대 기본값과 같은 규칙).
  pgm.sql(`UPDATE users SET ops_role = 'cp' WHERE role = 'owner' AND ops_role = 'editor';`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ops_role_check;`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS ops_role;`);
};

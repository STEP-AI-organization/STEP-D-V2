/* eslint-disable camelcase */
/**
 * 0040 — owner 의 송출 권한(ops_role) 재백필.
 *
 * 0022 가 같은 백필을 했지만 **그 시점에 있던 행만** 대상이었다. 그 뒤에 만든 워크스페이스의
 * owner 는 컬럼 기본값 'editor' 로 들어갔고, editor 는 배포 권한이 없어서(ops-role.ts)
 * `/api/distributions/publish` 가 항상 403 이었다. 게다가 이 값을 바꾸는 경로가 제품에
 * 하나도 없어서(어드민에도 없음) DB 를 직접 고치는 것 말고는 복구할 방법이 없었다 —
 * 첫 유료 고객 워크스페이스가 "배포 버튼이 안 눌리는" 상태로 열릴 뻔했다.
 *
 * 같은 커밋에서 코드도 고쳤다: createUser 가 defaultOpsRoleFor(role) 로 값을 넣고,
 * PATCH /api/workspace/members/:id 가 opsRole 을 받는다. 이 마이그레이션은 **이미 만들어진**
 * 행을 구제하는 1회성 백필이다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'users'
                   AND column_name = 'ops_role') THEN
        UPDATE users SET ops_role = 'cp' WHERE role = 'owner' AND ops_role = 'editor';
      END IF;
    END $$;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = () => {
  // 되돌리지 않는다 — 권한을 뺏는 방향이라 사고만 만든다. 필요하면 사람이 화면에서 바꾼다.
};

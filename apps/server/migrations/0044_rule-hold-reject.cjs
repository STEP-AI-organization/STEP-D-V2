/**
 * 승인 대기 건 **거부(reject)** — rule_hold 에 rejected_at/rejected_by 를 추가한다.
 *
 * 왜: 자동배포의 승인 대기(rule_hold · released_at IS NULL)는 지금까지 **승인(해제)** 만
 * 가능했다. 승인하면 다음 순방에 다시 잡혀 게시된다. 그런데 "이건 내보내지 마" 를 표현할
 * 방법이 없어, 거부하고 싶은 건도 승인 큐에 남거나 승인할 수밖에 없었다(사용자 2026-08-21:
 * "승인대기 있는거 거부도 가능해야해").
 *
 * 설계: **released_at 과 별개 상태**로 둔다. released_at 을 쓰면 hasReleasedHold 가 참이 되어
 * approve_first 게이트를 통과해 **게시되어 버린다**(거부의 정반대). rejected_at 은 그와 무관하게,
 *  - openHolds/isHeldAwaitingHuman 에서 제외되고(승인 큐에서 사라짐),
 *  - 순방이 isRejectedHold 로 보고 그 (규칙·영상)을 **재선정·게시하지 않고 건너뛴다.**
 * 둘 다 NULL 이면 종전과 동일(대기). 되돌림(down)은 컬럼 제거.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rule_hold
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rejected_by TEXT;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE rule_hold
      DROP COLUMN IF EXISTS rejected_at,
      DROP COLUMN IF EXISTS rejected_by;
  `);
};

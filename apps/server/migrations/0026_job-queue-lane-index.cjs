/* eslint-disable camelcase */
/**
 * 0026 — 레인 워커의 클레임 인덱스.
 *
 * 클레임 쿼리는 이렇게 생겼다:
 *   WHERE status='pending' AND runAfter <= $1 AND attempts < maxAttempts
 *     AND type = ANY($2)              ← 레인 필터
 *   ORDER BY runAfter ASC, createdAt ASC
 *
 * 그런데 기존 인덱스는 `(status, runafter)` 뿐이라 **type 이 인덱스에 없다.** 레인 워커는
 * pending 을 runAfter 순으로 훑으며 자기 타입을 골라내야 한다. 큐가 작을 땐 티가 안 나지만
 * 프로덕션 job_queue 는 8만 건 규모라, 분석 잡이 수천 건 밀려 있으면 **네이버·GEBD 워커가
 * 자기 잡 하나를 찾으려고 남의 잡을 계속 훑는다.**
 *
 * 증상이 "왜 잡을 늦게 집지?" 로만 나타나고 원인이 안 보이는 종류다 — 레인을 나눈 이유가
 * 서로 굶기지 않으려는 것이었는데, 인덱스가 없으면 그 효과가 절반만 난다.
 *
 * 기존 `(status, runafter)` 는 지운다 — 새 인덱스가 그 접근 경로를 포함하지 않지만,
 * 레인 없이(단일 워커) 도는 경우를 위해 **남겨둔다.** 두 경로가 다 있어야 한다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // 선두 컬럼이 type 이어야 레인 필터가 인덱스로 걸린다.
  // status 를 그다음에 두는 이유: pending 은 전체의 일부라 선택도가 높다.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_claim_type
      ON job_queue (type, status, runafter)
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_job_queue_claim_type`);
};

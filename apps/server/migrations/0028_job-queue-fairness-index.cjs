/* eslint-disable camelcase */
/**
 * 0028 — 큐 공정성 정렬용 인덱스 (다회사 5단계).
 *
 * `claimJobInner` 의 정렬 1순위가 "그 회사가 마지막으로 잡을 집힌 시각"이 됐다:
 *
 *   ORDER BY COALESCE((SELECT MAX(s.lockedAt) FROM job_queue s
 *                       WHERE s.tenant_id = q.tenant_id AND s.lockedAt IS NOT NULL), 0) ASC,
 *            q.runAfter ASC, q.createdAt ASC
 *
 * 이 상관 서브쿼리가 후보 행마다 돈다. 인덱스가 없으면 큐가 커질수록 **잡을 집는 것 자체가**
 * 느려지고, 그건 파이프라인 전체가 느려지는 것과 같다.
 *
 * `(tenant_id, lockedAt DESC)` 부분 인덱스 — `lockedAt IS NOT NULL` 조건과 정확히 맞고,
 * 아직 안 집힌 행(대다수)은 인덱스에 아예 안 들어가서 작게 유지된다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_tenant_locked
      ON job_queue (tenant_id, lockedAt DESC)
      WHERE lockedAt IS NOT NULL;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_job_queue_tenant_locked;`);
};

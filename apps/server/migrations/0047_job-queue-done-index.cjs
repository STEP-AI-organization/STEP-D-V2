/* eslint-disable camelcase */
/**
 * 0047 — 완료 잡 조회용 인덱스.
 *
 * `lastDoneJobAt`(queue.ts)은 `WHERE type = $1 AND dedupeKey = $2 AND status = 'done'` 로
 * 묻는데, 기존 dedupe 유니크 인덱스는 **`status IN ('pending','running')` 부분 인덱스**라
 * (0001_baseline) 이 쿼리가 쓸 수 있는 인덱스가 하나도 없었다 — 매 호출이 job_queue 전체를
 * 훑는다.
 *
 * 실측(2026-08-31): job_queue **43,231행 / 21MB**, `seq_scan` 누적 **294,618회**.
 * 이 쿼리는 채널 스윕 1회당 신선 영상 수(~150회)만큼 불린다 — 기동당 힙 리드 수 GB.
 *
 * ⚠️ 이 인덱스는 **done 행에만** 건다(부분 인덱스). 전체에 걸면 pending/running 이 계속
 * 뒤집히는 테이블에 쓰기 비용만 늘고, 정작 이 쿼리는 done 만 본다.
 *
 * `updatedat DESC` 를 포함하는 이유: 쿼리가 `MAX(updatedAt)` 이라 인덱스만으로 끝난다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_done_lookup
      ON job_queue (type, dedupeKey, updatedAt DESC)
      WHERE status = 'done' AND dedupeKey IS NOT NULL;
  `);
};

/** 되돌려도 기능은 같다 — 같은 쿼리가 느려질 뿐이다. */
/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_job_queue_done_lookup;`);
};

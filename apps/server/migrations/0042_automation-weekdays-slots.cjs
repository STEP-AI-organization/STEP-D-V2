/* eslint-disable camelcase */
/**
 * 0042 — 자동배포 규칙에 **발행 요일**과 **발행 시각 슬롯** 추가.
 *
 * 지금까지 규칙이 표현할 수 있는 시간은 "활동 시간창(기본 9~22시) 안에서 하루 할당량이
 * 찰 때까지" 뿐이었다. 그래서 "월화수목금 17:00·20:00·22:00 에 한 건씩" 같은 편성은
 * 표현 자체가 불가능했고, 화면이 그런 걸 받아도 **실제로는 다른 시각에 나갔다.**
 *
 *   weekdays : ISO 요일 배열 [1..7] (1=월 … 7=일). NULL·빈배열 = 매일 (기존 동작).
 *   slots    : KST 벽시계 "HH:MM" 배열. NULL·빈배열 = 슬롯 없음 (기존 동작 = 할당량 방식).
 *
 * 둘 다 **NULL 이 기존 동작**이라 기존 규칙은 이 마이그레이션으로 아무것도 달라지지 않는다.
 * 0038·0032·0041 과 같은 스타일(JSONB 로 얹기 — upsert 가 컬럼을 몰라도 조용히 죽지 않는다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule ADD COLUMN IF NOT EXISTS weekdays JSONB;`);
  pgm.sql(`ALTER TABLE automation_rule ADD COLUMN IF NOT EXISTS slots JSONB;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule DROP COLUMN IF EXISTS weekdays;`);
  pgm.sql(`ALTER TABLE automation_rule DROP COLUMN IF EXISTS slots;`);
};

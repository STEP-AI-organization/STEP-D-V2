/* eslint-disable camelcase */
/**
 * short-source-map-segment — 매칭 구간의 LEARN 입력(자막·장면요약·감정·훅)을 보관.
 *
 * 왜 여기에 두나: 이 값들은 매핑 1건과 정확히 1:1이고(같은 구간을 설명하는 것),
 * 매핑이 지워지면 같이 무의미해진다. 별도 테이블로 빼면 조인만 늘고 얻는 게 없다.
 *
 * 왜 필요한가: LEARN 프롬프트가 "롱폼 구간의 자막 + 장면/감정"을 요구하는데
 * `/api/lab/match/export`가 그 자리를 null로 비워 두고 있었다. core/segment.py가
 * 구간별 Gemini 1회 호출로 채우고, 그 결과를 여기에 적재한다.
 *
 * NON-DESTRUCTIVE: 순수 추가(ADD COLUMN IF NOT EXISTS).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE short_source_map ADD COLUMN IF NOT EXISTS segTranscript TEXT;`);
  pgm.sql(`ALTER TABLE short_source_map ADD COLUMN IF NOT EXISTS segSummary TEXT;`);
  pgm.sql(`ALTER TABLE short_source_map ADD COLUMN IF NOT EXISTS segEmotion TEXT;`);
  pgm.sql(`ALTER TABLE short_source_map ADD COLUMN IF NOT EXISTS segHook TEXT;`);
  pgm.sql(`ALTER TABLE short_source_map ADD COLUMN IF NOT EXISTS segAt BIGINT;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE short_source_map DROP COLUMN IF EXISTS segAt;`);
  pgm.sql(`ALTER TABLE short_source_map DROP COLUMN IF EXISTS segHook;`);
  pgm.sql(`ALTER TABLE short_source_map DROP COLUMN IF EXISTS segEmotion;`);
  pgm.sql(`ALTER TABLE short_source_map DROP COLUMN IF EXISTS segSummary;`);
  pgm.sql(`ALTER TABLE short_source_map DROP COLUMN IF EXISTS segTranscript;`);
};

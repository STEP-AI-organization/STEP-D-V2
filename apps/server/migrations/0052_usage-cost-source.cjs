/**
 * 원가가 **실측인지 추정인지** 구분한다 (`usage_events.cost_source` · `cost_detail`).
 *
 * 없어서 난 문제 (2026-09-03 실측): 원장은 `cost_krw` 를 `분 × 상수 19` 로 쌓고 있었다.
 * 그런데 정본 원가는 분당 ₩13.3 이다(2026-08-19 beat_annot flash-lite 전환 이후 ·
 * docs/ops/how-it-works.md §4). 상수만 한 세대 뒤처져서 30일 원장이 ₩14,806 —
 * **실제보다 43% 부풀린 값**으로 마진을 보고하고 있었다. 숫자가 하나뿐이라
 * 그게 실측인지 상수인지 구분할 방법조차 없었다.
 *
 * 이제 core 가 회차마다 남기는 `usage.json`(토큰·받아쓰기 시간 실측, 재시도분 누적)을
 * 읽어 넣고 `cost_source='measured'` 로 표시한다. 파일이 없는 옛 회차·덤프 실패는
 * `'estimated'` 로 남아 **섞이지 않는다** — 대시보드가 "실측 N건 중 M건" 을 말할 수 있다.
 *
 * `cost_detail` 은 벤더별 내역(geminiKrw·externalKrw·byModel·external). "왜 올랐나" 를
 * 원본 아티팩트까지 되짚지 않고 답하기 위한 것이다.
 *
 * 둘 다 NULL 허용 — 기존 행은 소급하지 않는다. **모르는 걸 안다고 칠하면 안 된다.**
 * 옛 행의 cost_krw 는 상수 곱이지만, 어느 세대 상수인지 지금은 확정할 수 없다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS cost_source TEXT,
      ADD COLUMN IF NOT EXISTS cost_detail JSONB;
  `);
  // "실측 비중" 집계를 받쳐 준다. 기간 필터와 함께 도는 질의라 occurred_at 을 같이 묶는다.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_usage_cost_source
      ON usage_events (cost_source, occurred_at DESC);
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_usage_cost_source;`);
  pgm.sql(`ALTER TABLE usage_events DROP COLUMN IF EXISTS cost_detail;`);
  pgm.sql(`ALTER TABLE usage_events DROP COLUMN IF EXISTS cost_source;`);
};

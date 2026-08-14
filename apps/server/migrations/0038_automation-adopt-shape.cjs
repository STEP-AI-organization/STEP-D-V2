/* eslint-disable camelcase */
/**
 * 0038 — 자동배포 규칙에 채택 형태(방향·AI 리프레임) 저장
 *
 * 왜: 수동 채택은 다이얼로그에서 방향(가로/세로)과 AI 리프레임을 사람이 고르는데(8023f6a),
 * 자동 순방은 고를 사람이 없다 — 규칙에 미리 담아 둔다. 값 체계는 수동 채택과 동일:
 *   orientation: 'portrait' | 'landscape' | NULL(기존처럼 추천 kind 로 결정)
 *   reframe:     'ai' | 'none' | NULL — 'ai' 는 세로형(portrait)일 때만 의미가 있다
 * 0032 와 같은 실컬럼 방식 — JSONB 에 숨기면 upsert 가 컬럼을 몰라 조용히 유실된다(0032 의 교훈).
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE automation_rule
      ADD COLUMN IF NOT EXISTS orientation TEXT,
      ADD COLUMN IF NOT EXISTS reframe     TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule
    DROP COLUMN IF EXISTS orientation, DROP COLUMN IF EXISTS reframe;`);
};

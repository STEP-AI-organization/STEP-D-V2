/**
 * 자동배포 확장 (사용자 요구 2026-08-12):
 *   - 규칙 하나 = 여러 프로그램 × 여러 채널 (program_ids · channels JSONB)
 *   - 하루 할당량(daily_quota, 채널당)을 채울 때까지 순방마다 배포
 *   - 활동 시간창 (active_start~active_end 시, KST · 기본 9~22)
 *   - 렌더 템플릿·레이아웃 (template_id · layout) — 코드에는 있었는데 upsert 가 컬럼이
 *     없어 조용히 유실되던 것을 이번에 실컬럼로.
 *   - rule_run.account_key — 채널별 하루 할당량 집계용 ("youtube:UCxxx" 형식).
 *
 * 기존 단수 컬럼(program_id·platform·account_id)은 그대로 둔다 — 구 규칙 호환 +
 * UNIQUE 제약의 기준. 다중 값은 JSONB 가 정본이고, 코드가 "배열 있으면 배열, 없으면
 * 단수 폴백"으로 읽는다.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE automation_rule
      ADD COLUMN IF NOT EXISTS template_id  TEXT,
      ADD COLUMN IF NOT EXISTS layout       JSONB,
      ADD COLUMN IF NOT EXISTS program_ids  JSONB,
      ADD COLUMN IF NOT EXISTS channels     JSONB,
      ADD COLUMN IF NOT EXISTS daily_quota  INTEGER NOT NULL DEFAULT 3,
      ADD COLUMN IF NOT EXISTS active_start INTEGER NOT NULL DEFAULT 9,
      ADD COLUMN IF NOT EXISTS active_end   INTEGER NOT NULL DEFAULT 22;
  `);
  pgm.sql(`
    ALTER TABLE rule_run
      ADD COLUMN IF NOT EXISTS account_key TEXT;
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rule_run_quota ON rule_run(rule_id, account_key, at DESC);`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule
    DROP COLUMN IF EXISTS template_id, DROP COLUMN IF EXISTS layout,
    DROP COLUMN IF EXISTS program_ids, DROP COLUMN IF EXISTS channels,
    DROP COLUMN IF EXISTS daily_quota, DROP COLUMN IF EXISTS active_start,
    DROP COLUMN IF EXISTS active_end;`);
  pgm.sql(`ALTER TABLE rule_run DROP COLUMN IF EXISTS account_key;`);
};

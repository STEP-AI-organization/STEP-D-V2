/* eslint-disable camelcase */
/**
 * 자동 배포 규칙 + 실행 로그 + 보류 큐 (FLOWS F6).
 *
 * `rule_run` 은 **자동 실행 전용 로그**다. 사람이 누른 배포와 같은 목록에 섞지 않는다
 * (F6 실행 로그) — 섞이면 "이거 내가 한 거야 자동이야"를 못 가린다.
 *
 * `rule_hold` 가 F6 Invariant 의 실체다: 보류된 건은 **사람이 확정해야** 다음 순방에
 * 다시 잡힌다. 행이 남아 있는 동안은 게이트가 열려도 자동이 밀어내지 않는다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS automation_rule (
      id          TEXT PRIMARY KEY,
      program_id  TEXT NOT NULL,
      platform    TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      media_kind  TEXT NOT NULL DEFAULT 'both',      -- short | clip | both
      criterion   TEXT NOT NULL DEFAULT 'score80',   -- score80 | score85 | top3
      gate_policy TEXT NOT NULL DEFAULT 'hold_on_issue', -- approve_first | hold_on_issue
      -- window 는 Postgres 예약어라 컬럼명으로 못 쓴다(윈도우 함수 문법과 충돌).
      time_window TEXT NOT NULL DEFAULT '수시',
      enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 같은 프로그램 → 같은 채널 규칙이 둘이면 같은 영상이 두 번 나간다.
      UNIQUE (program_id, platform, account_id)
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rule_run (
      id        BIGSERIAL PRIMARY KEY,
      at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      rule_id   TEXT,
      clip_id   TEXT,
      -- published | recorded | media_created | held | failed | skipped
      result    TEXT NOT NULL,
      detail    TEXT NOT NULL DEFAULT ''
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rule_run_at ON rule_run(at DESC);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rule_run_rule ON rule_run(rule_id, at DESC);`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rule_hold (
      rule_id     TEXT NOT NULL,
      clip_id     TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      held_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 사람이 확정한 기록. 이게 채워져야 다음 순방에 다시 잡힌다.
      released_by TEXT,
      released_at TIMESTAMPTZ,
      PRIMARY KEY (rule_id, clip_id)
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rule_hold_open ON rule_hold(rule_id) WHERE released_at IS NULL;`);

  // 전역 일시정지 같은 한 줄짜리 설정.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS automation_setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS automation_setting;`);
  pgm.sql(`DROP TABLE IF EXISTS rule_hold;`);
  pgm.sql(`DROP TABLE IF EXISTS rule_run;`);
  pgm.sql(`DROP TABLE IF EXISTS automation_rule;`);
};

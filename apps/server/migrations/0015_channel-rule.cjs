/* eslint-disable camelcase */
/**
 * 채널별 업로드 규칙 (FLOWS F4-2 · README §10).
 *
 * 지금까지 규칙은 코드 상수(RENDER_PRESETS 3종)뿐이었다. 그건 "배포처 유형"의 기본값이지
 * **연결된 계정 하나하나의 규칙**이 아니다. 같은 YouTube 라도 본채널과 숏폼 전용 채널은
 * 길이 상한도 제목 규칙도 다르다.
 *
 * 계정 자체(토큰·연결 상태)는 youtube_channels / meta_accounts / tiktok_accounts 가 갖고,
 * 여기는 **운영 규칙만** 둔다. 계정이 끊겨도 규칙은 남아 있어야 재연결 뒤 다시 쓴다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS channel_rule (
      platform          TEXT NOT NULL,          -- youtube | instagram | facebook | tiktok | smr
      account_id        TEXT NOT NULL,          -- 연결 계정 식별자
      label             TEXT NOT NULL DEFAULT '',
      role              TEXT NOT NULL DEFAULT 'main',   -- main | sub | shorts_only | affiliate
      max_sec           INTEGER,                -- NULL = 길이 제한 없음
      aspect            TEXT NOT NULL DEFAULT 'any',    -- 9:16 | 16:9 | any
      title_prefix      TEXT NOT NULL DEFAULT '',
      hashtag_template  TEXT NOT NULL DEFAULT '',
      tone_preset       TEXT NOT NULL DEFAULT '기본',
      privacy           TEXT NOT NULL DEFAULT 'public',
      schedule_window   TEXT NOT NULL DEFAULT '',
      enabled           BOOLEAN NOT NULL DEFAULT true,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform, account_id)
    );
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS channel_rule;`);
};

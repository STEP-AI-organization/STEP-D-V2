/* eslint-disable camelcase */
/**
 * search-events — 검색·선택 로그 (§8, core/search_log.py의 프로덕션 테이블판).
 *
 * 검색을 붙이기 전에 설계해야 하는 로그. 나중에 붙이면 몇 달치가 날아간다. 검색·선택
 * 로그는 하루 수십 개씩 쌓여 채널 성과 학습보다 빠른 루프를 만든다 — 특히 편집자가
 * 조정한 경계값(before→after)이 하이라이트 컷 지점의 지도(supervised) 신호다.
 *
 * 이벤트 4종(하나의 query_id로 묶임): search · click · export · boundary_adjust.
 * 공통 컬럼(event·query_id·ts·actor·role)은 1급으로, 이벤트별 페이로드(parsed·candidates·
 * before/after·delta…)는 data JSONB로. core/search_log.py의 JSONL 스키마와 1:1 대응한다
 * (actor = 거기의 "user" — pg 예약어라 이름만 바꿈).
 *
 * NON-DESTRUCTIVE: CREATE TABLE/INDEX IF NOT EXISTS. down은 테이블만 드랍.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS search_events (
      id          BIGSERIAL PRIMARY KEY,
      event       TEXT NOT NULL,                 -- search|click|export|boundary_adjust
      query_id    TEXT NOT NULL,                 -- 한 검색 세션을 묶는 키
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor       TEXT,                          -- 사용자 식별 (search_log.py의 "user")
      role        TEXT,
      -- 조인·필터용 1급 컬럼 (선택 이벤트)
      segment_id  TEXT,                          -- click/export/boundary_adjust
      rank        INTEGER,                       -- click (노출 순위)
      query       TEXT,                          -- search (원문)
      -- 이벤트별 페이로드: search→{parsed,candidates,result_count}, boundary→{before,after,delta_*}
      data        JSONB NOT NULL DEFAULT '{}'
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_events_qid   ON search_events(query_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_events_event ON search_events(event);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_events_ts    ON search_events(ts);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_events_seg   ON search_events(segment_id);`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS search_events;`);
};

/* eslint-disable camelcase */
/**
 * search-log — 검색·선택·경계조정 로그 (core/search_log.py §8 스키마의 프로덕션 테이블).
 *
 * core/search_log.py 헤더가 경고한 그대로다: "검색을 붙이기 **전에** 설계해야 하는 로그.
 * 나중에 붙이면 몇 달치가 날아간다." 스키마는 거기 있었는데 호출부가 0건이라 아무것도
 * 안 쌓이고 있었다. JSONL(로컬 오프라인 검증용)을 테이블로 옮기고 필드명은 그대로 둔다.
 *
 * 이벤트 4종 (하나의 query_id 로 묶임):
 *   search           쿼리 원문 + 파싱 결과 + 노출 후보(순위 포함)   ← Recall 평가·클릭 조인
 *   click            클릭한 구간
 *   export           실제 반출한 구간
 *   boundary_adjust  조정한 경계값 (before→after)                  ← 가장 중요
 *
 * boundary_adjust 는 검색 경로뿐 아니라 **에디터 경로**에서도 들어온다(AI 가 제안한
 * [start,end] 를 사람이 어디로 옮겼나 = 컷 지점의 지도 신호). 그래서 search_log.py 에
 * 없던 clip_id·media_id·source 컬럼을 더한다. query_id 는 에디터 경로에선 NULL 이다.
 *
 * NON-DESTRUCTIVE: CREATE TABLE/INDEX IF NOT EXISTS. down 은 테이블만 드랍.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS search_events (
      id            BIGSERIAL PRIMARY KEY,
      event         TEXT NOT NULL,          -- search | click | export | boundary_adjust
      ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
      query_id      TEXT,                   -- 4종을 묶는 키 (에디터 경로는 NULL)
      source        TEXT,                   -- 'search' | 'editor' — 이벤트가 어디서 왔나
      user_id       TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT '',
      -- search
      query         TEXT,
      parsed        JSONB,                  -- LLM 쿼리 파서 결과 (인물·장면유형·기간·semantic)
      candidates    JSONB,                  -- [{rank, segment_id, score, lex, vec}] 노출 후보
      result_count  INTEGER,
      -- click / export / boundary_adjust 공통
      segment_id    TEXT,
      media_id      TEXT,
      clip_id       TEXT,
      rank          INTEGER,
      start_sec     DOUBLE PRECISION,
      end_sec       DOUBLE PRECISION,
      -- boundary_adjust
      before_start  DOUBLE PRECISION,
      before_end    DOUBLE PRECISION,
      after_start   DOUBLE PRECISION,
      after_end     DOUBLE PRECISION,
      delta_start   DOUBLE PRECISION,
      delta_end     DOUBLE PRECISION
    );
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_ev_event_ts ON search_events(event, ts DESC);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_ev_query    ON search_events(query_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_ev_segment  ON search_events(segment_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_ev_media    ON search_events(media_id);`);
  // 학습 추출용 — boundary_adjust 만 시간순으로 훑는 쿼리가 주 사용처
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_ev_badj     ON search_events(ts DESC) WHERE event = 'boundary_adjust';`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS search_events;`);
};

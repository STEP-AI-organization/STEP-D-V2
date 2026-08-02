/* eslint-disable camelcase */
/**
 * search-segments — 자연어 영상 검색엔진의 인덱스 테이블 (pgvector).
 *
 * core/index_segments.py가 beats.json 등 파이프라인 부산물에서 뽑은 검색 세그먼트를
 * 여기에 적재한다(content.analyze 완료 후). 검색 단위 = beat(영상 전체 커버, 쇼츠 편향
 * 없음). 필터(프로그램·스코프·회차·방영일·인물·장면유형)는 컬럼으로, 의미검색은 벡터로
 * — 필터 먼저 좁히고 벡터로 랭킹한다. 60분 1편 ≈ 세그먼트 수백 개라 pgvector로 충분.
 *
 * 벡터는 세그먼트당 2개(emb_dialogue·emb_summary): 하나만 두면 대사·장소·감정이 뭉개진다.
 * 차원 768 = core.embed DIM (text-multilingual-embedding-002 기본) 과 일치해야 한다.
 * 하이브리드 랭킹의 키워드 축은 pg_trgm(언어무관 부분일치 — 한국어에 robust)로 잡는다.
 *
 * rights(출연자·음원·PPL·스포일러)·scope(기수/시즌)는 아직 파이프라인 신호 전이라 대부분
 * NULL로 들어온다 — 컬럼은 지금 만들어 두고(스키마 마이그레이션 재발 방지) 채우는 건 이후.
 *
 * NON-DESTRUCTIVE: CREATE EXTENSION/TABLE/INDEX IF NOT EXISTS. down은 테이블만 드랍(공유
 * 익스텐션 vector·pg_trgm은 남긴다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS vector;`);
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS search_segments (
      segment_id      TEXT PRIMARY KEY,
      media_id        TEXT NOT NULL,
      program_id      TEXT,
      genre           TEXT,
      -- 스코프 (인물 ID 유효범위 · 온보딩 설정에서 주입 예정)
      scope_type      TEXT,
      scope_id        TEXT,
      episode         TEXT,
      aired_at        DATE,
      -- 구간
      start_sec       DOUBLE PRECISION NOT NULL,
      end_sec         DOUBLE PRECISION NOT NULL,
      duration_sec    DOUBLE PRECISION,
      -- 인물 (구조 필터 — 벡터에 녹이지 않는다)
      characters      JSONB NOT NULL DEFAULT '[]',
      speakers        JSONB NOT NULL DEFAULT '[]',
      -- 분류
      scene_type      TEXT,
      hook            TEXT,
      highlight_score DOUBLE PRECISION,
      is_short        BOOLEAN NOT NULL DEFAULT FALSE,
      -- 권리·스포일러 (결과에 상태를 달려면 채워야 함)
      rights          JSONB NOT NULL DEFAULT '{}',
      -- 텍스트 레이어 (검색의 실질 8할)
      dialogue        TEXT,
      chyron          TEXT,
      summary         TEXT,
      search_text     TEXT GENERATED ALWAYS AS (
                        coalesce(dialogue,'') || ' ' || coalesce(chyron,'') || ' ' || coalesce(summary,'')
                      ) STORED,
      -- 벡터 (768 = core.embed DIM)
      emb_dialogue    vector(768),
      emb_summary     vector(768),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 메타데이터 필터 인덱스 — 필터가 검색 품질의 대부분을 결정한다
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_media   ON search_segments(media_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_program ON search_segments(program_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_genre   ON search_segments(genre);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_scope   ON search_segments(scope_type, scope_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_episode ON search_segments(episode);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_aired   ON search_segments(aired_at);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_short   ON search_segments(is_short);`);
  // 인물 필터 — characters @> '["영철"]' 컨테인먼트
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_chars   ON search_segments USING GIN (characters jsonb_path_ops);`);
  // 키워드 축 (하이브리드) — trgm 부분일치 (한국어 robust)
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_trgm    ON search_segments USING GIN (search_text gin_trgm_ops);`);
  // 의미 축 — HNSW 코사인 (대사·요약 각각)
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_emb_dia ON search_segments USING hnsw (emb_dialogue vector_cosine_ops);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_search_seg_emb_sum ON search_segments USING hnsw (emb_summary vector_cosine_ops);`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS search_segments;`);
  // 공유 익스텐션(vector·pg_trgm)은 다른 곳이 쓸 수 있으니 남긴다.
};

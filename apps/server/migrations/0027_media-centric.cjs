/* eslint-disable camelcase */
/**
 * 0027 — 미디어 중심 정규화 1단계: 새 테이블 생성 + entities 백필.
 *
 * 설계: docs/plans/active/db-normalization-media-centric.md
 *
 * **`entities` 를 지우지 않는다.** 새 테이블을 나란히 만들고 데이터를 복사만 한다.
 * 라우트 118개가 아직 entities 를 읽고 있어서, 지금 지우면 되돌릴 수 없다.
 * 읽는 곳이 0이 된 뒤 별도 마이그레이션으로 지운다(설계 문서 5단계).
 *
 * media 는 **이미 있는 테이블**이라 새로 만들지 않고 컬럼만 더한다:
 *   kind            role 의 새 이름. master | clip | shorts | highlight
 *                   (role 을 바로 rename 하지 않는다 — 기존 코드가 role 을 읽는다.
 *                    둘 다 유지하고 트리거 없이 앱에서 kind 를 쓰게 옮긴 뒤 role 을 지운다.)
 *   source_media_id 파생물이 어느 마스터에서 나왔나
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

// 0014·0021·0025 와 **같은** 술어여야 한다. 두 벌이 되면 한쪽만 고치게 된다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

/** 새 테이블을 테넌트 격리에 편입한다(0014 와 동일 절차). */
function scope(pgm, table) {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${table}_tenant') THEN
        EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT fk_${table}_tenant
                   FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
      END IF;
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)';
      EXECUTE 'ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY';
      EXECUTE 'ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${table}';
      EXECUTE 'CREATE POLICY tenant_isolation ON ${table}
                 USING ${PREDICATE} WITH CHECK ${PREDICATE}';
    END $$;
  `);
}

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── program ────────────────────────────────────────────────────────────────
  // episode_count 는 컬럼으로 두지 않는다 — 손으로 갱신하면 어긋난다. episode 카운트로 뽑는다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS program (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      title         TEXT NOT NULL,
      section       TEXT,
      target_age    TEXT,
      status        TEXT NOT NULL DEFAULT 'airing',
      owner         TEXT,
      ended_date    TEXT,
      rights_until  TEXT,
      rights_note   TEXT,
      pipeline_genre TEXT,
      moods         JSONB,
      profile       JSONB,
      smr           JSONB,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT
    );
  `);
  scope(pgm, "program");

  // ── episode ────────────────────────────────────────────────────────────────
  // program_title 을 넣지 않는다 — 조인으로 얻는다. 사본을 두면 프로그램명을 바꿔도 안 따라온다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS episode (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      program_id        TEXT REFERENCES program(id) ON DELETE SET NULL,
      episode_number    INTEGER,
      broad_date        TEXT,
      target_age        TEXT,
      source_channel_id TEXT,
      source_video_id   TEXT,
      pipeline          JSONB,
      created_at        BIGINT NOT NULL,
      updated_at        BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_episode_program ON episode(program_id);
  `);
  scope(pgm, "episode");

  // ── media 확장 ─────────────────────────────────────────────────────────────
  // role 은 남겨둔다. 기존 코드가 읽고 있어서 지금 rename 하면 전부 깨진다.
  pgm.sql(`
    ALTER TABLE media ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE media ADD COLUMN IF NOT EXISTS source_media_id TEXT;
    UPDATE media SET kind = role WHERE kind IS NULL;
    CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
    CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_media_id);
  `);

  // ── media_edit — 파생물(clip·shorts·highlight) 공통 확장 ────────────────────
  // PK 가 media_id 다: 파생물은 미디어이지 별개 객체가 아니다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS media_edit (
      media_id            TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      tenant_id           TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      episode_id          TEXT,
      title               TEXT,
      title_line1         TEXT,
      title_line2         TEXT,
      synopsis            TEXT,
      tags                JSONB,
      status              TEXT,
      rendered            BOOLEAN NOT NULL DEFAULT FALSE,
      render_revision     TEXT,
      render_preset       TEXT,
      aspect_ratio        TEXT,
      start_time          DOUBLE PRECISION,
      end_time            DOUBLE PRECISION,
      hook_time_sec       DOUBLE PRECISION,
      hook_intro_caption  TEXT,
      target_channel      TEXT,
      source_recommendation_id TEXT,
      editor_state        JSONB,
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_media_edit_episode ON media_edit(episode_id);
  `);
  scope(pgm, "media_edit");

  // ── recommendation ─────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS recommendation (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      episode_id        TEXT,
      kind              TEXT,
      title             TEXT,
      start_time        DOUBLE PRECISION,
      end_time          DOUBLE PRECISION,
      hook_time_sec     DOUBLE PRECISION,
      hook_quote        TEXT,
      hook_intro_caption TEXT,
      hook_strength     DOUBLE PRECISION,
      appeal            TEXT,
      payoff            TEXT,
      edit_note         TEXT,
      completeness      DOUBLE PRECISION,
      score100          DOUBLE PRECISION,
      status            TEXT,
      tags              JSONB,
      channel_scores    JSONB,
      thumbnail_candidates JSONB,
      selected_thumbnail_id TEXT,
      adopted_media_id  TEXT REFERENCES media(id) ON DELETE SET NULL,
      created_at        BIGINT NOT NULL,
      updated_at        BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_recommendation_episode ON recommendation(episode_id);
  `);
  scope(pgm, "recommendation");

  // ── distribution — 배포 이력 ────────────────────────────────────────────────
  // 지금은 clip.distributions JSONB 배열이라 채널별 조회·집계가 안 된다.
  // UNIQUE(media_id, channel): 같은 채널에 두 줄이 생기면 어느 게 진짜인지 알 수 없다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS distribution (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      media_id      TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      channel       TEXT NOT NULL,
      account_id    TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      url           TEXT,
      error         TEXT,
      scheduled_at  BIGINT,
      published_at  BIGINT,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT,
      CONSTRAINT distribution_media_channel_uniq UNIQUE (media_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_distribution_media ON distribution(media_id);
    CREATE INDEX IF NOT EXISTS idx_distribution_channel ON distribution(channel, status);
  `);
  scope(pgm, "distribution");

  // ── 백필 (entities → 새 테이블) ─────────────────────────────────────────────
  // tenant_id 를 명시적으로 옮긴다. DEFAULT 에 맡기면 마이그레이션 컨텍스트의 테넌트가
  // 들어가 **전부 한 테넌트로 뭉친다.**
  pgm.sql(`
    INSERT INTO program (id, tenant_id, title, section, target_age, status, created_at)
    SELECT e.id, e.tenant_id,
           COALESCE(e.data->>'title', '(제목 없음)'),
           e.data->>'section', e.data->>'targetAge',
           COALESCE(e.data->>'status', 'airing'),
           COALESCE((e.data->>'createdAt')::bigint, 0)
      FROM entities e WHERE e.kind = 'program'
    ON CONFLICT (id) DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO episode (id, tenant_id, program_id, episode_number, broad_date, target_age,
                         source_channel_id, source_video_id, pipeline, created_at)
    SELECT e.id, e.tenant_id, e.data->>'programId',
           NULLIF(e.data->>'episodeNumber','')::int,
           e.data->>'broadDate', e.data->>'targetAge',
           e.data->>'sourceChannelId', e.data->>'sourceVideoId',
           e.data->'pipeline',
           COALESCE((e.data->>'createdAt')::bigint, 0)
      FROM entities e WHERE e.kind = 'episode'
    ON CONFLICT (id) DO NOTHING;
  `);
  // 클립은 **media 행이 있는 것만** 옮긴다. mediaId 가 없으면 아직 렌더 전이라
  // 파생 미디어가 존재하지 않는다 — media_edit 의 PK 를 만들 수 없다.
  pgm.sql(`
    INSERT INTO media_edit (media_id, tenant_id, episode_id, title, synopsis, tags, status,
                            rendered, render_revision, render_preset, aspect_ratio,
                            start_time, end_time, hook_time_sec, hook_intro_caption,
                            target_channel, source_recommendation_id, editor_state, created_at)
    SELECT e.data->>'mediaId', e.tenant_id, e.data->>'episodeId',
           e.data->>'title', e.data->>'synopsis', e.data->'tags', e.data->>'status',
           COALESCE((e.data->>'rendered')::boolean, false),
           e.data->>'renderRevision', e.data->>'renderPreset', e.data->>'aspectRatio',
           NULLIF(e.data->>'startTime','')::double precision,
           NULLIF(e.data->>'endTime','')::double precision,
           NULLIF(e.data->>'hookTimeSec','')::double precision,
           e.data->>'hookIntroCaption',
           e.data->>'targetChannel', e.data->>'sourceRecommendationId',
           e.data->'editorState',
           COALESCE((e.data->>'createdAt')::bigint, 0)
      FROM entities e
      JOIN media m ON m.id = e.data->>'mediaId'
     WHERE e.kind = 'clip'
    ON CONFLICT (media_id) DO NOTHING;
  `);
  // 파생물의 원본 연결 — 클립 엔티티가 알고 있던 sourceMediaId 를 media 로 옮긴다.
  pgm.sql(`
    UPDATE media m SET source_media_id = e.data->>'sourceMediaId'
      FROM entities e
     WHERE e.kind = 'clip' AND m.id = e.data->>'mediaId'
       AND e.data->>'sourceMediaId' IS NOT NULL AND m.source_media_id IS NULL;
  `);
  pgm.sql(`
    INSERT INTO recommendation (id, tenant_id, episode_id, kind, title, start_time, end_time,
      hook_time_sec, hook_quote, hook_intro_caption, hook_strength, appeal, payoff, edit_note,
      completeness, score100, status, tags, channel_scores, thumbnail_candidates,
      selected_thumbnail_id, created_at)
    SELECT e.id, e.tenant_id, e.data->>'episodeId', e.data->>'kind', e.data->>'title',
           NULLIF(e.data->>'startTime','')::double precision,
           NULLIF(e.data->>'endTime','')::double precision,
           NULLIF(e.data->>'hookTimeSec','')::double precision,
           e.data->>'hookQuote', e.data->>'hookIntroCaption',
           NULLIF(e.data->>'hookStrength','')::double precision,
           e.data->>'appeal', e.data->>'payoff', e.data->>'editNote',
           NULLIF(e.data->>'completeness','')::double precision,
           NULLIF(e.data->>'score100','')::double precision,
           e.data->>'status', e.data->'tags', e.data->'channelScores',
           e.data->'thumbnailCandidates', e.data->>'selectedThumbnailId',
           COALESCE((e.data->>'createdAt')::bigint, 0)
      FROM entities e WHERE e.kind = 'recommendation'
    ON CONFLICT (id) DO NOTHING;
  `);
  // 채택된 추천 → 결과 미디어 연결 (adoptedClipId 는 clip 엔티티 id 라 media 로 환산한다)
  pgm.sql(`
    UPDATE recommendation r SET adopted_media_id = c.data->>'mediaId'
      FROM entities e JOIN entities c ON c.kind = 'clip' AND c.id = e.data->>'adoptedClipId'
     WHERE e.kind = 'recommendation' AND r.id = e.id
       AND EXISTS (SELECT 1 FROM media m WHERE m.id = c.data->>'mediaId');
  `);
  // distributions JSONB 배열 → 행. 채널당 한 줄.
  pgm.sql(`
    INSERT INTO distribution (id, tenant_id, media_id, channel, status, url, published_at, created_at)
    SELECT e.id || ':' || (d->>'channel'), e.tenant_id, e.data->>'mediaId',
           d->>'channel', COALESCE(d->>'status', 'pending'), d->>'url',
           NULLIF(d->>'publishedAt','')::bigint,
           COALESCE((e.data->>'createdAt')::bigint, 0)
      FROM entities e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'distributions', '[]'::jsonb)) d
      JOIN media m ON m.id = e.data->>'mediaId'
     WHERE e.kind = 'clip' AND d->>'channel' IS NOT NULL
    ON CONFLICT (media_id, channel) DO NOTHING;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS distribution`);
  pgm.sql(`DROP TABLE IF EXISTS recommendation`);
  pgm.sql(`DROP TABLE IF EXISTS media_edit`);
  pgm.sql(`DROP TABLE IF EXISTS episode`);
  pgm.sql(`DROP TABLE IF EXISTS program`);
  pgm.sql(`ALTER TABLE media DROP COLUMN IF EXISTS kind`);
  pgm.sql(`ALTER TABLE media DROP COLUMN IF EXISTS source_media_id`);
};

/* eslint-disable camelcase */
/**
 * 0013 — 테넌트 격리 1단계: tenants 테이블 + 전 테이블 tenant_id 백필
 *
 * 왜 필요한가 (docs/plans/active/billing-portone-plan.md §6)
 *   지금 데이터 모델에는 소유자 개념이 없다. 외부 방송사를 받는 순간 A사가 B사의
 *   회차를 본다. 과금(포트원)보다 이게 먼저다 — 과금 주체 = 테넌트이기도 하다.
 *
 * 설계
 *   - **전 테이블에 tenant_id 를 denormalize 한다.** 파생 테이블(content_analysis,
 *     search_segments 등)도 부모를 조인하지 않고 단독으로 필터할 수 있어야 한다.
 *     조인으로 스코프를 잡으면 조인을 빼먹은 쿼리 하나가 곧 유출이다.
 *   - NOT NULL + DEFAULT 't_default'. 기존 데이터는 전부 기본 테넌트에 귀속된다.
 *     DEFAULT 를 두는 이유: 아직 tenant_id 를 안 넘기는 INSERT 가 남아 있어도
 *     **NULL(=무소속, 필터에서 사라짐)이 아니라 기본 테넌트로 떨어지게** 하기 위함이다.
 *     스코프 배선이 끝나면 후속 마이그레이션에서 DEFAULT 를 걷어낸다.
 *   - FK 는 걸되 ON DELETE 는 걸지 않는다. 테넌트 삭제는 데이터 삭제를 동반해야 하는
 *     별도 절차이지, CASCADE 로 조용히 일어날 일이 아니다.
 *
 * 비파괴: 컬럼 추가 + 인덱스뿐. 기존 컬럼·행을 건드리지 않는다.
 */

const TABLES = [
  // 루트 소유
  "entities",
  "media",
  "kv",
  "job_queue",
  "youtube_channels",
  "meta_accounts",
  "tiktok_accounts",
  "search_events",
  // 미디어 파생
  "content_analysis",
  "transcript",
  "search_segments",
  "episode_cast",
  // 프로그램 파생
  "program_cast",
  // 채널 파생
  "channel_videos",
  "channel_analytics",
  "video_stats",
  "video_analytics",
  "video_retention",
  "video_comments",
  "short_source_map",
  // 게이트(0012)
  "rights_issue",
  "rights_judgement",
  "gate_audit",
];

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'internal',   -- internal | web | api
      status        TEXT NOT NULL DEFAULT 'active',     -- active | suspended | closed
      billing_email TEXT,
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    );
  `);

  // 기본 테넌트 — 기존 데이터 전부의 귀속처. 지우면 안 된다.
  pgm.sql(`
    INSERT INTO tenants (id, name, kind)
    VALUES ('t_default', 'STEP D', 'internal')
    ON CONFLICT (id) DO NOTHING;
  `);

  for (const t of TABLES) {
    // 테이블 자체가 아직 없는 배포(런타임 부트스트랩 순서 차이)에서도 죽지 않게 방어한다.
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = current_schema() AND table_name = '${t}') THEN
          EXECUTE 'ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT ''t_default''';
          EXECUTE 'CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)';
          BEGIN
            EXECUTE 'ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_tenant
                     FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
          EXCEPTION WHEN duplicate_object THEN NULL;
          END;
        END IF;
      END $$;
    `);
  }
};

// 되돌리면 격리가 사라진다 — 라이브에서 실수로 내려가지 않게 막는다.
exports.down = false;

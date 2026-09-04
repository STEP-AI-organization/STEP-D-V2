/* eslint-disable camelcase */
/**
 * 0054 — 완전자동화의 **수집원**(수확할 유튜브 채널).
 *
 * ## 왜 필요한가
 *
 * 지금 자동화는 **사람이 영상을 하나씩 넣어야** 시작된다(업로드하거나 유튜브 URL 을 붙여넣거나).
 * 그 한 번이 매번 사람 몫이다. 이 표는 그 한 번을 없앤다 — "이 채널을 보고 있어라" 를 적어 두면
 * 수확기(`channel.harvest`)가 새 롱폼을 찾아 회차로 만든다.
 *
 * ## 배포 대상은 여기 없다 — 일부러다
 *
 * 어느 채널로 나갈지는 **자동배포 계획(`automation_rule`)이 이미 정한다**(프로그램 → 채널).
 * 여기에도 적으면 두 곳이 서로 다른 말을 하는 날이 오고, 그때 영상은 엉뚱한 채널로 나간다.
 * 그래서 수확기는 **프로그램까지만** 책임지고 그 뒤는 계획이 받는다.
 *
 * ## 커서를 두지 않는다
 *
 * 처음엔 "여기까지 처리했다" 는 커서(`cursor_published_at`)를 둘 생각이었다. 그런데 이미
 * 만든 회차가 `episode.sourceVideoId` 로 남아 있어서, **그 집합이 곧 커서다.** 두 벌을 두면
 * 반드시 어긋나고(커서는 옮겼는데 회차 생성이 실패한 경우 등), 어긋난 쪽이 조용히 이긴다.
 * 매번 다시 세는 비용은 채널당 최대 500행 스캔이라 무시할 만하다.
 *
 * ## 권리 게이트가 status 에 들어 있다
 *
 *   active   연결된 채널(우리가 OAuth 로 붙인 것) — 바로 돈다
 *   blocked  연결 안 된 채널 — **운영자가 승인해야** 돈다(`approved_by` 에 기록)
 *   paused   사람이 잠깐 멈춘 것
 *
 * 남의 채널 영상을 받아 재배포하는 것은 저작권 사고라, 기본을 "안 돎"으로 두고 승인을
 * 명시적 행위로 만든다. 실패 방향이 "안 돌아감" 이지 "몰래 돌아감" 이 아니게.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

// 0014·0021·0025·0045·0053 과 **같은** 술어여야 한다. 두 벌이 되면 한쪽만 고치게 된다.
const PREDICATE = `(tenant_id = current_setting(''app.tenant_id'', true)`
  + ` OR current_setting(''app.tenant_id'', true) = ''*'')`;

// ⚠️ 이 배열 형태를 지킬 것 — `rls-access.test.ts` 가 마이그레이션에서 RLS 표 목록을 걷어서
//    "스코프 없는 풀(getRawPool)로 만지지 않는가" 를 검사한다.
const TABLES = ["harvest_source"];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS harvest_source (
      id                    TEXT PRIMARY KEY,
      tenant_id             TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      -- 수확 대상 유튜브 채널(UC…). channel_videos 가 이 값으로 업로드를 쌓는다.
      source_channel_id     TEXT NOT NULL,
      -- 사람이 목록에서 알아볼 이름. 유튜브에서 바뀌어도 따라가지 않는다(표시용).
      source_channel_title  TEXT NOT NULL DEFAULT '',
      -- 이 채널의 영상이 들어갈 프로그램. 자동배포 계획이 이 프로그램을 보고 배포한다.
      program_id            TEXT NOT NULL,
      -- active | paused | blocked  (위 주석 참고)
      status                TEXT NOT NULL DEFAULT 'blocked',
      -- 연결 안 된 채널을 열어 준 운영자. 나중에 "누가 승인했나" 에 답할 근거다.
      approved_by           TEXT,
      -- 하루에 몇 편까지 집을지. 60분 1편 = 60크레딧이라 이 값이 곧 돈이다.
      daily_cap             INTEGER NOT NULL DEFAULT 2,
      -- 롱폼 판정 하한(초). 이보다 짧으면 숏폼으로 쓸 구간이 안 나온다.
      min_duration_sec      INTEGER NOT NULL DEFAULT 180,
      -- 과거 영상까지 소급할지. false 면 등록 시각 이후 업로드만 본다.
      backfill              BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at           BIGINT,
      created_at            BIGINT NOT NULL,
      -- 같은 채널을 두 번 등록하면 같은 영상이 두 번 수확된다. 회차·크레딧이 두 배가 된다.
      CONSTRAINT harvest_source_channel_uniq UNIQUE (tenant_id, source_channel_id)
    );
  `);

  for (const t of TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_${t}_tenant') THEN
          EXECUTE 'ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_tenant
                     FOREIGN KEY (tenant_id) REFERENCES tenants(id)';
        END IF;

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)';

        EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON ${t}';
        EXECUTE 'CREATE POLICY tenant_isolation ON ${t}
                   USING ${PREDICATE}
                   WITH CHECK ${PREDICATE}';
      END $$;
    `);
  }

  // 수확기가 매 순회마다 하는 질의 — "지금 돌려야 할 수집원". 상태로 먼저 걸러진다.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_harvest_source_due
      ON harvest_source(status, last_run_at);
  `);
};

// 되돌리면 "무엇을 보고 있었는지" 가 사라진다. 이미 만든 회차·영상은 남는다(그건 별개 표다).
/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS harvest_source`);
};

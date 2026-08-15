/* eslint-disable camelcase */
/**
 * 0039 — 연동 계정 테이블의 유일 제약을 **테넌트 포함**으로 다시 잡는다.
 *
 * 0021 이 asset_folder·channel_rule 등에 대해 고친 것과 같은 함정이 소셜 계정 테이블에
 * 남아 있었다. `youtube_channels.channelId` · `meta_accounts.pageId` ·
 * `tiktok_accounts.openId` · `instagram_accounts.igUserId` 가 전역 UNIQUE 라,
 * 워크스페이스 A 가 이미 연결한 채널을 B 가 연결하면 **B 에게는 보이지도 않는 행과 충돌**해
 * 실패한다(RLS 는 행을 숨길 뿐 유일 제약을 우회하지 못한다).
 *
 * 증상이 특히 나쁘다: 사용자는 OAuth 동의를 다 끝낸 뒤에야 "연결에 실패했습니다" 만 받고,
 * 화면에는 연결된 채널이 하나도 없다 — 중복이라는 안내조차 못 준다. 대행사·MCN 이 같은
 * 채널을 두 워크스페이스에서 다루거나, 데모 테넌트에 붙였던 채널을 실고객 워크스페이스로
 * 옮길 때 바로 걸린다.
 *
 * 제약 이름은 실제 DB 에 있는 것을 찾아 지운다 — 런타임 부트스트랩(db-pg.ts)이 만든
 * 자동 생성 이름(예: youtube_channels_channelid_key)과 마이그레이션이 만든 이름이 섞여 있다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** [테이블, 유일해야 하는 컬럼, 새 제약 이름] */
const KEYS = [
  ["youtube_channels", "channelid", "youtube_channels_tenant_channel_key"],
  ["meta_accounts", "pageid", "meta_accounts_tenant_page_key"],
  ["tiktok_accounts", "openid", "tiktok_accounts_tenant_open_key"],
  ["instagram_accounts", "iguserid", "instagram_accounts_tenant_iguser_key"],
];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  for (const [table, col, newName] of KEYS) {
    pgm.sql(`
      DO $$
      DECLARE c RECORD;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_schema = current_schema() AND table_name = '${table}') THEN
          RETURN;
        END IF;
        -- tenant_id 가 없으면(옛 부트스트랩) 여기서 손댈 게 없다 — 0014/0034 가 먼저다.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = '${table}'
                         AND column_name = 'tenant_id') THEN
          RETURN;
        END IF;

        -- 이 컬럼 하나로만 걸린 유일 제약을 전부 걷어낸다(이름이 환경마다 다르다).
        -- 정의 문자열로 찾는다 — conkey 를 풀어 비교하면 array_agg 가 name[] 을 내서
        -- text[] 와 타입이 안 맞는다(42883, 2026-08-15 실측).
        FOR c IN
          SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
           WHERE rel.relname = '${table}'
             AND con.contype = 'u'
             AND pg_get_constraintdef(con.oid) = 'UNIQUE (${col})'
        LOOP
          EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END LOOP;
        -- 제약이 아니라 인덱스로만 걸린 경우도 있다(CREATE UNIQUE INDEX).
        FOR c IN
          SELECT i.relname AS conname
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class t ON t.oid = x.indrelid
           WHERE t.relname = '${table}' AND x.indisunique AND NOT x.indisprimary
             AND pg_get_indexdef(x.indexrelid) LIKE '%(${col})'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = x.indexrelid)
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I', c.conname);
        END LOOP;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${newName}') THEN
          EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${newName} UNIQUE (tenant_id, ${col})';
        END IF;
      END $$;
    `);
  }
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  // 되돌리면 전역 UNIQUE 로 돌아가야 하는데, 그 사이 두 워크스페이스가 같은 채널을 연결했다면
  // 복원 자체가 불가능하다(충돌 행이 이미 있다). 제약을 지우는 데까지만 한다.
  for (const [table, , newName] of KEYS) {
    pgm.sql(`ALTER TABLE IF EXISTS ${table} DROP CONSTRAINT IF EXISTS ${newName}`);
  }
};

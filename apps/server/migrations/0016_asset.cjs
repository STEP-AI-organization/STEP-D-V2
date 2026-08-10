/* eslint-disable camelcase */
/**
 * 에셋 — 폴더 트리 + 파일 (FLOWS F8 · README §6).
 *
 * 폴더를 **행으로** 둔다. 파일 경로에서 유추하면 빈 폴더가 존재할 수 없는데,
 * "폴더를 먼저 만들고 나중에 채우는" 게 실제 작업 순서다.
 *
 * ⊘ 이름 변경 없음 · ⊘ 되돌리기 없음 (F8). 그래서 rename 컬럼도 삭제 이력 테이블도 없다 —
 * 되돌릴 수 없는 걸 되돌릴 수 있는 것처럼 보이게 하지 않는다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS asset_folder (
      path        TEXT PRIMARY KEY,            -- 정규화된 절대 경로 ('/a/b')
      parent      TEXT NOT NULL,               -- 부모 경로 ('/' 는 루트)
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_asset_folder_parent ON asset_folder(parent);`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS asset_file (
      id           TEXT PRIMARY KEY,
      folder       TEXT NOT NULL,              -- 소속 폴더 경로
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'other',  -- image|video|audio|font|other
      mime         TEXT NOT NULL DEFAULT '',
      size         BIGINT NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,              -- GCS 오브젝트 경로(또는 로컬 폴백)
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 같은 폴더에 같은 이름은 하나. 이름이 곧 참조라서 중복이 생기면 어느 쪽인지 모른다.
      UNIQUE (folder, name)
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_asset_file_folder ON asset_file(folder);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_asset_file_kind ON asset_file(kind);`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS asset_file;`);
  pgm.sql(`DROP TABLE IF EXISTS asset_folder;`);
};

/* eslint-disable camelcase */
/**
 * (programId, episodeNumber) 유일성 — FLOWS F1 ⊘ "같은 프로그램·같은 회차 번호로 재업로드 금지".
 *
 * 지금까지 회차 번호는 서버가 MAX+1 로 매겼다. 사람이 번호를 직접 입력하게 되면(F1 필수 3개
 * 중 하나) 같은 번호가 두 번 들어올 수 있고, 그러면 "회차 12"가 두 개인 채로 분석·배포가
 * 갈라진다. 라우트의 check-then-insert 로는 동시 요청을 못 막는다 — 유일 인덱스가 진짜 보증이다.
 *
 * ⚠️ 기존에 중복이 있으면 이 마이그레이션은 **실패한다.** 일부러 그렇게 뒀다:
 * 조용히 번호를 바꾸면 사람이 알던 회차 번호가 말없이 달라진다. 실패 시 아래 NOTICE 로
 * 어떤 (programId, episodeNumber) 가 겹치는지 찍히니, 그걸 보고 사람이 정하면 된다.
 * (2026-08-10 로컬 DB 기준 중복 0건)
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // 실패하기 전에 무엇이 걸리는지 먼저 찍는다.
  pgm.sql(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT data->>'programId' AS pid, data->>'episodeNumber' AS num, count(*) AS c
          FROM entities
         WHERE kind = 'episode' AND data->>'episodeNumber' IS NOT NULL
         GROUP BY 1, 2 HAVING count(*) > 1
      LOOP
        RAISE NOTICE '중복 회차: program=% episode=% (%건)', r.pid, r.num, r.c;
      END LOOP;
    END $$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_episode_program_number
      ON entities ((data->>'programId'), (data->>'episodeNumber'))
      WHERE kind = 'episode' AND data->>'episodeNumber' IS NOT NULL;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS uq_episode_program_number;`);
};

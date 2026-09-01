/* eslint-disable camelcase */
/**
 * 0048 — `entities` 조인 축 인덱스 (회차·프로그램).
 *
 * 지금까지 `entities` 인덱스는 `(kind, id)` 와 `tenant_id` 뿐이었다. 그런데 실제 질의는
 * **JSONB 안의 외래키**로 찾는다:
 *   · `kind='recommendation' AND data->>'episodeId' = $1`   (회차의 추천)
 *   · `kind IN ('recommendation','clip') AND data->>'episodeId' = $1`  (회차 재분석 정리)
 *   · `kind='episode' AND data->>'programId' = $1`          (프로그램의 회차)
 * 인덱스가 없으니 **매번 순차 스캔**이다.
 *
 * 실측(2026-09-01): entities 는 **415행인데 31MB** — 행 하나가 평균 75KB(editorState·분석
 * 결과가 JSONB 안에 통째로 들어간다). 즉 "행이 적으니 괜찮다" 가 아니라, 한 번 훑을 때마다
 * **31MB를 읽는다.** 고객사가 늘면 이 비용이 선형으로 커진다.
 *
 * ⚠️ **tenant_id 는 넣지 않는다** — 처음엔 넣으려 했는데 실측이 반대였다(2026-09-01).
 *    RLS 술어가 `tenant_id = current_setting(...) OR current_setting(...) = '*'` 라 **OR** 이고,
 *    OR 는 선행 컬럼 등치로 안 쓰인다. 프로덕션에서 두 형태를 만들어 `enable_seqscan=off` 로
 *    비교한 결과 비용이 (tenant,kind,ep) 10.99 vs (kind,ep) **10.19** 로, 빼는 쪽이 싸다.
 *    테넌트 격리는 힙 재검사에서 어차피 걸린다(RLS 는 그대로 강제된다).
 *
 * ⚠️ **지금은 플래너가 여전히 순차 스캔을 고른다** — 415행짜리 표에서는 그게 실제로 더 싸다.
 *    이 인덱스는 그 판단이 뒤집히는 시점(고객사가 늘어 행이 수만 개가 될 때)을 위한 것이고,
 *    **행이 적은 지금 만들어 두는 게 가장 싸다**(나중에 만들면 같은 작업을 부하 중에 한다).
 *
 * ⚠️ 부분 인덱스(`WHERE … IS NOT NULL`)로 만든다. 프로그램·회차 자체에는 그 키가 없어서
 *    NULL 행을 색인해 봐야 크기만 는다.
 *
 * 되돌려도 기능은 같다 — 같은 질의가 다시 느려질 뿐이다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_entities_episode
      ON entities (kind, (data->>'episodeId'))
      WHERE data->>'episodeId' IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_entities_program
      ON entities (kind, (data->>'programId'))
      WHERE data->>'programId' IS NOT NULL;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_entities_episode;
    DROP INDEX IF EXISTS idx_entities_program;
  `);
};

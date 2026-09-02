/**
 * 게시가 **어느 슬롯 몫인지** 기록한다 (`rule_run.slot_time`).
 *
 * 없어서 난 사고 (2026-09-02 ENA 실측): 계획이 `06:30 ×2` + `18:00 ×2` 인데 18시에 **4건이
 * 한꺼번에** 나갔다. 아침 몫이 저녁으로 넘어간 것이다.
 *
 * 원인은 한도 계산이 "오늘 몇 건 나갔나" 만 알고 **어느 슬롯 건인지**를 몰랐던 것:
 *   1차 순방: 게시 0건 → 06:30(2건) 포기 인정 → 한도 4−2=2 → 2건 게시
 *   2차 순방: 게시 2건 → `staleMissedSlots` 의 `if (publishedToday > 0) return 0` 이 걸려
 *             **포기분이 되살아나** 한도 4−0=4 → 2건 더 게시
 * 그 가드는 그 자체로는 옳았다(2026-08-26: "15시에 20개" 를 렌더 지연으로 소멸시키지 않으려고).
 * 진짜 문제는 게시와 슬롯의 연결이 없어서 **2건을 06:30 몫으로 오해**한 것이다.
 *
 * 이 컬럼이 그 연결을 만든다. 그러면 슬롯마다 창을 닫을 수 있다 —
 * 지나간 슬롯 몫은 소멸하고(다음 슬롯으로 안 넘어감), 배달이 늦어도 그 슬롯 몫은 안 사라진다.
 *
 * NULL 을 허용한다. **옛 기록과 슬롯 없는 계획(할당량 방식)이 NULL** 이고, 그 둘은
 * "슬롯 몫이 아님" 이라는 뜻이다 — 기본값을 박으면 없는 슬롯에 몫이 배정된 것처럼 보인다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rule_run
      ADD COLUMN IF NOT EXISTS slot_time TEXT;
  `);
  // 슬롯별 오늘 게시 수를 세는 질의(계획·계정·슬롯)를 받쳐 준다. 순방이 계획×채널마다
  // 부르므로 인덱스가 없으면 rule_run 전체를 훑는다 — 이 표는 계속 자란다.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_rule_run_slot
      ON rule_run (rule_id, account_key, slot_time, at DESC);
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_rule_run_slot;`);
  pgm.sql(`ALTER TABLE rule_run DROP COLUMN IF EXISTS slot_time;`);
};

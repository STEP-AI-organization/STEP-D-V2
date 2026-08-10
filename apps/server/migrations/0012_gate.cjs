/* eslint-disable camelcase */
/**
 * 게이트 도메인 — 권리·심의 이슈와 감사 로그 (FLOWS F3).
 *
 * 이 제품의 핵심이다. "게이트를 통과하지 않은 미디어는 **어떤 경로로도** 게시되지 않는다.
 * 관리자 권한도 우회 불가"(FLOWS.md:73).
 *
 * 설계 결정 둘:
 *
 * 1. **게이트 상태를 저장하지 않는다.** 진실은 `rights_issue` 행이고, 게이트는 판정할 때마다
 *    gate.ts 의 evaluateGate() 로 계산한다. clip JSONB 에 gate 필드를 캐시해 두면 누군가
 *    그 JSONB 를 덮어써서 통과시킬 수 있고, 그 순간 "어떤 경로로도"가 깨진다.
 *
 * 2. **"이슈 없음"은 행이 없는 상태가 아니라 판정 기록이다**(`rights_judgement`).
 *    이슈 0건과 아직 아무도 안 본 것은 다르다(F2 Invariant). 행이 없으면 `검수 대기`,
 *    판정 기록이 있고 미해결 이슈가 없으면 `통과`.
 *
 * `gate_audit` 는 append-only 다. UPDATE·DELETE 를 트리거로 막는다 — 감사 로그를
 * 고칠 수 있으면 감사 로그가 아니다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rights_issue (
      id           TEXT PRIMARY KEY,
      -- 이슈가 붙는 대상. episode(회차 전체) · recommendation(추천 구간) · clip(미디어)
      subject_type TEXT NOT NULL,
      subject_id   TEXT NOT NULL,
      -- music | portrait | ppl | cast_hold | brand_blur | vod_window (FLOWS.md:59)
      kind         TEXT NOT NULL,
      -- open(미해결) | conditional(조치하면 통과) | resolved(해제됨) | blocked(불가)
      resolution   TEXT NOT NULL DEFAULT 'open',
      -- 구간 이슈일 때의 초 단위 범위. NULL = 대상 전체.
      band_start   DOUBLE PRECISION,
      band_end     DOUBLE PRECISION,
      note         TEXT NOT NULL DEFAULT '',
      -- 등록/해제한 사람. 자동 판정이 없으므로 비어 있으면 안 된다(F3).
      actor        TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at  TIMESTAMPTZ,
      resolved_by  TEXT,
      -- 조건부 처리를 통과로 바꾼 근거 ("블러 처리 완료" 등). 없으면 통과로 못 바꾼다.
      resolution_note TEXT,
      -- 승계 원본 (추천 → 클립). 어느 이슈에서 내려왔는지 추적용.
      inherited_from  TEXT
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rights_issue_subject ON rights_issue(subject_type, subject_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_rights_issue_open ON rights_issue(subject_id) WHERE resolution <> 'resolved';`);

  // "이슈 없음"이라는 명시적 판정 (F2 Invariant — 미판정과 구분).
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rights_judgement (
      subject_type TEXT NOT NULL,
      subject_id   TEXT NOT NULL,
      actor        TEXT NOT NULL,
      judged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      note         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (subject_type, subject_id)
    );
  `);

  // 감사 로그 — 누가·언제·무엇을 근거로 (FLOWS.md:74).
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS gate_audit (
      id           BIGSERIAL PRIMARY KEY,
      at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      subject_type TEXT NOT NULL,
      subject_id   TEXT NOT NULL,
      -- issue.create | issue.resolve | issue.reopen | issue.delete | judge | gate.block | gate.pass
      action       TEXT NOT NULL,
      from_state   TEXT,
      to_state     TEXT,
      actor        TEXT NOT NULL,
      -- 근거. 사람이 적은 문장이거나, 시스템이 어떤 이슈를 보고 막았는지.
      basis        TEXT NOT NULL DEFAULT '',
      issue_id     TEXT
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gate_audit_subject ON gate_audit(subject_type, subject_id, at DESC);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gate_audit_at ON gate_audit(at DESC);`);

  // append-only 강제. 고칠 수 있는 감사 로그는 감사 로그가 아니다.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION gate_audit_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'gate_audit is append-only (attempted %)', TG_OP;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`DROP TRIGGER IF EXISTS trg_gate_audit_append_only ON gate_audit;`);
  pgm.sql(`
    CREATE TRIGGER trg_gate_audit_append_only
      BEFORE UPDATE OR DELETE ON gate_audit
      FOR EACH ROW EXECUTE FUNCTION gate_audit_append_only();
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_gate_audit_append_only ON gate_audit;`);
  pgm.sql(`DROP FUNCTION IF EXISTS gate_audit_append_only();`);
  pgm.sql(`DROP TABLE IF EXISTS gate_audit;`);
  pgm.sql(`DROP TABLE IF EXISTS rights_judgement;`);
  pgm.sql(`DROP TABLE IF EXISTS rights_issue;`);
};

/* eslint-disable camelcase */
/**
 * 0041 — 자동배포 규칙에 **썸네일 생성 방식** 저장
 *
 * 썸네일이 두 갈래가 됐다(사용자 확정 2026-08-16).
 *   ai    : 서사 기획 + 등록 인물 누끼 → 모델이 그린다. 잘 나오지만 **인물 등록이 선행**돼야
 *           하고, 캐스트가 안 채워진 아카이브 회차에서는 한 장도 못 만든다.
 *   frame : 실제 영상 프레임 한 장 + 자막. 인물 등록이 필요 없고 얼굴이 원본 그대로다.
 *
 * 무인 경로는 고를 사람이 없으니 규칙에 담아 둔다. NULL 이면 'frame'(안전한 쪽)으로 본다 —
 * 자동 경로에서 ai 를 기본으로 두면 캐스트 미등록 회차가 통째로 썸네일 없이 나간다.
 * 0038·0032 와 같은 실컬럼 방식(JSONB 에 숨기면 upsert 가 컬럼을 몰라 조용히 유실된다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule ADD COLUMN IF NOT EXISTS thumbnail_mode TEXT;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE automation_rule DROP COLUMN IF EXISTS thumbnail_mode;`);
};

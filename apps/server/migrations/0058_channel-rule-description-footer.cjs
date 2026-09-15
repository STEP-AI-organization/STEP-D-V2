/**
 * 채널 규칙 · 배포 설명 고정 문구 — 발행 직전, 생성(동적) 설명 아래·커머스 블록 위에 붙는다.
 *
 * 왜 **채널 단위**인가(프로그램 아님 · 사용자 결정 2026-09-15): 문구가 채널의 언어·플랫폼을
 * 따른다 — 인도네시아어 채널엔 "AI 자동 번역 자막 안내"를 인니어로, 인스타그램은 짧게,
 * 틱톡은 캡션 꼬리표 한 줄("(Sub Indo/terjemahan AI)"). 같은 프로그램이라도 채널마다 다르다.
 *
 * 저장된 설명 본문에 굽지 않고 발행 시점에 조립한다(커머스 대가성 문구와 같은 구조) —
 * 문구를 바꾸면 다음 발행부터 전부 새 문구, 사람이 실수로 지울 수도 없다.
 * 소비처: worker metaForChannel · updatemeta · naver (publish/description-footer.ts).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE channel_rule
      ADD COLUMN IF NOT EXISTS description_footer TEXT NOT NULL DEFAULT '';
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE channel_rule DROP COLUMN IF EXISTS description_footer;`);
};

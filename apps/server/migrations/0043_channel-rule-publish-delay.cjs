/**
 * 채널 규칙 · 공개 유예(분) — 자동 게시를 N분 비공개로 잡아뒀다 공개한다.
 *
 * 왜: 업로드 직후엔 유튜브의 HD 트랜스코딩이 안 끝나 있고(초기 시청자가 360p 를 본다),
 * 우리 워커도 **업로드가 끝난 뒤에** 커스텀 썸네일을 건다(worker.ts). 그 사이에 공개되면
 * 첫 노출이 저화질·기본 프레임 썸네일로 나간다 — 첫 노출 물량은 초기 시청 지표가 좌우하므로
 * 그게 그대로 손해다. 그래서 "완성된 상태로 첫 노출을 받게" 유예를 둔다.
 *
 * ⚠️ "유튜브가 영상을 이해할 시간을 준다"는 통설과는 다른 근거다. 제목·설명·태그는 게시
 * 시점에 읽히므로 묵힌다고 이해도가 오르지는 않는다 — 유예의 값은 **처리 완료**에 있다.
 *
 * 구현은 유튜브의 `status.publishAt`(예약)이다 — 유튜브가 private 로 잡아뒀다가 스스로
 * 공개한다. 우리가 N분 뒤 공개 API 를 부르는 방식은 워커가 죽으면 **영원히 비공개**로 남는
 * 실패 모드가 있어 쓰지 않는다.
 *
 * 기본 5분. 0 이면 즉시 공개(종전 동작). privacy 가 public 일 때만 의미가 있다 —
 * unlisted/private 목표에는 적용하지 않는다(publishAt 은 공개로 끝나므로 목표가 달라진다).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE channel_rule
      ADD COLUMN IF NOT EXISTS publish_delay_min INTEGER NOT NULL DEFAULT 5;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE channel_rule DROP COLUMN IF EXISTS publish_delay_min;`);
};

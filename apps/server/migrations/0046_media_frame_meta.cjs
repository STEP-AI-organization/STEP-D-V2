/**
 * 미디어 프레임 메타 — fps · 시작 타임코드 · 오디오 트랙 수.
 *
 * 왜: Premiere 플러그인이 STEP-D 추천 구간을 편집 타임라인에 **1프레임 오차 안에서** 꽂으려면
 * 세 값이 필요하다(추진안 2026-08-27 "서버에 FPS, 시작 타임코드, 오디오 스트림 수를 저장해
 * Premiere 원본과 1프레임 단위로 검증한다").
 *
 *  · fps          — 29.97DF / 25 / 23.976 이 섞이는 방송 소재에서 초↔프레임 환산의 유일한 근거.
 *                   지금까지는 probe 가 계산해 놓고 **버렸다**(렌더 스냅에서만 일회성으로 씀).
 *  · start_timecode — 방송 원본은 00:00:00:00 이 아니라 10:00:00:00 에서 시작하는 게 표준이다.
 *                   STEP-D 는 파일 0초 기준으로 일관되지만, Premiere·EDL 은 소스 타임코드
 *                   기준이라 이 오프셋을 모르면 편집자 화면에서 10시간 어긋난 자리를 가리킨다.
 *  · audio_streams — 방송 MXF 는 모노 8트랙이 흔하다. 정규화(mp4)가 몇 트랙을 어떻게 접었는지
 *                   추적하고, 원본과 대조할 때 쓴다.
 *
 * 전부 NULL 허용이 아니라 기본값을 둔다 — 옛 행은 "모른다"가 아니라 "안 쟀다"이고, 값이
 * 필요해지는 시점(플러그인 연결)에 재프로브로 채운다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE media
      ADD COLUMN IF NOT EXISTS fps REAL NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS start_timecode TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS audio_streams INTEGER NOT NULL DEFAULT 0;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE media
      DROP COLUMN IF EXISTS fps,
      DROP COLUMN IF EXISTS start_timecode,
      DROP COLUMN IF EXISTS audio_streams;
  `);
};

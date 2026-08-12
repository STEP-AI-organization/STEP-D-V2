/* eslint-disable camelcase */
/**
 * 0028 — 네이버 세션을 서버에 보관(암호화).
 *
 * 원래 설계는 세션(쿠키)을 **윈도우2 로컬 파일에만** 두는 것이었다. 클라우드로 안 나가니
 * DB 가 털려도 네이버 채널은 안전했다. 이 마이그레이션은 그 전제를 바꾼다 —
 * 운영자가 웹에서 계정을 추가하고 세션을 올리면 워커가 어디서든 받아 쓸 수 있게.
 *
 * ⚠️ **세션 쿠키는 그 계정 전체 권한이다.** 그래서:
 *   - 평문으로 두지 않는다. AES-256-GCM 으로 암호화해 저장한다(naver-session-store.ts).
 *   - 키(NAVER_SESSION_KEY)가 없으면 **저장도 조회도 거부**한다. 평문 폴백은 두지 않는다 —
 *     "키를 깜빡했더니 평문으로 저장됐다" 가 제일 나쁜 실패다.
 *   - 이 컬럼은 로그·응답에 절대 싣지 않는다. API 는 "있다/없다" 와 갱신 시각만 돌려준다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS session_blob TEXT;
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS session_updated_at BIGINT;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE naver_account DROP COLUMN IF EXISTS session_blob;
    ALTER TABLE naver_account DROP COLUMN IF EXISTS session_updated_at;
  `);
};

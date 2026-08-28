/* eslint-disable camelcase */
/**
 * 0046 — 네이버 계정 자격증명(아이디/비번) 보관.
 *
 * ⚠️ 번호가 `0046_media_frame_meta`(다른 세션) 와 겹친다. **그대로 두는 게 맞다.**
 *    node-pg-migrate 는 번호가 아니라 **파일명 전체**로 실행 여부를 기록하므로 같은 번호가
 *    둘이어도 각각 한 번씩 돈다. 2026-08-28 에 겹친 게 신경 쓰여 0047 로 옮겼다가
 *    `Not run migration 0047_naver-credentials is preceding already run migration
 *    0046_naver-credentials` 로 **마이그레이션 전체가 멈췄다** — 이미 적용된 것의 이름을
 *    바꾸면 DB 기록과 파일이 어긋나고, 그 뒤 모든 마이그레이션이 막힌다.
 *    **한 번이라도 적용된 마이그레이션은 이름을 바꾸지 말 것.**
 *
 *    (겹친 원인은 따로 있다: 적용 여부를 확인한 시점이 migrate Job 이 끝나기 전이라
 *     "안 돌았다" 고 오판했다. `pgmigrations` 조회는 Job 종료를 확인한 뒤에 할 것.)
 *
 * ## 왜 필요한가
 *
 * 세션은 만료된다(실측 2026-08-28: 9일 된 세션이 죽어 있었고, 그동안 화면은 "로그인됨" 이라고
 * 말하고 있었다 — 발행이 실패해야만 상태가 바뀌기 때문). 만료마다 사람이 브라우저를 열어
 * 다시 로그인해야 하는데, 고객사가 늘면 그만큼 곱해진다. 자격증명이 있으면 **워커가 스스로
 * 다시 로그인**해 세션을 되살릴 수 있다.
 *
 * ## ⚠️ 세션보다 위험한 자산이다
 *
 * 세션 쿠키는 그 서비스에만 통하고 로그아웃으로 무효화된다. **비밀번호는 다르다** —
 * 사람들이 다른 서비스에도 같은 걸 쓰고, 무효화도 본인이 바꾸기 전엔 안 된다. 유출되면
 * 피해 범위가 우리 서비스 밖으로 나간다. 그래서 세션과 **다른 키**로 봉인한다
 * (`NAVER_CRED_KEY` ≠ `NAVER_SESSION_KEY`) — 한쪽이 새도 다른 쪽은 안 열린다.
 *
 * 규칙:
 *  - `cred_blob` 은 **어떤 SELECT 목록에도 넣지 않는다**(0025 의 session_blob 과 같은 이유).
 *  - 바깥에는 "있다/없다 + 상태 + 갱신시각" 만 나간다. 값은 절대 되돌려주지 않는다.
 *  - **검증된 것만 남긴다**: 로그인에 실패한 자격증명은 지운다(틀린 비번을 들고 있어 봐야
 *    반복 실패로 계정만 잠긴다).
 *
 * cred_status: pending(검증 대기) · verified(로그인 성공 확인) · failed(로그인 실패 — blob 은 지워짐)
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS cred_blob       TEXT;
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS cred_status     TEXT;
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS cred_updated_at BIGINT;
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS cred_error      TEXT;
    ALTER TABLE naver_account ADD COLUMN IF NOT EXISTS relogin_at      BIGINT;
  `);
};

/** 되돌리면 자격증명이 사라진다 — 세션은 남으므로 발행은 계속되고, 자동 재로그인만 꺼진다. */
/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE naver_account DROP COLUMN IF EXISTS cred_blob;
    ALTER TABLE naver_account DROP COLUMN IF EXISTS cred_status;
    ALTER TABLE naver_account DROP COLUMN IF EXISTS cred_updated_at;
    ALTER TABLE naver_account DROP COLUMN IF EXISTS cred_error;
    ALTER TABLE naver_account DROP COLUMN IF EXISTS relogin_at;
  `);
};

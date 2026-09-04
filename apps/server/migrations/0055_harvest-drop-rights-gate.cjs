/**
 * 완전자동화 **권리 게이트 제거** (2026-09-04 사용자 결정).
 *
 * ## 무엇을 없앴나
 *
 * 우리가 연결하지 않은 채널을 등록하면 `blocked` 로 들어가 사람이 "이 채널 영상을 쓸 권리가
 * 있다" 고 확인해야 돌았다. 그 문을 하루 안에 두 번 옮겼다 — STEPAI 어드민 → 고객사 화면 →
 * 그리고 지금 제거한다.
 *
 * 왜 없애기로 했나: 문을 어디에 두든 **판단하는 사람이 곧 등록하는 사람**이었다. 어드민에
 * 두면 우리가 모르는 걸 심사하는 척하게 되고, 고객사 화면에 두면 방금 자기가 넣은 주소를
 * 자기가 다시 확인하는 절차가 된다. 어느 쪽도 막아 주는 게 없으면서 등록을 두 단계로
 * 늘리기만 했다(실측: 확인 전에 자동 수확이 먼저 돌아 헛도는 사고까지 났다).
 *
 * ⚠️ **이건 안전장치를 없애는 마이그레이션이다.** 이제 등록한 채널은 전부 바로 돈다 —
 * 남의 채널을 넣으면 그 영상을 받아 숏폼으로 만들어 재배포한다. 저작권 책임은 등록한
 * 워크스페이스에 있다. 되돌리려면 `status` 기본값을 'blocked' 로 돌리고 승인 경로를
 * 다시 만들어야 한다(git 이력: 0054 · index.ts harvest 라우트).
 *
 * `approved_by` 컬럼은 **남긴다** — 지금까지 누가 확인했는지의 기록이고, 지우면 그 사실이
 * 사라진다. 새로 쓰이지만 않을 뿐이다.
 */
exports.up = async (pgm) => {
  // 기본값을 바꾼다 — 코드가 status 를 명시하지만, 기본값이 'blocked' 로 남아 있으면
  // 나중에 누가 status 없이 INSERT 했을 때 조용히 안 도는 행이 생긴다.
  pgm.sql(`ALTER TABLE harvest_source ALTER COLUMN status SET DEFAULT 'active'`);
  // 이미 걸려 있던 것들을 푼다. 승인 경로가 사라지므로, 안 풀면 **영영 못 도는 행**이 된다.
  pgm.sql(`UPDATE harvest_source SET status = 'active' WHERE status = 'blocked'`);
};

exports.down = async (pgm) => {
  // 되돌려도 이미 active 가 된 행은 blocked 로 돌리지 않는다 — 그 행들은 그 사이에
  // 회차를 만들었을 수 있고, 도는 걸 멈추는 건 사람이 화면에서 할 일이다.
  pgm.sql(`ALTER TABLE harvest_source ALTER COLUMN status SET DEFAULT 'blocked'`);
};

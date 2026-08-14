/* eslint-disable camelcase */
/**
 * 0036 — 자동 충전 전 워크스페이스 일시정지 (Phase 3 결제 알림 배포 전까지)
 *
 * 왜: 자동 충전은 사람 확인 없이 카드가 긁힌다. 여신전문금융업 관행상(그리고 상식상)
 * 자동결제는 **사후 통지**가 따라와야 하는데, 결제 알림(Phase 3)이 아직 없다 —
 * 알림 없이 긁히면 사용자는 카드사 문자로 처음 알게 된다. 그래서 알림이 배포될 때까지
 * 전 워크스페이스 정책을 enabled=false 로 내린다. 정책값(임계·상한)은 남겨 두므로
 * 다시 켤 때 재설정할 필요는 없다.
 *
 * ⚠️ **Phase 3(결제 알림) 배포 후 사람이 다시 켠다** — 코드가 자동으로 되켜지 않는다.
 * 누가 껐는지 updated_by 에 남겨 화면·감사에서 "왜 꺼졌지"를 추적할 수 있게 한다.
 *
 * ⚠️ auto_topup 은 FORCE RLS 표다(0033) — 마이그레이션 커넥션은 tenant GUC 가 없어
 * 정책이 모든 행을 숨기고, UPDATE 가 "성공했는데 0건"으로 조용히 끝난다.
 * 시스템 스코프('*')를 먼저 심어야 실제로 갱신된다 (0035 와 같은 패턴).
 */

exports.up = (pgm) => {
  pgm.sql(`SELECT set_config('app.tenant_id', '*', false);`);
  pgm.sql(`
    UPDATE auto_topup
       SET enabled = FALSE, updated_at = now(), updated_by = 'migration-0036 (결제 알림 배포 전 일시정지)'
     WHERE enabled = TRUE;
  `);
};

// 어떤 워크스페이스가 켜져 있었는지는 이 시점 이후 알 수 없다 — 되돌릴 수 없는 게 맞고,
// 다시 켜는 건 Phase 3 배포 후 사람이 워크스페이스별로 판단한다.
exports.down = false;

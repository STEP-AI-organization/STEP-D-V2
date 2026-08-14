/* eslint-disable camelcase */
/**
 * 0037 — billing_card 에 구매자 정보 저장
 *
 * 왜: 빌링키 결제(POST /payments/{id}/billing-key)에 KG이니시스가 customer.name·email·
 * phoneNumber 를 **필수**로 요구하는데(2026-08-14 실결제 실측: REQUIRED 3종 거절),
 * 우리는 카드 등록 때만 이 값을 받고 버려서 결제 시 보낼 값이 없었다.
 * 등록 시 저장하고, 구 카드(컬럼 없던 시절)는 첫 수동 충전 성공 때 백필한다.
 *
 * 비파괴: nullable 컬럼 3개 추가뿐.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE billing_card
      ADD COLUMN IF NOT EXISTS buyer_name  TEXT,
      ADD COLUMN IF NOT EXISTS buyer_email TEXT,
      ADD COLUMN IF NOT EXISTS buyer_phone TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE billing_card
      DROP COLUMN IF EXISTS buyer_name,
      DROP COLUMN IF EXISTS buyer_email,
      DROP COLUMN IF EXISTS buyer_phone;
  `);
};

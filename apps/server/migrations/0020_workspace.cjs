/* eslint-disable camelcase */
/**
 * 0020 — 테넌트를 "워크스페이스"로 확정
 *
 * 제품 용어 정리 (2026-08-10 사용자):
 *   **워크스페이스 = 테넌트 = 방송사 하나.** 그 안에 직원이 여러 명 있고, 서로의 작업을
 *   같이 본다. 처음에 워크스페이스마다 계정 하나(owner)를 주고, 그 사람이 동료를 초대하면
 *   초대받은 사람이 또 초대할 수 있다.
 *
 * 스키마 변경은 두 가지뿐이다 — 나머지(users.tenant_id · invites)는 0017 에 이미 있다.
 *   1. 기본 워크스페이스 이름을 'STEP D' → 'STEPAI' 로. 사내 워크스페이스의 실제 이름이다.
 *   2. `owner_user_id` — 워크스페이스의 대표 계정. 화면에 "누구 워크스페이스인가"를 보여주고,
 *      **마지막 owner 를 지우지 못하게** 막는 기준점이 된다(주인 없는 워크스페이스 방지).
 *
 * ⚠️ 새 워크스페이스를 만들 때는 `AUTH_REQUIRED=1` 이 먼저다. 인증이 꺼져 있으면 모든 요청이
 *    기본 워크스페이스로 해석되어 격리가 무의미해지고, 서버가 503 으로 막는다(index.ts).
 *    그래서 여기서도 **새 테넌트를 만들지 않고 기존 t_default 의 이름만 바꾼다** — 기존 데이터가
 *    전부 거기 귀속돼 있고, 테넌트를 하나 더 만드는 순간 인증 없이는 서버가 안 뜨기 때문이다.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_user_id TEXT;

    UPDATE tenants
       SET name = 'STEPAI'
     WHERE id = 't_default' AND name IN ('STEP D', 'STEPAI') ;
  `);
};

exports.down = false;

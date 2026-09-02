/**
 * 자동배포 계획의 **세로 영상 배치**(`aspect`) — 저장할 자리가 없었다.
 *
 * 2026-09-02 에 계획에서 세로 배치를 고르는 기능(71806ef)과, 그 배치가 영상창을 정하게 하는
 * 렌더 배선(e8b441a)이 들어갔다. 그런데 **컬럼도 INSERT/SELECT 도 없어서** 화면에서 고른 값이
 * 저장 단계에서 조용히 버려졌다:
 *
 *   화면 선택 → 라우트 검증 통과 → **DB 저장 없음** → 조회 시 undefined
 *     → automation-cycle 의 `rule.aspect ? { videoAspect } : {}` 가 영영 안 붙음
 *     → index.ts 의 frameVideoForAspect(undefined) → null → 항상 템플릿 창
 *
 * 즉 기능이 화면까지만 살아 있고 결과물엔 도달하지 않았다(이 리포 최빈 실패모드 —
 * 생산·저장·소비 3단 중 저장 누락). 이 컬럼이 그 3단을 잇는다.
 *
 * NULL 을 허용한다. **"미지정" 과 "레터박스" 는 다른 뜻**이기 때문이다 — 미지정이면 순방이
 * SHORTS_DEFAULT_ASPECT 로 떨어지고 `videoAspect` 를 아예 안 싣는다(이미 돌던 계획의 결과물이
 * 안 바뀌게 하는 무회귀 조건). 여기에 기본값을 박으면 옛 계획 전부가 배치를 "명시한" 것이 되어
 * 렌더 경로가 바뀐다 — 그게 정확히 막으려던 일이다.
 *
 * 값의 정본은 `pipeline/automation.ts` 의 RULE_ASPECTS 다(9:16-letterbox · 9:16-crop-full ·
 * 9:16-crop-main · 9:16-crop-sub). 여기서 CHECK 제약을 걸지 않는 이유: 프리셋이 늘 때마다
 * 마이그레이션이 필요해지고, 검증은 이미 라우트(isRuleAspect)가 한다.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */
exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE automation_rule
      ADD COLUMN IF NOT EXISTS aspect TEXT;
  `);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE automation_rule
      DROP COLUMN IF EXISTS aspect;
  `);
};

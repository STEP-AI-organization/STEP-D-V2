/* eslint-disable camelcase */
/**
 * 0035 — 검색 인덱스 고아 세그먼트 일회성 정리
 *
 * 왜: 2026-08-13 이전의 미디어/회차/프로그램 삭제는 search_segments 를 안 지웠다
 * (deleteMediaData 에 빠져 있었다). 그래서 삭제된 회차의 세그먼트가 영상검색에
 * 유령으로 남아 검색·빈검색 기본 목록에 계속 뜬다. 코드는 같은 날 고쳤고(삭제
 * 캐스케이드에 포함), 이 마이그레이션은 이미 쌓인 잔재만 걷는다.
 *
 * ⚠️ search_segments·media 는 FORCE RLS 대상이다 — 마이그레이션 커넥션은 tenant GUC 가
 * 없어서 정책이 모든 행을 숨기고, DELETE 가 "성공했는데 0건"으로 조용히 끝난다.
 * 시스템 스코프('*')를 먼저 심어야 실제로 지워진다 (0014 정책의 '*' 분기).
 */

exports.up = async (pgm) => {
  pgm.sql(`SELECT set_config('app.tenant_id', '*', false);`);
  // 고아 = media 행이 어느 테넌트에도 없는 세그먼트. 테넌트 무관 전역 대조가 맞다 —
  // 세그먼트의 원본 미디어가 지워졌다는 사실은 테넌트 경계와 무관한 물리적 사실이다.
  pgm.sql(`
    DELETE FROM search_segments ss
     WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = ss.media_id);
  `);
};

// 삭제된 인덱스는 재분석(content.analyze)으로만 재생성된다 — 되돌릴 게 없다.
exports.down = false;

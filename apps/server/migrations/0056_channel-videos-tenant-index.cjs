/**
 * `channel_videos` 에 **회사 단위 유니크 인덱스**를 추가한다. (2단계 중 1단계)
 *
 * ## 고치려는 것
 *
 * 이 표는 RLS 로 회사별 격리되는데 유니크 제약만 전역(`UNIQUE (videoid)`)이었다. 두
 * 워크스페이스가 **같은 유튜브 채널**을 수집원으로 등록하면(완전자동화에서는 흔하다 —
 * 인기 채널을 여럿이 본다) 뒤에 등록한 쪽의 `upsertChannelVideo` 가
 *
 *   · `ON CONFLICT (videoId) DO UPDATE` 로 앞 회사의 행을 노리는데
 *   · RLS 때문에 그 행이 **보이지 않아** 업데이트가 성립하지 않는다
 *
 * 결과는 조용한 실패다. 뒤 회사의 업로드 목록이 영영 안 채워지고 수확기는 "새로 가져올
 * 롱폼이 없습니다" 라고만 말한다 — 원인이 **다른 회사의 데이터**라, 그 회사 화면만 봐서는
 * 절대 알 수 없다.
 *
 * ## 왜 2단계인가
 *
 * 배포 순서가 `서버 이미지 → 마이그레이션` 이라, 코드와 스키마를 같은 배포에서 바꾸면
 * 그 사이 몇 분 동안 새 코드가 없는 인덱스를 가리킨다(`ON CONFLICT` 는 인덱스가 있어야
 * 성립한다) → 채널 동기화가 전부 실패한다.
 *
 *   1단계(여기): **인덱스만 만든다.** 코드는 그대로 — 동작이 하나도 안 바뀐다.
 *   2단계(0057): 코드를 `ON CONFLICT (tenant_id, videoId)` 로 바꾸고 옛 전역 제약을 지운다.
 *                그때는 인덱스가 이미 있으므로 창이 없다.
 *
 * ⚠️ **1단계만으로는 버그가 안 고쳐진다.** 전역 제약이 아직 살아 있어서, 두 회사가 같은
 *    영상을 넣으면 여전히 막힌다. 0057 까지 가야 끝난다.
 */
exports.up = async (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_videos_tenant_video
      ON channel_videos(tenant_id, videoid)
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS uq_channel_videos_tenant_video`);
};

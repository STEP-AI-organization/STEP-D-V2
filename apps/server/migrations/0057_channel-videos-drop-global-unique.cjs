/**
 * `channel_videos` 의 **전역 UNIQUE(videoid)** 를 지운다. (2단계 중 2단계 · 0056 참조)
 *
 * 0056 이 회사 단위 인덱스(`uq_channel_videos_tenant_video`)를 이미 만들어 뒀고, 이 배포의
 * 서버 코드가 `ON CONFLICT (tenant_id, videoId)` 로 바뀐다. 그래서 지금 전역 제약을 지우면
 * 두 워크스페이스가 같은 유튜브 채널을 봐도 서로를 막지 않는다.
 *
 * 순서가 중요하다 — 0056(인덱스) → 코드 → 0057(제약 삭제). 인덱스 없이 코드부터 나가면
 * `ON CONFLICT` 가 가리킬 대상이 없어 채널 동기화가 전부 실패한다.
 */
exports.up = async (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE con TEXT;
    BEGIN
      SELECT conname INTO con
        FROM pg_constraint
       WHERE conrelid = 'channel_videos'::regclass
         AND contype = 'u'
         AND pg_get_constraintdef(oid) = 'UNIQUE (videoid)';
      IF con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE channel_videos DROP CONSTRAINT %I', con);
      END IF;
    END $$;
  `);
};

exports.down = async (pgm) => {
  // 회사가 갈려 같은 videoId 가 이미 둘 이상이면 실패한다 — 그게 맞다.
  // 조용히 데이터를 버리는 것보다 되돌리기를 멈추는 편이 낫다.
  pgm.sql(`ALTER TABLE channel_videos ADD CONSTRAINT channel_videos_videoid_key UNIQUE (videoid)`);
};

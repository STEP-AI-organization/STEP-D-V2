// Exp 9: 다채널 재현 대상 조사 — 채널별 (리텐션 · 매칭정답 · 엔진분석) 3종 세트 준비 여부.
// 워커 VM에서 실행 (exp8_fetch_retention.cjs와 동일 환경).
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();

  const q = await c.query(`
    with chans as (
      select channelid, channelname from youtube_channels order by channelname
    ),
    ret as (
      select channelid, count(distinct videoid) as n_ret
      from video_retention where jsonb_array_length(curve) > 0
      group by channelid
    ),
    matches as (
      select channelid,
             count(*) as n_pairs,
             count(distinct longvideoid) as n_longs_matched
      from short_source_map
      group by channelid
    ),
    analyzed as (
      select cv.channelid, count(distinct ca.mediaid) as n_analyzed
      from content_analysis ca
      join channel_videos cv on cv.videoid = ca.mediaid
      group by cv.channelid
    ),
    longs_ret as (
      -- 리텐션 있고, 매칭 정답도 있는 롱폼 (교집합) — Exp 8 재현에 실제 쓸 수 있는 후보
      select ssm.channelid, count(distinct ssm.longvideoid) as n_longs_full
      from short_source_map ssm
      join video_retention vr on vr.videoid = ssm.longvideoid
      where jsonb_array_length(vr.curve) > 0
      group by ssm.channelid
    )
    select
      chans.channelid, chans.channelname,
      coalesce(ret.n_ret, 0) as retention_videos,
      coalesce(matches.n_pairs, 0) as truth_pairs,
      coalesce(matches.n_longs_matched, 0) as longs_matched,
      coalesce(analyzed.n_analyzed, 0) as analyzed_videos,
      coalesce(longs_ret.n_longs_full, 0) as longs_ret_and_matched
    from chans
    left join ret on ret.channelid = chans.channelid
    left join matches on matches.channelid = chans.channelid
    left join analyzed on analyzed.channelid = chans.channelid
    left join longs_ret on longs_ret.channelid = chans.channelid
    order by longs_ret_and_matched desc, truth_pairs desc, chans.channelname
  `);

  console.log('=== Exp 9 다채널 재현 대상 조사 ===\n');
  console.log('columns: channel | retention_videos | truth_pairs | longs_matched | analyzed_videos | *longs_ret_and_matched*\n');
  for (const r of q.rows) {
    console.log(`${r.channelname.padEnd(20)} | ret=${String(r.retention_videos).padStart(3)} | pairs=${String(r.truth_pairs).padStart(3)} | longsM=${String(r.longs_matched).padStart(3)} | analyzed=${String(r.analyzed_videos).padStart(3)} | **ready=${r.longs_ret_and_matched}**`);
  }
  console.log(`\n총 ${q.rows.length}개 채널`);

  // 하하 이외 재현 가능 후보 (ready >= 3)
  const candidates = q.rows.filter(r =>
    r.longs_ret_and_matched >= 3 &&
    !/haha|하하/i.test(r.channelname)
  );
  console.log(`\n🎯 Exp 9 후보 (하하 제외, ready 롱폼 ≥ 3): ${candidates.length}개`);
  for (const r of candidates) {
    console.log(`  ${r.channelname}: ${r.longs_ret_and_matched} 롱폼 · ${r.truth_pairs} 매칭 정답 · ${r.retention_videos} 리텐션`);
  }

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

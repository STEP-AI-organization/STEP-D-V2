// Exp 10 조사: 어떤 채널·롱폼에 이미 댓글이 수집돼 있고, 평균 몇 개인지
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();

  const q = await c.query(`
    with by_ch as (
      select vc.channelid, yc.channelname,
             count(*) as n_comments,
             count(distinct vc.videoid) as n_videos_with_comments
      from video_comments vc
      join youtube_channels yc on yc.channelid = vc.channelid
      group by vc.channelid, yc.channelname
    )
    select * from by_ch order by n_comments desc
  `);

  console.log('=== 채널별 댓글 수집 현황 ===\n');
  for (const r of q.rows) {
    console.log(`${r.channelname.padEnd(22)} | comments=${String(r.n_comments).padStart(5)} | videos=${String(r.n_videos_with_comments).padStart(4)}`);
  }
  console.log(`\n총 ${q.rows.length}개 채널`);

  // Exp 8/9 대상 롱폼별 댓글 상태
  const targetLongs = [
    // 하하 Exp 8 v2
    'JppILjNTCok', 'NtXLj7xOeE8', 'LcMolKaPcrw',
    // ENA Exp 9
    'dnIaj6L3t1E', 'DPclbGO1F9g', 'Lj_tFgRqqEI', 'MjWwq8bBwJE', 'QNtoQ4zI8mc',
    // 드나드나 Exp 9
    'rhX9po-DBZI', 'NUM1zfQujWY', 'OuvpspSaAUQ', 'k8BHuiKF0rk', 'ALuFb_TqHPU', 'a9O8d0zLfTg', 'sT9KQTLg2Cs',
  ];
  const q2 = await c.query(`
    select videoid, count(*) as n
    from video_comments
    where videoid = ANY($1)
    group by videoid
  `, [targetLongs]);
  const have = new Map(q2.rows.map(r => [r.videoid, Number(r.n)]));

  console.log('\n=== Exp 8/9 대상 롱폼 댓글 상태 ===');
  for (const lid of targetLongs) {
    const n = have.get(lid) || 0;
    console.log(`  ${lid}: ${n} comments ${n === 0 ? '❌ 미수집' : '✅'}`);
  }

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

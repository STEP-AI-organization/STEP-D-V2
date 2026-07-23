// Exp 11: 하하 채널 과거 롱폼 목록 (Exp 8 홀드아웃 3편 제외)
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();

  const HAHA = 'UCK3p1wDoQYOkxi414EvBlLw';
  const HOLDOUT = ['JppILjNTCok', 'NtXLj7xOeE8', 'LcMolKaPcrw'];

  const q = await c.query(`
    select videoid, title, durationsec, viewcount, publishedAt
    from channel_videos
    where channelid = $1
      and not (isshort = true or coalesce(durationsec, 0) <= 180)
      and coalesce(durationsec, 0) between 300 and 3600
      and videoid <> ALL($2)
    order by viewcount desc nulls last
    limit 15`, [HAHA, HOLDOUT]);

  console.log(`하하 채널 과거 롱폼 (상위 15편, 홀드아웃 제외):\n`);
  for (const r of q.rows) {
    console.log(`  ${r.videoid} | ${r.durationsec}s | v=${r.viewcount} | ${(r.title||'').slice(0,50)}`);
  }
  require('fs').writeFileSync('/tmp/exp11_past_longs.json', JSON.stringify(q.rows, null, 2));

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

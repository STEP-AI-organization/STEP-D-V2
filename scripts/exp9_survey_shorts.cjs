// Exp 9 준비: 채널별 shorts·longs 수량 조사 (매칭 잡을 걸 만한 규모인지 확인)
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();

  const q = await c.query(`
    with base as (
      select
        cv.channelid,
        yc.channelname,
        count(*) filter (where cv.isshort = true or coalesce(cv.durationsec, 0) <= 180) as shorts,
        count(*) filter (where not (cv.isshort = true or coalesce(cv.durationsec, 0) <= 180) and coalesce(cv.durationsec, 0) > 180) as longs,
        count(*) filter (where cv.isshort is not null) as classified
      from channel_videos cv
      join youtube_channels yc on yc.channelid = cv.channelid
      group by cv.channelid, yc.channelname
    )
    select * from base order by longs desc, shorts desc
  `);

  console.log('=== 채널별 shorts/longs 수량 ===\n');
  for (const r of q.rows) {
    console.log(`${r.channelname.padEnd(22)} | shorts=${String(r.shorts).padStart(4)} | longs=${String(r.longs).padStart(4)} | classified=${r.classified}`);
  }

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

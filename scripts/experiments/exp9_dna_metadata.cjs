// Exp 9 드나드나: 리텐션 좋은 상위 롱폼 + 조회수 높은 shorts 목록 → 로컬 다운로드용 metadata 뽑기
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
const fs = require('fs');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();

  // 드나드나 채널 ID 찾기
  const ch = await c.query(`select channelid, channelname from youtube_channels where channelname like '%드나%'`);
  if (!ch.rows.length) { console.error('드나드나 채널 없음'); process.exit(1); }
  const channelId = ch.rows[0].channelid;
  console.log(`채널: ${ch.rows[0].channelname} (${channelId})\n`);

  // 리텐션 있는 롱폼 상위 10편 (조회수 좋은 순)
  const longs = await c.query(`
    select cv.videoid, cv.title, cv.durationsec, cv.viewcount, jsonb_array_length(vr.curve) as ret_points
    from channel_videos cv
    join video_retention vr on vr.videoid = cv.videoid
    where cv.channelid = $1
      and not (cv.isshort = true or coalesce(cv.durationsec, 0) <= 180)
      and jsonb_array_length(vr.curve) > 0
      and coalesce(cv.durationsec, 0) between 300 and 3600
    order by cv.viewcount desc nulls last
    limit 10`, [channelId]);
  console.log(`상위 롱폼 (리텐션 有, 300~3600s): ${longs.rows.length}편`);
  for (const r of longs.rows) {
    console.log(`  ${r.videoid} | ${r.durationsec}s | v=${r.viewcount} | ret_pts=${r.ret_points} | ${r.title?.slice(0,40)}`);
  }

  // shorts 상위 30편 (조회수 순)
  const shorts = await c.query(`
    select videoid, title, durationsec, viewcount
    from channel_videos
    where channelid = $1
      and (isshort = true or coalesce(durationsec, 0) <= 180)
      and coalesce(durationsec, 0) between 8 and 180
    order by viewcount desc nulls last
    limit 30`, [channelId]);
  console.log(`\n상위 shorts: ${shorts.rows.length}편`);

  fs.writeFileSync('/tmp/exp9_dna_longs.json', JSON.stringify(longs.rows, null, 2));
  fs.writeFileSync('/tmp/exp9_dna_shorts.json', JSON.stringify(shorts.rows, null, 2));

  // 리텐션 커브까지 함께
  const longIds = longs.rows.map(r => r.videoid);
  const rets = await c.query(`
    select vr.videoid, vr.curve, cv.durationsec
    from video_retention vr
    join channel_videos cv on cv.videoid = vr.videoid
    where vr.videoid = ANY($1)`, [longIds]);
  const retOut = {};
  for (const r of rets.rows) retOut[r.videoid] = { curve: r.curve, dur: Number(r.durationsec) || 0 };
  fs.writeFileSync('/tmp/exp9_dna_retention.json', JSON.stringify(retOut, null, 2));
  console.log(`\n리텐션 커브: ${rets.rows.length}편 저장 → /tmp/exp9_dna_*.json`);

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

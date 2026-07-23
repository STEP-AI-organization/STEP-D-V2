// Exp 9 ENA: 5개 롱폼의 리텐션 커브를 프로덕션 DB에서 가져와서 로컬로 저장
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();
  const longids = ['DPclbGO1F9g', 'Lj_tFgRqqEI', 'MjWwq8bBwJE', 'QNtoQ4zI8mc', 'dnIaj6L3t1E'];
  const q = await c.query(`
    select vr.videoid, vr.curve, cv.durationsec
    from video_retention vr
    join channel_videos cv on cv.videoid = vr.videoid
    where vr.videoid = ANY($1) and jsonb_array_length(vr.curve) > 0`, [longids]);
  console.log(`Fetched: ${q.rows.length}/5 longforms with curves`);
  const out = {};
  for (const r of q.rows) {
    out[r.videoid] = {
      curve: r.curve,
      dur: Number(r.durationsec) || 0,
      n_points: r.curve.length,
    };
    console.log(`  ${r.videoid}: dur=${r.durationsec}s, curve=${r.curve.length}pts`);
  }
  require('fs').writeFileSync('/tmp/exp9_ena_retention.json', JSON.stringify(out, null, 2));
  console.log('저장: /tmp/exp9_ena_retention.json');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

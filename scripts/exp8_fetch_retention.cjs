// Exp 8: 3홀드아웃의 롱폼 리텐션 커브 DB 조회 → JSON 저장
// 워커 VM에서 실행 (deploy-worker.ps1과 동일 환경)
const {Client} = require('/opt/stepd/apps/server/node_modules/pg');
(async () => {
  const c = new Client({connectionString: process.env.DATABASE_URL});
  await c.connect();
  const longids = ['JppILjNTCok', 'NtXLj7xOeE8', 'LcMolKaPcrw'];
  const q = await c.query(`
    select vr.videoid, vr.curve, cv.durationsec
    from video_retention vr
    join channel_videos cv on cv.videoid = vr.videoid
    where vr.videoid = ANY($1) and jsonb_array_length(vr.curve) > 0`, [longids]);
  console.log(`Fetched: ${q.rows.length}/3 longforms with curves`);
  const out = {};
  for (const r of q.rows) {
    out[r.videoid] = {
      curve: r.curve,
      dur: Number(r.durationsec) || 0,
      n_points: r.curve.length,
    };
    console.log(`  ${r.videoid}: dur=${r.durationsec}s, curve=${r.curve.length}pts`);
  }
  require('fs').writeFileSync('/tmp/exp8_retention.json', JSON.stringify(out, null, 2));
  console.log('저장: /tmp/exp8_retention.json');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

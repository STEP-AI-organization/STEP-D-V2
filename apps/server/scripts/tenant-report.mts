/**
 * 테넌트(워크스페이스) 귀속 현황. **배포 직후 확인용.**
 *
 *   pnpm --filter @stepd/server tenants:report
 *
 * 0013 마이그레이션이 모든 테이블에 `tenant_id NOT NULL DEFAULT 't_default'` 를 붙이므로,
 * 프로덕션에 이미 있던 행(연결된 YouTube/Meta/TikTok 채널 포함)은 마이그레이션이 도는 순간
 * 전부 기본 워크스페이스(STEPAI)로 귀속된다. **이관을 위해 따로 실행할 것은 없고**, 이
 * 스크립트는 그게 실제로 그렇게 됐는지 눈으로 확인하는 용도다.
 *
 * 스코프 없는 풀(rawPool)로 읽는다 — 전 테넌트를 가로질러 세는 게 목적이라 RLS 를 통과하면
 * 자기 것만 보여 의미가 없다.
 */
import { initDb, getRawPool } from "../src/db-pg.ts";

const TABLES = [
  "youtube_channels", "meta_accounts", "tiktok_accounts",
  "channel_videos", "media", "entities", "content_analysis", "search_segments",
  "job_queue", "users",
];

await initDb();
const p = getRawPool();

const { rows: tenants } = await p.query(
  "SELECT id, name, kind, status FROM tenants ORDER BY created_at ASC",
);
console.log("\n워크스페이스");
for (const t of tenants) console.log(`  ${String(t.id).padEnd(14)} ${String(t.name).padEnd(16)} ${t.kind} · ${t.status}`);

console.log("\n테이블별 귀속");
for (const table of TABLES) {
  try {
    const { rows } = await p.query(
      `SELECT tenant_id, COUNT(*)::int AS n FROM ${table} GROUP BY tenant_id ORDER BY n DESC`,
    );
    const summary = rows.length ? rows.map((r) => `${r.tenant_id}=${r.n}`).join("  ") : "(비어 있음)";
    console.log(`  ${table.padEnd(18)} ${summary}`);
  } catch (e: any) {
    console.log(`  ${table.padEnd(18)} (조회 실패: ${e.code ?? e.message})`);
  }
}

// 주인이 사라진 행이 있으면 FK 가 막았어야 한다 — 그래도 확인한다. 여기서 걸리면 스키마가 깨진 것이다.
const { rows: orphan } = await p.query(`
  SELECT 'media' AS t, COUNT(*)::int AS n FROM media m WHERE NOT EXISTS (SELECT 1 FROM tenants x WHERE x.id = m.tenant_id)
  UNION ALL
  SELECT 'youtube_channels', COUNT(*)::int FROM youtube_channels y WHERE NOT EXISTS (SELECT 1 FROM tenants x WHERE x.id = y.tenant_id)
`);
const bad = orphan.filter((r: any) => r.n > 0);
console.log(bad.length ? `\n⚠️  주인 없는 행: ${JSON.stringify(bad)}` : "\n주인 없는 행 없음");

process.exit(0);

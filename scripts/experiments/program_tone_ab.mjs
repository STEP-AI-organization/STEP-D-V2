/**
 * 같은 beats · 다른 program context = title 톤 변화 검증.
 * 3가지 프로그램 컨텍스트로 recommend만 반복 실행, title 비교.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, cpSync } from "node:fs";

const OUT_BASE = "C:/tmp/ytest_analyze";
const CONTEXTS = [
  { label: "no_ctx",  path: null },
  { label: "talkshow", path: "C:/tmp/program_ctx_talkshow.json" },
  { label: "documentary", path: "C:/tmp/program_ctx_doc.json" },
  { label: "transit_love", path: "C:/tmp/program_ctx_transit.json" },
];

const PY = "C:/Users/STEPAI05/STEPD-repo/core/.venv310/Scripts/python.exe";
const VIDEO = "C:/tmp/ytest_J2XZyU5OIII.mp4";

const results = [];
for (const c of CONTEXTS) {
  // shorts.json + analysis.json 삭제 · beats는 유지
  for (const f of ["shorts.json", "analysis.json"]) {
    const p = `${OUT_BASE}/${f}`;
    if (existsSync(p)) rmSync(p);
  }
  const args = ["-X", "utf8", "-m", "core.analyze", VIDEO, "--out", OUT_BASE];
  if (c.path) args.push("--program-context", c.path);
  console.log(`\n=== ${c.label} ===`);
  execFileSync(PY, args, {
    env: { ...process.env,
      GOOGLE_APPLICATION_CREDENTIALS: "C:/Users/STEPAI05/STEPD-repo/gcp-keys/stepd-service-account-key.json",
      STT_PROVIDER: "hybrid",
    },
    cwd: "C:/Users/STEPAI05/STEPD-repo",
    stdio: ["ignore", "ignore", "inherit"],
  });
  const shorts = JSON.parse(readFileSync(`${OUT_BASE}/shorts.json`, "utf-8"));
  const list = Array.isArray(shorts) ? shorts : (shorts.shorts || []);
  results.push({ label: c.label, titles: list.map(s => s.title || "-") });
}

console.log("\n\n═══ 결과 비교 ═══");
const maxTitles = Math.max(...results.map(r => r.titles.length));
for (let i = 0; i < maxTitles; i++) {
  console.log(`\n[shorts #${i + 1}]`);
  for (const r of results) {
    console.log(`  ${r.label.padEnd(15)} ${r.titles[i] || "-"}`);
  }
}

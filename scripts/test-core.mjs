#!/usr/bin/env node
/**
 * core/ 파이썬 테스트 실행기 — `pnpm check` 와 CI 가 같이 쓴다.
 *
 * ## 왜 래퍼가 필요한가
 *
 * 테스트 103개가 있는데 **아무도 안 돌리고 있었다**(2026-09-07 발견). `pnpm check` 에
 * 파이썬 테스트가 없어서, core 를 고쳐도 깨진 걸 배포하고 나서야 안다.
 *
 * 그런데 그냥 넣으면 안 된다 — README 가 "core 없어도 웹·서버는 뜬다" 고 안내하므로
 * **파이썬을 안 깐 개발자가 첫날부터 빨간불을 본다.** 초록이 아닌 관문은 사람이 무시하게
 * 되고(CLAUDE.md 원칙), 그러면 관문 전체가 무의미해진다.
 *
 * 그래서 갈라놨다:
 *   - 로컬(`pnpm check`)  : 파이썬·pytest 없으면 **건너뛴다**(exit 0) + 까는 법 안내
 *   - CI(`--required`)    : 없으면 **실패**한다 — CI 에서 조용히 넘어가면 있으나 마나다
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = process.argv.includes("--required");

/** venv 파이썬 → CORE_PYTHON → 시스템 python 순. content-pipeline 의 탐색 순서와 같다. */
function findPython() {
  const candidates = [
    process.env.CORE_PYTHON,
    path.join(ROOT, "core", ".venv310", "Scripts", "python.exe"),  // Windows
    path.join(ROOT, "core", ".venv310", "bin", "python"),          // macOS/Linux
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 마지막 폴백 — CI 는 setup-python 이 깔아준 것을 PATH 로 준다.
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    if (r.status === 0) return cmd;
  }
  return null;
}

function skip(reason, howTo) {
  if (required) {
    console.error(`\n[core 테스트] ❌ ${reason}`);
    console.error(`  CI 에서는 건너뛸 수 없다 — ${howTo}\n`);
    process.exit(1);
  }
  console.log(`\n[core 테스트] 건너뜀 — ${reason}`);
  console.log(`  돌리려면: ${howTo}`);
  console.log("  (파이썬 없이도 웹·서버 개발은 된다. core/ 를 고칠 때만 필요하다.)\n");
  process.exit(0);
}

const py = findPython();
if (!py) {
  skip("파이썬을 못 찾았다", "python -m venv core/.venv310 && core/.venv310/Scripts/pip install -r core/requirements-dev.txt");
}

// pytest 가 있는지 먼저 본다 — 없이 실행하면 "No module named pytest" 라는 불친절한 실패가 난다.
const hasPytest = spawnSync(py, ["-c", "import pytest"], { stdio: "ignore" }).status === 0;
if (!hasPytest) {
  skip("pytest 가 없다", `${py} -m pip install -r core/requirements-dev.txt`);
}

const res = spawnSync(py, ["-m", "pytest", "core/tests", "-q"], { cwd: ROOT, stdio: "inherit" });
process.exit(res.status ?? 1);

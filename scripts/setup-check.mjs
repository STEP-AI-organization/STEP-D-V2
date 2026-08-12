#!/usr/bin/env node
/**
 * 클론 직후 "내 머신에 뭐가 없나" 를 한 번에 알려준다 — `pnpm setup:check`.
 *
 * 왜 스크립트인가: 준비물 목록을 README 에만 두면 사람이 하나씩 확인해야 하고, 빠뜨린 채
 * 개발을 시작하면 **한참 뒤 엉뚱한 에러**로 나타난다(ffmpeg 이 없어서 썸네일이 빈 파일이
 * 된다든지). 여기서 미리 잡는다.
 *
 * ⚠️ 고치려 들지 않는다. **무엇이 없고 어떻게 채우는지만** 말한다 — 남의 머신에 임의로
 *    설치하는 쪽이 더 나쁘다.
 *
 * 종료코드: 필수가 하나라도 빠지면 1, 선택만 빠지면 0.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OK = "  ✓", NO = "  ✗", WARN = "  !";
let hardFail = 0;

/**
 * ⚠️ Windows 에서 `pnpm`·`gcloud` 는 `.cmd`/`.ps1` 셸 래퍼다. Node 20+ 는 보안상
 * `.cmd` 직접 실행을 막아서, shell 없이 부르면 **설치돼 있는데도 "없음"** 으로 나온다.
 * 잘못된 실패를 보고하는 점검기는 없느니만 못하므로 win32 에서는 shell 로 부른다.
 */
function run(cmd, args) {
  const opts = { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] };
  try {
    return execFileSync(cmd, args, opts).trim();
  } catch {
    if (process.platform !== "win32") return null;
    try {
      return execFileSync(`${cmd} ${args.join(" ")}`, { ...opts, shell: true }).trim();
    } catch {
      return null;
    }
  }
}

/** 첫 숫자 덩어리를 major 로. "v24.14.1" · "Python 3.11.15" 둘 다 처리. */
function major(s) {
  const m = String(s ?? "").match(/(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2] } : null;
}

function check({ label, got, need, how, optional = false, note }) {
  if (got) {
    console.log(`${OK} ${label.padEnd(22)} ${got}${note ? `  (${note})` : ""}`);
    return true;
  }
  if (optional) {
    console.log(`${WARN} ${label.padEnd(22)} 없음 — ${need}`);
    if (how) console.log(`      ${how}`);
    return false;
  }
  console.log(`${NO} ${label.padEnd(22)} 없음 — ${need}`);
  if (how) console.log(`      ${how}`);
  hardFail++;
  return false;
}

console.log("\nSTEP-D 개발 환경 점검\n" + "=".repeat(52) + "\n");

console.log("[필수] 없으면 아무것도 안 돈다");
const node = run("node", ["-v"]);
const nv = major(node);
check({
  label: "Node >= 22", need: "Node 22 이상", how: "https://nodejs.org (또는 nvm)",
  got: nv && nv.major >= 22 ? node : null,
  note: nv && nv.major < 22 ? `현재 ${node} — 너무 낮다` : undefined,
});
const pnpm = run("pnpm", ["-v"]) ?? run("pnpm.cmd", ["-v"]);
check({ label: "pnpm >= 10", need: "pnpm", how: "npm i -g pnpm  (또는 corepack enable)", got: pnpm });
check({
  label: "ffmpeg", need: "영상 프로브·트림·썸네일에 필수", got: run("ffmpeg", ["-version"])?.split("\n")[0]?.slice(0, 40),
  how: "https://ffmpeg.org/download.html  ·  PATH 에 있어야 한다",
});
check({
  label: "node_modules", need: "의존성 미설치", how: "pnpm install",
  got: existsSync(join(ROOT, "node_modules")) ? "설치됨" : null,
});
check({
  label: "apps/server/.env", need: "서버 환경변수", how: "cp apps/server/.env.example apps/server/.env  → 값 채우기",
  got: existsSync(join(ROOT, "apps/server/.env")) ? "있음" : null,
});

console.log("\n[선택] 없으면 그 기능만 안 된다");
const py = run("python", ["--version"]) ?? run("python3", ["--version"]);
const pv = major(py);
check({
  optional: true, label: "Python >= 3.10", need: "core/ AI 파이프라인을 로컬에서 돌릴 때",
  how: "python -m venv core/.venv310 && core/.venv310/Scripts/pip install -r core/requirements.txt",
  got: pv && (pv.major > 3 || (pv.major === 3 && pv.minor >= 10)) ? py : null,
});
check({
  optional: true, label: "core venv", need: "파이프라인 의존성",
  how: "위 명령으로 만든다. 위치가 다르면 CORE_PYTHON 으로 알려준다",
  got: ["core/.venv310", "core/.venv"].find((p) => existsSync(join(ROOT, p))) ?? null,
});
check({
  optional: true, label: "Docker", need: "로컬 Postgres (dev.ps1 이 띄운다)",
  how: "Docker Desktop. 원격 DB 를 쓸 거면 DATABASE_URL 만 있으면 된다",
  got: run("docker", ["--version"]),
});
check({
  optional: true, label: "gcloud", need: "배포·GCS·Vertex 인증",
  how: "https://cloud.google.com/sdk  →  gcloud auth application-default login",
  got: run("gcloud", ["--version"])?.split("\n")[0],
});
check({
  optional: true, label: "썸네일 폰트", need: "썸네일 자막 렌더 (61MB · 리포에 없다)",
  how: "pwsh scripts/ops/download-fonts.ps1",
  got: existsSync(join(ROOT, "assets/thumbnail-fonts")) ? "있음" : null,
});

// .env 가 있어도 필수 키가 비어 있으면 서버가 기동 중에 죽는다 — 미리 본다.
const envPath = join(ROOT, "apps/server/.env");
if (existsSync(envPath)) {
  const env = readFileSync(envPath, "utf-8");
  const empty = ["DATABASE_URL"].filter((k) => !new RegExp(`^${k}=.+`, "m").test(env));
  if (empty.length) {
    console.log(`\n${NO} apps/server/.env 에 값이 비었다: ${empty.join(", ")}`);
    hardFail++;
  }
}

console.log("\n" + "=".repeat(52));
if (hardFail) {
  console.log(`필수 ${hardFail}개가 빠졌다. 위 안내대로 채운 뒤 다시 실행할 것.\n`);
  process.exit(1);
}
console.log("필수는 전부 준비됐다.  다음:  pnpm dev   (또는 .\\dev.ps1)\n");
console.log("  리포 지도   README.md");
console.log("  작업 규칙   CLAUDE.md");
console.log("  로컬 개발   docs/ops/local-dev.md\n");

/**
 * 데스크톱 앱 업데이트 발행 — `release/` 의 산출물을 GCS 피드로 올린다.
 *
 * ## 이 스크립트가 하는 진짜 일은 "안 올리는 것" 이다
 *
 * 여기 올리는 순간 **모든 편집자 PC 가 자동으로 그걸 받는다.** 되돌릴 방법은 다음 버전을
 * 급히 올리는 것뿐이고, 그 사이에 편집자들은 깨진 앱을 쓴다. 그래서 올리기 전에 거른다:
 *
 *   · 안정 버전인가 (`0.3.0` 은 되고 `0.3.0-beta.1` 은 안 된다)
 *   · 지금 피드에 있는 것보다 **높은가** (되돌리기·같은 버전 재발행을 막는다)
 *   · `latest.yml` 이 가리키는 파일이 **실제로 다 있는가**
 *   · 빌드가 이번 버전 것인가 (package.json 과 산출물 이름이 같은가)
 *
 * 마지막 하나가 실전에서 제일 자주 걸린다 — 버전을 올리고 빌드를 다시 안 하면
 * `release/` 에 옛 exe 가 남아 있고, 그걸 새 버전이라고 올리게 된다.
 *
 * ## 순서
 *
 * **설치본을 먼저, `latest.yml` 을 마지막에.** 반대로 하면 그 사이에 확인한 앱이
 * "새 버전이 있다" 를 보고 받으러 갔다가 404 를 만난다.
 *
 * ```
 * pnpm --filter stepaistudio dist          # 빌드
 * pnpm --filter stepaistudio publish:update        # 무엇이 올라갈지 보여주고 멈춘다
 * pnpm --filter stepaistudio publish:update -- --yes   # 실제로 올린다
 * ```
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, "..");
const RELEASE = path.join(NATIVE, "release");
const BUCKET = process.env.GCS_BUCKET || "stepd-media";
const PREFIX = "desktop";

const args = process.argv.slice(2);
const APPLY = args.includes("--yes");

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function gcloud(...a) {
  return execFileSync("gcloud", a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `0.3.0` 만 안정이다 — native/src/update/policy.ts 의 isStableVersion 과 같은 규칙. */
const isStable = (v) => /^\d+\.\d+\.\d+$/.test(String(v ?? "").trim());

function isNewer(a, b) {
  const p = (v) => String(v).split(".").map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// ── 1. 이번에 올릴 버전 ────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(NATIVE, "package.json"), "utf-8"));
const version = pkg.version;
if (!isStable(version)) {
  die(`안정 버전이 아닙니다: ${version}\n`
    + "  프리릴리스는 발행하지 않습니다 — 올리는 순간 전 편집자 PC 가 자동으로 받습니다.");
}

// ── 2. 산출물 확인 ────────────────────────────────────────────────────────────
if (!fs.existsSync(RELEASE)) die(`빌드 산출물이 없습니다: ${RELEASE}\n  먼저 \`pnpm --filter stepaistudio dist\``);

const latestYmlPath = path.join(RELEASE, "latest.yml");
if (!fs.existsSync(latestYmlPath)) {
  die("release/latest.yml 이 없습니다.\n"
    + "  electron-builder 가 이 파일을 만들려면 package.json 의 build.publish 가 있어야 합니다.");
}
const yml = fs.readFileSync(latestYmlPath, "utf-8");

const ymlVersion = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
if (ymlVersion !== version) {
  die(`빌드가 이번 버전 것이 아닙니다 — package.json=${version} · latest.yml=${ymlVersion}\n`
    + "  버전만 올리고 다시 안 빌드하면 **옛 exe 를 새 버전이라고 올리게 됩니다.**\n"
    + "  `pnpm --filter stepaistudio dist` 를 다시 돌리세요.");
}

/** latest.yml 이 가리키는 파일 전부 — 하나라도 없으면 편집자 PC 가 받다가 실패한다. */
const referenced = [...yml.matchAll(/^\s+-?\s*url:\s*(.+)$/gm)].map((m) => m[1].trim());
if (referenced.length === 0) die("latest.yml 에서 파일 이름을 못 읽었습니다 — 형식을 확인하세요.");

const missing = referenced.filter((f) => !fs.existsSync(path.join(RELEASE, f)));
if (missing.length) die(`latest.yml 이 가리키는 파일이 없습니다: ${missing.join(", ")}`);

// blockmap 은 차등 업데이트용이라 latest.yml 에 안 적히는 경우가 있다 — 있으면 같이 올린다.
const blockmaps = referenced
  .map((f) => `${f}.blockmap`)
  .filter((f) => fs.existsSync(path.join(RELEASE, f)));

// ── 3. 지금 피드에 있는 것 ─────────────────────────────────────────────────────
let live = null;
try {
  const cur = gcloud("storage", "cat", `gs://${BUCKET}/${PREFIX}/latest.yml`);
  live = /^version:\s*(.+)$/m.exec(cur)?.[1]?.trim() ?? null;
} catch {
  console.log("· 피드에 아직 아무것도 없습니다 — 첫 발행입니다.");
}
if (live && !isNewer(version, live)) {
  die(`피드에 이미 ${live} 가 있습니다 — ${version} 은 더 높지 않습니다.\n`
    + "  되돌리기·같은 버전 재발행은 막습니다: 편집자 PC 는 버전 번호로만 판단하므로\n"
    + "  같은 번호로 내용을 바꾸면 **이미 받은 PC 는 영영 안 받습니다.**");
}

// ── 4. 보여주고 멈춘다 ────────────────────────────────────────────────────────
const uploads = [...referenced, ...blockmaps];
const sha = (f) => createHash("sha256").update(fs.readFileSync(path.join(RELEASE, f))).digest("hex").slice(0, 16);
const mb = (f) => (fs.statSync(path.join(RELEASE, f)).size / 1024 ** 2).toFixed(1);

console.log(`\n발행 대상 — gs://${BUCKET}/${PREFIX}/`);
console.log(`  버전: ${live ?? "(없음)"} → ${version}`);
for (const f of uploads) console.log(`  · ${f}  ${mb(f)}MB  sha256:${sha(f)}…`);
console.log(`  · latest.yml  (마지막에 올립니다)`);

if (!APPLY) {
  console.log("\n실제로 올리려면 `--yes` 를 붙이세요. 올리는 순간 모든 편집자 PC 가 받습니다.\n");
  process.exit(0);
}

// ── 5. 설치본 먼저, latest.yml 마지막 ──────────────────────────────────────────
//
// 순서가 뒤집히면 그 사이에 확인한 앱이 "새 버전이 있다" 를 보고 받으러 갔다가 404 를 만난다.
for (const f of uploads) {
  process.stdout.write(`올리는 중 ${f} … `);
  gcloud("storage", "cp", path.join(RELEASE, f), `gs://${BUCKET}/${PREFIX}/${f}`);
  console.log("완료");
}
process.stdout.write("올리는 중 latest.yml … ");
gcloud("storage", "cp", latestYmlPath, `gs://${BUCKET}/${PREFIX}/latest.yml`);
console.log("완료");

console.log(`\n✓ ${version} 발행. 편집자 PC 는 최대 6시간 안에 받아 두고, 노는 순간 재시작합니다.\n`);

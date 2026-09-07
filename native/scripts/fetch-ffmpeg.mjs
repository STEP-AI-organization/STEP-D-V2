/**
 * 동봉할 ffmpeg 을 받아 `native/vendor/ffmpeg/` 에 둔다. (설치본 빌드 전에 한 번)
 *
 * ## 왜 받아서 넣나 — 세 가지를 동시에 지켜야 한다
 *
 *  1. **버전 고정.** 편집자 PC 가 클립을 굽는데 기계마다 ffmpeg 이 다르면 같은 클립이
 *     다르게 나온다. 필터 기본값은 버전 사이에 조용히 바뀐다 — "동일하게" 를 지키려면
 *     우리가 버전을 못박아야 한다. 개발자 PC 의 winget 설치본을 퍼오면 그게 안 된다.
 *  2. **리포를 안 무겁게.** 80MB 바이너리를 git 에 넣지 않는다(`vendor/` 는 gitignore).
 *     `pnpm install` 하는 모든 사람이 받게 하지도 않는다 — 설치본을 굽는 사람만 받는다.
 *  3. **능력 검증.** ASS 자막 번인은 libass 가 있어야 한다. 없는 빌드를 넣으면 자막이
 *     조용히 빠진 영상이 나간다(에러도 안 난다). 그래서 받은 즉시 확인하고, 없으면 멈춘다.
 *
 * ## 무결성
 *
 * `EXPECTED_SHA256` 이 비어 있으면 **받은 파일의 해시를 찍고 실패**한다. 그 값을 여기 박은
 * 뒤부터는 매번 대조한다 — 배포처가 파일을 갈아치워도 우리가 안다.
 *
 *   node scripts/fetch-ffmpeg.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const NATIVE = path.resolve(HERE, "..");
const VENDOR = path.join(NATIVE, "vendor", "ffmpeg");

/**
 * 핀. 올릴 때는 **해시도 같이** 올린다 — 버전만 바꾸고 해시를 두면 대조가 통과해 버린다.
 * gyan.dev essentials 빌드에 libass·libfreetype·libharfbuzz 가 들어 있다(아래 스모크가 확인).
 */
const VERSION = "7.1.1";
const URL_ZIP = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/ffmpeg-${VERSION}-essentials_build.zip`;
const EXPECTED_SHA256 = "04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4";

/**
 * 없으면 자막이 조용히 빠지거나 깨진다 — 그래서 받은 즉시 본다.
 *
 * ⚠️ **fontconfig 를 요구하지 않는다.** Windows 용 ffmpeg 빌드는 fontconfig 대신
 * **DirectWrite** 로 글꼴을 찾는다(gyan essentials·full 둘 다 그렇다). 그래서 우리가 동봉한
 * 글꼴은 시스템에 설치하는 대신 `ass` 필터의 `fontsdir` 로 지목한다 — libass 가 그 폴더를
 * 직접 훑으므로 공급자와 무관하게 동작하고, 편집자 PC 에 글꼴을 설치할 필요도 없다.
 *
 * `harfbuzz` 는 뺄 수 없다 — 한글 조판(자모 결합·커닝)을 그게 한다. 없으면 자막이
 * 미묘하게 깨져 나가는데 에러는 안 난다.
 */
const REQUIRED_CONFIG = ["--enable-libass", "--enable-libfreetype", "--enable-libharfbuzz"];

async function download(url, dest) {
  console.log(`[ffmpeg] 내려받는 중 — ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`다운로드 실패 ${res.status} ${res.statusText}`);
  await pipeline(res.body, fs.createWriteStream(dest));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * 압축 해제 — Windows 기본 tar(bsdtar)가 zip 을 푼다. 추가 의존을 안 만든다.
 *
 * ⚠️ **절대경로를 인자로 주면 안 된다.** bsdtar 는 `C:\...` 를 `host:path`(원격)로 읽어
 * "Cannot connect to C: resolve failed" 로 죽는다. 그래서 작업 디렉토리를 옮기고
 * **상대 파일명**만 넘긴다.
 */
function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  // ⚠️ 그냥 `tar` 를 부르면 **Git Bash 의 GNU tar** 가 잡혀 "not a tar archive" 로 죽는다
  //    (zip 을 못 읽는다). Windows 기본 bsdtar 를 절대경로로 지목한다.
  const bsdtar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (fs.existsSync(bsdtar)) {
    // bsdtar 는 `C:\...` 를 host:path 로 읽으므로 **상대 파일명**만 넘긴다.
    execFileSync(bsdtar, ["-xf", path.basename(zip), "-C", path.basename(into)], {
      cwd: path.dirname(zip),
      stdio: "inherit",
    });
    return;
  }
  // 아주 옛 Windows — PowerShell 로 떨어진다.
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`,
  ], { stdio: "inherit" });
}

/** 압축 안에 `ffmpeg-<ver>-essentials_build/bin/ffmpeg.exe` 로 들어 있다. */
function findBin(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === name) return full;
    }
  }
  return null;
}

function assertCapabilities(exe) {
  const version = execFileSync(exe, ["-hide_banner", "-version"], { encoding: "utf8" });
  const missing = REQUIRED_CONFIG.filter((flag) => !version.includes(flag));
  if (missing.length) {
    throw new Error(
      `이 빌드에는 ${missing.join(" · ")} 가 없다 — ASS 자막 번인이 조용히 빠진다. 다른 빌드를 쓸 것.`,
    );
  }
  const filters = execFileSync(exe, ["-hide_banner", "-filters"], { encoding: "utf8" });
  for (const f of ["ass", "subtitles", "boxblur", "drawbox", "overlay", "xfade"]) {
    if (!new RegExp(`\\b${f}\\b`).test(filters)) {
      throw new Error(`필터 ${f} 가 없다 — 렌더 필터그래프가 이걸 쓴다.`);
    }
  }
  console.log(`[ffmpeg] 능력 확인 완료 — ${version.split("\n")[0]}`);
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const exeOut = path.join(VENDOR, "ffmpeg.exe");
  const probeOut = path.join(VENDOR, "ffprobe.exe");
  if (fs.existsSync(exeOut) && fs.existsSync(probeOut)) {
    console.log("[ffmpeg] 이미 있다 — 능력만 다시 확인한다.");
    assertCapabilities(exeOut);
    return;
  }

  const tmp = path.join(VENDOR, `ffmpeg-${VERSION}.zip`);
  await download(URL_ZIP, tmp);

  const got = sha256(tmp);
  if (!EXPECTED_SHA256) {
    console.error(`\n[ffmpeg] ⚠️ EXPECTED_SHA256 이 비어 있다. 아래 값을 스크립트에 박을 것:\n\n  ${got}\n`);
    process.exit(2);
  }
  if (got !== EXPECTED_SHA256) {
    throw new Error(`무결성 불일치\n  기대 ${EXPECTED_SHA256}\n  받음 ${got}`);
  }

  const work = path.join(VENDOR, "_extract");
  fs.rmSync(work, { recursive: true, force: true });
  unzip(tmp, work);

  for (const [name, out] of [["ffmpeg.exe", exeOut], ["ffprobe.exe", probeOut]]) {
    const found = findBin(work, name);
    if (!found) throw new Error(`압축 안에서 ${name} 를 못 찾았다`);
    fs.copyFileSync(found, out);
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(tmp, { force: true });

  assertCapabilities(exeOut);
  const mb = (p) => (fs.statSync(p).size / 1024 ** 2).toFixed(1);
  console.log(`[ffmpeg] 준비 완료 — ffmpeg ${mb(exeOut)}MB · ffprobe ${mb(probeOut)}MB → ${VENDOR}`);
}

main().catch((err) => {
  console.error(`[ffmpeg] 실패: ${err.message}`);
  process.exit(1);
});
